/**
 * Freebox: who is home, from the box that sees every phone join the Wi-Fi, and whether the
 * internet is up.
 *
 *  - **Found by itself**: `_fbx-api._tcp` in mDNS, or /api_version on mafreebox.freebox.fr.
 *  - **Paired on the box's screen.** The hub asks for an app token; the Freebox Server shows
 *    the request and a human validates it with the right arrow. The token stays in the hub's
 *    store: it never appears in a state, a log, a status or an answer.
 *  - **HTTPS checked against Free's own certificate authorities**, never with verification
 *    off: the session token must not be readable on the network. The local name is tried
 *    first (it works with the internet down), then the box's HTTPS domain.
 *  - **Sessions** are HMAC-SHA1(app_token, challenge); an expired one is opened again with
 *    the challenge the box sends back, and a token removed in Freebox OS asks for pairing.
 *  - **Presence**: phones and tablets in the hosts list (not Free's players, which call
 *    themselves phones) are people at home while active, and for a while after, since phones
 *    put their Wi-Fi to sleep. A phone that joins later appears without a scan.
 *  - **The box** reports its connection (state, fibre or DSL, rates) and firmware, and raises
 *    `internet_down` / `internet_up` when the line changes.
 *
 * Not covered: Freebox Player control (it needs the "player" permission, granted by hand in
 * Freebox OS), bridge mode presence (the box has no hosts list then).
 */

import { hostname } from 'node:os'
import { deviceUid } from '@sway-home/shared'
import type { AdapterContext, AdapterDescriptor, AdapterStatus, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { FREEBOX_CA } from '#adapters/freebox_ca'
import {
  apiBase,
  authorizationStatus,
  isPersonal,
  parseApiVersion,
  parseConnection,
  parseHosts,
  parseSystem,
  presenceOf,
  sessionPassword,
  unwrap,
  type Connection,
  type FreeboxInfo,
  type FreeboxSystem,
  type LanHost,
} from '#adapters/freebox_codec'

export interface FreeboxOptions {
  /** Certificate authorities the API must be signed by: Free's, unless a test brings its own. */
  ca?: string
  /** Where the box describes itself. */
  discoveryUrls?: string[]
  /** The box's local name, tried before its internet domain; null to skip it. */
  localHost?: string | null
  pollMs?: number
  systemEveryMs?: number
  requestTimeoutMs?: number
  pairTimeoutMs?: number
  pairPollMs?: number
  /** How long a phone gone quiet still counts as home. */
  awayAfterMs?: number
  offlineAfter?: number
}

interface Stored {
  appToken: string | null
  info: FreeboxInfo | null
  known?: string[]
}

const APP = { app_id: 'fr.sway.home', app_name: 'Sway Home', app_version: '1.0.0' }
const STORE_KEY = 'freebox'

const PAIR_HELP = "Lancer l'appairage, puis valider sur l'écran de la Freebox Server avec la flèche de droite : la demande y reste affichée quelques minutes."
const UNANSWERED = "Personne n'a validé sur l'écran de la Freebox à temps : relancer l'appairage, puis appuyer sur la flèche de droite de la Freebox Server."
const REVOKED = "L'accès de Sway Home a été retiré dans Freebox OS : appairer de nouveau."
const UNTRUSTED = "Le certificat présenté n'est pas signé par Free : connexion refusée, rien n'a été envoyé."

class FreeboxError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

class Unreachable extends Error {
  constructor(
    message: string,
    readonly untrusted: boolean
  ) {
    super(message)
  }
}

/** The token is gone (refused, removed in Freebox OS): pairing again is the only way back. */
class NeedsPairing extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const TLS_FAILURE = /certificate|self[- ]signed|ERR_TLS|UNABLE_TO|CERT_|DEPTH_ZERO|altname|issuer/i

export class FreeboxAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'freebox',
    name: 'Freebox',
    vendor: 'Free',
    transports: ['wifi', 'ethernet'],
    capabilities: ['presence', 'firmware'],
    zeroConfig: true,
    cloud: false,
    implemented: true,
    requiresHardware: 'Une Freebox (Server ou Pop) en mode routeur',
    docsUrl: 'https://dev.freebox.fr/sdk/os/',
    configSchema: [
      {
        key: 'awayMinutes',
        label: 'Absent après (minutes)',
        type: 'number',
        default: 10,
        help: "Un téléphone qui a quitté le Wi-Fi compte encore comme présent pendant ce temps : les téléphones mettent leur Wi-Fi en veille.",
      },
      { key: 'pollSeconds', label: 'Lecture de la Freebox (secondes)', type: 'number', default: 30 },
    ],
  }

  readonly #options: Required<Omit<FreeboxOptions, 'localHost'>> & { localHost: string | null }
  #context: AdapterContext | null = null
  #info: FreeboxInfo | null = null
  #appToken: string | null = null
  #revoked = false
  #session: string | null = null
  #base: string | null = null
  #problem: string | null = null
  #system: FreeboxSystem | null = null
  #systemAt = 0
  #boxState: Record<string, unknown> = {}
  #internet: Connection['internet'] | null = null
  #phones = new Map<string, { host: LanHost; state: Record<string, unknown> }>()
  #known = new Set<string>()
  #bridge = false
  #failures = 0
  #online: boolean | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  #inflight: Promise<void> | null = null
  #stopped = false

  constructor(options: FreeboxOptions = {}) {
    this.#options = {
      ca: options.ca ?? FREEBOX_CA,
      discoveryUrls: options.discoveryUrls ?? ['https://mafreebox.freebox.fr/api_version', 'http://mafreebox.freebox.fr/api_version'],
      localHost: options.localHost === undefined ? 'mafreebox.freebox.fr' : options.localHost,
      pollMs: options.pollMs ?? 30_000,
      systemEveryMs: options.systemEveryMs ?? 3_600_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 5000,
      pairTimeoutMs: options.pairTimeoutMs ?? 120_000,
      pairPollMs: options.pairPollMs ?? 1000,
      awayAfterMs: options.awayAfterMs ?? 600_000,
      offlineAfter: options.offlineAfter ?? 2,
    }
  }

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#stopped = false
    const away = Number(config.awayMinutes)
    if (Number.isFinite(away) && away >= 1) this.#options.awayAfterMs = away * 60_000
    const poll = Number(config.pollSeconds)
    if (Number.isFinite(poll) && poll >= 5) this.#options.pollMs = poll * 1000
    const stored = await context.store.get<Stored>(STORE_KEY)
    this.#appToken = stored?.appToken ?? null
    this.#info = stored?.info ?? null
    this.#known = new Set(stored?.known ?? [])
    if (this.#appToken) this.#start()
  }

  // -------------------------------------------------------------------------------------
  // Finding and pairing
  // -------------------------------------------------------------------------------------

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    if (this.#stopped) return []
    const info = await this.#findBox(hosts)
    if (!info) return []
    if (!this.#appToken) return [this.#boxDevice()]
    await this.#poll()
    if (!this.#appToken) return [this.#boxDevice()]
    const phones = [...this.#phones.values()].map((phone) => this.#phoneDevice(phone.host))
    for (const phone of phones) this.#known.add(phone.nativeId)
    await this.#save()
    return [this.#boxDevice(), ...phones]
  }

  async pair(_input: Record<string, unknown>): Promise<{ ok: boolean; message: string; device?: DiscoveredDevice }> {
    const info = await this.#findBox([])
    if (!info) return { ok: false, message: this.#problem ?? 'Aucune Freebox trouvée sur ce réseau.' }
    let track: number
    let token: string
    try {
      const answer = unwrap((await this.#raw('POST', 'login/authorize/', { ...APP, device_name: hostname() || 'Sway Home' })).json)
      if (!answer.ok) {
        if (answer.code === 'new_apps_denied' || answer.code === 'apps_denied') return { ok: false, message: "La Freebox refuse les nouvelles applications : l'autoriser dans Freebox OS (Paramètres > Gestion des accès)." }
        return { ok: false, message: `La Freebox refuse la demande : ${answer.message}` }
      }
      const result = answer.result as { app_token?: unknown; track_id?: unknown }
      if (typeof result.app_token !== 'string' || typeof result.track_id !== 'number') return { ok: false, message: 'Réponse inattendue de la Freebox.' }
      token = result.app_token
      track = result.track_id
    } catch (error) {
      return { ok: false, message: this.#describe(error) }
    }

    const until = Date.now() + this.#options.pairTimeoutMs
    while (Date.now() < until && !this.#stopped) {
      let status: ReturnType<typeof authorizationStatus> = null
      try {
        status = authorizationStatus((await this.#raw('GET', `login/authorize/${track}`)).json)
      } catch {
        /* the next round will tell */
      }
      if (status === 'granted') {
        this.#appToken = token
        this.#revoked = false
        this.#session = null
        await this.#save()
        this.#start()
        await this.#poll()
        const device = this.#boxDevice()
        this.#context?.emitDiscovered(device)
        return { ok: true, message: 'Freebox appairée : la présence des téléphones et la connexion sont suivies.', device }
      }
      if (status === 'denied') {
        this.#appToken = null
        await this.#save()
        return { ok: false, message: "Refusé sur l'écran de la Freebox." }
      }
      if (status === 'timeout') return { ok: false, message: UNANSWERED }
      if (status === 'unknown') return { ok: false, message: "La Freebox a perdu la demande : relancer l'appairage." }
      await sleep(this.#options.pairPollMs)
    }
    return { ok: false, message: UNANSWERED }
  }

  /** The box's description: mDNS first (no request), then /api_version, then what was stored. */
  async #findBox(hosts: NetworkHost[]): Promise<FreeboxInfo | null> {
    for (const host of hosts) {
      if (!host.mdnsServices.some((service) => service.includes('_fbx-api._tcp'))) continue
      const info = parseApiVersion(host.mdnsTxt)
      if (info) return this.#adoptInfo(info)
    }
    let untrusted = false
    for (const url of this.#options.discoveryUrls) {
      try {
        const reply = await this.#fetch(url, { method: 'GET' })
        const info = parseApiVersion(reply.json)
        if (info) return this.#adoptInfo(info)
      } catch (error) {
        if (error instanceof Unreachable && error.untrusted) untrusted = true
      }
    }
    if (untrusted) this.#problem = UNTRUSTED
    return this.#info
  }

  async #adoptInfo(info: FreeboxInfo): Promise<FreeboxInfo> {
    const changed = JSON.stringify(info) !== JSON.stringify(this.#info)
    this.#info = info
    this.#problem = null
    if (changed) {
      this.#base = null
      await this.#save()
    }
    return info
  }

  async #save(): Promise<void> {
    await this.#context?.store.set(STORE_KEY, { appToken: this.#appToken, info: this.#info, known: [...this.#known] } satisfies Stored)
  }

  // -------------------------------------------------------------------------------------
  // HTTPS, sessions
  // -------------------------------------------------------------------------------------

  async #fetch(url: string, init: { method: string; body?: unknown; session?: string | null }): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#options.requestTimeoutMs)
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (init.body !== undefined) headers['content-type'] = 'application/json'
      if (init.session) headers['X-Fbx-App-Auth'] = init.session
      const response = await fetch(url, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
        // Verified against Free's authorities, never switched off.
        ...(url.startsWith('https:') ? { tls: { ca: this.#options.ca } } : {}),
      } as RequestInit)
      const text = await response.text()
      let json: unknown = null
      try {
        json = JSON.parse(text)
      } catch {
        /* not JSON: unwrap says so */
      }
      return { status: response.status, json }
    } catch (error) {
      const message = (error as Error).message ?? ''
      throw new Unreachable(message, TLS_FAILURE.test(message))
    } finally {
      clearTimeout(timer)
    }
  }

  #bases(): string[] {
    if (!this.#info) return []
    const bases: string[] = []
    if (this.#options.localHost) bases.push(`https://${this.#options.localHost}${this.#info.apiBaseUrl}v${this.#info.apiMajor}/`)
    if (this.#info.httpsAvailable) bases.push(apiBase(this.#info))
    return bases
  }

  /** One request to the API, on the address that answered last, or the first that answers. */
  async #raw(method: string, path: string, body?: unknown, session?: string | null): Promise<{ status: number; json: unknown }> {
    const bases = this.#base ? [this.#base, ...this.#bases().filter((base) => base !== this.#base)] : this.#bases()
    if (bases.length === 0) throw new Unreachable("l'accès HTTPS de la Freebox est désactivé", false)
    let last: Unreachable | null = null
    for (const base of bases) {
      try {
        const reply = await this.#fetch(`${base}${path}`, { method, body, session })
        this.#base = base
        return reply
      } catch (error) {
        last = error as Unreachable
      }
    }
    if (last?.untrusted) this.#problem = UNTRUSTED
    throw last ?? new Unreachable('la Freebox ne répond pas', false)
  }

  async #login(challenge: string | null = null): Promise<void> {
    const token = this.#appToken
    if (!token) throw new NeedsPairing()
    let current = challenge
    if (!current) {
      const answer = unwrap((await this.#raw('GET', 'login/')).json)
      if (!answer.ok) throw new FreeboxError(answer.code, answer.message)
      current = String((answer.result as { challenge?: unknown } | null)?.challenge ?? '')
    }
    const answer = unwrap((await this.#raw('POST', 'login/session/', { app_id: APP.app_id, password: sessionPassword(token, current) })).json)
    if (!answer.ok) {
      if (answer.code === 'invalid_token' || answer.code === 'pending_token') {
        await this.#forgetToken()
        throw new NeedsPairing()
      }
      throw new FreeboxError(answer.code, answer.message)
    }
    const session = (answer.result as { session_token?: unknown } | null)?.session_token
    if (typeof session !== 'string') throw new FreeboxError('invalid_answer', 'pas de jeton de session')
    this.#session = session
  }

  async #api(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.#session) await this.#login()
    let answer = unwrap((await this.#raw(method, path, body, this.#session)).json)
    if (!answer.ok && (answer.code === 'auth_required' || answer.code === 'invalid_session')) {
      this.#session = null
      await this.#login(answer.challenge)
      answer = unwrap((await this.#raw(method, path, body, this.#session)).json)
    }
    if (!answer.ok) throw new FreeboxError(answer.code, answer.message)
    return answer.result
  }

  async #forgetToken(): Promise<void> {
    this.#appToken = null
    this.#session = null
    this.#revoked = true
    this.#stop()
    await this.#save()
    this.#context?.log('warn', REVOKED)
  }

  // -------------------------------------------------------------------------------------
  // Reading the box
  // -------------------------------------------------------------------------------------

  #start(): void {
    if (this.#timer || this.#stopped) return
    this.#timer = setInterval(() => void this.#poll(), this.#options.pollMs)
    void this.#poll()
  }

  #stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  #poll(): Promise<void> {
    if (!this.#inflight) {
      this.#inflight = this.#read().finally(() => {
        this.#inflight = null
      })
    }
    return this.#inflight
  }

  async #read(): Promise<void> {
    if (this.#stopped || !this.#appToken) return
    try {
      if (!this.#info && !(await this.#findBox([]))) return
      const connection = parseConnection(await this.#api('GET', 'connection/'))
      if (!this.#system || Date.now() - this.#systemAt > this.#options.systemEveryMs) {
        this.#system = parseSystem(await this.#api('GET', 'system/'))
        this.#systemAt = Date.now()
      }
      this.#reportBox(connection)
      await this.#readHosts()
      this.#reachable()
    } catch (error) {
      if (error instanceof NeedsPairing) return
      this.#failed(error)
    }
  }

  async #readHosts(): Promise<void> {
    let interfaces: unknown
    try {
      interfaces = await this.#api('GET', 'lan/browser/interfaces/')
      this.#bridge = false
    } catch (error) {
      // Bridge mode: the box routes nothing, so it lists no one.
      if (error instanceof FreeboxError && error.code === 'nodev') {
        this.#bridge = true
        return
      }
      throw error
    }
    const hosts: LanHost[] = []
    for (const entry of Array.isArray(interfaces) ? interfaces : []) {
      const name = (entry as { name?: unknown } | null)?.name
      if (typeof name !== 'string' || !/^[\w-]+$/.test(name)) continue
      hosts.push(...parseHosts(await this.#api('GET', `lan/browser/${name}/`)))
    }
    const now = Date.now()
    const seen = new Set<string>()
    for (const host of hosts.filter(isPersonal)) {
      const nativeId = `mac:${host.mac}`
      seen.add(nativeId)
      const phone = this.#phones.get(nativeId) ?? { host, state: {} }
      phone.host = host
      this.#phones.set(nativeId, phone)
      this.#emit(nativeId, phone.state, presenceOf(host, now, this.#options.awayAfterMs))
      if (!this.#known.has(nativeId)) {
        this.#known.add(nativeId)
        this.#context?.emitDiscovered(this.#phoneDevice(host))
        await this.#save()
      }
    }
    // Forgotten by the box: long gone.
    for (const [nativeId, phone] of this.#phones) {
      if (!seen.has(nativeId)) this.#emit(nativeId, phone.state, { home: false, confidence: 1 })
    }
  }

  #reportBox(connection: Connection): void {
    const nativeId = this.#boxId()
    if (!nativeId) return
    this.#emit(nativeId, this.#boxState, {
      internet: connection.internet,
      media: connection.media,
      ipv4: connection.ipv4,
      ipv6: connection.ipv6,
      rateDown: connection.rateDown,
      rateUp: connection.rateUp,
      bandwidthDown: connection.bandwidthDown,
      bandwidthUp: connection.bandwidthUp,
      firmwareVersion: this.#system?.firmware ?? null,
      updateAvailable: false,
    })
    const settled = connection.internet === 'up' || connection.internet === 'down' ? connection.internet : null
    if (settled && this.#internet && settled !== this.#internet) this.#context?.emitEvent(nativeId, settled === 'down' ? 'internet_down' : 'internet_up', { media: connection.media })
    if (settled) this.#internet = settled
  }

  #emit(nativeId: string, current: Record<string, unknown>, patch: Record<string, unknown>): void {
    const changed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch)) if (current[key] !== value) changed[key] = value
    if (Object.keys(changed).length === 0) return
    Object.assign(current, changed)
    this.#context?.emitState(nativeId, changed)
  }

  #reachable(): void {
    this.#failures = 0
    this.#problem = null
    if (this.#online !== true) {
      this.#online = true
      const nativeId = this.#boxId()
      if (nativeId) this.#context?.emitAvailability(nativeId, true)
    }
  }

  #failed(error: unknown): void {
    if (error instanceof Unreachable) {
      this.#failures += 1
      if (this.#failures >= this.#options.offlineAfter && this.#online !== false) {
        this.#online = false
        const nativeId = this.#boxId()
        if (nativeId) this.#context?.emitAvailability(nativeId, false)
        this.#context?.log('warn', `Freebox injoignable : ${this.#describe(error)}`)
      }
    } else {
      this.#context?.log('warn', `Freebox : ${this.#describe(error)}`)
    }
  }

  #describe(error: unknown): string {
    if (error instanceof Unreachable) return error.untrusted ? UNTRUSTED : 'la Freebox ne répond pas.'
    if (error instanceof FreeboxError) return `${error.message} (${error.code})`
    return (error as Error).message
  }

  // -------------------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------------------

  #boxId(): string | null {
    return this.#info ? `box:${this.#info.uid}` : null
  }

  #boxDevice(): DiscoveredDevice {
    const nativeId = this.#boxId()!
    return {
      adapterId: 'freebox',
      nativeId,
      uid: deviceUid('freebox', nativeId),
      name: this.#info?.name ?? this.#system?.name ?? 'Freebox',
      category: 'gateway',
      capabilities: ['firmware'],
      transport: 'ethernet',
      manufacturer: 'Free',
      model: this.#system?.model ?? this.#info?.model ?? null,
      firmwareVersion: this.#system?.firmware ?? null,
      serialNumber: this.#system?.serial ?? null,
      confidence: 0.95,
      network: { mac: this.#system?.mac ?? null },
      requiresPairing: this.#appToken ? null : { kind: 'button', instructions: PAIR_HELP },
    }
  }

  #phoneDevice(host: LanHost): DiscoveredDevice {
    const nativeId = `mac:${host.mac}`
    return {
      adapterId: 'freebox',
      nativeId,
      uid: deviceUid('freebox', nativeId),
      name: host.name,
      category: 'phone',
      capabilities: ['presence'],
      transport: 'wifi',
      manufacturer: host.vendor,
      confidence: 0.8,
      network: { ip: host.ipv4, mac: host.mac },
      meta: { hostType: host.type, guest: host.guest },
    }
  }

  // -------------------------------------------------------------------------------------
  // The rest of the contract
  // -------------------------------------------------------------------------------------

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    if (nativeId === this.#boxId()) return { ...this.#boxState }
    return { ...(this.#phones.get(nativeId)?.state ?? {}) }
  }

  async execute(nativeId: string, command: string): Promise<CommandResult> {
    const fail = (error: string): CommandResult => ({ ok: false, deviceId: nativeId, command, error })
    if (command === 'installUpdate') return fail("La Freebox installe ses mises à jour d'elle-même.")
    if (command === 'setPresence') return fail("La présence d'un téléphone vient du réseau de la Freebox : elle se met à jour seule.")
    return fail(`La Freebox ne sait pas faire "${command}".`)
  }

  status(): AdapterStatus {
    const deviceCount = this.#info ? 1 + this.#phones.size : 0
    if (!this.#info) {
      return this.#problem ? { health: 'error', deviceCount, message: this.#problem } : { health: 'needs_setup', deviceCount, message: 'Aucune Freebox trouvée sur ce réseau.' }
    }
    if (!this.#appToken) return { health: 'needs_setup', deviceCount, message: this.#revoked ? REVOKED : "Appairage à faire : valider sur l'écran de la Freebox." }
    if (this.#problem) return { health: 'error', deviceCount, message: this.#problem }
    if (this.#online === false) return { health: 'degraded', deviceCount, message: 'La Freebox ne répond pas.' }
    return { health: 'ok', deviceCount, message: this.#bridge ? 'Freebox en mode bridge : pas de liste des appareils, donc pas de présence.' : undefined }
  }

  async shutdown(): Promise<void> {
    this.#stopped = true
    this.#stop()
    await this.#inflight?.catch(() => undefined)
    if (this.#session) {
      try {
        await this.#raw('POST', 'login/logout/', undefined, this.#session)
      } catch {
        /* the session lapses by itself */
      }
    }
    this.#session = null
    this.#phones.clear()
    this.#context = null
  }
}
