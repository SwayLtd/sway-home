/**
 * The insight engine: what the hub notices on its own.
 *
 * Three jobs, all on a timer, none of which need a language model:
 *  1. **Roll-ups.** Compact `state_history` into hourly energy and sensor aggregates, so a
 *     month of charts is a hundred rows rather than a million.
 *  2. **Watchdogs.** Batteries dying, devices that stopped answering, a leak, a window left
 *     open while the heating runs, a load drawing power all night. These become alerts.
 *  3. **Routine suggestions.** Patterns in the event log that look like a habit worth
 *     automating, and sensible starting routines for a device that was just added.
 *
 * Suggestions are written to the routines table with `status: 'suggested'`, so they appear
 * in the UI as a card to accept or dismiss and never run until a human says yes. The agent
 * can write better ones with an LLM, but everything here works with no key configured -
 * which is the point: the product has to be useful before it is paid for.
 */

import type { Routine, RoutineAlternative } from '@sway-home/shared'
import { database, nowIso } from '#db/database'
import { bus } from '#services/event_bus'
import { deviceRepository } from '#repositories/device_repository'
import { alerts, places, routines, settings } from '#repositories/store'

type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
/** `Date.getDay()` order: Sunday first. */
const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const WORKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri']
const WEEKEND: Weekday[] = ['sat', 'sun']

export interface Habit {
  deviceId: string
  deviceName: string
  command: string
  hour: number
  occurrences: number
  /** The days it happens on; empty means every day. */
  days: Weekday[]
}

const HABIT_VERB: Record<string, string> = {
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

/**
 * The days a habit happens on: weekdays when four presses in five fall on them, the weekend
 * likewise, every day otherwise.
 */
export function habitDays(counts: Partial<Record<Weekday, number>>): Weekday[] {
  const total = Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0)
  if (total === 0) return []
  const share = (days: Weekday[]) => days.reduce((sum, day) => sum + (counts[day] ?? 0), 0) / total
  if (share(WORKDAYS) >= 0.8) return [...WORKDAYS]
  if (share(WEEKEND) >= 0.8) return [...WEEKEND]
  return []
}

/** How sure the hub is about a habit: more presses, more certainty, never all of it. */
export function habitConfidence(occurrences: number): number {
  return Math.min(0.95, 0.35 + 0.05 * occurrences)
}

/**
 * Other ways to do what a habit does: every day (or weekdays only), at sunrise for a morning
 * habit or sunset for an evening one, and on the first movement in the room when the room has
 * a motion sensor, around the usual hour.
 */
function habitAlternatives(habit: Habit, areaId: string | null): RoutineAlternative[] {
  const at = `${String(habit.hour).padStart(2, '0')}:00`
  const out: RoutineAlternative[] = []

  if (habit.days.length > 0) {
    out.push({ id: 'every-day', title: 'Tous les jours', description: `À ${habit.hour} h, week-end compris.`, triggers: [{ kind: 'time', at, days: [] }] })
  } else {
    out.push({ id: 'weekdays', title: 'En semaine seulement', description: `À ${habit.hour} h, du lundi au vendredi.`, triggers: [{ kind: 'time', at, days: [...WORKDAYS] }] })
  }

  if (habit.hour >= 5 && habit.hour <= 10) {
    out.push({ id: 'sunrise', title: 'Au lever du soleil', description: "Suit l'heure du lever au fil des saisons.", triggers: [{ kind: 'sun', event: 'sunrise', offsetMinutes: 0 }] })
  } else if (habit.hour >= 16 && habit.hour <= 21) {
    out.push({ id: 'sunset', title: 'Au coucher du soleil', description: "Suit l'heure du coucher au fil des saisons.", triggers: [{ kind: 'sun', event: 'sunset', offsetMinutes: 0 }] })
  }

  const motion = areaId ? deviceRepository.all({ areaId, capability: 'motion' })[0] : undefined
  if (motion) {
    const from = `${String(Math.max(0, habit.hour - 1)).padStart(2, '0')}:00`
    const to = `${String(Math.min(23, habit.hour + 2)).padStart(2, '0')}:00`
    out.push({
      id: 'motion',
      title: 'Au premier mouvement',
      description: `Quand ${motion.name} détecte quelqu'un, entre ${Math.max(0, habit.hour - 1)} h et ${Math.min(23, habit.hour + 2)} h.`,
      triggers: [{ kind: 'device_state', deviceId: motion.id, attribute: 'motion', operator: 'changed_to', value: true, forSeconds: 0 }],
      conditions: [{ kind: 'time_window', after: from, before: to, days: [] }],
    })
  }

  return out
}

class InsightEngine {
  #rollupTimer: ReturnType<typeof setInterval> | null = null
  #watchdogTimer: ReturnType<typeof setInterval> | null = null
  #unsubscribe: (() => void) | null = null
  #unsubscribeState: (() => void) | null = null

  start(): void {
    if (this.#rollupTimer) return
    this.#rollupTimer = setInterval(() => this.rollUp(), 10 * 60_000)
    this.#watchdogTimer = setInterval(() => this.runWatchdogs(), 5 * 60_000)

    // A new device is the one moment the user is definitely thinking about it, so that is
    // when a suggestion is worth making.
    this.#unsubscribe = bus.on('device.added', (event) => {
      if (!settings.get<{ proactivity?: { suggestOnNewDevice?: boolean } }>('agent', {}).proactivity?.suggestOnNewDevice) return
      const deviceId = event.subjectId
      if (deviceId) setTimeout(() => this.suggestForDevice(deviceId), 3000)
    })

    // Safety cannot wait for the five-minute tick. A leak, smoke or a door unlocking is
    // checked the moment the state arrives; everything slower stays on the timer.
    this.#unsubscribeState = bus.on('device.state_changed', (event) => {
      const changes = (event.payload as { changes?: Record<string, unknown> }).changes ?? {}
      if (!('leak' in changes || 'smoke' in changes || 'battery' in changes || 'open' in changes)) return
      const deviceId = event.subjectId
      if (deviceId) this.checkDevice(deviceId)
    })

    setTimeout(() => this.runWatchdogs(), 30_000)
  }

  /** The urgent subset of runWatchdogs, for one device, run the instant its state changes. */
  checkDevice(deviceId: string): void {
    const device = deviceRepository.find(deviceId)
    if (!device) return
    const areaName = device.areaId ? places.areas().find((area) => area.id === device.areaId)?.name ?? null : null

    if (device.state.leak === true) {
      this.#alert({ kind: 'leak', severity: 'critical', title: `Fuite d'eau détectée : ${device.name}`, detail: areaName, subjectId: device.id })
    } else {
      alerts.clear('leak', device.id)
    }

    if (device.state.smoke === true) {
      this.#alert({ kind: 'smoke', severity: 'critical', title: `Fumée détectée : ${device.name}`, detail: areaName, subjectId: device.id })
    } else {
      alerts.clear('smoke', device.id)
    }

    const battery = device.state.battery
    if (typeof battery === 'number' && battery <= 10) {
      this.#alert({
        kind: 'battery_critical',
        severity: 'critical',
        title: `${device.name} : pile à ${battery} %`,
        detail: 'À remplacer avant que le capteur cesse de répondre.',
        subjectId: device.id,
      })
    }
  }

  stop(): void {
    if (this.#rollupTimer) clearInterval(this.#rollupTimer)
    if (this.#watchdogTimer) clearInterval(this.#watchdogTimer)
    this.#rollupTimer = null
    this.#watchdogTimer = null
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#unsubscribeState?.()
    this.#unsubscribeState = null
  }

  // -------------------------------------------------------------------------------------
  // Roll-ups
  // -------------------------------------------------------------------------------------

  rollUp(): { energyRows: number; sensorRows: number; pruned: number } {
    const db = database()
    const cutoff = new Date(Date.now() - 60 * 60_000).toISOString()

    // Energy: average and peak power per device per hour, plus the kWh that implies.
    const energyRows = db.all<{ device_id: string; hour: string; avg_power: number; max_power: number; samples: number }>(
      `SELECT device_id,
              substr(at, 1, 13) AS hour,
              AVG(value_num) AS avg_power,
              MAX(value_num) AS max_power,
              COUNT(*) AS samples
       FROM state_history
       WHERE attribute = 'power' AND value_num IS NOT NULL AND at < ?
       GROUP BY device_id, hour`,
      [cutoff]
    )

    const price = settings.get<{ pricePerKwh: number }>('energy', { pricePerKwh: 0.2516 }).pricePerKwh
    for (const row of energyRows) {
      const kwh = Number(((row.avg_power / 1000) * 1).toFixed(5)) // one hour of the average
      db.run(
        `INSERT INTO energy_hourly (device_id, hour, kwh, avg_power, max_power, cost)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, hour) DO UPDATE SET kwh = excluded.kwh, avg_power = excluded.avg_power, max_power = excluded.max_power, cost = excluded.cost`,
        [row.device_id, row.hour, kwh, Number(row.avg_power.toFixed(2)), Number(row.max_power.toFixed(2)), Number((kwh * price).toFixed(4))]
      )
    }

    // Sensors: min, max and mean per attribute per hour.
    const sensorRows = db.all<{ device_id: string; attribute: string; hour: string; min_value: number; max_value: number; avg_value: number; samples: number }>(
      `SELECT device_id, attribute,
              substr(at, 1, 13) AS hour,
              MIN(value_num) AS min_value,
              MAX(value_num) AS max_value,
              AVG(value_num) AS avg_value,
              COUNT(*) AS samples
       FROM state_history
       WHERE value_num IS NOT NULL AND attribute IN ('temperature','humidity','illuminance','co2','pm25','pressure','battery','voc')
         AND at < ?
       GROUP BY device_id, attribute, hour`,
      [cutoff]
    )

    for (const row of sensorRows) {
      db.run(
        `INSERT INTO sensor_hourly (device_id, attribute, hour, min_value, max_value, avg_value, samples)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, attribute, hour) DO UPDATE SET min_value = excluded.min_value, max_value = excluded.max_value, avg_value = excluded.avg_value, samples = excluded.samples`,
        [row.device_id, row.attribute, row.hour, row.min_value, row.max_value, Number(row.avg_value.toFixed(3)), row.samples]
      )
    }

    // Raw history older than the retention window is now redundant with the roll-ups.
    const retainDays = settings.get('history.retainRawDays', 7)
    const rawCutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString()
    const pruned = db.run('DELETE FROM state_history WHERE at < ?', [rawCutoff]).changes

    return { energyRows: energyRows.length, sensorRows: sensorRows.length, pruned }
  }

  // -------------------------------------------------------------------------------------
  // Watchdogs
  // -------------------------------------------------------------------------------------

  /**
   * Raise an alert and put it on the bus the first time only. The narrator listens there,
   * and a watchdog that re-raises the same leak every five minutes must not re-announce it.
   */
  #alert(input: {
    kind: string
    severity?: 'info' | 'notice' | 'warning' | 'critical'
    title: string
    detail?: string | null
    subjectType?: string
    subjectId?: string | null
  }): void {
    const isNew = alerts.isNew(input.kind, input.subjectId ?? null)
    const alert = alerts.raise(input as Parameters<typeof alerts.raise>[0])
    if (!isNew) return
    bus.publish('alert.raised', {
      subjectType: (input.subjectType ?? 'device') as 'device' | 'area',
      subjectId: input.subjectId ?? null,
      origin: 'system',
      severity: input.severity === 'critical' ? 'critical' : input.severity === 'warning' ? 'warning' : 'info',
      payload: { alertId: alert.id, kind: input.kind, title: input.title, detail: input.detail ?? null, severity: input.severity ?? 'warning' },
    })
  }

  runWatchdogs(): void {
    const devices = deviceRepository.all({ includeHidden: false, limit: 1000 })
    const areaById = new Map(places.areas().map((area) => [area.id, area.name]))

    for (const device of devices) {
      const battery = device.state.battery
      if (typeof battery === 'number') {
        if (battery <= 10) {
          this.#alert({ kind: 'battery_critical', severity: 'critical', title: `${device.name} : pile à ${battery} %`, detail: 'À remplacer avant que le capteur cesse de répondre.', subjectId: device.id })
        } else if (battery <= 20) {
          this.#alert({ kind: 'battery_low', severity: 'warning', title: `${device.name} : pile à ${battery} %`, subjectId: device.id })
        } else {
          alerts.clear('battery_low', device.id)
          alerts.clear('battery_critical', device.id)
        }
      }

      if (device.state.leak === true) {
        this.#alert({ kind: 'leak', severity: 'critical', title: `Fuite d'eau détectée : ${device.name}`, detail: areaById.get(device.areaId ?? '') ?? null, subjectId: device.id })
      } else {
        alerts.clear('leak', device.id)
      }

      if (device.state.smoke === true) {
        this.#alert({ kind: 'smoke', severity: 'critical', title: `Fumée détectée : ${device.name}`, subjectId: device.id })
      } else {
        alerts.clear('smoke', device.id)
      }

      // Offline for more than an hour is a real fault; a minute is a Wi-Fi hiccup.
      if (!device.online && device.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() > 3_600_000) {
        this.#alert({ kind: 'offline', severity: 'warning', title: `${device.name} ne répond plus depuis une heure`, subjectId: device.id })
      } else if (device.online) {
        alerts.clear('offline', device.id)
      }

      if (device.state.updateAvailable === true) {
        this.#alert({ kind: 'firmware', severity: 'info', title: `Mise à jour disponible pour ${device.name}`, subjectId: device.id })
      } else {
        alerts.clear('firmware', device.id)
      }
    }

    this.#heatingWithWindowOpen(devices, areaById)
    this.#standbyDrain(devices)
  }

  /** Heating on in a room whose window is open: the most expensive mistake in a flat. */
  #heatingWithWindowOpen(devices: ReturnType<typeof deviceRepository.all>, areaById: Map<string, string>): void {
    const byArea = new Map<string, typeof devices>()
    for (const device of devices) {
      if (!device.areaId) continue
      const list = byArea.get(device.areaId) ?? []
      list.push(device)
      byArea.set(device.areaId, list)
    }

    for (const [areaId, list] of byArea) {
      const heating = list.find((device) => device.state.hvacAction === 'heating' || (device.state.hvacMode === 'heat' && Number(device.state.targetTemperature ?? 0) > Number(device.state.currentTemperature ?? 99)))
      const openWindow = list.find((device) => device.state.open === true)
      const key = `${areaId}`

      if (heating && openWindow) {
        this.#alert({
          kind: 'heating_window_open',
          severity: 'warning',
          title: `${areaById.get(areaId) ?? 'Une pièce'} : le chauffage tourne fenêtre ouverte`,
          detail: `${openWindow.name} est ouvert et ${heating.name} chauffe.`,
          subjectType: 'area',
          subjectId: key,
        })
      } else {
        alerts.clear('heating_window_open', key)
      }
    }
  }

  /** Something drawing real power through the night, every night, is usually forgotten. */
  #standbyDrain(devices: ReturnType<typeof deviceRepository.all>): void {
    const hour = new Date().getHours()
    if (hour < 3 || hour > 5) return

    for (const device of devices) {
      const power = device.state.power
      if (typeof power !== 'number' || power < 15) continue
      this.#alert({
        kind: 'night_drain',
        severity: 'info',
        title: `${device.name} tire ${power} W en pleine nuit`,
        detail: "À vérifier : est-ce qu'il doit rester allumé ?",
        subjectId: device.id,
      })
    }
  }

  // -------------------------------------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------------------------------------

  /**
   * Starting routines for a device that was just added, chosen from its capabilities and
   * its room. Deterministic, so it works on a hub with no model configured; the agent
   * rewrites them into something better when it has one.
   */
  suggestForDevice(deviceId: string): Routine[] {
    const device = deviceRepository.find(deviceId)
    if (!device) return []

    const areaName = device.areaId ? places.areas().find((area) => area.id === device.areaId)?.name ?? null : null
    const existing = routines.all().map((routine) => routine.name)
    const created: Routine[] = []

    const propose = (draft: {
      name: string
      description: string
      reason: string
      confidence: number
      alternatives?: RoutineAlternative[]
      triggers: Routine['triggers']
      conditions?: Routine['conditions']
      actions: Routine['actions']
    }) => {
      if (existing.includes(draft.name)) return
      const routine = routines.create({
        name: draft.name,
        description: draft.description,
        enabled: true,
        mode: 'restart',
        triggers: draft.triggers,
        conditions: draft.conditions ?? [],
        actions: draft.actions,
        authoredBy: 'agent',
        status: 'suggested',
        suggestionReason: draft.reason,
        confidence: draft.confidence,
        alternatives: draft.alternatives ?? [],
        areaId: device.areaId,
      })
      created.push(routine)
      bus.publish('automation.suggested', {
        subjectType: 'automation',
        subjectId: routine.id,
        origin: 'agent',
        payload: { name: routine.name, reason: draft.reason, deviceId: device.id, deviceName: device.name },
      })
    }

    const capabilities = new Set(device.capabilities)

    if (capabilities.has('motion') && device.areaId) {
      const lights = deviceRepository.all({ areaId: device.areaId, capability: 'onoff' }).filter((candidate) => candidate.category === 'light')
      if (lights.length > 0) {
        const selector = { areaId: device.areaId, capability: 'onoff', category: 'light', tag: null }
        const lightOn = { kind: 'device_command' as const, deviceId: null, selector, command: 'turnOn', args: { transitionMs: 600 } }
        const waitStill = { kind: 'wait_until' as const, condition: { kind: 'device_state' as const, deviceId: device.id, attribute: 'motion', operator: 'eq' as const, value: false }, timeoutSeconds: 900 }
        const lightOff = { kind: 'device_command' as const, deviceId: null, selector, command: 'turnOff', args: { transitionMs: 2000 } }
        propose({
          name: `${areaName ?? 'Pièce'} : lumière au passage`,
          description: `Allume les lumières quand ${device.name} détecte un mouvement, et les éteint deux minutes après.`,
          reason: `${device.name} vient d'arriver et ${lights.length === 1 ? 'une lumière est' : `${lights.length} lumières sont`} dans la même pièce.`,
          confidence: 0.8,
          triggers: [{ kind: 'device_state', deviceId: device.id, attribute: 'motion', operator: 'changed_to', value: true, forSeconds: 0 }],
          conditions: [{ kind: 'sun_position', state: 'below_horizon' }],
          actions: [lightOn, waitStill, { kind: 'delay', seconds: 120 }, lightOff],
          alternatives: [
            { id: 'all-day', title: 'De jour comme de nuit', description: 'Sans attendre le coucher du soleil.', conditions: [] },
            { id: 'five-minutes', title: 'Éteindre après 5 min', description: 'Plus de temps avant que la lumière ne s\'éteigne.', actions: [lightOn, waitStill, { kind: 'delay', seconds: 300 }, lightOff] },
          ],
        })
      }
    }

    if (capabilities.has('contact') && device.areaId) {
      const thermostats = deviceRepository.all({ areaId: device.areaId, capability: 'thermostat' })
      const thermostat = thermostats[0]
      if (thermostat) {
        propose({
          name: `${areaName ?? 'Pièce'} : couper le chauffage fenêtre ouverte`,
          description: `Éteint ${thermostat.name} tant que ${device.name} est ouvert, et le rallume à la fermeture.`,
          reason: 'Un capteur d\'ouverture et un thermostat dans la même pièce : la première économie de la maison.',
          confidence: 0.85,
          triggers: [{ kind: 'device_state', deviceId: device.id, attribute: 'open', operator: 'changed_to', value: true, forSeconds: 60 }],
          actions: [
            { kind: 'device_command', deviceId: thermostat.id, selector: null, command: 'setHvacMode', args: { mode: 'off' } },
            { kind: 'wait_until', condition: { kind: 'device_state', deviceId: device.id, attribute: 'open', operator: 'eq', value: false }, timeoutSeconds: 3600 },
            { kind: 'device_command', deviceId: thermostat.id, selector: null, command: 'setHvacMode', args: { mode: 'heat' } },
          ],
          alternatives: [
            {
              id: 'after-5-min',
              title: 'Après 5 min ouverte',
              description: 'Laisse le temps d\'aérer sans couper le chauffage.',
              triggers: [{ kind: 'device_state', deviceId: device.id, attribute: 'open', operator: 'changed_to', value: true, forSeconds: 300 }],
            },
          ],
        })
      }
    }

    if (capabilities.has('lock')) {
      const lock = { kind: 'device_command' as const, deviceId: device.id, selector: null, command: 'lock', args: {} }
      propose({
        name: `Verrouiller ${device.name} la nuit`,
        description: 'Verrouille la porte chaque soir à 23 h si elle ne l\'est pas déjà.',
        reason: 'Une serrure qu\'on ne ferme qu\'à la main reste parfois ouverte.',
        confidence: 0.7,
        triggers: [{ kind: 'time', at: '23:00', days: [] }],
        conditions: [{ kind: 'device_state', deviceId: device.id, attribute: 'locked', operator: 'eq', value: false }],
        actions: [lock, { kind: 'notify', message: `${device.name} a été verrouillée pour la nuit.`, channel: 'web', priority: 'low' }],
        alternatives: [
          { id: '22h', title: 'À 22 h', description: 'Une heure plus tôt.', triggers: [{ kind: 'time', at: '22:00', days: [] }] },
          { id: 'night-mode', title: 'En passant en mode Nuit', description: 'Quand la maison se met en mode Nuit, à l\'heure où on se couche.', triggers: [{ kind: 'house_mode', mode: 'night' }] },
          { id: 'last-leaves', title: 'Quand tout le monde part', description: 'Au départ de la dernière personne.', triggers: [{ kind: 'presence', personId: null, transition: 'last_leaves' }] },
        ],
      })
    }

    if (capabilities.has('waterLeak')) {
      const valves = deviceRepository.all({ capability: 'valve' })
      const valve = valves[0]
      propose({
        name: `Fuite d'eau : ${device.name}`,
        description: valve ? "Ferme la vanne d'eau et déclenche une alerte critique." : "Déclenche une alerte critique dès que de l'eau est détectée.",
        reason: 'Un détecteur de fuite sans routine, c\'est une alarme qui sonne dans un appartement vide.',
        confidence: 0.95,
        triggers: [{ kind: 'device_state', deviceId: device.id, attribute: 'leak', operator: 'changed_to', value: true, forSeconds: 0 }],
        actions: [
          ...(valve ? [{ kind: 'device_command' as const, deviceId: valve.id, selector: null, command: 'closeValve', args: {} }] : []),
          { kind: 'notify', message: `De l'eau a été détectée par ${device.name}.`, title: 'Fuite', channel: 'all', priority: 'critical' },
          { kind: 'speak', text: `Attention, fuite d'eau détectée par ${device.name}.`, deviceId: null },
        ],
      })
    }

    if (capabilities.has('power') && device.category === 'outlet') {
      propose({
        name: `${device.name} : prévenir quand c'est fini`,
        description: "Surveille la consommation et prévient quand l'appareil branché s'est arrêté.",
        reason: 'Une prise qui mesure la consommation sait dire que la lessive est finie, sans rien ajouter.',
        confidence: 0.6,
        triggers: [{ kind: 'device_state', deviceId: device.id, attribute: 'power', operator: 'lt', value: 5, forSeconds: 300 }],
        conditions: [],
        actions: [{ kind: 'notify', message: `${device.name} a terminé.`, channel: 'all', priority: 'normal' }],
        alternatives: [
          {
            id: 'ten-minutes',
            title: 'Après 10 min sous 5 W',
            description: 'Pour les appareils qui marquent des pauses, comme un lave-vaisselle.',
            triggers: [{ kind: 'device_state', deviceId: device.id, attribute: 'power', operator: 'lt', value: 5, forSeconds: 600 }],
          },
        ],
      })
    }

    return created
  }

  /**
   * Habits in the event log: the same manual command at roughly the same time on several
   * days is a routine waiting to be written. Grouped by the local hour of each press - the
   * hour a time trigger is written in - and with the days of the week it happened on.
   */
  findHabits(minOccurrences = 4): Habit[] {
    const since = new Date(Date.now() - 21 * 86_400_000).toISOString()
    const rows = database().all<{ subject_id: string; at: string; payload: string }>(
      `SELECT subject_id, at, payload FROM events
       WHERE type = 'device.command_sent' AND origin = 'user' AND at > ?
       ORDER BY at DESC LIMIT 5000`,
      [since]
    )

    const groups = new Map<string, { deviceId: string; command: string; hour: number; occurrences: number; days: Partial<Record<Weekday, number>> }>()
    for (const row of rows) {
      let command: string
      try {
        command = String((JSON.parse(row.payload) as { command?: unknown }).command ?? '')
      } catch {
        continue
      }
      if (!command) continue
      const at = new Date(row.at)
      const hour = at.getHours()
      const day = WEEKDAYS[at.getDay()]!
      const key = `${row.subject_id}|${command}|${hour}`
      const group = groups.get(key) ?? { deviceId: row.subject_id, command, hour, occurrences: 0, days: {} }
      group.occurrences += 1
      group.days[day] = (group.days[day] ?? 0) + 1
      groups.set(key, group)
    }

    return [...groups.values()]
      .filter((group) => group.occurrences >= minOccurrences)
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 20)
      .map((group) => {
        const device = deviceRepository.find(group.deviceId)
        return device
          ? { deviceId: device.id, deviceName: device.name, command: group.command, hour: group.hour, occurrences: group.occurrences, days: habitDays(group.days) }
          : null
      })
      .filter((habit): habit is Habit => habit !== null)
  }

  /** Turn a detected habit into a suggested routine, with the other ways to do it. */
  suggestFromHabits(): Routine[] {
    const created: Routine[] = []
    const existing = routines.all().map((routine) => routine.name)

    for (const habit of this.findHabits()) {
      const verb = HABIT_VERB[habit.command] ?? habit.command
      const name = `${habit.deviceName} : ${verb} à ${habit.hour} h`
      if (existing.includes(name)) continue

      const device = deviceRepository.find(habit.deviceId)
      const at = `${String(habit.hour).padStart(2, '0')}:00`
      const when = habit.days.length === 5 && !habit.days.includes('sat') ? ', en semaine' : habit.days.length === 2 && habit.days.includes('sat') ? ', le week-end' : ''
      const reason = `Fait à la main ${habit.occurrences} fois en trois semaines, vers ${habit.hour} h${when}.`

      const routine = routines.create({
        name,
        description: `Refait chaque jour à ${habit.hour} h ce que vous faites à la main.`,
        enabled: true,
        mode: 'single',
        triggers: [{ kind: 'time', at, days: habit.days }],
        conditions: [],
        actions: [{ kind: 'device_command', deviceId: habit.deviceId, selector: null, command: habit.command, args: {} }],
        authoredBy: 'agent',
        status: 'suggested',
        suggestionReason: reason,
        confidence: habitConfidence(habit.occurrences),
        alternatives: habitAlternatives(habit, device?.areaId ?? null),
        areaId: device?.areaId ?? null,
      })
      created.push(routine)
      bus.publish('automation.suggested', {
        subjectType: 'automation',
        subjectId: routine.id,
        origin: 'agent',
        payload: { name: routine.name, reason, occurrences: habit.occurrences },
      })
    }

    return created
  }

  /**
   * Approve a suggested routine, as proposed or with one of its alternatives: the parts the
   * alternative carries (trigger, conditions, actions) replace the routine's. An unknown
   * alternative approves nothing.
   */
  approveSuggestion(routineId: string, alternativeId?: string): Routine | null {
    const routine = routines.find(routineId)
    if (!routine) return null
    const alternative = alternativeId ? routine.alternatives?.find((candidate) => candidate.id === alternativeId) : undefined
    if (alternativeId && !alternative) return null

    return routines.update(routineId, {
      status: 'active',
      enabled: true,
      ...(alternative?.triggers ? { triggers: alternative.triggers } : {}),
      ...(alternative?.conditions ? { conditions: alternative.conditions } : {}),
      ...(alternative?.actions ? { actions: alternative.actions } : {}),
    })
  }

  /** A short morning summary, built without a model. */
  briefing(): { headline: string; lines: string[]; at: string } {
    const devices = deviceRepository.all({ limit: 1000 })
    const open = alerts.open()
    const lines: string[] = []

    const outside = devices.find((device) => /ext|jardin|outdoor|garden/i.test(device.name) && typeof device.state.temperature === 'number')
    if (outside) lines.push(`Il fait ${outside.state.temperature} °C dehors.`)

    const inside = devices.filter((device) => typeof device.state.temperature === 'number' && device !== outside)
    if (inside.length > 0) {
      const average = inside.reduce((sum, device) => sum + Number(device.state.temperature), 0) / inside.length
      lines.push(`Température moyenne à l'intérieur : ${average.toFixed(1)} °C.`)
    }

    const lightsOn = devices.filter((device) => device.category === 'light' && device.state.on === true)
    if (lightsOn.length > 0) lines.push(`${lightsOn.length} lumière${lightsOn.length > 1 ? 's' : ''} encore allumée${lightsOn.length > 1 ? 's' : ''}.`)

    const unlocked = devices.filter((device) => device.state.locked === false)
    if (unlocked.length > 0) lines.push(`Non verrouillé : ${unlocked.map((device) => device.name).join(', ')}.`)

    const totalPower = devices.reduce((sum, device) => sum + (typeof device.state.power === 'number' ? device.state.power : 0), 0)
    if (totalPower > 0) lines.push(`Consommation instantanée : ${Math.round(totalPower)} W.`)

    if (open.length > 0) lines.push(`${open.length} alerte${open.length > 1 ? 's' : ''} : ${open.slice(0, 3).map((alert) => alert.title).join(' | ')}`)

    const suggested = routines.all('suggested')
    if (suggested.length > 0) lines.push(`${suggested.length} routine${suggested.length > 1 ? 's' : ''} proposée${suggested.length > 1 ? 's' : ''} en attente.`)

    return {
      headline: open.some((alert) => alert.severity === 'critical') ? 'Il y a quelque chose à regarder.' : 'Tout est normal.',
      lines,
      at: nowIso(),
    }
  }
}

export const insightEngine = new InsightEngine()
