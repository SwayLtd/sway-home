/**
 * The house service: the one way anything gets changed.
 *
 * Every command - from the UI, from a routine, from the agent, from the API - goes through
 * `execute`. That is what makes the timeline complete, the undo stack real, and the agent
 * able to answer "who turned that off" with something other than a guess.
 */

import { randomUUID } from 'node:crypto'
import {
  commandRisk,
  type CommandResult,
  type Device,
  type DeviceCategory,
  type CapabilityId,
  type HouseMode,
} from '@sway-home/shared'
import { adapters } from '#services/adapter_manager'
import { bus } from '#services/event_bus'
import { deviceRepository } from '#repositories/device_repository'
import { alerts, house, places, scenes, undo } from '#repositories/store'

export interface ExecuteOptions {
  origin?: 'user' | 'automation' | 'agent' | 'device' | 'schedule' | 'api'
  originDetail?: string
  correlationId?: string
  endpointIndex?: number
  /** Skip the undo entry, for commands issued *by* an undo. */
  noUndo?: boolean
}

export interface Selector {
  deviceIds?: string[]
  areaId?: string | null
  areaName?: string
  capability?: CapabilityId
  category?: DeviceCategory
  all?: boolean
}

export { isOutdoorArea } from '@sway-home/shared'

export const houseService = {
  async execute(deviceId: string, command: string, args: Record<string, unknown> = {}, options: ExecuteOptions = {}): Promise<CommandResult> {
    const device = deviceRepository.find(deviceId)
    if (!device) return { ok: false, deviceId, command, error: 'Unknown device' }

    const correlationId = options.correlationId ?? randomUUID()
    const started = performance.now()

    const result = await adapters.execute(device.adapterId, device.nativeId, command, args, options.endpointIndex)
    const latencyMs = Math.round(performance.now() - started)

    if (result.ok) {
      if (result.state) {
        const endpointId = options.endpointIndex === undefined ? null : device.endpoints.find((e) => e.index === options.endpointIndex)?.id ?? null
        const { previous, changed } = deviceRepository.mergeState(device.id, result.state, endpointId)
        if (changed.length > 0) {
          bus.publish('device.state_changed', {
            subjectType: 'device',
            subjectId: device.id,
            origin: options.origin ?? 'user',
            originDetail: options.originDetail ?? null,
            correlationId,
            payload: { deviceId: device.id, endpointId, changes: result.state, previous, changed },
          })
        }
      }

      bus.publish('device.command_sent', {
        subjectType: 'device',
        subjectId: device.id,
        origin: options.origin ?? 'user',
        originDetail: options.originDetail ?? null,
        correlationId,
        payload: { command, args, deviceName: device.name, latencyMs, risk: commandRisk(command, device.critical) },
      })

      if (!options.noUndo && result.undo) {
        undo.push({
          description: `${device.name}: ${command}`,
          origin: options.origin ?? 'user',
          commands: [{ deviceId: device.id, command: result.undo.command, args: result.undo.args }],
          correlationId,
        })
      }
    } else {
      bus.publish('device.command_failed', {
        subjectType: 'device',
        subjectId: device.id,
        origin: options.origin ?? 'user',
        correlationId,
        severity: 'warning',
        payload: { command, args, deviceName: device.name, error: result.error },
      })
      alerts.raise({
        kind: 'command_failed',
        severity: 'warning',
        title: `${device.name} n'a pas répondu`,
        detail: result.error ?? null,
        subjectId: device.id,
      })
    }

    return { ...result, latencyMs }
  },

  /** Fan a command out over a selector. Returns one result per device. */
  async executeMany(selector: Selector, command: string, args: Record<string, unknown> = {}, options: ExecuteOptions = {}): Promise<CommandResult[]> {
    const targets = houseService.resolve(selector)
    const correlationId = options.correlationId ?? randomUUID()
    const results = await Promise.all(
      targets.map((device) => houseService.execute(device.id, command, args, { ...options, correlationId, noUndo: true }))
    )

    // One undo entry for the whole batch: undoing "turn off the living room" should turn
    // the living room back on, not require six separate undos.
    const undoCommands = results
      .map((result, index) => ({ result, device: targets[index] }))
      .filter((pair): pair is { result: CommandResult; device: Device } => pair.result.ok && pair.result.undo != null && pair.device != null)
      .map((pair) => ({ deviceId: pair.device.id, command: pair.result.undo!.command, args: pair.result.undo!.args }))

    if (!options.noUndo && undoCommands.length > 0) {
      undo.push({
        description: describeSelector(selector, command, targets.length),
        origin: options.origin ?? 'user',
        commands: undoCommands,
        correlationId,
      })
    }

    return results
  },

  resolve(selector: Selector): Device[] {
    if (selector.deviceIds?.length) {
      return selector.deviceIds.map((id) => deviceRepository.find(id)).filter((d): d is Device => d !== null)
    }

    // "Everything" has to be asked for explicitly. Without this, a selector whose only field
    // was mistyped - or an agent tool call that lost its argument on the way - falls through
    // to every device in the house, and "éteins la véranda" turns the whole flat off. The
    // `all` flag exists precisely so that the dangerous case is the one you have to name.
    const narrowed =
      selector.areaId !== undefined ||
      selector.areaName !== undefined ||
      selector.capability !== undefined ||
      selector.category !== undefined
    if (!narrowed && selector.all !== true) return []

    let areaId = selector.areaId
    if (areaId === undefined && selector.areaName) {
      const area = places.areas().find((a) => normalise(a.name) === normalise(selector.areaName!))
      areaId = area?.id ?? undefined
      if (!area) return []
    }

    return deviceRepository.all({
      areaId: areaId === undefined ? undefined : areaId,
      capability: selector.capability,
      category: selector.category,
      limit: 200,
    })
  },

  async applyScene(sceneId: string, options: ExecuteOptions = {}): Promise<CommandResult[]> {
    const scene = scenes.find(sceneId)
    if (!scene) return []
    const correlationId = options.correlationId ?? randomUUID()

    const results: CommandResult[] = []
    const undoCommands: { deviceId: string; command: string; args: Record<string, unknown> }[] = []

    for (const entry of scene.entries) {
      const device = deviceRepository.find(entry.deviceId)
      if (!device) continue

      for (const command of stateToCommands(entry.state, entry.transitionMs)) {
        const result = await houseService.execute(device.id, command.command, command.args, {
          ...options,
          origin: options.origin ?? 'user',
          originDetail: `scene:${scene.name}`,
          correlationId,
          noUndo: true,
        })
        results.push(result)
        if (result.ok && result.undo) undoCommands.push({ deviceId: device.id, command: result.undo.command, args: result.undo.args })
      }
    }

    if (undoCommands.length > 0) {
      undo.push({ description: `Scene: ${scene.name}`, origin: options.origin ?? 'user', commands: undoCommands, correlationId })
    }

    bus.publish('scene.activated', {
      subjectType: 'scene',
      subjectId: scene.id,
      origin: options.origin ?? 'user',
      correlationId,
      payload: { name: scene.name, devices: scene.entries.length },
    })

    return results
  },

  /** Capture what every device in a selector is doing right now, as a scene. */
  snapshotScene(name: string, selector: Selector, areaId: string | null = null): string {
    const devices = houseService.resolve(selector)
    const entries = devices
      .filter((device) => device.capabilities.some((capability) => SNAPSHOT_CAPABILITIES.includes(capability)))
      .map((device) => ({
        deviceId: device.id,
        endpointId: null,
        state: pickSnapshotState(device.state),
        transitionMs: 400,
      }))
    return scenes.create({ name, areaId, entries, authoredBy: 'snapshot' }).id
  },

  async undoLast(): Promise<{ ok: boolean; description: string | null }> {
    const [entry] = undo.stack(1)
    if (!entry) return { ok: false, description: null }
    return houseService.undo(entry.id)
  },

  /** Undo one entry by id: the "Annuler" under something the assistant did on its own. */
  async undo(id: string): Promise<{ ok: boolean; description: string | null }> {
    const entry = undo.find(id)
    if (!entry) return { ok: false, description: null }
    const correlationId = randomUUID()
    for (const command of entry.commands) {
      await houseService.execute(command.deviceId, command.command, command.args, {
        origin: 'user',
        originDetail: 'undo',
        correlationId,
        noUndo: true,
      })
    }
    undo.markApplied(entry.id)
    return { ok: true, description: entry.description }
  },

  setMode(mode: HouseMode, origin: ExecuteOptions['origin'] = 'user'): void {
    const previous = house.mode()
    if (previous === mode) return
    house.setMode(mode)
    bus.publish('house.mode_changed', {
      subjectType: 'system',
      origin: origin ?? 'user',
      payload: { mode, previous },
    })
  },

  /**
   * One object with everything the agent and the dashboard need. Built in one pass so a
   * "what is going on" question is a single query rather than fifteen.
   */
  snapshot(): {
    mode: HouseMode
    devices: Device[]
    areas: ReturnType<typeof places.areas>
    counts: ReturnType<typeof deviceRepository.counts>
    openAlerts: ReturnType<typeof alerts.open>
    power: { total: number; byArea: Record<string, number> }
    climate: { area: string; temperature: number | null; humidity: number | null }[]
    security: { locksUnlocked: string[]; openContacts: string[]; leaks: string[]; smoke: string[] }
    lightsOn: string[]
    mediaPlaying: string[]
    batteriesLow: { name: string; battery: number }[]
    offline: string[]
  } {
    const devices = deviceRepository.all({ limit: 1000 })
    const areaById = new Map(places.areas().map((area) => [area.id, area]))

    let totalPower = 0
    const byArea: Record<string, number> = {}
    const climateByArea = new Map<string, { temperature: number | null; humidity: number | null }>()
    const locksUnlocked: string[] = []
    const openContacts: string[] = []
    const leaks: string[] = []
    const smoke: string[] = []
    const lightsOn: string[] = []
    const mediaPlaying: string[] = []
    const batteriesLow: { name: string; battery: number }[] = []
    const offline: string[] = []

    for (const device of devices) {
      const areaName = device.areaId ? areaById.get(device.areaId)?.name ?? 'Sans pièce' : 'Sans pièce'
      const state = device.state

      if (typeof state.power === 'number') {
        totalPower += state.power
        byArea[areaName] = Number(((byArea[areaName] ?? 0) + state.power).toFixed(1))
      }
      if (typeof state.temperature === 'number' || typeof state.humidity === 'number') {
        const current = climateByArea.get(areaName) ?? { temperature: null, humidity: null }
        if (typeof state.temperature === 'number') current.temperature = state.temperature
        if (typeof state.humidity === 'number') current.humidity = state.humidity
        climateByArea.set(areaName, current)
      }
      if (state.locked === false) locksUnlocked.push(device.name)
      if (state.open === true) openContacts.push(device.name)
      if (state.leak === true) leaks.push(device.name)
      if (state.smoke === true) smoke.push(device.name)
      if (device.category === 'light' && state.on === true) lightsOn.push(device.name)
      if (state.playback === 'playing') mediaPlaying.push(device.name)
      if (typeof state.battery === 'number' && state.battery <= 20) batteriesLow.push({ name: device.name, battery: state.battery })
      if (!device.online) offline.push(device.name)
    }

    return {
      mode: house.mode(),
      devices,
      areas: places.areas(),
      counts: deviceRepository.counts(),
      openAlerts: alerts.open(),
      power: { total: Number(totalPower.toFixed(1)), byArea },
      climate: [...climateByArea.entries()].map(([area, values]) => ({ area, ...values })),
      security: { locksUnlocked, openContacts, leaks, smoke },
      lightsOn,
      mediaPlaying,
      batteriesLow,
      offline,
    }
  },
}

const SNAPSHOT_CAPABILITIES: CapabilityId[] = ['onoff', 'brightness', 'colorTemperature', 'color', 'position', 'thermostat', 'volume', 'fan']
const SNAPSHOT_KEYS = ['on', 'brightness', 'colorTemperature', 'hue', 'saturation', 'position', 'tilt', 'targetTemperature', 'hvacMode', 'volume', 'fanSpeed', 'effect']

function pickSnapshotState(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of SNAPSHOT_KEYS) {
    if (state[key] !== undefined && state[key] !== null) out[key] = state[key]
  }
  return out
}

/** A scene stores target state; applying it means turning that state back into commands. */
export function stateToCommands(state: Record<string, unknown>, transitionMs = 400): { command: string; args: Record<string, unknown> }[] {
  const commands: { command: string; args: Record<string, unknown> }[] = []

  if (state.on === false) {
    // Off wins: setting brightness on a light that should be off turns it back on.
    return [{ command: 'turnOff', args: { transitionMs } }]
  }
  if (state.on === true) commands.push({ command: 'turnOn', args: { transitionMs } })
  if (typeof state.brightness === 'number') commands.push({ command: 'setBrightness', args: { brightness: state.brightness, transitionMs } })
  if (typeof state.hue === 'number' && typeof state.saturation === 'number' && state.saturation > 0) {
    commands.push({ command: 'setColor', args: { hue: state.hue, saturation: state.saturation, transitionMs } })
  } else if (typeof state.colorTemperature === 'number') {
    commands.push({ command: 'setColorTemperature', args: { kelvin: state.colorTemperature, transitionMs } })
  }
  if (typeof state.effect === 'string') commands.push({ command: 'setEffect', args: { effect: state.effect } })
  if (typeof state.position === 'number') commands.push({ command: 'setPosition', args: { position: state.position } })
  if (typeof state.tilt === 'number') commands.push({ command: 'setTilt', args: { tilt: state.tilt } })
  if (typeof state.targetTemperature === 'number') commands.push({ command: 'setTargetTemperature', args: { celsius: state.targetTemperature } })
  if (typeof state.hvacMode === 'string') commands.push({ command: 'setHvacMode', args: { mode: state.hvacMode } })
  if (typeof state.volume === 'number') commands.push({ command: 'setVolume', args: { volume: state.volume } })
  if (typeof state.fanSpeed === 'number') commands.push({ command: 'setFanSpeed', args: { speed: state.fanSpeed } })

  return commands
}

function describeSelector(selector: Selector, command: string, count: number): string {
  if (selector.areaName) return `${selector.areaName}: ${command} (${count})`
  if (selector.capability) return `${selector.capability}: ${command} (${count})`
  if (selector.category) return `${selector.category}: ${command} (${count})`
  return `${command} on ${count} devices`
}

function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}
