/**
 * ESPHome, over its built-in web server.
 *
 * ESPHome's first-class API is a protobuf stream with an optional Noise handshake. It is
 * excellent and it is also a large amount of code for what this adapter needs. Every
 * ESPHome build that enables `web_server:` also exposes a REST surface plus a
 * server-sent-events stream at `/events`, which gives the same entities, the same state,
 * and push updates with no encoding work at all.
 *
 * So: SSE for state, REST for commands, and a note in the integrations screen that a device
 * with `web_server` turned off needs the native API adapter, which is on the roadmap.
 */

import type { AdapterDescriptor, CapabilityId, CommandResult, DeviceCategory, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { PollingAdapter, httpJson, httpText, mapLimit } from '#adapters/base'

interface EsphomeEntity {
  id: string
  name: string
  state?: string
  value?: number | boolean | string
  brightness?: number
  color_temp?: number
  /** `light-salon`, `switch-relay`, `sensor-temperature`, ... */
  domain: string
  objectId: string
}

function parseEntityId(id: string): { domain: string; objectId: string } {
  const index = id.indexOf('-')
  if (index === -1) return { domain: 'unknown', objectId: id }
  return { domain: id.slice(0, index), objectId: id.slice(index + 1) }
}

export class EsphomeAdapter extends PollingAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'esphome',
    name: 'ESPHome',
    vendor: 'ESPHome (Open Home Foundation)',
    transports: ['wifi', 'ethernet'],
    capabilities: ['onoff', 'brightness', 'colorTemperature', 'color', 'temperature', 'humidity', 'pressure', 'illuminance', 'motion', 'contact', 'power', 'energy', 'position', 'button', 'connectivity', 'firmware'],
    zeroConfig: true,
    cloud: false,
    implemented: true,
    requiresHardware: null,
    docsUrl: 'https://esphome.io/web-api/',
    configSchema: [
      { key: 'pollIntervalMs', label: 'Poll interval (ms)', type: 'number', default: 10000, help: 'Only a fallback: state arrives over the event stream.' },
    ],
  }

  protected override pollIntervalMs = 10_000
  #entities = new Map<string, Map<string, EsphomeEntity>>()
  #streams = new Map<string, AbortController>()

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    const candidates = hosts.filter(
      (host) =>
        host.mdnsServices.some((service) => service.includes('_esphomelib')) ||
        /esphome/i.test(`${host.httpTitle} ${host.httpBanner}`) ||
        host.openPorts.includes(6053)
    )

    const found = await mapLimit<NetworkHost, DiscoveredDevice | null>(candidates, 8, async (host) => {
      const page = await httpText(`http://${host.ip}/`, 2500)
      // The web server always renders a title with the node name and an `esp-app` element.
      if (!page || !/esp-app|ESPHome/i.test(page)) return null

      const name = /<title>([^<]+)<\/title>/i.exec(page)?.[1]?.trim() ?? host.hostname ?? `ESPHome ${host.ip}`
      const version = host.mdnsTxt.version ?? host.mdnsTxt.esphome_version ?? null
      const mac = host.mdnsTxt.mac ?? host.mac ?? null

      const entities = await this.#readEntities(host.ip)
      this.#entities.set(host.ip, entities)
      this.devices.set(host.ip, { ip: host.ip, meta: {} })
      void this.#openStream(host.ip)

      const { category, capabilities } = classify(entities)

      return {
        adapterId: 'esphome',
        nativeId: host.ip,
        uid: `esphome:${(mac ?? host.ip).toLowerCase().replace(/:/g, '')}`,
        name: name.replace(/\s*-\s*ESPHome.*$/i, ''),
        category,
        capabilities,
        transport: 'wifi',
        manufacturer: 'ESPHome',
        model: host.mdnsTxt.project_name ?? 'ESPHome node',
        firmwareVersion: version,
        serialNumber: mac,
        confidence: 0.93,
        network: { ip: host.ip, mac, hostname: host.hostname },
        meta: { entities: [...entities.keys()] },
      }
    })

    return found.filter((device): device is DiscoveredDevice => device !== null)
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const entities = this.#entities.get(nativeId) ?? (await this.#readEntities(nativeId))
    this.#entities.set(nativeId, entities)
    return entitiesToState(entities)
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const entities = this.#entities.get(nativeId) ?? (await this.#readEntities(nativeId))
    const before = entitiesToState(entities)

    const light = [...entities.values()].find((entity) => entity.domain === 'light')
    const relay = [...entities.values()].find((entity) => entity.domain === 'switch' || entity.domain === 'fan')
    const cover = [...entities.values()].find((entity) => entity.domain === 'cover')
    const target = light ?? relay ?? cover
    if (!target) return this.fail(nativeId, command, 'This ESPHome node has nothing controllable')

    const path = buildPath(target, command, args, before)
    if (!path) return this.fail(nativeId, command, `ESPHome does not support ${command} here`)

    const response = await fetch(`http://${nativeId}${path}`, { method: 'POST' }).catch(() => null)
    if (!response || !response.ok) return this.fail(nativeId, command, 'Node did not answer')

    const after = await this.getState(nativeId)
    return this.ok(nativeId, command, after, undoFrom(command, before))
  }

  async #readEntities(ip: string): Promise<Map<string, EsphomeEntity>> {
    const entities = new Map<string, EsphomeEntity>()
    // `/events` is the authoritative list; one short listen collects the initial burst that
    // ESPHome sends on connect.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2500)
    try {
      const response = await fetch(`http://${ip}/events`, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
      if (!response.body) return entities
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const deadline = Date.now() + 2000

      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (const entity of parseSseEntities(buffer)) entities.set(entity.id, entity)
        if (buffer.length > 64_000) buffer = buffer.slice(-8000)
      }
      await reader.cancel().catch(() => undefined)
    } catch {
      // Fall back to the JSON endpoint some builds expose.
      const list = await httpJson<EsphomeEntity[]>(`http://${ip}/json`, { timeoutMs: 2000 })
      for (const entity of list ?? []) {
        const parsed = parseEntityId(entity.id)
        entities.set(entity.id, { ...entity, ...parsed })
      }
    } finally {
      clearTimeout(timer)
    }
    return entities
  }

  /** Keep the SSE stream open so state arrives without polling. */
  async #openStream(ip: string): Promise<void> {
    if (this.#streams.has(ip)) return
    const controller = new AbortController()
    this.#streams.set(ip, controller)

    void (async () => {
      try {
        const response = await fetch(`http://${ip}/events`, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
        if (!response.body) return
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lastBreak = buffer.lastIndexOf('\n\n')
          if (lastBreak === -1) continue
          const complete = buffer.slice(0, lastBreak)
          buffer = buffer.slice(lastBreak + 2)

          const entities = this.#entities.get(ip) ?? new Map<string, EsphomeEntity>()
          let changed = false
          for (const entity of parseSseEntities(complete)) {
            entities.set(entity.id, entity)
            changed = true
          }
          if (changed) {
            this.#entities.set(ip, entities)
            this.context?.emitState(ip, entitiesToState(entities))
            this.context?.emitAvailability(ip, true)
          }
        }
      } catch {
        this.context?.emitAvailability(ip, false)
      } finally {
        this.#streams.delete(ip)
        // Reconnect after a pause: an ESP that reboots comes back within seconds.
        setTimeout(() => void this.#openStream(ip), 10_000)
      }
    })()
  }

  override async shutdown(): Promise<void> {
    for (const controller of this.#streams.values()) controller.abort()
    this.#streams.clear()
    await super.shutdown()
  }
}

function parseSseEntities(chunk: string): EsphomeEntity[] {
  const out: EsphomeEntity[] = []
  for (const block of chunk.split('\n\n')) {
    const dataLine = block.split('\n').find((line) => line.startsWith('data:'))
    if (!dataLine) continue
    try {
      const parsed = JSON.parse(dataLine.slice(5).trim()) as EsphomeEntity
      if (!parsed?.id) continue
      out.push({ ...parsed, ...parseEntityId(parsed.id) })
    } catch {
      // A partial frame at the edge of the buffer; the next read completes it.
    }
  }
  return out
}

function entitiesToState(entities: Map<string, EsphomeEntity>): Record<string, unknown> {
  const state: Record<string, unknown> = {}

  for (const entity of entities.values()) {
    const value = entity.value ?? entity.state
    switch (entity.domain) {
      case 'light':
      case 'switch':
      case 'fan':
        state.on = value === true || value === 'ON' || value === 'on'
        if (typeof entity.brightness === 'number') state.brightness = Math.round((entity.brightness / 255) * 100)
        if (typeof entity.color_temp === 'number' && entity.color_temp > 0) state.colorTemperature = Math.round(1_000_000 / entity.color_temp)
        break
      case 'binary_sensor': {
        const on = value === true || value === 'ON'
        const name = entity.objectId.toLowerCase()
        if (/motion|pir|presence/.test(name)) state.motion = on
        else if (/door|window|contact/.test(name)) state.open = on
        else if (/leak|water/.test(name)) state.leak = on
        else if (/smoke/.test(name)) state.smoke = on
        break
      }
      case 'sensor': {
        const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value))
        if (!Number.isFinite(numeric)) break
        const name = entity.objectId.toLowerCase()
        if (/temp/.test(name)) state.temperature = numeric
        else if (/humid/.test(name)) state.humidity = numeric
        else if (/pressure/.test(name)) state.pressure = numeric
        else if (/lux|illumin/.test(name)) state.illuminance = numeric
        else if (/power|watt/.test(name)) state.power = numeric
        else if (/energy|kwh/.test(name)) state.energyTotal = numeric
        else if (/battery/.test(name)) state.battery = numeric
        else if (/rssi|signal/.test(name)) state.rssi = numeric
        else if (/co2/.test(name)) state.co2 = numeric
        else if (/pm.?2/.test(name)) state.pm25 = numeric
        break
      }
      case 'cover':
        if (typeof value === 'number') state.position = Math.round(value * 100)
        break
      default:
        break
    }
  }

  return state
}

function classify(entities: Map<string, EsphomeEntity>): { category: DeviceCategory; capabilities: CapabilityId[] } {
  const domains = new Set([...entities.values()].map((entity) => entity.domain))
  const names = [...entities.values()].map((entity) => entity.objectId.toLowerCase()).join(' ')
  const capabilities: CapabilityId[] = ['connectivity']

  if (domains.has('light')) capabilities.push('onoff', 'brightness', 'colorTemperature')
  if (domains.has('switch') || domains.has('fan')) capabilities.push('onoff')
  if (domains.has('cover')) capabilities.push('position')
  if (/temp/.test(names)) capabilities.push('temperature')
  if (/humid/.test(names)) capabilities.push('humidity')
  if (/pressure/.test(names)) capabilities.push('pressure')
  if (/lux|illumin/.test(names)) capabilities.push('illuminance')
  if (/motion|pir|presence/.test(names)) capabilities.push('motion')
  if (/door|window|contact/.test(names)) capabilities.push('contact')
  if (/power|watt/.test(names)) capabilities.push('power')
  if (/energy|kwh/.test(names)) capabilities.push('energy')

  const category: DeviceCategory = domains.has('light')
    ? 'light'
    : domains.has('cover')
      ? 'cover'
      : domains.has('switch')
        ? 'switch'
        : 'sensor'

  return { category, capabilities: [...new Set(capabilities)] }
}

function buildPath(entity: EsphomeEntity, command: string, args: Record<string, unknown>, before: Record<string, unknown>): string | null {
  const base = `/${entity.domain}/${entity.objectId}`
  switch (command) {
    case 'turnOn':
      return `${base}/turn_on`
    case 'turnOff':
      return `${base}/turn_off`
    case 'toggle':
      return `${base}/toggle`
    case 'setBrightness':
      return `${base}/turn_on?brightness=${Math.round((Number(args.brightness ?? 0) / 100) * 255)}`
    case 'stepBrightness': {
      const next = Math.min(100, Math.max(0, Number(before.brightness ?? 0) + Number(args.delta ?? 0)))
      return `${base}/turn_on?brightness=${Math.round((next / 100) * 255)}`
    }
    case 'setColorTemperature':
      return `${base}/turn_on?color_temp=${Math.round(1_000_000 / Number(args.kelvin ?? 3000))}`
    case 'setPosition':
      return `${base}/set?position=${Number(args.position ?? 0) / 100}`
    case 'open':
      return `${base}/open`
    case 'close':
      return `${base}/close`
    case 'stop':
      return `${base}/stop`
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
    case 'setPosition':
    case 'open':
    case 'close':
      return { command: 'setPosition', args: { position: Number(before.position ?? 0) } }
    default:
      return null
  }
}
