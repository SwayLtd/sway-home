/**
 * Tasmota.
 *
 * The firmware that a large share of cheap white-label plugs and bulbs end up running once
 * someone refuses to use the vendor cloud. One HTTP endpoint, `/cm?cmnd=<command>`, does
 * everything, and `Status 0` returns the whole device in one response.
 *
 * Covering Tasmota well is worth more than covering any single brand: it is the same
 * adapter for Sonoff, Athom, Nous, Gosund, Blitzwolf, Martin Jerry and a hundred others.
 */

import type { AdapterDescriptor, CapabilityId, CommandResult, DeviceCategory, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { hsToRgb } from '@sway-home/shared'
import { PollingAdapter, httpCandidates, httpJson, mapLimit } from '#adapters/base'

interface TasmotaStatus {
  Status?: { Module?: number; DeviceName?: string; FriendlyName?: string[]; Topic?: string; Power?: number }
  StatusFWR?: { Version?: string; Hardware?: string }
  StatusNET?: { Mac?: string; Hostname?: string; IPAddress?: string }
  StatusSNS?: Record<string, unknown>
  StatusSTS?: Record<string, unknown>
  StatusPRM?: Record<string, unknown>
}

export class TasmotaAdapter extends PollingAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'tasmota',
    name: 'Tasmota',
    vendor: 'Tasmota (open firmware)',
    transports: ['wifi'],
    capabilities: ['onoff', 'brightness', 'colorTemperature', 'color', 'power', 'energy', 'temperature', 'humidity', 'connectivity', 'firmware'],
    zeroConfig: true,
    cloud: false,
    implemented: true,
    docsUrl: 'https://tasmota.github.io/docs/Commands/',
    configSchema: [
      { key: 'username', label: 'Web username', type: 'string', help: 'Only if web authentication is enabled.' },
      { key: 'password', label: 'Web password', type: 'password' },
      { key: 'pollIntervalMs', label: 'Poll interval (ms)', type: 'number', default: 8000 },
    ],
  }

  protected override pollIntervalMs = 8000

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    const candidates = httpCandidates(hosts)
    const found = await mapLimit<NetworkHost, DiscoveredDevice | null>(candidates, 10, async (host) => {
      const status = await this.#command<TasmotaStatus>(host.ip, 'Status 0', 2500)
      if (!status?.StatusNET?.Mac || !status.Status) return null

      this.devices.set(host.ip, { ip: host.ip, meta: {} })
      const { category, capabilities } = classify(status)
      const name = status.Status.FriendlyName?.[0] ?? status.Status.DeviceName ?? `Tasmota ${host.ip}`

      return {
        adapterId: 'tasmota',
        nativeId: host.ip,
        uid: `tasmota:${status.StatusNET.Mac.toLowerCase().replace(/:/g, '')}`,
        name,
        category,
        capabilities,
        transport: 'wifi',
        manufacturer: 'Tasmota',
        model: status.StatusFWR?.Hardware ?? `Module ${status.Status.Module ?? '?'}`,
        firmwareVersion: status.StatusFWR?.Version ?? null,
        serialNumber: status.StatusNET.Mac,
        confidence: 0.94,
        network: { ip: host.ip, mac: status.StatusNET.Mac.toLowerCase(), hostname: status.StatusNET.Hostname ?? host.hostname },
        meta: { topic: status.Status.Topic ?? null },
      }
    })
    return found.filter((device): device is DiscoveredDevice => device !== null)
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const status = await this.#command<TasmotaStatus>(nativeId, 'Status 0')
    if (!status) return {}

    const state: Record<string, unknown> = {}
    const sts = status.StatusSTS ?? {}
    if (typeof sts.POWER === 'string') state.on = sts.POWER === 'ON'
    if (typeof sts.POWER1 === 'string') state.on = sts.POWER1 === 'ON'
    if (typeof sts.Dimmer === 'number') state.brightness = sts.Dimmer
    if (typeof sts.CT === 'number') state.colorTemperature = Math.round(1_000_000 / sts.CT)
    if (Array.isArray(sts.HSBColor)) {
      const [hue, saturation] = sts.HSBColor as number[]
      state.hue = hue ?? 0
      state.saturation = saturation ?? 0
    } else if (typeof sts.HSBColor === 'string') {
      const [hue, saturation] = sts.HSBColor.split(',').map(Number)
      state.hue = hue ?? 0
      state.saturation = saturation ?? 0
    }
    if (typeof (sts.Wifi as Record<string, unknown> | undefined)?.RSSI === 'number') {
      state.rssi = ((sts.Wifi as Record<string, number>).RSSI ?? 0) - 100
    }

    const sns = status.StatusSNS ?? {}
    const energy = sns.ENERGY as Record<string, number> | undefined
    if (energy) {
      if (typeof energy.Power === 'number') state.power = energy.Power
      if (typeof energy.Voltage === 'number') state.voltage = energy.Voltage
      if (typeof energy.Current === 'number') state.current = energy.Current
      if (typeof energy.Total === 'number') state.energyTotal = energy.Total
      if (typeof energy.Today === 'number') state.energyToday = energy.Today
    }
    // Sensors live under their driver name: DS18B20, SI7021, BME280, AM2301...
    for (const value of Object.values(sns)) {
      if (value === null || typeof value !== 'object') continue
      const sensor = value as Record<string, unknown>
      if (typeof sensor.Temperature === 'number') state.temperature = sensor.Temperature
      if (typeof sensor.Humidity === 'number') state.humidity = sensor.Humidity
      if (typeof sensor.Pressure === 'number') state.pressure = sensor.Pressure
    }

    if (status.StatusFWR?.Version) state.firmwareVersion = status.StatusFWR.Version
    return state
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const before = await this.getState(nativeId)
    const cmnd = buildCommand(command, args, before)
    if (!cmnd) return this.fail(nativeId, command, `Tasmota does not support ${command}`)

    const response = await this.#command<Record<string, unknown>>(nativeId, cmnd)
    if (response === null) return this.fail(nativeId, command, 'Device did not answer')

    const after = await this.getState(nativeId)
    return this.ok(nativeId, command, after, undoFrom(command, before))
  }

  async #command<T>(ip: string, cmnd: string, timeoutMs?: number): Promise<T | null> {
    const auth = this.#auth()
    const credentials = auth ? `&user=${encodeURIComponent(auth.user)}&password=${encodeURIComponent(auth.password)}` : ''
    return httpJson<T>(`http://${ip}/cm?cmnd=${encodeURIComponent(cmnd)}${credentials}`, { timeoutMs })
  }

  #auth(): { user: string; password: string } | undefined {
    const password = String(this.config.password ?? '')
    if (!password) return undefined
    return { user: String(this.config.username ?? 'admin'), password }
  }
}

function buildCommand(command: string, args: Record<string, unknown>, before: Record<string, unknown>): string | null {
  switch (command) {
    case 'turnOn':
      return 'Power ON'
    case 'turnOff':
      return 'Power OFF'
    case 'toggle':
      return 'Power TOGGLE'
    case 'setBrightness':
      return `Dimmer ${Math.round(Number(args.brightness ?? 0))}`
    case 'stepBrightness':
      return `Dimmer ${Math.round(Math.min(100, Math.max(0, Number(before.brightness ?? 0) + Number(args.delta ?? 0))))}`
    case 'setColorTemperature':
      // Tasmota speaks mireds, clamped to the 153..500 range every Tasmota bulb accepts.
      return `CT ${Math.round(Math.min(500, Math.max(153, 1_000_000 / Number(args.kelvin ?? 3000))))}`
    case 'setColor':
      return `HSBColor ${Math.round(Number(args.hue ?? 0))},${Math.round(Number(args.saturation ?? 100))},${Math.round(Number(before.brightness ?? 100))}`
    case 'setColorRgb': {
      const toHex = (value: unknown) => Math.round(Number(value ?? 0)).toString(16).padStart(2, '0')
      return `Color #${toHex(args.r)}${toHex(args.g)}${toHex(args.b)}`
    }
    case 'setColorName': {
      const named = NAMED[String(args.name ?? '').toLowerCase()]
      if (!named) return null
      const [r, g, b] = hsToRgb(named[0], named[1])
      const toHex = (value: number) => value.toString(16).padStart(2, '0')
      return `Color #${toHex(r)}${toHex(g)}${toHex(b)}`
    }
    case 'identify':
      return 'LedPower ON'
    case 'installUpdate':
      return 'Upgrade 1'
    case 'resetEnergy':
      return 'EnergyReset 0'
    default:
      return null
  }
}

function classify(status: TasmotaStatus): { category: DeviceCategory; capabilities: CapabilityId[] } {
  const base: CapabilityId[] = ['connectivity', 'firmware', 'onoff']
  const sts = status.StatusSTS ?? {}
  const sns = status.StatusSNS ?? {}

  const hasDimmer = typeof sts.Dimmer === 'number'
  const hasColour = sts.HSBColor !== undefined
  const hasEnergy = sns.ENERGY !== undefined
  const hasClimate = Object.values(sns).some(
    (value) => value !== null && typeof value === 'object' && ('Temperature' in (value as object) || 'Humidity' in (value as object))
  )

  if (hasColour) return { category: 'light', capabilities: [...base, 'brightness', 'color', 'colorTemperature'] }
  if (hasDimmer) return { category: 'light', capabilities: [...base, 'brightness', 'colorTemperature'] }
  if (hasEnergy) return { category: 'outlet', capabilities: [...base, 'power', 'energy'] }
  if (hasClimate) return { category: 'sensor', capabilities: [...base, 'temperature', 'humidity'] }
  return { category: 'switch', capabilities: base }
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
    case 'setColorRgb':
    case 'setColorName':
      return { command: 'setColor', args: { hue: Number(before.hue ?? 0), saturation: Number(before.saturation ?? 0) } }
    default:
      return null
  }
}

const NAMED: Record<string, [number, number]> = {
  rouge: [0, 100], red: [0, 100],
  orange: [30, 100],
  jaune: [55, 100], yellow: [55, 100],
  vert: [120, 100], green: [120, 100],
  cyan: [180, 100],
  bleu: [220, 100], blue: [220, 100],
  violet: [275, 100], purple: [275, 100],
  rose: [320, 80], pink: [320, 80],
  blanc: [0, 0], white: [0, 0],
}
