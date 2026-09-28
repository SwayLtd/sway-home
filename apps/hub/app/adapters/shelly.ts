/**
 * Shelly.
 *
 * Two generations with two different APIs, both spoken here:
 *  - Gen1 (Shelly 1, 2.5, Dimmer, Plug S): flat HTTP, `/status`, `/relay/0?turn=on`.
 *  - Gen2 and up (Plus, Pro, Mini, Gen3, Gen4): JSON-RPC at `/rpc/<Method>`.
 *
 * Shelly is the best-behaved LAN device in the house: no cloud, no token, documented, and
 * it answers `/shelly` with everything needed to identify it. That single endpoint is the
 * whole discovery step.
 */

import type {
  AdapterDescriptor,
  CapabilityId,
  CommandResult,
  DeviceCategory,
  DiscoveredDevice,
  NetworkHost,
  ProtocolAdapter,
} from '@sway-home/shared'
import { PollingAdapter, httpCandidates, httpJson, mapLimit } from '#adapters/base'

interface ShellyIdentity {
  gen: number
  id: string
  mac: string
  model: string
  app?: string
  fw?: string
  fw_id?: string
  type?: string
  auth?: boolean
  auth_en?: boolean
  num_outputs?: number
  num_meters?: number
  profile?: string
}

export class ShellyAdapter extends PollingAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'shelly',
    name: 'Shelly',
    vendor: 'Allterco',
    transports: ['wifi', 'ethernet'],
    capabilities: ['onoff', 'brightness', 'colorTemperature', 'color', 'position', 'power', 'energy', 'temperature', 'humidity', 'contact', 'connectivity', 'firmware', 'identify'],
    zeroConfig: true,
    cloud: false,
    implemented: true,
    docsUrl: 'https://shelly-api-docs.shelly.cloud/',
    configSchema: [
      { key: 'username', label: 'Username', type: 'string', help: 'Only if the device has authentication enabled (Gen1).' },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'pollIntervalMs', label: 'Poll interval (ms)', type: 'number', default: 8000 },
    ],
  }

  protected override pollIntervalMs = 8000
  #identities = new Map<string, ShellyIdentity>()

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    // `_shelly._tcp` responders first, then anything else with a web port: a Shelly behind
    // a VLAN that blocks multicast still answers `/shelly` on 80.
    const candidates = httpCandidates(hosts).sort((a, b) => {
      const aShelly = a.mdnsServices.some((s) => s.includes('_shelly')) ? 1 : 0
      const bShelly = b.mdnsServices.some((s) => s.includes('_shelly')) ? 1 : 0
      return bShelly - aShelly
    })

    const found = await mapLimit<NetworkHost, DiscoveredDevice | null>(candidates, 12, async (host) => {
      const identity = await httpJson<ShellyIdentity>(`http://${host.ip}/shelly`, { timeoutMs: 2500 })
      if (!identity || (!identity.mac && !identity.id)) return null
      // `/shelly` is Shelly-specific; a non-Shelly answering it with this shape does not
      // happen in practice, so a positive answer is proof rather than a hint.
      if (!identity.model && !identity.type && !identity.app) return null

      const nativeId = host.ip
      this.#identities.set(nativeId, identity)
      this.devices.set(nativeId, { ip: host.ip, meta: { gen: identity.gen ?? 1 } })

      const gen = identity.gen ?? 1
      const { category, capabilities } = classify(identity)

      return {
        adapterId: 'shelly',
        nativeId,
        uid: `shelly:${(identity.mac ?? identity.id).toLowerCase()}`,
        name: identity.id ?? `Shelly ${identity.model ?? identity.type ?? ''}`.trim(),
        category,
        capabilities,
        transport: 'wifi',
        manufacturer: 'Shelly',
        model: identity.model ?? identity.app ?? identity.type ?? 'Shelly',
        firmwareVersion: identity.fw ?? identity.fw_id ?? null,
        serialNumber: identity.mac ?? null,
        confidence: 0.97,
        network: { ip: host.ip, mac: identity.mac ? formatMac(identity.mac) : host.mac, hostname: host.hostname },
        meta: { gen, profile: identity.profile ?? null, numOutputs: identity.num_outputs ?? 1 },
        endpoints:
          (identity.num_outputs ?? 1) > 1
            ? Array.from({ length: identity.num_outputs ?? 1 }, (_, index): { index: number; name: string; category: DeviceCategory; capabilities: CapabilityId[] } => ({
                index,
                name: `Sortie ${index + 1}`,
                category: 'switch',
                capabilities: ['onoff', 'power', 'energy'],
              }))
            : undefined,
      }
    })

    return found.filter((device): device is DiscoveredDevice => device !== null)
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const gen = Number(this.devices.get(nativeId)?.meta.gen ?? 1)
    return gen >= 2 ? this.#stateGen2(nativeId) : this.#stateGen1(nativeId)
  }

  async #stateGen1(ip: string): Promise<Record<string, unknown>> {
    const status = await httpJson<Record<string, any>>(`http://${ip}/status`, { auth: this.#auth() })
    if (!status) return {}

    const state: Record<string, unknown> = {}
    const relay = status.relays?.[0]
    if (relay) state.on = relay.ison === true
    const light = status.lights?.[0]
    if (light) {
      state.on = light.ison === true
      if (typeof light.brightness === 'number') state.brightness = light.brightness
      if (typeof light.temp === 'number') state.colorTemperature = light.temp
      if (typeof light.red === 'number') Object.assign(state, rgbToHs(light.red, light.green ?? 0, light.blue ?? 0))
    }
    const meter = status.meters?.[0]
    if (meter) {
      if (typeof meter.power === 'number') state.power = Number(meter.power.toFixed(1))
      if (typeof meter.total === 'number') state.energyTotal = Number((meter.total / 60000).toFixed(4)) // Wmin -> kWh
    }
    if (typeof status.tmp?.tC === 'number') state.temperature = status.tmp.tC
    if (typeof status.hum?.value === 'number') state.humidity = status.hum.value
    if (typeof status.bat?.value === 'number') state.battery = status.bat.value
    if (typeof status.wifi_sta?.rssi === 'number') state.rssi = status.wifi_sta.rssi
    if (status.update) state.updateAvailable = status.update.has_update === true
    if (typeof status.rollers?.[0]?.current_pos === 'number') state.position = status.rollers[0].current_pos

    return state
  }

  async #stateGen2(ip: string): Promise<Record<string, unknown>> {
    const status = await httpJson<Record<string, any>>(`http://${ip}/rpc/Shelly.GetStatus`, { auth: this.#auth() })
    if (!status) return {}

    const state: Record<string, unknown> = {}
    const switch0 = status['switch:0']
    if (switch0) {
      state.on = switch0.output === true
      if (typeof switch0.apower === 'number') state.power = Number(switch0.apower.toFixed(1))
      if (typeof switch0.voltage === 'number') state.voltage = Number(switch0.voltage.toFixed(1))
      if (typeof switch0.current === 'number') state.current = Number(switch0.current.toFixed(3))
      if (typeof switch0.aenergy?.total === 'number') state.energyTotal = Number((switch0.aenergy.total / 1000).toFixed(4))
      if (typeof switch0.temperature?.tC === 'number') state.temperature = switch0.temperature.tC
    }
    const light0 = status['light:0']
    if (light0) {
      state.on = light0.output === true
      if (typeof light0.brightness === 'number') state.brightness = light0.brightness
    }
    const cover0 = status['cover:0']
    if (cover0) {
      if (typeof cover0.current_pos === 'number') state.position = cover0.current_pos
      state.moving = cover0.state === 'opening' ? 'opening' : cover0.state === 'closing' ? 'closing' : 'idle'
    }
    if (typeof status['temperature:0']?.tC === 'number') state.temperature = status['temperature:0'].tC
    if (typeof status['humidity:0']?.rh === 'number') state.humidity = status['humidity:0'].rh
    if (typeof status.wifi?.rssi === 'number') state.rssi = status.wifi.rssi
    if (typeof status.sys?.available_updates === 'object') {
      state.updateAvailable = Object.keys(status.sys.available_updates ?? {}).length > 0
    }

    return state
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const gen = Number(this.devices.get(nativeId)?.meta.gen ?? 1)
    const before = await this.getState(nativeId)

    const url = gen >= 2 ? this.#urlGen2(command, args) : this.#urlGen1(command, args)
    if (!url) return this.fail(nativeId, command, `Shelly gen${gen} does not support ${command}`)

    const response = await httpJson<unknown>(`http://${nativeId}${url}`, { auth: this.#auth() })
    if (response === null) return this.fail(nativeId, command, 'Device did not answer')

    const after = await this.getState(nativeId)
    return this.ok(nativeId, command, after, undoFrom(command, before))
  }

  #urlGen1(command: string, args: Record<string, unknown>): string | null {
    switch (command) {
      case 'turnOn':
        return '/relay/0?turn=on'
      case 'turnOff':
        return '/relay/0?turn=off'
      case 'toggle':
        return '/relay/0?turn=toggle'
      case 'setBrightness':
        return `/light/0?turn=on&brightness=${Math.round(Number(args.brightness ?? 0))}`
      case 'setColorTemperature':
        return `/light/0?turn=on&temp=${Math.round(Number(args.kelvin ?? 3000))}`
      case 'setPosition':
        return `/roller/0?go=to_pos&roller_pos=${Math.round(Number(args.position ?? 0))}`
      case 'open':
        return '/roller/0?go=open'
      case 'close':
        return '/roller/0?go=close'
      case 'stop':
        return '/roller/0?go=stop'
      default:
        return null
    }
  }

  #urlGen2(command: string, args: Record<string, unknown>): string | null {
    switch (command) {
      case 'turnOn':
        return '/rpc/Switch.Set?id=0&on=true'
      case 'turnOff':
        return '/rpc/Switch.Set?id=0&on=false'
      case 'toggle':
        return '/rpc/Switch.Toggle?id=0'
      case 'setBrightness':
        return `/rpc/Light.Set?id=0&on=true&brightness=${Math.round(Number(args.brightness ?? 0))}`
      case 'setPosition':
        return `/rpc/Cover.GoToPosition?id=0&pos=${Math.round(Number(args.position ?? 0))}`
      case 'open':
        return '/rpc/Cover.Open?id=0'
      case 'close':
        return '/rpc/Cover.Close?id=0'
      case 'stop':
        return '/rpc/Cover.Stop?id=0'
      case 'identify':
        return '/rpc/Shelly.SetDeviceIdentification?enable=true'
      case 'installUpdate':
        return '/rpc/Shelly.Update?stage=stable'
      default:
        return null
    }
  }

  #auth(): { user: string; password: string } | undefined {
    const password = String(this.config.password ?? '')
    if (!password) return undefined
    return { user: String(this.config.username ?? 'admin'), password }
  }
}

function classify(identity: ShellyIdentity): { category: DeviceCategory; capabilities: CapabilityId[] } {
  const model = `${identity.model ?? ''} ${identity.app ?? ''} ${identity.type ?? ''}`.toLowerCase()
  const base: CapabilityId[] = ['connectivity', 'firmware']

  if (/dimmer|dimmi/.test(model)) {
    return { category: 'light', capabilities: [...base, 'onoff', 'brightness', 'power', 'energy'] }
  }
  if (/rgbw|duo|bulb|vintage/.test(model)) {
    return { category: 'light', capabilities: [...base, 'onoff', 'brightness', 'colorTemperature', 'color', 'power', 'energy'] }
  }
  if (/2pm|shutter|cover|roller|25/.test(model)) {
    return { category: 'cover', capabilities: [...base, 'position', 'power', 'energy', 'onoff'] }
  }
  if (/plug|pm mini|plus plug/.test(model)) {
    return { category: 'outlet', capabilities: [...base, 'onoff', 'power', 'energy', 'temperature'] }
  }
  if (/ht|h&t|温/.test(model)) {
    return { category: 'sensor', capabilities: [...base, 'temperature', 'humidity', 'battery'] }
  }
  if (/door|window|dw/.test(model)) {
    return { category: 'sensor', capabilities: [...base, 'contact', 'battery', 'illuminance'] }
  }
  if (/flood/.test(model)) {
    return { category: 'sensor', capabilities: [...base, 'waterLeak', 'temperature', 'battery'] }
  }
  if (/motion/.test(model)) {
    return { category: 'sensor', capabilities: [...base, 'motion', 'illuminance', 'battery'] }
  }
  return { category: 'switch', capabilities: [...base, 'onoff', 'power', 'energy'] }
}

function undoFrom(command: string, before: Record<string, unknown>): { command: string; args: Record<string, unknown> } | null {
  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'toggle':
      return { command: before.on === true ? 'turnOn' : 'turnOff', args: {} }
    case 'setBrightness':
      return { command: 'setBrightness', args: { brightness: Number(before.brightness ?? 100) } }
    case 'setPosition':
    case 'open':
    case 'close':
      return { command: 'setPosition', args: { position: Number(before.position ?? 0) } }
    default:
      return null
  }
}

function formatMac(mac: string): string {
  const hex = mac.replace(/[^0-9a-f]/gi, '').toLowerCase()
  return hex.length === 12 ? (hex.match(/.{2}/g) ?? []).join(':') : mac
}

function rgbToHs(r: number, g: number, b: number): { hue: number; saturation: number } {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const delta = max - min
  let hue = 0
  if (delta !== 0) {
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    if (max === rn) hue = 60 * (((gn - bn) / delta) % 6)
    else if (max === gn) hue = 60 * ((bn - rn) / delta + 2)
    else hue = 60 * ((rn - gn) / delta + 4)
  }
  if (hue < 0) hue += 360
  return { hue: Math.round(hue), saturation: Math.round((max === 0 ? 0 : delta / max) * 100) }
}
