/**
 * A controllable adapter for the tests.
 *
 * It holds state in a Map and records every command it was asked to run, which is what most
 * hub tests actually need to assert: not "did the light change" but "did exactly one
 * turnOff reach the adapter, with these arguments, in this order". It can also be told to
 * fail or to hang, because the interesting paths in the hub are the ones where a device does
 * not answer.
 */

import type { AdapterContext, AdapterDescriptor, AdapterStatus, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'

export interface RecordedCommand {
  nativeId: string
  command: string
  args: Record<string, unknown>
  at: number
}

export class FakeAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'test',
    name: 'Test adapter',
    vendor: 'Sway',
    transports: ['virtual'],
    capabilities: ['onoff', 'brightness', 'colorTemperature', 'thermostat', 'lock', 'motion', 'waterLeak', 'power', 'energy', 'battery', 'temperature', 'humidity'],
    zeroConfig: true,
    cloud: false,
    implemented: true,
  }

  readonly commands: RecordedCommand[] = []
  context: AdapterContext | null = null

  /** Command names that must fail, and the message they fail with. */
  failures = new Map<string, string>()
  /** Commands that never resolve, for timeout paths. */
  hangs = new Set<string>()
  /** Devices the house asked the adapter to let go of. */
  readonly forgotten: string[] = []

  #state = new Map<string, Record<string, unknown>>()
  #discoverable: DiscoveredDevice[] = []

  async init(context: AdapterContext): Promise<void> {
    this.context = context
  }

  async discover(_hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    return this.#discoverable
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    return { ...(this.#state.get(nativeId) ?? {}) }
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    this.commands.push({ nativeId, command, args, at: Date.now() })

    if (this.hangs.has(command)) await new Promise(() => {})

    const failure = this.failures.get(command)
    if (failure) return { ok: false, deviceId: nativeId, command, error: failure }

    const before = { ...(this.#state.get(nativeId) ?? {}) }
    const state = this.#apply(nativeId, command, args)
    return { ok: true, deviceId: nativeId, command, state, undo: undoFor(command, before) }
  }

  async forget(nativeId: string): Promise<{ ok: boolean; message?: string }> {
    this.forgotten.push(nativeId)
    this.#state.delete(nativeId)
    this.#discoverable = this.#discoverable.filter((device) => device.nativeId !== nativeId)
    return { ok: true }
  }

  status(): AdapterStatus {
    return { health: 'ok', deviceCount: this.#state.size }
  }

  async shutdown(): Promise<void> {
    this.context = null
  }

  // --- test controls -------------------------------------------------------------------

  setState(nativeId: string, state: Record<string, unknown>): void {
    this.#state.set(nativeId, { ...(this.#state.get(nativeId) ?? {}), ...state })
  }

  stateOf(nativeId: string): Record<string, unknown> {
    return { ...(this.#state.get(nativeId) ?? {}) }
  }

  offerDevices(devices: DiscoveredDevice[]): void {
    this.#discoverable = devices
  }

  /** Pushes a state change the way a real adapter does when a device reports on its own. */
  push(nativeId: string, state: Record<string, unknown>): void {
    this.setState(nativeId, state)
    this.context?.emitState(nativeId, state)
  }

  pushEvent(nativeId: string, event: string, payload: Record<string, unknown> = {}): void {
    this.context?.emitEvent(nativeId, event, payload)
  }

  reset(): void {
    this.commands.length = 0
    this.failures.clear()
    this.hangs.clear()
    this.forgotten.length = 0
    this.#state.clear()
    this.#discoverable = []
  }

  commandsFor(nativeId: string): RecordedCommand[] {
    return this.commands.filter((entry) => entry.nativeId === nativeId)
  }

  #apply(nativeId: string, command: string, args: Record<string, unknown>): Record<string, unknown> {
    const current = { ...(this.#state.get(nativeId) ?? {}) }
    switch (command) {
      case 'turnOn':
        current.on = true
        break
      case 'turnOff':
        current.on = false
        break
      case 'toggle':
        current.on = !current.on
        break
      case 'setBrightness':
        current.brightness = args.brightness
        current.on = true
        break
      case 'setColorTemperature':
        current.colorTemperature = args.colorTemperature
        break
      case 'setTargetTemperature':
        current.targetTemperature = args.targetTemperature
        break
      case 'setHvacMode':
        current.hvacMode = args.mode
        break
      case 'lock':
        current.locked = true
        break
      case 'unlock':
        current.locked = false
        break
      case 'open':
        current.position = 100
        break
      case 'close':
        current.position = 0
        break
      case 'setPosition':
        current.position = args.position
        break
      default:
        break
    }
    this.#state.set(nativeId, current)
    return current
  }
}

/** The undo an adapter returns alongside a command, mirroring what the real ones do. */
function undoFor(command: string, before: Record<string, unknown>): CommandResult['undo'] {
  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'toggle':
      return { command: before.on === true ? 'turnOn' : 'turnOff', args: {} }
    case 'setBrightness':
      return typeof before.brightness === 'number' ? { command: 'setBrightness', args: { brightness: before.brightness } } : null
    case 'lock':
    case 'unlock':
      return { command: before.locked === true ? 'lock' : 'unlock', args: {} }
    case 'setTargetTemperature':
      return typeof before.targetTemperature === 'number'
        ? { command: 'setTargetTemperature', args: { targetTemperature: before.targetTemperature } }
        : null
    default:
      return null
  }
}
