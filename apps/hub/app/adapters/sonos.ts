/**
 * Sonos, locally, over UPnP on port 1400.
 *
 * No account and no cloud: every player answers SOAP on the LAN. Discovery probes hosts the
 * scan saw with port 1400 open (or a Sonos SSDP banner) and reads their description; the zone
 * topology then says which player coordinates which group.
 *
 * That topology matters for every transport command. A grouped member answers
 * GetTransportInfo with PLAYING whatever the group is doing and refuses Play or Pause with
 * UPnP error 800, so transport goes to the coordinator and volume to the speaker itself. The
 * topology is cached, and refreshed whenever a speaker answers 800 - the sign that someone
 * regrouped the speakers from their phone since the last look.
 *
 * Wire format and quirks live in `sonos_codec.ts`.
 */

import type { AdapterDescriptor, CapabilityId, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { PollingAdapter } from '#adapters/base'
import { soapEnvelope, soapFault, firstText } from '#adapters/soap_xml'
import {
  SONOS_PORT,
  SONOS_SERVICES,
  commandCalls,
  parseDescription,
  parseTime,
  parseTrack,
  parseZoneGroups,
  playbackFrom,
  zoneGroupStateFrom,
  type SonosCall,
  type SonosGroup,
  type SonosService,
} from '#adapters/sonos_codec'

export interface SonosOptions {
  /** Ports to probe; tests run several speakers on one host. */
  ports?: number[]
  timeoutMs?: number
}

const CAPABILITIES: CapabilityId[] = ['mediaPlayback', 'volume']

class SoapError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export class SonosAdapter extends PollingAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'sonos',
    name: 'Sonos',
    vendor: 'Sonos',
    transports: ['wifi', 'ethernet'],
    capabilities: CAPABILITIES,
    zeroConfig: true,
    cloud: false,
    implemented: true,
    docsUrl: 'https://sonos.svrooij.io/',
    configSchema: [{ key: 'pollIntervalMs', label: 'Intervalle de lecture (ms)', type: 'number', default: 10000 }],
  }

  readonly #ports: number[]
  readonly #timeoutMs: number
  /** uuid -> "ip:port" */
  #addresses = new Map<string, string>()
  #groups: SonosGroup[] = []

  constructor(options: SonosOptions = {}) {
    super()
    this.#ports = options.ports ?? [SONOS_PORT]
    this.#timeoutMs = options.timeoutMs ?? 3000
  }

  // -------------------------------------------------------------------------------------
  // SOAP
  // -------------------------------------------------------------------------------------

  async #soap(address: string, service: SonosService, action: string, args: Record<string, string | number>): Promise<string> {
    const { path, type } = SONOS_SERVICES[service]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await fetch(`http://${address}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${type}#${action}"` },
        body: soapEnvelope(type, action, args),
        signal: controller.signal,
      })
      const text = await response.text()
      const fault = soapFault(text)
      if (fault) throw new SoapError(fault.code, `Sonos a refusé ${action} (erreur UPnP ${fault.code})`)
      if (!response.ok) throw new SoapError(String(response.status), `Sonos a répondu ${response.status} à ${action}`)
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  async #refreshTopology(): Promise<void> {
    for (const address of new Set(this.#addresses.values())) {
      try {
        const answer = await this.#soap(address, 'ZoneGroupTopology', 'GetZoneGroupState', {})
        this.#groups = parseZoneGroups(zoneGroupStateFrom(answer))
        for (const member of this.#groups.flatMap((group) => group.members)) {
          if (member.address && this.#addresses.has(member.uuid)) this.#addresses.set(member.uuid, member.address)
        }
        return
      } catch {
        // Ask the next speaker: any of them knows the whole household.
      }
    }
  }

  /** Where transport commands for this speaker go: its group's coordinator, if known. */
  #coordinatorOf(uuid: string): string {
    const group = this.#groups.find((candidate) => candidate.members.some((member) => member.uuid === uuid))
    const coordinator = group?.coordinator
    return (coordinator && this.#addresses.get(coordinator)) ?? this.#addresses.get(uuid)!
  }

  // -------------------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------------------

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    const candidates = hosts.flatMap((host) => {
      const sonosBanner = host.ssdp ? /sonos/i.test(`${host.ssdp.server ?? ''} ${host.ssdp.modelName ?? ''}`) : false
      const ports = this.#ports.filter((port) => host.openPorts?.includes(port) || (sonosBanner && port === SONOS_PORT))
      return ports.map((port) => ({ host, address: `${host.ip}:${port}` }))
    })

    const found: DiscoveredDevice[] = []
    for (const { host, address } of candidates) {
      const xml = await this.#get(`http://${address}/xml/device_description.xml`)
      const description = xml ? parseDescription(xml) : null
      if (!description?.player) continue
      this.#addresses.set(description.uuid, address)
      this.devices.set(description.uuid, { ip: host.ip, meta: { address } })
      found.push({
        adapterId: 'sonos',
        nativeId: description.uuid,
        uid: `sonos:${description.uuid}`,
        name: description.room,
        category: 'speaker',
        capabilities: CAPABILITIES,
        transport: 'wifi',
        manufacturer: 'Sonos',
        model: description.model,
        firmwareVersion: description.firmware,
        serialNumber: description.serial,
        confidence: 0.98,
        network: { ip: host.ip, mac: host.mac ?? null, hostname: host.hostname ?? null },
        meta: { address, modelNumber: description.modelNumber },
      })
    }

    if (found.length === 0) return found
    await this.#refreshTopology()
    // Bonded surrounds and subs are part of a room, not speakers of their own.
    const hidden = new Set(this.#groups.flatMap((group) => group.members.filter((member) => member.invisible).map((member) => member.uuid)))
    return found.filter((device) => !hidden.has(device.nativeId))
  }

  async #get(url: string): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal })
      return response.ok ? await response.text() : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // -------------------------------------------------------------------------------------
  // State and commands
  // -------------------------------------------------------------------------------------

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const own = this.#addresses.get(nativeId)
    if (!own) return {}
    if (this.#groups.length === 0) await this.#refreshTopology()
    const coordinator = this.#coordinatorOf(nativeId)

    const [transport, position, volume, mute] = await Promise.all([
      this.#soap(coordinator, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 }),
      this.#soap(coordinator, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 }),
      this.#soap(own, 'RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' }),
      this.#soap(own, 'RenderingControl', 'GetMute', { InstanceID: 0, Channel: 'Master' }),
    ])

    const track = parseTrack(firstText(position, 'TrackMetaData') ?? '', coordinator)
    return {
      playback: playbackFrom(firstText(transport, 'CurrentTransportState')),
      volume: Number(firstText(volume, 'CurrentVolume') ?? 0),
      muted: firstText(mute, 'CurrentMute') === '1',
      ...track,
      positionSeconds: parseTime(firstText(position, 'RelTime')),
      durationSeconds: parseTime(firstText(position, 'TrackDuration')),
    }
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const own = this.#addresses.get(nativeId)
    if (!own) return this.fail(nativeId, command, 'Enceinte Sonos inconnue.')
    const calls = commandCalls(command, args)
    if (!calls) return this.fail(nativeId, command, `Une enceinte Sonos ne sait pas faire « ${command} ».`)

    try {
      for (const call of calls) await this.#call(nativeId, call)
      return this.ok(nativeId, command)
    } catch (error) {
      return this.fail(nativeId, command, (error as Error).message)
    }
  }

  async #call(uuid: string, call: SonosCall): Promise<void> {
    if (call.scope === 'player') {
      await this.#soap(this.#addresses.get(uuid)!, call.service, call.action, call.args)
      return
    }
    if (this.#groups.length === 0) await this.#refreshTopology()
    try {
      await this.#soap(this.#coordinatorOf(uuid), call.service, call.action, call.args)
    } catch (error) {
      // 800: not the coordinator any more. The groups changed; look again, and retry once.
      if (!(error instanceof SoapError) || error.code !== '800') throw error
      await this.#refreshTopology()
      await this.#soap(this.#coordinatorOf(uuid), call.service, call.action, call.args)
    }
  }

  override async shutdown(): Promise<void> {
    this.#addresses.clear()
    this.#groups = []
    await super.shutdown()
  }
}
