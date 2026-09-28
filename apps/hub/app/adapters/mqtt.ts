/**
 * MQTT, with the client written out by hand.
 *
 * MQTT is the backbone of the open smart-home world: zigbee2mqtt, Zigbee2MQTT's Z-Wave
 * cousin, Tasmota, ESPHome, Shelly, Sonoff, Frigate, Teslamate and most DIY sensors all
 * publish to it. Supporting it well is the single cheapest way to reach thousands of device
 * models.
 *
 * The client below implements the subset of MQTT 3.1.1 that a subscriber-publisher needs:
 * CONNECT, CONNACK, SUBSCRIBE, SUBACK, PUBLISH (QoS 0 and 1), PUBACK, PINGREQ, PINGRESP,
 * DISCONNECT. That is roughly 200 lines and no dependency, which matters because the
 * alternative pulls a websocket stack and a stream polyfill into a process that needs
 * neither.
 *
 * On top of the client sits topic translation: Home Assistant discovery messages,
 * zigbee2mqtt's `<base>/<friendly name>` payloads, and Tasmota's `tele/<topic>/STATE` are
 * all mapped onto the capability vocabulary.
 */

import net from 'node:net'
import { activeZigbeeBridges, bridgeKey } from '#adapters/zigbee_bridges'
import type { AdapterDescriptor, AdapterStatus, CapabilityId, CommandResult, DeviceCategory, DiscoveredDevice, NetworkHost, ProtocolAdapter, AdapterContext } from '@sway-home/shared'

// ---------------------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------------------

const PACKET = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
} as const

function encodeLength(length: number): Buffer {
  const bytes: number[] = []
  let remaining = length
  do {
    let byte = remaining % 128
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining > 0)
  return Buffer.from(bytes)
}

function decodeLength(buffer: Buffer, offset: number): { value: number; bytes: number } | null {
  let value = 0
  let multiplier = 1
  let bytes = 0
  for (;;) {
    if (offset + bytes >= buffer.length) return null
    const byte = buffer[offset + bytes] ?? 0
    bytes += 1
    value += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) break
    multiplier *= 128
    if (bytes > 4) return null
  }
  return { value, bytes }
}

function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  const header = Buffer.alloc(2)
  header.writeUInt16BE(bytes.length, 0)
  return Buffer.concat([header, bytes])
}

export interface MqttOptions {
  host: string
  port?: number
  clientId?: string
  username?: string
  password?: string
  keepAliveSeconds?: number
  /** Delay before reconnecting after the connection drops. */
  reconnectMs?: number
}

/** CONNACK return codes that retrying cannot fix: the credentials or the permission. */
const REFUSED_FOR_GOOD = new Set([4, 5])

export class MqttClient {
  #socket: net.Socket | null = null
  #buffer = Buffer.alloc(0)
  #packetId = 1
  #keepAlive: ReturnType<typeof setInterval> | null = null
  #connected = false
  #subscriptions = new Set<string>()
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #closedByUs = false
  #refusal: number | null = null

  onMessage: (topic: string, payload: string, retained: boolean) => void = () => {}
  onConnect: () => void = () => {}
  onClose: (reason: string) => void = () => {}

  constructor(private readonly options: MqttOptions) {}

  get connected(): boolean {
    return this.#connected
  }

  /** The CONNACK return code of the last refused connection, or null (3.1.1 section 3.2.2.3). */
  get refusal(): number | null {
    return this.#refusal
  }

  connect(timeoutMs = 8000): Promise<boolean> {
    this.#closedByUs = false
    return new Promise((resolve) => {
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        resolve(ok)
      }

      const socket = net.createConnection({ host: this.options.host, port: this.options.port ?? 1883 }, () => {
        socket.write(this.#connectPacket())
      })
      this.#socket = socket

      const timer = setTimeout(() => {
        socket.destroy()
        finish(false)
      }, timeoutMs)

      socket.on('data', (chunk: Buffer) => {
        this.#buffer = Buffer.concat([this.#buffer, chunk])
        for (;;) {
          const packet = this.#nextPacket()
          if (!packet) break
          if (packet.type === PACKET.CONNACK) {
            clearTimeout(timer)
            const returnCode = packet.body[1] ?? 1
            if (returnCode !== 0) {
              this.#refusal = returnCode
              // Wrong credentials stay wrong: retrying every few seconds only fills the
              // broker's log. A new configuration restarts the client anyway.
              if (REFUSED_FOR_GOOD.has(returnCode)) this.#closedByUs = true
              socket.destroy()
              finish(false)
              return
            }
            this.#refusal = null
            this.#connected = true
            this.#keepAlive = setInterval(() => this.#write(Buffer.from([PACKET.PINGREQ << 4, 0])), (this.options.keepAliveSeconds ?? 45) * 1000)
            for (const topic of this.#subscriptions) this.#sendSubscribe(topic)
            this.onConnect()
            finish(true)
          } else if (packet.type === PACKET.PUBLISH) {
            this.#handlePublish(packet.body, packet.flags)
          }
        }
      })

      socket.on('error', () => {
        clearTimeout(timer)
        this.#teardown('error')
        finish(false)
      })
      socket.on('close', () => {
        clearTimeout(timer)
        this.#teardown('closed')
        finish(false)
      })
    })
  }

  #connectPacket(): Buffer {
    const clientId = this.options.clientId ?? `sway-home-${Math.random().toString(16).slice(2, 10)}`
    let flags = 0x02 // clean session
    const payload: Buffer[] = [encodeString(clientId)]

    if (this.options.username) {
      flags |= 0x80
      payload.push(encodeString(this.options.username))
      if (this.options.password) {
        flags |= 0x40
        payload.push(encodeString(this.options.password))
      }
    }

    const variable = Buffer.concat([
      encodeString('MQTT'),
      Buffer.from([4, flags]), // protocol level 4 = 3.1.1
      (() => {
        const keepAlive = Buffer.alloc(2)
        keepAlive.writeUInt16BE(this.options.keepAliveSeconds ?? 45, 0)
        return keepAlive
      })(),
    ])

    const body = Buffer.concat([variable, ...payload])
    return Buffer.concat([Buffer.from([PACKET.CONNECT << 4]), encodeLength(body.length), body])
  }

  #nextPacket(): { type: number; flags: number; body: Buffer } | null {
    if (this.#buffer.length < 2) return null
    const first = this.#buffer[0] ?? 0
    const length = decodeLength(this.#buffer, 1)
    if (!length) return null
    const total = 1 + length.bytes + length.value
    if (this.#buffer.length < total) return null

    const body = this.#buffer.subarray(1 + length.bytes, total)
    this.#buffer = this.#buffer.subarray(total)
    return { type: first >> 4, flags: first & 0x0f, body }
  }

  #handlePublish(body: Buffer, flags: number): void {
    const qos = (flags >> 1) & 0x03
    const retained = (flags & 0x01) === 1
    if (body.length < 2) return

    const topicLength = body.readUInt16BE(0)
    const topic = body.subarray(2, 2 + topicLength).toString('utf8')
    let offset = 2 + topicLength

    if (qos > 0) {
      const packetId = body.readUInt16BE(offset)
      offset += 2
      // QoS 1 needs an acknowledgement or the broker redelivers forever.
      const ack = Buffer.alloc(4)
      ack[0] = PACKET.PUBACK << 4
      ack[1] = 2
      ack.writeUInt16BE(packetId, 2)
      this.#write(ack)
    }

    const payload = body.subarray(offset).toString('utf8')
    try {
      this.onMessage(topic, payload, retained)
    } catch {
      // A bad payload from one device must not kill the connection for the others.
    }
  }

  subscribe(topic: string): void {
    this.#subscriptions.add(topic)
    if (this.#connected) this.#sendSubscribe(topic)
  }

  #sendSubscribe(topic: string): void {
    const packetId = this.#packetId++
    const header = Buffer.alloc(2)
    header.writeUInt16BE(packetId, 0)
    const body = Buffer.concat([header, encodeString(topic), Buffer.from([0])]) // QoS 0
    this.#write(Buffer.concat([Buffer.from([(PACKET.SUBSCRIBE << 4) | 0x02]), encodeLength(body.length), body]))
  }

  publish(topic: string, payload: string, options: { retain?: boolean } = {}): void {
    const flags = options.retain ? 0x01 : 0x00
    const body = Buffer.concat([encodeString(topic), Buffer.from(payload, 'utf8')])
    this.#write(Buffer.concat([Buffer.from([(PACKET.PUBLISH << 4) | flags]), encodeLength(body.length), body]))
  }

  #write(data: Buffer): void {
    if (this.#socket && !this.#socket.destroyed) this.#socket.write(data)
  }

  #teardown(reason: string): void {
    const wasConnected = this.#connected
    this.#connected = false
    if (this.#keepAlive) clearInterval(this.#keepAlive)
    this.#keepAlive = null
    this.#socket?.destroy()
    this.#socket = null
    this.#buffer = Buffer.alloc(0)
    if (wasConnected) this.onClose(reason)

    if (!this.#closedByUs && !this.#reconnectTimer) {
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = null
        void this.connect()
      }, this.options.reconnectMs ?? 5000)
    }
  }

  disconnect(): void {
    this.#closedByUs = true
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
    this.#write(Buffer.from([PACKET.DISCONNECT << 4, 0]))
    this.#teardown('disconnect')
  }
}

// ---------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------

interface MqttDevice {
  nativeId: string
  name: string
  category: DeviceCategory
  capabilities: CapabilityId[]
  stateTopic: string
  commandTopic: string | null
  source: 'zigbee2mqtt' | 'tasmota' | 'discovery' | 'manual'
  manufacturer: string | null
  model: string | null
  state: Record<string, unknown>
}

export class MqttAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'mqtt',
    name: 'MQTT',
    vendor: 'OASIS / open ecosystem',
    transports: ['mqtt'],
    capabilities: ['onoff', 'brightness', 'colorTemperature', 'color', 'position', 'thermostat', 'lock', 'contact', 'motion', 'occupancy', 'temperature', 'humidity', 'illuminance', 'pressure', 'battery', 'power', 'energy', 'waterLeak', 'smoke', 'airQuality', 'button', 'connectivity'],
    zeroConfig: false,
    cloud: false,
    implemented: true,
    docsUrl: 'https://www.zigbee2mqtt.io/',
    configSchema: [
      { key: 'host', label: 'Broker address', type: 'host', required: true, placeholder: '192.168.1.10' },
      { key: 'port', label: 'Port', type: 'number', default: 1883 },
      { key: 'username', label: 'Username', type: 'string' },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'zigbee2mqttBase', label: 'zigbee2mqtt base topic', type: 'string', default: 'zigbee2mqtt' },
      { key: 'discoveryPrefix', label: 'Home Assistant discovery prefix', type: 'string', default: 'homeassistant' },
    ],
  }

  #client: MqttClient | null = null
  #context: AdapterContext | null = null
  #config: Record<string, unknown> = {}
  #devices = new Map<string, MqttDevice>()
  #lastError: string | null = null

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#config = config

    const host = String(config.host ?? '')
    if (!host) {
      this.#lastError = 'No broker address configured'
      return
    }

    const client = new MqttClient({
      host,
      port: Number(config.port ?? 1883),
      username: config.username ? String(config.username) : undefined,
      password: config.password ? String(config.password) : undefined,
      clientId: 'sway-home-hub',
    })

    client.onMessage = (topic, payload, retained) => this.#onMessage(topic, payload, retained)
    client.onConnect = () => {
      this.#lastError = null
      context.log('info', `connected to MQTT broker at ${host}`)
      const base = String(config.zigbee2mqttBase ?? 'zigbee2mqtt')
      const prefix = String(config.discoveryPrefix ?? 'homeassistant')
      client.subscribe(`${base}/#`)
      client.subscribe(`${prefix}/#`)
      client.subscribe('tele/+/+')
      client.subscribe('stat/+/+')
      client.subscribe('shellies/#')
    }
    client.onClose = (reason) => {
      this.#lastError = `Broker connection ${reason}`
      for (const device of this.#devices.values()) context.emitAvailability(device.nativeId, false)
    }

    this.#client = client
    const ok = await client.connect()
    if (!ok) this.#lastError = `Could not connect to the broker at ${host}`
  }

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    // A broker on the network with nothing configured is worth pointing out: it is almost
    // always a zigbee2mqtt or Home Assistant install the user forgot they had.
    if (!this.#client?.connected) {
      const broker = hosts.find((host) => host.openPorts.includes(1883) || host.openPorts.includes(8883))
      if (broker && !this.#config.host) {
        this.#context?.log('warn', `an MQTT broker is answering on ${broker.ip}; configure it to import its devices`)
      }
      return []
    }

    // Devices arrive through retained messages rather than a request, so discovery just
    // reports what has been seen so far.
    return [...this.#devices.values()].map((device) => ({
      adapterId: 'mqtt',
      nativeId: device.nativeId,
      uid: `mqtt:${device.nativeId}`,
      name: device.name,
      category: device.category,
      capabilities: device.capabilities,
      transport: 'mqtt' as const,
      manufacturer: device.manufacturer,
      model: device.model,
      confidence: 0.9,
      meta: { source: device.source, stateTopic: device.stateTopic },
    }))
  }

  #onMessage(topic: string, payload: string, retained: boolean): void {
    const base = String(this.#config.zigbee2mqttBase ?? 'zigbee2mqtt')
    const prefix = String(this.#config.discoveryPrefix ?? 'homeassistant')

    if (topic === `${base}/bridge/devices`) {
      // A bridge the Zigbee adapter is watching is its to import, not ours.
      if (activeZigbeeBridges.has(bridgeKey(String(this.#config.host ?? ''), Number(this.#config.port ?? 1883), base))) return
      this.#importZigbee2mqtt(payload)
      return
    }
    if (topic.startsWith(`${prefix}/`) && topic.endsWith('/config') && retained) {
      this.#importDiscovery(topic, payload)
      return
    }

    // zigbee2mqtt state: `zigbee2mqtt/<friendly name>` with a JSON body.
    if (topic.startsWith(`${base}/`) && !topic.includes('/bridge/') && !topic.endsWith('/set') && !topic.endsWith('/get')) {
      const friendly = topic.slice(base.length + 1)
      const device = this.#devices.get(friendly)
      if (!device) return
      const state = mapZigbeeState(safeJson(payload))
      if (Object.keys(state).length > 0) {
        device.state = { ...device.state, ...state }
        this.#context?.emitState(friendly, state)
        this.#context?.emitAvailability(friendly, true)
      }
      return
    }

    // Tasmota telemetry: `tele/<topic>/STATE` and `tele/<topic>/SENSOR`.
    const tasmota = /^tele\/([^/]+)\/(STATE|SENSOR)$/.exec(topic)
    if (tasmota?.[1]) {
      const device = this.#devices.get(tasmota[1]) ?? this.#registerTasmota(tasmota[1])
      const state = mapTasmotaState(safeJson(payload))
      if (Object.keys(state).length > 0) {
        device.state = { ...device.state, ...state }
        this.#context?.emitState(device.nativeId, state)
      }
    }
  }

  #importZigbee2mqtt(payload: string): void {
    const list = safeJson(payload)
    if (!Array.isArray(list)) return

    for (const entry of list as Record<string, any>[]) {
      const friendly = String(entry.friendly_name ?? '')
      if (!friendly || entry.type === 'Coordinator') continue

      const exposes = collectExposes(entry.definition?.exposes ?? [])
      const { category, capabilities } = classifyZigbee(exposes)
      const base = String(this.#config.zigbee2mqttBase ?? 'zigbee2mqtt')

      const device: MqttDevice = {
        nativeId: friendly,
        name: friendly,
        category,
        capabilities,
        stateTopic: `${base}/${friendly}`,
        commandTopic: `${base}/${friendly}/set`,
        source: 'zigbee2mqtt',
        manufacturer: entry.manufacturer ?? entry.definition?.vendor ?? null,
        model: entry.definition?.model ?? entry.model_id ?? null,
        state: {},
      }
      this.#devices.set(friendly, device)
      this.#context?.emitDiscovered({
        adapterId: 'mqtt',
        nativeId: friendly,
        uid: `mqtt:zigbee:${entry.ieee_address ?? friendly}`,
        name: friendly,
        category,
        capabilities,
        transport: 'zigbee',
        manufacturer: device.manufacturer,
        model: device.model,
        confidence: 0.95,
        meta: { source: 'zigbee2mqtt', ieee: entry.ieee_address ?? null },
      })
    }
  }

  #importDiscovery(topic: string, payload: string): void {
    const config = safeJson(payload) as Record<string, any> | null
    if (!config?.state_topic) return
    const parts = topic.split('/')
    const component = parts[1] ?? 'sensor'
    const objectId = parts.slice(2, -1).join('_')

    const { category, capabilities } = classifyDiscovery(component, config)
    const device: MqttDevice = {
      nativeId: objectId,
      name: config.name ?? objectId,
      category,
      capabilities,
      stateTopic: config.state_topic,
      commandTopic: config.command_topic ?? null,
      source: 'discovery',
      manufacturer: config.device?.manufacturer ?? null,
      model: config.device?.model ?? null,
      state: {},
    }
    this.#devices.set(objectId, device)
    this.#client?.subscribe(config.state_topic)
  }

  #registerTasmota(topic: string): MqttDevice {
    const device: MqttDevice = {
      nativeId: topic,
      name: topic,
      category: 'switch',
      capabilities: ['onoff', 'power', 'energy', 'connectivity'],
      stateTopic: `tele/${topic}/STATE`,
      commandTopic: `cmnd/${topic}`,
      source: 'tasmota',
      manufacturer: 'Tasmota',
      model: null,
      state: {},
    }
    this.#devices.set(topic, device)
    return device
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    return { ...(this.#devices.get(nativeId)?.state ?? {}) }
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const device = this.#devices.get(nativeId)
    if (!device?.commandTopic) return { ok: false, deviceId: nativeId, command, error: 'No command topic for this device' }
    if (!this.#client?.connected) return { ok: false, deviceId: nativeId, command, error: 'Broker is not connected' }

    const before = { ...device.state }

    if (device.source === 'tasmota') {
      const mapped = tasmotaCommand(command, args, before)
      if (!mapped) return { ok: false, deviceId: nativeId, command, error: `MQTT Tasmota does not support ${command}` }
      this.#client.publish(`${device.commandTopic}/${mapped.suffix}`, mapped.payload)
      return { ok: true, deviceId: nativeId, command, undo: undoFrom(command, before) }
    }

    const body = zigbeeCommand(command, args)
    if (!body) return { ok: false, deviceId: nativeId, command, error: `MQTT does not support ${command}` }
    this.#client.publish(device.commandTopic, JSON.stringify(body))
    return { ok: true, deviceId: nativeId, command, undo: undoFrom(command, before) }
  }

  status(): AdapterStatus {
    if (!this.#config.host) return { health: 'needs_setup', deviceCount: 0, message: 'No broker configured' }
    if (!this.#client?.connected) return { health: 'error', deviceCount: this.#devices.size, message: this.#lastError ?? 'Not connected' }
    return { health: 'ok', deviceCount: this.#devices.size, message: `${this.#devices.size} devices on ${String(this.#config.host)}` }
  }

  async shutdown(): Promise<void> {
    this.#client?.disconnect()
    this.#client = null
    this.#devices.clear()
  }
}

// ---------------------------------------------------------------------------------------
// Topic translation
// ---------------------------------------------------------------------------------------

function safeJson(payload: string): unknown {
  try {
    return JSON.parse(payload)
  } catch {
    return payload
  }
}

function collectExposes(exposes: Record<string, any>[]): Set<string> {
  const out = new Set<string>()
  const walk = (list: Record<string, any>[]) => {
    for (const item of list ?? []) {
      if (item.property) out.add(String(item.property))
      if (item.name) out.add(String(item.name))
      if (item.type) out.add(String(item.type))
      if (Array.isArray(item.features)) walk(item.features)
    }
  }
  walk(exposes)
  return out
}

function classifyZigbee(exposes: Set<string>): { category: DeviceCategory; capabilities: CapabilityId[] } {
  const capabilities: CapabilityId[] = []
  let category: DeviceCategory = 'sensor'

  if (exposes.has('state') || exposes.has('switch')) capabilities.push('onoff')
  if (exposes.has('brightness')) {
    capabilities.push('brightness')
    category = 'light'
  }
  if (exposes.has('color_temp')) capabilities.push('colorTemperature')
  if (exposes.has('color_xy') || exposes.has('color_hs') || exposes.has('color')) capabilities.push('color')
  if (exposes.has('light')) category = 'light'
  if (exposes.has('position') || exposes.has('cover')) {
    capabilities.push('position')
    category = 'cover'
  }
  if (exposes.has('lock') || exposes.has('state_lock')) {
    capabilities.push('lock')
    category = 'lock'
  }
  if (exposes.has('occupancy')) capabilities.push('motion', 'occupancy')
  if (exposes.has('contact')) capabilities.push('contact')
  if (exposes.has('temperature')) capabilities.push('temperature')
  if (exposes.has('humidity')) capabilities.push('humidity')
  if (exposes.has('pressure')) capabilities.push('pressure')
  if (exposes.has('illuminance') || exposes.has('illuminance_lux')) capabilities.push('illuminance')
  if (exposes.has('battery')) capabilities.push('battery')
  if (exposes.has('power')) capabilities.push('power')
  if (exposes.has('energy')) capabilities.push('energy')
  if (exposes.has('water_leak')) capabilities.push('waterLeak')
  if (exposes.has('smoke')) capabilities.push('smoke')
  if (exposes.has('action')) capabilities.push('button')
  if (exposes.has('climate') || exposes.has('occupied_heating_setpoint')) {
    capabilities.push('thermostat')
    category = 'climate'
  }

  if (capabilities.includes('onoff') && category === 'sensor') category = 'switch'
  capabilities.push('connectivity')
  return { category, capabilities: [...new Set(capabilities)] }
}

function classifyDiscovery(component: string, config: Record<string, any>): { category: DeviceCategory; capabilities: CapabilityId[] } {
  const deviceClass = String(config.device_class ?? '').toLowerCase()
  switch (component) {
    case 'light':
      return { category: 'light', capabilities: ['onoff', 'brightness', 'colorTemperature', 'color'] }
    case 'switch':
      return { category: 'switch', capabilities: ['onoff'] }
    case 'cover':
      return { category: 'cover', capabilities: ['position'] }
    case 'lock':
      return { category: 'lock', capabilities: ['lock'] }
    case 'climate':
      return { category: 'climate', capabilities: ['thermostat'] }
    case 'binary_sensor':
      if (deviceClass === 'motion') return { category: 'sensor', capabilities: ['motion'] }
      if (deviceClass === 'door' || deviceClass === 'window' || deviceClass === 'opening') return { category: 'sensor', capabilities: ['contact'] }
      if (deviceClass === 'moisture') return { category: 'sensor', capabilities: ['waterLeak'] }
      if (deviceClass === 'smoke') return { category: 'sensor', capabilities: ['smoke'] }
      return { category: 'sensor', capabilities: ['contact'] }
    default:
      if (deviceClass === 'temperature') return { category: 'sensor', capabilities: ['temperature'] }
      if (deviceClass === 'humidity') return { category: 'sensor', capabilities: ['humidity'] }
      if (deviceClass === 'power') return { category: 'energy', capabilities: ['power'] }
      if (deviceClass === 'energy') return { category: 'energy', capabilities: ['energy'] }
      if (deviceClass === 'battery') return { category: 'sensor', capabilities: ['battery'] }
      return { category: 'sensor', capabilities: [] }
  }
}

function mapZigbeeState(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object') return {}
  const raw = payload as Record<string, any>
  const state: Record<string, unknown> = {}

  if (typeof raw.state === 'string') state.on = raw.state === 'ON'
  if (typeof raw.brightness === 'number') state.brightness = Math.round((raw.brightness / 254) * 100)
  if (typeof raw.color_temp === 'number') state.colorTemperature = Math.round(1_000_000 / raw.color_temp)
  if (raw.color?.hue !== undefined) {
    state.hue = raw.color.hue
    state.saturation = raw.color.saturation ?? 100
  }
  if (typeof raw.position === 'number') state.position = raw.position
  if (typeof raw.occupancy === 'boolean') {
    state.motion = raw.occupancy
    state.occupied = raw.occupancy
  }
  if (typeof raw.contact === 'boolean') state.open = !raw.contact
  if (typeof raw.temperature === 'number') state.temperature = raw.temperature
  if (typeof raw.humidity === 'number') state.humidity = raw.humidity
  if (typeof raw.pressure === 'number') state.pressure = raw.pressure
  if (typeof raw.illuminance_lux === 'number') state.illuminance = raw.illuminance_lux
  else if (typeof raw.illuminance === 'number') state.illuminance = raw.illuminance
  if (typeof raw.battery === 'number') {
    state.battery = raw.battery
    state.batteryLow = raw.battery <= 20
  }
  if (typeof raw.power === 'number') state.power = raw.power
  if (typeof raw.energy === 'number') state.energyTotal = raw.energy
  if (typeof raw.water_leak === 'boolean') state.leak = raw.water_leak
  if (typeof raw.smoke === 'boolean') state.smoke = raw.smoke
  if (typeof raw.linkquality === 'number') state.linkQuality = raw.linkquality
  if (typeof raw.action === 'string' && raw.action.length > 0) {
    state.lastEvent = raw.action.includes('double') ? 'double' : raw.action.includes('hold') ? 'hold' : 'single'
    state.lastEventAt = new Date().toISOString()
  }
  if (typeof raw.lock_state === 'string') state.locked = raw.lock_state === 'locked'

  return state
}

function mapTasmotaState(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object') return {}
  const raw = payload as Record<string, any>
  const state: Record<string, unknown> = {}

  if (typeof raw.POWER === 'string') state.on = raw.POWER === 'ON'
  if (typeof raw.POWER1 === 'string') state.on = raw.POWER1 === 'ON'
  if (typeof raw.Dimmer === 'number') state.brightness = raw.Dimmer
  if (typeof raw.Wifi?.RSSI === 'number') state.rssi = raw.Wifi.RSSI - 100
  if (raw.ENERGY) {
    if (typeof raw.ENERGY.Power === 'number') state.power = raw.ENERGY.Power
    if (typeof raw.ENERGY.Total === 'number') state.energyTotal = raw.ENERGY.Total
    if (typeof raw.ENERGY.Voltage === 'number') state.voltage = raw.ENERGY.Voltage
  }
  for (const value of Object.values(raw)) {
    if (value === null || typeof value !== 'object') continue
    const sensor = value as Record<string, unknown>
    if (typeof sensor.Temperature === 'number') state.temperature = sensor.Temperature
    if (typeof sensor.Humidity === 'number') state.humidity = sensor.Humidity
  }

  return state
}

/** Zigbee2MQTT takes absolute values, so the previous state is not needed to build a command. */
function zigbeeCommand(command: string, args: Record<string, unknown>): Record<string, unknown> | null {
  const transition = Number(args.transitionMs ?? 400) / 1000
  switch (command) {
    case 'turnOn':
      return { state: 'ON', transition }
    case 'turnOff':
      return { state: 'OFF', transition }
    case 'toggle':
      return { state: 'TOGGLE' }
    case 'setBrightness':
      return { state: Number(args.brightness ?? 0) > 0 ? 'ON' : 'OFF', brightness: Math.round((Number(args.brightness ?? 0) / 100) * 254), transition }
    case 'stepBrightness':
      return { brightness_step: Math.round((Number(args.delta ?? 0) / 100) * 254), transition }
    case 'setColorTemperature':
      return { state: 'ON', color_temp: Math.round(1_000_000 / Number(args.kelvin ?? 3000)), transition }
    case 'setColor':
      return { state: 'ON', color: { hue: Number(args.hue ?? 0), saturation: Number(args.saturation ?? 100) }, transition }
    case 'setColorRgb':
      return { state: 'ON', color: { r: Number(args.r ?? 0), g: Number(args.g ?? 0), b: Number(args.b ?? 0) }, transition }
    case 'setPosition':
      return { position: Math.round(Number(args.position ?? 0)) }
    case 'open':
      return { state: 'OPEN' }
    case 'close':
      return { state: 'CLOSE' }
    case 'stop':
      return { state: 'STOP' }
    case 'lock':
      return { state: 'LOCK' }
    case 'unlock':
      return { state: 'UNLOCK' }
    case 'setTargetTemperature':
      return { occupied_heating_setpoint: Number(args.celsius ?? 20) }
    case 'identify':
      return { effect: 'blink' }
    default:
      return null
  }
}

function tasmotaCommand(command: string, args: Record<string, unknown>, before: Record<string, unknown>): { suffix: string; payload: string } | null {
  switch (command) {
    case 'turnOn':
      return { suffix: 'Power', payload: 'ON' }
    case 'turnOff':
      return { suffix: 'Power', payload: 'OFF' }
    case 'toggle':
      return { suffix: 'Power', payload: 'TOGGLE' }
    case 'setBrightness':
      return { suffix: 'Dimmer', payload: String(Math.round(Number(args.brightness ?? 0))) }
    case 'stepBrightness':
      return { suffix: 'Dimmer', payload: String(Math.round(Math.min(100, Math.max(0, Number(before.brightness ?? 0) + Number(args.delta ?? 0))))) }
    default:
      return null
  }
}

function undoFrom(command: string, before: Record<string, unknown>): { command: string; args: Record<string, unknown> } | null {
  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'toggle':
      return { command: before.on === true ? 'turnOn' : 'turnOff', args: {} }
    case 'setBrightness':
    case 'stepBrightness':
      return { command: 'setBrightness', args: { brightness: Number(before.brightness ?? 100) } }
    case 'setPosition':
    case 'open':
    case 'close':
      return { command: 'setPosition', args: { position: Number(before.position ?? 0) } }
    case 'lock':
    case 'unlock':
      return { command: before.locked === true ? 'lock' : 'unlock', args: {} }
    default:
      return null
  }
}
