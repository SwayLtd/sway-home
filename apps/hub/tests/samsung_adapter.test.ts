/**
 * The Samsung adapter against a TV that answers on its three doors.
 *
 * The fake TV serves the remote channel over TLS with a certificate of its own (port 8002),
 * the device description on `/api/v2/` and the UPnP renderer, in clear (8001 and 9197). It
 * asks "Autoriser ?" for an unknown client and hands a token once allowed, applies the keys it
 * receives, and goes to standby on the power key - after which the channel and the renderer
 * stop answering and only a Wake-on-LAN packet brings it back.
 *
 * What is pinned down is what a person notices: the TV shows up after a scan, pairing is one
 * press on the remote, "mets le son à 30" is exact, "éteins la télé" shows off at once, and
 * "allume la télé" works on a TV in standby.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { NetworkHost } from '@sway-home/shared'
import { SamsungAdapter, type SamsungOptions } from '#adapters/samsung'
import { pinnedWebSocket } from '#adapters/pinned_websocket'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'
import { selfSignedCertificate } from './self_signed.ts'

const MAC = 'f4:7b:09:aa:bb:cc'
const TV_CERTIFICATE = selfSignedCertificate('Samsung Q80 Series (55)')

const APPS = [
  { appId: '111299001912', app_type: 2, name: 'YouTube' },
  { appId: '3201907018807', app_type: 2, name: 'Netflix' },
  { appId: 'org.tizen.browser', app_type: 4, name: 'Internet' },
]

interface Remote {
  token: string | null
}

class FakeSamsungTv {
  remote: ReturnType<typeof Bun.serve<Remote>> | null = null
  api: ReturnType<typeof Bun.serve> | null = null
  sockets = new Set<ServerWebSocket<Remote>>()
  /** 'off': nothing answers; 'standby': only the description answers. */
  power: 'on' | 'standby' | 'off' = 'on'
  token: string | null = 'tok-abc'
  frame = false
  pairing: 'accept' | 'instant' | 'reject' | 'silent' = 'accept'
  prompts = 0
  /** Every connection to the remote channel, with the name and token it revealed. */
  connections: { name: string; token: string | null }[] = []
  keys: { cmd: string; key: string }[] = []
  launched: { appId: string; action_type: string; metaTag: string }[] = []
  volume = 12
  muted = false
  rendererAllowed = true
  apiRequests = 0
  /** How long the TV keeps saying "on" after the power key, as it finishes turning off. */
  standbyDelayMs = 0

  start(): void {
    this.remote = Bun.serve<Remote>({
      port: 0,
      hostname: '127.0.0.1',
      tls: { cert: TV_CERTIFICATE.cert, key: TV_CERTIFICATE.key },
      fetch: (request, server) => {
        if (this.power !== 'on') return new Response('standby', { status: 503 })
        const url = new URL(request.url)
        const token = url.searchParams.get('token')
        this.connections.push({ name: Buffer.from(url.searchParams.get('name') ?? '', 'base64').toString('utf8'), token })
        return server.upgrade(request, { data: { token } }) ? undefined : new Response('no', { status: 400 })
      },
      websocket: {
        open: (ws) => this.#open(ws),
        close: (ws) => void this.sockets.delete(ws),
        message: (ws, raw) => this.#message(ws, JSON.parse(String(raw))),
      },
    })
    this.api = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        this.apiRequests += 1
        const url = new URL(request.url)
        if (this.power === 'off') return new Response('off', { status: 503 })
        if (url.pathname === '/api/v2/') return Response.json(this.#info())
        if (url.pathname === '/upnp/control/RenderingControl1') return this.#renderer(request.headers.get('soapaction') ?? '', await request.text())
        return new Response('not found', { status: 404 })
      },
    })
  }

  stop(): void {
    this.remote?.stop(true)
    this.api?.stop(true)
  }

  get ports() {
    return { ws: this.api!.port!, wss: this.remote!.port!, api: this.api!.port!, renderer: this.api!.port! }
  }

  wake(): void {
    this.power = 'on'
  }

  #info() {
    return {
      device: {
        FrameTVSupport: String(this.frame),
        OS: 'Tizen',
        PowerState: this.power === 'on' ? 'on' : 'standby',
        TokenAuthSupport: 'true',
        modelName: 'QE55Q80TATXXC',
        name: '[TV] Samsung Q80 Series (55)',
        type: 'Samsung SmartTV',
        wifiMac: MAC.toUpperCase(),
      },
      name: '[TV] Samsung Q80 Series (55)',
      type: 'Samsung SmartTV',
    }
  }

  #renderer(action: string, body: string): Response {
    if (this.power !== 'on') return new Response('standby', { status: 503 })
    const soap = (inner: string) =>
      new Response(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`, {
        headers: { 'content-type': 'text/xml' },
      })
    if (!this.rendererAllowed) {
      return new Response(
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>401</errorCode><errorDescription>Unauthorized</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>',
        { status: 500 }
      )
    }
    const name = action.replace(/"/g, '').split('#')[1]
    const argument = (tag: string) => body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]
    const ns = 'xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"'
    switch (name) {
      case 'GetVolume':
        return soap(`<u:GetVolumeResponse ${ns}><CurrentVolume>${this.volume}</CurrentVolume></u:GetVolumeResponse>`)
      case 'GetMute':
        return soap(`<u:GetMuteResponse ${ns}><CurrentMute>${this.muted ? 1 : 0}</CurrentMute></u:GetMuteResponse>`)
      case 'SetVolume':
        this.volume = Number(argument('DesiredVolume'))
        return soap(`<u:SetVolumeResponse ${ns}></u:SetVolumeResponse>`)
      case 'SetMute':
        this.muted = argument('DesiredMute') === '1'
        return soap(`<u:SetMuteResponse ${ns}></u:SetMuteResponse>`)
      default:
        return new Response('unknown action', { status: 500 })
    }
  }

  #send(ws: ServerWebSocket<Remote>, message: unknown): void {
    ws.send(JSON.stringify(message))
  }

  #open(ws: ServerWebSocket<Remote>): void {
    this.sockets.add(ws)
    if (this.token && ws.data.token === this.token) return this.#send(ws, { event: 'ms.channel.connect', data: { token: this.token, clients: [] } })
    this.prompts += 1
    const answer = () => {
      if (this.pairing === 'reject') {
        this.#send(ws, { event: 'ms.channel.unauthorized' })
        return ws.close()
      }
      this.token = 'tok-new'
      this.#send(ws, { event: 'ms.channel.connect', data: { token: this.token, clients: [] } })
    }
    if (this.pairing === 'instant') return answer()
    if (this.pairing !== 'silent') setTimeout(answer, 40)
  }

  #message(ws: ServerWebSocket<Remote>, message: { method: string; params: Record<string, unknown> }): void {
    if (message.method === 'ms.remote.control') {
      const cmd = String(message.params.Cmd)
      const key = String(message.params.DataOfCmd)
      this.keys.push({ cmd, key })
      if (cmd === 'Press') return
      this.#press(key, cmd)
      return
    }
    if (message.method === 'ms.channel.emit') {
      const event = message.params.event
      if (event === 'ed.installedApp.get') return this.#send(ws, { event: 'ed.installedApp.get', from: 'host', data: { data: APPS } })
      if (event === 'ed.apps.launch') this.launched.push(message.params.data as FakeSamsungTv['launched'][number])
    }
  }

  #press(key: string, cmd: string): void {
    switch (key) {
      case 'KEY_POWER':
        // A click on a Frame TV only switches to art mode; the key held turns it off.
        if (this.frame && cmd === 'Click') return
        setTimeout(() => {
          this.power = 'standby'
          for (const ws of this.sockets) ws.close(1001, 'standby')
          this.sockets.clear()
        }, this.standbyDelayMs)
        return
      case 'KEY_VOLUP':
        this.volume += 1
        return
      case 'KEY_VOLDOWN':
        this.volume -= 1
        return
      case 'KEY_MUTE':
        this.muted = !this.muted
        return
      default:
        return
    }
  }
}

function samsungHost(patch: Partial<NetworkHost> = {}): NetworkHost {
  return {
    ip: '127.0.0.1',
    mac: 'F4:7B:09:AA:BB:CC',
    macVendor: 'Samsung Electronics Co.,Ltd',
    hostname: null,
    openPorts: [8001, 8002, 9197],
    mdnsServices: [],
    mdnsTxt: {},
    ssdp: { server: 'SHP, UPnP/1.0, Samsung UPnP SDK/1.0', st: 'urn:samsung.com:device:RemoteControlReceiver:1', friendlyName: '[TV] Samsung Q80 Series (55)', modelName: 'QE55Q80TATXXC' },
    httpBanner: null,
    httpTitle: null,
    rttMs: 1,
    firstSeenAt: '2026-09-26T10:00:00.000Z',
    lastSeenAt: '2026-09-26T10:00:00.000Z',
    source: ['arp', 'ssdp'],
    ...patch,
  }
}

let tv: FakeSamsungTv
let context: RecordingContext
let adapter: SamsungAdapter
let wakes: { mac: string; targets: string[] }[]
let wakeBringsBack: boolean

function makeAdapter(extra: Partial<SamsungOptions> = {}): SamsungAdapter {
  return new SamsungAdapter({
    ports: tv.ports,
    wake: async (mac, targets) => {
      wakes.push({ mac, targets })
      if (wakeBringsBack) tv.wake()
    },
    requestTimeoutMs: 500,
    connectTimeoutMs: 500,
    promptTimeoutMs: 20,
    pairTimeoutMs: 1000,
    pollMs: 30,
    offGraceMs: 400,
    wakeTimeoutMs: 800,
    keyDelayMs: 0,
    holdScale: 0.01,
    ...extra,
  })
}

/** A TV this hub paired with before: its token and certificate are in the adapter's store. */
function remembered(patch: Record<string, unknown> = {}): void {
  context.memory.set('tvs', [
    {
      nativeId: MAC,
      ip: '127.0.0.1',
      mac: MAC,
      name: 'Samsung Q80 Series (55)',
      model: 'QE55Q80TATXXC',
      paired: true,
      token: 'tok-abc',
      secure: true,
      certificate: TV_CERTIFICATE.fingerprint,
      frame: false,
      ...patch,
    },
  ])
}

const stored = () => (context.memory.get('tvs') as { token: string | null; paired: boolean; certificate: string | null; secure: boolean | null }[])[0]!

beforeEach(() => {
  tv = new FakeSamsungTv()
  tv.start()
  context = recordingContext()
  wakes = []
  wakeBringsBack = true
})

afterEach(async () => {
  await adapter?.shutdown()
  tv.stop()
})

describe('finding TVs', () => {
  test('a Samsung TV on the network, named after itself, waiting to be paired', async () => {
    adapter = makeAdapter()
    await adapter.init(context, {})
    const [found, ...rest] = await adapter.discover([samsungHost()])
    expect(rest).toEqual([])
    expect(found).toMatchObject({
      adapterId: 'samsungtv',
      nativeId: MAC,
      uid: `samsungtv:${MAC}`,
      name: 'Samsung Q80 Series (55)',
      category: 'display',
      manufacturer: 'Samsung',
      model: 'QE55Q80TATXXC',
      requiresPairing: { kind: 'button' },
    })
  })

  test('a Samsung phone is not a TV, and is not even asked', async () => {
    adapter = makeAdapter()
    await adapter.init(context, {})
    expect(await adapter.discover([samsungHost({ ip: '127.0.0.9', mac: '8c:77:12:00:00:01', openPorts: [], ssdp: null })])).toEqual([])
    expect(tv.apiRequests).toBe(0)
  })

  test('a TV fully off is still recognised by its UPnP description', async () => {
    tv.power = 'off'
    adapter = makeAdapter()
    await adapter.init(context, {})
    const [found] = await adapter.discover([samsungHost()])
    expect(found).toMatchObject({ nativeId: MAC, name: 'Samsung Q80 Series (55)' })
  })
})

describe('pairing', () => {
  test('the TV asks on screen; once allowed, the token is kept and the state flows', async () => {
    tv.token = null
    adapter = makeAdapter()
    await adapter.init(context, {})
    await adapter.discover([samsungHost()])

    const result = await adapter.pair({})
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/Acceptez/)
    expect(tv.connections[0]).toEqual({ name: 'Sway Home', token: null })

    await eventually(() => stored().token === 'tok-new')
    expect(stored()).toMatchObject({ paired: true, secure: true, certificate: TV_CERTIFICATE.fingerprint })
    await eventually(() => context.stateOf(MAC).volume === 12)
    expect(context.stateOf(MAC)).toMatchObject({ on: true, volume: 12, muted: false })
    await eventually(() => (context.stateOf(MAC).availableSources as string[] | undefined)?.includes('YouTube') === true)
    expect(adapter.status().health).toBe('ok')
    expect((await adapter.discover([samsungHost()]))[0]?.requiresPairing ?? null).toBeNull()
  })

  test('a TV set to allow without asking is paired straight away', async () => {
    tv.token = null
    tv.pairing = 'instant'
    adapter = makeAdapter()
    await adapter.init(context, {})
    await adapter.discover([samsungHost()])
    const result = await adapter.pair({})
    expect(result).toMatchObject({ ok: true })
    expect(result.message).toMatch(/appairé/)
    expect(stored().token).toBe('tok-new')
  })

  test('refused on the TV: nothing is kept, and the status says so', async () => {
    tv.token = null
    tv.pairing = 'reject'
    adapter = makeAdapter()
    await adapter.init(context, {})
    await adapter.discover([samsungHost()])
    await adapter.pair({})
    await eventually(() => /refus/i.test(adapter.status().message ?? ''))
    expect(stored().token).toBeNull()
    expect(stored().paired).toBe(false)
  })

  test('a TV that is off is reported, not waited on', async () => {
    tv.power = 'off'
    adapter = makeAdapter()
    await adapter.init(context, {})
    await adapter.discover([samsungHost()])
    const result = await adapter.pair({})
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/allumez/i)
  })
})

describe('state', () => {
  test('power and volume follow the TV', async () => {
    remembered()
    adapter = makeAdapter()
    await adapter.init(context, {})
    await eventually(() => context.stateOf(MAC).on === true && context.stateOf(MAC).volume === 12)

    tv.volume = 25
    tv.muted = true
    await eventually(() => context.stateOf(MAC).volume === 25 && context.stateOf(MAC).muted === true)

    tv.power = 'standby'
    await eventually(() => context.stateOf(MAC).on === false)
    expect(tv.prompts).toBe(0)
  })
})

describe('commands', () => {
  async function paired(): Promise<void> {
    remembered()
    adapter = makeAdapter()
    await adapter.init(context, {})
    await adapter.discover([samsungHost()])
    await eventually(() => context.stateOf(MAC).volume === 12)
  }

  test('an exact volume through the renderer; sources by key or by app', async () => {
    await paired()
    expect((await adapter.execute(MAC, 'setVolume', { volume: 30 })).ok).toBe(true)
    expect(tv.volume).toBe(30)

    expect((await adapter.execute(MAC, 'setSource', { source: 'youtube' })).ok).toBe(true)
    await eventually(() => tv.launched.length === 1)
    expect(tv.launched[0]).toEqual({ appId: '111299001912', action_type: 'DEEP_LINK', metaTag: '' })

    expect((await adapter.execute(MAC, 'setSource', { source: 'HDMI' })).ok).toBe(true)
    await eventually(() => tv.keys.some((entry) => entry.key === 'KEY_HDMI'))
    expect(context.stateOf(MAC).source).toBe('HDMI')
    expect(tv.connections.every((connection) => connection.token === 'tok-abc')).toBe(true)
  })

  test('without the renderer the volume moves one press at a time', async () => {
    tv.rendererAllowed = false
    remembered()
    adapter = makeAdapter()
    await adapter.init(context, {})
    await eventually(() => context.stateOf(MAC).on === true)
    expect((await adapter.execute(MAC, 'stepVolume', { delta: 2 })).ok).toBe(true)
    await eventually(() => tv.keys.filter((entry) => entry.key === 'KEY_VOLUP').length === 2)
    const exact = await adapter.execute(MAC, 'setVolume', { volume: 20 })
    expect(exact.ok).toBe(false)
    expect(exact.error).toMatch(/monte le son/)
  })

  test('turned off: the power key, and off at once even while the TV still says on', async () => {
    tv.standbyDelayMs = 250
    await paired()
    expect((await adapter.execute(MAC, 'turnOff', {})).ok).toBe(true)
    await eventually(() => tv.keys.some((entry) => entry.key === 'KEY_POWER'))
    expect(context.stateOf(MAC).on).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(tv.power).toBe('on')
    expect(context.stateOf(MAC).on).toBe(false)
  })

  test('a Frame TV is turned off by holding the key, not by a click', async () => {
    tv.frame = true
    await paired()
    await adapter.discover([samsungHost()])
    expect((await adapter.execute(MAC, 'turnOff', {})).ok).toBe(true)
    await eventually(() => tv.power === 'standby')
    expect(tv.keys.map((entry) => `${entry.cmd} ${entry.key}`)).toEqual(['Press KEY_POWER', 'Release KEY_POWER'])
  })

  test('back on from standby with a Wake-on-LAN packet', async () => {
    await paired()
    tv.power = 'standby'
    await eventually(() => context.stateOf(MAC).on === false)

    const result = await adapter.execute(MAC, 'turnOn', {})
    expect(result.ok).toBe(true)
    expect(wakes[0]?.mac).toBe(MAC)
    expect(wakes[0]?.targets).toEqual(expect.arrayContaining(['192.168.1.255', '127.0.0.1']))
    await eventually(() => context.stateOf(MAC).on === true)
  })

  test('a TV that stays asleep says which setting to turn on', async () => {
    await paired()
    tv.power = 'standby'
    await eventually(() => context.stateOf(MAC).on === false)
    wakeBringsBack = false
    const result = await adapter.execute(MAC, 'turnOn', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/appareil mobile/)
  })

  test('a token the TV no longer accepts: refused, and the status says to pair again', async () => {
    tv.pairing = 'reject'
    remembered({ token: 'tok-old' })
    adapter = makeAdapter()
    await adapter.init(context, {})
    await eventually(() => context.stateOf(MAC).on === true)
    const result = await adapter.execute(MAC, 'setSource', { source: 'Netflix' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/appairage/i)
    expect(adapter.status().health).toBe('degraded')
    expect(stored().paired).toBe(false)
  })

  test('an unknown TV, or one never paired, is refused before any connection', async () => {
    adapter = makeAdapter()
    await adapter.init(context, {})
    expect((await adapter.execute('nope', 'turnOff', {})).ok).toBe(false)
    await adapter.discover([samsungHost()])
    const result = await adapter.execute(MAC, 'setSource', { source: 'Netflix' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/appair/i)
    expect(tv.connections).toEqual([])
  })
})

describe('the connection', () => {
  test('over TLS, with the token, named after the hub', async () => {
    remembered()
    const tried: string[] = []
    adapter = makeAdapter({ connect: (url, trust) => (tried.push(url), pinnedWebSocket(url, { ...trust, timeoutMs: 500 })) })
    await adapter.init(context, {})
    await eventually(() => context.stateOf(MAC).on === true)
    expect((await adapter.execute(MAC, 'pause', {})).ok).toBe(true)
    expect(tried[0]).toStartWith(`wss://127.0.0.1:${tv.ports.wss}/api/v2/channels/samsung.remote.control?name=`)
    expect(tried[0]).toContain('token=tok-abc')
  })

  test('another certificate at the TV address: the token stays here, and the status says why', async () => {
    remembered({ certificate: 'ab'.repeat(32) })
    adapter = makeAdapter()
    await adapter.init(context, {})
    await eventually(() => context.stateOf(MAC).on === true)
    const result = await adapter.execute(MAC, 'pause', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/certificat/i)
    expect(tv.connections).toEqual([])
    expect(adapter.status().health).toBe('degraded')
  })
})
