/**
 * Zigbee, through zigbee2mqtt.
 *
 * zigbee2mqtt owns the radio - the coordinator stick, the mesh, the 4000 device definitions -
 * and publishes everything on MQTT. This adapter is its dedicated client: devices keyed by
 * IEEE address (a rename in zigbee2mqtt is not a new device), state interpreted through each
 * device's exposes, per-device availability, button presses as events, multi-gang switches
 * as endpoints, the bridge's own online/offline state, and pairing through `permit_join`.
 *
 * Topics (2.x): https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html
 *   <base>/bridge/state            {"state":"online"} (1.x: plain "online"), retained
 *   <base>/bridge/devices          the device list with exposes, retained
 *   <base>/bridge/request/permit_join   {"time":254,"transaction":"..."}
 *   <base>/bridge/response/permit_join  {"status":"ok"|"error","error"?,"transaction"}
 *   <base>/<friendly name>         state JSON; /availability; /set for commands
 *
 * The generic MQTT adapter also understands zigbee2mqtt. When this adapter watches a bridge,
 * it registers it in `activeZigbeeBridges` and the MQTT adapter leaves that bridge alone, so
 * no device appears twice.
 */

import type { AdapterContext, AdapterDescriptor, AdapterStatus, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { MqttClient } from '#adapters/mqtt'
import { commandPayload, deviceFrom, stateFrom, type BridgeDevice, type ZigbeeProfile } from '#adapters/zigbee_codec'
import { activeZigbeeBridges, bridgeKey } from '#adapters/zigbee_bridges'

export interface ZigbeeOptions {
  reconnectMs?: number
  /** How long to wait for zigbee2mqtt to answer a permit_join. */
  pairTimeoutMs?: number
}

interface Known {
  device: DiscoveredDevice
  profile: ZigbeeProfile
  friendlyName: string
  state: Record<string, unknown>
}

export class ZigbeeAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'zigbee',
    name: 'Zigbee (zigbee2mqtt)',
    vendor: 'zigbee2mqtt',
    transports: ['zigbee', 'mqtt'],
    capabilities: [
      'onoff', 'brightness', 'colorTemperature', 'color', 'position', 'tilt', 'thermostat', 'lock', 'contact', 'motion', 'occupancy',
      'temperature', 'humidity', 'pressure', 'illuminance', 'airQuality', 'battery', 'button', 'power', 'energy', 'waterLeak', 'smoke',
      'carbonMonoxide', 'identify', 'connectivity',
    ],
    zeroConfig: false,
    cloud: false,
    implemented: true,
    requiresHardware: 'Un coordinateur Zigbee (Sonoff ZBDongle-E, SkyConnect, ConBee III) piloté par zigbee2mqtt',
    docsUrl: 'https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html',
    configSchema: [
      { key: 'host', label: 'Broker MQTT', type: 'host', required: true, placeholder: '192.168.1.10' },
      { key: 'port', label: 'Port', type: 'number', default: 1883 },
      { key: 'username', label: 'Utilisateur', type: 'string' },
      { key: 'password', label: 'Mot de passe', type: 'password' },
      { key: 'baseTopic', label: 'Topic de base zigbee2mqtt', type: 'string', default: 'zigbee2mqtt' },
    ],
  }

  readonly #options: Required<ZigbeeOptions>
  #context: AdapterContext | null = null
  #client: MqttClient | null = null
  #base = 'zigbee2mqtt'
  #key: string | null = null
  #configured = false
  #bridgeOnline: boolean | null = null
  #devices = new Map<string, Known>()
  /** friendly name -> IEEE address; rebuilt from every bridge/devices message. */
  #byName = new Map<string, string>()
  #pairing = new Map<string, (response: Record<string, unknown>) => void>()

  constructor(options: ZigbeeOptions = {}) {
    this.#options = { reconnectMs: options.reconnectMs ?? 5000, pairTimeoutMs: options.pairTimeoutMs ?? 8000 }
  }

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.#context = context
    const host = typeof config.host === 'string' ? config.host.trim() : ''
    this.#configured = host.length > 0
    if (!this.#configured) return

    const port = Number(config.port ?? 1883)
    this.#base = String(config.baseTopic ?? 'zigbee2mqtt').replace(/\/+$/, '') || 'zigbee2mqtt'
    this.#key = bridgeKey(host, port, this.#base)
    activeZigbeeBridges.add(this.#key)

    const client = new MqttClient({
      host,
      port,
      username: config.username ? String(config.username) : undefined,
      password: config.password ? String(config.password) : undefined,
      clientId: `sway-home-zigbee-${Math.random().toString(16).slice(2, 8)}`,
      reconnectMs: this.#options.reconnectMs,
    })
    client.onConnect = () => {
      client.subscribe(`${this.#base}/#`)
      context.log('info', `watching zigbee2mqtt on ${host}:${port}/${this.#base}`)
    }
    client.onClose = () => {
      for (const known of this.#devices.values()) context.emitAvailability(known.device.nativeId, false)
    }
    client.onMessage = (topic, payload) => this.#receive(topic, payload)
    this.#client = client
    await client.connect()
  }

  // -------------------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------------------

  #receive(topic: string, payload: string): void {
    if (!topic.startsWith(`${this.#base}/`)) return
    const rest = topic.slice(this.#base.length + 1)

    if (rest === 'bridge/state') return this.#bridgeState(payload)
    if (rest === 'bridge/devices') return this.#importDevices(payload)
    if (rest === 'bridge/response/permit_join') {
      const response = parse(payload) as Record<string, unknown> | null
      const transaction = typeof response?.transaction === 'string' ? response.transaction : null
      if (response && transaction) this.#pairing.get(transaction)?.(response)
      return
    }
    if (rest.startsWith('bridge/')) return

    if (rest.endsWith('/availability')) {
      const ieee = this.#byName.get(rest.slice(0, -'/availability'.length))
      if (!ieee) return
      const body = parse(payload)
      const value = typeof body === 'object' && body !== null ? (body as { state?: unknown }).state : body
      this.#context?.emitAvailability(ieee, value === 'online')
      return
    }
    if (rest.endsWith('/set') || rest.endsWith('/get') || /\/set\/[^/]+$/.test(rest)) return

    const ieee = this.#byName.get(rest)
    const known = ieee ? this.#devices.get(ieee) : undefined
    const body = parse(payload)
    if (!known || typeof body !== 'object' || body === null) return

    const reading = stateFrom(body as Record<string, unknown>, known.profile)
    if (Object.keys(reading.state).length > 0) {
      known.state = { ...known.state, ...reading.state }
      this.#context?.emitState(known.device.nativeId, reading.state)
    }
    for (const [index, state] of Object.entries(reading.endpoints)) this.#context?.emitState(known.device.nativeId, state, Number(index))
    for (const action of reading.events) this.#context?.emitEvent(known.device.nativeId, 'button', { action })
  }

  #bridgeState(payload: string): void {
    const body = parse(payload)
    const value = typeof body === 'object' && body !== null ? (body as { state?: unknown }).state : body
    this.#bridgeOnline = value === 'online'
    if (!this.#bridgeOnline) for (const known of this.#devices.values()) this.#context?.emitAvailability(known.device.nativeId, false)
  }

  #importDevices(payload: string): void {
    const list = parse(payload)
    if (!Array.isArray(list)) return

    const names = new Map<string, string>()
    for (const entry of list as BridgeDevice[]) {
      const found = deviceFrom(entry)
      if (!found) continue
      const { profile, ...device } = found
      const friendlyName = String(device.meta?.friendlyName ?? device.nativeId)
      names.set(friendlyName, device.nativeId)
      const previous = this.#devices.get(device.nativeId)
      this.#devices.set(device.nativeId, { device, profile, friendlyName, state: previous?.state ?? {} })
      if (!previous) this.#context?.emitDiscovered(device)
    }
    this.#byName = names
  }

  // -------------------------------------------------------------------------------------
  // ProtocolAdapter
  // -------------------------------------------------------------------------------------

  /** The name zigbee2mqtt currently uses for a device, which is what its topics are built on. */
  friendlyName(nativeId: string): string | null {
    return this.#devices.get(nativeId)?.friendlyName ?? null
  }

  async discover(_hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    return [...this.#devices.values()].map((known) => known.device)
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    return { ...(this.#devices.get(nativeId)?.state ?? {}) }
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>, endpointIndex?: number): Promise<CommandResult> {
    const fail = (error: string): CommandResult => ({ ok: false, deviceId: nativeId, command, error })
    const known = this.#devices.get(nativeId)
    if (!known) return fail('Appareil Zigbee inconnu de zigbee2mqtt.')
    if (!this.#client?.connected) return fail('Le broker MQTT n’est pas connecté.')

    const body = commandPayload(command, args, known.profile, endpointIndex)
    if (!body) return fail(`${known.friendlyName} ne sait pas faire « ${command} ».`)
    this.#client.publish(`${this.#base}/${known.friendlyName}/set`, JSON.stringify(body))
    return { ok: true, deviceId: nativeId, command, undo: undoFor(command, known.state) }
  }

  /** Opens the Zigbee network for joining. `seconds` defaults to the maximum, 254. */
  async pair(input: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    if (!this.#client?.connected) return { ok: false, message: 'Le broker MQTT n’est pas connecté.' }
    const seconds = Math.min(254, Math.max(1, Math.round(Number(input.seconds ?? 254)) || 254))
    const transaction = `sway-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    const answer = new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#pairing.delete(transaction)
        resolve(null)
      }, this.#options.pairTimeoutMs)
      this.#pairing.set(transaction, (response) => {
        clearTimeout(timer)
        this.#pairing.delete(transaction)
        resolve(response)
      })
    })
    this.#client.publish(`${this.#base}/bridge/request/permit_join`, JSON.stringify({ time: seconds, transaction }))

    const response = await answer
    if (!response) return { ok: false, message: 'zigbee2mqtt n’a pas répondu. Vérifiez qu’il tourne et qu’il écoute ce broker.' }
    if (response.status !== 'ok') return { ok: false, message: `zigbee2mqtt a refusé : ${String(response.error ?? 'erreur inconnue')}` }
    return { ok: true, message: `Réseau Zigbee ouvert pendant ${seconds} s : mettez l’appareil en mode appairage.` }
  }

  status(): AdapterStatus {
    const deviceCount = this.#devices.size
    if (!this.#configured) return { health: 'needs_setup', deviceCount, message: 'Indiquez le broker MQTT où zigbee2mqtt publie.' }
    const refusal = this.#client?.refusal ?? null
    if (refusal === 4 || refusal === 5) return { health: 'error', deviceCount, message: 'Le broker MQTT a refusé les identifiants.' }
    if (!this.#client?.connected) return { health: 'error', deviceCount, message: 'Broker MQTT injoignable, nouvelle tentative en cours.' }
    if (this.#bridgeOnline === false) return { health: 'error', deviceCount, message: 'zigbee2mqtt est hors ligne : le broker répond, mais le pont Zigbee est arrêté.' }
    if (this.#bridgeOnline === null) return { health: 'degraded', deviceCount, message: 'Aucun zigbee2mqtt entendu sur ce topic pour l’instant.' }
    return { health: 'ok', deviceCount }
  }

  async shutdown(): Promise<void> {
    if (this.#key) activeZigbeeBridges.delete(this.#key)
    this.#key = null
    this.#client?.disconnect()
    this.#client = null
    this.#devices.clear()
    this.#byName.clear()
    for (const resolve of this.#pairing.values()) resolve({ status: 'error', error: 'adaptateur arrêté' })
    this.#pairing.clear()
  }
}

function parse(payload: string): unknown {
  try {
    return JSON.parse(payload)
  } catch {
    return payload
  }
}

function undoFor(command: string, before: Record<string, unknown>): { command: string; args: Record<string, unknown> } | null {
  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'toggle':
      return typeof before.on === 'boolean' ? { command: before.on ? 'turnOn' : 'turnOff', args: {} } : null
    case 'setBrightness':
    case 'stepBrightness':
      return typeof before.brightness === 'number' ? { command: 'setBrightness', args: { brightness: before.brightness } } : null
    case 'setPosition':
    case 'open':
    case 'close':
      return typeof before.position === 'number' ? { command: 'setPosition', args: { position: before.position } } : null
    case 'setTargetTemperature':
      return typeof before.targetTemperature === 'number' ? { command: 'setTargetTemperature', args: { celsius: before.targetTemperature } } : null
    default:
      return null
  }
}
