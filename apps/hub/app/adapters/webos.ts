/**
 * LG webOS TVs, over their local WebSocket API (SSAP).
 *
 * One persistent socket per TV, kept open: the TV pushes power, volume, app and playback
 * changes on its own (subscriptions), so the remote in someone's hand and the phone agree
 * without polling, and a command goes out on a socket that is already warm.
 *
 *  - **Pairing** is one press on the remote. The first registration makes the TV show a
 *    prompt; once accepted it returns a client key, kept in the adapter's store, and every
 *    later connection registers with it silently. The adapter never registers without a key
 *    on its own - a prompt appearing on the TV unasked is exactly the kind of surprise a
 *    house must not make - only when someone presses "Appairer".
 *  - **Off is not offline.** A TV in standby closes its socket; that is the TV being off,
 *    reported as `on: false`, and retried with backoff. Turning it on sends a Wake-on-LAN
 *    packet to its MAC, then reconnects quickly until it answers.
 *  - **TLS first, and pinned.** Port 3001 (TLS) is tried before port 3000 (clear), so a TV
 *    that speaks TLS never sees its key in clear; once a TV has answered over TLS it is never
 *    asked in clear again. Its certificate is self-signed: the one seen first is kept, and a
 *    TV that later shows another one does not get the key (see `pinned_websocket.ts`).
 *
 * Translation lives in `webos_codec.ts`; this file is only the conversation.
 */

import type { AdapterContext, AdapterDescriptor, AdapterStatus, CapabilityId, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import type { SocketLike } from '#adapters/homeassistant'
import { CertificateMismatchError, pinnedWebSocket, type Trust } from '#adapters/pinned_websocket'
import { broadcastAddress, sendWakeOnLan } from '#adapters/wake_on_lan'
import {
  URI,
  WEBOS_PORTS,
  commandActions,
  currentSource,
  failureOf,
  isOn,
  parseMessage,
  playbackFrom,
  registerMessage,
  requestMessage,
  sourcesFrom,
  volumeFrom,
  type WebosMessage,
  type WebosSource,
} from '#adapters/webos_codec'

export interface WebosOptions {
  connect?: (url: string, trust: Trust) => SocketLike
  ports?: { ws: number; wss: number }
  wake?: (mac: string, targets: string[]) => Promise<void>
  requestTimeoutMs?: number
  connectTimeoutMs?: number
  /** How long "Appairer" waits for the TV to show its prompt. */
  promptTimeoutMs?: number
  /** How long the prompt stays open on the TV before the attempt is given up. */
  pairTimeoutMs?: number
  reconnectMs?: number
  maxReconnectMs?: number
  heartbeatMs?: number
  wakeTimeoutMs?: number
}

const CAPABILITIES: CapabilityId[] = ['onoff', 'volume', 'mediaPlayback', 'mediaSource', 'notify']

const WAKE_HELP =
  'Le téléviseur ne s\'est pas allumé. Activez "Allumer via le Wi-Fi" (Réglages > Général > Mobile TV On) ou, sur les modèles 2025, "Wake on LAN" (Réglages > Assistance > Contrôle IP).'

interface StoredTv {
  nativeId: string
  ip: string
  mac: string | null
  name: string
  model: string | null
  key: string | null
  /** True once the TV has answered over TLS: from then on it is never asked in clear. */
  secure: boolean | null
  /** SHA-256 of its TLS certificate, kept at the first TLS contact. */
  certificate: string | null
}

type Phase = 'offline' | 'connecting' | 'prompt' | 'ready' | 'rejected'
type Opened = { socket: SocketLike; early: { messages: unknown[]; closed: boolean } }
type RegisterOutcome = 'registered' | 'prompt' | { error: string }

interface Pending {
  resolve: (message: WebosMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class Tv {
  socket: SocketLike | null = null
  phase: Phase = 'offline'
  message: string | null = null
  nextId = 1
  pending = new Map<string, Pending>()
  subscriptions = new Map<string, (message: WebosMessage) => void>()
  onRegister: ((outcome: RegisterOutcome) => void) | null = null
  pairTimer: ReturnType<typeof setTimeout> | null = null
  reconnectTimer: ReturnType<typeof setTimeout> | null = null
  heartbeat: ReturnType<typeof setInterval> | null = null
  backoff: number
  /** undefined: not known yet; null: this TV has no power service (older firmware). */
  power: string | null | undefined = undefined
  appId: string | null = null
  volume: number | null = null
  muted: boolean | null = null
  playback: 'playing' | 'paused' | 'idle' | null = null
  sources: WebosSource[] = []

  constructor(
    public stored: StoredTv,
    reconnectMs: number
  ) {
    this.backoff = reconnectMs
  }

  forgetSession(): void {
    this.power = undefined
    this.appId = null
    this.playback = null
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function normaliseMac(mac: string | null | undefined): string | null {
  const hex = (mac ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  return hex.length === 12 ? hex.match(/.{2}/g)!.join(':') : null
}

function looksLikeWebos(host: NetworkHost): boolean {
  const ssdp = host.ssdp ? [host.ssdp.server, host.ssdp.st, host.ssdp.modelName, host.ssdp.friendlyName].filter(Boolean).join(' ') : ''
  if (/webos|lge-com:service:webos|\[lg\]/i.test(ssdp)) return true
  if (/^lgwebostv/i.test(host.hostname ?? '')) return true
  const lg = /\bLG\b|LG Electronics|LG Innotek/i.test(host.macVendor ?? '')
  return lg && (host.openPorts ?? []).some((port) => port === WEBOS_PORTS.ws || port === WEBOS_PORTS.wss)
}

function nameOf(host: NetworkHost): string {
  const friendly = host.ssdp?.friendlyName?.replace(/^\[LG\]\s*/i, '').trim()
  return friendly && friendly.length > 0 ? friendly : 'Téléviseur LG'
}

export class WebosAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'webos',
    name: 'LG webOS TV',
    vendor: 'LG',
    transports: ['wifi', 'ethernet'],
    capabilities: CAPABILITIES,
    zeroConfig: true,
    cloud: false,
    implemented: true,
    docsUrl: 'https://github.com/home-assistant-libs/aiowebostv',
    configSchema: [],
  }

  readonly #options: Required<WebosOptions>
  #context: AdapterContext | null = null
  #tvs = new Map<string, Tv>()
  #stopped = false

  constructor(options: WebosOptions = {}) {
    const connectTimeoutMs = options.connectTimeoutMs ?? 4000
    this.#options = {
      connect: options.connect ?? ((url, trust) => pinnedWebSocket(url, { ...trust, timeoutMs: connectTimeoutMs })),
      ports: options.ports ?? { ...WEBOS_PORTS },
      wake: options.wake ?? ((mac, targets) => sendWakeOnLan(mac, targets)),
      requestTimeoutMs: options.requestTimeoutMs ?? 8000,
      connectTimeoutMs,
      promptTimeoutMs: options.promptTimeoutMs ?? 8000,
      pairTimeoutMs: options.pairTimeoutMs ?? 60_000,
      reconnectMs: options.reconnectMs ?? 2000,
      maxReconnectMs: options.maxReconnectMs ?? 30_000,
      heartbeatMs: options.heartbeatMs ?? 30_000,
      wakeTimeoutMs: options.wakeTimeoutMs ?? 15_000,
    }
  }

  async init(context: AdapterContext, _config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#stopped = false
    const stored = (await context.store.get<StoredTv[]>('tvs')) ?? []
    for (const entry of stored) {
      const tv = new Tv({ ...entry, secure: entry.secure ?? null, certificate: entry.certificate ?? null }, this.#options.reconnectMs)
      this.#tvs.set(entry.nativeId, tv)
      if (entry.key) void this.#connect(tv, 'resume')
    }
  }

  // -------------------------------------------------------------------------------------
  // Discovery and pairing
  // -------------------------------------------------------------------------------------

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    const found: DiscoveredDevice[] = []
    for (const host of hosts) {
      if (!looksLikeWebos(host)) continue
      const mac = normaliseMac(host.mac)
      let tv = [...this.#tvs.values()].find((candidate) => (mac && candidate.stored.mac === mac) || candidate.stored.ip === host.ip)
      if (!tv) {
        tv = new Tv({ nativeId: mac ?? host.ip, ip: host.ip, mac, name: nameOf(host), model: host.ssdp?.modelName ?? null, key: null, secure: null, certificate: null }, this.#options.reconnectMs)
        this.#tvs.set(tv.stored.nativeId, tv)
      } else {
        tv.stored.ip = host.ip
        tv.stored.mac ??= mac
        tv.stored.model ??= host.ssdp?.modelName ?? null
      }
      found.push(this.#device(tv, host))
      if (tv.stored.key && tv.phase === 'offline' && !tv.reconnectTimer) void this.#connect(tv, 'resume')
    }
    await this.#persist()
    return found
  }

  #device(tv: Tv, host: NetworkHost): DiscoveredDevice {
    const { stored } = tv
    return {
      adapterId: 'webos',
      nativeId: stored.nativeId,
      uid: `webos:${stored.nativeId}`,
      name: stored.name,
      category: 'display',
      capabilities: CAPABILITIES,
      transport: 'wifi',
      manufacturer: 'LG',
      model: stored.model,
      confidence: host.ssdp ? 0.95 : 0.8,
      network: { ip: stored.ip, mac: stored.mac, hostname: host.hostname ?? null },
      meta: { ip: stored.ip, mac: stored.mac, paired: Boolean(stored.key) },
      requiresPairing: stored.key
        ? null
        : { kind: 'button', instructions: "Dans Intégrations, LG webOS TV : lancez l'appairage, puis acceptez la demande sur l'écran du téléviseur avec la télécommande." },
    }
  }

  async pair(input: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    if (this.#tvs.size === 0) return { ok: false, message: 'Aucun téléviseur LG trouvé : allumez-le, puis lancez un scan du réseau.' }
    const named = typeof input.nativeId === 'string' ? this.#tvs.get(input.nativeId) : typeof input.host === 'string' ? [...this.#tvs.values()].find((tv) => tv.stored.ip === input.host) : undefined
    const targets = named ? [named] : [...this.#tvs.values()].filter((tv) => !tv.stored.key || tv.phase === 'rejected')
    if (targets.length === 0) return { ok: true, message: 'Les téléviseurs LG sont déjà appairés.' }

    const outcomes = await Promise.all(targets.map(async (tv) => ({ tv, outcome: await this.#startPairing(tv) })))
    const names = (list: typeof outcomes) => list.map(({ tv }) => tv.stored.name).join(', ')
    const prompted = outcomes.filter(({ outcome }) => outcome === 'prompt')
    const registered = outcomes.filter(({ outcome }) => outcome === 'registered')
    const failed = outcomes.filter(({ outcome }) => typeof outcome === 'object')

    const parts: string[] = []
    if (prompted.length > 0) parts.push(`Acceptez la demande affichée sur ${names(prompted)} avec la télécommande.`)
    if (registered.length > 0) parts.push(`${names(registered)} : appairé.`)
    if (failed.length > 0) parts.push(`${names(failed)} ne répond pas : allumez-le, puis relancez l'appairage.`)
    return { ok: prompted.length + registered.length > 0, message: parts.join(' ') }
  }

  async #startPairing(tv: Tv): Promise<RegisterOutcome> {
    this.#closeSocket(tv)
    tv.phase = 'offline'
    tv.message = null
    // Pairing is a person in front of the TV: whatever certificate it shows now is its own.
    tv.stored.certificate = null
    return this.#connect(tv, 'pair')
  }

  // -------------------------------------------------------------------------------------
  // The connection
  // -------------------------------------------------------------------------------------

  /** Whatever the socket does before the real handlers are attached is kept for them. */
  #dial(tv: Tv, url: string): Promise<Opened> {
    return new Promise((resolve, reject) => {
      const early: Opened['early'] = { messages: [], closed: false }
      const trust: Trust = {
        pin: tv.stored.certificate,
        onPin: (fingerprint) => {
          tv.stored.certificate = fingerprint
          void this.#persist()
        },
      }
      let socket: SocketLike
      try {
        socket = this.#options.connect(url, trust)
      } catch (error) {
        reject(error as Error)
        return
      }
      const timer = setTimeout(() => {
        try {
          socket.close()
        } catch {
          // Already gone.
        }
        reject(new Error(`${url}: no answer`))
      }, this.#options.connectTimeoutMs)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve({ socket, early })
      }
      socket.onmessage = (event) => void early.messages.push(event.data)
      socket.onerror = (event) => {
        clearTimeout(timer)
        const cause = (event as { error?: unknown } | null)?.error
        reject(cause instanceof CertificateMismatchError ? cause : new Error(`${url}: refused`))
      }
      socket.onclose = () => {
        clearTimeout(timer)
        early.closed = true
        reject(new Error(`${url}: closed`))
      }
    })
  }

  /** TLS on 3001 first; port 3000 in clear only for a TV that has never answered over TLS. */
  async #open(tv: Tv): Promise<Opened> {
    const order: ('ws' | 'wss')[] = tv.stored.secure ? ['wss'] : ['wss', 'ws']
    let last: Error | null = null
    for (const scheme of order) {
      try {
        const opened = await this.#dial(tv, `${scheme}://${tv.stored.ip}:${this.#options.ports[scheme]}`)
        if (tv.stored.secure !== (scheme === 'wss')) {
          tv.stored.secure = scheme === 'wss'
          await this.#persist()
        }
        return opened
      } catch (error) {
        if (error instanceof CertificateMismatchError) throw error
        last = error as Error
      }
    }
    throw last ?? new Error('unreachable')
  }

  async #connect(tv: Tv, mode: 'resume' | 'pair'): Promise<RegisterOutcome> {
    if (tv.phase !== 'offline' && tv.phase !== 'rejected') return tv.phase === 'ready' ? 'registered' : tv.phase === 'prompt' ? 'prompt' : { error: 'busy' }
    if (tv.reconnectTimer) clearTimeout(tv.reconnectTimer)
    tv.reconnectTimer = null
    tv.phase = 'connecting'

    let opened: Opened
    try {
      opened = await this.#open(tv)
    } catch (error) {
      if (error instanceof CertificateMismatchError) {
        tv.phase = 'rejected'
        tv.message = `${tv.stored.name} présente un autre certificat que lors de l'appairage : je ne lui envoie plus sa clé. Si c'est bien lui (mise à jour, réparation), relancez l'appairage.`
        this.#emit(tv)
        return { error: 'certificate' }
      }
      tv.phase = 'offline'
      this.#emit(tv)
      if (mode === 'resume') this.#scheduleReconnect(tv)
      return { error: 'unreachable' }
    }
    const { socket, early } = opened
    if (this.#stopped) {
      socket.close()
      return { error: 'stopped' }
    }

    tv.socket = socket
    tv.forgetSession()
    socket.onmessage = (event) => this.#onMessage(tv, event.data)
    socket.onclose = () => this.#onClose(tv, socket)
    socket.onerror = () => undefined
    for (const data of early.messages) this.#onMessage(tv, data)
    if (early.closed) {
      this.#onClose(tv, socket)
      return { error: 'closed' }
    }

    // Newer firmware only gives its system information before registration.
    const info = await this.#request(tv, URI.systemInfo).catch(() => null)
    const model = info && !failureOf(info) ? info.payload?.modelName : null
    if (typeof model === 'string' && model.length > 0) tv.stored.model = model

    return this.#register(tv, mode === 'pair' ? null : tv.stored.key)
  }

  #register(tv: Tv, key: string | null): Promise<RegisterOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        tv.onRegister = null
        this.#closeSocket(tv)
        tv.phase = 'offline'
        resolve({ error: 'no answer to the registration' })
      }, this.#options.promptTimeoutMs)
      tv.onRegister = (outcome) => {
        clearTimeout(timer)
        tv.onRegister = null
        resolve(outcome)
      }
      tv.socket?.send(JSON.stringify(registerMessage(key)))
    })
  }

  #onMessage(tv: Tv, data: unknown): void {
    const message = parseMessage(data)
    if (!message) return
    const id = message.id === undefined ? '' : String(message.id)

    if (id === 'register_0') return this.#onRegistration(tv, message)

    const pending = tv.pending.get(id)
    if (pending) {
      clearTimeout(pending.timer)
      tv.pending.delete(id)
      pending.resolve(message)
    }
    tv.subscriptions.get(id)?.(message)
  }

  #onRegistration(tv: Tv, message: WebosMessage): void {
    if (message.type === 'response' && message.payload?.pairingType === 'PROMPT') {
      tv.phase = 'prompt'
      if (tv.pairTimer) clearTimeout(tv.pairTimer)
      tv.pairTimer = setTimeout(() => {
        if (tv.phase !== 'prompt') return
        tv.phase = 'rejected'
        tv.message = `Demande restée sans réponse sur ${tv.stored.name}.`
        this.#closeSocket(tv)
      }, this.#options.pairTimeoutMs)
      tv.onRegister?.('prompt')
      return
    }

    if (message.type === 'registered') {
      if (tv.pairTimer) clearTimeout(tv.pairTimer)
      tv.pairTimer = null
      const key = message.payload?.['client-key']
      if (typeof key === 'string' && key.length > 0 && key !== tv.stored.key) {
        tv.stored.key = key
        void this.#persist()
      }
      tv.phase = 'ready'
      tv.message = null
      tv.backoff = this.#options.reconnectMs
      tv.onRegister?.('registered')
      void this.#afterRegistration(tv)
      return
    }

    if (message.type === 'error') {
      if (tv.pairTimer) clearTimeout(tv.pairTimer)
      tv.pairTimer = null
      const error = message.error ?? 'erreur'
      tv.phase = 'rejected'
      tv.message = /403|reject|denied|cancel/i.test(error) ? `Appairage refusé sur ${tv.stored.name}.` : `Appairage impossible avec ${tv.stored.name} : ${error}`
      // A key the TV no longer honours is worth nothing; the next pairing starts clean.
      tv.stored.key = null
      void this.#persist()
      tv.onRegister?.({ error })
      this.#closeSocket(tv)
    }
  }

  async #afterRegistration(tv: Tv): Promise<void> {
    const [inputs, apps] = await Promise.all([this.#request(tv, URI.inputs).catch(() => null), this.#request(tv, URI.apps).catch(() => null)])
    tv.sources = sourcesFrom(inputs && !failureOf(inputs) ? inputs.payload : {}, apps && !failureOf(apps) ? apps.payload : {})

    this.#subscribe(tv, URI.powerState, (message) => {
      if (failureOf(message)) {
        if (tv.power === undefined) tv.power = null
      } else if (typeof message.payload?.state === 'string') {
        tv.power = message.payload.state
      }
      this.#emit(tv)
    })
    this.#subscribe(tv, URI.foregroundApp, (message) => {
      if (failureOf(message)) return
      const appId = message.payload?.appId
      tv.appId = typeof appId === 'string' && appId.length > 0 ? appId : null
      this.#emit(tv)
    })
    this.#subscribe(tv, URI.volume, (message) => {
      if (failureOf(message)) return
      const { volume, muted } = volumeFrom(message.payload ?? {})
      if (volume !== undefined) tv.volume = volume
      if (muted !== undefined) tv.muted = muted
      this.#emit(tv)
    })
    this.#subscribe(tv, URI.mediaForeground, (message) => {
      if (failureOf(message)) return
      tv.playback = playbackFrom(message.payload ?? {})
      this.#emit(tv)
    })

    if (tv.heartbeat) clearInterval(tv.heartbeat)
    // A socket can die without a close frame (the TV unplugged): a request that goes
    // unanswered is how that is noticed.
    tv.heartbeat = setInterval(() => {
      if (tv.phase !== 'ready') return
      this.#request(tv, URI.powerState).catch(() => this.#closeSocket(tv))
    }, this.#options.heartbeatMs)

    this.#context?.emitAvailability(tv.stored.nativeId, true)
    this.#emit(tv)
  }

  #request(tv: Tv, uri: string, payload: Record<string, unknown> = {}): Promise<WebosMessage> {
    return new Promise((resolve, reject) => {
      const socket = tv.socket
      if (!socket) {
        reject(new Error('Le téléviseur ne répond pas.'))
        return
      }
      const id = String(tv.nextId++)
      const timer = setTimeout(() => {
        tv.pending.delete(id)
        reject(new Error('Le téléviseur ne répond pas.'))
      }, this.#options.requestTimeoutMs)
      tv.pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify(requestMessage(id, uri, payload)))
    })
  }

  #subscribe(tv: Tv, uri: string, onMessage: (message: WebosMessage) => void): void {
    const id = String(tv.nextId++)
    tv.subscriptions.set(id, onMessage)
    tv.socket?.send(JSON.stringify(requestMessage(id, uri, {}, 'subscribe')))
  }

  #closeSocket(tv: Tv): void {
    const socket = tv.socket
    if (!socket) return
    this.#onClose(tv, socket)
    try {
      socket.close()
    } catch {
      // Already closed.
    }
  }

  #onClose(tv: Tv, socket: SocketLike): void {
    if (tv.socket !== socket) return
    tv.socket = null
    for (const pending of tv.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Le téléviseur a fermé la connexion.'))
    }
    tv.pending.clear()
    tv.subscriptions.clear()
    if (tv.heartbeat) clearInterval(tv.heartbeat)
    tv.heartbeat = null
    if (tv.phase === 'prompt' && tv.pairTimer) clearTimeout(tv.pairTimer)
    if (tv.phase !== 'rejected') tv.phase = 'offline'
    tv.forgetSession()
    this.#emit(tv)
    if (!this.#stopped && tv.stored.key && tv.phase === 'offline') this.#scheduleReconnect(tv)
  }

  #scheduleReconnect(tv: Tv): void {
    if (tv.reconnectTimer || this.#stopped) return
    const delay = tv.backoff
    tv.backoff = Math.min(tv.backoff * 2, this.#options.maxReconnectMs)
    tv.reconnectTimer = setTimeout(() => {
      tv.reconnectTimer = null
      if (!this.#stopped && tv.stored.key && tv.phase === 'offline') void this.#connect(tv, 'resume')
    }, delay)
  }

  async #persist(): Promise<void> {
    await this.#context?.store.set(
      'tvs',
      [...this.#tvs.values()].map((tv) => ({ ...tv.stored }))
    )
  }

  // -------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------

  #on(tv: Tv): boolean {
    return tv.phase === 'ready' && isOn(tv.power === undefined ? null : tv.power, tv.appId)
  }

  #snapshot(tv: Tv): Record<string, unknown> {
    const on = this.#on(tv)
    const source = on ? currentSource(tv.sources, tv.appId) : null
    return {
      on,
      ...(tv.volume === null ? {} : { volume: tv.volume }),
      ...(tv.muted === null ? {} : { muted: tv.muted }),
      source,
      availableSources: tv.sources.map((entry) => entry.label),
      app: on ? source ?? tv.appId : null,
      playback: on ? tv.playback ?? 'idle' : 'idle',
    }
  }

  #emit(tv: Tv): void {
    this.#context?.emitState(tv.stored.nativeId, this.#snapshot(tv))
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const tv = this.#tvs.get(nativeId)
    return tv ? this.#snapshot(tv) : {}
  }

  // -------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const fail = (error: string): CommandResult => ({ ok: false, deviceId: nativeId, command, error })
    const tv = this.#tvs.get(nativeId)
    if (!tv) return fail('Téléviseur LG inconnu.')
    if (!tv.stored.key) return fail("Ce téléviseur n'est pas encore appairé : lancez l'appairage dans Intégrations.")

    const before = this.#snapshot(tv)
    const plan = commandActions(command, args, { on: before.on === true, screenOn: tv.power !== 'Screen Off', appId: tv.appId, volume: tv.volume, sources: tv.sources })
    if ('error' in plan) return fail(plan.error)

    for (const action of plan.actions) {
      if (action.kind === 'wake') {
        const problem = await this.#wake(tv)
        if (problem) return fail(problem)
        continue
      }
      if (tv.phase !== 'ready') return fail('Le téléviseur ne répond pas.')
      let answer: WebosMessage
      try {
        answer = await this.#request(tv, action.uri, action.payload ?? {})
      } catch (error) {
        return fail((error as Error).message)
      }
      const failure = failureOf(answer)
      if (failure) return fail(`Le téléviseur a refusé : ${failure}`)
    }

    if (typeof plan.expect?.volume === 'number') tv.volume = plan.expect.volume
    if (typeof plan.expect?.muted === 'boolean') tv.muted = plan.expect.muted
    return { ok: true, deviceId: nativeId, command, state: { ...this.#snapshot(tv), ...(plan.expect ?? {}) }, undo: undoFor(command, before) }
  }

  /** Wake-on-LAN, then reconnect quickly until the TV answers and says it is on. */
  async #wake(tv: Tv): Promise<string | null> {
    if (!tv.stored.mac) return 'Adresse MAC du téléviseur inconnue : impossible de le réveiller à distance. Allumez-le une fois et relancez un scan.'
    const targets = [broadcastAddress(this.#context?.network.cidr ?? '') ?? null, '255.255.255.255', tv.stored.ip].filter((target): target is string => target !== null)
    await this.#options.wake(tv.stored.mac, targets).catch(() => undefined)
    // In "Quick Start" standby the socket may still be open: then asking is enough.
    if (tv.phase === 'ready') await this.#request(tv, URI.turnOn).catch(() => null)

    const deadline = Date.now() + this.#options.wakeTimeoutMs
    while (Date.now() < deadline && !this.#stopped) {
      if (this.#on(tv)) return null
      if (tv.phase === 'offline') {
        tv.backoff = this.#options.reconnectMs
        await this.#connect(tv, 'resume')
        continue
      }
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())))
    }
    return this.#on(tv) ? null : WAKE_HELP
  }

  status(): AdapterStatus {
    const tvs = [...this.#tvs.values()]
    const deviceCount = tvs.length
    const rejected = tvs.find((tv) => tv.phase === 'rejected')
    if (rejected) return { health: 'degraded', message: rejected.message ?? 'Appairage refusé sur le téléviseur.', deviceCount }
    if (tvs.some((tv) => tv.phase === 'prompt')) return { health: 'needs_setup', message: 'Acceptez la demande affichée sur le téléviseur avec la télécommande.', deviceCount }
    const unpaired = tvs.filter((tv) => !tv.stored.key)
    if (unpaired.length > 0) return { health: 'needs_setup', message: `À appairer : ${unpaired.map((tv) => tv.stored.name).join(', ')}.`, deviceCount }
    return { health: 'ok', deviceCount }
  }

  async shutdown(): Promise<void> {
    this.#stopped = true
    for (const tv of this.#tvs.values()) {
      if (tv.reconnectTimer) clearTimeout(tv.reconnectTimer)
      if (tv.pairTimer) clearTimeout(tv.pairTimer)
      tv.reconnectTimer = null
      tv.pairTimer = null
      this.#closeSocket(tv)
    }
    this.#tvs.clear()
  }
}

function undoFor(command: string, before: Record<string, unknown>): CommandResult['undo'] {
  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'toggle':
      return { command: before.on === true ? 'turnOn' : 'turnOff', args: {} }
    case 'setVolume':
    case 'stepVolume':
      return typeof before.volume === 'number' ? { command: 'setVolume', args: { volume: before.volume } } : null
    case 'setMuted':
      return typeof before.muted === 'boolean' ? { command: 'setMuted', args: { muted: before.muted } } : null
    case 'setSource':
      return typeof before.source === 'string' ? { command: 'setSource', args: { source: before.source } } : null
    default:
      return null
  }
}
