/**
 * TP-Link Kasa (and older Tapo) over LAN.
 *
 * TP-Link's local protocol is JSON over TCP 9999, obfuscated with an autokey XOR stream
 * seeded with 171. It is not encryption - the key is a constant published in every
 * open-source client - but it does mean the payload has to be wrapped, which is why this
 * adapter is fifty lines longer than the HTTP ones.
 *
 * Written by hand rather than pulled from a package: the cipher is eight lines, the command
 * set is four JSON objects, and the alternative was a dependency tree for a bit flip.
 */

import net from 'node:net'
import type { AdapterDescriptor, CapabilityId, CommandResult, DeviceCategory, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { PollingAdapter, mapLimit } from '#adapters/base'

const KASA_PORT = 9999
const INITIAL_KEY = 171

/** Autokey XOR: each byte is XORed with the previous ciphertext byte. */
function encrypt(payload: string): Buffer {
  const bytes = Buffer.from(payload, 'utf8')
  const out = Buffer.alloc(bytes.length + 4)
  out.writeUInt32BE(bytes.length, 0)
  let key = INITIAL_KEY
  for (let i = 0; i < bytes.length; i += 1) {
    key = (bytes[i] ?? 0) ^ key
    out[i + 4] = key
  }
  return out
}

function decrypt(buffer: Buffer): string {
  const body = buffer.subarray(4)
  const out = Buffer.alloc(body.length)
  let key = INITIAL_KEY
  for (let i = 0; i < body.length; i += 1) {
    const cipher = body[i] ?? 0
    out[i] = cipher ^ key
    key = cipher
  }
  return out.toString('utf8')
}

async function request(ip: string, payload: unknown, timeoutMs = 3000): Promise<Record<string, any> | null> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const chunks: Buffer[] = []
    let settled = false

    const finish = (value: Record<string, any> | null) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }

    socket.setTimeout(timeoutMs)
    socket.once('timeout', () => finish(null))
    socket.once('error', () => finish(null))
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      if (buffer.length < 4) return
      const expected = buffer.readUInt32BE(0)
      if (buffer.length < expected + 4) return
      try {
        finish(JSON.parse(decrypt(buffer)) as Record<string, any>)
      } catch {
        finish(null)
      }
    })
    socket.once('close', () => finish(null))

    try {
      socket.connect(KASA_PORT, ip, () => socket.write(encrypt(JSON.stringify(payload))))
    } catch {
      finish(null)
    }
  })
}

export class KasaAdapter extends PollingAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'kasa',
    name: 'TP-Link Kasa',
    vendor: 'TP-Link',
    transports: ['wifi'],
    capabilities: ['onoff', 'brightness', 'colorTemperature', 'color', 'power', 'energy', 'connectivity', 'firmware', 'identify'],
    zeroConfig: true,
    cloud: false,
    implemented: true,
    docsUrl: 'https://github.com/python-kasa/python-kasa',
    configSchema: [{ key: 'pollIntervalMs', label: 'Poll interval (ms)', type: 'number', default: 8000 }],
  }

  protected override pollIntervalMs = 8000

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    // Port 9999 is Kasa's and nothing else's on a home network, so the candidate list is
    // short and every hit is real.
    const candidates = hosts.filter((host) => host.openPorts.includes(KASA_PORT) || /tp-?link/i.test(host.macVendor ?? ''))

    const found = await mapLimit<NetworkHost, DiscoveredDevice | null>(candidates, 8, async (host) => {
      const response = await request(host.ip, { system: { get_sysinfo: {} } }, 2500)
      const info = response?.system?.get_sysinfo
      if (!info || (!info.deviceId && !info.mic_mac && !info.mac)) return null

      const mac = String(info.mac ?? info.mic_mac ?? '').toLowerCase().replace(/-/g, ':')
      const nativeId = host.ip
      this.devices.set(nativeId, { ip: host.ip, meta: { children: info.child_num ?? 0 } })

      const { category, capabilities } = classify(info)
      const children: { index: number; name: string; category: DeviceCategory; capabilities: CapabilityId[] }[] = Array.isArray(info.children)
        ? info.children.map((child: Record<string, unknown>, index: number) => ({
            index,
            name: String(child.alias ?? `Prise ${index + 1}`),
            category: 'outlet' as DeviceCategory,
            capabilities: ['onoff'] as CapabilityId[],
          }))
        : []

      return {
        adapterId: 'kasa',
        nativeId,
        uid: `kasa:${String(info.deviceId ?? mac).toLowerCase()}`,
        name: String(info.alias ?? info.dev_name ?? `Kasa ${host.ip}`),
        category,
        capabilities,
        transport: 'wifi',
        manufacturer: 'TP-Link',
        model: String(info.model ?? 'Kasa'),
        firmwareVersion: String(info.sw_ver ?? ''),
        serialNumber: String(info.deviceId ?? mac),
        confidence: 0.95,
        network: { ip: host.ip, mac, hostname: host.hostname },
        endpoints: children.length > 0 ? children : undefined,
        meta: { deviceId: info.deviceId, hasEmeter: (info.feature ?? '').includes('ENE') },
      }
    })

    return found.filter((device): device is DiscoveredDevice => device !== null)
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const response = await request(nativeId, { system: { get_sysinfo: {} } })
    const info = response?.system?.get_sysinfo
    if (!info) return {}

    const state: Record<string, unknown> = {}
    if (typeof info.relay_state === 'number') state.on = info.relay_state === 1
    const lightState = info.light_state
    if (lightState) {
      state.on = lightState.on_off === 1
      const source = lightState.on_off === 1 ? lightState : lightState.dft_on_state ?? {}
      if (typeof source.brightness === 'number') state.brightness = source.brightness
      if (typeof source.color_temp === 'number' && source.color_temp > 0) state.colorTemperature = source.color_temp
      if (typeof source.hue === 'number') state.hue = source.hue
      if (typeof source.saturation === 'number') state.saturation = source.saturation
    }
    if (typeof info.rssi === 'number') state.rssi = info.rssi
    if (typeof info.sw_ver === 'string') state.firmwareVersion = info.sw_ver

    // The energy monitoring models answer a second call; the others simply do not.
    const feature = String(info.feature ?? '')
    if (feature.includes('ENE')) {
      const meter = await request(nativeId, { emeter: { get_realtime: {} } })
      const realtime = meter?.emeter?.get_realtime
      if (realtime) {
        const watts = realtime.power_mw !== undefined ? realtime.power_mw / 1000 : realtime.power
        const volts = realtime.voltage_mv !== undefined ? realtime.voltage_mv / 1000 : realtime.voltage
        const amps = realtime.current_ma !== undefined ? realtime.current_ma / 1000 : realtime.current
        const total = realtime.total_wh !== undefined ? realtime.total_wh / 1000 : realtime.total
        if (typeof watts === 'number') state.power = Number(watts.toFixed(1))
        if (typeof volts === 'number') state.voltage = Number(volts.toFixed(1))
        if (typeof amps === 'number') state.current = Number(amps.toFixed(3))
        if (typeof total === 'number') state.energyTotal = Number(total.toFixed(4))
      }
    }

    return state
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>, endpointIndex?: number): Promise<CommandResult> {
    const before = await this.getState(nativeId)
    const payload = buildPayload(command, args, before, endpointIndex)
    if (!payload) return this.fail(nativeId, command, `Kasa does not support ${command}`)

    const response = await request(nativeId, payload)
    if (!response) return this.fail(nativeId, command, 'Device did not answer')

    const after = await this.getState(nativeId)
    return this.ok(nativeId, command, after, undoFrom(command, before))
  }
}

function classify(info: Record<string, any>): { category: DeviceCategory; capabilities: CapabilityId[] } {
  const base: CapabilityId[] = ['onoff', 'connectivity', 'firmware']
  const type = String(info.mic_type ?? info.type ?? '').toLowerCase()
  const model = String(info.model ?? '').toUpperCase()
  const feature = String(info.feature ?? '')

  if (type.includes('bulb') || model.startsWith('KL') || model.startsWith('LB')) {
    const capabilities: CapabilityId[] = [...base, 'brightness']
    if (info.is_variable_color_temp === 1) capabilities.push('colorTemperature')
    if (info.is_color === 1) capabilities.push('color')
    return { category: 'light', capabilities }
  }
  if (model.startsWith('HS2') || model.includes('SWITCH')) {
    return { category: 'switch', capabilities: info.brightness !== undefined ? [...base, 'brightness'] : base }
  }
  return { category: 'outlet', capabilities: feature.includes('ENE') ? [...base, 'power', 'energy'] : base }
}

function buildPayload(command: string, args: Record<string, unknown>, before: Record<string, unknown>, endpointIndex?: number): unknown | null {
  const isBulb = before.brightness !== undefined || before.colorTemperature !== undefined
  const transition = Number(args.transitionMs ?? 400)

  if (isBulb) {
    const light = (patch: Record<string, unknown>) => ({
      'smartlife.iot.smartbulb.lightingservice': { transition_light_state: { ignore_default: 1, transition_period: transition, ...patch } },
    })
    switch (command) {
      case 'turnOn':
        return light({ on_off: 1 })
      case 'turnOff':
        return light({ on_off: 0 })
      case 'toggle':
        return light({ on_off: before.on === true ? 0 : 1 })
      case 'setBrightness':
        return light({ on_off: Number(args.brightness ?? 0) > 0 ? 1 : 0, brightness: Math.round(Number(args.brightness ?? 0)) })
      case 'stepBrightness':
        return light({ on_off: 1, brightness: Math.round(Math.min(100, Math.max(0, Number(before.brightness ?? 0) + Number(args.delta ?? 0)))) })
      case 'setColorTemperature':
        return light({ on_off: 1, color_temp: Math.round(Number(args.kelvin ?? 3000)) })
      case 'setColor':
        return light({ on_off: 1, color_temp: 0, hue: Math.round(Number(args.hue ?? 0)), saturation: Math.round(Number(args.saturation ?? 100)) })
      default:
        return null
    }
  }

  const relay = (value: number) =>
    endpointIndex === undefined
      ? { system: { set_relay_state: { state: value } } }
      : { context: { child_ids: [`${endpointIndex}`] }, system: { set_relay_state: { state: value } } }

  switch (command) {
    case 'turnOn':
      return relay(1)
    case 'turnOff':
      return relay(0)
    case 'toggle':
      return relay(before.on === true ? 0 : 1)
    case 'identify':
      return { system: { set_led_off: { off: 0 } } }
    case 'resetEnergy':
      return { emeter: { erase_emeter_stat: {} } }
    default:
      return null
  }
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
    case 'setColorTemperature':
      return { command: 'setColorTemperature', args: { kelvin: Number(before.colorTemperature ?? 3000) } }
    case 'setColor':
      return { command: 'setColor', args: { hue: Number(before.hue ?? 0), saturation: Number(before.saturation ?? 0) } }
    default:
      return null
  }
}
