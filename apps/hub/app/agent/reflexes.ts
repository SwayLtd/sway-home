/**
 * Reflexes: what the assistant does without being asked.
 *
 * An assistant that only answers is a remote control with a text box. These are the
 * situations where the right move is obvious enough to make on its own: a leak closes the
 * water, a window opened in winter pauses the heating of that room, lights left on in a
 * room nobody has moved in for half an hour go off, the flat that everyone left drops to
 * 16 °C until someone is back.
 *
 * This file only *decides*. It reads a picture of the house and returns what it would do,
 * the sentence it would say having done it, and the question it would ask instead. The
 * engine (`autonomy_engine.ts`) decides whether the autonomy level lets it act or makes it
 * ask, runs the commands, and remembers what it did. Keeping the decision pure keeps every
 * threshold testable to the minute.
 *
 * The rules that make an unprompted assistant bearable, from Alexa Hunches and the Home
 * Assistant "adaptive lighting" manual-control logic:
 *  - **Episodes.** Something done because of a situation is undone when the situation ends
 *    (heating back on when the window closes), and nothing is done twice while it lasts. A
 *    later change during the episode - a presence simulation, someone at home the house did
 *    not see - is respected rather than fought.
 *  - **Restore only what is still ours.** A restore carries the state it expects; if a
 *    person changed the device meanwhile, the restore is dropped silently.
 *  - **Never guess presence.** When the house cannot tell who is home, it does nothing that
 *    depends on it.
 */

import { chip, formatQuantity, isOutdoorArea } from '@sway-home/shared'

export type ReflexId = 'leak_shutoff' | 'smoke_safety' | 'frost_guard' | 'window_heating' | 'empty_house' | 'idle_room' | 'humid_bathroom' | 'stale_air'

export interface ReflexSpec {
  id: ReflexId
  label: string
  description: string
  icon: string
  /** Safety reflexes skip the hourly budget: a leak does not wait for the next hour. */
  safety: boolean
}

export const REFLEXES: ReflexSpec[] = [
  { id: 'leak_shutoff', label: "Fermer l'eau en cas de fuite", description: "Une fuite détectée ferme les vannes d'arrivée d'eau.", icon: 'ph:drop', safety: true },
  {
    id: 'smoke_safety',
    label: 'Sécuriser en cas de fumée',
    description: 'Fumée ou monoxyde : lumières à fond, musique coupée, ventilation arrêtée en cas de fumée.',
    icon: 'ph:fire',
    safety: true,
  },
  { id: 'frost_guard', label: 'Protéger du gel', description: 'Sous 7 °C avec le chauffage coupé, il repart en hors-gel à 8 °C.', icon: 'ph:snowflake', safety: true },
  {
    id: 'window_heating',
    label: 'Couper le chauffage fenêtre ouverte',
    description: 'Fenêtre ouverte deux minutes : chauffage de la pièce coupé, rallumé quand elle se referme.',
    icon: 'ph:thermometer-simple',
    safety: false,
  },
  {
    id: 'empty_house',
    label: 'Maison vide',
    description: "Personne depuis dix minutes : lumières et écrans éteints, musique en pause, chauffage à 16 °C jusqu'au retour.",
    icon: 'ph:house-line',
    safety: false,
  },
  { id: 'idle_room', label: 'Éteindre les pièces vides', description: "Aucun mouvement depuis trente minutes : les lumières de la pièce s'éteignent.", icon: 'ph:lightbulb', safety: false },
  { id: 'humid_bathroom', label: 'Aérer après la douche', description: 'Salle de bain à 70 % : extracteur allumé, arrêté sous 60 %.', icon: 'ph:shower', safety: false },
  { id: 'stale_air', label: 'Air confiné', description: "CO2 au-dessus de 1 400 ppm : ventilation allumée, ou conseil d'aérer.", icon: 'ph:wind', safety: false },
]

export const REFLEX_BY_ID = new Map(REFLEXES.map((reflex) => [reflex.id, reflex]))

// ---------------------------------------------------------------------------------------
// The picture of the house
// ---------------------------------------------------------------------------------------

export interface ReflexDevice {
  id: string
  name: string
  areaId: string | null
  category: string
  capabilities: string[]
  state: Record<string, unknown>
  online: boolean
  critical: boolean
}

export interface ReflexArea {
  id: string
  name: string
  kind?: string | null
}

export interface ReflexCommand {
  deviceId: string
  command: string
  args: Record<string, unknown>
  /** For a restore: only run if the device is still in this state. */
  ifState?: Record<string, unknown>
}

export interface ReflexEpisode {
  key: string
  reflex: ReflexId
  openedAt: string
  /** What puts things back when the situation ends. */
  restore: ReflexCommand[]
}

export interface ReflexDecision {
  reflex: ReflexId
  /** One situation, one key: the engine never asks or acts twice for the same key. */
  key: string
  severity: 'info' | 'notice' | 'warning' | 'critical'
  commands: ReflexCommand[]
  /** The sentence once it is done, with chips. */
  done: string
  /** The sentence when it has to ask first. */
  ask: string
  /** Never acted on alone, whatever the autonomy level. */
  askOnly?: boolean
  /** Nothing to switch, only something to say. */
  adviceOnly?: boolean
  /** The episode this opens once the commands ran. */
  opens?: ReflexEpisode
  /** The episode this closes. */
  closes?: string
  /** Bookkeeping only: open or close an episode without saying anything. */
  silent?: boolean
}

export interface ReflexWorld {
  now: Date
  devices: ReflexDevice[]
  areas: ReflexArea[]
  /** true: someone is home; false: nobody; null: the house cannot tell. */
  occupied: boolean | null
  emptyForMinutes: number | null
  /** When an attribute last changed, epoch ms, or null when never recorded. */
  changedAt(deviceId: string, attribute: string): number | null
  /** Last movement in a room: undefined when it has no motion sensor, null when it never reported. */
  lastMotion(areaId: string): number | null | undefined
  episodes: ReflexEpisode[]
  enabled(reflex: ReflexId): boolean
  /** A person took this device back from the assistant a moment ago: leave it alone. */
  held?(deviceId: string): boolean
}

// ---------------------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------------------

const MINUTE = 60_000
const WINDOW_OPEN_MS = 2 * MINUTE
const WINDOW_CLOSED_MS = MINUTE
const EMPTY_AFTER_MINUTES = 10
const IDLE_MS = 30 * MINUTE
const HUMID_ON = 70
const HUMID_OFF = 60
const CO2_ON = 1400
const CO2_OFF = 1000
const FROST_AT = 7
const FROST_TARGET = 8
const FROST_CLEARED = 10
/** ADEME: 16 °C for an absence of a few hours, 19 °C in a lived-in room. */
const AWAY_TARGET = 16

const HEATING_MODES = new Set(['heat', 'auto', 'heat_cool'])
const WINDOW_WORDS = /(fen[eê]tre|window|velux|baie|vasistas|lucarne|chassis|châssis)/i
const NOT_A_WINDOW = /(porte|door|portail|gate|garage|frigo|r[ée]frig|cong[ée]l|freezer|fridge|bo[iî]te aux lettres|mailbox|placard|tiroir|drawer|cabinet)/i
const BATHROOM = /(salle de bain|salle d.eau|\bsdb\b|douche|bathroom|shower)/i
const EXTRACTOR = /(extract|vmc|ventil|a[ée]rateur|\bfan\b)/i
const SCREEN_CATEGORIES = new Set(['display', 'media'])

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

const has = (device: ReflexDevice, capability: string) => device.capabilities.includes(capability)
/** A mode that heats, or a thermostat that at least says it is heating right now. */
const heating = (device: ReflexDevice) => has(device, 'thermostat') && (HEATING_MODES.has(String(device.state.hvacMode)) || device.state.hvacAction === 'heating')
const modeOf = (device: ReflexDevice) => (typeof device.state.hvacMode === 'string' && device.state.hvacMode !== 'off' ? device.state.hvacMode : 'heat')
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const plural = (count: number, one: string, many: string) => (count > 1 ? many : one)

function matches(device: ReflexDevice | undefined, expected: Record<string, unknown> | undefined): boolean {
  if (!device) return false
  if (!expected) return true
  return Object.entries(expected).every(([key, value]) => device.state[key] === value)
}

/** "A", "A et B", "A, B et C" */
function list(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} et ${parts.at(-1)}`
}

/** Two names read well; beyond that, a count reads better. */
function names(devices: ReflexDevice[], many: string): string {
  if (devices.length <= 2) return devices.map((device) => device.name).join(' et ')
  return `${devices.length} ${many}`
}

function minutesLabel(ms: number): string {
  const minutes = Math.floor(ms / MINUTE)
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
}

function isWindow(device: ReflexDevice): boolean {
  if (WINDOW_WORDS.test(device.name)) return true
  return !NOT_A_WINDOW.test(device.name)
}

function isExtractor(device: ReflexDevice): boolean {
  if (device.category === 'light') return false
  if (has(device, 'fan')) return true
  return has(device, 'onoff') && (device.category === 'climate' || EXTRACTOR.test(device.name))
}

function extractorRunning(device: ReflexDevice): boolean {
  if (has(device, 'fan') && typeof device.state.fanMode === 'string') return device.state.fanMode !== 'off' && device.state.fanSpeed !== 0
  return device.state.on === true
}

/** Start an extractor or a ventilation, and what stops it again. */
function startAir(device: ReflexDevice): { command: ReflexCommand; restore: ReflexCommand } {
  if (has(device, 'fan')) {
    const previous = typeof device.state.fanMode === 'string' ? device.state.fanMode : 'off'
    return {
      command: { deviceId: device.id, command: 'setFanMode', args: { mode: 'high' } },
      restore: { deviceId: device.id, command: 'setFanMode', args: { mode: previous }, ifState: { fanMode: 'high' } },
    }
  }
  return {
    command: { deviceId: device.id, command: 'turnOn', args: {} },
    restore: { deviceId: device.id, command: 'turnOff', args: {}, ifState: { on: true } },
  }
}

class Decider {
  readonly decisions: ReflexDecision[] = []
  readonly #world: ReflexWorld
  readonly #devices: ReflexDevice[]
  readonly #episodes: Map<string, ReflexEpisode>
  /** Devices already given a command this round, so two reflexes never both touch one. */
  readonly #claimed = new Set<string>()

  constructor(world: ReflexWorld) {
    this.#world = world
    this.#devices = world.devices
    this.#episodes = new Map(world.episodes.map((episode) => [episode.key, episode]))
  }

  get now(): number {
    return this.#world.now.getTime()
  }

  episode(key: string): ReflexEpisode | undefined {
    return this.#episodes.get(key)
  }

  area(id: string | null): ReflexArea | undefined {
    return id ? this.#world.areas.find((area) => area.id === id) : undefined
  }

  indoorAreas(): ReflexArea[] {
    return this.#world.areas.filter((area) => !isOutdoorArea(area))
  }

  inArea(areaId: string): ReflexDevice[] {
    return this.#devices.filter((device) => device.areaId === areaId)
  }

  /** Online devices nothing else has claimed this round, and no person is holding. */
  controllable(devices: ReflexDevice[]): ReflexDevice[] {
    return devices.filter((device) => device.online && !this.#claimed.has(device.id) && !this.#world.held?.(device.id))
  }

  push(decision: ReflexDecision): void {
    // A switched-off reflex decides nothing new, but still puts back what it changed.
    if (!decision.closes && !this.#world.enabled(decision.reflex)) return
    for (const command of decision.commands) this.#claimed.add(command.deviceId)
    this.decisions.push(decision)
  }

  /** The restore commands whose device is still the way the reflex left it. */
  restorable(episode: ReflexEpisode): ReflexCommand[] {
    return episode.restore
      .filter((command) => matches(this.#devices.find((device) => device.id === command.deviceId && device.online), command.ifState))
      .map(({ ifState: _ifState, ...command }) => command)
  }

  close(episode: ReflexEpisode, done: (commands: ReflexCommand[]) => string): void {
    const commands = this.restorable(episode)
    this.push({
      reflex: episode.reflex,
      key: episode.key,
      severity: 'info',
      commands,
      done: commands.length > 0 ? done(commands) : '',
      ask: '',
      closes: episode.key,
      silent: commands.length === 0,
    })
  }

  openEpisode(reflex: ReflexId, key: string, restore: ReflexCommand[] = []): ReflexEpisode {
    return { key, reflex, openedAt: this.#world.now.toISOString(), restore }
  }

  get world(): ReflexWorld {
    return this.#world
  }

  get devices(): ReflexDevice[] {
    return this.#devices
  }
}

// ---------------------------------------------------------------------------------------
// The reflexes, most urgent first
// ---------------------------------------------------------------------------------------

function leak(decider: Decider): void {
  const leaking = decider.devices.filter((device) => device.state.leak === true)
  if (leaking.length === 0) return
  const valves = decider.controllable(decider.devices.filter((device) => has(device, 'valve') && device.state.valveOpen !== false))
  if (valves.length === 0) return

  const where = chip('ph:drop', leaking.map((device) => device.name).join(', '), 'alert')
  const what = chip('ph:drop', valves.map((device) => device.name).join(', '), 'alert')
  decider.push({
    reflex: 'leak_shutoff',
    key: 'leak_shutoff',
    severity: 'critical',
    commands: valves.map((valve) => ({ deviceId: valve.id, command: 'closeValve', args: {} })),
    done: `Fuite détectée par ${where} : j'ai fermé ${what}.`,
    ask: `Fuite détectée par ${where} : je ferme ${what} ?`,
  })
}

function smoke(decider: Decider): void {
  const smoking = decider.devices.filter((device) => device.state.smoke === true && device.state.testing !== true)
  const monoxide = decider.devices.filter((device) => device.state.co === true)
  const episode = decider.episode('smoke_safety')

  if (smoking.length === 0 && monoxide.length === 0) {
    if (episode) decider.close(episode, () => '')
    return
  }
  if (episode) return

  const commands: ReflexCommand[] = []
  const done: string[] = []
  const ask: string[] = []

  const lights = decider.controllable(decider.devices.filter((device) => device.category === 'light' && has(device, 'onoff')))
  const dark = lights.filter((light) => (has(light, 'brightness') ? light.state.on !== true || num(light.state.brightness) !== 100 : light.state.on !== true))
  for (const light of dark) {
    commands.push(has(light, 'brightness') ? { deviceId: light.id, command: 'setBrightness', args: { brightness: 100 } } : { deviceId: light.id, command: 'turnOn', args: {} })
  }
  if (dark.length > 0) {
    done.push(`allumé ${chip('ph:lightbulb', plural(dark.length, 'la lumière', `${dark.length} lumières`))}`)
    ask.push("j'allume les lumières")
  }

  const players = decider.controllable(decider.devices.filter((device) => has(device, 'mediaPlayback') && device.state.playback === 'playing'))
  for (const player of players) commands.push({ deviceId: player.id, command: 'pause', args: {} })
  if (players.length > 0) {
    done.push(`coupé ${chip('ph:speaker-slash', names(players, 'enceintes'))}`)
    ask.push('je coupe le son')
  }

  if (smoking.length > 0) {
    const fans = decider.controllable(decider.devices.filter((device) => isExtractor(device) && extractorRunning(device)))
    for (const fan of fans) {
      commands.push(has(fan, 'fan') ? { deviceId: fan.id, command: 'setFanMode', args: { mode: 'off' } } : { deviceId: fan.id, command: 'turnOff', args: {} })
    }
    if (fans.length > 0) {
      done.push(`arrêté ${chip('ph:fan', 'la ventilation')}`)
      ask.push("j'arrête la ventilation")
    }
  }

  const detector =
    smoking.length > 0
      ? `Fumée détectée par ${chip('ph:fire', smoking.map((device) => device.name).join(', '), 'alert')}`
      : `Monoxyde de carbone détecté par ${chip('ph:warning', monoxide.map((device) => device.name).join(', '), 'alert')}`
  const coda = smoking.length === 0 ? ' Sortez et aérez.' : ''

  decider.push({
    reflex: 'smoke_safety',
    key: 'smoke_safety',
    severity: 'critical',
    commands,
    done: commands.length > 0 ? `${detector} : j'ai ${list(done)}.${coda}` : `${detector}.${coda}`,
    ask: `${detector} : ${list(ask)} ?`,
    adviceOnly: commands.length === 0,
    opens: decider.openEpisode('smoke_safety', 'smoke_safety'),
  })
}

function frost(decider: Decider): void {
  for (const thermostat of decider.devices.filter((device) => has(device, 'thermostat'))) {
    const area = decider.area(thermostat.areaId)
    if (area && isOutdoorArea(area)) continue
    const temperature = num(thermostat.state.currentTemperature) ?? num(thermostat.state.temperature)
    const key = `frost_guard:${thermostat.id}`
    const episode = decider.episode(key)

    if (episode) {
      if (temperature !== null && temperature >= FROST_CLEARED) decider.close(episode, () => '')
      continue
    }
    if (temperature === null || temperature > FROST_AT || thermostat.state.hvacMode !== 'off') continue
    if (decider.controllable([thermostat]).length === 0) continue

    const place = chip('ph:snowflake', area?.name ?? thermostat.name)
    const reading = chip('ph:thermometer-simple', formatQuantity(temperature, '°C'), 'alert')
    decider.push({
      reflex: 'frost_guard',
      key,
      severity: 'warning',
      commands: [
        { deviceId: thermostat.id, command: 'setHvacMode', args: { mode: 'heat' } },
        { deviceId: thermostat.id, command: 'setTargetTemperature', args: { celsius: FROST_TARGET } },
      ],
      done: `${place} à ${reading} : chauffage relancé en hors-gel à ${FROST_TARGET} °C.`,
      ask: `${place} à ${reading} : je relance le chauffage en hors-gel à ${FROST_TARGET} °C ?`,
      opens: decider.openEpisode('frost_guard', key),
    })
  }
}

function windowHeating(decider: Decider): void {
  for (const area of decider.indoorAreas()) {
    const contacts = decider.inArea(area.id).filter((device) => has(device, 'contact') && isWindow(device))
    if (contacts.length === 0) continue
    const key = `window_heating:${area.id}`
    const episode = decider.episode(key)
    const place = chip('ph:wind', area.name)

    const openFor = (device: ReflexDevice) => {
      const since = decider.world.changedAt(device.id, 'open')
      return since === null ? Number.POSITIVE_INFINITY : decider.now - since
    }

    if (episode) {
      const allClosed = contacts.every((device) => device.state.open !== true && openFor(device) >= WINDOW_CLOSED_MS)
      if (allClosed) decider.close(episode, () => `${place} : fenêtre refermée, chauffage rallumé.`)
      continue
    }

    const open = contacts.some((device) => device.state.open === true && openFor(device) >= WINDOW_OPEN_MS)
    if (!open) continue
    const heaters = decider.controllable(decider.inArea(area.id).filter(heating))
    if (heaters.length === 0) continue

    decider.push({
      reflex: 'window_heating',
      key,
      severity: 'notice',
      commands: heaters.map((device) => ({ deviceId: device.id, command: 'setHvacMode', args: { mode: 'off' } })),
      done: `${place} : fenêtre ouverte, ${chip('ph:thermometer-simple', 'chauffage coupé')} en attendant.`,
      ask: `${place} : fenêtre ouverte avec le chauffage allumé, je le coupe ?`,
      opens: decider.openEpisode(
        'window_heating',
        key,
        heaters.map((device) => ({ deviceId: device.id, command: 'setHvacMode', args: { mode: modeOf(device) }, ifState: { hvacMode: 'off' } }))
      ),
    })
  }
}

function emptyHouse(decider: Decider): void {
  const { occupied, emptyForMinutes } = decider.world
  const main = decider.episode('empty_house')
  const locksEpisode = decider.episode('empty_house:locks')

  if (occupied === true) {
    if (main) {
      decider.close(main, (commands) => {
        const targets = [...new Set(commands.map((command) => num(command.args.celsius)).filter((value): value is number => value !== null))]
        const where = targets.length === 1 ? chip('ph:thermometer-simple', formatQuantity(targets[0]!, '°C')) : chip('ph:thermometer-simple', 'comme avant')
        return `Bon retour : chauffage remis à ${where}.`
      })
    }
    if (locksEpisode) decider.close(locksEpisode, () => '')
    return
  }
  if (occupied !== false || emptyForMinutes === null || emptyForMinutes < EMPTY_AFTER_MINUTES) return

  if (!main) {
    const lights = decider.controllable(decider.devices.filter((device) => device.category === 'light' && has(device, 'onoff') && device.state.on === true))
    const screens = decider.controllable(decider.devices.filter((device) => SCREEN_CATEGORIES.has(device.category) && has(device, 'onoff') && device.state.on === true))
    const players = decider.controllable(
      decider.devices.filter((device) => has(device, 'mediaPlayback') && device.state.playback === 'playing' && !screens.includes(device))
    )
    const thermostats = decider.controllable(
      decider.devices.filter((device) => heating(device) && (num(device.state.targetTemperature) ?? 0) > AWAY_TARGET)
    )

    const commands: ReflexCommand[] = [
      ...lights.map((device) => ({ deviceId: device.id, command: 'turnOff', args: {} })),
      ...screens.map((device) => ({ deviceId: device.id, command: 'turnOff', args: {} })),
      ...players.map((device) => ({ deviceId: device.id, command: 'pause', args: {} })),
      ...thermostats.map((device) => ({ deviceId: device.id, command: 'setTargetTemperature', args: { celsius: AWAY_TARGET } })),
    ]
    const restore = thermostats.map((device) => ({
      deviceId: device.id,
      command: 'setTargetTemperature',
      args: { celsius: num(device.state.targetTemperature) },
      ifState: { targetTemperature: AWAY_TARGET },
    }))

    const done: string[] = []
    const ask: string[] = []
    const off = [...(lights.length > 0 ? [chip('ph:lightbulb', names(lights, 'lumières'))] : []), ...(screens.length > 0 ? [chip('ph:television', names(screens, 'écrans'))] : [])]
    if (off.length > 0) {
      done.push(`éteint ${list(off)}`)
      ask.push(`j'éteins ${list(off)}`)
    }
    if (players.length > 0) {
      done.push(`mis en pause ${chip('ph:speaker-high', names(players, 'enceintes'))}`)
      ask.push(`je mets ${chip('ph:speaker-high', names(players, 'enceintes'))} en pause`)
    }
    if (thermostats.length > 0) {
      done.push(`baissé ${chip('ph:thermometer-simple', `le chauffage à ${AWAY_TARGET} °C`)}`)
      ask.push(`je baisse ${chip('ph:thermometer-simple', `le chauffage à ${AWAY_TARGET} °C`)}`)
    }

    decider.push({
      reflex: 'empty_house',
      key: 'empty_house',
      severity: 'info',
      commands,
      done: commands.length > 0 ? `Personne à la maison : j'ai ${list(done)}.` : '',
      ask: commands.length > 0 ? `Personne à la maison : ${list(ask)} ?` : '',
      opens: decider.openEpisode('empty_house', 'empty_house', restore),
      silent: commands.length === 0,
    })
  }

  if (!locksEpisode) {
    const unlocked = decider.controllable(decider.devices.filter((device) => has(device, 'lock') && device.state.locked === false))
    if (unlocked.length > 0) {
      const what = chip('ph:lock-simple-open', names(unlocked, 'serrures'), 'warn')
      decider.push({
        reflex: 'empty_house',
        key: 'empty_house:locks',
        severity: 'warning',
        commands: unlocked.map((device) => ({ deviceId: device.id, command: 'lock', args: {} })),
        done: `Personne à la maison : j'ai verrouillé ${what}.`,
        ask: `Personne à la maison et ${what} ${plural(unlocked.length, "n'est pas verrouillée", 'ne sont pas verrouillées')} : je verrouille ?`,
        askOnly: true,
        opens: decider.openEpisode('empty_house', 'empty_house:locks'),
      })
    }
  }
}

function idleRooms(decider: Decider): void {
  for (const area of decider.indoorAreas()) {
    const last = decider.world.lastMotion(area.id)
    if (last === undefined || last === null) continue
    const present = decider.inArea(area.id).some((device) => device.state.motion === true || device.state.occupied === true)
    if (present) continue
    const still = decider.now - last
    if (still < IDLE_MS) continue

    const lights = decider.controllable(
      decider.inArea(area.id).filter((device) => {
        if (device.category !== 'light' || !has(device, 'onoff') || device.state.on !== true) return false
        const since = decider.world.changedAt(device.id, 'on')
        return since !== null && decider.now - since >= IDLE_MS
      })
    )
    if (lights.length === 0) continue

    const place = chip('ph:lightbulb', area.name)
    decider.push({
      reflex: 'idle_room',
      key: `idle_room:${area.id}`,
      severity: 'info',
      commands: lights.map((device) => ({ deviceId: device.id, command: 'turnOff', args: {} })),
      done: `${place} : personne depuis ${minutesLabel(still)}, ${plural(lights.length, 'lumière éteinte', 'lumières éteintes')}.`,
      ask: `${place} : personne depuis ${minutesLabel(still)}, j'éteins ${plural(lights.length, 'la lumière', 'les lumières')} ?`,
    })
  }
}

function humidBathroom(decider: Decider): void {
  for (const area of decider.indoorAreas()) {
    if (area.kind !== 'bathroom' && !BATHROOM.test(area.name)) continue
    const readings = decider
      .inArea(area.id)
      .filter((device) => device.online)
      .map((device) => num(device.state.humidity))
      .filter((value): value is number => value !== null)
    if (readings.length === 0) continue
    const humidity = Math.max(...readings)
    const key = `humid_bathroom:${area.id}`
    const episode = decider.episode(key)
    const place = chip('ph:shower', area.name)

    if (episode) {
      if (humidity < HUMID_OFF) decider.close(episode, () => `${place} : ${chip('ph:drop', formatQuantity(humidity, '%', 0))}, extracteur arrêté.`)
      continue
    }
    if (humidity < HUMID_ON) continue
    const extractors = decider.controllable(decider.inArea(area.id).filter((device) => isExtractor(device) && !extractorRunning(device)))
    if (extractors.length === 0) continue

    const started = extractors.map(startAir)
    const level = chip('ph:drop', formatQuantity(humidity, '%', 0), 'warn')
    decider.push({
      reflex: 'humid_bathroom',
      key,
      severity: 'info',
      commands: started.map((entry) => entry.command),
      done: `${place} à ${level} : extracteur allumé.`,
      ask: `${place} à ${level} : j'allume l'extracteur ?`,
      opens: decider.openEpisode('humid_bathroom', key, started.map((entry) => entry.restore)),
    })
  }
}

function staleAir(decider: Decider): void {
  for (const area of decider.indoorAreas()) {
    const readings = decider
      .inArea(area.id)
      .filter((device) => device.online)
      .map((device) => num(device.state.co2))
      .filter((value): value is number => value !== null)
    if (readings.length === 0) continue
    const co2 = Math.max(...readings)
    const key = `stale_air:${area.id}`
    const episode = decider.episode(key)
    const place = chip('ph:wind', area.name)

    if (episode) {
      if (co2 < CO2_OFF) decider.close(episode, () => `${place} : air renouvelé, ventilation arrêtée.`)
      continue
    }
    if (co2 < CO2_ON) continue

    const level = chip('ph:wind', formatQuantity(co2, 'ppm', 0), 'warn')
    const fans = decider.controllable(decider.inArea(area.id).filter((device) => isExtractor(device) && !extractorRunning(device)))
    if (fans.length === 0) {
      decider.push({
        reflex: 'stale_air',
        key,
        severity: 'notice',
        commands: [],
        done: `${place} : air confiné à ${level}, aérez cinq minutes.`,
        ask: `${place} : air confiné à ${level}, aérez cinq minutes.`,
        adviceOnly: true,
        opens: decider.openEpisode('stale_air', key),
      })
      continue
    }

    const started = fans.map(startAir)
    decider.push({
      reflex: 'stale_air',
      key,
      severity: 'notice',
      commands: started.map((entry) => entry.command),
      done: `${place} : air confiné à ${level}, ventilation allumée.`,
      ask: `${place} : air confiné à ${level}, j'allume la ventilation ?`,
      opens: decider.openEpisode('stale_air', key, started.map((entry) => entry.restore)),
    })
  }
}

/**
 * Everything the assistant would do right now, most urgent first. Safety reflexes run
 * first and claim their devices, so a light the fire reflex lights up is not switched off
 * by the empty-room reflex in the same round.
 */
export function decideReflexes(world: ReflexWorld): ReflexDecision[] {
  const decider = new Decider(world)
  leak(decider)
  smoke(decider)
  frost(decider)
  windowHeating(decider)
  emptyHouse(decider)
  idleRooms(decider)
  humidBathroom(decider)
  staleAir(decider)
  return decider.decisions
}

// ---------------------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------------------

/** What each reflex sounds like in "J'agis seul : ...", most telling first. */
const SPOKEN: [ReflexId, string][] = [
  ['window_heating', `je coupe ${chip('ph:thermometer-simple', 'le chauffage fenêtre ouverte')}`],
  ['idle_room', `j'éteins ${chip('ph:lightbulb', 'les pièces vides')}`],
  ['leak_shutoff', `je ferme ${chip('ph:drop', "l'eau en cas de fuite")}`],
  ['empty_house', `je mets ${chip('ph:house-line', 'la maison en veille')} quand elle est vide`],
  ['smoke_safety', `je sécurise ${chip('ph:fire', 'la maison en cas de fumée')}`],
  ['humid_bathroom', `j'aère ${chip('ph:shower', 'après la douche')}`],
  ['stale_air', `je surveille ${chip('ph:wind', "l'air")}`],
  ['frost_guard', `je protège ${chip('ph:snowflake', 'du gel')}`],
]

/**
 * The answer to "que fais-tu de proactif ?": one sentence, the three reflexes that say the
 * most, and what was actually done today, because a claim with a count is believed.
 */
export function describeAutonomy(input: { actsAlone: boolean; enabled: ReflexId[]; today: number }): string {
  const active = SPOKEN.filter(([id]) => input.enabled.includes(id)).map(([, phrase]) => phrase)
  if (active.length === 0) return "Mes réflexes sont tous coupés : je n'agis que sur demande."
  if (!input.actsAlone) return "Je repère fenêtres ouvertes, pièces vides et fuites, mais je vous demande avant d'agir : dites \"agis seul\" pour que je m'en charge."
  const today = input.today > 0 ? `, déjà ${chip('ph:sparkle', `${input.today} fois`)} aujourd'hui` : ''
  return `J'agis seul : ${list(active.slice(0, 3))}${today}.`
}
