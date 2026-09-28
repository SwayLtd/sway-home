/**
 * Samsung Tizen TVs (2016 and later), over their local remote channel.
 *
 *  - **Pairing** is one press on the remote. The first connection makes the TV ask
 *    "Autoriser ?"; once allowed, 2018 and later models hand back a token, kept in the
 *    adapter's store and sent on every later connection so the question never comes back.
 *    The adapter only connects without a token when someone presses "Appairer".
 *  - **State is read, not pushed.** The remote channel says nothing on its own, so power comes
 *    from `/api/v2/` (`PowerState`) and volume and mute from the UPnP renderer, polled. After
 *    the power key the TV keeps saying "on" while it winds down; that is not believed for a
 *    few seconds, so "éteins la télé" shows off at once.
 *  - **Volume is exact when the renderer answers** (9197, the TV only answers devices it
 *    allowed); otherwise it moves one key press at a time, and an exact level is refused
 *    with what to say instead.
 *  - **TLS first, and pinned**, as for LG: port 8002 before 8001, never back to clear once
 *    seen over TLS, and a TV showing another certificate does not get the token.
 *  - **On from standby** by Wake-on-LAN to the Wi-Fi MAC the TV reports about itself.
 *
 * Translation lives in `samsung_codec.ts`; this file is only the conversation.
 * 2014 and 2015 models (encrypted pairing with a PIN on port 8000) are not covered.
 */

import type { AdapterContext, AdapterDescriptor, AdapterStatus, CapabilityId, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import type { SocketLike } from '#adapters/homeassistant'
import { CertificateMismatchError, pinnedWebSocket, type Trust } from '#adapters/pinned_websocket'
import {
  APPS_REQUEST,
  RENDERER_PATH,
  RENDERING_CONTROL,
  SAMSUNG_PORTS,
  appsFrom,
  commandPlan,
  connectOutcome,
  keyMessages,
  launchMessage,
  muteFrom,
  parseDeviceInfo,
  parseEvent,
  remoteUrl,
  sourcesFrom,
  volumeFrom,
  type ConnectOutcome,
  type SamsungApp,
  type SamsungInfo,
  type SamsungSource,
  type SamsungStep,
} from '#adapters/samsung_codec'
import { soapEnvelope, soapFault } from '#adapters/soap_xml'
import { broadcastAddress, sendWakeOnLan } from '#adapters/wake_on_lan'

export interface SamsungOptions {
  connect?: (url: string, trust: Trust) => SocketLike
  ports?: { ws: number; wss: number; api: number; renderer: number }
  wake?: (mac: string, targets: string[]) => Promise<void>
  /** The name the TV shows in its question and in its list of allowed devices. */
  clientName?: string
  requestTimeoutMs?: number
  connectTimeoutMs?: number
  /** How long "Appairer" waits for an answer before telling the person to look at the TV. */
  promptTimeoutMs?: number
  /** How long the question stays open on the TV before the attempt is given up. */
  pairTimeoutMs?: number
  pollMs?: number
  /** After the power key, how long an "on" from the TV is not believed. */
  offGraceMs?: number
  wakeTimeoutMs?: number
  /** Pause between two keys: the TV drops keys that arrive too close together. */
  keyDelayMs?: number
  /** Scale for held keys; tests shorten the three seconds of a Frame TV's power key. */
  holdScale?: number
}

const CAPABILITIES: CapabilityId[] = ['onoff', 'volume', 'mediaPlayback', 'mediaSource']

const WAKE_HELP =
  'Le téléviseur ne s\'est pas allumé. Activez "Allumer depuis un appareil mobile" (Paramètres > Général > Réseau > Paramètres experts ; sur les modèles récents, Connexions > Réseau > Paramètres experts).'

interface StoredTv {
  nativeId: string
  ip: string
  mac: string | null
  name: string
  model: string | null
  /** Allowed on the TV: with a token (2018 and later), or by name (2016 and 2017). */
  paired: boolean
  token: string | null
  /** True once the TV has answered over TLS: from then on it is never asked in clear. */
  secure: boolean | null
  /** SHA-256 of its TLS certificate, kept at the first TLS contact. */
  certificate: string | null
  frame: boolean
  /** Installed apps as the TV last listed them: sources are known before any connection. */
  apps: SamsungApp[]
}

type Phase = 'offline' | 'connecting' | 'prompt' | 'ready' | 'rejected'
type Outcome = 'connected' | 'prompt' | 'refused' | 'unreachable' | 'certificate'
type Opened = { socket: SocketLike; early: { messages: unknown[]; closed: boolean } }

class Tv {
  socket: SocketLike | null = null
  phase: Phase = 'offline'
  message: string | null = null
  connecting: Promise<Outcome> | null = null
  /** Settles the attempt waiting for the TV's first answer. */
  settle: ((outcome: Outcome) => void) | null = null
  pairTimer: ReturnType<typeof setTimeout> | null = null
  on = false
  volume: number | null = null
  muted: boolean | null = null
  /** Whether the UPnP renderer answered last time; null before it was asked. */
  renderer: boolean | null = null
  /** The last source chosen from here: the TV does not say which one is showing. */
  source: string | null = null
  sources: SamsungSource[]
  /** Whether the TV listed its apps since this connection opened. */
  appsListed = false
  offUntil = 0
  emitted = ''

  constructor(public stored: StoredTv) {
    this.sources = sourcesFrom(stored.apps)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function normaliseMac(mac: string | null | undefined): string | null {
  const hex = (mac ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  return hex.length === 12 ? hex.match(/.{2}/g)!.join(':') : null
}

/** An SSDP description that can only be a Samsung TV, even one that does not answer now. */
function describesSamsungTv(host: NetworkHost): boolean {
  const ssdp = host.ssdp
  if (!ssdp) return false
  const text = [ssdp.server, ssdp.st, ssdp.friendlyName, ssdp.modelName].filter(Boolean).join(' ')
  return /samsung/i.test(text) && (/^\[TV\]/i.test(ssdp.friendlyName ?? '') || /RemoteControlReceiver|dial-multiscreen/i.test(ssdp.st ?? ''))
}

function looksLikeSamsungTv(host: NetworkHost): boolean {
  if (describesSamsungTv(host)) return true
  const ports = host.openPorts ?? []
  const remote = ports.includes(SAMSUNG_PORTS.ws) || ports.includes(SAMSUNG_PORTS.wss)
  return remote && [host.macVendor, host.hostname, host.ssdp?.server].some((value) => /samsung/i.test(value ?? ''))
}

function nameFromSsdp(host: NetworkHost): string {
  const friendly = host.ssdp?.friendlyName?.replace(/^\[TV\]\s*/i, '').trim()
  return friendly && friendly.length > 0 ? friendly : 'Téléviseur Samsung'
}

export class SamsungAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'samsungtv',
    name: 'Samsung TV',
    vendor: 'Samsung',
    transports: ['wifi', 'ethernet'],
    capabilities: CAPABILITIES,
    zeroConfig: true,
    cloud: false,
    implemented: true,
    docsUrl: 'https://github.com/xchwarze/samsung-tv-ws-api',
    configSchema: [],
  }

  readonly #options: Required<SamsungOptions>
  #context: AdapterContext | null = null
  #tvs = new Map<string, Tv>()
  #timer: ReturnType<typeof setInterval> | null = null
  #polling = false
  #stopped = false

  constructor(options: SamsungOptions = {}) {
    const connectTimeoutMs = options.connectTimeoutMs ?? 5000
    this.#options = {
      connect: options.connect ?? ((url, trust) => pinnedWebSocket(url, { ...trust, timeoutMs: connectTimeoutMs })),
      ports: options.ports ?? { ws: SAMSUNG_PORTS.ws, wss: SAMSUNG_PORTS.wss, api: SAMSUNG_PORTS.ws, renderer: SAMSUNG_PORTS.renderer },
      wake: options.wake ?? ((mac, targets) => sendWakeOnLan(mac, targets)),
      clientName: options.clientName ?? 'Sway Home',
      requestTimeoutMs: options.requestTimeoutMs ?? 3000,
      connectTimeoutMs,
      promptTimeoutMs: options.promptTimeoutMs ?? 4000,
      pairTimeoutMs: options.pairTimeoutMs ?? 60_000,
      pollMs: options.pollMs ?? 10_000,
      offGraceMs: options.offGraceMs ?? 15_000,
      wakeTimeoutMs: options.wakeTimeoutMs ?? 20_000,
      keyDelayMs: options.keyDelayMs ?? 150,
      holdScale: options.holdScale ?? 1,
    }
  }

  async init(context: AdapterContext, _config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#stopped = false
    const stored = (await context.store.get<StoredTv[]>('tvs')) ?? []
    for (const entry of stored) {
      this.#tvs.set(
        entry.nativeId,
        new Tv({ ...entry, paired: entry.paired ?? Boolean(entry.token), secure: entry.secure ?? null, certificate: entry.certificate ?? null, frame: entry.frame ?? false, apps: entry.apps ?? [] })
      )
    }
    this.#timer = setInterval(() => void this.#pollAll(), this.#options.pollMs)
    void this.#pollAll()
  }

  // -------------------------------------------------------------------------------------
  // Discovery and pairing
  // -------------------------------------------------------------------------------------

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    const candidates = hosts.filter(looksLikeSamsungTv)
    const infos = await Promise.all(candidates.map((host) => this.#deviceInfo(host.ip)))
    const found: DiscoveredDevice[] = []
    candidates.forEach((host, index) => {
      const info = infos[index] ?? null
      if (!info && !describesSamsungTv(host)) return
      const mac = info?.mac ?? normaliseMac(host.mac)
      let tv = [...this.#tvs.values()].find((candidate) => (mac && candidate.stored.mac === mac) || candidate.stored.ip === host.ip)
      if (!tv) {
        tv = new Tv({
          nativeId: mac ?? host.ip,
          ip: host.ip,
          mac,
          name: info?.name ?? nameFromSsdp(host),
          model: info?.model ?? host.ssdp?.modelName ?? null,
          paired: false,
          token: null,
          secure: null,
          certificate: null,
          frame: info?.frame ?? false,
          apps: [],
        })
        this.#tvs.set(tv.stored.nativeId, tv)
      } else {
        tv.stored.ip = host.ip
        tv.stored.mac ??= mac
        if (info) {
          tv.stored.frame = info.frame
          tv.stored.model = info.model ?? tv.stored.model
        }
      }
      found.push(this.#device(tv, host, info !== null))
    })
    await this.#persist()
    return found
  }

  #device(tv: Tv, host: NetworkHost, answered: boolean): DiscoveredDevice {
    const { stored } = tv
    return {
      adapterId: 'samsungtv',
      nativeId: stored.nativeId,
      uid: `samsungtv:${stored.nativeId}`,
      name: stored.name,
      category: 'display',
      capabilities: CAPABILITIES,
      transport: 'wifi',
      manufacturer: 'Samsung',
      model: stored.model,
      confidence: answered ? 0.95 : 0.75,
      network: { ip: stored.ip, mac: stored.mac, hostname: host.hostname ?? null },
      meta: { ip: stored.ip, mac: stored.mac, paired: stored.paired },
      requiresPairing: stored.paired
        ? null
        : { kind: 'button', instructions: "Dans Intégrations, Samsung TV : lancez l'appairage, puis choisissez Autoriser sur l'écran du téléviseur avec la télécommande." },
    }
  }

  async #deviceInfo(ip: string): Promise<SamsungInfo | null> {
    try {
      const response = await fetch(`http://${ip}:${this.#options.ports.api}/api/v2/`, { signal: AbortSignal.timeout(this.#options.requestTimeoutMs) })
      return response.ok ? parseDeviceInfo(await response.text()) : null
    } catch {
      return null
    }
  }

  async pair(input: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    if (this.#tvs.size === 0) return { ok: false, message: 'Aucun téléviseur Samsung trouvé : allumez-le, puis lancez un scan du réseau.' }
    const named = typeof input.nativeId === 'string' ? this.#tvs.get(input.nativeId) : typeof input.host === 'string' ? [...this.#tvs.values()].find((tv) => tv.stored.ip === input.host) : undefined
    const targets = named ? [named] : [...this.#tvs.values()].filter((tv) => !tv.stored.paired || tv.phase === 'rejected')
    if (targets.length === 0) return { ok: true, message: 'Les téléviseurs Samsung sont déjà appairés.' }

    const outcomes = await Promise.all(targets.map(async (tv) => ({ tv, outcome: await this.#startPairing(tv) })))
    const names = (outcome: Outcome) =>
      outcomes
        .filter((entry) => entry.outcome === outcome)
        .map(({ tv }) => tv.stored.name)
        .join(', ')
    const parts: string[] = []
    if (names('prompt')) parts.push(`Choisissez Autoriser sur ${names('prompt')} avec la télécommande. Acceptez la demande dans la minute.`)
    if (names('connected')) parts.push(`${names('connected')} : appairé.`)
    if (names('refused')) parts.push(`Appairage refusé sur ${names('refused')}.`)
    const silent = [...new Set([...names('unreachable').split(', '), ...names('certificate').split(', ')].filter(Boolean))].join(', ')
    if (silent) parts.push(`${silent} ne répond pas : allumez-le, puis relancez l'appairage.`)
    const ok = outcomes.some(({ outcome }) => outcome === 'prompt' || outcome === 'connected')
    return { ok, message: parts.join(' ') }
  }

  #startPairing(tv: Tv): Promise<Outcome> {
    this.#closeSocket(tv)
    tv.phase = 'offline'
    tv.message = null
    // Pairing is a person in front of the TV: whatever certificate it shows now is its own.
    tv.stored.certificate = null
    return this.#connect(tv, 'pair')
  }

  // -------------------------------------------------------------------------------------
  // The remote channel
  // -------------------------------------------------------------------------------------

  #connect(tv: Tv, mode: 'resume' | 'pair'): Promise<Outcome> {
    if (tv.phase === 'ready' && tv.socket) return Promise.resolve('connected')
    if (tv.phase === 'prompt') return Promise.resolve('prompt')
    if (tv.connecting) return tv.connecting
    const attempt = this.#attempt(tv, mode).finally(() => {
      if (tv.connecting === attempt) tv.connecting = null
    })
    tv.connecting = attempt
    return attempt
  }

  async #attempt(tv: Tv, mode: 'resume' | 'pair'): Promise<Outcome> {
    tv.phase = 'connecting'
    let opened: Opened
    try {
      opened = await this.#open(tv, mode === 'pair' ? null : tv.stored.token)
    } catch (error) {
      if (error instanceof CertificateMismatchError) {
        tv.phase = 'rejected'
        tv.message = `${tv.stored.name} présente un autre certificat que lors de l'appairage : je ne lui envoie plus son jeton. Si c'est bien lui (mise à jour, réparation), relancez l'appairage.`
        return 'certificate'
      }
      tv.phase = 'offline'
      return 'unreachable'
    }
    const { socket, early } = opened
    if (this.#stopped) {
      socket.close()
      tv.phase = 'offline'
      return 'unreachable'
    }

    tv.socket = socket
    const outcome = new Promise<Outcome>((resolve) => {
      // A known client is answered at once; no answer means the TV is asking on screen.
      const wait = mode === 'pair' ? this.#options.promptTimeoutMs : this.#options.connectTimeoutMs
      const timer = setTimeout(() => {
        if (tv.phase !== 'connecting') return
        tv.phase = 'prompt'
        tv.settle = null
        tv.pairTimer = setTimeout(() => {
          if (tv.phase !== 'prompt') return
          tv.phase = 'rejected'
          tv.message = `Demande restée sans réponse sur ${tv.stored.name}.`
          this.#closeSocket(tv)
        }, this.#options.pairTimeoutMs)
        resolve('prompt')
      }, wait)
      tv.settle = (result) => {
        clearTimeout(timer)
        tv.settle = null
        resolve(result)
      }
    })
    socket.onmessage = (event) => this.#onMessage(tv, event.data)
    socket.onclose = () => this.#onClose(tv, socket)
    socket.onerror = () => undefined
    for (const data of early.messages) this.#onMessage(tv, data)
    if (early.closed) this.#onClose(tv, socket)
    return outcome
  }

  /**
   * The TV speaks first (its answer to the connection comes right after the upgrade), so
   * whatever arrives before the real handlers are attached is kept for them.
   */
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
        reject(new Error('no answer'))
      }, this.#options.connectTimeoutMs)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve({ socket, early })
      }
      socket.onmessage = (event) => void early.messages.push(event.data)
      socket.onerror = (event) => {
        clearTimeout(timer)
        const cause = (event as { error?: unknown } | null)?.error
        reject(cause instanceof CertificateMismatchError ? cause : new Error('refused'))
      }
      socket.onclose = () => {
        clearTimeout(timer)
        early.closed = true
        reject(new Error('closed'))
      }
    })
  }

  /** TLS on 8002 first; 8001 in clear only for a TV that has never answered over TLS. */
  async #open(tv: Tv, token: string | null): Promise<Opened> {
    const order: ('ws' | 'wss')[] = tv.stored.secure ? ['wss'] : ['wss', 'ws']
    let last: Error | null = null
    for (const scheme of order) {
      const url = remoteUrl({ ip: tv.stored.ip, secure: scheme === 'wss', port: this.#options.ports[scheme], name: this.#options.clientName, token })
      try {
        const opened = await this.#dial(tv, url)
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

  #onMessage(tv: Tv, data: unknown): void {
    const message = parseEvent(data)
    if (!message) return
    const outcome = connectOutcome(message)
    if (outcome) return this.#onOutcome(tv, outcome)
    if (message.event === 'ed.installedApp.get') {
      const apps = appsFrom(message)
      tv.appsListed = true
      tv.sources = sourcesFrom(apps)
      if (JSON.stringify(apps) !== JSON.stringify(tv.stored.apps)) {
        tv.stored.apps = apps
        void this.#persist()
      }
      this.#emit(tv)
    }
  }

  #onOutcome(tv: Tv, outcome: ConnectOutcome): void {
    if (outcome.kind === 'connected') {
      if (tv.pairTimer) clearTimeout(tv.pairTimer)
      tv.pairTimer = null
      const changed = !tv.stored.paired || (outcome.token !== null && outcome.token !== tv.stored.token)
      tv.stored.paired = true
      if (outcome.token) tv.stored.token = outcome.token
      if (changed) void this.#persist()
      tv.phase = 'ready'
      tv.message = null
      tv.socket?.send(JSON.stringify(APPS_REQUEST))
      tv.settle?.('connected')
      void this.#poll(tv)
      return
    }
    // Errors on a working channel concern one command, not the connection.
    if (tv.phase === 'ready') {
      if (outcome.kind === 'error') this.#context?.log('warn', 'Samsung TV error', { tv: tv.stored.name, message: outcome.message })
      return
    }
    if (tv.pairTimer) clearTimeout(tv.pairTimer)
    tv.pairTimer = null
    if (outcome.kind === 'unauthorized') {
      tv.phase = 'rejected'
      tv.message = `${tv.stored.name} a refusé l'accès : relancez l'appairage dans Intégrations, puis choisissez Autoriser sur l'écran.`
      tv.stored.paired = false
      tv.stored.token = null
      void this.#persist()
      tv.settle?.('refused')
    } else {
      tv.phase = 'offline'
      tv.settle?.('unreachable')
    }
    this.#closeSocket(tv)
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
    tv.appsListed = false
    if (tv.phase !== 'rejected') tv.phase = 'offline'
    if (tv.pairTimer) clearTimeout(tv.pairTimer)
    tv.pairTimer = null
    tv.settle?.('unreachable')
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

  async #pollAll(): Promise<void> {
    if (this.#polling || this.#stopped) return
    this.#polling = true
    try {
      await Promise.all([...this.#tvs.values()].map((tv) => this.#poll(tv)))
    } finally {
      this.#polling = false
    }
  }

  async #poll(tv: Tv): Promise<void> {
    const info = await this.#deviceInfo(tv.stored.ip)
    if (this.#stopped) return
    // Reachable without a PowerState (2016, 2017) means on; standby answers on newer models.
    let on = info !== null && info.power !== 'standby'
    if (Date.now() < tv.offUntil) on = false
    if (info) tv.stored.frame = info.frame
    tv.on = on
    if (on && tv.stored.paired) {
      const [volume, mute] = await Promise.all([this.#renderer(tv, 'GetVolume', { InstanceID: 0, Channel: 'Master' }), this.#renderer(tv, 'GetMute', { InstanceID: 0, Channel: 'Master' })])
      tv.renderer = 'xml' in volume
      if ('xml' in volume) tv.volume = volumeFrom(volume.xml) ?? tv.volume
      if ('xml' in mute) tv.muted = muteFrom(mute.xml) ?? tv.muted
    }
    if (!on) tv.source = null
    this.#emit(tv)
  }

  async #renderer(tv: Tv, action: string, args: Record<string, string | number>): Promise<{ xml: string } | { error: string }> {
    try {
      const response = await fetch(`http://${tv.stored.ip}:${this.#options.ports.renderer}${RENDERER_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${RENDERING_CONTROL}#${action}"` },
        body: soapEnvelope(RENDERING_CONTROL, action, args),
        signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
      })
      const xml = await response.text()
      const fault = soapFault(xml)
      if (fault) return { error: `${fault.code} ${fault.message}` }
      return response.ok ? { xml } : { error: `HTTP ${response.status}` }
    } catch {
      return { error: 'pas de réponse' }
    }
  }

  #snapshot(tv: Tv): Record<string, unknown> {
    return {
      on: tv.on,
      ...(tv.volume === null ? {} : { volume: tv.volume }),
      ...(tv.muted === null ? {} : { muted: tv.muted }),
      source: tv.on ? tv.source : null,
      availableSources: tv.sources.map((source) => source.label),
    }
  }

  #emit(tv: Tv): void {
    const snapshot = this.#snapshot(tv)
    const serialised = JSON.stringify(snapshot)
    if (serialised === tv.emitted) return
    tv.emitted = serialised
    this.#context?.emitState(tv.stored.nativeId, snapshot)
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
    if (!tv) return fail('Téléviseur Samsung inconnu.')
    if (!tv.stored.paired) return fail("Ce téléviseur n'est pas encore appairé : lancez l'appairage dans Intégrations.")

    const before = this.#snapshot(tv)
    const planFor = () => commandPlan(command, args, { on: tv.on, volume: tv.volume, muted: tv.muted, renderer: tv.renderer === true, frame: tv.stored.frame, sources: tv.sources })
    let plan = planFor()
    if ('error' in plan && command === 'setSource' && tv.on && !tv.appsListed) {
      // An app installed since the TV last listed them: ask again before saying it is not there.
      const problem = await this.#ready(tv)
      if (problem) return fail(problem)
      const deadline = Date.now() + this.#options.requestTimeoutMs
      while (!tv.appsListed && Date.now() < deadline) await sleep(20)
      plan = planFor()
    }
    if ('error' in plan) return fail(plan.error)

    for (const [index, step] of plan.steps.entries()) {
      const problem = await this.#run(tv, step)
      if (problem) return fail(problem)
      if (index < plan.steps.length - 1 && this.#options.keyDelayMs > 0) await sleep(this.#options.keyDelayMs)
    }

    const expected = plan.expect ?? {}
    if (expected.on === false) {
      tv.offUntil = Date.now() + this.#options.offGraceMs
      tv.on = false
    }
    if (expected.on === true) {
      tv.offUntil = 0
      tv.on = true
    }
    if (typeof expected.volume === 'number') tv.volume = expected.volume
    if (typeof expected.muted === 'boolean') tv.muted = expected.muted
    if (typeof expected.source === 'string') tv.source = expected.source
    this.#emit(tv)
    return { ok: true, deviceId: nativeId, command, state: this.#snapshot(tv), undo: undoFor(command, before) }
  }

  async #run(tv: Tv, step: SamsungStep): Promise<string | null> {
    switch (step.kind) {
      case 'wake':
        return this.#wake(tv)
      case 'renderer': {
        const answer = await this.#renderer(tv, step.action, step.args)
        return 'xml' in answer ? null : `Le téléviseur a refusé : ${answer.error}`
      }
      case 'key': {
        const problem = await this.#ready(tv)
        if (problem) return problem
        for (const message of keyMessages(step.key, step.holdSeconds)) {
          if ('pauseMs' in message) await sleep(message.pauseMs * this.#options.holdScale)
          else tv.socket?.send(JSON.stringify(message))
        }
        return null
      }
      case 'launch': {
        const problem = await this.#ready(tv)
        if (problem) return problem
        tv.socket?.send(JSON.stringify(launchMessage(step, step.metaTag)))
        return null
      }
    }
  }

  /** The remote channel open and allowed, or what stands in the way. */
  async #ready(tv: Tv): Promise<string | null> {
    switch (await this.#connect(tv, 'resume')) {
      case 'connected':
        return null
      case 'prompt':
        return 'Le téléviseur demande une autorisation : choisissez Autoriser avec la télécommande, puis réessayez.'
      case 'refused':
        return "Le téléviseur a refusé la connexion : relancez l'appairage dans Intégrations."
      case 'certificate':
        return tv.message ?? 'Le téléviseur présente un certificat inattendu.'
      default:
        return 'Le téléviseur ne répond pas.'
    }
  }

  /** Wake-on-LAN, repeated, until the TV says it is on. */
  async #wake(tv: Tv): Promise<string | null> {
    if (!tv.stored.mac) return 'Adresse MAC du téléviseur inconnue : impossible de le réveiller à distance. Allumez-le une fois et relancez un scan.'
    tv.offUntil = 0
    const targets = [broadcastAddress(this.#context?.network.cidr ?? '') ?? null, '255.255.255.255', tv.stored.ip].filter((target): target is string => target !== null)
    const deadline = Date.now() + this.#options.wakeTimeoutMs
    let nextPacket = 0
    while (Date.now() < deadline && !this.#stopped) {
      if (Date.now() >= nextPacket) {
        await this.#options.wake(tv.stored.mac, targets).catch(() => undefined)
        nextPacket = Date.now() + 2000
      }
      const info = await this.#deviceInfo(tv.stored.ip)
      if (info && info.power !== 'standby') {
        tv.on = true
        void this.#poll(tv)
        return null
      }
      await sleep(Math.min(250, Math.max(0, deadline - Date.now())))
    }
    return WAKE_HELP
  }

  status(): AdapterStatus {
    const tvs = [...this.#tvs.values()]
    const deviceCount = tvs.length
    const rejected = tvs.find((tv) => tv.phase === 'rejected')
    if (rejected) return { health: 'degraded', message: rejected.message ?? 'Appairage refusé sur le téléviseur.', deviceCount }
    if (tvs.some((tv) => tv.phase === 'prompt')) return { health: 'needs_setup', message: "Choisissez Autoriser sur l'écran du téléviseur avec la télécommande.", deviceCount }
    const unpaired = tvs.filter((tv) => !tv.stored.paired)
    if (unpaired.length > 0) return { health: 'needs_setup', message: `À appairer : ${unpaired.map((tv) => tv.stored.name).join(', ')}.`, deviceCount }
    return { health: 'ok', deviceCount }
  }

  async shutdown(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    for (const tv of this.#tvs.values()) {
      if (tv.pairTimer) clearTimeout(tv.pairTimer)
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
