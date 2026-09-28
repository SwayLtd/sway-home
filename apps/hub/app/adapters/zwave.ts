/**
 * Z-Wave, through Z-Wave JS.
 *
 * Z-Wave JS drives the USB stick; zwave-js-server (standalone, or inside Z-Wave JS UI) puts it
 * on a WebSocket. This adapter is its client: nodes become devices keyed by home id and node
 * id, `value updated` events keep them live, dead and alive map to offline and online (a
 * battery node asleep is neither), Central Scene presses become button events, and pairing
 * runs a real S2 inclusion - granting the classes the device asks for and entering the PIN
 * printed on its label, without which a lock will not include securely.
 *
 * Protocol: https://github.com/zwave-js/zwave-js-server
 *   server {type: 'version', homeId, maxSchemaVersion} -> set_api_schema -> start_listening
 *   commands {messageId, command, ...}; results {type: 'result', messageId, success, result}
 *   events {type: 'event', event: {source, event, nodeId?, args?}}
 */

import type { AdapterContext, AdapterDescriptor, AdapterStatus, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import type { SocketLike } from '#adapters/homeassistant'
import { nodeDevice, nodeState, setValueFor, type ZwaveNode, type ZwaveValue } from '#adapters/zwave_codec'

/** The API schema this adapter was written against; the server may offer newer ones. */
const SCHEMA = 35

/** SetValueStatus values that mean the value was, or is being, applied. */
const SET_OK = new Set([1, 254, 255])

/** Central Scene key attributes (CC 91), as Sway button events. */
const SCENE_EVENTS = ['single', 'release', 'hold', 'double', 'triple', 'triple', 'triple']

export interface ZwaveOptions {
  connect?: (url: string) => SocketLike
  reconnectMs?: number
  maxReconnectMs?: number
  requestTimeoutMs?: number
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ZwaveAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'zwave',
    name: 'Z-Wave (Z-Wave JS)',
    vendor: 'Z-Wave Alliance',
    transports: ['zwave'],
    capabilities: ['onoff', 'brightness', 'position', 'thermostat', 'lock', 'contact', 'motion', 'temperature', 'humidity', 'illuminance', 'pressure', 'battery', 'power', 'energy', 'siren', 'waterLeak', 'smoke', 'carbonMonoxide', 'button'],
    zeroConfig: false,
    cloud: false,
    implemented: true,
    requiresHardware: 'Une clé Z-Wave (Aeotec Z-Stick, Zooz ZST39) pilotée par Z-Wave JS UI ou zwave-js-server',
    docsUrl: 'https://github.com/zwave-js/zwave-js-server',
    configSchema: [{ key: 'url', label: 'Adresse du serveur Z-Wave JS', type: 'host', required: true, placeholder: 'ws://192.168.1.10:3000' }],
  }

  readonly #options: Required<Omit<ZwaveOptions, 'connect'>> & Pick<ZwaveOptions, 'connect'>
  #context: AdapterContext | null = null
  #url: string | null = null
  #socket: SocketLike | null = null
  #homeId = 0
  #nodes = new Map<number, ZwaveNode>()
  #pending = new Map<string, Pending>()
  #sequence = 0
  #ready = false
  #readyWaiters: (() => void)[] = []
  #message: string | null = null
  #backoff: number
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #stopped = false
  /** The PIN for the inclusion in progress, if the person gave one. */
  #pin: string | null = null

  constructor(options: ZwaveOptions = {}) {
    this.#options = {
      connect: options.connect,
      reconnectMs: options.reconnectMs ?? 1000,
      maxReconnectMs: options.maxReconnectMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
    }
    this.#backoff = this.#options.reconnectMs
  }

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.#context = context
    const raw = typeof config.url === 'string' ? config.url.trim() : ''
    this.#url = raw ? (/^wss?:\/\//.test(raw) ? raw : `ws://${raw.replace(/^https?:\/\//, '')}`) : null
    this.#stopped = false
    if (this.#url) this.#open()
  }

  // -------------------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------------------

  #open(): void {
    this.#ready = false
    let socket: SocketLike
    try {
      socket = this.#options.connect ? this.#options.connect(this.#url!) : (new WebSocket(this.#url!) as unknown as SocketLike)
    } catch (error) {
      this.#message = `Adresse Z-Wave JS invalide : ${(error as Error).message}`
      this.#scheduleReconnect()
      return
    }
    this.#socket = socket
    socket.onmessage = (event) => {
      try {
        void this.#receive(JSON.parse(String(event.data)))
      } catch {
        // A frame that is not JSON is not ours to act on.
      }
    }
    socket.onclose = () => this.#closed(socket)
    socket.onerror = () => undefined
  }

  #request(command: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const socket = this.#socket
    if (!socket) return Promise.reject(new Error('Z-Wave JS n’est pas connecté.'))
    const messageId = `sway-${++this.#sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(messageId)
        reject(new Error('Z-Wave JS n’a pas répondu à temps.'))
      }, this.#options.requestTimeoutMs)
      this.#pending.set(messageId, { resolve, reject, timer })
      socket.send(JSON.stringify({ messageId, command, ...payload }))
    })
  }

  async #receive(message: Record<string, any>): Promise<void> {
    if (message.type === 'version') {
      this.#homeId = Number(message.homeId ?? 0)
      await this.#synchronise(Number(message.maxSchemaVersion ?? SCHEMA))
      return
    }
    if (message.type === 'result') {
      const pending = this.#pending.get(message.messageId)
      if (!pending) return
      this.#pending.delete(message.messageId)
      clearTimeout(pending.timer)
      if (message.success) pending.resolve((message.result ?? {}) as Record<string, unknown>)
      else pending.reject(new Error(String(message.message ?? message.errorCode ?? 'Z-Wave JS a refusé la commande.')))
      return
    }
    if (message.type === 'event' && message.event) this.#event(message.event as Record<string, any>)
  }

  async #synchronise(maxSchema: number): Promise<void> {
    try {
      await this.#request('set_api_schema', { schemaVersion: Math.min(SCHEMA, maxSchema) })
      const result = await this.#request('start_listening')
      const state = (result.state ?? {}) as { nodes?: ZwaveNode[] }
      this.#nodes = new Map((state.nodes ?? []).map((node) => [node.nodeId, node]))
      this.#ready = true
      this.#message = null
      this.#backoff = this.#options.reconnectMs
      for (const node of this.#nodes.values()) {
        if (node.isControllerNode) continue
        this.#context?.emitAvailability(String(node.nodeId), node.status !== 3)
        this.#emit(node)
      }
      for (const waiter of this.#readyWaiters.splice(0)) waiter()
    } catch (error) {
      this.#message = `Synchronisation Z-Wave JS impossible : ${(error as Error).message}`
      this.#socket?.close(4000, 'sync failed')
    }
  }

  #emit(node: ZwaveNode): void {
    const reading = nodeState(node)
    const nativeId = String(node.nodeId)
    if (Object.keys(reading.state).length > 0) this.#context?.emitState(nativeId, reading.state)
    for (const [index, state] of Object.entries(reading.endpoints)) this.#context?.emitState(nativeId, state, Number(index))
  }

  #event(event: Record<string, any>): void {
    const nodeId = Number(event.nodeId ?? event.node?.nodeId)
    switch (event.event) {
      case 'value updated':
      case 'value added': {
        const node = this.#nodes.get(nodeId)
        if (!node || !event.args) return
        upsertValue(node, event.args)
        this.#emit(node)
        return
      }
      case 'value removed': {
        const node = this.#nodes.get(nodeId)
        if (!node || !event.args) return
        node.values = node.values.filter((value) => !sameValue(value, event.args))
        return
      }
      case 'value notification': {
        // Central Scene: a press is an event, never a state to keep.
        if (event.args?.commandClass !== 91) return
        const action = SCENE_EVENTS[Number(event.args.value)] ?? 'single'
        this.#context?.emitEvent(String(nodeId), 'button', { action, scene: String(event.args.propertyKey ?? '') })
        return
      }
      case 'dead':
        this.#context?.emitAvailability(String(nodeId), false)
        return
      case 'alive':
      case 'wake up':
        this.#context?.emitAvailability(String(nodeId), true)
        return
      case 'ready':
      case 'node added': {
        const dump = (event.nodeState ?? event.node) as ZwaveNode | undefined
        if (!dump?.nodeId) return
        const known = this.#nodes.has(dump.nodeId)
        this.#nodes.set(dump.nodeId, { ...dump, values: dump.values ?? [] })
        const device = nodeDevice(this.#nodes.get(dump.nodeId)!, this.#homeId)
        if (device && !known) this.#context?.emitDiscovered(device)
        this.#emit(this.#nodes.get(dump.nodeId)!)
        return
      }
      case 'node removed':
        this.#context?.emitAvailability(String(nodeId), false)
        this.#nodes.delete(nodeId)
        return
      case 'grant security classes': {
        // What the device asks for is what it needs to work; a lock that is refused S2 Access
        // Control includes, and then refuses every command.
        const requested = (event.requested ?? {}) as { securityClasses?: number[]; clientSideAuth?: boolean }
        void this.#request('controller.grant_security_classes', { inclusionGrant: { securityClasses: requested.securityClasses ?? [], clientSideAuth: requested.clientSideAuth ?? false } }).catch(() => undefined)
        return
      }
      case 'validate dsk and enter pin': {
        if (this.#pin) {
          void this.#request('controller.validate_dsk_and_enter_pin', { pin: this.#pin }).catch(() => undefined)
          this.#pin = null
          return
        }
        this.#message = "L'appareil demande son code PIN (les 5 premiers chiffres du DSK sur son étiquette) : relancez l'appairage avec ce code."
        void this.#request('controller.stop_inclusion').catch(() => undefined)
        return
      }
      case 'inclusion stopped':
      case 'inclusion failed':
        this.#pin = null
        return
    }
  }

  #closed(socket: SocketLike): void {
    if (socket !== this.#socket) return
    this.#socket = null
    this.#ready = false
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Connexion à Z-Wave JS perdue.'))
      this.#pending.delete(id)
    }
    if (this.#stopped) return
    this.#message = 'Connexion à Z-Wave JS perdue, reconnexion en cours.'
    for (const node of this.#nodes.values()) if (!node.isControllerNode) this.#context?.emitAvailability(String(node.nodeId), false)
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

  async #whenReady(): Promise<boolean> {
    if (this.#ready) return true
    if (!this.#url) return false
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.#options.requestTimeoutMs)
      this.#readyWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  // -------------------------------------------------------------------------------------
  // ProtocolAdapter
  // -------------------------------------------------------------------------------------

  async discover(_hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    if (!(await this.#whenReady())) return []
    return [...this.#nodes.values()].map((node) => nodeDevice(node, this.#homeId)).filter((device): device is DiscoveredDevice => device !== null)
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const node = this.#nodes.get(Number(nativeId))
    return node ? nodeState(node).state : {}
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>, endpointIndex?: number): Promise<CommandResult> {
    const fail = (error: string): CommandResult => ({ ok: false, deviceId: nativeId, command, error })
    if (!(await this.#whenReady())) return fail(this.#message ?? 'Z-Wave JS n’est pas connecté.')
    const node = this.#nodes.get(Number(nativeId))
    if (!node) return fail('Nœud Z-Wave inconnu.')
    const write = setValueFor(node, command, args, endpointIndex)
    if (!write) return fail(`Ce nœud ne sait pas faire « ${command} ».`)

    try {
      const result = await this.#request('node.set_value', { nodeId: node.nodeId, valueId: write.valueId, value: write.value })
      // Recent schemas answer {result: {status}}; old ones a bare {success}.
      const status = (result.result as { status?: number } | undefined)?.status
      const ok = status !== undefined ? SET_OK.has(status) : result.success !== false
      return ok ? { ok: true, deviceId: nativeId, command, undo: null } : fail(`Le nœud a refusé la valeur (statut ${status}).`)
    } catch (error) {
      return fail((error as Error).message)
    }
  }

  /**
   * Starts an inclusion. With `pin` - the five digits under the QR code on the device - an S2
   * device includes securely; without it, a device that asks for one is stopped and the
   * status says so, rather than left half-included.
   */
  async pair(input: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    if (!(await this.#whenReady())) return { ok: false, message: this.#message ?? 'Z-Wave JS n’est pas connecté.' }
    const pin = typeof input.pin === 'string' && /^\d{5}$/.test(input.pin.trim()) ? input.pin.trim() : null
    this.#pin = pin
    try {
      await this.#request('controller.begin_inclusion', { options: { strategy: 0 } })
      return { ok: true, message: 'Inclusion Z-Wave lancée : mettez l’appareil en mode inclusion (souvent trois appuis rapides).' }
    } catch (error) {
      this.#pin = null
      return { ok: false, message: (error as Error).message }
    }
  }

  status(): AdapterStatus {
    const deviceCount = [...this.#nodes.values()].filter((node) => !node.isControllerNode).length
    if (!this.#url) return { health: 'needs_setup', deviceCount, message: 'Indiquez l’adresse WebSocket de Z-Wave JS (Z-Wave JS UI : port 3000).' }
    if (!this.#ready) return { health: this.#socket ? 'degraded' : 'error', deviceCount, message: this.#message ?? 'Connexion à Z-Wave JS en cours.' }
    return { health: 'ok', deviceCount, ...(this.#message ? { message: this.#message } : {}) }
  }

  async shutdown(): Promise<void> {
    this.#stopped = true
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Adaptateur arrêté.'))
    }
    this.#pending.clear()
    const socket = this.#socket
    this.#socket = null
    socket?.close(1000, 'shutdown')
    this.#nodes.clear()
    this.#ready = false
  }
}

function sameValue(value: ZwaveValue, args: Record<string, unknown>): boolean {
  return value.commandClass === args.commandClass && (value.endpoint ?? 0) === Number(args.endpoint ?? 0) && value.property === args.property && value.propertyKey === args.propertyKey
}

function upsertValue(node: ZwaveNode, args: Record<string, unknown>): void {
  const existing = node.values.find((value) => sameValue(value, args))
  const next = args.newValue !== undefined ? args.newValue : args.value
  if (existing) {
    existing.value = next
    return
  }
  node.values.push({
    commandClass: Number(args.commandClass),
    endpoint: Number(args.endpoint ?? 0),
    property: args.property as string | number,
    ...(args.propertyKey !== undefined ? { propertyKey: args.propertyKey as string | number } : {}),
    value: next,
    metadata: (args.metadata as ZwaveValue['metadata']) ?? { readable: true },
  })
}
