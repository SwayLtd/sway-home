/**
 * The Sonos adapter against speakers that answer real SOAP over HTTP.
 *
 * Each fake speaker is its own HTTP server with the three control endpoints and a device
 * description. They behave like a household: a grouped member reports PLAYING whatever the
 * group does and refuses transport with UPnP error 800, the topology lists who coordinates,
 * and volume is per speaker. What is pinned down is what a person would notice: pause on the
 * kitchen pauses the group it is in, the kitchen volume moves only the kitchen, and a speaker
 * that stops answering goes offline instead of hanging.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Server } from 'bun'
import type { NetworkHost } from '@sway-home/shared'
import { SonosAdapter } from '#adapters/sonos'
import { encodeXml } from '#adapters/soap_xml'
import { recordingContext } from './adapter_harness.ts'

interface Household {
  speakers: FakeSpeaker[]
  groups: { coordinator: string; members: string[] }[]
}

class FakeSpeaker {
  volume = 20
  muted = false
  transport = 'PAUSED_PLAYBACK'
  uri = ''
  position = '0:01:05'
  calls: { service: string; action: string; body: string }[] = []
  down = false
  server: Server<undefined> | null = null

  constructor(
    readonly uuid: string,
    readonly room: string,
    readonly household: Household,
    readonly model = 'Sonos One'
  ) {}

  get address(): string {
    return `127.0.0.1:${this.server!.port}`
  }

  #coordinator(): boolean {
    return this.household.groups.some((group) => group.coordinator === this.uuid)
  }

  start(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        if (this.down) return new Response('down', { status: 503 })
        const url = new URL(request.url)
        if (url.pathname === '/xml/device_description.xml') return new Response(this.#description(), { headers: { 'content-type': 'text/xml' } })
        const soapAction = (request.headers.get('soapaction') ?? '').replace(/"/g, '')
        const [serviceType, action] = soapAction.split('#')
        const body = await request.text()
        const service = serviceType?.split(':')[3] ?? ''
        this.calls.push({ service, action: action ?? '', body })
        return this.#answer(service, action ?? '', body)
      },
    })
    return this.server.port!
  }

  #description(): string {
    const renderer = this.model.includes('Boost') ? '' : '<deviceList><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType></service></serviceList></device></deviceList>'
    return `<?xml version="1.0"?><root><device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><modelName>${this.model}</modelName><modelNumber>S18</modelNumber><softwareVersion>80.1</softwareVersion><serialNum>SN-${this.uuid}</serialNum><UDN>uuid:${this.uuid}</UDN><roomName>${this.room}</roomName>${renderer}</device></root>`
  }

  #answer(service: string, action: string, body: string): Response {
    const ok = (inner = '') =>
      new Response(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${inner}</u:${action}Response></s:Body></s:Envelope>`, {
        headers: { 'content-type': 'text/xml' },
      })
    const fault = (code: number) =>
      new Response(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>`, {
        status: 500,
        headers: { 'content-type': 'text/xml' },
      })
    const arg = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? ''

    if (service === 'ZoneGroupTopology' && action === 'GetZoneGroupState') {
      const groups = this.household.groups
        .map((group) => `<ZoneGroup Coordinator="${group.coordinator}" ID="${group.coordinator}:1">${group.members
          .map((uuid) => {
            const speaker = this.household.speakers.find((candidate) => candidate.uuid === uuid)!
            return `<ZoneGroupMember UUID="${uuid}" Location="http://${speaker.address}/xml/device_description.xml" ZoneName="${speaker.room}"/>`
          })
          .join('')}</ZoneGroup>`)
        .join('')
      return ok(`<ZoneGroupState>${encodeXml(`<ZoneGroupState><ZoneGroups>${groups}</ZoneGroups></ZoneGroupState>`)}</ZoneGroupState>`)
    }

    if (service === 'AVTransport') {
      if (action === 'GetTransportInfo') return ok(`<CurrentTransportState>${this.#coordinator() ? this.transport : 'PLAYING'}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>`)
      if (action === 'GetPositionInfo') {
        const didl = encodeXml('<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item><dc:title>Clair de lune</dc:title><dc:creator>Debussy</dc:creator><upnp:album>Suite</upnp:album></item></DIDL-Lite>')
        return ok(`<Track>1</Track><TrackDuration>0:05:00</TrackDuration><TrackMetaData>${didl}</TrackMetaData><RelTime>${this.position}</RelTime>`)
      }
      if (!this.#coordinator()) return fault(800)
      if (action === 'Play') this.transport = 'PLAYING'
      if (action === 'Pause') this.transport = 'PAUSED_PLAYBACK'
      if (action === 'SetAVTransportURI') this.uri = arg('CurrentURI')
      return ok()
    }

    if (service === 'RenderingControl') {
      if (action === 'GetVolume') return ok(`<CurrentVolume>${this.volume}</CurrentVolume>`)
      if (action === 'GetMute') return ok(`<CurrentMute>${this.muted ? 1 : 0}</CurrentMute>`)
      if (action === 'SetVolume') this.volume = Number(arg('DesiredVolume'))
      if (action === 'SetRelativeVolume') this.volume = Math.max(0, Math.min(100, this.volume + Number(arg('Adjustment'))))
      if (action === 'SetMute') this.muted = arg('DesiredMute') === '1'
      return ok(action === 'SetRelativeVolume' ? `<NewVolume>${this.volume}</NewVolume>` : '')
    }
    return fault(401)
  }
}

let household: Household
let salon: FakeSpeaker
let cuisine: FakeSpeaker
let boost: FakeSpeaker
let adapter: SonosAdapter
let hosts: NetworkHost[]

beforeEach(async () => {
  household = { speakers: [], groups: [] }
  salon = new FakeSpeaker('RINCON_SALON01400', 'Salon', household)
  cuisine = new FakeSpeaker('RINCON_CUISINE01400', 'Cuisine', household)
  boost = new FakeSpeaker('RINCON_BOOST01400', 'Boost', household, 'Sonos Boost')
  household.speakers.push(salon, cuisine, boost)
  const ports = [salon.start(), cuisine.start(), boost.start()]
  // The kitchen is grouped with the living room, which coordinates.
  household.groups = [{ coordinator: salon.uuid, members: [salon.uuid, cuisine.uuid] }]
  hosts = [{ ip: '127.0.0.1', openPorts: ports, mdnsServices: [], mac: null } as unknown as NetworkHost]
  adapter = new SonosAdapter({ ports, timeoutMs: 1000 })
  await adapter.init(recordingContext(), { pollIntervalMs: 60_000 })
})

afterEach(async () => {
  await adapter.shutdown()
  for (const speaker of household.speakers) speaker.server?.stop(true)
})

describe('discovery', () => {
  test('finds the players named after their rooms, and leaves the Boost out', async () => {
    const found = await adapter.discover(hosts)
    expect(found.map((device) => device.name).sort()).toEqual(['Cuisine', 'Salon'])
    expect(found.find((device) => device.name === 'Salon')).toMatchObject({
      adapterId: 'sonos',
      nativeId: 'RINCON_SALON01400',
      uid: 'sonos:RINCON_SALON01400',
      category: 'speaker',
      capabilities: ['mediaPlayback', 'volume'],
      manufacturer: 'Sonos',
      model: 'Sonos One',
    })
  })
})

describe('state', () => {
  test("a grouped speaker reports the group's playback, not its own PLAYING, and its own volume", async () => {
    await adapter.discover(hosts)
    cuisine.volume = 35
    const state = await adapter.getState(cuisine.uuid)
    expect(state).toMatchObject({ playback: 'paused', volume: 35, muted: false, title: 'Clair de lune', artist: 'Debussy', album: 'Suite', positionSeconds: 65, durationSeconds: 300 })
  })

  test('a speaker that stops answering fails, so the poll can mark it offline', async () => {
    await adapter.discover(hosts)
    salon.down = true
    await expect(adapter.getState(salon.uuid)).rejects.toThrow()
  })
})

describe('commands', () => {
  test('play on a grouped speaker is sent to the coordinator', async () => {
    await adapter.discover(hosts)
    const result = await adapter.execute(cuisine.uuid, 'play', {})
    expect(result.ok).toBe(true)
    expect(salon.calls.some((call) => call.action === 'Play')).toBe(true)
    expect(cuisine.calls.some((call) => call.action === 'Play')).toBe(false)
    expect(salon.transport).toBe('PLAYING')
  })

  test('volume moves only the speaker asked for', async () => {
    await adapter.discover(hosts)
    expect((await adapter.execute(cuisine.uuid, 'setVolume', { volume: 42 })).ok).toBe(true)
    expect(cuisine.volume).toBe(42)
    expect(salon.volume).toBe(20)
    await adapter.execute(cuisine.uuid, 'stepVolume', { delta: -2 })
    expect(cuisine.volume).toBe(40)
  })

  test('a URL is loaded and played on the group', async () => {
    await adapter.discover(hosts)
    await adapter.execute(cuisine.uuid, 'playMedia', { query: 'http://radio.example/fip.mp3', kind: 'url' })
    expect(salon.uri).toBe('http://radio.example/fip.mp3')
    expect(salon.transport).toBe('PLAYING')
  })

  test('after an ungroup the speaker is its own coordinator: error 800 refreshes the topology and retries', async () => {
    await adapter.discover(hosts)
    await adapter.getState(cuisine.uuid)
    // Behind the adapter's back, the living room joins the kitchen's group: the cached
    // topology still says "the salon coordinates", and the salon now refuses with 800.
    household.groups = [{ coordinator: cuisine.uuid, members: [cuisine.uuid, salon.uuid] }]
    const result = await adapter.execute(cuisine.uuid, 'pause', {})
    expect(result.ok).toBe(true)
    expect(cuisine.calls.some((call) => call.action === 'Pause')).toBe(true)
  })

  test("a refused action fails with the speaker's error", async () => {
    await adapter.discover(hosts)
    household.groups = [{ coordinator: 'RINCON_ELSEWHERE', members: [salon.uuid, cuisine.uuid] }]
    const result = await adapter.execute(salon.uuid, 'next', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/800/)
  })

  test('what a speaker cannot do is refused before any request', async () => {
    await adapter.discover(hosts)
    const before = salon.calls.length
    expect((await adapter.execute(salon.uuid, 'turnOn', {})).ok).toBe(false)
    expect(salon.calls.length).toBe(before)
  })
})
