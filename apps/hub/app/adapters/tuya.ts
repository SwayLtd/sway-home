/**
 * Tuya devices over the LAN (protocol 3.3, 3.4 and 3.5), without the Tuya cloud.
 *
 *  - **Found by their own announcements**: every Tuya device broadcasts its id, address and
 *    protocol version every few seconds (UDP 6666, 6667; 3.5 devices on 7000 when asked).
 *  - **The local key is the one thing to give**, per device, in the settings. It never
 *    leaves the hub and is never repeated in a message. A device announced without one shows
 *    up asking for it.
 *  - **One connection per device, kept open** (the devices accept few at a time), with a
 *    heartbeat every ten seconds. 3.4 and 3.5 agree on a session key first; a device that
 *    refuses that agreement twice has a wrong key, and the status says so.
 *  - **The state is pushed by the device**: the button on a plug shows up by itself.
 *  - **Data points become capabilities** by product kind (plug, switch, bulb, curtain),
 *    detected from the points the device reports or given in the settings.
 */

import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { connect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import type { AdapterContext, AdapterDescriptor, AdapterStatus, CommandResult, DeviceCategory, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { broadcastAddress } from '#adapters/wake_on_lan'
import {
  COMMAND,
  TUYA_PORT,
  TUYA_UDP_PORTS,
  TUYA_VERSIONS,
  TuyaReader,
  capabilitiesFor,
  commandFor,
  decodeBroadcast,
  decodeResponse,
  detectProfile,
  discoveryRequest,
  dpsForCommand,
  encodeRequest,
  negotiateFinish,
  negotiateStart,
  packFrame,
  parseLocalKeys,
  requestJson,
  stateFromDps,
  type Dps,
  type TuyaAnnounce,
  type TuyaDeviceConfig,
  type TuyaFrame,
  type TuyaProfile,
  type TuyaVersion,
} from '#adapters/tuya_codec'

export interface TuyaOptions {
  /** Ports announcements are heard on: 6666, 6667 and 7000. */
  udpPorts?: number[]
  /** Where the request that makes 3.5 devices speak goes. */
  broadcastPort?: number
  broadcastAddress?: string
  tcpPort?: number
  requestTimeoutMs?: number
  heartbeatMs?: number
  reconnectMs?: number
  maxReconnectMs?: number
  /** How long a scan listens for the announcements of devices not heard yet. */
  listenMs?: number
}

const KEYS_HELP =
  'Un objet JSON : {"id de l\'appareil": "clé locale"} ou {"id": {"key": "clé locale", "name": "Prise salon", "type": "plug"}}. Types : switch, plug, bulb, bulb_v1, cover. La clé se récupère une fois avec "python -m tinytuya wizard" ou sur la plateforme Tuya IoT.'

const CATEGORY: Record<TuyaProfile, DeviceCategory> = { switch: 'switch', plug: 'outlet', bulb: 'light', bulb_v1: 'light', cover: 'cover' }

/** Points asked for, by devices that want to be asked with a list (22-character ids). */
const COMMON_POINTS = ['1', '2', '3', '4', '5', '6', '9', '18', '19', '20', '21', '22', '23', '24', '25', '26']

interface Stored {
  ip: string
  version: TuyaVersion
  profile: TuyaProfile | null
}

type Phase = 'offline' | 'connecting' | 'ready' | 'wrong-key'

class Link {
  socket: Socket | null = null
  phase: Phase = 'offline'
  message: string | null = null
  sessionKey: Buffer | null = null
  seq = 1
  dps: Dps = {}
  profile: TuyaProfile | null
  device22 = false
  refusedQuery = false
  undecodable = false
  failedNegotiations = 0
  missedHeartbeats = 0
  waiters: { cmds: number[]; resolve: (frame: TuyaFrame | null) => void }[] = []
  connecting: Promise<boolean> | null = null
  heartbeat: ReturnType<typeof setInterval> | null = null
  reconnect: ReturnType<typeof setTimeout> | null = null
  backoff: number
  emitted = ''

  constructor(
    public config: TuyaDeviceConfig,
    public ip: string,
    public version: TuyaVersion,
    reconnectMs: number
  ) {
    this.profile = config.profile
    this.backoff = reconnectMs
  }

  get key(): Buffer {
    return Buffer.from(this.config.key, 'latin1')
  }

  get name(): string {
    return this.config.name ?? `Appareil Tuya ${this.config.id.slice(-4)}`
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class TuyaAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'tuya',
    name: 'Tuya local',
    vendor: 'Tuya',
    transports: ['wifi'],
    capabilities: ['onoff', 'brightness', 'colorTemperature', 'color', 'power', 'position'],
    zeroConfig: false,
    cloud: false,
    implemented: true,
    docsUrl: 'https://github.com/jasonacox/tinytuya',
    configSchema: [{ key: 'localKeys', label: 'Clés locales (JSON)', type: 'password', help: KEYS_HELP }],
  }

  readonly #options: Required<Omit<TuyaOptions, 'broadcastAddress'>> & { broadcastAddress: string | null }
  #context: AdapterContext | null = null
  #configs = new Map<string, TuyaDeviceConfig>()
  #configErrors: string[] = []
  #seen = new Map<string, TuyaAnnounce>()
  #stored = new Map<string, Stored>()
  #links = new Map<string, Link>()
  #udp: UdpSocket[] = []
  #stopped = false

  constructor(options: TuyaOptions = {}) {
    this.#options = {
      udpPorts: options.udpPorts ?? [...TUYA_UDP_PORTS],
      broadcastPort: options.broadcastPort ?? 7000,
      broadcastAddress: options.broadcastAddress ?? null,
      tcpPort: options.tcpPort ?? TUYA_PORT,
      requestTimeoutMs: options.requestTimeoutMs ?? 5000,
      heartbeatMs: options.heartbeatMs ?? 10_000,
      reconnectMs: options.reconnectMs ?? 3000,
      maxReconnectMs: options.maxReconnectMs ?? 60_000,
      listenMs: options.listenMs ?? 6000,
    }
  }

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#stopped = false
    const { devices, errors } = parseLocalKeys(typeof config.localKeys === 'string' ? config.localKeys : '')
    this.#configErrors = errors
    for (const device of devices) this.#configs.set(device.id, device)
    for (const [id, entry] of Object.entries((await context.store.get<Record<string, Stored>>('devices')) ?? {})) this.#stored.set(id, entry)

    for (const port of this.#options.udpPorts) {
      const socket = createSocket({ type: 'udp4', reuseAddr: true })
      socket.on('message', (message) => this.#onAnnouncement(message))
      socket.on('error', (error) => this.#context?.log('warn', 'Tuya UDP socket error', { port, error: error.message }))
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('error', reject)
          socket.bind(port, () => {
            socket.off('error', reject)
            resolve()
          })
        })
        socket.setBroadcast(true)
        this.#udp.push(socket)
      } catch (error) {
        this.#context?.log('warn', 'Tuya UDP port unavailable', { port, error: (error as Error).message })
        socket.close()
      }
    }

    for (const device of devices) {
      const stored = this.#stored.get(device.id)
      const ip = device.ip ?? stored?.ip
      const version = device.version ?? stored?.version
      if (ip && version) void this.#connect(this.#linkFor(device, ip, version))
    }
    this.#askToSpeak()
  }

  /** The UDP ports actually listened on (tests bind to free ports). */
  listeningPorts(): number[] {
    return this.#udp.map((socket) => socket.address().port)
  }

  #askToSpeak(): void {
    const socket = this.#udp[0]
    if (!socket || !this.#context) return
    const target = this.#options.broadcastAddress ?? broadcastAddress(this.#context.network.cidr) ?? '255.255.255.255'
    try {
      socket.send(discoveryRequest(this.#context.network.localIp), this.#options.broadcastPort, target)
    } catch (error) {
      this.#context.log('debug', 'Tuya discovery request failed', { error: (error as Error).message })
    }
  }

  #onAnnouncement(message: Buffer): void {
    const announce = decodeBroadcast(message)
    if (!announce) return
    this.#seen.set(announce.id, announce)
    const config = this.#configs.get(announce.id)
    if (!config) return
    const version = (config.version ?? (TUYA_VERSIONS.includes(announce.version as TuyaVersion) ? announce.version : '3.3')) as TuyaVersion
    const link = this.#links.get(announce.id)
    if (link && link.ip === (config.ip ?? announce.ip) && link.version === version) {
      if (link.phase === 'offline' && !link.reconnect) void this.#connect(link)
      return
    }
    if (link) this.#close(link)
    void this.#connect(this.#linkFor(config, config.ip ?? announce.ip, version))
  }

  #linkFor(config: TuyaDeviceConfig, ip: string, version: TuyaVersion): Link {
    const link = new Link(config, ip, version, this.#options.reconnectMs)
    link.profile ??= this.#stored.get(config.id)?.profile ?? null
    this.#links.set(config.id, link)
    return link
  }

  // -------------------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------------------

  async discover(_hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    this.#askToSpeak()
    const unknown = () => [...this.#configs.keys()].some((id) => !this.#links.has(id))
    const deadline = Date.now() + this.#options.listenMs
    while ((unknown() || (this.#seen.size === 0 && this.#configs.size === 0)) && Date.now() < deadline && !this.#stopped) await sleep(50)

    // A kind not given nor stored yet comes from the first status.
    await Promise.all(
      [...this.#links.values()].map(async (link) => {
        // A function, not a comparison: the phase changes while we wait, behind TypeScript's back.
        const refused = () => link.phase === 'wrong-key'
        if (link.profile || refused()) return
        await this.#connect(link)
        const until = Date.now() + this.#options.requestTimeoutMs
        while (!link.profile && Date.now() < until && !refused()) await sleep(20)
      })
    )

    const found: DiscoveredDevice[] = []
    for (const link of this.#links.values()) {
      const profile = link.profile
      this.#stored.set(link.config.id, { ip: link.ip, version: link.version, profile })
      found.push({
        adapterId: 'tuya',
        nativeId: link.config.id,
        uid: `tuya:${link.config.id}`,
        name: link.name,
        category: profile ? CATEGORY[profile] : 'unknown',
        capabilities: profile ? capabilitiesFor(profile, link.dps) : [],
        transport: 'wifi',
        manufacturer: 'Tuya',
        model: this.#seen.get(link.config.id)?.productKey ?? null,
        confidence: 0.9,
        network: { ip: link.ip },
        meta: { version: link.version },
        requiresPairing: null,
      })
    }
    for (const announce of this.#seen.values()) {
      if (this.#configs.has(announce.id)) continue
      found.push({
        adapterId: 'tuya',
        nativeId: announce.id,
        uid: `tuya:${announce.id}`,
        name: `Appareil Tuya ${announce.id.slice(-4)}`,
        category: 'unknown',
        capabilities: [],
        transport: 'wifi',
        manufacturer: 'Tuya',
        model: announce.productKey,
        confidence: 0.6,
        network: { ip: announce.ip },
        meta: { version: announce.version },
        requiresPairing: {
          kind: 'token',
          instructions: `Il faut la clé locale de l'appareil ${announce.id} : récupérez-la une fois (python -m tinytuya wizard, ou la plateforme Tuya IoT), puis ajoutez-la dans Intégrations > Tuya local.`,
        },
      })
    }
    await this.#context?.store.set('devices', Object.fromEntries(this.#stored))
    return found
  }

  // -------------------------------------------------------------------------------------
  // The connection
  // -------------------------------------------------------------------------------------

  #write(link: Link, cmd: number, payload: Buffer): void {
    const socket = link.socket
    if (!socket || socket.destroyed) return
    const key = link.sessionKey ?? link.key
    const frame =
      link.version === '3.5'
        ? packFrame({ format: '6699', seq: link.seq, cmd, payload, key })
        : packFrame({ format: '55aa', seq: link.seq, cmd, payload, key: link.version === '3.4' ? key : null })
    link.seq += 1
    socket.write(frame)
  }

  #await(link: Link, cmds: number[], timeoutMs = this.#options.requestTimeoutMs): Promise<TuyaFrame | null> {
    return new Promise((resolve) => {
      const waiter = {
        cmds,
        resolve: (frame: TuyaFrame | null) => {
          clearTimeout(timer)
          link.waiters = link.waiters.filter((entry) => entry !== waiter)
          resolve(frame)
        },
      }
      const timer = setTimeout(() => waiter.resolve(null), timeoutMs)
      link.waiters.push(waiter)
    })
  }

  #connect(link: Link): Promise<boolean> {
    if (link.phase === 'ready') return Promise.resolve(true)
    if (link.connecting) return link.connecting
    const attempt = this.#open(link).finally(() => {
      if (link.connecting === attempt) link.connecting = null
    })
    link.connecting = attempt
    return attempt
  }

  async #open(link: Link): Promise<boolean> {
    if (this.#stopped) return false
    if (link.reconnect) clearTimeout(link.reconnect)
    link.reconnect = null
    const wasWrongKey = link.phase === 'wrong-key'
    link.phase = 'connecting'

    const socket = await new Promise<Socket | null>((resolve) => {
      const candidate = connect({ host: link.ip, port: this.#options.tcpPort })
      const timer = setTimeout(() => {
        candidate.destroy()
        resolve(null)
      }, this.#options.requestTimeoutMs)
      candidate.once('connect', () => {
        clearTimeout(timer)
        resolve(candidate)
      })
      candidate.once('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
    })
    if (!socket || this.#stopped) {
      socket?.destroy()
      return this.#retry(link, wasWrongKey ? 'wrong-key' : 'offline', `${link.name} ne répond pas (${link.ip}).`)
    }

    link.socket = socket
    link.sessionKey = null
    link.seq = 1
    link.undecodable = false
    link.refusedQuery = false
    const reader = new TuyaReader({ key: () => link.sessionKey ?? link.key, hmac: link.version === '3.4', retcode: true })
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => {
      for (const frame of reader.read(chunk)) this.#onFrame(link, frame)
    })
    socket.on('error', () => undefined)
    socket.on('close', () => this.#onClose(link, socket))

    if (link.version !== '3.3') {
      const nonce = randomBytes(16)
      const answer = this.#await(link, [COMMAND.sessKeyNegResp])
      this.#write(link, COMMAND.sessKeyNegStart, negotiateStart(link.version, link.key, nonce))
      const frame = await answer
      const result = frame?.valid ? negotiateFinish(link.version, link.key, nonce, frame.payload) : null
      if (!result || 'error' in result) return this.#refused(link, socket)
      this.#write(link, COMMAND.sessKeyNegFinish, result.finish)
      link.sessionKey = result.sessionKey
    }

    if (!(await this.#query(link))) {
      if (link.undecodable || link.socket !== socket) return this.#refused(link, socket)
      socket.destroy()
      return this.#retry(link, 'offline', `${link.name} ne donne pas son état.`)
    }

    link.phase = 'ready'
    link.message = null
    link.failedNegotiations = 0
    link.backoff = this.#options.reconnectMs
    link.missedHeartbeats = 0
    if (link.heartbeat) clearInterval(link.heartbeat)
    link.heartbeat = setInterval(() => void this.#beat(link), this.#options.heartbeatMs)
    return true
  }

  /** The device would not agree on a key, or sent what the key cannot open. */
  #refused(link: Link, socket: Socket): boolean {
    socket.destroy()
    link.failedNegotiations += 1
    // Once can be a device busy with another app; twice in a row is the key.
    if (link.failedNegotiations >= 2) {
      return this.#retry(link, 'wrong-key', `${link.name} : la clé locale ne correspond pas à cet appareil (ou une autre application y est connectée).`)
    }
    return this.#retry(link, 'offline', `${link.name} refuse la connexion.`)
  }

  #retry(link: Link, phase: Phase, message: string): boolean {
    link.phase = phase
    link.message = message
    link.socket = null
    if (!this.#stopped && !link.reconnect) {
      const delay = link.backoff
      link.backoff = Math.min(link.backoff * 2, this.#options.maxReconnectMs)
      link.reconnect = setTimeout(() => {
        link.reconnect = null
        void this.#connect(link)
      }, delay)
    }
    return false
  }

  /** The device's status: a plain query, or with the list of points for the devices that want it. */
  async #query(link: Link): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const device22 = link.version === '3.3' && link.device22
      const cmd = device22 ? COMMAND.controlNew : commandFor(link.version, 'query')
      const json = device22
        ? { ...requestJson('3.3', 'control', link.config.id), dps: Object.fromEntries((Object.keys(link.dps).length > 0 ? Object.keys(link.dps) : COMMON_POINTS).map((point) => [point, null])) }
        : requestJson(link.version, 'query', link.config.id)
      const before = link.refusedQuery
      const answer = this.#await(link, [cmd, COMMAND.status, COMMAND.dpQuery, COMMAND.dpQueryNew, COMMAND.controlNew])
      this.#write(link, cmd, encodeRequest(link.version, cmd, json, link.sessionKey ?? link.key))
      const frame = await answer
      if (link.refusedQuery && !before && !link.device22) {
        link.device22 = true
        continue
      }
      if (frame && Object.keys(link.dps).length > 0) return true
      if (!frame) return false
      // An acknowledgement without points: the status follows in a push.
      const until = Date.now() + this.#options.requestTimeoutMs
      while (Object.keys(link.dps).length === 0 && Date.now() < until && link.socket) await sleep(20)
      return Object.keys(link.dps).length > 0
    }
    return false
  }

  #onFrame(link: Link, frame: TuyaFrame): void {
    if (!frame.valid) {
      link.undecodable = true
      return
    }
    let decoded: Record<string, unknown> | null = null
    if (frame.cmd !== COMMAND.sessKeyNegResp && frame.payload.length > 0) {
      decoded = decodeResponse(link.version, frame.payload, link.sessionKey ?? link.key)
      if (!decoded) link.undecodable = true
      else if (decoded.error === 'data unvalid') link.refusedQuery = true
      else if (decoded.dps && typeof decoded.dps === 'object') this.#absorb(link, decoded.dps as Dps)
    }
    if (frame.cmd === COMMAND.heartbeat) link.missedHeartbeats = 0
    for (const waiter of [...link.waiters]) if (waiter.cmds.includes(frame.cmd)) waiter.resolve(frame)
  }

  #absorb(link: Link, dps: Dps): void {
    Object.assign(link.dps, dps)
    link.profile ??= detectProfile(link.dps)
    this.#emit(link)
  }

  #emit(link: Link, state = link.profile ? stateFromDps(link.profile, link.dps) : {}): void {
    if (Object.keys(state).length === 0) return
    const serialised = JSON.stringify(state)
    if (serialised === link.emitted) return
    link.emitted = serialised
    this.#context?.emitState(link.config.id, state)
  }

  async #beat(link: Link): Promise<void> {
    if (link.phase !== 'ready') return
    const answer = this.#await(link, [COMMAND.heartbeat])
    this.#write(link, COMMAND.heartbeat, encodeRequest(link.version, COMMAND.heartbeat, requestJson(link.version, 'heartbeat', link.config.id), link.sessionKey ?? link.key))
    if (await answer) return
    link.missedHeartbeats += 1
    if (link.missedHeartbeats >= 2) link.socket?.destroy()
  }

  #onClose(link: Link, socket: Socket): void {
    if (link.socket !== socket) return
    link.socket = null
    if (link.heartbeat) clearInterval(link.heartbeat)
    link.heartbeat = null
    for (const waiter of [...link.waiters]) waiter.resolve(null)
    if (link.phase === 'ready') this.#retry(link, 'offline', `${link.name} a fermé la connexion.`)
  }

  #close(link: Link): void {
    if (link.heartbeat) clearInterval(link.heartbeat)
    if (link.reconnect) clearTimeout(link.reconnect)
    link.heartbeat = null
    link.reconnect = null
    link.socket?.destroy()
    link.socket = null
  }

  // -------------------------------------------------------------------------------------
  // Commands and state
  // -------------------------------------------------------------------------------------

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const link = this.#links.get(nativeId)
    return link?.profile ? stateFromDps(link.profile, link.dps) : {}
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const fail = (error: string): CommandResult => ({ ok: false, deviceId: nativeId, command, error })
    const link = this.#links.get(nativeId)
    if (!link) {
      if (this.#seen.has(nativeId) && !this.#configs.has(nativeId)) return fail("Clé locale manquante pour cet appareil Tuya : ajoutez-la dans Intégrations > Tuya local.")
      return fail(this.#configs.has(nativeId) ? "Adresse de l'appareil Tuya inconnue : il ne s'est pas encore annoncé sur le réseau." : 'Appareil Tuya inconnu.')
    }
    if (link.phase === 'wrong-key') return fail(link.message ?? 'La clé locale ne correspond pas à cet appareil.')
    if (!(await this.#connect(link))) return fail(link.message ?? `${link.name} ne répond pas.`)
    const profile = link.profile
    if (!profile) return fail(`Type de ${link.name} inconnu : précisez "type" dans les clés locales.`)

    const before = stateFromDps(profile, link.dps)
    const plan = dpsForCommand(profile, command, args, link.dps)
    if ('error' in plan) return fail(plan.error)
    const cmd = commandFor(link.version, 'control')
    const answer = this.#await(link, [cmd, COMMAND.status])
    this.#write(link, cmd, encodeRequest(link.version, cmd, requestJson(link.version, 'control', link.config.id, plan.dps), link.sessionKey ?? link.key))
    const frame = await answer
    if (!frame) return fail(`${link.name} ne répond pas.`)
    if (frame.retcode) return fail(`${link.name} a refusé la commande (code ${frame.retcode}).`)

    Object.assign(link.dps, plan.dps)
    const state = { ...stateFromDps(profile, link.dps), ...plan.expect }
    this.#emit(link, state)
    return { ok: true, deviceId: nativeId, command, state, undo: undoFor(command, before) }
  }

  status(): AdapterStatus {
    const links = [...this.#links.values()]
    const deviceCount = links.length
    if (this.#configErrors.length > 0) {
      const more = this.#configErrors.length > 1 ? ` (et ${this.#configErrors.length - 1} autre${this.#configErrors.length > 2 ? 's' : ''})` : ''
      return { health: 'degraded', message: `${this.#configErrors[0]}${more}`, deviceCount }
    }
    const refused = links.find((link) => link.phase === 'wrong-key')
    if (refused) return { health: 'degraded', message: refused.message ?? 'Clé locale incorrecte.', deviceCount }
    const withoutKey = [...this.#seen.keys()].filter((id) => !this.#configs.has(id))
    if (withoutKey.length > 0) {
      return { health: 'needs_setup', message: `${withoutKey.length} appareil${withoutKey.length > 1 ? 's' : ''} Tuya sans clé locale : ${withoutKey.join(', ')}.`, deviceCount }
    }
    const silent = [...this.#configs.values()].filter((config) => !this.#links.has(config.id))
    if (silent.length > 0) return { health: 'degraded', message: `Pas encore annoncé${silent.length > 1 ? 's' : ''} sur le réseau : ${silent.map((config) => config.name ?? config.id).join(', ')}.`, deviceCount }
    const offline = links.filter((link) => link.phase === 'offline' && link.message)
    if (offline.length > 0) return { health: 'degraded', message: offline.map((link) => link.message).join(' '), deviceCount }
    return { health: 'ok', deviceCount }
  }

  async shutdown(): Promise<void> {
    this.#stopped = true
    for (const link of this.#links.values()) this.#close(link)
    for (const socket of this.#udp) {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    }
    this.#udp = []
  }
}

function undoFor(command: string, before: Record<string, unknown>): CommandResult['undo'] {
  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'toggle':
      return typeof before.on === 'boolean' ? { command: before.on ? 'turnOn' : 'turnOff', args: {} } : null
    case 'setBrightness':
    case 'stepBrightness':
      return typeof before.brightness === 'number' ? { command: 'setBrightness', args: { brightness: before.brightness } } : null
    case 'setColorTemperature':
      return typeof before.colorTemperature === 'number' ? { command: 'setColorTemperature', args: { kelvin: before.colorTemperature } } : null
    case 'setColor':
    case 'setColorRgb':
    case 'setColorName':
      return typeof before.hue === 'number' && typeof before.saturation === 'number'
        ? { command: 'setColor', args: { hue: before.hue, saturation: before.saturation } }
        : typeof before.colorTemperature === 'number'
          ? { command: 'setColorTemperature', args: { kelvin: before.colorTemperature } }
          : null
    case 'open':
    case 'close':
    case 'setPosition':
      return typeof before.position === 'number' ? { command: 'setPosition', args: { position: before.position } } : null
    default:
      return null
  }
}
