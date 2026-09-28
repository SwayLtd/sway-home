/**
 * The webOS adapter against a TV that speaks real SSAP over a real WebSocket.
 *
 * The fake TV behaves like the firmware: it prompts on screen for an unknown client and hands
 * back a key once accepted, answers a known key without a prompt, refuses everything but the
 * system info before registration, answers subscriptions again whenever something changes,
 * and closes its socket when turned off - after which only a Wake-on-LAN packet brings it back.
 *
 * What is pinned down is what a person would notice: the TV shows up after a scan, pairing is
 * one press on the remote and never again, the volume on the phone follows the remote, a
 * notification lands on screen, and "allume la télé" works on a TV that is fully off. The
 * fake TV serves TLS with a certificate of its own, like the real one on port 3001, and the
 * adapter reaches it through its real pinned socket.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Server, ServerWebSocket } from 'bun'
import type { NetworkHost } from '@sway-home/shared'
import { WebosAdapter, type WebosOptions } from '#adapters/webos'
import { URI } from '#adapters/webos_codec'
import { pinnedWebSocket } from '#adapters/pinned_websocket'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'
import { selfSignedCertificate, type SelfSigned } from './self_signed.ts'

interface Session {
  registered: boolean
  subscriptions: Map<string, string>
}

const INPUTS = [
  { id: 'HDMI_1', label: 'HDMI 1', appId: 'com.webos.app.hdmi1' },
  { id: 'HDMI_2', label: 'Console', appId: 'com.webos.app.hdmi2' },
]
const APPS = [
  { id: 'netflix', title: 'Netflix' },
  { id: 'youtube.leanback.v4', title: 'YouTube' },
  { id: 'com.webos.app.livetv', title: 'Live TV' },
]

class FakeTv {
  server: Server<Session> | null = null
  sockets = new Set<ServerWebSocket<Session>>()
  down = false
  /** The client key this TV remembers; null means it has never paired anyone. */
  key: string | null = 'key-abc'
  pairing: 'accept' | 'reject' | 'silent' = 'accept'
  prompts = 0
  power: string | null = 'Active'
  volume = 12
  muted = false
  appId = 'netflix'
  playState: string | null = 'playing'
  toasts: string[] = []
  calls: { uri: string; payload: Record<string, unknown> }[] = []
  failing = new Map<string, string>()
  /** HTTP upgrades and registrations received: what a client revealed to this TV. */
  upgrades = 0
  registrations = 0

  get port(): number {
    return this.server!.port!
  }

  /** With a certificate, TLS like port 3001; without, clear like port 3000 on older TVs. */
  start(certificate: SelfSigned | null): void {
    this.server = Bun.serve<Session>({
      port: 0,
      hostname: '127.0.0.1',
      ...(certificate ? { tls: { cert: certificate.cert, key: certificate.key } } : {}),
      fetch: (request, server) => {
        if (this.down) return new Response('asleep', { status: 503 })
        this.upgrades += 1
        if (server.upgrade(request, { data: { registered: false, subscriptions: new Map() } })) return undefined
        return new Response('webOS', { status: 400 })
      },
      websocket: {
        open: (ws) => void this.sockets.add(ws),
        close: (ws) => void this.sockets.delete(ws),
        message: (ws, raw) => this.#onMessage(ws, JSON.parse(String(raw))),
      },
    })
  }

  stop(): void {
    this.server?.stop(true)
  }

  /** Fully off: every socket closed, new ones refused. */
  sleep(): void {
    this.down = true
    for (const ws of this.sockets) ws.close(1001, 'standby')
    this.sockets.clear()
  }

  wake(): void {
    this.down = false
    this.power = 'Active'
  }

  /** Answer every subscription to this service again, as the TV does on a change. */
  push(uri: string): void {
    for (const ws of this.sockets) {
      for (const [id, subscribed] of ws.data.subscriptions) {
        if (subscribed === uri) ws.send(JSON.stringify(this.#answer(id, uri, {})))
      }
    }
  }

  #send(ws: ServerWebSocket<Session>, message: unknown): void {
    ws.send(JSON.stringify(message))
  }

  #onMessage(ws: ServerWebSocket<Session>, message: { id: string; type: string; uri?: string; payload?: Record<string, unknown> }): void {
    if (message.type === 'register') return this.#register(ws, message.id, message.payload ?? {})
    const uri = (message.uri ?? '').replace(/^ssap:\/\//, '')
    const payload = message.payload ?? {}
    if (!ws.data.registered && uri !== URI.systemInfo) {
      return this.#send(ws, { type: 'error', id: message.id, error: '401 insufficient permissions', payload: {} })
    }
    this.calls.push({ uri, payload })
    if (message.type === 'subscribe') ws.data.subscriptions.set(message.id, uri)
    const failure = this.failing.get(uri)
    if (failure) return this.#send(ws, { type: 'error', id: message.id, error: failure, payload: {} })
    this.#send(ws, this.#answer(message.id, uri, payload))
    this.#effects(uri, payload)
  }

  #register(ws: ServerWebSocket<Session>, id: string, payload: Record<string, unknown>): void {
    this.registrations += 1
    if (this.key && payload['client-key'] === this.key) {
      ws.data.registered = true
      return this.#send(ws, { type: 'registered', id, payload: { 'client-key': this.key } })
    }
    this.prompts += 1
    this.#send(ws, { type: 'response', id, payload: { pairingType: 'PROMPT', returnValue: true } })
    if (this.pairing === 'silent') return
    setTimeout(() => {
      if (this.pairing === 'reject') return this.#send(ws, { type: 'error', id, error: '403 User rejected pairing', payload: {} })
      this.key = 'key-new'
      ws.data.registered = true
      this.#send(ws, { type: 'registered', id, payload: { 'client-key': this.key } })
    }, 40)
  }

  #answer(id: string, uri: string, payload: Record<string, unknown>): Record<string, unknown> {
    const ok = (body: Record<string, unknown>) => ({ type: 'response', id, payload: { returnValue: true, ...body } })
    switch (uri) {
      case URI.systemInfo:
        return ok({ modelName: 'OLED55C1PUB', serialNumber: 'SN-55C1' })
      case URI.softwareInfo:
        return { type: 'error', id, error: '401 insufficient permissions', payload: {} }
      case URI.powerState:
        return this.power === null ? { type: 'error', id, error: '404 no such service or method', payload: {} } : ok({ state: this.power, subscribed: true })
      case URI.volume:
        return ok({ volumeStatus: { volume: this.volume, muteStatus: this.muted } })
      case URI.audioStatus:
        return ok({ volume: this.volume, mute: this.muted })
      case URI.foregroundApp:
        return ok({ appId: this.appId })
      case URI.mediaForeground:
        return ok({ foregroundAppInfo: this.playState ? [{ appId: this.appId, playState: this.playState }] : [] })
      case URI.inputs:
        return ok({ devices: INPUTS })
      case URI.apps:
        return ok({ launchPoints: APPS })
      case 'system.notifications/createToast':
        this.toasts.push(String(payload.message))
        return ok({ toastId: String(this.toasts.length) })
      case 'audio/setVolume':
      case 'audio/setMute':
      case 'audio/volumeUp':
      case 'audio/volumeDown':
      case 'system/turnOff':
      case 'system/turnOn':
      case URI.screenOn:
      case 'media.controls/play':
      case 'media.controls/pause':
      case 'media.controls/stop':
      case 'media.controls/fastForward':
      case 'media.controls/rewind':
      case 'tv/channelUp':
      case 'tv/channelDown':
      case 'tv/switchInput':
      case 'com.webos.applicationManager/launch':
      case 'system.launcher/open':
        return ok({})
      default:
        return { type: 'error', id, error: '404 no such service or method', payload: {} }
    }
  }

  #effects(uri: string, payload: Record<string, unknown>): void {
    switch (uri) {
      case 'audio/setVolume':
        this.volume = Number(payload.volume)
        this.push(URI.volume)
        break
      case 'audio/setMute':
        this.muted = payload.mute === true
        this.push(URI.volume)
        break
      case 'system/turnOff':
        this.power = 'Active Standby'
        this.push(URI.powerState)
        setTimeout(() => this.sleep(), 30)
        break
      case 'system/turnOn':
      case URI.screenOn:
        this.power = 'Active'
        this.push(URI.powerState)
        break
      case 'media.controls/play':
      case 'media.controls/pause':
        this.playState = uri.endsWith('play') ? 'playing' : 'paused'
        this.push(URI.mediaForeground)
        break
      case 'tv/switchInput':
        this.appId = INPUTS.find((input) => input.id === payload.inputId)?.appId ?? this.appId
        this.push(URI.foregroundApp)
        break
      case 'com.webos.applicationManager/launch':
        this.appId = String(payload.id)
        this.push(URI.foregroundApp)
        break
      default:
        break
    }
  }
}

const MAC = 'a8:23:fe:01:02:03'
const TV_CERTIFICATE = selfSignedCertificate('LG webOS TV OLED55C1PUB')

function lgHost(patch: Partial<NetworkHost> = {}): NetworkHost {
  return {
    ip: '127.0.0.1',
    mac: 'A8:23:FE:01:02:03',
    macVendor: 'LG Electronics',
    hostname: 'LGwebOSTV',
    openPorts: [3000, 3001],
    mdnsServices: [],
    mdnsTxt: {},
    ssdp: { server: 'WebOS/4.1.0 UPnP/1.0', st: 'urn:lge-com:service:webos-second-screen:1', friendlyName: '[LG] webOS TV OLED55C1PUB', modelName: 'OLED55C1PUB' },
    httpBanner: null,
    httpTitle: null,
    rttMs: 1,
    firstSeenAt: '2026-09-26T10:00:00.000Z',
    lastSeenAt: '2026-09-26T10:00:00.000Z',
    source: ['arp', 'ssdp'],
    ...patch,
  }
}

let tv: FakeTv
let context: RecordingContext
let adapter: WebosAdapter
let wakes: { mac: string; targets: string[] }[]
let wakeBringsBack: boolean

function makeAdapter(extra: Partial<WebosOptions> = {}): WebosAdapter {
  return new WebosAdapter({
    ports: { ws: tv.port, wss: tv.port },
    wake: async (mac, targets) => {
      wakes.push({ mac, targets })
      if (wakeBringsBack) tv.wake()
    },
    requestTimeoutMs: 500,
    connectTimeoutMs: 500,
    promptTimeoutMs: 500,
    pairTimeoutMs: 1000,
    reconnectMs: 20,
    maxReconnectMs: 80,
    heartbeatMs: 60_000,
    wakeTimeoutMs: 800,
    ...extra,
  })
}

/** A TV this hub paired with before: its key and its certificate are in the adapter's store. */
function remembered(key = 'key-abc', patch: Record<string, unknown> = {}): void {
  context.memory.set('tvs', [
    { nativeId: MAC, ip: '127.0.0.1', mac: MAC, name: 'webOS TV OLED55C1PUB', model: 'OLED55C1PUB', key, secure: true, certificate: TV_CERTIFICATE.fingerprint, ...patch },
  ])
}

const stored = () => (context.memory.get('tvs') as { key: string | null; secure: boolean | null; certificate: string | null }[])[0]!

beforeEach(() => {
  tv = new FakeTv()
  tv.start(TV_CERTIFICATE)
  context = recordingContext()
  wakes = []
  wakeBringsBack = true
})

afterEach(async () => {
  await adapter?.shutdown()
  tv.stop()
})

describe('finding TVs', () => {
  test('an LG TV on the network, named after itself, waiting to be paired', async () => {
    adapter = makeAdapter()
    await adapter.init(context, {})
    const [found, ...rest] = await adapter.discover([lgHost()])
    expect(rest).toEqual([])
    expect(found).toMatchObject({
      adapterId: 'webos',
      nativeId: MAC,
      uid: `webos:${MAC}`,
      name: 'webOS TV OLED55C1PUB',
      category: 'display',
      manufacturer: 'LG',
      model: 'OLED55C1PUB',
      requiresPairing: { kind: 'button' },
    })
  })

  test('a development server on port 3000 is not a TV', async () => {
    adapter = makeAdapter()
    await adapter.init(context, {})
    expect(await adapter.discover([lgHost({ ip: '127.0.0.2', mac: '00:11:22:33:44:55', macVendor: 'Intel Corporate', hostname: 'laptop', openPorts: [3000], ssdp: null })])).toEqual([])
  })

  test('an LG network card with the TLS port, or the LGwebOSTV hostname, is enough', async () => {
    adapter = makeAdapter()
    await adapter.init(context, {})
    expect(await adapter.discover([lgHost({ ssdp: null, hostname: null, openPorts: [3001] })])).toHaveLength(1)
    expect(await adapter.discover([lgHost({ ssdp: null, macVendor: null, openPorts: [] })])).toHaveLength(1)
  })
})

describe('pairing', () => {
  test('the TV asks on screen; once accepted, the key is kept and the state flows', async () => {
    tv.key = null
    adapter = makeAdapter()
    await adapter.init(context, {})
    await adapter.discover([lgHost()])

    const result = await adapter.pair({})
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/Acceptez/)

    await eventually(() => (context.memory.get('tvs') as { key: string | null }[] | undefined)?.[0]?.key === 'key-new')
    await eventually(() => context.stateOf(MAC).source === 'Netflix')
    expect(context.stateOf(MAC)).toMatchObject({ on: true, volume: 12, muted: false, source: 'Netflix', playback: 'playing' })
    expect(context.stateOf(MAC).availableSources).toEqual(['HDMI 1', 'Console', 'Netflix', 'YouTube', 'Live TV'])
    expect(adapter.status().health).toBe('ok')
    expect(stored()).toMatchObject({ secure: true, certificate: TV_CERTIFICATE.fingerprint })
    expect((await adapter.discover([lgHost()]))[0]?.requiresPairing ?? null).toBeNull()
  })

  test('refused on the TV: nothing is kept, and the status says so', async () => {
    tv.key = null
    tv.pairing = 'reject'
    adapter = makeAdapter()
    await adapter.init(context, {})
    await adapter.discover([lgHost()])

    expect((await adapter.pair({})).ok).toBe(true)
    await eventually(() => /refus/i.test(adapter.status().message ?? ''))
    expect((context.memory.get('tvs') as { key: string | null }[])[0]?.key ?? null).toBeNull()
  })

  test('a TV that does not answer is reported, not waited on forever', async () => {
    tv.sleep()
    adapter = makeAdapter()
    await adapter.init(context, {})
    await adapter.discover([lgHost()])
    const result = await adapter.pair({})
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/allumez/i)
  })

  test('a known key reconnects at start-up without a prompt', async () => {
    remembered()
    adapter = makeAdapter()
    await adapter.init(context, {})
    await eventually(() => context.stateOf(MAC).on === true)
    expect(tv.prompts).toBe(0)
  })
})

describe('live state', () => {
  test('volume, app and power changes arrive by themselves', async () => {
    remembered()
    adapter = makeAdapter()
    await adapter.init(context, {})
    await eventually(() => context.stateOf(MAC).source === 'Netflix')

    tv.volume = 20
    tv.push(URI.volume)
    await eventually(() => context.stateOf(MAC).volume === 20)

    tv.appId = 'com.webos.app.hdmi2'
    tv.push(URI.foregroundApp)
    await eventually(() => context.stateOf(MAC).source === 'Console')

    tv.power = 'Active Standby'
    tv.push(URI.powerState)
    await eventually(() => context.stateOf(MAC).on === false)
  })
})

describe('commands', () => {
  async function paired(): Promise<void> {
    remembered()
    adapter = makeAdapter()
    await adapter.init(context, {})
    await adapter.discover([lgHost()])
    await eventually(() => context.stateOf(MAC).source === 'Netflix')
  }

  test('volume, source and a notification on screen', async () => {
    await paired()
    expect((await adapter.execute(MAC, 'setVolume', { volume: 30 })).ok).toBe(true)
    expect(tv.volume).toBe(30)

    expect((await adapter.execute(MAC, 'setSource', { source: 'console' })).ok).toBe(true)
    expect(tv.calls.find((call) => call.uri === 'tv/switchInput')?.payload).toEqual({ inputId: 'HDMI_2' })
    await eventually(() => context.stateOf(MAC).source === 'Console')

    expect((await adapter.execute(MAC, 'notify', { message: 'Le linge est prêt', title: 'Lave-linge' })).ok).toBe(true)
    expect(tv.toasts).toEqual(['Lave-linge : Le linge est prêt'])
  })

  test('turned off, then back on from fully off with a Wake-on-LAN packet', async () => {
    await paired()
    expect((await adapter.execute(MAC, 'turnOff', {})).ok).toBe(true)
    // Fully off: the TV has closed its socket, not only reported standby.
    await eventually(() => tv.down && context.stateOf(MAC).on === false)

    const result = await adapter.execute(MAC, 'turnOn', {})
    expect(result.ok).toBe(true)
    expect(wakes[0]?.mac).toBe(MAC)
    expect(wakes[0]?.targets).toEqual(expect.arrayContaining(['192.168.1.255', '127.0.0.1']))
    await eventually(() => context.stateOf(MAC).on === true)
  })

  test('a TV that stays asleep says which setting to turn on', async () => {
    await paired()
    await adapter.execute(MAC, 'turnOff', {})
    await eventually(() => tv.down && context.stateOf(MAC).on === false)
    wakeBringsBack = false
    const result = await adapter.execute(MAC, 'turnOn', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Wi-Fi|Wake on LAN/)
  })

  test("the TV's own refusal is passed on", async () => {
    await paired()
    tv.failing.set('audio/setVolume', '401 insufficient permissions')
    const result = await adapter.execute(MAC, 'setVolume', { volume: 40 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('401')
  })

  test('an unknown TV, or one never paired, is refused before any request', async () => {
    adapter = makeAdapter()
    await adapter.init(context, {})
    expect((await adapter.execute('nope', 'turnOff', {})).ok).toBe(false)
    await adapter.discover([lgHost()])
    const result = await adapter.execute(MAC, 'setVolume', { volume: 10 })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/appair/i)
  })
})

describe('the connection', () => {
  test('TLS first: a TV that speaks it never sees its key in clear', async () => {
    remembered('key-abc', { secure: null, certificate: null })
    const tried: string[] = []
    adapter = makeAdapter({ connect: (url, trust) => (tried.push(url), pinnedWebSocket(url, { ...trust, timeoutMs: 500 })) })
    await adapter.init(context, {})
    await eventually(() => context.stateOf(MAC).on === true)
    expect(tried).toEqual([`wss://127.0.0.1:${tv.port}`])
    expect(stored()).toMatchObject({ secure: true, certificate: TV_CERTIFICATE.fingerprint })
  })

  test('an older TV without TLS still works on port 3000', async () => {
    tv.stop()
    tv = new FakeTv()
    tv.start(null)
    remembered('key-abc', { secure: null, certificate: null })
    adapter = makeAdapter()
    await adapter.init(context, {})
    await eventually(() => context.stateOf(MAC).on === true)
    expect(stored()).toMatchObject({ secure: false, certificate: null })
  })

  test('a TV once reached over TLS is never asked in clear again', async () => {
    tv.stop()
    tv = new FakeTv()
    tv.start(null)
    remembered()
    const tried: string[] = []
    adapter = makeAdapter({ connect: (url, trust) => (tried.push(url), pinnedWebSocket(url, { ...trust, timeoutMs: 500 })) })
    await adapter.init(context, {})
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(tried.length).toBeGreaterThan(0)
    expect(tried.every((url) => url.startsWith('wss://'))).toBe(true)
    expect(tv.registrations).toBe(0)
    expect(context.stateOf(MAC).on ?? false).toBe(false)
  })

  test("another certificate at the TV's address: the key stays here, and the status says why", async () => {
    remembered('key-abc', { certificate: 'ab'.repeat(32) })
    adapter = makeAdapter()
    await adapter.init(context, {})
    await eventually(() => /certificat/i.test(adapter.status().message ?? ''))
    expect(adapter.status().health).toBe('degraded')
    expect(tv.upgrades).toBe(0)
    expect(tv.registrations).toBe(0)

    // Someone in front of the TV pairs again: the certificate it shows now is kept.
    tv.key = null
    expect((await adapter.pair({})).ok).toBe(true)
    await eventually(() => stored().key === 'key-new')
    expect(stored().certificate).toBe(TV_CERTIFICATE.fingerprint)
    expect(adapter.status().health).toBe('ok')
  })
})
