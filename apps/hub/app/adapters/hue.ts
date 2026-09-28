/**
 * Philips Hue bridge.
 *
 * The bridge is the one piece of hardware in this repo that needs a pairing gesture: press
 * the round button, then the hub has thirty seconds to ask for an application key. That key
 * is stored in the adapter store and never leaves the machine.
 *
 * The v1 HTTP API is used rather than CLIP v2, on purpose: v1 is plain HTTP so there is no
 * self-signed certificate to work around, it is still fully supported on current bridge
 * firmware, and every light, group, sensor and scene is two GETs away. When the pairing is
 * done the adapter upgrades to v2 event streaming if the bridge offers it.
 */

import type { AdapterDescriptor, CapabilityId, CommandResult, DeviceCategory, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { kelvinToMired, miredToKelvin, hue254ToDegrees, degreesToHue254, level254ToPercent, percentToLevel254 } from '@sway-home/shared'
import { PollingAdapter, httpJson, mapLimit } from '#adapters/base'

interface HueLight {
  name: string
  modelid: string
  manufacturername: string
  productname?: string
  uniqueid: string
  swversion?: string
  type: string
  state: { on: boolean; bri?: number; ct?: number; hue?: number; sat?: number; xy?: [number, number]; reachable?: boolean; effect?: string }
}

interface HueSensor {
  name: string
  modelid: string
  manufacturername: string
  uniqueid?: string
  type: string
  state: Record<string, unknown>
  config?: { battery?: number; reachable?: boolean }
}

export class HueAdapter extends PollingAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'hue',
    name: 'Philips Hue',
    vendor: 'Signify',
    transports: ['zigbee', 'wifi'],
    capabilities: ['onoff', 'brightness', 'colorTemperature', 'color', 'effect', 'motion', 'illuminance', 'temperature', 'battery', 'button', 'identify', 'scene', 'connectivity'],
    zeroConfig: false,
    cloud: false,
    implemented: true,
    docsUrl: 'https://developers.meethue.com/develop/hue-api/',
    configSchema: [
      { key: 'bridgeIp', label: 'Bridge address', type: 'host', placeholder: '192.168.1.42', help: 'Left empty, the hub finds the bridge itself.' },
      { key: 'pollIntervalMs', label: 'Poll interval (ms)', type: 'number', default: 5000 },
    ],
  }

  protected override pollIntervalMs = 5000
  #bridgeIp: string | null = null
  #appKey: string | null = null

  protected override async onInit(): Promise<void> {
    this.#bridgeIp = (String(this.config.bridgeIp ?? '') || (await this.context?.store.get<string>('bridgeIp'))) ?? null
    this.#appKey = (await this.context?.store.get<string>('appKey')) ?? null
  }

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    const bridge = this.#bridgeIp ?? (await this.#findBridge(hosts))
    if (!bridge) return []
    this.#bridgeIp = bridge
    await this.context?.store.set('bridgeIp', bridge)

    if (!this.#appKey) {
      // The bridge is there but not paired yet. Report it as one device so the UI can offer
      // the pairing button rather than silently finding nothing.
      const config = await httpJson<{ bridgeid?: string; name?: string; modelid?: string; swversion?: string; mac?: string }>(`http://${bridge}/api/config`)
      if (!config?.bridgeid) return []
      return [
        {
          adapterId: 'hue',
          nativeId: `bridge:${bridge}`,
          uid: `hue:bridge:${config.bridgeid}`,
          name: config.name ?? 'Hue Bridge',
          category: 'hub',
          capabilities: ['identify'],
          transport: 'wifi',
          manufacturer: 'Signify',
          model: config.modelid ?? 'BSB002',
          firmwareVersion: config.swversion ?? null,
          serialNumber: config.bridgeid,
          confidence: 0.98,
          network: { ip: bridge, mac: config.mac ?? null },
          requiresPairing: { kind: 'button', instructions: 'Press the round button on the Hue bridge, then start pairing within 30 seconds.' },
          meta: { bridgeId: config.bridgeid },
        },
      ]
    }

    const [lights, sensors] = await Promise.all([
      httpJson<Record<string, HueLight>>(`http://${bridge}/api/${this.#appKey}/lights`),
      httpJson<Record<string, HueSensor>>(`http://${bridge}/api/${this.#appKey}/sensors`),
    ])

    const found: DiscoveredDevice[] = []

    for (const [id, light] of Object.entries(lights ?? {})) {
      const nativeId = `light:${id}`
      this.devices.set(nativeId, { ip: bridge, meta: { id } })
      found.push({
        adapterId: 'hue',
        nativeId,
        uid: `hue:${light.uniqueid}`,
        name: light.name,
        category: 'light',
        capabilities: lightCapabilities(light),
        transport: 'zigbee',
        manufacturer: light.manufacturername,
        model: light.productname ?? light.modelid,
        firmwareVersion: light.swversion ?? null,
        serialNumber: light.uniqueid,
        confidence: 0.99,
        network: { ip: bridge },
        meta: { bridgeIp: bridge, hueId: id, hueType: light.type },
      })
    }

    for (const [id, sensor] of Object.entries(sensors ?? {})) {
      // The bridge invents a pile of internal "sensors" (daylight, CLIPGenericStatus) that
      // are software, not hardware. Only real hardware gets a device row.
      if (!sensor.uniqueid || !/^ZLL|^ZHA/.test(sensor.type)) continue
      const nativeId = `sensor:${id}`
      this.devices.set(nativeId, { ip: bridge, meta: { id } })
      const { category, capabilities } = sensorCapabilities(sensor)
      found.push({
        adapterId: 'hue',
        nativeId,
        uid: `hue:${sensor.uniqueid}`,
        name: sensor.name,
        category,
        capabilities,
        transport: 'zigbee',
        manufacturer: sensor.manufacturername,
        model: sensor.modelid,
        confidence: 0.99,
        network: { ip: bridge },
        meta: { bridgeIp: bridge, hueId: id, hueType: sensor.type },
      })
    }

    return found
  }

  /** Pairing: the bridge answers with an app key only while the link button is lit. */
  async pair(input: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    const bridge = String(input.bridgeIp ?? this.#bridgeIp ?? '')
    if (!bridge) return { ok: false, message: 'No Hue bridge address known yet. Run a scan first.' }

    const response = await httpJson<{ success?: { username: string }; error?: { description: string } }[]>(`http://${bridge}/api`, {
      method: 'POST',
      body: { devicetype: 'sway-home#hub' },
      timeoutMs: 6000,
    })

    const first = response?.[0]
    if (first?.success?.username) {
      this.#appKey = first.success.username
      await this.context?.store.set('appKey', this.#appKey)
      await this.context?.store.set('bridgeIp', bridge)
      return { ok: true, message: 'Paired. Run a scan to import the lights.' }
    }

    return { ok: false, message: first?.error?.description ?? 'Press the round button on the bridge, then try again within 30 seconds.' }
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    if (!this.#bridgeIp || !this.#appKey) return {}
    const [kind, id] = nativeId.split(':')
    if (kind === 'light') {
      const light = await httpJson<HueLight>(`http://${this.#bridgeIp}/api/${this.#appKey}/lights/${id}`)
      if (!light) return {}
      return lightState(light)
    }
    if (kind === 'sensor') {
      const sensor = await httpJson<HueSensor>(`http://${this.#bridgeIp}/api/${this.#appKey}/sensors/${id}`)
      if (!sensor) return {}
      return sensorState(sensor)
    }
    return {}
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    if (!this.#bridgeIp || !this.#appKey) return this.fail(nativeId, command, 'Hue bridge is not paired')
    const [kind, id] = nativeId.split(':')
    if (kind !== 'light') return this.fail(nativeId, command, 'Only Hue lights accept commands')

    const before = await this.getState(nativeId)
    const body = buildBody(command, args, before)
    if (!body) return this.fail(nativeId, command, `Hue does not support ${command}`)

    const response = await httpJson<unknown[]>(`http://${this.#bridgeIp}/api/${this.#appKey}/lights/${id}/state`, { method: 'PUT', body })
    if (response === null) return this.fail(nativeId, command, 'Bridge did not answer')

    const after = await this.getState(nativeId)
    return this.ok(nativeId, command, after, undoFrom(command, before))
  }

  async #findBridge(hosts: NetworkHost[]): Promise<string | null> {
    // mDNS first, then any host answering `/api/config` with a bridge id.
    const advertised = hosts.find((host) => host.mdnsServices.some((service) => service.includes('_hue._tcp')))
    if (advertised) return advertised.ip

    const candidates = hosts.filter((host) => host.openPorts.includes(80) || host.openPorts.includes(443))
    const results = await mapLimit<NetworkHost, string | null>(candidates, 10, async (host) => {
      const config = await httpJson<{ bridgeid?: string; modelid?: string }>(`http://${host.ip}/api/config`, { timeoutMs: 1800 })
      return config?.bridgeid && config.modelid?.startsWith('BSB') ? host.ip : null
    })
    return results.find((ip): ip is string => ip !== null) ?? null
  }
}

function lightCapabilities(light: HueLight): CapabilityId[] {
  const base: CapabilityId[] = ['onoff', 'identify', 'connectivity']
  const type = light.type.toLowerCase()
  if (type.includes('extended color') || type.includes('color light')) return [...base, 'brightness', 'colorTemperature', 'color', 'effect']
  if (type.includes('temperature')) return [...base, 'brightness', 'colorTemperature']
  if (type.includes('dimmable')) return [...base, 'brightness']
  return base
}

function lightState(light: HueLight): Record<string, unknown> {
  const state: Record<string, unknown> = { on: light.state.on }
  if (typeof light.state.bri === 'number') state.brightness = level254ToPercent(light.state.bri)
  if (typeof light.state.ct === 'number') state.colorTemperature = miredToKelvin(light.state.ct)
  if (typeof light.state.hue === 'number') state.hue = hue254ToDegrees(light.state.hue / 257)
  if (typeof light.state.sat === 'number') state.saturation = level254ToPercent(light.state.sat)
  if (typeof light.state.effect === 'string') state.effect = light.state.effect === 'none' ? null : light.state.effect
  if (light.state.reachable === false) state.rssi = undefined
  return state
}

function sensorCapabilities(sensor: HueSensor): { category: DeviceCategory; capabilities: CapabilityId[] } {
  const type = sensor.type.toLowerCase()
  if (type.includes('presence')) return { category: 'sensor', capabilities: ['motion', 'battery', 'connectivity'] }
  if (type.includes('lightlevel')) return { category: 'sensor', capabilities: ['illuminance', 'battery'] }
  if (type.includes('temperature')) return { category: 'sensor', capabilities: ['temperature', 'battery'] }
  if (type.includes('switch')) return { category: 'sensor', capabilities: ['button', 'battery'] }
  return { category: 'sensor', capabilities: ['battery'] }
}

function sensorState(sensor: HueSensor): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  if (typeof sensor.state.presence === 'boolean') {
    state.motion = sensor.state.presence
    if (sensor.state.presence) state.lastMotionAt = String(sensor.state.lastupdated ?? new Date().toISOString())
  }
  if (typeof sensor.state.lightlevel === 'number') {
    // Hue reports 10000 * log10(lux) + 1; invert it back to lux.
    state.illuminance = Math.round(10 ** ((sensor.state.lightlevel - 1) / 10000))
  }
  if (typeof sensor.state.temperature === 'number') state.temperature = sensor.state.temperature / 100
  if (typeof sensor.state.buttonevent === 'number') {
    const event = sensor.state.buttonevent
    state.lastEvent = event % 1000 === 2 ? 'hold' : event % 1000 === 3 ? 'release' : 'single'
    state.buttonIndex = Math.floor(event / 1000) - 1
    state.lastEventAt = String(sensor.state.lastupdated ?? new Date().toISOString())
  }
  if (typeof sensor.config?.battery === 'number') {
    state.battery = sensor.config.battery
    state.batteryLow = sensor.config.battery <= 20
  }
  return state
}

function buildBody(command: string, args: Record<string, unknown>, before: Record<string, unknown>): Record<string, unknown> | null {
  const transitiontime = Math.round(Number(args.transitionMs ?? 400) / 100)

  switch (command) {
    case 'turnOn':
      return { on: true, transitiontime }
    case 'turnOff':
      return { on: false, transitiontime }
    case 'toggle':
      return { on: before.on !== true, transitiontime }
    case 'setBrightness':
      return { on: Number(args.brightness ?? 0) > 0, bri: percentToLevel254(Number(args.brightness ?? 0)), transitiontime }
    case 'stepBrightness':
      return { bri_inc: percentToLevel254(Number(args.delta ?? 0)), transitiontime }
    case 'setColorTemperature':
      return { on: true, ct: kelvinToMired(Number(args.kelvin ?? 3000)), transitiontime }
    case 'setColor':
      return { on: true, hue: degreesToHue254(Number(args.hue ?? 0)) * 257, sat: percentToLevel254(Number(args.saturation ?? 100)), transitiontime }
    case 'setEffect':
      return { effect: String(args.effect ?? 'none') }
    case 'clearEffect':
      return { effect: 'none' }
    case 'identify':
      return { alert: 'select' }
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
