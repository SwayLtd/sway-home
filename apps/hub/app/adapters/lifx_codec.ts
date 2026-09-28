/**
 * The LIFX LAN protocol, as bytes.
 *
 * Every message is a 36-byte little-endian header followed by a type-specific payload, sent
 * over UDP to port 56700. The header packs four fields into one 16-bit word and two flags
 * into one byte, which is where hand-written clients usually go wrong; the encoder below is
 * pinned to the worked example in LIFX's own documentation.
 *
 * Spec: https://lan.developer.lifx.com/docs/encoding-a-packet
 *       https://lan.developer.lifx.com/docs/changing-a-device
 *       https://lan.developer.lifx.com/docs/information-messages
 */

export const LIFX_PORT = 56700
export const LIFX_HEADER_SIZE = 36
const PROTOCOL = 1024

export const LIFX_TYPE = {
  GetService: 2,
  StateService: 3,
  GetPower: 20,
  SetPower: 21,
  StatePower: 22,
  GetLabel: 23,
  StateLabel: 25,
  GetVersion: 32,
  StateVersion: 33,
  Acknowledgement: 45,
  GetColor: 101,
  SetColor: 102,
  LightState: 107,
  GetLightPower: 116,
  SetLightPower: 117,
  StateLightPower: 118,
} as const

export interface Hsbk {
  hue: number
  saturation: number
  brightness: number
  kelvin: number
}

export interface LifxMessage {
  type: number
  source: number
  sequence: number
  /** Eight bytes; the first six are the MAC. All zeros with `tagged` means "every light". */
  target?: Uint8Array
  tagged?: boolean
  ackRequired?: boolean
  resRequired?: boolean
  payload?: Uint8Array
}

export interface DecodedLifx {
  type: number
  source: number
  sequence: number
  mac: string
  tagged: boolean
  ackRequired: boolean
  resRequired: boolean
  payload: Uint8Array
}

export function encodeLifx(message: LifxMessage): Uint8Array {
  const payload = message.payload ?? new Uint8Array(0)
  const bytes = new Uint8Array(LIFX_HEADER_SIZE + payload.length)
  const view = new DataView(bytes.buffer)

  view.setUint16(0, bytes.length, true)
  // protocol (12 bits) | addressable (bit 12, always set) | tagged (bit 13) | origin (0)
  view.setUint16(2, PROTOCOL | (1 << 12) | (message.tagged ? 1 << 13 : 0), true)
  view.setUint32(4, message.source >>> 0, true)
  if (message.target) bytes.set(message.target.subarray(0, 8), 8)
  // bytes 16-21 reserved
  bytes[22] = (message.resRequired ? 0b01 : 0) | (message.ackRequired ? 0b10 : 0)
  bytes[23] = message.sequence & 0xff
  // bytes 24-31 reserved
  view.setUint16(32, message.type, true)
  // bytes 34-35 reserved
  bytes.set(payload, LIFX_HEADER_SIZE)
  return bytes
}

/** Null for anything that is not a well-formed LIFX packet: UDP port 56700 is not ours alone. */
export function decodeLifx(bytes: Uint8Array): DecodedLifx | null {
  if (bytes.length < LIFX_HEADER_SIZE) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = view.getUint16(0, true)
  if (size < LIFX_HEADER_SIZE || size > bytes.length) return null

  const word = view.getUint16(2, true)
  if ((word & 0x0fff) !== PROTOCOL) return null

  const flags = bytes[22]!
  return {
    type: view.getUint16(32, true),
    source: view.getUint32(4, true),
    sequence: bytes[23]!,
    mac: macFromTarget(bytes.subarray(8, 14)),
    tagged: (word & (1 << 13)) !== 0,
    ackRequired: (flags & 0b10) !== 0,
    resRequired: (flags & 0b01) !== 0,
    payload: bytes.slice(LIFX_HEADER_SIZE, size),
  }
}

export function targetFromMac(mac: string): Uint8Array {
  const hex = mac.replace(/[^0-9a-f]/gi, '')
  if (hex.length !== 12) throw new Error(`Adresse MAC LIFX invalide : ${mac}`)
  const target = new Uint8Array(8)
  for (let index = 0; index < 6; index += 1) target[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return target
}

export function macFromTarget(bytes: Uint8Array): string {
  return [...bytes.subarray(0, 6)].map((byte) => byte.toString(16).padStart(2, '0')).join(':')
}

// ---------------------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------------------

export function setColorPayload(color: Hsbk, durationMs: number): Uint8Array {
  const bytes = new Uint8Array(13)
  const view = new DataView(bytes.buffer)
  // byte 0 reserved
  view.setUint16(1, color.hue, true)
  view.setUint16(3, color.saturation, true)
  view.setUint16(5, color.brightness, true)
  view.setUint16(7, color.kelvin, true)
  view.setUint32(9, Math.max(0, Math.round(durationMs)), true)
  return bytes
}

export function setLightPowerPayload(on: boolean, durationMs: number): Uint8Array {
  const bytes = new Uint8Array(6)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, on ? 0xffff : 0, true)
  view.setUint32(2, Math.max(0, Math.round(durationMs)), true)
  return bytes
}

export function parseStateService(payload: Uint8Array): { service: number; port: number } | null {
  if (payload.length < 5) return null
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return { service: payload[0]!, port: view.getUint32(1, true) }
}

export interface LightState {
  hsbk: Hsbk
  power: number
  on: boolean
  label: string
}

const LIGHT_STATE_SIZE = 52

export function parseLightState(payload: Uint8Array): LightState {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const power = view.getUint16(10, true)
  return {
    hsbk: {
      hue: view.getUint16(0, true),
      saturation: view.getUint16(2, true),
      brightness: view.getUint16(4, true),
      kelvin: view.getUint16(6, true),
    },
    power,
    on: power > 0,
    label: decodeLabel(payload.subarray(12, 44)),
  }
}

/** The inverse of `parseLightState`, for fixtures and for a simulated light. */
export function lightStatePayload(color: Hsbk, power: number, label: string): Uint8Array {
  const bytes = new Uint8Array(LIGHT_STATE_SIZE)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, color.hue, true)
  view.setUint16(2, color.saturation, true)
  view.setUint16(4, color.brightness, true)
  view.setUint16(6, color.kelvin, true)
  view.setUint16(10, power, true)
  bytes.set(new TextEncoder().encode(label).subarray(0, 32), 12)
  return bytes
}

function decodeLabel(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end)).trim()
}

// ---------------------------------------------------------------------------------------
// Colour: the house speaks degrees and percent, the wire speaks 16-bit integers
// ---------------------------------------------------------------------------------------

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** Degrees (0-360) and percent (0-100) to the wire's Uint16s, per the HSBK page of the spec. */
export function toHsbk(color: { hue: number; saturation: number; brightness: number; kelvin: number }): Hsbk {
  const hue = ((color.hue % 360) + 360) % 360
  return {
    hue: Math.round((0x10000 * hue) / 360) % 0x10000,
    saturation: Math.round(0xffff * (clamp(color.saturation, 0, 100) / 100)),
    brightness: Math.round(0xffff * (clamp(color.brightness, 0, 100) / 100)),
    kelvin: Math.round(clamp(color.kelvin, 1500, 9000)),
  }
}

export function fromHsbk(color: Hsbk): { hue: number; saturation: number; brightness: number; kelvin: number } {
  return {
    hue: Math.round((color.hue * 360) / 0x10000) % 360,
    saturation: Math.round((color.saturation * 100) / 0xffff),
    brightness: Math.round((color.brightness * 100) / 0xffff),
    kelvin: color.kelvin,
  }
}
