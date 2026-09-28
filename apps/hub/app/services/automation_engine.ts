/**
 * The automation engine.
 *
 * Routines are JSON: triggers, conditions, actions. This turns that JSON into behaviour.
 *
 * The parts that are easy to get wrong, and how they are handled here:
 *  - **Debounce.** A `forSeconds` trigger must not fire on a sensor that flickers. Timers
 *    are held per routine and per trigger, and cancelled the moment the condition stops
 *    holding.
 *  - **Re-entry.** A motion light that re-triggers while it is still running must restart
 *    its timer rather than stack a second run. That is `mode`.
 *  - **Loops.** A routine whose action changes the state its own trigger watches would run
 *    forever. Runs carry a depth, and anything past three levels is stopped and reported.
 */

import { randomUUID } from 'node:crypto'
import type { Action, Condition, HouseEvent, Routine, Trigger } from '@sway-home/shared'
import { bus } from '#services/event_bus'
import { houseService } from '#services/house'
import { deviceRepository } from '#repositories/device_repository'
import { house, people, places, routines, scenes, settings } from '#repositories/store'
import { tasks } from '#services/task_service'

const VERB: Record<string, string> = {
  turnOn: 'allumer',
  turnOff: 'éteindre',
  toggle: 'basculer',
  open: 'ouvrir',
  close: 'fermer',
  lock: 'verrouiller',
  unlock: 'déverrouiller',
  play: 'lancer la lecture',
  pause: 'mettre en pause',
}

const MODE_WORD: Record<string, string> = {
  home: 'Maison',
  away: 'Absent',
  night: 'Nuit',
  guest: 'Invités',
  vacation: 'Vacances',
  party: 'Soirée',
  focus: 'Focus',
  cinema: 'Cinéma',
  cleaning: 'Ménage',
}

function commandWords(command: string, args: Record<string, unknown>): string {
  if (command === 'setBrightness' && typeof args.brightness === 'number') return `luminosité ${args.brightness} %`
  if (command === 'setTargetTemperature' && typeof args.temperature === 'number') return `consigne ${String(args.temperature).replace('.', ',')} °C`
  if (command === 'setPosition' && typeof args.position === 'number') return `position ${args.position} %`
  return VERB[command] ?? command
}

/** An action in words, for the step list of the running routine. */
export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'device_command': {
      const words = commandWords(action.command, action.args ?? {})
      if (action.deviceId) {
        const device = deviceRepository.find(action.deviceId)
        return device ? `${device.name} : ${words}` : `Appareil introuvable : ${words}`
      }
      return `Plusieurs appareils : ${words}`
    }
    case 'scene':
      return `Scène ${scenes.all().find((scene) => scene.id === action.sceneId)?.name ?? 'introuvable'}`
    case 'delay':
      return action.seconds >= 60 && action.seconds % 60 === 0 ? `Attendre ${action.seconds / 60} min` : `Attendre ${action.seconds} s`
    case 'notify':
      return 'Envoyer une notification'
    case 'speak':
      return 'Annoncer à voix haute'
    case 'set_house_mode':
      return `Mode ${MODE_WORD[action.mode] ?? action.mode}`
    case 'run_routine':
      return `Routine ${routines.find(action.routineId)?.name ?? 'introuvable'}`
    case 'webhook':
      return 'Appeler un webhook'
    case 'ask_agent':
      return "Demander à l'assistant"
    case 'wait_until':
      return 'Attendre une condition'
    case 'stop':
      return 'Arrêter'
    default:
      return 'Action'
  }
}

interface RunContext {
  routine: Routine
  trigger: Trigger | null
  event: HouseEvent | null
  depth: number
  correlationId: string
  startedAt: string
  steps: { action: string; ok: boolean; detail?: string }[]
}

class AutomationEngine {
  #unsubscribe: (() => void) | null = null
  #tick: ReturnType<typeof setInterval> | null = null
  #pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #running = new Map<string, AbortController>()
  #lastMinute = ''
  #intervalMarks = new Map<string, number>()

  start(): void {
    if (this.#unsubscribe) return
    this.#unsubscribe = bus.on('*', (event) => this.#onEvent(event))
    // One timer for every time-shaped trigger. A cron library would be a dependency for
    // something that is a minute comparison.
    this.#tick = setInterval(() => this.#onMinute(), 15_000)
  }

  stop(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    if (this.#tick) clearInterval(this.#tick)
    this.#tick = null
    for (const timer of this.#pendingTimers.values()) clearTimeout(timer)
    this.#pendingTimers.clear()
    for (const controller of this.#running.values()) controller.abort()
    this.#running.clear()
  }

  constructor() {
    // "Réessayer" on a failed routine task runs the routine again, by hand.
    tasks.registerRunner('routine', async (payload) => {
      if (typeof payload.routineId === 'string') await this.trigger(payload.routineId, 'user')
    })
  }

  /** Run a routine by hand, from the UI or from the agent. */
  async trigger(routineId: string, origin: 'user' | 'agent' | 'api' = 'user'): Promise<boolean> {
    const routine = routines.find(routineId)
    if (!routine) return false
    await this.#run({
      routine,
      trigger: { kind: 'manual' },
      event: null,
      depth: 0,
      correlationId: randomUUID(),
      startedAt: new Date().toISOString(),
      steps: [],
    }, origin)
    return true
  }

  #onEvent(event: HouseEvent): void {
    // Only events a routine can watch. Everything else would be a full table scan per event.
    if (!['device.state_changed', 'device.event', 'presence.changed', 'house.mode_changed'].includes(event.type)) return

    for (const routine of routines.active()) {
      for (const trigger of routine.triggers) {
        if (!this.#triggerMatchesEvent(trigger, event, routine)) continue

        const forSeconds = 'forSeconds' in trigger ? Number(trigger.forSeconds ?? 0) : 0
        const key = `${routine.id}:${JSON.stringify(trigger)}`

        if (forSeconds > 0) {
          // Hold the trigger open. If the state stops matching before the delay is up, the
          // pending run is cancelled in the branch below.
          if (this.#pendingTimers.has(key)) continue
          const timer = setTimeout(() => {
            this.#pendingTimers.delete(key)
            if (this.#stillTrue(trigger)) void this.#fire(routine, trigger, event)
          }, forSeconds * 1000)
          this.#pendingTimers.set(key, timer)
          continue
        }

        void this.#fire(routine, trigger, event)
      }

      // Cancel any pending debounce whose condition stopped holding.
      for (const trigger of routine.triggers) {
        const forSeconds = 'forSeconds' in trigger ? Number(trigger.forSeconds ?? 0) : 0
        if (forSeconds <= 0) continue
        const key = `${routine.id}:${JSON.stringify(trigger)}`
        const timer = this.#pendingTimers.get(key)
        if (timer && !this.#stillTrue(trigger)) {
          clearTimeout(timer)
          this.#pendingTimers.delete(key)
        }
      }
    }
  }

  #onMinute(): void {
    const now = new Date()
    const minute = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
    const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()] as 'mon'

    const isNewMinute = minute !== this.#lastMinute
    this.#lastMinute = minute

    for (const routine of routines.active()) {
      for (const trigger of routine.triggers) {
        if (trigger.kind === 'time' && isNewMinute) {
          if (trigger.at !== minute) continue
          if (trigger.days.length > 0 && !trigger.days.includes(day)) continue
          void this.#fire(routine, trigger, null)
        }

        if (trigger.kind === 'sun' && isNewMinute) {
          const times = solarTimes(now, this.#coordinates())
          const target = times[trigger.event]
          if (!target) continue
          const shifted = new Date(target.getTime() + trigger.offsetMinutes * 60_000)
          const shiftedMinute = `${shifted.getHours().toString().padStart(2, '0')}:${shifted.getMinutes().toString().padStart(2, '0')}`
          if (shiftedMinute === minute) void this.#fire(routine, trigger, null)
        }

        if (trigger.kind === 'interval') {
          const key = `${routine.id}:interval:${trigger.everySeconds}`
          const last = this.#intervalMarks.get(key) ?? 0
          if (Date.now() - last >= trigger.everySeconds * 1000) {
            this.#intervalMarks.set(key, Date.now())
            if (last !== 0) void this.#fire(routine, trigger, null)
          }
        }
      }
    }
  }

  #triggerMatchesEvent(trigger: Trigger, event: HouseEvent, _routine: Routine): boolean {
    switch (trigger.kind) {
      case 'device_state': {
        if (event.type !== 'device.state_changed') return false
        if (event.subjectId !== trigger.deviceId) return false
        const changes = event.payload.changes as Record<string, unknown>
        const previous = event.payload.previous as Record<string, unknown>
        if (!(trigger.attribute in changes)) return false
        return compare(changes[trigger.attribute], trigger.operator, trigger.value, previous[trigger.attribute])
      }

      case 'capability_state': {
        if (event.type !== 'device.state_changed') return false
        const device = deviceRepository.find(String(event.subjectId))
        if (!device) return false
        if (!device.capabilities.includes(trigger.capability as never)) return false
        if (trigger.areaId && device.areaId !== trigger.areaId) return false
        const changes = event.payload.changes as Record<string, unknown>
        const previous = event.payload.previous as Record<string, unknown>
        if (!(trigger.attribute in changes)) return false
        return compare(changes[trigger.attribute], trigger.operator, trigger.value, previous[trigger.attribute])
      }

      case 'device_event':
        return event.type === 'device.event' && event.subjectId === trigger.deviceId && event.payload.event === trigger.event

      case 'presence': {
        if (event.type !== 'presence.changed') return false
        const home = event.payload.home === true
        const personId = String(event.payload.personId ?? '')
        if (trigger.personId && trigger.personId !== personId) return false
        if (trigger.transition === 'arrives') return home
        if (trigger.transition === 'leaves') return !home
        if (trigger.transition === 'first_arrives') return home && Number(event.payload.homeCount ?? 0) === 1
        if (trigger.transition === 'last_leaves') return !home && Number(event.payload.homeCount ?? 0) === 0
        return false
      }

      case 'house_mode':
        return event.type === 'house.mode_changed' && event.payload.mode === trigger.mode

      default:
        return false
    }
  }

  /** Re-read the live state to confirm a debounced trigger still holds. */
  #stillTrue(trigger: Trigger): boolean {
    if (trigger.kind === 'device_state') {
      const device = deviceRepository.find(trigger.deviceId)
      if (!device) return false
      return compare(device.state[trigger.attribute], trigger.operator, trigger.value, undefined)
    }
    if (trigger.kind === 'capability_state') {
      const devices = deviceRepository.all({ capability: trigger.capability as never, areaId: trigger.areaId ?? undefined })
      return devices.some((device) => compare(device.state[trigger.attribute], trigger.operator, trigger.value, undefined))
    }
    return true
  }

  async #fire(routine: Routine, trigger: Trigger, event: HouseEvent | null, depth = 0): Promise<void> {
    if (!routine.enabled || routine.status !== 'active') return

    const existing = this.#running.get(routine.id)
    if (existing) {
      if (routine.mode === 'single') return
      if (routine.mode === 'restart') existing.abort()
      // `queued` and `parallel` both fall through; parallel simply does not wait.
    }

    const context: RunContext = {
      routine,
      trigger,
      event,
      depth,
      correlationId: event?.correlationId ?? randomUUID(),
      startedAt: new Date().toISOString(),
      steps: [],
    }

    if (!this.#conditionsHold(routine.conditions as Condition[])) return
    await this.#run(context, 'automation')
  }

  async #run(context: RunContext, origin: 'user' | 'agent' | 'api' | 'automation'): Promise<void> {
    const { routine } = context
    if (context.depth > 3) {
      bus.publish('automation.failed', {
        subjectType: 'automation',
        subjectId: routine.id,
        severity: 'warning',
        payload: { name: routine.name, error: 'Stopped: the routine chain went more than three levels deep, which is almost always a loop.' },
      })
      return
    }

    const controller = new AbortController()
    this.#running.set(routine.id, controller)

    // The run as a task: one step per action, so the console can show where it is.
    const task = tasks.start({
      kind: 'routine',
      title: routine.name,
      subtitle: context.trigger?.kind === 'manual' ? 'Lancée à la main' : 'Déclenchée',
      steps: routine.actions.map((action) => describeAction(action)),
      retry: { routineId: routine.id },
      onCancel: () => controller.abort(),
    })

    bus.publish('automation.triggered', {
      subjectType: 'automation',
      subjectId: routine.id,
      origin,
      correlationId: context.correlationId,
      payload: { name: routine.name, trigger: context.trigger?.kind ?? 'manual' },
    })

    let failure: string | null = null

    let failed = 0
    try {
      for (const [index, action] of routine.actions.entries()) {
        if (controller.signal.aborted) break
        task.step(index, 'running')
        const ok = await this.#runAction(action, context, controller.signal)
        context.steps.push({ action: action.kind, ok })
        task.step(index, ok ? 'done' : 'failed')
        task.progress((index + 1) / routine.actions.length)
        if (!ok) failed += 1
        bus.publish('automation.action_run', {
          subjectType: 'automation',
          subjectId: routine.id,
          correlationId: context.correlationId,
          payload: { name: routine.name, index, action: action.kind, ok },
        })
        if (action.kind === 'stop') break
      }
      if (failed > 0) task.fail(`${failed} action${failed > 1 ? 's' : ''} en échec`)
      else task.done()
    } catch (error) {
      failure = (error as Error).message
      task.fail(failure)
      bus.publish('automation.failed', {
        subjectType: 'automation',
        subjectId: routine.id,
        severity: 'warning',
        correlationId: context.correlationId,
        payload: { name: routine.name, error: failure },
      })
    } finally {
      this.#running.delete(routine.id)
      routines.markRun(routine.id)
      routines.recordRun({
        routineId: routine.id,
        trigger: context.trigger,
        steps: context.steps,
        status: failure ? 'failed' : controller.signal.aborted ? 'cancelled' : 'ok',
        error: failure,
        startedAt: context.startedAt,
      })
    }
  }

  async #runAction(action: Action, context: RunContext, signal: AbortSignal): Promise<boolean> {
    const options = {
      origin: 'automation' as const,
      originDetail: context.routine.name,
      correlationId: context.correlationId,
    }

    switch (action.kind) {
      case 'device_command': {
        if (action.deviceId) {
          const result = await houseService.execute(action.deviceId, action.command, action.args, options)
          return result.ok
        }
        if (action.selector) {
          const results = await houseService.executeMany(
            {
              areaId: action.selector.areaId ?? undefined,
              capability: (action.selector.capability ?? undefined) as never,
              category: (action.selector.category ?? undefined) as never,
            },
            action.command,
            action.args,
            options
          )
          return results.every((result) => result.ok)
        }
        return false
      }

      case 'scene': {
        const results = await houseService.applyScene(action.sceneId, options)
        return results.every((result) => result.ok)
      }

      case 'delay':
        await sleep(action.seconds * 1000, signal)
        return !signal.aborted

      case 'notify':
        bus.publish('system.notice', {
          origin: 'automation',
          correlationId: context.correlationId,
          severity: action.priority === 'critical' ? 'critical' : action.priority === 'high' ? 'warning' : 'notice',
          payload: { message: action.message, title: action.title ?? context.routine.name, channel: action.channel },
        })
        return true

      case 'speak': {
        const targets = action.deviceId
          ? [action.deviceId]
          : deviceRepository.all({ capability: 'speech' }).map((device) => device.id)
        if (targets.length === 0) return false
        const results = await Promise.all(targets.map((id) => houseService.execute(id, 'speak', { text: action.text }, options)))
        return results.some((result) => result.ok)
      }

      case 'set_house_mode':
        houseService.setMode(action.mode as never, 'automation')
        return true

      case 'run_routine':
        await this.#fire(routines.find(action.routineId)!, { kind: 'manual' }, null, context.depth + 1)
        return true

      case 'webhook': {
        // Outbound HTTP from a routine is the one place the hub touches the internet
        // without being asked, so it is blocked outright in local-only mode.
        const privacy = settings.get<{ localOnly?: boolean }>('agent', {}).localOnly
        if (privacy) return false
        const response = await fetch(action.url, {
          method: action.method,
          headers: { 'content-type': 'application/json' },
          body: action.method === 'POST' ? JSON.stringify(action.body) : undefined,
          signal,
        }).catch(() => null)
        return response?.ok === true
      }

      case 'wait_until': {
        const deadline = Date.now() + action.timeoutSeconds * 1000
        while (Date.now() < deadline) {
          if (signal.aborted) return false
          if (this.#conditionsHold([action.condition as Condition])) return true
          await sleep(1000, signal)
        }
        return false
      }

      case 'ask_agent': {
        // Imported lazily: the agent pulls in the model providers, and a hub with no key
        // configured must still run its routines.
        const { agentService } = await import('#agent/agent_service')
        const result = await agentService.runGoal(action.goal, { maxActions: action.maxActions, correlationId: context.correlationId, unattended: true })
        return result.ok
      }

      case 'stop':
        return true

      default:
        return false
    }
  }

  #conditionsHold(conditions: Condition[]): boolean {
    return conditions.every((condition) => this.#conditionHolds(condition))
  }

  #conditionHolds(condition: Condition): boolean {
    switch (condition.kind) {
      case 'device_state': {
        const device = deviceRepository.find(condition.deviceId)
        if (!device) return false
        return compare(device.state[condition.attribute], condition.operator, condition.value, undefined)
      }
      case 'time_window': {
        const now = new Date()
        const minutes = now.getHours() * 60 + now.getMinutes()
        const [afterHour = 0, afterMinute = 0] = condition.after.split(':').map(Number)
        const [beforeHour = 0, beforeMinute = 0] = condition.before.split(':').map(Number)
        const from = afterHour * 60 + afterMinute
        const to = beforeHour * 60 + beforeMinute
        const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()] as 'mon'
        if (condition.days.length > 0 && !condition.days.includes(day)) return false
        // A window that crosses midnight (22:00 to 07:00) is the common case for "night".
        return from <= to ? minutes >= from && minutes <= to : minutes >= from || minutes <= to
      }
      case 'sun_position': {
        const times = solarTimes(new Date(), this.#coordinates())
        const now = Date.now()
        const above = times.sunrise && times.sunset ? now > times.sunrise.getTime() && now < times.sunset.getTime() : true
        return condition.state === 'above_horizon' ? above : !above
      }
      case 'presence': {
        const list = people.all()
        if (condition.personId) {
          const person = list.find((candidate) => candidate.id === condition.personId)
          return person ? person.home === condition.home : false
        }
        const anyoneHome = list.some((person) => person.home)
        return anyoneHome === condition.home
      }
      case 'house_mode':
        return condition.modeIn.includes(house.mode())
      case 'area_occupied': {
        const devices = deviceRepository.all({ areaId: condition.areaId, capability: 'motion' })
        const occupied = devices.some((device) => device.state.motion === true || device.state.occupied === true)
        return occupied === condition.occupied
      }
      case 'numeric': {
        const value = evaluateExpression(condition.expression)
        return value === null ? false : compare(value, condition.operator, condition.value, undefined)
      }
      case 'and':
        return condition.conditions.every((child) => this.#conditionHolds(child))
      case 'or':
        return condition.conditions.some((child) => this.#conditionHolds(child))
      case 'not':
        return !this.#conditionHolds(condition.condition)
      default:
        return false
    }
  }

  #coordinates(): { latitude: number; longitude: number } {
    return settings.get('house.location', { latitude: 48.8566, longitude: 2.3522 })
  }
}

export const automationEngine = new AutomationEngine()

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

function compare(value: unknown, operator: string, expected: unknown, previous: unknown): boolean {
  switch (operator) {
    case 'eq':
      return value === expected
    case 'neq':
      return value !== expected
    case 'gt':
      return Number(value) > Number(expected)
    case 'gte':
      return Number(value) >= Number(expected)
    case 'lt':
      return Number(value) < Number(expected)
    case 'lte':
      return Number(value) <= Number(expected)
    case 'changed':
      return true
    case 'changed_to':
      return value === expected
    case 'changed_from':
      return previous === expected
    case 'in':
      return Array.isArray(expected) && expected.includes(value)
    case 'between': {
      if (!Array.isArray(expected) || expected.length !== 2) return false
      const numeric = Number(value)
      return numeric >= Number(expected[0]) && numeric <= Number(expected[1])
    }
    default:
      return false
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * `{{ device('id').attribute }}` and `{{ area('Salon').temperature }}`, evaluated without
 * an expression engine: routines need arithmetic on one value, not a language.
 */
function evaluateExpression(expression: string): number | null {
  const deviceMatch = /device\(['"]([^'"]+)['"]\)\.(\w+)/.exec(expression)
  if (deviceMatch?.[1] && deviceMatch[2]) {
    const device = deviceRepository.find(deviceMatch[1])
    const value = device?.state[deviceMatch[2]]
    return typeof value === 'number' ? value : null
  }

  const areaMatch = /area\(['"]([^'"]+)['"]\)\.(\w+)/.exec(expression)
  if (areaMatch?.[1] && areaMatch[2]) {
    const area = places.areas().find((candidate) => candidate.name.toLowerCase() === areaMatch[1]!.toLowerCase())
    if (!area) return null
    const values = deviceRepository
      .all({ areaId: area.id })
      .map((device) => device.state[areaMatch[2]!])
      .filter((value): value is number => typeof value === 'number')
    if (values.length === 0) return null
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }

  const numeric = Number(expression)
  return Number.isFinite(numeric) ? numeric : null
}

/**
 * Sunrise and sunset from latitude and longitude, NOAA's approximation. Around a minute of
 * error at these latitudes, which is well inside what a lighting routine cares about, and
 * it removes a dependency that would otherwise be pulled in for two numbers a day.
 */
export function solarTimes(date: Date, coordinates: { latitude: number; longitude: number }): Record<string, Date | null> {
  const rad = Math.PI / 180
  const dayMs = 86_400_000
  const j1970 = 2_440_588
  const j2000 = 2_451_545

  const toJulian = (value: Date) => value.valueOf() / dayMs - 0.5 + j1970
  const fromJulian = (julian: number) => new Date((julian + 0.5 - j1970) * dayMs)
  const days = toJulian(date) - j2000

  const meanAnomaly = rad * (357.5291 + 0.98560028 * days)
  const equationOfCentre = rad * (1.9148 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly) + 0.0003 * Math.sin(3 * meanAnomaly))
  const perihelion = rad * 102.9372
  const eclipticLongitude = meanAnomaly + equationOfCentre + perihelion + Math.PI
  const obliquity = rad * 23.4397
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude))

  const longitudeWest = -coordinates.longitude * rad
  const approxTransit = Math.round(days - 0.0009 - longitudeWest / (2 * Math.PI))
  const solarNoonJulian =
    j2000 + approxTransit + 0.0009 + longitudeWest / (2 * Math.PI) + 0.0053 * Math.sin(meanAnomaly) - 0.0069 * Math.sin(2 * eclipticLongitude)

  const hourAngle = (angle: number) => {
    const latitude = coordinates.latitude * rad
    const cosine = (Math.sin(angle * rad) - Math.sin(latitude) * Math.sin(declination)) / (Math.cos(latitude) * Math.cos(declination))
    if (cosine > 1 || cosine < -1) return null // polar day or night
    return Math.acos(cosine)
  }

  const eventJulian = (angle: number, rising: boolean) => {
    const angleHour = hourAngle(angle)
    if (angleHour === null) return null
    const setJulian = j2000 + approxTransit + 0.0009 + (angleHour + longitudeWest) / (2 * Math.PI) + 0.0053 * Math.sin(meanAnomaly) - 0.0069 * Math.sin(2 * eclipticLongitude)
    return fromJulian(rising ? solarNoonJulian - (setJulian - solarNoonJulian) : setJulian)
  }

  return {
    sunrise: eventJulian(-0.833, true),
    sunset: eventJulian(-0.833, false),
    dawn: eventJulian(-6, true),
    dusk: eventJulian(-6, false),
    solar_noon: fromJulian(solarNoonJulian),
  }
}
