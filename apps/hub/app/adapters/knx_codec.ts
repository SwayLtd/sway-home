/**
 * KNX over IP: addresses, datapoint types, cEMI telegrams and KNXnet/IP frames. No I/O.
 *
 * On the bus, devices talk in group addresses ("1/2/3"): a push button writes "on" to the
 * light's address, the actuator answers on its status address. Values are datapoint types
 * (DPT): one bit for a switch (packed into the telegram header), the KNX 2-byte float for a
 * temperature, a byte for a percentage. The hub reaches the bus through an IP interface over
 * a KNXnet/IP tunnel (UDP 3671); every frame below is what travels in it.
 *
 * Nothing on the bus says what an address is for: the map comes from the installer's ETS
 * project, written once in the settings as points with a role (onoff, setpoint...).
 *
 * Sources: KNX Standard 3/8/2, 3/8/4, 3/6/3, 3/7/2; xknx (knxip, cemi, dpt) for encodings.
 */

import type { CapabilityId, DeviceCategory } from '@sway-home/shared'

export const KNX_PORT = 3671
export const KNX_MULTICAST = '224.0.23.12'

export const KNX_SERVICE = {
  searchRequest: 0x0201,
  searchResponse: 0x0202,
  connectRequest: 0x0205,
  connectResponse: 0x0206,
  connectionStateRequest: 0x0207,
  connectionStateResponse: 0x0208,
  disconnectRequest: 0x0209,
  disconnectResponse: 0x020a,
  tunnellingRequest: 0x0420,
  tunnellingAck: 0x0421,
} as const

const STATUS_MESSAGES: Record<number, string> = {
  0x21: 'la passerelle ne reconnaît plus la connexion',
  0x22: 'type de connexion non pris en charge',
  0x23: 'option de connexion non prise en charge',
  0x24: "la passerelle n'accepte plus de connexion : toutes ses liaisons sont prises",
  0x26: 'erreur de la connexion de données',
  0x27: 'la passerelle a perdu le bus KNX',
  0x29: 'couche de tunnel non prise en charge',
}

export function statusMessage(status: number): string {
  return STATUS_MESSAGES[status] ?? `erreur 0x${status.toString(16).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------

/** "1/2/3" (main/middle/sub), "1/515" (main/sub) or "2563": the 16-bit group address. */
export function parseGroupAddress(text: string): number | null {
  const three = /^(\d{1,2})\/(\d)\/(\d{1,3})$/.exec(text.trim())
  if (three) {
    const [main, middle, sub] = three.slice(1).map(Number) as [number, number, number]
    return main <= 31 && middle <= 7 && sub <= 255 ? (main << 11) | (middle << 8) | sub : null
  }
  const two = /^(\d{1,2})\/(\d{1,4})$/.exec(text.trim())
  if (two) {
    const [main, sub] = two.slice(1).map(Number) as [number, number]
    return main <= 31 && sub <= 2047 ? (main << 11) | sub : null
  }
  if (/^\d{1,5}$/.test(text.trim())) {
    const value = Number(text.trim())
    return value <= 0xffff ? value : null
  }
  return null
}

export function formatGroupAddress(value: number): string {
  return `${(value >> 11) & 0x1f}/${(value >> 8) & 0x07}/${value & 0xff}`
}

export function parseIndividualAddress(text: string): number | null {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{1,3})$/.exec(text.trim())
  if (!match) return null
  const [area, line, device] = match.slice(1).map(Number) as [number, number, number]
  return area <= 15 && line <= 15 && device <= 255 ? (area << 12) | (line << 8) | device : null
}

export function formatIndividualAddress(value: number): string {
  return `${(value >> 12) & 0x0f}.${(value >> 8) & 0x0f}.${value & 0xff}`
}

// ---------------------------------------------------------------------------------------
// Datapoint types
// ---------------------------------------------------------------------------------------

const SUPPORTED_FAMILIES = new Set([1, 5, 7, 8, 9, 12, 13, 14])

function family(dpt: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,3}))?$/.exec(dpt.trim())
  return match ? Number(match[1]) : null
}

export function isSupportedDpt(dpt: string): boolean {
  const main = family(dpt)
  return main !== null && SUPPORTED_FAMILIES.has(main)
}

/** One bit (1.x) travels inside the telegram header rather than after it. */
export function isSmallDpt(dpt: string): boolean {
  return family(dpt) === 1
}

const isPercent = (dpt: string) => dpt.trim() === '5.001'

function encodeFloat16(value: number): Buffer {
  let mantissa = Math.round(value * 100)
  let exponent = 0
  while ((mantissa < -2048 || mantissa > 2047) && exponent < 15) {
    exponent += 1
    mantissa = Math.round((value * 100) / 2 ** exponent)
  }
  mantissa = Math.max(-2048, Math.min(2047, mantissa))
  const twelveBits = mantissa & 0xfff
  const raw = ((twelveBits & 0x800) << 4) | (exponent << 11) | (twelveBits & 0x7ff)
  return Buffer.from([raw >> 8, raw & 0xff])
}

function decodeFloat16(data: Buffer): number | null {
  const raw = data.readUInt16BE(0)
  if (raw === 0x7fff) return null
  const exponent = (raw >> 11) & 0x0f
  let mantissa = raw & 0x7ff
  if (raw & 0x8000) mantissa -= 0x800
  return Number((0.01 * mantissa * 2 ** exponent).toFixed(2))
}

export function encodeDpt(dpt: string, value: number | boolean): Buffer {
  const number = typeof value === 'boolean' ? (value ? 1 : 0) : value
  const out = (size: number, write: (buffer: Buffer) => void) => {
    const buffer = Buffer.alloc(size)
    write(buffer)
    return buffer
  }
  switch (family(dpt)) {
    case 1:
      return Buffer.from([number ? 1 : 0])
    case 5:
      return Buffer.from([isPercent(dpt) ? Math.round((Math.min(100, Math.max(0, number)) * 255) / 100) : Math.round(Math.min(255, Math.max(0, number)))])
    case 7:
      return out(2, (buffer) => buffer.writeUInt16BE(Math.round(Math.min(0xffff, Math.max(0, number))), 0))
    case 8:
      return out(2, (buffer) => buffer.writeInt16BE(Math.round(Math.min(0x7fff, Math.max(-0x8000, number))), 0))
    case 9:
      return encodeFloat16(number)
    case 12:
      return out(4, (buffer) => buffer.writeUInt32BE(Math.round(Math.min(0xffffffff, Math.max(0, number))), 0))
    case 13:
      return out(4, (buffer) => buffer.writeInt32BE(Math.round(Math.min(0x7fffffff, Math.max(-0x80000000, number))), 0))
    case 14:
      return out(4, (buffer) => buffer.writeFloatBE(number, 0))
    default:
      throw new Error(`DPT ${dpt} non pris en charge.`)
  }
}

export function decodeDpt(dpt: string, data: Buffer): number | boolean | null {
  const need = (size: number) => data.length >= size
  switch (family(dpt)) {
    case 1:
      return need(1) ? (data[0]! & 0x01) === 1 : null
    case 5:
      return need(1) ? (isPercent(dpt) ? Math.round((data[0]! * 100) / 255) : data[0]!) : null
    case 7:
      return need(2) ? data.readUInt16BE(0) : null
    case 8:
      return need(2) ? data.readInt16BE(0) : null
    case 9:
      return need(2) ? decodeFloat16(data) : null
    case 12:
      return need(4) ? data.readUInt32BE(0) : null
    case 13:
      return need(4) ? data.readInt32BE(0) : null
    case 14: {
      if (!need(4)) return null
      const value = data.readFloatBE(0)
      return Number.isFinite(value) ? value : null
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------
// cEMI telegrams
// ---------------------------------------------------------------------------------------

export type CemiCode = 'request' | 'indication' | 'confirmation'
export type GroupService = 'read' | 'response' | 'write'

const MESSAGE_CODE: Record<CemiCode, number> = { request: 0x11, indication: 0x29, confirmation: 0x2e }
const CODE_OF = new Map(Object.entries(MESSAGE_CODE).map(([name, code]) => [code, name as CemiCode]))
const APCI: Record<GroupService, number> = { read: 0x00, response: 0x40, write: 0x80 }

export interface GroupTelegram {
  code: CemiCode
  source: string
  destination: number
  service: GroupService
  data: Buffer
  small: boolean
  confirmError: boolean
}

/**
 * An L_Data frame to a group address: standard frame, no repeat, low priority, hop count 6
 * (control fields 0xBC 0xE0). The source is 0.0.0: the interface puts its own.
 */
export function lData(options: { code: CemiCode; source?: number; destination: number; service: GroupService; data?: Buffer; small?: boolean; confirmError?: boolean }): Buffer {
  const data = options.data ?? Buffer.alloc(0)
  const apci = APCI[options.service]
  const tpdu = options.small !== false && data.length <= 1 && (options.small || options.service === 'read') ? Buffer.from([0x00, apci | ((data[0] ?? 0) & 0x3f)]) : Buffer.concat([Buffer.from([0x00, apci]), data])
  const source = options.source ?? 0
  return Buffer.concat([
    Buffer.from([MESSAGE_CODE[options.code], 0x00, options.confirmError ? 0xbd : 0xbc, 0xe0, source >> 8, source & 0xff, options.destination >> 8, options.destination & 0xff, tpdu.length - 1]),
    tpdu,
  ])
}

export function groupWrite(destination: number, data: Buffer, small: boolean): Buffer {
  return lData({ code: 'request', destination, service: 'write', data, small })
}

export function groupRead(destination: number): Buffer {
  return lData({ code: 'request', destination, service: 'read' })
}

/** A group telegram, or null for anything else (individual addressing, extended frames, other services). */
export function decodeCemi(buffer: Buffer): GroupTelegram | null {
  const code = CODE_OF.get(buffer[0] ?? -1)
  if (!code || buffer.length < 2) return null
  const base = 2 + buffer[1]!
  if (buffer.length < base + 9) return null
  const control1 = buffer[base]!
  const control2 = buffer[base + 1]!
  if ((control2 & 0x80) === 0 || (control2 & 0x0f) !== 0) return null
  const npduLength = buffer[base + 6]!
  const tpdu = buffer.subarray(base + 7)
  if (tpdu.length !== npduLength + 1) return null
  const apci = ((tpdu[0]! & 0x03) << 8) | tpdu[1]!
  const service = (Object.entries(APCI) as [GroupService, number][]).find(([, value]) => (apci & 0x3c0) === value)?.[0]
  if (!service) return null
  const small = npduLength === 1
  return {
    code,
    source: formatIndividualAddress(buffer.readUInt16BE(base + 2)),
    destination: buffer.readUInt16BE(base + 4),
    service,
    data: service === 'read' ? Buffer.alloc(0) : small ? Buffer.from([tpdu[1]! & 0x3f]) : Buffer.from(tpdu.subarray(2)),
    small,
    confirmError: (control1 & 0x01) === 1,
  }
}

// ---------------------------------------------------------------------------------------
// KNXnet/IP frames
// ---------------------------------------------------------------------------------------

export interface Endpoint {
  ip: string
  port: number
}

function knxFrame(service: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const total = 6 + body.length
  return Buffer.concat([Buffer.from([0x06, 0x10, service >> 8, service & 0xff, total >> 8, total & 0xff]), body])
}

function hpai(endpoint: Endpoint): Buffer {
  const octets = endpoint.ip.split('.').map((part) => Number(part) & 0xff)
  return Buffer.from([0x08, 0x01, ...octets, endpoint.port >> 8, endpoint.port & 0xff])
}

function readHpai(buffer: Buffer, offset: number): Endpoint | null {
  if (buffer.length < offset + 8 || buffer[offset] !== 0x08) return null
  return { ip: [...buffer.subarray(offset + 2, offset + 6)].join('.'), port: buffer.readUInt16BE(offset + 6) }
}

export const searchRequest = (local: Endpoint) => knxFrame(KNX_SERVICE.searchRequest, hpai(local))
export const connectRequest = (local: Endpoint) => knxFrame(KNX_SERVICE.connectRequest, hpai(local), hpai(local), Buffer.from([0x04, 0x04, 0x02, 0x00]))
export const connectionStateRequest = (channel: number, local: Endpoint) => knxFrame(KNX_SERVICE.connectionStateRequest, Buffer.from([channel, 0x00]), hpai(local))
export const disconnectRequest = (channel: number, local: Endpoint) => knxFrame(KNX_SERVICE.disconnectRequest, Buffer.from([channel, 0x00]), hpai(local))
export const disconnectResponse = (channel: number, status = 0) => knxFrame(KNX_SERVICE.disconnectResponse, Buffer.from([channel, status]))
export const tunnellingRequest = (channel: number, sequence: number, cemi: Buffer) => knxFrame(KNX_SERVICE.tunnellingRequest, Buffer.from([0x04, channel, sequence & 0xff, 0x00]), cemi)
export const tunnellingAck = (channel: number, sequence: number, status = 0) => knxFrame(KNX_SERVICE.tunnellingAck, Buffer.from([0x04, channel, sequence & 0xff, status]))
export const connectionStateResponse = (channel: number, status = 0) => knxFrame(KNX_SERVICE.connectionStateResponse, Buffer.from([channel, status]))

export function connectResponse(channel: number, status: number, dataEndpoint?: Endpoint, individualAddress?: number): Buffer {
  if (status !== 0 || !dataEndpoint || individualAddress === undefined) return knxFrame(KNX_SERVICE.connectResponse, Buffer.from([channel, status]))
  return knxFrame(KNX_SERVICE.connectResponse, Buffer.from([channel, status]), hpai(dataEndpoint), Buffer.from([0x04, 0x04, individualAddress >> 8, individualAddress & 0xff]))
}

export type KnxFrame =
  | { service: typeof KNX_SERVICE.searchRequest; endpoint: Endpoint | null }
  | { service: typeof KNX_SERVICE.connectRequest; control: Endpoint | null; data: Endpoint | null }
  | { service: typeof KNX_SERVICE.connectResponse; channel: number; status: number; dataEndpoint?: Endpoint; individualAddress?: string }
  | { service: typeof KNX_SERVICE.connectionStateRequest; channel: number }
  | { service: typeof KNX_SERVICE.connectionStateResponse; channel: number; status: number }
  | { service: typeof KNX_SERVICE.disconnectRequest; channel: number }
  | { service: typeof KNX_SERVICE.disconnectResponse; channel: number; status: number }
  | { service: typeof KNX_SERVICE.tunnellingRequest; channel: number; sequence: number; cemi: Buffer }
  | { service: typeof KNX_SERVICE.tunnellingAck; channel: number; sequence: number; status: number }

/** The service and fields of a KNXnet/IP frame; null when it is not one, or one not used here. */
export function parseFrame(buffer: Buffer): KnxFrame | null {
  if (buffer.length < 6 || buffer[0] !== 0x06 || buffer[1] !== 0x10) return null
  if (buffer.readUInt16BE(4) !== buffer.length) return null
  const service = buffer.readUInt16BE(2)
  const body = buffer.subarray(6)
  switch (service) {
    case KNX_SERVICE.searchRequest:
      return { service, endpoint: readHpai(body, 0) }
    case KNX_SERVICE.connectRequest:
      return { service, control: readHpai(body, 0), data: readHpai(body, 8) }
    case KNX_SERVICE.connectResponse: {
      if (body.length < 2) return null
      const channel = body[0]!
      const status = body[1]!
      const dataEndpoint = readHpai(body, 2)
      if (status !== 0 || !dataEndpoint || body.length < 14) return { service, channel, status }
      return { service, channel, status, dataEndpoint, individualAddress: formatIndividualAddress(body.readUInt16BE(12)) }
    }
    case KNX_SERVICE.connectionStateRequest:
    case KNX_SERVICE.disconnectRequest:
      return body.length >= 1 ? { service, channel: body[0]! } : null
    case KNX_SERVICE.connectionStateResponse:
    case KNX_SERVICE.disconnectResponse:
      return body.length >= 2 ? { service, channel: body[0]!, status: body[1]! } : null
    case KNX_SERVICE.tunnellingRequest:
      return body.length >= 4 && body[0] === 0x04 ? { service, channel: body[1]!, sequence: body[2]!, cemi: Buffer.from(body.subarray(4)) } : null
    case KNX_SERVICE.tunnellingAck:
      return body.length >= 4 ? { service, channel: body[1]!, sequence: body[2]!, status: body[3]! } : null
    default:
      return null
  }
}

export interface KnxGateway {
  endpoint: Endpoint
  name: string
  individualAddress: string
  serial: string
  mac: string
  tunnelling: boolean
  routing: boolean
}

/** A gateway's answer to a search: where to reach it, what it is, what it offers. */
export function parseSearchResponse(buffer: Buffer): KnxGateway | null {
  if (buffer.length < 6 || buffer.readUInt16BE(2) !== KNX_SERVICE.searchResponse) return null
  const body = buffer.subarray(6)
  const endpoint = readHpai(body, 0)
  if (!endpoint) return null
  let offset = 8
  let info: Omit<KnxGateway, 'endpoint' | 'tunnelling' | 'routing'> | null = null
  const families = new Set<number>()
  while (offset + 2 <= body.length) {
    const length = body[offset]!
    const type = body[offset + 1]!
    if (length < 2 || offset + length > body.length) break
    const dib = body.subarray(offset, offset + length)
    if (type === 0x01 && length >= 54) {
      info = {
        individualAddress: formatIndividualAddress(dib.readUInt16BE(4)),
        serial: dib.subarray(8, 14).toString('hex'),
        mac: [...dib.subarray(18, 24)].map((byte) => byte.toString(16).padStart(2, '0')).join(':'),
        name: dib.subarray(24, 54).toString('latin1').replace(/\0.*$/s, '').trim(),
      }
    } else if (type === 0x02) {
      for (let at = 2; at + 1 < length; at += 2) families.add(dib[at]!)
    }
    offset += length
  }
  if (!info) return null
  return { endpoint, ...info, tunnelling: families.has(0x04), routing: families.has(0x05) }
}

// ---------------------------------------------------------------------------------------
// The map from ETS
// ---------------------------------------------------------------------------------------

export const KNX_ROLES = ['onoff', 'brightness', 'position', 'stop', 'setpoint', 'temperature', 'humidity', 'illuminance', 'power', 'energy', 'contact', 'motion'] as const
export type KnxRole = (typeof KNX_ROLES)[number]

const DEFAULT_DPT: Record<KnxRole, string> = {
  onoff: '1.001',
  brightness: '5.001',
  position: '5.001',
  stop: '1.010',
  setpoint: '9.001',
  temperature: '9.001',
  humidity: '9.007',
  illuminance: '9.004',
  power: '14.056',
  energy: '13.010',
  contact: '1.019',
  motion: '1.001',
}

/** Roles that are commands need the address to write to; the others, the address they are heard on. */
const COMMANDED = new Set<KnxRole>(['onoff', 'brightness', 'position', 'stop', 'setpoint'])

const CAPABILITY: Partial<Record<KnxRole, CapabilityId>> = {
  onoff: 'onoff',
  brightness: 'brightness',
  position: 'position',
  setpoint: 'thermostat',
  temperature: 'temperature',
  humidity: 'humidity',
  illuminance: 'illuminance',
  power: 'power',
  energy: 'energy',
  contact: 'contact',
  motion: 'motion',
}

export interface KnxPoint {
  device: string
  role: KnxRole
  /** Where commands are written; null for what is only heard. */
  write: number | null
  /** Where the value is heard (status); the write address when there is no status. */
  status: number | null
  dpt: string
  /** Position only: KNX says 0 % for open, the hub 0 for closed. */
  invert: boolean
}

export function parseKnxPoints(text: string): { points: KnxPoint[]; errors: string[] } {
  if (text.trim().length === 0) return { points: [], errors: [] }
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch (error) {
    return { points: [], errors: [`Points KNX : JSON illisible (${(error as Error).message}).`] }
  }
  if (!Array.isArray(list)) return { points: [], errors: ['Points KNX : une liste [ ... ] est attendue.'] }

  const points: KnxPoint[] = []
  const errors: string[] = []
  const taken = new Set<string>()
  list.forEach((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>
    const device = typeof item.device === 'string' ? item.device.trim() : ''
    const role = item.role as KnxRole
    const address = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? parseGroupAddress(String(value)) : null)
    const write = item.write === undefined ? null : address(item.write)
    const status = item.status === undefined ? null : address(item.status)
    const dpt = typeof item.dpt === 'string' ? item.dpt : DEFAULT_DPT[role] ?? ''

    let problem: string | null = null
    if (!device) problem = "nom d'appareil manquant."
    else if (!KNX_ROLES.includes(role)) problem = `rôle "${String(item.role)}" inconnu (${KNX_ROLES.join(', ')}).`
    else if (item.write !== undefined && write === null) problem = `adresse de groupe "${String(item.write)}" invalide.`
    else if (item.status !== undefined && status === null) problem = `adresse de groupe "${String(item.status)}" invalide.`
    else if (COMMANDED.has(role) && write === null) problem = 'adresse de commande manquante.'
    else if (!COMMANDED.has(role) && status === null) problem = "adresse d'état manquante."
    else if (!isSupportedDpt(dpt)) problem = `type "${dpt}" non pris en charge.`
    else if (taken.has(`${device}/${role}`)) problem = `${device} a déjà un point "${role}".`

    if (problem) {
      errors.push(`Point ${index + 1} : ${problem}`)
      return
    }
    taken.add(`${device}/${role}`)
    points.push({ device, role, write, status, dpt, invert: role === 'position' ? item.invert !== false : item.invert === true })
  })
  return { points, errors }
}

export interface KnxDevice {
  id: string
  name: string
  category: DeviceCategory
  capabilities: CapabilityId[]
  points: KnxPoint[]
}

const slug = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const LIGHTING = /lumi|lampe|plafonnier|spot|applique|[ée]clairage|led|suspension|lustre|light/i

function categoryOf(name: string, roles: Set<KnxRole>): DeviceCategory {
  if (roles.has('setpoint')) return 'climate'
  if (roles.has('position')) return 'cover'
  if (roles.has('brightness')) return 'light'
  if (roles.has('onoff')) return LIGHTING.test(name) ? 'light' : 'switch'
  if (roles.has('power') || roles.has('energy')) return 'energy'
  return 'sensor'
}

export function devicesFrom(points: KnxPoint[]): KnxDevice[] {
  const byName = new Map<string, KnxPoint[]>()
  for (const point of points) byName.set(point.device, [...(byName.get(point.device) ?? []), point])
  return [...byName.entries()].map(([name, list]) => {
    const roles = new Set(list.map((point) => point.role))
    return {
      id: `knx:${slug(name)}`,
      name,
      category: categoryOf(name, roles),
      capabilities: [...new Set(list.map((point) => CAPABILITY[point.role]).filter((capability): capability is CapabilityId => capability !== undefined))],
      points: list,
    }
  })
}

/** The address a point's value is heard on. */
export function heardOn(point: KnxPoint): number | null {
  return point.status ?? point.write
}

/** The capability state of a device, from the last value heard on each of its addresses. */
export function stateFrom(device: KnxDevice, heard: Map<number, Buffer>): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  const valueOf = (point: KnxPoint) => {
    const address = heardOn(point)
    const data = address === null ? undefined : heard.get(address)
    return data ? decodeDpt(point.dpt, data) : null
  }
  const temperaturePoint = device.points.find((point) => point.role === 'temperature')
  for (const point of device.points) {
    const value = valueOf(point)
    if (value === null) continue
    const number = typeof value === 'boolean' ? (value ? 1 : 0) : value
    switch (point.role) {
      case 'onoff':
        state.on = value === true || number === 1
        break
      case 'brightness':
        state.brightness = number
        break
      case 'position':
        state.position = point.invert ? 100 - number : number
        break
      case 'setpoint': {
        state.targetTemperature = number
        const current = temperaturePoint ? valueOf(temperaturePoint) : null
        if (typeof current === 'number') state.currentTemperature = current
        state.hvacMode = 'heat'
        break
      }
      case 'temperature':
      case 'humidity':
      case 'illuminance':
        state[point.role] = number
        break
      case 'power':
        state.power = family(point.dpt) === 9 ? Number((number * 1000).toFixed(3)) : number
        break
      case 'energy':
        state.energyTotal = point.dpt === '13.010' ? Number((number / 1000).toFixed(6)) : number
        break
      case 'contact':
        state.open = value === true || number === 1
        break
      case 'motion':
        state.motion = value === true || number === 1
        break
      case 'stop':
        break
    }
  }
  return state
}

export interface KnxWrite {
  address: number
  data: Buffer
  small: boolean
}

/** The group writes a command needs, with the state they should leave. */
export function commandTelegrams(
  device: KnxDevice,
  command: string,
  args: Record<string, unknown>,
  state: Record<string, unknown> = {}
): { writes: KnxWrite[]; expect: Record<string, unknown> } | { error: string } {
  const pointFor = (role: KnxRole) => device.points.find((point) => point.role === role && point.write !== null)
  const write = (point: KnxPoint, value: number | boolean): KnxWrite => ({ address: point.write!, data: encodeDpt(point.dpt, value), small: isSmallDpt(point.dpt) })
  const unknown = { error: `${device.name} ne sait pas faire "${command}".` }

  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'toggle': {
      const point = pointFor('onoff')
      if (!point) return unknown
      const on = command === 'toggle' ? state.on !== true : command === 'turnOn'
      return { writes: [write(point, on)], expect: { on } }
    }
    case 'setBrightness':
    case 'stepBrightness': {
      const point = pointFor('brightness')
      if (!point) return unknown
      const base = typeof state.brightness === 'number' ? state.brightness : 0
      const brightness = Math.round(Math.min(100, Math.max(0, command === 'setBrightness' ? Number(args.brightness) : base + Number(args.delta ?? 0))))
      if (!Number.isFinite(brightness)) return { error: 'Luminosité manquante.' }
      return { writes: [write(point, brightness)], expect: { brightness, on: brightness > 0 } }
    }
    case 'open':
    case 'close':
    case 'setPosition': {
      const point = pointFor('position')
      if (!point) return unknown
      const position = command === 'open' ? 100 : command === 'close' ? 0 : Math.round(Math.min(100, Math.max(0, Number(args.position))))
      if (!Number.isFinite(position)) return { error: 'Position manquante.' }
      return { writes: [write(point, point.invert ? 100 - position : position)], expect: { position } }
    }
    case 'stop': {
      const point = pointFor('stop')
      if (!point) return unknown
      return { writes: [write(point, true)], expect: {} }
    }
    case 'setTargetTemperature': {
      const point = pointFor('setpoint')
      const celsius = Number(args.celsius)
      if (!point) return unknown
      if (!Number.isFinite(celsius)) return { error: 'Température de consigne manquante.' }
      return { writes: [write(point, celsius)], expect: { targetTemperature: celsius } }
    }
    default:
      return unknown
  }
}
