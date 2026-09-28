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

import type { Routine } from '@sway-home/shared'
import { database, nowIso } from '#db/database'
import { bus } from '#services/event_bus'
import { deviceRepository } from '#repositories/device_repository'
import { alerts, places, routines, settings } from '#repositories/store'

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

    const propose = (draft: { name: string; description: string; reason: string; triggers: Routine['triggers']; conditions?: Routine['conditions']; actions: Routine['actions'] }) => {
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
        propose({
          name: `${areaName ?? 'Room'}: light on movement`,
          description: `Turns the lights on when ${device.name} sees movement, and off two minutes after it stops.`,
          reason: `${device.name} was just added and there ${lights.length === 1 ? 'is a light' : `are ${lights.length} lights`} in the same room.`,
          triggers: [{ kind: 'device_state', deviceId: device.id, attribute: 'motion', operator: 'changed_to', value: true, forSeconds: 0 }],
          conditions: [{ kind: 'sun_position', state: 'below_horizon' }],
          actions: [
            { kind: 'device_command', deviceId: null, selector: { areaId: device.areaId, capability: 'onoff', category: 'light', tag: null }, command: 'turnOn', args: { transitionMs: 600 } },
            { kind: 'wait_until', condition: { kind: 'device_state', deviceId: device.id, attribute: 'motion', operator: 'eq', value: false }, timeoutSeconds: 900 },
            { kind: 'delay', seconds: 120 },
            { kind: 'device_command', deviceId: null, selector: { areaId: device.areaId, capability: 'onoff', category: 'light', tag: null }, command: 'turnOff', args: { transitionMs: 2000 } },
          ],
        })
      }
    }

    if (capabilities.has('contact') && device.areaId) {
      const thermostats = deviceRepository.all({ areaId: device.areaId, capability: 'thermostat' })
      if (thermostats.length > 0 && thermostats[0]) {
        propose({
          name: `${areaName ?? 'Room'}: pause the heating when the window opens`,
          description: `Switches ${thermostats[0].name} off while ${device.name} is open, and restores it when it closes.`,
          reason: 'A contact sensor and a thermostat in the same room is the cheapest saving in the house.',
          triggers: [{ kind: 'device_state', deviceId: device.id, attribute: 'open', operator: 'changed_to', value: true, forSeconds: 60 }],
          actions: [
            { kind: 'device_command', deviceId: thermostats[0].id, selector: null, command: 'setHvacMode', args: { mode: 'off' } },
            { kind: 'wait_until', condition: { kind: 'device_state', deviceId: device.id, attribute: 'open', operator: 'eq', value: false }, timeoutSeconds: 3600 },
            { kind: 'device_command', deviceId: thermostats[0].id, selector: null, command: 'setHvacMode', args: { mode: 'heat' } },
          ],
        })
      }
    }

    if (capabilities.has('lock')) {
      propose({
        name: `Lock ${device.name} at night`,
        description: 'Locks the door every night at 23:00 if it is not already locked.',
        reason: 'A lock that is only locked by hand is a lock that is sometimes not locked.',
        triggers: [{ kind: 'time', at: '23:00', days: [] }],
        conditions: [{ kind: 'device_state', deviceId: device.id, attribute: 'locked', operator: 'eq', value: false }],
        actions: [
          { kind: 'device_command', deviceId: device.id, selector: null, command: 'lock', args: {} },
          { kind: 'notify', message: `${device.name} was locked for the night.`, channel: 'web', priority: 'low' },
        ],
      })
    }

    if (capabilities.has('waterLeak')) {
      const valves = deviceRepository.all({ capability: 'valve' })
      propose({
        name: `Water leak: ${device.name}`,
        description: valves.length > 0 ? 'Closes the water valve and raises a critical alert.' : 'Raises a critical alert the moment water is detected.',
        reason: 'A leak detector with no routine behind it is a sensor that beeps into an empty flat.',
        triggers: [{ kind: 'device_state', deviceId: device.id, attribute: 'leak', operator: 'changed_to', value: true, forSeconds: 0 }],
        actions: [
          ...(valves.length > 0 && valves[0] ? [{ kind: 'device_command' as const, deviceId: valves[0].id, selector: null, command: 'closeValve', args: {} }] : []),
          { kind: 'notify', message: `Water detected by ${device.name}.`, title: 'Leak', channel: 'all', priority: 'critical' },
          { kind: 'speak', text: `Attention, fuite d'eau détectée par ${device.name}.`, deviceId: null },
        ],
      })
    }

    if (capabilities.has('power') && device.category === 'outlet') {
      propose({
        name: `${device.name}: tell me when it is finished`,
        description: 'Watches the power draw and says when the appliance has stopped.',
        reason: 'A plug with energy metering can tell you the washing is done without any extra hardware.',
        triggers: [{ kind: 'device_state', deviceId: device.id, attribute: 'power', operator: 'lt', value: 5, forSeconds: 300 }],
        conditions: [],
        actions: [{ kind: 'notify', message: `${device.name} has finished.`, channel: 'all', priority: 'normal' }],
      })
    }

    return created
  }

  /**
   * Habits in the event log: the same manual command at roughly the same time on several
   * days is a routine waiting to be written.
   */
  findHabits(minOccurrences = 4): { deviceId: string; deviceName: string; command: string; hour: number; occurrences: number }[] {
    const rows = database().all<{ subject_id: string; command: string; hour: number; occurrences: number }>(
      `SELECT subject_id,
              json_extract(payload, '$.command') AS command,
              CAST(strftime('%H', at) AS INTEGER) AS hour,
              COUNT(*) AS occurrences
       FROM events
       WHERE type = 'device.command_sent' AND origin = 'user' AND at > datetime('now', '-21 days')
       GROUP BY subject_id, command, hour
       HAVING occurrences >= ?
       ORDER BY occurrences DESC
       LIMIT 20`,
      [minOccurrences]
    )

    return rows
      .map((row) => {
        const device = deviceRepository.find(row.subject_id)
        return device ? { deviceId: device.id, deviceName: device.name, command: String(row.command), hour: Number(row.hour), occurrences: Number(row.occurrences) } : null
      })
      .filter((habit): habit is NonNullable<typeof habit> => habit !== null)
  }

  /** Turn a detected habit into a suggested routine. */
  suggestFromHabits(): Routine[] {
    const created: Routine[] = []
    const existing = routines.all().map((routine) => routine.name)

    for (const habit of this.findHabits()) {
      const name = `${habit.deviceName} at ${String(habit.hour).padStart(2, '0')}:00`
      if (existing.includes(name)) continue

      const routine = routines.create({
        name,
        description: `You have run this by hand ${habit.occurrences} times in the last three weeks, always around ${habit.hour}:00.`,
        enabled: true,
        mode: 'single',
        triggers: [{ kind: 'time', at: `${String(habit.hour).padStart(2, '0')}:00`, days: [] }],
        conditions: [],
        actions: [{ kind: 'device_command', deviceId: habit.deviceId, selector: null, command: habit.command, args: {} }],
        authoredBy: 'agent',
        status: 'suggested',
        suggestionReason: `Observed ${habit.occurrences} times in 21 days.`,
        areaId: deviceRepository.find(habit.deviceId)?.areaId ?? null,
      })
      created.push(routine)
      bus.publish('automation.suggested', {
        subjectType: 'automation',
        subjectId: routine.id,
        origin: 'agent',
        payload: { name: routine.name, reason: routine.suggestionReason, occurrences: habit.occurrences },
      })
    }

    return created
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
