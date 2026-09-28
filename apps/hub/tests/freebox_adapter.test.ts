/**
 * The Freebox adapter against a box that speaks Freebox OS over real HTTPS.
 *
 * The fake box serves its API under a certificate signed by its own authority, which the
 * adapter is given the way it is given Free's in production: a box whose certificate is not
 * signed by it is refused. It shows the authorization request on its "screen" until a test
 * presses yes or no, checks HMAC session passwords against its challenge, expires sessions,
 * forgets tokens, and lists hosts the way the real box does.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac, randomBytes } from 'node:crypto'
import { FreeboxAdapter, type FreeboxOptions } from '#adapters/freebox'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'
import { selfSignedCertificate } from './self_signed.ts'

const AUTHORITY = selfSignedCertificate('Freebox Server', { altNames: ['localhost'] })
const NOW_S = () => Math.floor(Date.now() / 1000)

interface Host {
  mac: string
  name: string
  type: string
  vendor?: string
  active: boolean
  lastSeen: number
  ip: string
}

class FakeFreebox {
  port = 0
  screen: 'idle' | 'pending' | 'granted' | 'denied' | 'timeout' = 'idle'
  authorizeRequests: Record<string, unknown>[] = []
  sessions = 0
  logouts = 0
  calls: string[] = []
  connection: Record<string, unknown> = { type: 'ethernet', rate_down: 198900, rate_up: 1440000, bandwidth_up: 700000000, bandwidth_down: 1000000000, media: 'ftth', state: 'up', ipv4: '82.67.0.1', ipv6: '2a01:e35::1' }
  bridge = false
  hosts: Host[] = [
    { mac: '5E:65:55:00:00:01', name: 'iPhone de Camille', type: 'smartphone', active: true, lastSeen: NOW_S(), ip: '192.168.1.148' },
    { mac: '5E:65:55:00:00:02', name: 'Pixel de Sam', type: 'smartphone', active: false, lastSeen: NOW_S() - 7200, ip: '192.168.1.149' },
    { mac: '8C:97:EA:00:00:00', name: 'Freebox Player POP', type: 'smartphone', vendor: 'Freebox SAS', active: true, lastSeen: NOW_S(), ip: '192.168.1.180' },
    { mac: 'DE:00:B0:00:00:00', name: 'bureau-pc', type: 'workstation', active: true, lastSeen: NOW_S(), ip: '192.168.1.181' },
  ]
  #server: ReturnType<typeof Bun.serve> | null = null
  #appToken: string | null = null
  #challenge = randomBytes(12).toString('base64')
  #session: string | null = null

  start(certificate = AUTHORITY): this {
    this.#server = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { cert: certificate.cert, key: certificate.key }, fetch: (request) => this.#handle(request) })
    this.port = this.#server.port!
    return this
  }

  stop(): void {
    this.#server?.stop(true)
    this.#server = null
  }

  /** Someone presses the arrow on the box's screen. */
  answer(choice: 'granted' | 'denied' | 'timeout'): void {
    this.screen = choice
  }

  /** The box has a token already: the house paired before this test. */
  knownToken(): string {
    this.#appToken = randomBytes(32).toString('base64')
    this.screen = 'granted'
    return this.#appToken
  }

  expireSession(): void {
    this.#session = null
    this.#challenge = randomBytes(12).toString('base64')
  }

  /** Access removed in Freebox OS > Gestion des accès. */
  revoke(): void {
    this.#appToken = null
    this.expireSession()
  }

  get base(): string {
    return `https://localhost:${this.port}`
  }

  #handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname
    this.calls.push(`${request.method} ${path}`)
    const ok = (result?: unknown) => Response.json(result === undefined ? { success: true } : { success: true, result })
    const fail = (status: number, code: string, msg: string, result?: unknown) => Response.json({ success: false, error_code: code, msg, ...(result ? { result } : {}) }, { status })

    if (path === '/api_version') {
      return Response.json({ box_model_name: 'Freebox v7 (r1)', api_base_url: '/api/', https_port: this.port, device_name: 'Freebox Server', https_available: true, box_model: 'fbxgw7-r1/full', api_domain: 'localhost', uid: 'f00dbabe', api_version: '10.0', device_type: 'FreeboxServer7,1' })
    }
    if (!path.startsWith('/api/v10/')) return new Response('not found', { status: 404 })
    const route = path.slice('/api/v10/'.length)

    if (route === 'login/authorize/' && request.method === 'POST') {
      this.authorizeRequests.push((await request.json()) as Record<string, unknown>)
      this.#appToken = randomBytes(32).toString('base64')
      this.screen = 'pending'
      return ok({ app_token: this.#appToken, track_id: 42 })
    }
    if (route === 'login/authorize/42') {
      const status = this.screen === 'idle' ? 'unknown' : this.screen
      if (status === 'denied' || status === 'timeout') this.#appToken = null
      return ok({ status, challenge: this.#challenge })
    }
    if (route === 'login/' || route === 'login') return ok({ logged_in: this.#session !== null, challenge: this.#challenge })
    if (route === 'login/session/' && request.method === 'POST') {
      const body = (await request.json()) as { app_id?: string; password?: string }
      if (!this.#appToken || this.screen !== 'granted') return fail(403, 'invalid_token', "Le jeton d'application est invalide")
      const expected = createHmac('sha1', this.#appToken).update(this.#challenge).digest('hex')
      if (body.app_id !== 'fr.sway.home' || body.password !== expected) return fail(403, 'invalid_token', 'Mot de passe de session invalide')
      this.sessions += 1
      this.#session = randomBytes(16).toString('hex')
      return ok({ session_token: this.#session, challenge: this.#challenge, permissions: { settings: false, player: false } })
    }

    if (!this.#session || request.headers.get('x-fbx-app-auth') !== this.#session) return fail(403, 'auth_required', 'Merci de vous connecter', { challenge: this.#challenge })

    switch (route) {
      case 'login/logout/':
        this.logouts += 1
        this.#session = null
        return ok()
      case 'connection/':
        return ok(this.connection)
      case 'system/':
        return ok({ mac: '68:A3:78:00:00:00', model_info: { pretty_name: 'Freebox Server (r2)', name: 'fbxgw-r2/full' }, uptime_val: 13550176, serial: '762601T190510709', firmware_version: '4.2.5' })
      case 'lan/browser/interfaces/':
        return this.bridge ? fail(200, 'nodev', 'Interface invalide') : ok([{ name: 'pub', host_count: this.hosts.length }])
      case 'lan/browser/pub/':
        return ok(
          this.hosts.map((host) => ({
            id: `ether-${host.mac.toLowerCase()}`,
            l2ident: { id: host.mac, type: 'mac_address' },
            primary_name: host.name,
            host_type: host.type,
            vendor_name: host.vendor ?? '',
            interface: 'pub',
            active: host.active,
            reachable: host.active,
            last_time_reachable: host.lastSeen,
            last_activity: host.lastSeen,
            l3connectivities: [{ addr: host.ip, af: 'ipv4', active: host.active, reachable: host.active, last_activity: host.lastSeen, last_time_reachable: host.lastSeen }],
          }))
        )
      default:
        return fail(404, 'invalid_request', `unknown route ${route}`)
    }
  }
}

let box: FakeFreebox | null = null
let adapter: FreeboxAdapter | null = null

afterEach(async () => {
  await adapter?.shutdown()
  adapter = null
  box?.stop()
  box = null
})

function options(extra: FreeboxOptions = {}): FreeboxOptions {
  return {
    ca: AUTHORITY.cert,
    discoveryUrls: [`${box!.base}/api_version`],
    localHost: null,
    pollMs: 100,
    requestTimeoutMs: 1500,
    pairTimeoutMs: 2000,
    pairPollMs: 20,
    awayAfterMs: 600_000,
    ...extra,
  }
}

async function running(extra: FreeboxOptions = {}, paired = false): Promise<{ context: RecordingContext; token: string | null }> {
  box = new FakeFreebox().start()
  const context = recordingContext()
  let token: string | null = null
  if (paired) {
    token = box.knownToken()
    context.memory.set('freebox', { appToken: token, info: null })
  }
  adapter = new FreeboxAdapter(options(extra))
  await adapter.init(context, {})
  return { context, token }
}

const leaks = (context: RecordingContext, token: string, ...more: unknown[]) =>
  JSON.stringify([context.states, context.events, context.logs, context.discovered, adapter!.status(), ...more]).includes(token)

describe('pairing', () => {
  test('the box is found, and asks to be validated on its screen', async () => {
    await running()
    const devices = await adapter!.discover([])
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ adapterId: 'freebox', nativeId: 'box:f00dbabe', name: 'Freebox v7 (r1)', category: 'gateway', manufacturer: 'Free' })
    expect(devices[0]!.requiresPairing?.kind).toBe('button')
    expect(devices[0]!.requiresPairing?.instructions).toMatch(/écran de la Freebox/)
    expect(adapter!.status().health).toBe('needs_setup')
  })

  test('pairing waits for the screen, then keeps the token out of sight and starts reading the box', async () => {
    const { context } = await running()
    const pairing = adapter!.pair({})
    await eventually(() => box!.screen === 'pending')
    expect(box!.authorizeRequests[0]).toMatchObject({ app_id: 'fr.sway.home', app_name: 'Sway Home' })
    expect(typeof box!.authorizeRequests[0]!.device_name).toBe('string')
    box!.answer('granted')
    const result = await pairing
    expect(result.ok).toBe(true)
    expect(result.device?.nativeId).toBe('box:f00dbabe')
    const stored = context.memory.get('freebox') as { appToken: string }
    expect(typeof stored.appToken).toBe('string')
    await eventually(() => context.stateOf('box:f00dbabe').internet === 'up')
    expect(leaks(context, stored.appToken, result)).toBe(false)
    expect(adapter!.status().health).toBe('ok')
  })

  test('a no on the screen, or nobody answering, is said plainly', async () => {
    const { context } = await running({ pairTimeoutMs: 400 })
    const refused = adapter!.pair({})
    await eventually(() => box!.screen === 'pending')
    box!.answer('denied')
    expect(await refused).toMatchObject({ ok: false, message: expect.stringMatching(/refus/i) })
    expect(context.memory.get('freebox')).toMatchObject({ appToken: null })
    const unanswered = await adapter!.pair({})
    expect(unanswered.ok).toBe(false)
    expect(unanswered.message).toMatch(/écran/)
  })

  test('a box whose certificate Free did not sign is refused before anything is sent', async () => {
    box = new FakeFreebox().start(selfSignedCertificate('Freebox Server', { altNames: ['localhost'] }))
    adapter = new FreeboxAdapter({ ...options(), ca: AUTHORITY.cert })
    await adapter.init(recordingContext(), {})
    expect(await adapter.discover([])).toEqual([])
    expect((await adapter.pair({})).ok).toBe(false)
    expect(box.calls).toEqual([])
    expect(adapter.status().message).toMatch(/certificat/i)
  })
})

describe('what the box tells the house', () => {
  test('phones are people at home; a Freebox player that calls itself a phone and a PC are not', async () => {
    const { context, token } = await running({}, true)
    const devices = await adapter!.discover([])
    const phones = devices.filter((device) => device.category === 'phone')
    expect(phones.map((device) => device.name).sort()).toEqual(['Pixel de Sam', 'iPhone de Camille'])
    expect(phones[0]).toMatchObject({ capabilities: ['presence'], network: { mac: expect.stringMatching(/^5e:65:55/) } })
    await eventually(() => context.stateOf('mac:5e:65:55:00:00:01').home === true)
    expect(context.stateOf('mac:5e:65:55:00:00:01')).toMatchObject({ home: true, confidence: 1, source: 'network' })
    expect(context.stateOf('mac:5e:65:55:00:00:02')).toMatchObject({ home: false })
    const boxDevice = devices.find((device) => device.category === 'gateway')!
    expect(boxDevice).toMatchObject({ nativeId: 'box:f00dbabe', model: 'fbxgw-r2/full', firmwareVersion: '4.2.5', requiresPairing: null })
    expect(leaks(context, token!, devices)).toBe(false)
  })

  test('a phone that drops off the Wi-Fi is still home for a while, then away', async () => {
    const { context } = await running({ awayAfterMs: 1500 }, true)
    await adapter!.discover([])
    const camille = box!.hosts[0]!
    camille.active = false
    camille.lastSeen = NOW_S()
    await eventually(() => context.stateOf('mac:5e:65:55:00:00:01').confidence === 0.6)
    expect(context.stateOf('mac:5e:65:55:00:00:01').home).toBe(true)
    await eventually(() => context.stateOf('mac:5e:65:55:00:00:01').home === false, 3000)
  })

  test('a phone that arrives later shows up without a scan', async () => {
    const { context } = await running({}, true)
    await adapter!.discover([])
    box!.hosts.push({ mac: '5E:65:55:00:00:03', name: 'iPad', type: 'tablet', active: true, lastSeen: NOW_S(), ip: '192.168.1.150' })
    await eventually(() => context.discovered.some((device) => device.nativeId === 'mac:5e:65:55:00:00:03'))
  })

  test('the internet going down and coming back: state and events', async () => {
    const { context } = await running({}, true)
    await adapter!.discover([])
    await eventually(() => context.stateOf('box:f00dbabe').internet === 'up')
    expect(context.stateOf('box:f00dbabe')).toMatchObject({ media: 'ftth', bandwidthDown: 1000000000, firmwareVersion: '4.2.5' })
    box!.connection = { ...box!.connection, state: 'down' }
    await eventually(() => context.events.some((event) => event.event === 'internet_down'))
    box!.connection = { ...box!.connection, state: 'up' }
    await eventually(() => context.events.some((event) => event.event === 'internet_up'))
    expect(context.events.filter((event) => event.event.startsWith('internet_'))).toHaveLength(2)
  })

  test('an expired session is opened again with the challenge the box gives', async () => {
    const { context } = await running({}, true)
    await adapter!.discover([])
    await eventually(() => box!.sessions === 1 && context.stateOf('box:f00dbabe').internet === 'up')
    box!.expireSession()
    box!.connection = { ...box!.connection, state: 'down' }
    await eventually(() => context.stateOf('box:f00dbabe').internet === 'down')
    expect(box!.sessions).toBe(2)
  })

  test('access removed in Freebox OS: the box asks to be paired again', async () => {
    const { context } = await running({}, true)
    await adapter!.discover([])
    await eventually(() => box!.sessions === 1)
    box!.revoke()
    await eventually(() => adapter!.status().health === 'needs_setup')
    expect(adapter!.status().message).toMatch(/appairer/i)
    expect(context.memory.get('freebox')).toMatchObject({ appToken: null })
    const [device] = await adapter!.discover([])
    expect(device?.requiresPairing?.kind).toBe('button')
  })

  test('bridge mode: no hosts to read, the connection still is', async () => {
    const { context } = await running({}, true)
    box!.bridge = true
    const devices = await adapter!.discover([])
    expect(devices.map((device) => device.category)).toEqual(['gateway'])
    await eventually(() => context.stateOf('box:f00dbabe').internet === 'up')
    expect(adapter!.status().health).toBe('ok')
  })

  test('shutdown closes the session and stops asking', async () => {
    await running({}, true)
    await adapter!.discover([])
    await eventually(() => box!.sessions === 1)
    await adapter!.shutdown()
    adapter = null
    expect(box!.logouts).toBe(1)
    const calls = box!.calls.length
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(box!.calls.length).toBe(calls)
  })
})
