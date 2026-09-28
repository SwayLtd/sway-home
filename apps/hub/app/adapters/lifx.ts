/**
 * LIFX, over the LAN protocol.
 *
 * No cloud, no bridge, no token: every LIFX bulb answers UDP on port 56700. Discovery is a
 * broadcast `GetService`, plus a direct probe of any scanned host whose MAC carries LIFX's
 * OUI (d0:73:d5), because plenty of home routers and mesh systems drop broadcast between
 * access points. State is `GetColor`; changes are `SetColor` and `SetLightPower`, each sent
 * with ack_required and retried on silence - UDP loses packets, and a light that ignores
 * "turn off" one time in fifty is a light people stop trusting.
 *
 * The wire format lives in `lifx_codec.ts`; this file is only the conversation.
 * Spec: https://lan.developer.lifx.com/
 */

import { createSocket } from 'node:dgram'
import type { AdapterDescriptor, CapabilityId, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { PollingAdapter } from '#adapters/base'
import {
  LIFX_PORT,
  LIFX_TYPE,
  decodeLifx,
  encodeLifx,
  fromHsbk,
  parseLightState,
  setColorPayload,
  setLightPowerPayload,
  targetFromMac,
  toHsbk,
  type DecodedLifx,
  type Hsbk,
  type LightState,
} from '#adapters/lifx_codec'

/** The socket, abstracted so tests can put simulated bulbs on the other end. */
export interface LifxTransport {
  send(bytes: Uint8Array, ip: string, port: number): void
  broadcast(bytes: Uint8Array): void
  onMessage(handler: (bytes: Uint8Array, ip: string) => void): void
  close(): void
}

export interface LifxOptions {
  transport?: LifxTransport
  /** How long to wait for one answer before retrying. */
  timeoutMs?: number
  retries?: number
  /** How long a discovery broadcast collects answers. */
  discoveryMs?: number
}

const LIFX_OUI = 'd0:73:d5'
const LIFX_CAPABILITIES: CapabilityId[] = ['onoff', 'brightness', 'color', 'colorTemperature', 'connectivity']

export class LifxAdapter extends PollingAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'lifx',
    name: 'LIFX',
    vendor: 'LIFX',
    transports: ['wifi'],
    capabilities: LIFX_CAPABILITIES,
    zeroConfig: true,
    cloud: false,
    implemented: true,
    docsUrl: 'https://lan.developer.lifx.com/',
    configSchema: [{ key: 'pollIntervalMs', label: 'Poll interval (ms)', type: 'number', default: 10000 }],
  }

  readonly #options: Required<Omit<LifxOptions, 'transport'>>
  #transport: LifxTransport | null
  /** Replies are matched on (source, sequence); the source is ours for this process. */
  readonly #source = 2 + Math.floor(Math.random() * 0xfffffff0)
  #sequence = 0
  #pending = new Map<number, { expect: number[]; resolve: (packet: DecodedLifx | null) => void; timer: ReturnType<typeof setTimeout> }>()
  #collector: Map<string, string> | null = null

  constructor(options: LifxOptions = {}) {
    super()
    this.#transport = options.transport ?? null
    this.#options = {
      timeoutMs: options.timeoutMs ?? 700,
      retries: options.retries ?? 2,
      discoveryMs: options.discoveryMs ?? 1500,
    }
  }

  protected override async onInit(): Promise<void> {
    this.#transport ??= udpTransport(this.context?.network.cidr ?? null)
    this.#transport.onMessage((bytes, ip) => this.#receive(bytes, ip))
  }

  override async shutdown(): Promise<void> {
    for (const waiter of this.#pending.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve(null)
    }
    this.#pending.clear()
    this.#transport?.close()
    await super.shutdown()
  }

  // -------------------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------------------

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    if (!this.#transport) return []
    const answered = new Map<string, string>()
    this.#collector = answered

    const probe = () => encodeLifx({ type: LIFX_TYPE.GetService, source: this.#source, sequence: this.#next(), tagged: true })
    this.#transport.broadcast(probe())
    for (const host of hosts) {
      if (host.mac?.toLowerCase().startsWith(LIFX_OUI)) this.#transport.send(probe(), host.ip, LIFX_PORT)
    }

    await sleep(this.#options.discoveryMs)
    this.#collector = null

    const found: DiscoveredDevice[] = []
    for (const [mac, ip] of answered) {
      const reply = await this.#request(ip, mac, LIFX_TYPE.GetColor, undefined, [LIFX_TYPE.LightState], false)
      if (!reply) continue
      const light = parseLightState(reply.payload)
      this.devices.set(mac, { ip, meta: { label: light.label } })
      found.push({
        adapterId: 'lifx',
        nativeId: mac,
        uid: `lifx:${mac.replace(/:/g, '')}`,
        name: light.label || `LIFX ${mac.slice(-5)}`,
        category: 'light',
        capabilities: LIFX_CAPABILITIES,
        transport: 'wifi',
        manufacturer: 'LIFX',
        model: 'LIFX',
        serialNumber: mac,
        confidence: 0.97,
        network: { ip, mac, hostname: null },
        meta: {},
      } as DiscoveredDevice)
    }
    return found
  }

  // -------------------------------------------------------------------------------------
  // State and commands
  // -------------------------------------------------------------------------------------

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const light = await this.#read(nativeId)
    if (!light) throw new Error('La lampe LIFX ne répond pas.')
    return stateOf(light.hsbk, light.on)
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const bulb = this.devices.get(nativeId)
    if (!bulb) return this.fail(nativeId, command, `Lampe LIFX inconnue : ${nativeId}`)
    if (!SUPPORTED.has(command)) return this.fail(nativeId, command, `LIFX ne gère pas la commande ${command}.`)

    const before = await this.#read(nativeId)
    if (!before) return this.fail(nativeId, command, 'La lampe LIFX ne répond pas.')

    const transitionMs = Number(args.transitionMs ?? 400)
    let colour: Hsbk = { ...before.hsbk }
    let power: boolean | null = null

    switch (command) {
      case 'turnOn':
        power = true
        break
      case 'turnOff':
        power = false
        break
      case 'toggle':
        power = !before.on
        break
      case 'setBrightness':
      case 'stepBrightness': {
        const current = fromHsbk(before.hsbk).brightness
        const wanted = command === 'setBrightness' ? Number(args.brightness ?? current) : current + Number(args.delta ?? 0)
        colour = { ...colour, brightness: toHsbk({ hue: 0, saturation: 0, brightness: wanted, kelvin: 3500 }).brightness }
        if (wanted > 0 && !before.on) power = true
        if (wanted <= 0) power = false
        break
      }
      case 'setColor': {
        const wire = toHsbk({ hue: Number(args.hue ?? 0), saturation: Number(args.saturation ?? 100), brightness: 0, kelvin: 3500 })
        colour = { ...colour, hue: wire.hue, saturation: wire.saturation }
        if (!before.on) power = true
        break
      }
      case 'setColorTemperature': {
        const wire = toHsbk({ hue: 0, saturation: 0, brightness: 0, kelvin: Number(args.kelvin ?? 3500) })
        colour = { ...colour, saturation: 0, kelvin: wire.kelvin }
        if (!before.on) power = true
        break
      }
    }

    const colourChanged = colour.hue !== before.hsbk.hue || colour.saturation !== before.hsbk.saturation || colour.brightness !== before.hsbk.brightness || colour.kelvin !== before.hsbk.kelvin
    if (colourChanged) {
      const ack = await this.#request(bulb.ip, nativeId, LIFX_TYPE.SetColor, setColorPayload(colour, transitionMs), [LIFX_TYPE.Acknowledgement], true)
      if (!ack) return this.fail(nativeId, command, 'La lampe LIFX ne répond pas.')
    }
    if (power !== null && power !== before.on) {
      const ack = await this.#request(bulb.ip, nativeId, LIFX_TYPE.SetLightPower, setLightPowerPayload(power, transitionMs), [LIFX_TYPE.Acknowledgement], true)
      if (!ack) return this.fail(nativeId, command, 'La lampe LIFX ne répond pas.')
    }

    this.lastError = null
    const after = stateOf(colour, power ?? before.on)
    return this.ok(nativeId, command, after, undoFrom(command, stateOf(before.hsbk, before.on)))
  }

  // -------------------------------------------------------------------------------------
  // The conversation
  // -------------------------------------------------------------------------------------

  async #read(mac: string): Promise<LightState | null> {
    const bulb = this.devices.get(mac)
    if (!bulb) return null
    const reply = await this.#request(bulb.ip, mac, LIFX_TYPE.GetColor, undefined, [LIFX_TYPE.LightState], false)
    return reply ? parseLightState(reply.payload) : null
  }

  #next(): number {
    this.#sequence = (this.#sequence + 1) % 256
    return this.#sequence
  }

  /** One request, retried on silence. Null when the bulb never answers. */
  async #request(ip: string, mac: string, type: number, payload: Uint8Array | undefined, expect: number[], ackRequired: boolean): Promise<DecodedLifx | null> {
    const transport = this.#transport
    if (!transport) return null

    for (let attempt = 0; attempt <= this.#options.retries; attempt += 1) {
      const sequence = this.#next()
      const packet = encodeLifx({ type, source: this.#source, sequence, target: targetFromMac(mac), ackRequired, payload })
      const reply = await new Promise<DecodedLifx | null>((resolve) => {
        const timer = setTimeout(() => {
          this.#pending.delete(sequence)
          resolve(null)
        }, this.#options.timeoutMs)
        this.#pending.set(sequence, { expect, resolve, timer })
        transport.send(packet, ip, LIFX_PORT)
      })
      if (reply) return reply
    }
    return null
  }

  #receive(bytes: Uint8Array, ip: string): void {
    const packet = decodeLifx(bytes)
    if (!packet || packet.source !== this.#source) return

    if (packet.type === LIFX_TYPE.StateService && this.#collector) {
      this.#collector.set(packet.mac, ip)
      return
    }

    const waiter = this.#pending.get(packet.sequence)
    if (!waiter || !waiter.expect.includes(packet.type)) return
    this.#pending.delete(packet.sequence)
    clearTimeout(waiter.timer)
    waiter.resolve(packet)
  }
}

const SUPPORTED = new Set(['turnOn', 'turnOff', 'toggle', 'setBrightness', 'stepBrightness', 'setColor', 'setColorTemperature'])

/** The wire's colour, said the way every other light in the house says it. */
function stateOf(colour: Hsbk, on: boolean): Record<string, unknown> {
  const human = fromHsbk(colour)
  const state: Record<string, unknown> = { on, brightness: human.brightness }
  // A LIFX bulb has one colour at a time: saturated means colour, unsaturated means white.
  if (colour.saturation > 0) {
    state.hue = human.hue
    state.saturation = human.saturation
  } else {
    state.colorTemperature = human.kelvin
  }
  return state
}

function undoFrom(command: string, before: Record<string, unknown>): { command: string; args: Record<string, unknown> } | null {
  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'toggle':
      return { command: before.on === true ? 'turnOn' : 'turnOff', args: {} }
    case 'setBrightness':
    case 'stepBrightness':
      return { command: 'setBrightness', args: { brightness: Number(before.brightness ?? 100) } }
    case 'setColor':
    case 'setColorTemperature':
      return typeof before.hue === 'number'
        ? { command: 'setColor', args: { hue: before.hue, saturation: before.saturation } }
        : { command: 'setColorTemperature', args: { kelvin: before.colorTemperature ?? 3500 } }
    default:
      return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The real socket. Broadcast goes to the subnet's directed broadcast address when the hub
 * knows it: on Windows, 255.255.255.255 leaves by the default interface only, which is not
 * always the one the bulbs are on.
 */
export function udpTransport(cidr: string | null): LifxTransport {
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  let handler: ((bytes: Uint8Array, ip: string) => void) | null = null
  socket.on('message', (message, remote) => handler?.(new Uint8Array(message.buffer, message.byteOffset, message.byteLength), remote.address))
  // A UDP error (a host unreachable, a closed port) is not fatal to the adapter.
  socket.on('error', () => undefined)

  const ready = new Promise<void>((resolve) => {
    socket.bind(0, () => {
      socket.setBroadcast(true)
      resolve()
    })
  })
  const broadcastTo = cidr ? directedBroadcast(cidr) : '255.255.255.255'

  return {
    send: (bytes, ip, port) => void ready.then(() => socket.send(bytes, port, ip)),
    broadcast: (bytes) => void ready.then(() => socket.send(bytes, LIFX_PORT, broadcastTo)),
    onMessage: (next) => {
      handler = next
    },
    close: () => {
      try {
        socket.close()
      } catch {
        /* already closed */
      }
    },
  }
}

/** 192.168.1.0/24 -> 192.168.1.255. */
export function directedBroadcast(cidr: string): string {
  const [address, bitsText] = cidr.split('/')
  const bits = Number(bitsText)
  const parts = (address ?? '').split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) || !Number.isInteger(bits) || bits < 0 || bits > 32) return '255.255.255.255'
  const value = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
  const host = bits === 32 ? 0 : (0xffffffff >>> bits) >>> 0
  const broadcast = (value | host) >>> 0
  return [broadcast >>> 24, (broadcast >>> 16) & 255, (broadcast >>> 8) & 255, broadcast & 255].join('.')
}
