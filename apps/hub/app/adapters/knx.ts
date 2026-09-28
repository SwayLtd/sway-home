/**
 * KNX, through a KNXnet/IP interface or router (tunnelling over UDP 3671).
 *
 *  - **The gateway is found by itself**: a search on the KNX multicast group, unless its
 *    address is given in the settings. A gateway has only a few tunnels (often one to four),
 *    so no tunnel is held until there is a map of group addresses to use it for.
 *  - **The map comes from ETS**, written once in the settings: each group address with its
 *    role for a device (see `parseKnxPoints`). Mistakes are said with the point's number.
 *  - **The state is heard, not polled.** Every status address is read once when the tunnel
 *    opens; after that the bus tells: a push button on the wall, a scene, a timer, all show
 *    up as they happen.
 *  - **A command is confirmed or it failed.** Each telegram waits for the gateway's
 *    acknowledgement (1 s, repeated once, as the standard says) and then for the bus's
 *    confirmation (L_Data.con); a telegram nobody took is a failed command, with a reason.
 *  - **Heartbeat every minute** (CONNECTIONSTATE_REQUEST, three tries): a gateway that
 *    restarts or forgets the tunnel is reconnected by itself, with backoff.
 *
 * KNX IP Secure (encrypted tunnels) is not covered.
 */

import { createSocket, type Socket } from 'node:dgram'
import type { AdapterContext, AdapterDescriptor, AdapterStatus, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import {
  KNX_MULTICAST,
  KNX_PORT,
  KNX_SERVICE,
  commandTelegrams,
  connectRequest,
  connectionStateRequest,
  decodeCemi,
  devicesFrom,
  disconnectRequest,
  disconnectResponse,
  groupRead,
  groupWrite,
  heardOn,
  parseFrame,
  parseKnxPoints,
  parseSearchResponse,
  searchRequest,
  stateFrom,
  statusMessage,
  tunnellingAck,
  tunnellingRequest,
  type Endpoint,
  type GroupTelegram,
  type KnxDevice,
  type KnxFrame,
  type KnxGateway,
} from '#adapters/knx_codec'

export interface KnxOptions {
  /** Where searches go: the KNX multicast group; tests aim at a gateway directly. */
  searchTargets?: Endpoint[]
  searchMs?: number
  requestTimeoutMs?: number
  ackTimeoutMs?: number
  confirmTimeoutMs?: number
  heartbeatMs?: number
  reconnectMs?: number
  maxReconnectMs?: number
  /** Pause between two reads when the tunnel opens: the bus carries a few dozen telegrams a second. */
  readSpacingMs?: number
  /** The address the gateway answers to; the hub's own address on the LAN by default. */
  localIp?: string
}

type Phase = 'starting' | 'no-gateway' | 'idle' | 'connecting' | 'ready' | 'failed'

const POINTS_HELP =
  'Une liste JSON, un objet par adresse de groupe : {"device": "Plafonnier salon", "role": "onoff", "write": "1/1/1", "status": "1/1/2"}. Rôles : onoff, brightness, position, stop, setpoint, temperature, humidity, illuminance, power, energy, contact, motion. "dpt" est facultatif ("9.001"...).'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function parseEndpoint(text: unknown): Endpoint | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null
  const match = /^(?:[a-z]+:\/\/)?([^:/\s]+)(?::(\d{1,5}))?\/?$/i.exec(text.trim())
  return match ? { ip: match[1]!, port: match[2] ? Number(match[2]) : KNX_PORT } : null
}

export class KnxAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'knx',
    name: 'KNX',
    vendor: 'KNX Association',
    transports: ['knx'],
    capabilities: ['onoff', 'brightness', 'position', 'thermostat', 'temperature', 'humidity', 'illuminance', 'power', 'energy', 'contact', 'motion'],
    zeroConfig: false,
    cloud: false,
    implemented: true,
    requiresHardware: 'Une interface ou un routeur KNX IP',
    docsUrl: 'https://www.knx.org/knx-en/for-professionals/Standard/',
    configSchema: [
      { key: 'points', label: 'Adresses de groupe (JSON)', type: 'text', help: POINTS_HELP },
      { key: 'gateway', label: 'Passerelle KNX IP', type: 'host', placeholder: '192.168.1.40', help: 'Laisser vide : la passerelle est cherchée sur le réseau.' },
    ],
  }

  readonly #options: Required<Omit<KnxOptions, 'localIp'>> & { localIp: string | null }
  #context: AdapterContext | null = null
  #socket: Socket | null = null
  #devices: KnxDevice[] = []
  #configErrors: string[] = []
  #fixedGateway: Endpoint | null = null
  #gateway: { endpoint: Endpoint; name: string } | null = null
  #dataEndpoint: Endpoint | null = null
  #channel: number | null = null
  #sendSequence = 0
  #receiveSequence = 0
  #phase: Phase = 'starting'
  #message: string | null = null
  #heard = new Map<number, Buffer>()
  #emitted = new Map<string, string>()
  #waiting = new Map<number, (frame: KnxFrame) => void>()
  #searchResults: ((gateway: KnxGateway) => void) | null = null
  #ack: { sequence: number; resolve: (status: number | null) => void } | null = null
  #confirm: { destination: number; resolve: (telegram: GroupTelegram | null) => void } | null = null
  #queue: Promise<unknown> = Promise.resolve()
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #reconnect: ReturnType<typeof setTimeout> | null = null
  #backoff: number
  #stopped = false

  constructor(options: KnxOptions = {}) {
    this.#options = {
      searchTargets: options.searchTargets ?? [{ ip: KNX_MULTICAST, port: KNX_PORT }],
      searchMs: options.searchMs ?? 2000,
      requestTimeoutMs: options.requestTimeoutMs ?? 3000,
      ackTimeoutMs: options.ackTimeoutMs ?? 1000,
      confirmTimeoutMs: options.confirmTimeoutMs ?? 3000,
      heartbeatMs: options.heartbeatMs ?? 60_000,
      reconnectMs: options.reconnectMs ?? 5000,
      maxReconnectMs: options.maxReconnectMs ?? 60_000,
      readSpacingMs: options.readSpacingMs ?? 50,
      localIp: options.localIp ?? null,
    }
    this.#backoff = this.#options.reconnectMs
  }

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#stopped = false
    const { points, errors } = parseKnxPoints(typeof config.points === 'string' ? config.points : '')
    this.#devices = devicesFrom(points)
    this.#configErrors = errors
    this.#fixedGateway = parseEndpoint(config.gateway)

    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('message', (message, remote) => this.#onDatagram(message, { ip: remote.address, port: remote.port }))
    socket.on('error', (error) => this.#context?.log('warn', 'KNX socket error', { error: error.message }))
    await new Promise<void>((resolve) => socket.bind(0, resolve))
    this.#socket = socket
    void this.#start()
  }

  get #local(): Endpoint {
    return { ip: this.#options.localIp ?? this.#context?.network.localIp ?? '0.0.0.0', port: this.#socket?.address().port ?? 0 }
  }

  #send(frame: Buffer, to: Endpoint): void {
    if (!this.#socket || this.#stopped) return
    try {
      this.#socket.send(frame, to.port, to.ip)
    } catch (error) {
      this.#context?.log('warn', 'KNX send failed', { error: (error as Error).message })
    }
  }

  // -------------------------------------------------------------------------------------
  // Finding the gateway
  // -------------------------------------------------------------------------------------

  async #start(): Promise<void> {
    if (this.#fixedGateway) {
      this.#gateway = { endpoint: this.#fixedGateway, name: this.#fixedGateway.ip }
    } else {
      const found = await this.#search()
      if (this.#stopped) return
      if (!found) {
        this.#phase = 'no-gateway'
        this.#message = 'Aucune passerelle KNX trouvée : indiquez son adresse IP dans les réglages.'
        return
      }
      this.#gateway = { endpoint: found.endpoint, name: found.name || found.endpoint.ip }
    }
    if (this.#devices.length === 0) {
      this.#phase = 'idle'
      this.#message = `Passerelle ${this.#gateway.name} trouvée : ajoutez les adresses de groupe de votre projet ETS.`
      return
    }
    await this.#connect()
  }

  /** The first gateway that tunnels, among those answering a search. */
  async #search(): Promise<KnxGateway | null> {
    const found: KnxGateway[] = []
    this.#searchResults = (gateway) => found.push(gateway)
    for (const target of this.#options.searchTargets) this.#send(searchRequest(this.#local), target)
    const deadline = Date.now() + this.#options.searchMs
    while (Date.now() < deadline && !this.#stopped && !found.some((gateway) => gateway.tunnelling)) await sleep(20)
    this.#searchResults = null
    return found.find((gateway) => gateway.tunnelling) ?? null
  }

  // -------------------------------------------------------------------------------------
  // The tunnel
  // -------------------------------------------------------------------------------------

  /** Sends a frame and waits for the answer of the given service, or null after the delay. */
  #request(frame: Buffer, answer: number, to: Endpoint): Promise<KnxFrame | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(answer)
        resolve(null)
      }, this.#options.requestTimeoutMs)
      this.#waiting.set(answer, (frame) => {
        clearTimeout(timer)
        this.#waiting.delete(answer)
        resolve(frame)
      })
      this.#send(frame, to)
    })
  }

  async #connect(): Promise<void> {
    const gateway = this.#gateway
    if (!gateway || this.#stopped) return
    this.#phase = 'connecting'
    const answer = await this.#request(connectRequest(this.#local), KNX_SERVICE.connectResponse, gateway.endpoint)
    if (this.#stopped) return
    if (!answer || answer.service !== KNX_SERVICE.connectResponse) return this.#failed(`La passerelle ${gateway.name} ne répond pas.`)
    if (answer.status !== 0) return this.#failed(`Passerelle ${gateway.name} : ${statusMessage(answer.status)}.`)

    this.#channel = answer.channel
    this.#dataEndpoint = answer.dataEndpoint && answer.dataEndpoint.ip !== '0.0.0.0' && answer.dataEndpoint.port !== 0 ? answer.dataEndpoint : gateway.endpoint
    this.#sendSequence = 0
    this.#receiveSequence = 0
    this.#phase = 'ready'
    this.#message = null
    this.#backoff = this.#options.reconnectMs
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = setInterval(() => void this.#checkAlive(), this.#options.heartbeatMs)
    void this.#readAll()
  }

  #failed(message: string): void {
    this.#phase = 'failed'
    this.#message = message
    this.#scheduleReconnect()
  }

  async #checkAlive(): Promise<void> {
    const gateway = this.#gateway
    const channel = this.#channel
    if (!gateway || channel === null || this.#phase !== 'ready') return
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await this.#request(connectionStateRequest(channel, this.#local), KNX_SERVICE.connectionStateResponse, gateway.endpoint)
      if (this.#channel !== channel) return
      if (answer?.service === KNX_SERVICE.connectionStateResponse) {
        if (answer.status === 0) return
        return this.#lost(`Passerelle ${gateway.name} : ${statusMessage(answer.status)}.`)
      }
    }
    this.#lost(`La passerelle ${gateway.name} ne répond plus.`)
  }

  #lost(message: string): void {
    this.#channel = null
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
    this.#ack?.resolve(null)
    this.#confirm?.resolve(null)
    this.#failed(message)
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnect) return
    const delay = this.#backoff
    this.#backoff = Math.min(this.#backoff * 2, this.#options.maxReconnectMs)
    this.#reconnect = setTimeout(() => {
      this.#reconnect = null
      void this.#connect()
    }, delay)
  }

  /** Every status address read once, so the app starts from the bus's real state. */
  async #readAll(): Promise<void> {
    const addresses = [...new Set(this.#devices.flatMap((device) => device.points.map(heardOn)).filter((address): address is number => address !== null))]
    for (const address of addresses) {
      if (this.#phase !== 'ready' || this.#stopped) return
      await this.#telegram(groupRead(address), address).catch(() => undefined)
      if (this.#options.readSpacingMs > 0) await sleep(this.#options.readSpacingMs)
    }
  }

  /** One telegram through the tunnel: acknowledged by the gateway, then confirmed by the bus. */
  #telegram(cemi: Buffer, destination: number): Promise<void> {
    const run = this.#queue.then(() => this.#transmit(cemi, destination))
    this.#queue = run.catch(() => undefined)
    return run
  }

  async #transmit(cemi: Buffer, destination: number): Promise<void> {
    const channel = this.#channel
    const data = this.#dataEndpoint
    if (this.#phase !== 'ready' || channel === null || !data) throw new Error(`La passerelle KNX n'est pas connectée${this.#message ? ` (${this.#message})` : ''}.`)
    const sequence = this.#sendSequence
    const confirmed = new Promise<GroupTelegram | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), this.#options.ackTimeoutMs * 2 + this.#options.confirmTimeoutMs)
      this.#confirm = {
        destination,
        resolve: (telegram) => {
          clearTimeout(timer)
          this.#confirm = null
          resolve(telegram)
        },
      }
    })

    let acknowledged = false
    for (let attempt = 0; attempt < 2 && !acknowledged; attempt++) {
      const status = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), this.#options.ackTimeoutMs)
        this.#ack = {
          sequence,
          resolve: (value) => {
            clearTimeout(timer)
            this.#ack = null
            resolve(value)
          },
        }
        this.#send(tunnellingRequest(channel, sequence, cemi), data)
      })
      if (status === null) continue
      if (status !== 0) {
        this.#confirm?.resolve(null)
        throw new Error(`Passerelle KNX : ${statusMessage(status)}.`)
      }
      acknowledged = true
    }
    if (!acknowledged) {
      this.#confirm?.resolve(null)
      this.#lost("La passerelle KNX n'acquitte plus les envois.")
      throw new Error("La passerelle KNX n'a pas acquitté l'envoi.")
    }
    this.#sendSequence = (sequence + 1) & 0xff

    const confirmation = await confirmed
    if (!confirmation) throw new Error("Le bus KNX n'a pas confirmé l'envoi.")
    if (confirmation.confirmError) throw new Error("Le bus KNX n'a pas confirmé l'envoi : aucun appareil ne l'a pris sur cette adresse.")
  }

  #onDatagram(message: Buffer, remote: Endpoint): void {
    if (message.length >= 4 && message.readUInt16BE(2) === KNX_SERVICE.searchResponse) {
      const gateway = parseSearchResponse(message)
      if (gateway && this.#searchResults) {
        const endpoint = gateway.endpoint.ip === '0.0.0.0' || gateway.endpoint.port === 0 ? remote : gateway.endpoint
        this.#searchResults({ ...gateway, endpoint })
      }
      return
    }
    const frame = parseFrame(message)
    if (!frame) return
    switch (frame.service) {
      case KNX_SERVICE.tunnellingAck:
        if (frame.channel === this.#channel && this.#ack?.sequence === frame.sequence) this.#ack.resolve(frame.status)
        return
      case KNX_SERVICE.tunnellingRequest:
        return this.#onTunnelled(frame.channel, frame.sequence, frame.cemi)
      case KNX_SERVICE.disconnectRequest:
        if (frame.channel !== this.#channel) return
        this.#send(disconnectResponse(frame.channel), remote)
        return this.#lost(`La passerelle ${this.#gateway?.name ?? 'KNX'} a fermé la connexion.`)
      default:
        this.#waiting.get(frame.service)?.(frame)
    }
  }

  #onTunnelled(channel: number, sequence: number, cemi: Buffer): void {
    if (channel !== this.#channel || !this.#dataEndpoint) return
    const expected = this.#receiveSequence
    if (sequence === ((expected - 1) & 0xff)) {
      // Our acknowledgement was lost: acknowledged again, not handled twice.
      this.#send(tunnellingAck(channel, sequence), this.#dataEndpoint)
      return
    }
    if (sequence !== expected) return
    this.#send(tunnellingAck(channel, sequence), this.#dataEndpoint)
    this.#receiveSequence = (expected + 1) & 0xff

    const telegram = decodeCemi(cemi)
    if (!telegram) return
    if (telegram.code === 'confirmation') {
      if (this.#confirm?.destination === telegram.destination) this.#confirm.resolve(telegram)
      return
    }
    if (telegram.code !== 'indication' || telegram.service === 'read') return
    this.#heard.set(telegram.destination, telegram.data)
    for (const device of this.#devices) {
      if (device.points.some((point) => heardOn(point) === telegram.destination || point.write === telegram.destination)) this.#emit(device)
    }
  }

  #emit(device: KnxDevice, state = stateFrom(device, this.#heard)): void {
    if (Object.keys(state).length === 0) return
    const serialised = JSON.stringify(state)
    if (this.#emitted.get(device.id) === serialised) return
    this.#emitted.set(device.id, serialised)
    this.#context?.emitState(device.id, state)
  }

  // -------------------------------------------------------------------------------------
  // The adapter contract
  // -------------------------------------------------------------------------------------

  async discover(_hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    // A scan is a good moment to look again for a gateway that was not there before.
    if (this.#phase === 'no-gateway' && !this.#stopped) void this.#start()
    return this.#devices.map((device) => ({
      adapterId: 'knx',
      nativeId: device.id,
      uid: `knx:${device.id}`,
      name: device.name,
      category: device.category,
      capabilities: device.capabilities,
      transport: 'knx',
      confidence: 1,
      meta: { addresses: device.points.length },
      requiresPairing: null,
    }))
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const device = this.#devices.find((entry) => entry.id === nativeId)
    return device ? stateFrom(device, this.#heard) : {}
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const fail = (error: string): CommandResult => ({ ok: false, deviceId: nativeId, command, error })
    const device = this.#devices.find((entry) => entry.id === nativeId)
    if (!device) return fail('Appareil KNX inconnu.')
    const before = stateFrom(device, this.#heard)
    const plan = commandTelegrams(device, command, args, before)
    if ('error' in plan) return fail(plan.error)

    for (const write of plan.writes) {
      try {
        await this.#telegram(groupWrite(write.address, write.data, write.small), write.address)
      } catch (error) {
        return fail((error as Error).message)
      }
      this.#heard.set(write.address, write.data)
    }
    const state = { ...stateFrom(device, this.#heard), ...plan.expect }
    this.#emit(device, state)
    return { ok: true, deviceId: nativeId, command, state, undo: undoFor(command, before) }
  }

  status(): AdapterStatus {
    const deviceCount = this.#devices.length
    if (this.#configErrors.length > 0) {
      const more = this.#configErrors.length > 1 ? ` (et ${this.#configErrors.length - 1} autre${this.#configErrors.length > 2 ? 's' : ''})` : ''
      return { health: 'degraded', message: `${this.#configErrors[0]}${more}`, deviceCount }
    }
    switch (this.#phase) {
      case 'ready':
        return { health: 'ok', deviceCount }
      case 'no-gateway':
      case 'idle':
        return { health: 'needs_setup', message: this.#message ?? undefined, deviceCount }
      case 'starting':
      case 'connecting':
        return { health: 'degraded', message: this.#message ?? 'Connexion à la passerelle KNX...', deviceCount }
      default:
        return { health: 'degraded', message: this.#message ?? 'Passerelle KNX injoignable.', deviceCount }
    }
  }

  async shutdown(): Promise<void> {
    if (this.#stopped) return
    const gateway = this.#gateway
    const channel = this.#channel
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    if (this.#reconnect) clearTimeout(this.#reconnect)
    this.#heartbeat = null
    this.#reconnect = null
    if (gateway && channel !== null) {
      await Promise.race([this.#request(disconnectRequest(channel, this.#local), KNX_SERVICE.disconnectResponse, gateway.endpoint), sleep(Math.min(500, this.#options.requestTimeoutMs))])
    }
    this.#stopped = true
    this.#channel = null
    this.#phase = 'failed'
    this.#ack?.resolve(null)
    this.#confirm?.resolve(null)
    try {
      this.#socket?.close()
    } catch {
      // Already closed.
    }
    this.#socket = null
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
    case 'open':
    case 'close':
    case 'setPosition':
      return typeof before.position === 'number' ? { command: 'setPosition', args: { position: before.position } } : null
    case 'setTargetTemperature':
      return typeof before.targetTemperature === 'number' ? { command: 'setTargetTemperature', args: { celsius: before.targetTemperature } } : null
    default:
      return null
  }
}
