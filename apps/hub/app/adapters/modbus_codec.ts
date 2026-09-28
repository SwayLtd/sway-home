/**
 * Modbus TCP: frames, values, SunSpec and hand-written point maps. No I/O.
 *
 * Modbus says nothing about what a register means. Two ways to know:
 *  - **SunSpec**, which most solar inverters and many meters follow: "SunS" at 40000 (or
 *    50000, or 0), then a chain of numbered models, each a fixed layout with scale factors.
 *    That is zero configuration for production and grid readings.
 *  - **A point map** written once for a heat pump, a ventilation unit or a relay board: for
 *    each point, where it is (host, unit, table, address), how it is encoded (type, word
 *    order, scale) and what it is for (a role: temperature, setpoint, onoff...).
 *
 * Sources: Modbus Application Protocol v1.1b3, Modbus Messaging on TCP/IP v1.0b, SunSpec
 * information models (github.com/sunspec/models: models 1, 101-103, 111-113, 201-204, 211-214).
 */

import type { CapabilityId, DeviceCategory } from '@sway-home/shared'

export const MODBUS_PORT = 502
/** Largest register read a request may ask for. */
export const MAX_READ_REGISTERS = 125

export type Table = 'coil' | 'discrete' | 'holding' | 'input'
export type ValueType = 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32' | 'acc32'
export type WordOrder = 'big' | 'little'

const READ_FUNCTION: Record<Table, number> = { coil: 0x01, discrete: 0x02, holding: 0x03, input: 0x04 }

// ---------------------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------------------

export function readPdu(table: Table, address: number, count: number): Buffer {
  const pdu = Buffer.alloc(5)
  pdu[0] = READ_FUNCTION[table]
  pdu.writeUInt16BE(address, 1)
  pdu.writeUInt16BE(count, 3)
  return pdu
}

export function writeCoilPdu(address: number, on: boolean): Buffer {
  const pdu = Buffer.alloc(5)
  pdu[0] = 0x05
  pdu.writeUInt16BE(address, 1)
  pdu.writeUInt16BE(on ? 0xff00 : 0x0000, 3)
  return pdu
}

export function writeRegisterPdu(address: number, value: number): Buffer {
  const pdu = Buffer.alloc(5)
  pdu[0] = 0x06
  pdu.writeUInt16BE(address, 1)
  pdu.writeUInt16BE(value & 0xffff, 3)
  return pdu
}

export function writeRegistersPdu(address: number, values: number[]): Buffer {
  const pdu = Buffer.alloc(6 + values.length * 2)
  pdu[0] = 0x10
  pdu.writeUInt16BE(address, 1)
  pdu.writeUInt16BE(values.length, 3)
  pdu[5] = values.length * 2
  values.forEach((value, index) => pdu.writeUInt16BE(value & 0xffff, 6 + index * 2))
  return pdu
}

/** The MBAP header around a PDU: transaction, protocol 0, length of what follows, unit. */
export function frame(transactionId: number, unitId: number, pdu: Buffer): Buffer {
  const header = Buffer.alloc(7)
  header.writeUInt16BE(transactionId & 0xffff, 0)
  header.writeUInt16BE(0, 2)
  header.writeUInt16BE(pdu.length + 1, 4)
  header[6] = unitId & 0xff
  return Buffer.concat([header, pdu])
}

export class ModbusProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModbusProtocolError'
  }
}

export interface Adu {
  transactionId: number
  unitId: number
  pdu: Buffer
}

/** Whole answers out of a TCP stream, however it was cut. */
export class AduReader {
  #buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Adu[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const out: Adu[] = []
    while (this.#buffer.length >= 7) {
      const length = this.#buffer.readUInt16BE(4)
      if (this.#buffer.readUInt16BE(2) !== 0 || length < 2 || length > 254) throw new ModbusProtocolError('Trame Modbus invalide.')
      if (this.#buffer.length < 6 + length) break
      out.push({ transactionId: this.#buffer.readUInt16BE(0), unitId: this.#buffer[6]!, pdu: Buffer.from(this.#buffer.subarray(7, 6 + length)) })
      this.#buffer = this.#buffer.subarray(6 + length)
    }
    return out
  }
}

const EXCEPTIONS: Record<number, string> = {
  1: 'fonction non prise en charge',
  2: 'adresse de registre invalide',
  3: 'valeur refusée',
  4: "panne de l'appareil",
  5: 'demande acceptée, traitement en cours',
  6: 'appareil occupé',
  8: 'erreur de parité mémoire',
  10: 'passerelle : chemin indisponible',
  11: "passerelle : l'appareil ne répond pas",
}

export function exceptionMessage(code: number): string {
  return EXCEPTIONS[code] ?? `exception ${code}`
}

export type ModbusAnswer = { registers: number[] } | { bits: boolean[] } | { written: true } | { exception: number; message: string }

/** What an answer PDU says, read against the request it answers. */
export function parseAnswer(request: Buffer, pdu: Buffer): ModbusAnswer {
  const code = request[0]!
  if (pdu[0] === (code | 0x80)) {
    const exception = pdu[1] ?? 0
    return { exception, message: exceptionMessage(exception) }
  }
  if (pdu[0] !== code) return { exception: -1, message: 'réponse à une autre demande' }
  switch (code) {
    case 0x01:
    case 0x02: {
      const count = request.readUInt16BE(3)
      if ((pdu[1] ?? 0) < Math.ceil(count / 8) || pdu.length < 2 + Math.ceil(count / 8)) return { exception: -1, message: 'réponse tronquée' }
      return { bits: Array.from({ length: count }, (_, index) => ((pdu[2 + (index >> 3)]! >> (index & 7)) & 1) === 1) }
    }
    case 0x03:
    case 0x04: {
      const count = request.readUInt16BE(3)
      if (pdu[1] !== count * 2 || pdu.length < 2 + count * 2) return { exception: -1, message: 'réponse tronquée' }
      return { registers: Array.from({ length: count }, (_, index) => pdu.readUInt16BE(2 + index * 2)) }
    }
    default:
      return { written: true }
  }
}

// ---------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------

export function registerCount(type: ValueType): number {
  return type === 'uint16' || type === 'int16' ? 1 : 2
}

/** Rounded to six decimals, so a scale of 0.1 reads 21.5 and not 21.500000000000004. */
const tidy = (value: number) => Number(value.toFixed(6))

/**
 * A number out of registers. With `sunspec`, the values SunSpec uses for "not implemented"
 * (0x8000, 0xFFFF, NaN) read as null.
 */
export function decodeValue(registers: number[], type: ValueType, wordOrder: WordOrder = 'big', options: { sunspec?: boolean } = {}): number | null {
  const count = registerCount(type)
  if (registers.length < count || registers.slice(0, count).some((word) => word === undefined)) return null
  const words = count === 2 && wordOrder === 'little' ? [registers[1]!, registers[0]!] : registers.slice(0, count)
  const [high, low = 0] = words as [number, number?]
  switch (type) {
    case 'uint16':
      return options.sunspec && high === 0xffff ? null : high
    case 'int16':
      if (options.sunspec && high === 0x8000) return null
      return high >= 0x8000 ? high - 0x10000 : high
    case 'uint32':
    case 'acc32': {
      const value = high * 0x10000 + low
      return options.sunspec && type === 'uint32' && value === 0xffffffff ? null : value
    }
    case 'int32': {
      const value = ((high << 16) | low) | 0
      return options.sunspec && value === -0x80000000 ? null : value
    }
    case 'float32': {
      const bytes = Buffer.alloc(4)
      bytes.writeUInt16BE(high, 0)
      bytes.writeUInt16BE(low, 2)
      const value = bytes.readFloatBE(0)
      return Number.isFinite(value) ? value : null
    }
  }
}

/** Registers for a number: the inverse of `decodeValue`, for writes. */
export function encodeValue(value: number, type: ValueType, wordOrder: WordOrder = 'big'): number[] {
  let words: number[]
  switch (type) {
    case 'uint16':
    case 'int16': {
      const whole = Math.round(value)
      words = [(whole < 0 ? whole + 0x10000 : whole) & 0xffff]
      break
    }
    case 'uint32':
    case 'acc32':
    case 'int32': {
      const whole = Math.round(value) >>> 0
      words = [whole >>> 16, whole & 0xffff]
      break
    }
    case 'float32': {
      const bytes = Buffer.alloc(4)
      bytes.writeFloatBE(value, 0)
      words = [bytes.readUInt16BE(0), bytes.readUInt16BE(2)]
      break
    }
  }
  return words.length === 2 && wordOrder === 'little' ? [words[1]!, words[0]!] : words
}

/** Two characters a register, up to the first NUL. */
export function decodeString(registers: number[]): string {
  const bytes = Buffer.alloc(registers.length * 2)
  registers.forEach((word, index) => bytes.writeUInt16BE(word & 0xffff, index * 2))
  const end = bytes.indexOf(0)
  return bytes
    .subarray(0, end === -1 ? bytes.length : end)
    .toString('latin1')
    .trim()
}

// ---------------------------------------------------------------------------------------
// SunSpec
// ---------------------------------------------------------------------------------------

export const SUNSPEC_MARKER = [0x5375, 0x6e53] as const
/** Where "SunS" may start: 40000 almost always, then the two other places the spec allows. */
export const SUNSPEC_BASES = [40000, 50000, 0] as const
/** Unit ids worth asking: 1 (SolarEdge, Fronius, most), 126 (SMA), 240 (meters behind a Fronius). */
export const SUNSPEC_UNITS = [1, 126, 240] as const
export const SUNSPEC_END = 0xffff
export const INVERTER_MODELS = new Set([101, 102, 103, 111, 112, 113])
export const METER_MODELS = new Set([201, 202, 203, 204, 211, 212, 213, 214])

export function isSunSpecMarker(registers: number[]): boolean {
  return registers[0] === SUNSPEC_MARKER[0] && registers[1] === SUNSPEC_MARKER[1]
}

export interface SunSpecIdentity {
  manufacturer: string
  model: string
  version: string
  serial: string
}

/** Model 1: who made the device, what it is, its firmware and serial number. */
export function commonFrom(registers: number[]): SunSpecIdentity {
  return {
    manufacturer: decodeString(registers.slice(0, 16)),
    model: decodeString(registers.slice(16, 32)),
    version: decodeString(registers.slice(40, 48)),
    serial: decodeString(registers.slice(48, 64)),
  }
}

function withoutNulls(state: Record<string, number | boolean | null>): Record<string, number | boolean> {
  return Object.fromEntries(Object.entries(state).filter((entry): entry is [string, number | boolean] => entry[1] !== null))
}

/** The capability state a SunSpec model block gives (header excluded), or null for a model not read here. */
export function sunspecState(modelId: number, block: number[]): Record<string, number | boolean> | null {
  const read = (offset: number, type: ValueType) => decodeValue(block.slice(offset, offset + registerCount(type)), type, 'big', { sunspec: true })
  const scaled = (offset: number, type: ValueType, factorAt: number) => {
    const raw = read(offset, type)
    const factor = read(factorAt, 'int16')
    if (raw === null || factor === null) return null
    return tidy(factor < 0 ? raw / 10 ** -factor : raw * 10 ** factor)
  }
  const float = (offset: number) => {
    const value = read(offset, 'float32')
    return value === null ? null : tidy(value)
  }
  const kilo = (wattHours: number | null) => (wattHours === null ? null : tidy(wattHours / 1000))

  if (INVERTER_MODELS.has(modelId)) {
    const floats = modelId >= 111
    const status = read(floats ? 46 : 36, 'uint16')
    return withoutNulls({
      power: floats ? float(20) : scaled(12, 'int16', 13),
      voltage: floats ? float(14) : scaled(8, 'uint16', 11),
      current: floats ? float(0) : scaled(0, 'uint16', 4),
      energyTotal: kilo(floats ? float(30) : scaled(22, 'acc32', 24)),
      // 4 is MPPT, 5 is throttled: both mean the panels are producing.
      producing: status === null ? null : status === 4 || status === 5,
    })
  }
  if (METER_MODELS.has(modelId)) {
    const floats = modelId >= 211
    return withoutNulls({
      power: floats ? float(26) : scaled(16, 'int16', 20),
      voltage: floats ? float(8) : scaled(5, 'int16', 13),
      current: floats ? float(0) : scaled(0, 'int16', 4),
      energyTotal: kilo(floats ? float(66) : scaled(44, 'acc32', 52)),
      energyReturned: kilo(floats ? float(58) : scaled(36, 'acc32', 52)),
    })
  }
  return null
}

// ---------------------------------------------------------------------------------------
// Points written by hand
// ---------------------------------------------------------------------------------------

export const ROLES = ['temperature', 'humidity', 'power', 'energy', 'onoff', 'setpoint', 'position', 'valve'] as const
export type Role = (typeof ROLES)[number]

const TABLES: Table[] = ['holding', 'input', 'coil', 'discrete']
const TYPES: ValueType[] = ['uint16', 'int16', 'uint32', 'int32', 'float32']
const SWITCHING: Partial<Record<Role, string>> = {
  onoff: 'allumer ou éteindre',
  setpoint: 'régler une consigne',
  position: 'déplacer un volet',
  valve: 'ouvrir ou fermer une vanne',
}
const YES_NO_ROLES = new Set<Role>(['onoff', 'valve'])

const CAPABILITY: Record<Role, CapabilityId> = {
  temperature: 'temperature',
  humidity: 'humidity',
  power: 'power',
  energy: 'energy',
  onoff: 'onoff',
  setpoint: 'thermostat',
  position: 'position',
  valve: 'valve',
}

export interface ModbusPoint {
  /** Where the point lives, unique across the map. */
  key: string
  device: string
  host: string
  port: number
  unit: number
  table: Table
  address: number
  type: ValueType
  wordOrder: WordOrder
  scale: number
  offset: number
  role: Role
}

const isInteger = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

/** The map as written in the adapter's settings; each mistake said with the point's number. */
export function parsePoints(text: string): { points: ModbusPoint[]; errors: string[] } {
  if (text.trim().length === 0) return { points: [], errors: [] }
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch (error) {
    return { points: [], errors: [`Points Modbus : JSON illisible (${(error as Error).message}).`] }
  }
  if (!Array.isArray(list)) return { points: [], errors: ['Points Modbus : une liste [ ... ] est attendue.'] }

  const points: ModbusPoint[] = []
  const errors: string[] = []
  const roles = new Set<string>()
  list.forEach((entry, index) => {
    const at = `Point ${index + 1} : `
    const item = (entry ?? {}) as Record<string, unknown>
    const device = typeof item.device === 'string' ? item.device.trim() : ''
    const host = typeof item.host === 'string' ? item.host.trim() : ''
    const table = item.table as Table
    const role = item.role as Role
    const type = (item.type ?? 'uint16') as ValueType
    const scale = item.scale === undefined ? 1 : Number(item.scale)
    const offset = item.offset === undefined ? 0 : Number(item.offset)
    const unit = item.unit === undefined ? 1 : item.unit
    const port = item.port === undefined ? MODBUS_PORT : item.port
    const bits = table === 'coil' || table === 'discrete'

    let problem: string | null = null
    if (!device) problem = "nom d'appareil manquant."
    else if (!host) problem = 'adresse IP manquante.'
    else if (!TABLES.includes(table)) problem = `table "${String(item.table)}" inconnue (holding, input, coil, discrete).`
    else if (item.address === undefined) problem = 'adresse manquante.'
    else if (!isInteger(item.address, 0, 65535)) problem = `adresse ${String(item.address)} invalide (0 à 65535).`
    else if (!ROLES.includes(role)) problem = `rôle "${String(item.role)}" inconnu (${ROLES.join(', ')}).`
    else if (!bits && !TYPES.includes(type)) problem = `type "${String(item.type)}" inconnu (${TYPES.join(', ')}).`
    else if (!isInteger(unit, 0, 255)) problem = `unité ${String(unit)} invalide (0 à 255).`
    else if (!isInteger(port, 1, 65535)) problem = `port ${String(port)} invalide.`
    else if (!Number.isFinite(scale) || scale === 0 || !Number.isFinite(offset)) problem = "échelle ou décalage invalide."
    else if (bits && !YES_NO_ROLES.has(role)) problem = `une ${table === 'coil' ? 'bobine' : 'entrée tout-ou-rien'} ne donne que oui ou non, pas une valeur pour "${role}".`
    else if ((table === 'input' || table === 'discrete') && SWITCHING[role]) {
      problem = `${table === 'input' ? "un registre d'entrée" : 'une entrée tout-ou-rien'} ne s'écrit pas, il ne peut pas ${SWITCHING[role]}.`
    } else if (roles.has(`${device}/${role}`)) problem = `${device} a déjà un point "${role}".`

    if (problem) {
      errors.push(`${at}${problem}`)
      return
    }
    roles.add(`${device}/${role}`)
    points.push({
      key: `${host}:${port}/${unit}/${table}/${item.address}`,
      device,
      host,
      port: port as number,
      unit: unit as number,
      table,
      address: item.address as number,
      type,
      wordOrder: item.wordOrder === 'little' ? 'little' : 'big',
      scale,
      offset,
      role,
    })
  })
  return { points, errors }
}

export interface CustomDevice {
  id: string
  name: string
  category: DeviceCategory
  capabilities: CapabilityId[]
  points: ModbusPoint[]
}

const slug = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

function categoryOf(roles: Set<Role>): DeviceCategory {
  if (roles.has('setpoint')) return 'climate'
  if (roles.has('position')) return 'cover'
  if (roles.has('onoff')) return 'switch'
  if (roles.has('valve')) return 'appliance'
  if (roles.has('power') || roles.has('energy')) return 'energy'
  return 'sensor'
}

export function devicesFrom(points: ModbusPoint[]): CustomDevice[] {
  const byName = new Map<string, ModbusPoint[]>()
  for (const point of points) byName.set(point.device, [...(byName.get(point.device) ?? []), point])
  return [...byName.entries()].map(([name, list]) => {
    const roles = new Set(list.map((point) => point.role))
    return {
      id: `custom:${slug(name)}`,
      name,
      category: categoryOf(roles),
      capabilities: [...new Set(list.map((point) => CAPABILITY[point.role]))],
      points: list,
    }
  })
}

/** The value a person reads: raw times scale, plus offset; a yes or no for coils and inputs. */
export function pointValue(point: ModbusPoint, raw: number | boolean | null | undefined): number | boolean | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'boolean') return raw
  if (YES_NO_ROLES.has(point.role)) return raw !== 0
  return tidy(raw * point.scale + point.offset)
}

/** The capability state of a hand-mapped device, from raw values keyed by point. */
export function stateFrom(device: CustomDevice, values: Map<string, number | boolean | null>): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  const valueOf = (role: Role) => {
    const point = device.points.find((entry) => entry.role === role)
    return point ? pointValue(point, values.get(point.key)) : null
  }
  for (const point of device.points) {
    const value = pointValue(point, values.get(point.key))
    if (value === null) continue
    switch (point.role) {
      case 'temperature':
      case 'humidity':
      case 'power':
        state[point.role] = value
        break
      case 'energy':
        state.energyTotal = value
        break
      case 'onoff':
        state.on = value === true
        break
      case 'valve':
        state.valveOpen = value === true
        break
      case 'position':
        state.position = value
        break
      case 'setpoint': {
        state.targetTemperature = value
        const current = valueOf('temperature')
        if (typeof current === 'number') state.currentTemperature = current
        state.hvacMode = 'heat'
        break
      }
    }
  }
  return state
}

export type PointWrite = { point: ModbusPoint; coil: boolean } | { point: ModbusPoint; registers: number[] }

/** The writes a command needs on a hand-mapped device, with the state they should leave. */
export function commandWrites(
  device: CustomDevice,
  command: string,
  args: Record<string, unknown>,
  values: Map<string, number | boolean | null>
): { writes: PointWrite[]; expect: Record<string, unknown> } | { error: string } {
  const pointFor = (role: Role) => device.points.find((point) => point.role === role)
  const yesNo = (point: ModbusPoint, on: boolean): PointWrite => (point.table === 'coil' ? { point, coil: on } : { point, registers: encodeValue(on ? 1 : 0, point.type, point.wordOrder) })
  const number = (point: ModbusPoint, value: number): PointWrite => {
    const raw = (value - point.offset) / point.scale
    return { point, registers: encodeValue(point.type === 'float32' ? raw : Math.round(raw), point.type, point.wordOrder) }
  }
  const unknown = { error: `${device.name} ne sait pas faire "${command}".` }

  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'toggle': {
      const point = pointFor('onoff')
      if (!point) return unknown
      const on = command === 'toggle' ? pointValue(point, values.get(point.key)) !== true : command === 'turnOn'
      return { writes: [yesNo(point, on)], expect: { on } }
    }
    case 'openValve':
    case 'closeValve': {
      const point = pointFor('valve')
      if (!point) return unknown
      const open = command === 'openValve'
      return { writes: [yesNo(point, open)], expect: { valveOpen: open } }
    }
    case 'setTargetTemperature': {
      const point = pointFor('setpoint')
      const celsius = Number(args.celsius)
      if (!point) return unknown
      if (!Number.isFinite(celsius)) return { error: 'Température de consigne manquante.' }
      return { writes: [number(point, celsius)], expect: { targetTemperature: celsius } }
    }
    case 'open':
    case 'close':
    case 'setPosition': {
      const point = pointFor('position')
      if (!point) return unknown
      const position = command === 'open' ? 100 : command === 'close' ? 0 : Math.min(100, Math.max(0, Number(args.position)))
      if (!Number.isFinite(position)) return { error: 'Position manquante.' }
      return { writes: [number(point, position)], expect: { position } }
    }
    default:
      return unknown
  }
}
