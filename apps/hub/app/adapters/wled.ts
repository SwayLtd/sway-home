/**
 * WLED.
 *
 * One JSON endpoint for everything: GET `/json` returns info, state and the effect and
 * palette lists; POST `/json/state` sets any of it. That makes WLED the cheapest adapter in
 * the repo and the best demonstration of the capability model, because a single strip
 * exposes on/off, brightness, colour and a hundred named effects through the same four
 * capabilities every other light uses.
 */

import type { AdapterDescriptor, CapabilityId, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { hsToRgb, rgbToHs } from '@sway-home/shared'
import { PollingAdapter, httpCandidates, httpJson, mapLimit } from '#adapters/base'

interface WledResponse {
  state: {
    on: boolean
    bri: number
    transition?: number
    ps?: number
    seg?: { col?: number[][]; fx?: number; sx?: number; ix?: number; pal?: number }[]
  }
  info: {
    ver: string
    name: string
    mac: string
    arch?: string
    brand?: string
    product?: string
    leds?: { count: number; pwr?: number; maxpwr?: number }
    wifi?: { rssi?: number; signal?: number }
  }
  effects?: string[]
  palettes?: string[]
}

const WLED_CAPABILITIES: CapabilityId[] = ['onoff', 'brightness', 'color', 'effect', 'power', 'connectivity', 'firmware']

export class WledAdapter extends PollingAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'wled',
    name: 'WLED',
    vendor: 'WLED project',
    transports: ['wifi'],
    capabilities: WLED_CAPABILITIES,
    zeroConfig: true,
    cloud: false,
    implemented: true,
    docsUrl: 'https://kno.wled.ge/interfaces/json-api/',
    configSchema: [{ key: 'pollIntervalMs', label: 'Poll interval (ms)', type: 'number', default: 6000 }],
  }

  protected override pollIntervalMs = 6000
  #effects = new Map<string, string[]>()

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    const candidates = httpCandidates(hosts)
    const found = await mapLimit<NetworkHost, DiscoveredDevice | null>(candidates, 12, async (host) => {
      const data = await httpJson<WledResponse>(`http://${host.ip}/json`, { timeoutMs: 2500 })
      if (!data?.info?.mac || typeof data.state?.bri !== 'number') return null
      // `info.brand` is "WLED" on every stock build; anything else with this shape is not one.
      if (data.info.brand && !/wled/i.test(data.info.brand)) return null

      this.devices.set(host.ip, { ip: host.ip, meta: { leds: data.info.leds?.count ?? 0 } })
      this.#effects.set(host.ip, data.effects ?? [])

      return {
        adapterId: 'wled',
        nativeId: host.ip,
        uid: `wled:${data.info.mac.toLowerCase()}`,
        name: data.info.name || `WLED ${host.ip}`,
        category: 'light',
        capabilities: WLED_CAPABILITIES,
        transport: 'wifi',
        manufacturer: 'WLED',
        model: data.info.product ?? data.info.arch ?? 'WLED',
        firmwareVersion: data.info.ver,
        serialNumber: data.info.mac,
        confidence: 0.96,
        network: { ip: host.ip, mac: formatMac(data.info.mac), hostname: host.hostname },
        meta: { leds: data.info.leds?.count ?? 0, maxPowerMilliamps: data.info.leds?.maxpwr ?? null },
      }
    })
    return found.filter((device): device is DiscoveredDevice => device !== null)
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const data = await httpJson<WledResponse>(`http://${nativeId}/json`)
    if (!data) return {}

    const segment = data.state.seg?.[0]
    const colour = segment?.col?.[0]
    const state: Record<string, unknown> = {
      on: data.state.on,
      brightness: Math.round((data.state.bri / 255) * 100),
      availableEffects: data.effects ?? this.#effects.get(nativeId) ?? [],
    }

    if (colour && colour.length >= 3) {
      const [hue, saturation] = rgbToHs(colour[0] ?? 0, colour[1] ?? 0, colour[2] ?? 0)
      state.hue = hue
      state.saturation = saturation
    }
    if (typeof segment?.fx === 'number') {
      const effects = data.effects ?? this.#effects.get(nativeId) ?? []
      state.effect = segment.fx === 0 ? null : effects[segment.fx] ?? String(segment.fx)
    }
    if (typeof data.info.leds?.pwr === 'number') state.power = Number((data.info.leds.pwr / 1000).toFixed(2))
    if (typeof data.info.wifi?.rssi === 'number') state.rssi = data.info.wifi.rssi
    state.firmwareVersion = data.info.ver

    return state
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const before = await this.getState(nativeId)
    const body = this.#body(nativeId, command, args, before)
    if (!body) return this.fail(nativeId, command, `WLED does not support ${command}`)

    const response = await httpJson<unknown>(`http://${nativeId}/json/state`, { method: 'POST', body })
    if (response === null) return this.fail(nativeId, command, 'Device did not answer')

    const after = await this.getState(nativeId)
    return this.ok(nativeId, command, after, undoFrom(command, before))
  }

  #body(nativeId: string, command: string, args: Record<string, unknown>, before: Record<string, unknown>): Record<string, unknown> | null {
    // WLED counts transitions in tenths of a second.
    const transition = Math.round(Number(args.transitionMs ?? 400) / 100)

    switch (command) {
      case 'turnOn':
        return { on: true, transition }
      case 'turnOff':
        return { on: false, transition }
      case 'toggle':
        return { on: 't', transition }
      case 'setBrightness':
        return { on: Number(args.brightness ?? 0) > 0, bri: Math.round((Number(args.brightness ?? 0) / 100) * 255), transition }
      case 'stepBrightness': {
        const next = Math.min(100, Math.max(0, Number(before.brightness ?? 0) + Number(args.delta ?? 0)))
        return { on: next > 0, bri: Math.round((next / 100) * 255), transition }
      }
      case 'setColor': {
        const [r, g, b] = hsToRgb(Number(args.hue ?? 0), Number(args.saturation ?? 100))
        return { on: true, seg: [{ col: [[r, g, b]] }], transition }
      }
      case 'setColorRgb':
        return { on: true, seg: [{ col: [[Number(args.r ?? 0), Number(args.g ?? 0), Number(args.b ?? 0)]] }], transition }
      case 'setEffect': {
        const effects = this.#effects.get(nativeId) ?? []
        const wanted = String(args.effect ?? '').toLowerCase()
        const index = effects.findIndex((effect) => effect.toLowerCase() === wanted)
        if (index === -1) return null
        const speed = args.speed === undefined ? undefined : Math.round((Number(args.speed) / 100) * 255)
        return { on: true, seg: [{ fx: index, ...(speed === undefined ? {} : { sx: speed }) }] }
      }
      case 'clearEffect':
        return { seg: [{ fx: 0 }] }
      case 'identify':
        // There is no identify in the API; full brightness for a moment is the honest equivalent.
        return { on: true, bri: 255, transition: 0 }
      default:
        return null
    }
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
    case 'setColor':
    case 'setColorRgb':
      return { command: 'setColor', args: { hue: Number(before.hue ?? 0), saturation: Number(before.saturation ?? 0) } }
    case 'setEffect':
    case 'clearEffect':
      return before.effect ? { command: 'setEffect', args: { effect: before.effect } } : { command: 'clearEffect', args: {} }
    default:
      return null
  }
}

function formatMac(mac: string): string {
  const hex = mac.replace(/[^0-9a-f]/gi, '').toLowerCase()
  return hex.length === 12 ? (hex.match(/.{2}/g) ?? []).join(':') : mac
}
