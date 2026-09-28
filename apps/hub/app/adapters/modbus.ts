/**
 * Modbus TCP: solar inverters and meters by themselves, anything else from a point map.
 *
 *  - **SunSpec needs nothing.** Every host with port 502 open (and any address given in the
 *    settings) is asked for "SunS" at 40000, 50000 and 0 on the unit ids inverters use; the
 *    model chain that follows names the device (model 1) and gives its readings (inverter
 *    and meter models, with their scale factors). A device answering the same thing on every
 *    unit id is kept once, by serial number.
 *  - **Anything else is mapped once by hand** in the settings (see `parsePoints`): a heat
 *    pump's temperature and set point, a relay board's coils. Each mistake in the map is said
 *    with the point's number, and the points that are right still work.
 *  - **Read by polling**, one request at a time per device (`ModbusClient`). A device that
 *    stops answering goes offline after a few rounds and comes back by itself.
 */

import type { AdapterContext, AdapterDescriptor, AdapterStatus, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { ModbusClient, ModbusException, ModbusUnreachable } from '#adapters/modbus_client'
import {
  INVERTER_MODELS,
  MAX_READ_REGISTERS,
  METER_MODELS,
  MODBUS_PORT,
  SUNSPEC_BASES,
  SUNSPEC_END,
  SUNSPEC_UNITS,
  commandWrites,
  commonFrom,
  decodeValue,
  devicesFrom,
  isSunSpecMarker,
  parsePoints,
  registerCount,
  stateFrom,
  sunspecState,
  type CustomDevice,
  type ModbusPoint,
  type SunSpecIdentity,
} from '#adapters/modbus_codec'

export interface ModbusOptions {
  /** Port asked on discovered hosts; the settings may give another one per address. */
  port?: number
  requestTimeoutMs?: number
  pollMs?: number
  /** Failed rounds in a row before a device is reported offline. */
  offlineAfter?: number
}

interface SunSpecDevice {
  nativeId: string
  host: string
  port: number
  unit: number
  modelId: number
  /** First register of the model's data, after its two-register header. */
  address: number
  length: number
  name: string
  manufacturer: string
  model: string
  serial: string
  mac: string | null
}

const POINTS_HELP =
  'Une liste JSON, un objet par valeur : {"device": "Pompe à chaleur", "host": "192.168.1.60", "unit": 1, "table": "holding", "address": 20, "type": "int16", "scale": 0.1, "role": "setpoint"}. Tables : holding, input, coil, discrete. Rôles : temperature, humidity, power, energy, onoff, setpoint, position, valve.'

function parseHosts(text: unknown, defaultPort: number): { host: string; port: number }[] {
  if (typeof text !== 'string') return []
  return text
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((entry) => {
      const match = /^(.+?)(?::(\d{1,5}))?$/.exec(entry)
      return { host: match?.[1] ?? entry, port: match?.[2] ? Number(match[2]) : defaultPort }
    })
}

export class ModbusAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'modbus',
    name: 'Modbus TCP',
    vendor: 'Modbus Organization',
    transports: ['modbus', 'ethernet'],
    capabilities: ['onoff', 'power', 'energy', 'temperature', 'humidity', 'thermostat', 'valve', 'position'],
    zeroConfig: true,
    cloud: false,
    implemented: true,
    docsUrl: 'https://sunspec.org/sunspec-modbus-specifications/',
    configSchema: [
      { key: 'points', label: 'Points Modbus (JSON)', type: 'text', help: POINTS_HELP },
      {
        key: 'hosts',
        label: 'Adresses SunSpec à interroger',
        type: 'string',
        placeholder: '192.168.1.50, 192.168.1.51:1502',
        help: "Onduleurs ou compteurs que le scan ne voit pas (autre réseau, port différent). Ceux du réseau local sont trouvés seuls.",
      },
      { key: 'pollSeconds', label: 'Lecture toutes les (secondes)', type: 'number', default: 10 },
    ],
  }

  readonly #options: Required<ModbusOptions>
  #context: AdapterContext | null = null
  #clients = new Map<string, ModbusClient>()
  #sunspec = new Map<string, SunSpecDevice>()
  #custom: CustomDevice[] = []
  #values = new Map<string, number | boolean | null>()
  #configErrors: string[] = []
  #extraHosts: { host: string; port: number }[] = []
  #failures = new Map<string, number>()
  #offline = new Set<string>()
  #emitted = new Map<string, string>()
  #timer: ReturnType<typeof setInterval> | null = null
  #polling = false
  #stopped = false

  constructor(options: ModbusOptions = {}) {
    this.#options = {
      port: options.port ?? MODBUS_PORT,
      requestTimeoutMs: options.requestTimeoutMs ?? 1500,
      pollMs: options.pollMs ?? 10_000,
      offlineAfter: options.offlineAfter ?? 3,
    }
  }

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#stopped = false
    const { points, errors } = parsePoints(typeof config.points === 'string' ? config.points : '')
    this.#custom = devicesFrom(points)
    this.#configErrors = errors
    this.#extraHosts = parseHosts(config.hosts, this.#options.port)
    for (const entry of (await context.store.get<SunSpecDevice[]>('sunspec')) ?? []) this.#sunspec.set(entry.nativeId, entry)

    const seconds = Number(config.pollSeconds)
    const every = Number.isFinite(seconds) && seconds >= 1 ? seconds * 1000 : this.#options.pollMs
    this.#timer = setInterval(() => void this.#pollAll(), every)
    void this.#pollAll()
  }

  #client(host: string, port: number): ModbusClient {
    const key = `${host}:${port}`
    let client = this.#clients.get(key)
    if (!client) {
      client = new ModbusClient(host, port, this.#options.requestTimeoutMs)
      this.#clients.set(key, client)
    }
    return client
  }

  // -------------------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------------------

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    const targets = new Map<string, { host: string; port: number; mac: string | null }>()
    for (const host of hosts) {
      if ((host.openPorts ?? []).includes(MODBUS_PORT)) targets.set(`${host.ip}:${this.#options.port}`, { host: host.ip, port: this.#options.port, mac: host.mac })
    }
    for (const extra of this.#extraHosts) targets.set(`${extra.host}:${extra.port}`, { ...extra, mac: null })

    const found = (await Promise.all([...targets.values()].map((target) => this.#probe(target.host, target.port, target.mac)))).flat()
    for (const device of found) this.#sunspec.set(device.nativeId, device)
    await this.#context?.store.set('sunspec', [...this.#sunspec.values()])
    void this.#pollAll()

    return [...found.map((device) => this.#sunspecDevice(device)), ...this.#custom.map((device) => this.#customDevice(device))]
  }

  /** SunSpec devices behind one address: every unit id worth asking, each model worth reading. */
  async #probe(host: string, port: number, mac: string | null): Promise<SunSpecDevice[]> {
    const client = this.#client(host, port)
    const devices: SunSpecDevice[] = []
    const seen = new Set<string>()

    for (const unit of SUNSPEC_UNITS) {
      let base: number | null = null
      for (const candidate of SUNSPEC_BASES) {
        try {
          if (isSunSpecMarker((await client.read(unit, 'holding', candidate, 2)) as number[])) {
            base = candidate
            break
          }
        } catch (error) {
          // Silence means nobody answers for this unit id: the other addresses would be silent too.
          if (error instanceof ModbusUnreachable) break
        }
      }
      if (base === null) continue

      let identity: SunSpecIdentity | null = null
      const models: { id: number; address: number; length: number }[] = []
      try {
        let address = base + 2
        for (let count = 0; count < 64 && address < 0xffff; count++) {
          const [id, length] = (await client.read(unit, 'holding', address, 2)) as number[]
          if (id === undefined || length === undefined || id === SUNSPEC_END) break
          if (id === 1) identity = commonFrom((await client.read(unit, 'holding', address + 2, Math.min(length, MAX_READ_REGISTERS))) as number[])
          else if ((INVERTER_MODELS.has(id) || METER_MODELS.has(id)) && length <= MAX_READ_REGISTERS) models.push({ id, address: address + 2, length })
          address += 2 + length
        }
      } catch {
        // A chain cut short still gives the models read so far.
      }

      const who = identity?.serial ? `${identity.manufacturer}/${identity.serial}` : `${identity?.manufacturer}/${identity?.model}/${models.map((model) => model.id).join(',')}`
      if (seen.has(who)) continue
      seen.add(who)

      const counts = new Map<number, number>()
      for (const model of models) {
        const index = counts.get(model.id) ?? 0
        counts.set(model.id, index + 1)
        const label = [identity?.manufacturer, identity?.model].filter(Boolean).join(' ') || `Appareil SunSpec ${host}`
        const isMeter = METER_MODELS.has(model.id)
        devices.push({
          nativeId: `sunspec:${identity?.serial || mac || host}:${unit}:${model.id}${index > 0 ? `-${index}` : ''}`,
          host,
          port,
          unit,
          modelId: model.id,
          address: model.address,
          length: model.length,
          name: isMeter && !/meter|compteur|zähler/i.test(label) ? `Compteur (${label})` : label,
          manufacturer: identity?.manufacturer ?? '',
          model: identity?.model ?? '',
          serial: identity?.serial ?? '',
          mac,
        })
      }
    }
    return devices
  }

  #sunspecDevice(device: SunSpecDevice): DiscoveredDevice {
    return {
      adapterId: 'modbus',
      nativeId: device.nativeId,
      uid: `modbus:${device.nativeId}`,
      name: device.name,
      category: 'energy',
      capabilities: ['power', 'energy'],
      transport: 'ethernet',
      manufacturer: device.manufacturer || null,
      model: device.model || null,
      serialNumber: device.serial || null,
      confidence: 0.9,
      network: { ip: device.host, mac: device.mac },
      meta: { host: device.host, port: device.port, unit: device.unit, sunspecModel: device.modelId },
      requiresPairing: null,
    }
  }

  #customDevice(device: CustomDevice): DiscoveredDevice {
    const host = device.points[0]?.host ?? null
    return {
      adapterId: 'modbus',
      nativeId: device.id,
      uid: `modbus:${device.id}`,
      name: device.name,
      category: device.category,
      capabilities: device.capabilities,
      transport: 'ethernet',
      confidence: 1,
      network: { ip: host },
      meta: { points: device.points.length },
      requiresPairing: null,
    }
  }

  // -------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------

  async #pollAll(): Promise<void> {
    if (this.#polling || this.#stopped) return
    this.#polling = true
    try {
      await Promise.all([...[...this.#sunspec.values()].map((device) => this.#pollSunSpec(device)), ...this.#custom.map((device) => this.#pollCustom(device))])
    } finally {
      this.#polling = false
    }
  }

  async #pollSunSpec(device: SunSpecDevice): Promise<void> {
    try {
      const block = (await this.#client(device.host, device.port).read(device.unit, 'holding', device.address, device.length)) as number[]
      const state = sunspecState(device.modelId, block)
      this.#reached(device.nativeId, true)
      if (state) this.#emit(device.nativeId, state)
    } catch {
      this.#reached(device.nativeId, false)
    }
  }

  async #readPoint(point: ModbusPoint): Promise<number | boolean | null> {
    const client = this.#client(point.host, point.port)
    if (point.table === 'coil' || point.table === 'discrete') {
      const [bit] = (await client.read(point.unit, point.table, point.address, 1)) as boolean[]
      return bit ?? null
    }
    const registers = (await client.read(point.unit, point.table, point.address, registerCount(point.type))) as number[]
    return decodeValue(registers, point.type, point.wordOrder)
  }

  async #pollCustom(device: CustomDevice): Promise<void> {
    let reached = false
    for (const point of device.points) {
      try {
        this.#values.set(point.key, await this.#readPoint(point))
        reached = true
      } catch (error) {
        // An exception is the device answering: the point is wrong, the device is there.
        if (error instanceof ModbusException) {
          reached = true
          this.#context?.log('warn', 'Modbus point refused', { device: device.name, point: point.key, error: error.message })
          continue
        }
        break
      }
    }
    this.#reached(device.id, reached)
    if (reached) this.#emit(device.id, stateFrom(device, this.#values))
  }

  #reached(nativeId: string, ok: boolean): void {
    if (ok) {
      this.#failures.set(nativeId, 0)
      if (this.#offline.delete(nativeId)) this.#context?.emitAvailability(nativeId, true)
      return
    }
    const failures = (this.#failures.get(nativeId) ?? 0) + 1
    this.#failures.set(nativeId, failures)
    if (failures >= this.#options.offlineAfter && !this.#offline.has(nativeId)) {
      this.#offline.add(nativeId)
      this.#context?.emitAvailability(nativeId, false)
    }
  }

  #emit(nativeId: string, state: Record<string, unknown>): void {
    const serialised = JSON.stringify(state)
    if (this.#emitted.get(nativeId) === serialised) return
    this.#emitted.set(nativeId, serialised)
    this.#context?.emitState(nativeId, state)
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const custom = this.#custom.find((device) => device.id === nativeId)
    if (custom) return stateFrom(custom, this.#values)
    const emitted = this.#emitted.get(nativeId)
    return emitted ? (JSON.parse(emitted) as Record<string, unknown>) : {}
  }

  // -------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const fail = (error: string): CommandResult => ({ ok: false, deviceId: nativeId, command, error })
    if (this.#sunspec.has(nativeId)) return fail('Lecture seule : un onduleur ou un compteur SunSpec se consulte, il ne se commande pas.')
    const device = this.#custom.find((entry) => entry.id === nativeId)
    if (!device) return fail('Appareil Modbus inconnu.')

    const before = stateFrom(device, this.#values)
    const plan = commandWrites(device, command, args, this.#values)
    if ('error' in plan) return fail(plan.error)

    for (const write of plan.writes) {
      const { point } = write
      const client = this.#client(point.host, point.port)
      try {
        if ('coil' in write) {
          await client.writeCoil(point.unit, point.address, write.coil)
          this.#values.set(point.key, write.coil)
        } else {
          await client.writeRegisters(point.unit, point.address, write.registers)
          this.#values.set(point.key, decodeValue(write.registers, point.type, point.wordOrder))
        }
      } catch (error) {
        return fail(`${device.name} : ${(error as Error).message}`)
      }
    }

    const state = { ...stateFrom(device, this.#values), ...plan.expect }
    this.#emit(nativeId, state)
    return { ok: true, deviceId: nativeId, command, state, undo: undoFor(command, before) }
  }

  status(): AdapterStatus {
    const deviceCount = this.#sunspec.size + this.#custom.length
    if (this.#configErrors.length > 0) {
      const more = this.#configErrors.length > 1 ? ` (et ${this.#configErrors.length - 1} autre${this.#configErrors.length > 2 ? 's' : ''})` : ''
      return { health: 'degraded', message: `${this.#configErrors[0]}${more}`, deviceCount }
    }
    if (this.#offline.size > 0) {
      const names = [...this.#offline].map((id) => this.#sunspec.get(id)?.name ?? this.#custom.find((device) => device.id === id)?.name ?? id)
      return { health: 'degraded', message: `Sans réponse : ${names.join(', ')}.`, deviceCount }
    }
    return { health: 'ok', deviceCount }
  }

  async shutdown(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    for (const client of this.#clients.values()) client.close()
    this.#clients.clear()
  }
}

function undoFor(command: string, before: Record<string, unknown>): CommandResult['undo'] {
  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'toggle':
      return typeof before.on === 'boolean' ? { command: before.on ? 'turnOn' : 'turnOff', args: {} } : null
    case 'setTargetTemperature':
      return typeof before.targetTemperature === 'number' ? { command: 'setTargetTemperature', args: { celsius: before.targetTemperature } } : null
    case 'open':
    case 'close':
    case 'setPosition':
      return typeof before.position === 'number' ? { command: 'setPosition', args: { position: before.position } } : null
    case 'openValve':
    case 'closeValve':
      return typeof before.valveOpen === 'boolean' ? { command: before.valveOpen ? 'openValve' : 'closeValve', args: {} } : null
    default:
      return null
  }
}
