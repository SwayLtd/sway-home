/**
 * Home Assistant, over its WebSocket API.
 *
 * The migration path, and the fastest way to inherit a thousand integrations: every entity
 * of an existing Home Assistant appears in Sway, grouped back into the physical devices HA
 * registered, and kept live by `state_changed` events rather than polling.
 *
 * The conversation (https://developers.home-assistant.io/docs/api/websocket):
 *   server auth_required -> client auth {access_token} -> server auth_ok | auth_invalid
 *   then id-correlated commands: get_states, the three registries, subscribe_events,
 *   call_service; every answer is {id, type: 'result', success, result | error}.
 *
 * A wrong token is reported once and never retried on its own - hammering HA with a bad
 * token gets the hub's IP banned by HA's `ip_ban` - while a dropped connection (HA
 * restarting, Wi-Fi hiccup) is retried with backoff and followed by a full resync, because
 * events sent while the socket was down are lost for good.
 *
 * Translation lives in `homeassistant_codec.ts`; this file is only the conversation.
 */

import type { AdapterContext, AdapterDescriptor, AdapterStatus, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import {
  entityForCommand,
  groupEntities,
  readEntity,
  toServiceCall,
  type HaAreaEntry,
  type HaDeviceEntry,
  type HaEntityEntry,
  type HaGroup,
  type HaState,
} from '#adapters/homeassistant_codec'

/** The subset of the WHATWG WebSocket this adapter uses, so tests can inject one. */
export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export interface HomeAssistantOptions {
  connect?: (url: string) => SocketLike
  /** First reconnection delay; doubles up to `maxReconnectMs`. */
  reconnectMs?: number
  maxReconnectMs?: number
  requestTimeoutMs?: number
  /** Heartbeat: a ping every this often, so a half-open socket is noticed. */
  pingIntervalMs?: number
}

type Phase = 'idle' | 'connecting' | 'ready' | 'auth_failed' | 'disconnected'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class HomeAssistantAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'homeassistant',
    name: 'Home Assistant',
    vendor: 'Open Home Foundation',
    transports: ['wifi', 'ethernet'],
    capabilities: [
      'onoff', 'brightness', 'color', 'colorTemperature', 'position', 'tilt', 'garage', 'valve', 'fan', 'thermostat', 'lock',
      'mediaPlayback', 'volume', 'mediaSource', 'vacuum', 'siren', 'camera', 'presence', 'temperature', 'humidity', 'illuminance',
      'pressure', 'airQuality', 'motion', 'occupancy', 'contact', 'waterLeak', 'smoke', 'carbonMonoxide', 'power', 'energy', 'battery',
    ],
    zeroConfig: false,
    cloud: false,
    implemented: true,
    docsUrl: 'https://developers.home-assistant.io/docs/api/websocket',
    configSchema: [
      { key: 'url', label: 'Home Assistant URL', type: 'host', required: true, placeholder: 'http://homeassistant.local:8123' },
      { key: 'token', label: 'Long-lived access token', type: 'password', required: true, help: 'Profil > Sécurité > Jetons d’accès longue durée, dans Home Assistant.' },
    ],
  }

  readonly #options: Required<Omit<HomeAssistantOptions, 'connect'>> & Pick<HomeAssistantOptions, 'connect'>
  #context: AdapterContext | null = null
  #url: string | null = null
  #token: string | null = null
  #socket: SocketLike | null = null
  #phase: Phase = 'idle'
  #message: string | null = null
  #nextId = 1
  #pending = new Map<number, Pending>()
  #subscription: number | null = null
  #states = new Map<string, HaState>()
  #groups = new Map<string, HaGroup>()
  /** entity id -> the group that shows it. */
  #owner = new Map<string, string>()
  #ready: Promise<void> | null = null
  #resolveReady: (() => void) | null = null
  #backoff: number
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #pingTimer: ReturnType<typeof setInterval> | null = null
  #stopped = false
  #seenOnNetwork: string | null = null

  constructor(options: HomeAssistantOptions = {}) {
    this.#options = {
      connect: options.connect,
      reconnectMs: options.reconnectMs ?? 1000,
      maxReconnectMs: options.maxReconnectMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      pingIntervalMs: options.pingIntervalMs ?? 30_000,
    }
    this.#backoff = this.#options.reconnectMs
  }

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#url = typeof config.url === 'string' && config.url.trim() ? config.url.trim().replace(/\/+$/, '') : null
    this.#token = typeof config.token === 'string' && config.token.trim() ? config.token.trim() : null
    this.#stopped = false
    if (!this.#url || !this.#token) return
    this.#open()
  }

  // -------------------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------------------

  #websocketUrl(): string {
    const base = new URL(this.#url!)
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/api/websocket`
    return base.toString()
  }

  #open(): void {
    this.#phase = 'connecting'
    this.#ready ??= new Promise((resolve) => (this.#resolveReady = resolve))
    this.#nextId = 1
    this.#subscription = null

    let socket: SocketLike
    try {
      const url = this.#websocketUrl()
      socket = this.#options.connect ? this.#options.connect(url) : (new WebSocket(url) as unknown as SocketLike)
    } catch (error) {
      this.#message = `Adresse Home Assistant invalide : ${(error as Error).message}`
      this.#phase = 'disconnected'
      this.#scheduleReconnect()
      return
    }
    this.#socket = socket

    socket.onmessage = (event) => {
      let message: Record<string, any>
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      // Coalesced frames arrive as an array when the feature is on; handle both shapes.
      for (const entry of Array.isArray(message) ? message : [message]) void this.#receive(entry)
    }
    socket.onclose = () => this.#closed(socket)
    socket.onerror = () => undefined
  }

  async #receive(message: Record<string, any>): Promise<void> {
    switch (message.type) {
      case 'auth_required':
        this.#socket?.send(JSON.stringify({ type: 'auth', access_token: this.#token }))
        return

      case 'auth_invalid':
        this.#phase = 'auth_failed'
        this.#message = `Jeton refusé par Home Assistant (${message.message ?? 'auth_invalid'}). Créez un jeton longue durée et enregistrez-le.`
        this.#context?.log('error', 'Home Assistant refused the token')
        return

      case 'auth_ok':
        this.#backoff = this.#options.reconnectMs
        await this.#synchronise()
        return

      case 'result':
      case 'pong': {
        const pending = this.#pending.get(message.id)
        if (!pending) return
        this.#pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.type === 'pong' || message.success) pending.resolve(message.result ?? null)
        else pending.reject(new Error(message.error?.message ?? message.error?.code ?? 'Home Assistant a refusé la commande.'))
        return
      }

      case 'event':
        if (message.id === this.#subscription && message.event?.event_type === 'state_changed') this.#changed(message.event.data?.new_state ?? null, message.event.data?.entity_id)
        return
    }
  }

  #request<T = unknown>(payload: Record<string, unknown>): Promise<T> {
    const socket = this.#socket
    if (!socket) return Promise.reject(new Error('Home Assistant n’est pas connecté.'))
    const id = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('Home Assistant n’a pas répondu à temps.'))
      }, this.#options.requestTimeoutMs)
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      socket.send(JSON.stringify({ id, ...payload }))
    })
  }

  /** Everything, from scratch: after the first connection and after every reconnection. */
  async #synchronise(): Promise<void> {
    try {
      const subscribe = this.#request({ type: 'subscribe_events', event_type: 'state_changed' })
      this.#subscription = this.#nextId - 1
      const [states, areas, devices, entities] = await Promise.all([
        this.#request<HaState[]>({ type: 'get_states' }),
        // The registries need an admin token; without them entities simply stand alone.
        this.#request<HaAreaEntry[]>({ type: 'config/area_registry/list' }).catch(() => []),
        this.#request<HaDeviceEntry[]>({ type: 'config/device_registry/list' }).catch(() => []),
        this.#request<HaEntityEntry[]>({ type: 'config/entity_registry/list' }).catch(() => []),
        subscribe,
      ])

      this.#states = new Map(states.map((state) => [state.entity_id, state]))
      const groups = groupEntities(states, { areas, devices, entities })
      this.#groups = new Map(groups.map((group) => [group.nativeId, group]))
      this.#owner = new Map(groups.flatMap((group) => group.entities.map((entityId) => [entityId, group.nativeId] as const)))

      this.#phase = 'ready'
      this.#message = null
      this.#startHeartbeat()
      // A resync after a reconnection has to tell the hub what changed while nobody was
      // listening; on the first sync this is simply the initial state.
      for (const group of groups) this.#emitGroup(group)
      this.#resolveReady?.()
    } catch (error) {
      this.#message = `Synchronisation Home Assistant impossible : ${(error as Error).message}`
      this.#socket?.close(4000, 'sync failed')
    }
  }

  #changed(state: HaState | null, entityId: string | undefined): void {
    const id = state?.entity_id ?? entityId
    if (!id) return
    if (state) this.#states.set(id, state)
    else this.#states.delete(id)
    const owner = this.#owner.get(id)
    const group = owner ? this.#groups.get(owner) : undefined
    if (group) this.#emitGroup(group)
  }

  #emitGroup(group: HaGroup): void {
    const { state, available } = this.#merge(group)
    this.#context?.emitAvailability(group.nativeId, available)
    if (Object.keys(state).length > 0) this.#context?.emitState(group.nativeId, state)
  }

  /** A group is online while its main entity is; its state is the merge of all of them. */
  #merge(group: HaGroup): { state: Record<string, unknown>; available: boolean } {
    const state: Record<string, unknown> = {}
    let available = true
    group.entities.forEach((entityId, index) => {
      const entity = this.#states.get(entityId)
      if (!entity) return
      const reading = readEntity(entity)
      if (index === 0 && !reading.available) available = false
      Object.assign(state, reading.state)
    })
    return { state, available }
  }

  #closed(socket: SocketLike): void {
    if (socket !== this.#socket) return
    this.#socket = null
    this.#stopHeartbeat()
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Connexion à Home Assistant perdue.'))
      this.#pending.delete(id)
    }
    if (this.#stopped || this.#phase === 'auth_failed') return
    this.#phase = 'disconnected'
    this.#message ??= 'Connexion à Home Assistant perdue, reconnexion en cours.'
    this.#scheduleReconnect()
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return
    const delay = this.#backoff
    this.#backoff = Math.min(this.#options.maxReconnectMs, this.#backoff * 2)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      if (!this.#stopped) this.#open()
    }, delay)
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat()
    this.#pingTimer = setInterval(() => {
      this.#request({ type: 'ping' }).catch(() => this.#socket?.close(4001, 'ping timeout'))
    }, this.#options.pingIntervalMs)
  }

  #stopHeartbeat(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer)
    this.#pingTimer = null
  }

  /** Waits for the first synchronisation, but never longer than a request would. */
  async #whenReady(): Promise<boolean> {
    if (this.#phase === 'ready') return true
    if (!this.#ready || this.#phase === 'auth_failed') return false
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), this.#options.requestTimeoutMs))
    return (await Promise.race([this.#ready.then(() => 'ready' as const), timeout])) === 'ready'
  }

  // -------------------------------------------------------------------------------------
  // ProtocolAdapter
  // -------------------------------------------------------------------------------------

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    if (!this.#url || !this.#token) {
      // Not set up, but worth saying when an instance is right there on the network.
      const instance = hosts.find((host) => host.openPorts?.includes(8123) || host.mdnsServices?.some((service) => service.includes('_home-assistant._tcp')))
      if (instance) this.#seenOnNetwork = `http://${instance.ip}:8123`
      return []
    }
    if (!(await this.#whenReady())) return []

    return [...this.#groups.values()].map((group) => ({
      adapterId: 'homeassistant',
      nativeId: group.nativeId,
      uid: `homeassistant:${group.nativeId}`,
      name: group.name,
      category: group.category,
      capabilities: group.capabilities,
      transport: 'wifi',
      manufacturer: group.manufacturer,
      model: group.model,
      firmwareVersion: group.firmware,
      confidence: 0.9,
      meta: { area: group.area, entities: group.entities },
    }))
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const group = this.#groups.get(nativeId)
    if (!group) return {}
    return this.#merge(group).state
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const fail = (error: string): CommandResult => ({ ok: false, deviceId: nativeId, command, error })
    if (!(await this.#whenReady())) return fail(this.#message ?? 'Home Assistant n’est pas connecté.')

    const group = this.#groups.get(nativeId)
    if (!group) return fail('Appareil Home Assistant inconnu.')
    const entityId = entityForCommand(group, command)
    const call = entityId ? toServiceCall(entityId, command, args, this.#states.get(entityId)) : null
    if (!call) return fail(`${group.name} ne sait pas faire « ${command} ».`)

    try {
      await this.#request({ type: 'call_service', ...call })
      return { ok: true, deviceId: nativeId, command, undo: null }
    } catch (error) {
      return fail((error as Error).message)
    }
  }

  status(): AdapterStatus {
    const deviceCount = this.#groups.size
    if (!this.#url || !this.#token) {
      return {
        health: 'needs_setup',
        deviceCount,
        message: this.#seenOnNetwork
          ? `Home Assistant détecté sur ${this.#seenOnNetwork} : ajoutez son adresse et un jeton longue durée.`
          : 'Ajoutez l’adresse de Home Assistant et un jeton longue durée.',
      }
    }
    if (this.#phase === 'auth_failed') return { health: 'error', deviceCount, message: this.#message ?? 'Jeton refusé.' }
    if (this.#phase === 'ready') return { health: 'ok', deviceCount }
    return { health: 'degraded', deviceCount, message: this.#message ?? 'Connexion à Home Assistant en cours.' }
  }

  async shutdown(): Promise<void> {
    this.#stopped = true
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
    this.#stopHeartbeat()
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Adaptateur arrêté.'))
    }
    this.#pending.clear()
    const socket = this.#socket
    this.#socket = null
    socket?.close(1000, 'shutdown')
    this.#groups.clear()
    this.#owner.clear()
    this.#states.clear()
    this.#phase = 'idle'
  }
}
