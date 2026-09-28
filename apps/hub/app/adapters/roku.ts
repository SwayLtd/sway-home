/**
 * Roku, over the External Control Protocol.
 *
 * ECP is the friendliest TV API there is: plain HTTP on port 8060, XML in, no auth, no
 * pairing, documented by the vendor. `/query/device-info` identifies the box and
 * `/keypress/<key>` does everything a remote does.
 *
 * It also covers every TV that ships Roku TV inside it - TCL, Hisense, Philips, Sharp,
 * onn - which is why one small adapter is worth more than its size.
 */

import type { AdapterDescriptor, CapabilityId, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { PollingAdapter, httpText, mapLimit } from '#adapters/base'

const ROKU_PORT = 8060
const ROKU_CAPABILITIES: CapabilityId[] = ['onoff', 'mediaPlayback', 'volume', 'mediaSource', 'connectivity']

function xmlTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml)
  return match?.[1]?.trim() ?? null
}

export class RokuAdapter extends PollingAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'roku',
    name: 'Roku',
    vendor: 'Roku',
    transports: ['wifi', 'ethernet'],
    capabilities: ROKU_CAPABILITIES,
    zeroConfig: true,
    cloud: false,
    implemented: true,
    docsUrl: 'https://developer.roku.com/docs/developer-program/dev-tools/external-control-api.md',
    configSchema: [{ key: 'pollIntervalMs', label: 'Poll interval (ms)', type: 'number', default: 10000 }],
  }

  protected override pollIntervalMs = 10_000
  #apps = new Map<string, { id: string; name: string }[]>()

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    const candidates = hosts.filter((host) => host.openPorts.includes(ROKU_PORT) || /roku/i.test(`${host.macVendor} ${host.hostname} ${host.ssdp?.server}`))

    const found = await mapLimit<NetworkHost, DiscoveredDevice | null>(candidates, 8, async (host) => {
      const xml = await httpText(`http://${host.ip}:${ROKU_PORT}/query/device-info`, 2500)
      if (!xml || !xml.includes('<device-info>')) return null

      const serial = xmlTag(xml, 'serial-number') ?? xmlTag(xml, 'device-id') ?? host.ip
      const isTv = xmlTag(xml, 'is-tv') === 'true'
      this.devices.set(host.ip, { ip: host.ip, meta: { isTv } })

      const apps = await this.#loadApps(host.ip)

      return {
        adapterId: 'roku',
        nativeId: host.ip,
        uid: `roku:${serial}`,
        name: xmlTag(xml, 'friendly-device-name') ?? xmlTag(xml, 'user-device-name') ?? xmlTag(xml, 'model-name') ?? `Roku ${host.ip}`,
        category: isTv ? 'display' : 'media',
        capabilities: ROKU_CAPABILITIES,
        transport: 'wifi',
        manufacturer: xmlTag(xml, 'vendor-name') ?? 'Roku',
        model: xmlTag(xml, 'model-name') ?? 'Roku',
        firmwareVersion: xmlTag(xml, 'software-version'),
        serialNumber: serial,
        confidence: 0.96,
        network: { ip: host.ip, mac: xmlTag(xml, 'wifi-mac') ?? xmlTag(xml, 'ethernet-mac') ?? host.mac, hostname: host.hostname },
        meta: { isTv, apps: apps.map((app) => app.name) },
      }
    })

    return found.filter((device): device is DiscoveredDevice => device !== null)
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const [info, active, media] = await Promise.all([
      httpText(`http://${nativeId}:${ROKU_PORT}/query/device-info`),
      httpText(`http://${nativeId}:${ROKU_PORT}/query/active-app`),
      httpText(`http://${nativeId}:${ROKU_PORT}/query/media-player`),
    ])
    if (!info) return {}

    const state: Record<string, unknown> = {
      on: xmlTag(info, 'power-mode') === 'PowerOn',
      availableSources: (this.#apps.get(nativeId) ?? []).map((app) => app.name),
    }

    const volume = xmlTag(info, 'volume-level')
    if (volume !== null) state.volume = Number(volume)
    const muted = xmlTag(info, 'mute')
    if (muted !== null) state.muted = muted === 'true'

    if (active) {
      const appName = /<app[^>]*>([^<]+)<\/app>/i.exec(active)?.[1]?.trim()
      if (appName) {
        state.app = appName
        state.source = appName
      }
    }

    if (media) {
      const playState = /state="([^"]+)"/i.exec(media)?.[1]
      state.playback = playState === 'play' ? 'playing' : playState === 'pause' ? 'paused' : playState === 'buffer' ? 'buffering' : 'stopped'
      const position = /<position>(\d+)/.exec(media)?.[1]
      const duration = /<duration>(\d+)/.exec(media)?.[1]
      if (position) state.positionSeconds = Math.round(Number(position) / 1000)
      if (duration) state.durationSeconds = Math.round(Number(duration) / 1000)
      const title = xmlTag(media, 'title')
      if (title) state.title = title
    }

    return state
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const before = await this.getState(nativeId)
    const path = await this.#path(nativeId, command, args)
    if (!path) return this.fail(nativeId, command, `Roku does not support ${command}`)

    const response = await fetch(`http://${nativeId}:${ROKU_PORT}${path}`, { method: 'POST' }).catch(() => null)
    if (!response || !response.ok) return this.fail(nativeId, command, 'Device did not answer')

    const after = await this.getState(nativeId)
    return this.ok(nativeId, command, after, undoFrom(command, before))
  }

  async #path(nativeId: string, command: string, args: Record<string, unknown>): Promise<string | null> {
    switch (command) {
      case 'turnOn':
        return '/keypress/PowerOn'
      case 'turnOff':
        return '/keypress/PowerOff'
      case 'toggle':
        return '/keypress/Power'
      case 'play':
      case 'pause':
        return '/keypress/Play'
      case 'stopPlayback':
        return '/keypress/Home'
      case 'next':
        return '/keypress/Fwd'
      case 'previous':
        return '/keypress/Rev'
      case 'setMuted':
        return '/keypress/VolumeMute'
      case 'stepVolume': {
        const delta = Number(args.delta ?? 0)
        // ECP has no absolute volume; each press is roughly one step.
        return delta >= 0 ? '/keypress/VolumeUp' : '/keypress/VolumeDown'
      }
      case 'setVolume':
        // Honest failure beats pretending: absolute volume is not in the protocol.
        return null
      case 'setSource': {
        const apps = await this.#loadApps(nativeId)
        const wanted = String(args.source ?? '').toLowerCase()
        const app = apps.find((candidate) => candidate.name.toLowerCase() === wanted)
        return app ? `/launch/${app.id}` : null
      }
      case 'playMedia': {
        const apps = await this.#loadApps(nativeId)
        const wanted = String(args.query ?? '')
        const app = apps.find((candidate) => candidate.name.toLowerCase().includes(wanted.toLowerCase()))
        if (app) return `/launch/${app.id}`
        return `/search/browse?keyword=${encodeURIComponent(wanted)}&type=movie`
      }
      default:
        return null
    }
  }

  async #loadApps(ip: string): Promise<{ id: string; name: string }[]> {
    const cached = this.#apps.get(ip)
    if (cached) return cached
    const xml = await httpText(`http://${ip}:${ROKU_PORT}/query/apps`, 2500)
    if (!xml) return []
    const apps: { id: string; name: string }[] = []
    for (const match of xml.matchAll(/<app id="([^"]+)"[^>]*>([^<]+)<\/app>/gi)) {
      if (match[1] && match[2]) apps.push({ id: match[1], name: match[2].trim() })
    }
    this.#apps.set(ip, apps)
    return apps
  }
}

function undoFrom(command: string, before: Record<string, unknown>): { command: string; args: Record<string, unknown> } | null {
  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'toggle':
      return { command: before.on === true ? 'turnOn' : 'turnOff', args: {} }
    case 'setSource':
      return before.source ? { command: 'setSource', args: { source: before.source } } : null
    default:
      return null
  }
}
