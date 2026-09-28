/**
 * The autonomy engine: the reflexes, wired to the house.
 *
 * `reflexes.ts` decides what the obvious move is. This runs it: every minute, and the
 * moment a leak, smoke, a window or a presence change arrives, it builds a picture of the
 * house, asks the reflexes, and for each decision either acts, asks, or stays quiet.
 *
 *  - **Acting** needs an autonomy level that may act unprompted (copilot, autopilot), a risk
 *    under that level's ceiling, and a device that is not a lock, a camera, a siren or
 *    marked critical: those always ask, whatever the level. Every action goes through the
 *    house service with `origin: 'agent'`, is said in the chat, and leaves an undo entry.
 *  - **Asking** creates a proposal and says the question; nothing moves until yes.
 *  - **The person wins.** A device the assistant changed and a person changed back is left
 *    alone for three hours - the "manual control" rule of Home Assistant's adaptive
 *    lighting - so the assistant never fights someone at the switch.
 *  - **Budget.** Comfort reflexes act at most `maxUnpromptedActionsPerHour` times an hour.
 *    Safety reflexes (leak, smoke, frost) ignore it.
 *
 * Episodes - "the heating is off because the window is open" - are persisted, so a restart
 * in the middle of one still puts the heating back when the window closes.
 */

import { randomUUID } from 'node:crypto'
import { AUTONOMY, DEFAULT_AUTONOMY, commandRisk, riskAllowed, stripRichText, type AutonomyLevel, type Device, type HouseEvent } from '@sway-home/shared'
import { REFLEXES, REFLEX_BY_ID, decideReflexes, type ReflexCommand, type ReflexDecision, type ReflexEpisode, type ReflexId, type ReflexWorld } from '#agent/reflexes'
import { database } from '#db/database'
import { deviceRepository } from '#repositories/device_repository'
import { house, people, places, proposals, settings, undo } from '#repositories/store'
import { bus } from '#services/event_bus'
import { houseService } from '#services/house'
import { narrator } from '#services/narrator'

const MINUTE = 60_000
const TICK_MS = MINUTE
const HOLD_MS = 3 * 60 * MINUTE
const ASK_AGAIN_MS = 30 * MINUTE
const UNDO_TTL_MINUTES = 12 * 60
const EPISODES_KEY = 'autonomy.episodes'
const SWITCHES_KEY = 'autonomy.reflexes'

/** What a state change has to touch to be worth a look before the next tick. */
const WATCHED = new Set(['leak', 'smoke', 'co', 'open', 'motion', 'occupied', 'home', 'humidity', 'co2', 'currentTemperature', 'temperature'])
const URGENT = new Set(['leak', 'smoke', 'co'])

/** Never touched without a yes, at any level: the agent contract says so. */
const GUARDED_CATEGORIES = new Set(['lock', 'camera'])
const GUARDED_CAPABILITIES = ['lock', 'camera', 'siren', 'garage']

export type ReflexAction = 'done' | 'asked' | 'advised' | 'restored' | 'closed' | 'noted' | 'failed' | 'skipped'

export interface ReflexOutcome {
  reflex: ReflexId
  key: string
  action: ReflexAction
  text: string
  commands: ReflexCommand[]
  undoId?: string
  proposalId?: string
  reason?: 'budget' | 'already-asked' | 'quiet'
}

interface Acted {
  at: number
  /** The attributes the command changed, as they were before: a person putting one back is a take-over. */
  before: Record<string, unknown>
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** The attributes a command changes, for spotting a person changing them back. */
function attributesOf(command: string): string[] {
  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'setBrightness':
      return ['on']
    case 'setHvacMode':
      return ['hvacMode']
    case 'setTargetTemperature':
      return ['targetTemperature']
    case 'setFanMode':
      return ['fanMode']
    case 'pause':
      return ['playback']
    case 'closeValve':
      return ['valveOpen']
    case 'lock':
      return ['locked']
    default:
      return []
  }
}

/** The command that puts a device back, from the state it had before. */
export function inverseOf(command: ReflexCommand, before: Record<string, unknown>): ReflexCommand | null {
  const back = (name: string, args: Record<string, unknown> = {}): ReflexCommand => ({ deviceId: command.deviceId, command: name, args })
  switch (command.command) {
    case 'turnOn':
    case 'turnOff':
      return before.on === true ? back('turnOn') : before.on === false ? back('turnOff') : null
    case 'setBrightness':
      if (before.on === false) return back('turnOff')
      return num(before.brightness) === null ? null : back('setBrightness', { brightness: before.brightness })
    case 'setHvacMode':
      return typeof before.hvacMode === 'string' ? back('setHvacMode', { mode: before.hvacMode }) : null
    case 'setTargetTemperature':
      return num(before.targetTemperature) === null ? null : back('setTargetTemperature', { celsius: before.targetTemperature })
    case 'setFanMode':
      return typeof before.fanMode === 'string' ? back('setFanMode', { mode: before.fanMode }) : null
    case 'pause':
      return before.playback === 'playing' ? back('play') : null
    case 'closeValve':
      return before.valveOpen === true ? back('openValve') : null
    case 'lock':
      return before.locked === false ? back('unlock') : null
    default:
      return null
  }
}

function lastEventAt(type: string): number | null {
  const row = database().get<{ at: string }>('SELECT at FROM events WHERE type = ? ORDER BY at DESC LIMIT 1', [type])
  return row ? Date.parse(row.at) : null
}

class AutonomyEngine {
  #timer: ReturnType<typeof setInterval> | null = null
  #soon: ReturnType<typeof setTimeout> | null = null
  #unsubscribes: (() => void)[] = []
  #running: Promise<ReflexOutcome[]> | null = null

  #asked = new Map<string, number>()
  #holds = new Map<string, number>()
  #acted = new Map<string, Acted>()
  #hour = -1
  #actionsThisHour = 0
  #emptySince: number | null = null

  // -------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------

  /** The bus listeners alone: take-overs and urgent changes. Tests use this without timers. */
  listen(): void {
    if (this.#unsubscribes.length > 0) return
    this.#unsubscribes.push(
      bus.on('device.command_sent', (event) => this.#onCommand(event)),
      bus.on('device.state_changed', (event) => this.#onState(event)),
      bus.on('presence.changed', () => this.#evaluateSoon(2000)),
      bus.on('house.mode_changed', () => this.#evaluateSoon(2000))
    )
  }

  start(): void {
    this.listen()
    if (this.#timer) return
    this.#timer = setInterval(() => void this.evaluate().catch(() => undefined), TICK_MS)
    this.#evaluateSoon(20_000)
  }

  stop(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe()
    this.#unsubscribes = []
    if (this.#timer) clearInterval(this.#timer)
    if (this.#soon) clearTimeout(this.#soon)
    this.#timer = null
    this.#soon = null
  }

  /** Forget what is held in memory. Persisted episodes and switches stay. */
  reset(): void {
    this.#asked.clear()
    this.#holds.clear()
    this.#acted.clear()
    this.#hour = -1
    this.#actionsThisHour = 0
    this.#emptySince = null
  }

  #evaluateSoon(delayMs: number): void {
    if (this.#soon) return
    this.#soon = setTimeout(() => {
      this.#soon = null
      void this.evaluate().catch(() => undefined)
    }, delayMs)
  }

  // -------------------------------------------------------------------------------------
  // Settings and status
  // -------------------------------------------------------------------------------------

  level(): AutonomyLevel {
    return settings.get<{ autonomy?: AutonomyLevel }>('agent', {}).autonomy ?? DEFAULT_AUTONOMY
  }

  #switches(): Partial<Record<ReflexId, boolean>> {
    return settings.get<Partial<Record<ReflexId, boolean>>>(SWITCHES_KEY, {})
  }

  reflexSettings(): ((typeof REFLEXES)[number] & { enabled: boolean })[] {
    const switches = this.#switches()
    return REFLEXES.map((reflex) => ({ ...reflex, enabled: switches[reflex.id] !== false }))
  }

  setReflex(id: ReflexId, enabled: boolean): boolean {
    if (!REFLEX_BY_ID.has(id)) return false
    settings.set(SWITCHES_KEY, { ...this.#switches(), [id]: enabled })
    return true
  }

  status(): {
    level: AutonomyLevel
    actsAlone: boolean
    enabled: ReflexId[]
    episodes: ReflexEpisode[]
    today: number
    recent: { at: string; text: string; reflex: string }[]
  } {
    const level = this.level()
    const since = new Date()
    since.setHours(0, 0, 0, 0)
    const rows = database().all<{ at: string; text: string; kind: string }>(
      "SELECT at, text, kind FROM agent_announcements WHERE kind LIKE 'reflex.%' AND json_extract(payload, '$.action') IN ('reflex-done', 'reflex-restored') ORDER BY at DESC LIMIT 50"
    )
    return {
      level,
      actsAlone: AUTONOMY[level].mayActUnprompted,
      enabled: this.reflexSettings()
        .filter((reflex) => reflex.enabled)
        .map((reflex) => reflex.id),
      episodes: this.#episodes(),
      today: rows.filter((row) => Date.parse(row.at) >= since.getTime()).length,
      recent: rows.slice(0, 5).map((row) => ({ at: row.at, text: row.text, reflex: row.kind.replace(/^reflex\./, '') })),
    }
  }

  // -------------------------------------------------------------------------------------
  // Take-overs
  // -------------------------------------------------------------------------------------

  #hold(deviceId: string): void {
    this.#holds.set(deviceId, Date.now() + HOLD_MS)
    this.#acted.delete(deviceId)
  }

  #recentlyActed(deviceId: string | null): Acted | null {
    if (!deviceId) return null
    const acted = this.#acted.get(deviceId)
    if (!acted || Date.now() - acted.at > HOLD_MS) return null
    return acted
  }

  #onCommand(event: HouseEvent): void {
    if (event.origin !== 'user' && event.origin !== 'api') return
    if (this.#recentlyActed(event.subjectId)) this.#hold(event.subjectId!)
  }

  #onState(event: HouseEvent): void {
    if (event.origin === 'agent') return
    const changes = (event.payload as { changes?: Record<string, unknown> }).changes ?? {}

    // Someone at the wall switch, putting back what the assistant changed.
    const acted = this.#recentlyActed(event.subjectId)
    if (acted && Object.entries(acted.before).some(([attribute, value]) => attribute in changes && changes[attribute] === value)) {
      this.#hold(event.subjectId!)
    }

    const keys = Object.keys(changes)
    if (keys.some((key) => URGENT.has(key))) this.#evaluateSoon(0)
    else if (keys.some((key) => WATCHED.has(key))) this.#evaluateSoon(5000)
  }

  // -------------------------------------------------------------------------------------
  // The picture of the house
  // -------------------------------------------------------------------------------------

  #episodes(): ReflexEpisode[] {
    return settings.get<ReflexEpisode[]>(EPISODES_KEY, [])
  }

  #openEpisode(episode: ReflexEpisode): void {
    settings.set(EPISODES_KEY, [...this.#episodes().filter((existing) => existing.key !== episode.key), episode])
  }

  #closeEpisode(key: string): void {
    settings.set(
      EPISODES_KEY,
      this.#episodes().filter((existing) => existing.key !== key)
    )
  }

  #presence(now: number, devices: Device[], changedAt: ReflexWorld['changedAt']): { occupied: boolean | null; emptyForMinutes: number | null } {
    const empty = (since: number | null) => {
      const from = since ?? (this.#emptySince ??= now)
      return { occupied: false, emptyForMinutes: Math.max(0, (now - from) / MINUTE) }
    }

    // People the house can actually track come first: a person with no tracker is always
    // "away", and treating that as an empty flat would switch the lights off on them.
    const tracked = people.all().filter((person) => person.trackerDeviceIds.length > 0 || person.presenceSource !== 'network')
    if (tracked.length > 0) {
      if (tracked.some((person) => person.home)) {
        this.#emptySince = null
        return { occupied: true, emptyForMinutes: null }
      }
      return empty(lastEventAt('presence.changed'))
    }

    const mode = house.mode()
    if (mode === 'away' || mode === 'vacation') return empty(lastEventAt('house.mode_changed'))

    const sensors = devices.filter((device) => device.capabilities.includes('presence'))
    if (sensors.length > 0) {
      if (sensors.some((device) => device.state.home === true)) {
        this.#emptySince = null
        return { occupied: true, emptyForMinutes: null }
      }
      const changes = sensors.map((device) => changedAt(device.id, 'home')).filter((at): at is number => at !== null)
      return empty(changes.length > 0 ? Math.max(...changes) : null)
    }

    this.#emptySince = null
    return { occupied: null, emptyForMinutes: null }
  }

  world(now = new Date()): ReflexWorld {
    const devices = deviceRepository.all({ limit: 5000 })
    const cache = new Map<string, number | null>()
    const changedAt = (deviceId: string, attribute: string): number | null => {
      const key = `${deviceId}:${attribute}`
      if (!cache.has(key)) {
        const row = database().get<{ at: string | null }>('SELECT MAX(at) AS at FROM state_history WHERE device_id = ? AND attribute = ?', [deviceId, attribute])
        cache.set(key, row?.at ? Date.parse(row.at) : null)
      }
      return cache.get(key) ?? null
    }
    const presence = this.#presence(now.getTime(), devices, changedAt)
    const switches = this.#switches()

    return {
      now,
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        areaId: device.areaId,
        category: device.category,
        capabilities: device.capabilities,
        state: device.state,
        online: device.online,
        critical: device.critical,
      })),
      areas: places.areas().map((area) => ({ id: area.id, name: area.name, kind: area.kind })),
      occupied: presence.occupied,
      emptyForMinutes: presence.emptyForMinutes,
      changedAt,
      lastMotion: (areaId) => {
        const sensors = devices.filter((device) => device.areaId === areaId && (device.capabilities.includes('motion') || device.capabilities.includes('occupancy')))
        if (sensors.length === 0) return undefined
        if (sensors.some((device) => device.state.motion === true || device.state.occupied === true)) return now.getTime()
        const marks = sensors.map((device) => database().get<{ at: string | null }>("SELECT MAX(at) AS at FROM state_history WHERE device_id = ? AND attribute IN ('motion', 'occupied')", [device.id])?.at)
        const known = marks.filter((at): at is string => typeof at === 'string').map((at) => Date.parse(at))
        return known.length > 0 ? Math.max(...known) : null
      },
      episodes: this.#episodes(),
      enabled: (reflex) => switches[reflex] !== false,
      held: (deviceId) => (this.#holds.get(deviceId) ?? 0) > now.getTime(),
    }
  }

  // -------------------------------------------------------------------------------------
  // Deciding and doing
  // -------------------------------------------------------------------------------------

  /** One evaluation at a time: a burst of changes queues rather than acting twice in parallel. */
  async evaluate(now = new Date()): Promise<ReflexOutcome[]> {
    const previous = this.#running
    const run = (async () => {
      if (previous) await previous.catch(() => undefined)
      return this.#evaluate(now)
    })()
    this.#running = run
    try {
      return await run
    } finally {
      if (this.#running === run) this.#running = null
    }
  }

  async #evaluate(now: Date): Promise<ReflexOutcome[]> {
    const level = this.level()
    const outcomes: ReflexOutcome[] = []
    for (const decision of decideReflexes(this.world(now))) {
      outcomes.push(await this.#apply(decision, level, now.getTime()))
    }
    return outcomes
  }

  #outcome(decision: ReflexDecision, action: ReflexAction, extra: Partial<ReflexOutcome> = {}): ReflexOutcome {
    const text = action === 'asked' ? decision.ask : action === 'skipped' || action === 'noted' || action === 'closed' ? '' : decision.done
    return { reflex: decision.reflex, key: decision.key, action, text, commands: decision.commands, ...extra }
  }

  #budgetLeft(now: number): number {
    const hour = Math.floor(now / (60 * MINUTE))
    if (hour !== this.#hour) {
      this.#hour = hour
      this.#actionsThisHour = 0
    }
    const budget = settings.get<{ proactivity?: { maxUnpromptedActionsPerHour?: number } }>('agent', {}).proactivity?.maxUnpromptedActionsPerHour ?? 6
    return budget - this.#actionsThisHour
  }

  #guarded(command: ReflexCommand): boolean {
    const device = deviceRepository.find(command.deviceId)
    if (!device) return true
    if (device.critical || GUARDED_CATEGORIES.has(device.category)) return true
    return GUARDED_CAPABILITIES.some((capability) => device.capabilities.includes(capability as never))
  }

  #mayAct(decision: ReflexDecision, level: AutonomyLevel): boolean {
    if (!AUTONOMY[level].mayActUnprompted || decision.askOnly) return false
    return decision.commands.every((command) => {
      if (this.#guarded(command)) return false
      const device = deviceRepository.find(command.deviceId)
      return riskAllowed(level, commandRisk(command.command, device?.critical ?? false))
    })
  }

  async #apply(decision: ReflexDecision, level: AutonomyLevel, now: number): Promise<ReflexOutcome> {
    const spec = REFLEX_BY_ID.get(decision.reflex)!

    if (decision.closes) return this.#restore(decision)
    if (decision.silent) {
      if (decision.opens) this.#openEpisode(decision.opens)
      return this.#outcome(decision, 'noted')
    }
    if ((this.#asked.get(decision.key) ?? 0) > now) return this.#outcome(decision, 'skipped', { reason: 'already-asked' })

    if (decision.adviceOnly) {
      if (decision.opens) this.#openEpisode(decision.opens)
      narrator.announce({
        kind: `reflex.${decision.reflex}`,
        text: decision.done,
        severity: decision.severity,
        dedupeKey: `reflex:${decision.key}:advice`,
        repeatAfterMinutes: 120,
        urgent: spec.safety,
        payload: { reflex: decision.reflex, action: 'reflex-advice' },
      })
      return this.#outcome(decision, 'advised')
    }

    const mayAct = this.#mayAct(decision, level)
    if (mayAct && !spec.safety && this.#budgetLeft(now) <= 0) return this.#outcome(decision, 'skipped', { reason: 'budget' })
    return mayAct ? this.#act(decision, spec.safety) : this.#ask(decision, spec.safety, now)
  }

  async #act(decision: ReflexDecision, safety: boolean): Promise<ReflexOutcome> {
    const correlationId = randomUUID()
    const inverse: ReflexCommand[] = []
    let succeeded = 0

    for (const command of decision.commands) {
      const before = { ...(deviceRepository.find(command.deviceId)?.state ?? {}) }
      const result = await houseService.execute(command.deviceId, command.command, command.args, {
        origin: 'agent',
        originDetail: `reflex:${decision.reflex}`,
        correlationId,
        noUndo: true,
      })
      if (!result.ok) continue
      succeeded += 1
      const back = result.undo ? { deviceId: command.deviceId, command: result.undo.command, args: result.undo.args } : inverseOf(command, before)
      if (back) inverse.unshift(back)
      const touched = attributesOf(command.command)
      if (touched.length > 0) this.#acted.set(command.deviceId, { at: Date.now(), before: Object.fromEntries(touched.map((attribute) => [attribute, before[attribute]])) })
    }

    if (succeeded === 0) return this.#outcome(decision, 'failed')
    if (!safety) this.#actionsThisHour += 1

    const entry = inverse.length > 0 ? undo.push({ description: stripRichText(decision.done), origin: 'agent', commands: inverse, ttlMinutes: UNDO_TTL_MINUTES }) : null
    if (decision.opens) this.#openEpisode(decision.opens)

    narrator.announce({
      kind: `reflex.${decision.reflex}`,
      text: decision.done,
      severity: decision.severity,
      subjectId: decision.commands[0]?.deviceId ?? null,
      // Every action taken alone is said, budget or not: an unexplained change is the
      // thing that makes people switch an assistant off.
      urgent: true,
      payload: { reflex: decision.reflex, action: 'reflex-done', undoId: entry?.id ?? null, deviceIds: decision.commands.map((command) => command.deviceId) },
    })
    return this.#outcome(decision, 'done', { undoId: entry?.id })
  }

  #ask(decision: ReflexDecision, safety: boolean, now: number): ReflexOutcome {
    const proposal = proposals.create({
      summary: stripRichText(decision.ask),
      reason: REFLEX_BY_ID.get(decision.reflex)?.label ?? decision.reflex,
      risk: decision.commands.reduce<ReturnType<typeof commandRisk>>((worst, command) => {
        const risk = commandRisk(command.command, deviceRepository.find(command.deviceId)?.critical ?? false)
        const order = ['none', 'low', 'medium', 'high', 'forbidden']
        return order.indexOf(risk) > order.indexOf(worst) ? risk : worst
      }, 'low'),
      commands: decision.commands.map((command) => ({
        deviceId: command.deviceId,
        deviceName: deviceRepository.find(command.deviceId)?.name ?? command.deviceId,
        command: command.command,
        args: command.args,
      })),
      routine: null,
      ttlMinutes: 30,
    })

    const said = narrator.announce({
      kind: `reflex.${decision.reflex}`,
      text: decision.ask,
      severity: decision.severity,
      subjectId: decision.commands[0]?.deviceId ?? null,
      dedupeKey: `reflex:${decision.key}:ask`,
      repeatAfterMinutes: 30,
      // A door left unlocked in an empty flat is asked about even when the hour's quota of
      // unprompted sentences is spent; a comfort question waits for the next hour.
      urgent: safety || decision.askOnly === true,
      payload: { reflex: decision.reflex, action: 'reflex-ask', proposalId: proposal.id },
    })
    if (!said) {
      // Nobody will see the question: a proposal nobody was asked about must not linger.
      proposals.decide(proposal.id, 'expired')
      return this.#outcome(decision, 'skipped', { reason: 'quiet' })
    }

    bus.publish('agent.action_proposed', {
      subjectType: 'agent',
      subjectId: proposal.id,
      origin: 'agent',
      payload: { summary: proposal.summary, reflex: decision.reflex },
    })
    this.#asked.set(decision.key, now + ASK_AGAIN_MS)
    if (decision.opens) this.#openEpisode(decision.opens)
    return this.#outcome(decision, 'asked', { proposalId: proposal.id })
  }

  async #restore(decision: ReflexDecision): Promise<ReflexOutcome> {
    const key = decision.closes!
    if (decision.commands.length === 0) {
      this.#closeEpisode(key)
      return this.#outcome(decision, 'closed')
    }

    const correlationId = randomUUID()
    let succeeded = 0
    for (const command of decision.commands) {
      const result = await houseService.execute(command.deviceId, command.command, command.args, {
        origin: 'agent',
        originDetail: `reflex:${decision.reflex}:restore`,
        correlationId,
        noUndo: true,
      })
      if (result.ok) succeeded += 1
    }
    this.#closeEpisode(key)
    if (succeeded === 0) return this.#outcome(decision, 'failed')

    narrator.announce({
      kind: `reflex.${decision.reflex}`,
      text: decision.done,
      severity: 'info',
      subjectId: decision.commands[0]?.deviceId ?? null,
      urgent: true,
      payload: { reflex: decision.reflex, action: 'reflex-restored' },
    })
    return this.#outcome(decision, 'restored')
  }
}

export const autonomyEngine = new AutonomyEngine()
