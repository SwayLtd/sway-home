/**
 * Bluetooth LE advertisements: what passive sensors shout, decoded. No I/O.
 *
 * Thermometers, door sensors and buttons that live on a coin cell never connect: they put
 * their readings in advertisements, as service data (BTHome on 0xFCD2, Xiaomi's MiBeacon on
 * 0xFE95, pvvx and ATC firmwares on 0x181A, SwitchBot on 0xFD3D) or manufacturer data (Govee
 * 0xEC88, Ruuvi 0x0499, SwitchBot 0x0969, ThermoBeacon). A phone app can also broadcast an iBeacon
 * identity (Apple, 0x004C), which is how a room knows who is in it.
 *
 * BTHome and MiBeacon v4/v5 can be encrypted with a per-device key: AES-CCM with a 4-byte
 * tag. The runtime has no CCM cipher, so it is built here on AES-ECB, as RFC 3610 describes.
 *
 * Sources: bthome.io (format, encryption); pvvx/ATC_MiThermometer; xiaomi-ble, govee-ble,
 * thermobeacon-ble and pySwitchbot (the parsers Home Assistant uses, and their test vectors); Ruuvi data format 5;
 * Apple iBeacon; Theengs Gateway and OpenMQTTGateway (their MQTT messages).
 */

import { createCipheriv } from 'node:crypto'
import type { CapabilityId } from '@sway-home/shared'

export interface Advert {
  /** "A4:C1:38:02:83:F4" */
  address: string
  rssi: number | null
  name: string | null
  /** Company identifier -> the bytes after it. */
  manufacturer: Map<number, Buffer>
  /** 16-bit service UUID, lowercase hex ("fcd2") -> the bytes after it. */
  serviceData: Map<string, Buffer>
  serviceUuids: string[]
}

export type ButtonEvent = 'single' | 'double' | 'triple' | 'hold'

export interface Values {
  temperature?: number
  humidity?: number
  battery?: number
  batteryLow?: boolean
  batteryVoltage?: number
  pressure?: number
  illuminance?: number
  motion?: boolean
  occupied?: boolean
  open?: boolean
  leak?: boolean
  smoke?: boolean
  co2?: number
  pm25?: number
  pm10?: number
  voc?: number
  power?: number
  energy?: number
  voltage?: number
  current?: number
  moisture?: number
  conductivity?: number
  motionCount?: number
  buttons?: { index: number; event: ButtonEvent }[]
}

export type Decoded =
  | { kind: 'reading'; format: string; model: string | null; packet: number | null; values: Values }
  | { kind: 'beacon'; uuid: string; major: number; minor: number; txPower: number }
  | { kind: 'locked'; format: string; model: string | null; reason: 'no-key' | 'wrong-key' }

// ---------------------------------------------------------------------------------------
// Where advertisements come from
// ---------------------------------------------------------------------------------------

export function formatAddress(text: string): string | null {
  const hex = text.replace(/[^0-9a-f]/gi, '')
  return hex.length === 12 ? hex.toUpperCase().match(/../g)!.join(':') : null
}

const uuid16 = (value: number) => value.toString(16).padStart(4, '0')

/** From AD structures, each as hex: its type byte, then its data ("ff4c00..."). */
export function advertFromSections(address: string, rssi: number | null, sections: string[]): Advert {
  const advert: Advert = { address: formatAddress(address) ?? address, rssi, name: null, manufacturer: new Map(), serviceData: new Map(), serviceUuids: [] }
  for (const section of sections) {
    if (typeof section !== 'string' || !/^([0-9a-f]{2})+$/i.test(section)) continue
    const type = Number.parseInt(section.slice(0, 2), 16)
    const data = Buffer.from(section.slice(2), 'hex')
    if ((type === 0x09 || (type === 0x08 && advert.name === null)) && data.length > 0) advert.name = data.toString('utf8').replace(/\0+$/, '') || advert.name
    else if (type === 0x02 || type === 0x03) for (let index = 0; index + 1 < data.length; index += 2) advert.serviceUuids.push(uuid16(data.readUInt16LE(index)))
    else if (type === 0x16 && data.length >= 2) advert.serviceData.set(uuid16(data.readUInt16LE(0)), data.subarray(2))
    else if (type === 0xff && data.length >= 2) advert.manufacturer.set(data.readUInt16LE(0), data.subarray(2))
  }
  return advert
}

/** One JSON line from the Windows scanner; null for anything else (its "stopped" notice). */
export function parseScannerLine(line: string): Advert | null {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return null
  }
  const raw = json as { address?: unknown; rssi?: unknown; sections?: unknown } | null
  if (!raw || typeof raw.address !== 'string' || !Array.isArray(raw.sections) || !formatAddress(raw.address)) return null
  return advertFromSections(raw.address, typeof raw.rssi === 'number' ? raw.rssi : null, raw.sections as string[])
}

const hexBytes = (value: unknown) => (typeof value === 'string' && /^([0-9a-f]{2})+$/i.test(value) ? Buffer.from(value, 'hex') : null)
const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/**
 * A Theengs Gateway or OpenMQTTGateway message: the raw advertisement when the gateway
 * publishes it, and what the gateway decoded itself, used when there is nothing raw.
 */
export function advertFromGateway(json: unknown): { advert: Advert; decoded: Values | null } | null {
  if (!json || typeof json !== 'object') return null
  const raw = json as Record<string, unknown>
  const address = typeof raw.id === 'string' ? formatAddress(raw.id) : null
  if (!address) return null
  const advert: Advert = { address, rssi: finite(raw.rssi) ?? null, name: typeof raw.name === 'string' ? raw.name : null, manufacturer: new Map(), serviceData: new Map(), serviceUuids: [] }
  const maker = hexBytes(raw.manufacturerdata)
  if (maker && maker.length >= 2) advert.manufacturer.set(maker.readUInt16LE(0), maker.subarray(2))
  const data = hexBytes(raw.servicedata)
  const uuid = typeof raw.servicedatauuid === 'string' ? /^(?:0x)?([0-9a-f]{4})$/i.exec(raw.servicedatauuid)?.[1] ?? /^0000([0-9a-f]{4})-/i.exec(raw.servicedatauuid)?.[1] : undefined
  if (data && uuid) advert.serviceData.set(uuid.toLowerCase(), data)

  const decoded: Values = {}
  const set = <K extends keyof Values>(key: K, value: Values[K] | undefined) => {
    if (value !== undefined) decoded[key] = value
  }
  set('temperature', finite(raw.tempc))
  set('humidity', finite(raw.hum))
  set('battery', finite(raw.batt))
  set('batteryVoltage', finite(raw.volt))
  set('illuminance', finite(raw.lux))
  set('pressure', finite(raw.pres))
  set('co2', finite(raw.co2))
  set('pm25', finite(raw.pm25))
  set('pm10', finite(raw.pm10))
  set('moisture', finite(raw.moi))
  set('conductivity', finite(raw.fer))
  if (typeof raw.motion === 'boolean') decoded.motion = raw.motion
  if (typeof raw.open === 'boolean') decoded.open = raw.open
  return { advert, decoded: Object.keys(decoded).length > 0 ? decoded : null }
}

// ---------------------------------------------------------------------------------------
// AES-CCM (RFC 3610), on the AES-ECB the runtime does have
// ---------------------------------------------------------------------------------------

/**
 * The AES block function, one 16-byte block at a time. It is the primitive CCM is built from
 * (counter mode and CBC-MAC below), never a mode applied to data on its own.
 */
function aesBlock(key: Buffer, block: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(block), cipher.final()])
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length)
  for (let index = 0; index < a.length; index++) out[index] = a[index]! ^ (b[index] ?? 0)
  return out
}

/** Decrypts and checks the tag; null when the key is wrong or the data was tampered with. */
export function aesCcmDecrypt(key: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer, aad: Buffer = Buffer.alloc(0)): Buffer | null {
  if (key.length !== 16 || nonce.length < 7 || nonce.length > 13) return null
  const lengthBytes = 15 - nonce.length
  const counter = (index: number) => {
    const block = Buffer.alloc(16)
    block[0] = lengthBytes - 1
    nonce.copy(block, 1)
    block.writeUIntBE(index, 16 - lengthBytes, Math.min(lengthBytes, 6))
    return block
  }
  // Counter mode: block 0 masks the tag, the next ones the data.
  const plaintext = Buffer.alloc(ciphertext.length)
  for (let offset = 0, index = 1; offset < ciphertext.length; offset += 16, index++) {
    const stream = aesBlock(key, counter(index))
    xor(ciphertext.subarray(offset, offset + 16), stream).copy(plaintext, offset)
  }
  // CBC-MAC over B0, the associated data and the plaintext.
  const b0 = Buffer.alloc(16)
  b0[0] = (aad.length > 0 ? 0x40 : 0) | (((tag.length - 2) / 2) << 3) | (lengthBytes - 1)
  nonce.copy(b0, 1)
  b0.writeUIntBE(plaintext.length, 16 - lengthBytes, Math.min(lengthBytes, 6))
  const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc((16 - (data.length % 16)) % 16)])
  const header = aad.length > 0 ? pad(Buffer.concat([Buffer.from([aad.length >> 8, aad.length & 0xff]), aad])) : Buffer.alloc(0)
  const blocks = Buffer.concat([b0, header, pad(plaintext)])
  let mac: Buffer = Buffer.alloc(16)
  for (let offset = 0; offset < blocks.length; offset += 16) mac = aesBlock(key, xor(mac, blocks.subarray(offset, offset + 16)))
  const expected = xor(mac.subarray(0, tag.length), aesBlock(key, counter(0)))
  let difference = 0
  for (let index = 0; index < tag.length; index++) difference |= expected[index]! ^ tag[index]!
  return difference === 0 ? plaintext : null
}

// ---------------------------------------------------------------------------------------
// BTHome v2
// ---------------------------------------------------------------------------------------

const unsigned = (data: Buffer, offset: number, length: number) => data.readUIntLE(offset, length)
const signed = (data: Buffer, offset: number, length: number) => data.readIntLE(offset, length)
const scaled = (value: number, factor: number) => {
  const decimals = Math.max(0, Math.round(-Math.log10(factor)))
  return Number((value * factor).toFixed(decimals))
}

type BthomeObject = [length: number, apply?: (values: Values, data: Buffer, offset: number, buttons: number) => void]

const BUTTON_EVENTS: Record<number, ButtonEvent> = { 0x01: 'single', 0x02: 'double', 0x03: 'triple', 0x04: 'hold', 0x80: 'hold' }
const flag = (key: 'open' | 'leak' | 'motion' | 'occupied' | 'smoke' | 'batteryLow'): BthomeObject => [1, (values, data, offset) => void (values[key] = data[offset] === 1)]

/**
 * Only objects whose length is known for certain: the specification says to stop at the first
 * unknown one, since reading past it with a wrong length would misread everything after.
 */
const BTHOME: Record<number, BthomeObject> = {
  0x01: [1, (values, data, offset) => void (values.battery = data[offset])],
  0x02: [2, (values, data, offset) => void (values.temperature = scaled(signed(data, offset, 2), 0.01))],
  0x03: [2, (values, data, offset) => void (values.humidity = scaled(unsigned(data, offset, 2), 0.01))],
  0x04: [3, (values, data, offset) => void (values.pressure = scaled(unsigned(data, offset, 3), 0.01))],
  0x05: [3, (values, data, offset) => void (values.illuminance = scaled(unsigned(data, offset, 3), 0.01))],
  0x06: [2],
  0x07: [2],
  0x08: [2],
  0x09: [1],
  0x0a: [3, (values, data, offset) => void (values.energy = scaled(unsigned(data, offset, 3), 0.001))],
  0x0b: [3, (values, data, offset) => void (values.power = scaled(unsigned(data, offset, 3), 0.01))],
  0x0c: [2, (values, data, offset) => void (values.voltage = scaled(unsigned(data, offset, 2), 0.001))],
  0x0d: [2, (values, data, offset) => void (values.pm25 = unsigned(data, offset, 2))],
  0x0e: [2, (values, data, offset) => void (values.pm10 = unsigned(data, offset, 2))],
  0x0f: [1],
  0x10: [1],
  0x11: flag('open'),
  0x12: [2, (values, data, offset) => void (values.co2 = unsigned(data, offset, 2))],
  0x13: [2, (values, data, offset) => void (values.voc = unsigned(data, offset, 2))],
  0x14: [2, (values, data, offset) => void (values.moisture = scaled(unsigned(data, offset, 2), 0.01))],
  0x15: flag('batteryLow'),
  0x16: [1],
  0x17: [1],
  0x18: [1],
  0x19: [1],
  0x1a: flag('open'),
  0x1b: [1],
  0x1c: [1],
  0x1d: [1],
  0x1e: [1],
  0x1f: [1],
  0x20: flag('leak'),
  0x21: flag('motion'),
  0x22: [1],
  0x23: flag('occupied'),
  0x24: [1],
  0x25: flag('occupied'),
  0x26: [1],
  0x27: [1],
  0x28: [1],
  0x29: flag('smoke'),
  0x2a: [1],
  0x2b: [1],
  0x2c: [1],
  0x2d: flag('open'),
  0x2e: [1, (values, data, offset) => void (values.humidity = data[offset])],
  0x2f: [1, (values, data, offset) => void (values.moisture = data[offset])],
  0x3a: [
    1,
    (values, data, offset, buttons) => {
      const event = BUTTON_EVENTS[data[offset]!]
      if (event) values.buttons = [...(values.buttons ?? []), { index: buttons, event }]
    },
  ],
  0x3c: [2],
  0x45: [2, (values, data, offset) => void (values.temperature = scaled(signed(data, offset, 2), 0.1))],
  0x4a: [2, (values, data, offset) => void (values.voltage = scaled(unsigned(data, offset, 2), 0.1))],
  0x57: [1, (values, data, offset) => void (values.temperature = signed(data, offset, 1))],
}

function bthomeObjects(data: Buffer): { values: Values; packet: number | null } {
  const values: Values = {}
  let packet: number | null = null
  let buttons = 0
  let offset = 0
  while (offset < data.length) {
    const id = data[offset]!
    if (id === 0x00) {
      if (offset + 1 >= data.length) break
      packet = data[offset + 1]!
      offset += 2
      continue
    }
    const object = BTHOME[id]
    if (!object || offset + 1 + object[0] > data.length) break
    object[1]?.(values, data, offset + 1, buttons)
    if (id === 0x3a) buttons += 1
    offset += 1 + object[0]
  }
  // A voltage without power is the battery's.
  if (values.voltage !== undefined && values.power === undefined) {
    values.batteryVoltage = values.voltage
    delete values.voltage
  }
  return { values, packet }
}

function macBytes(address: string): Buffer {
  return Buffer.from(address.replace(/:/g, ''), 'hex')
}

function decodeBthome(advert: Advert, data: Buffer, keys: Map<string, Buffer>): Decoded | null {
  if (data.length < 1) return null
  const info = data[0]!
  if ((info >> 5) !== 2) return null
  if ((info & 0x01) === 0) return { kind: 'reading', format: 'bthome', model: null, ...bthomeObjects(data.subarray(1)) }
  const key = keys.get(advert.address)
  if (!key) return { kind: 'locked', format: 'bthome', model: null, reason: 'no-key' }
  const payload = data.subarray(1)
  if (payload.length < 9) return null
  const counter = payload.subarray(payload.length - 8, payload.length - 4)
  const nonce = Buffer.concat([macBytes(advert.address), Buffer.from([0xd2, 0xfc, info]), counter])
  const plain = aesCcmDecrypt(key, nonce, payload.subarray(0, payload.length - 8), payload.subarray(payload.length - 4))
  if (!plain) return { kind: 'locked', format: 'bthome', model: null, reason: 'wrong-key' }
  return { kind: 'reading', format: 'bthome', model: null, ...bthomeObjects(plain) }
}

// ---------------------------------------------------------------------------------------
// Xiaomi: pvvx, ATC1441, MiBeacon
// ---------------------------------------------------------------------------------------

function decode181a(advert: Advert, data: Buffer): Decoded | null {
  if (data.length === 15) {
    // pvvx: the address least significant byte first, little-endian hundredths.
    return {
      kind: 'reading',
      format: 'pvvx',
      model: null,
      packet: data[13]!,
      values: {
        temperature: scaled(data.readInt16LE(6), 0.01),
        humidity: scaled(data.readUInt16LE(8), 0.01),
        batteryVoltage: scaled(data.readUInt16LE(10), 0.001),
        battery: data[12]!,
      },
    }
  }
  if (data.length === 13) {
    // ATC1441: the address as written, big-endian tenths.
    return {
      kind: 'reading',
      format: 'atc1441',
      model: null,
      packet: data[12]!,
      values: {
        temperature: scaled(data.readInt16BE(6), 0.1),
        humidity: data[8]!,
        battery: data[9]!,
        batteryVoltage: scaled(data.readUInt16BE(10), 0.001),
      },
    }
  }
  void advert
  return null
}

/** The Xiaomi products seen most, by the id their advertisements carry. */
const MIBEACON_MODELS: Record<number, string> = {
  0x0098: 'HHCCJCY01',
  0x01aa: 'LYWSDCGQ',
  0x0347: 'CGG1',
  0x045b: 'LYWSD02',
  0x055b: 'LYWSD03MMC',
  0x0387: 'MHO-C401',
  0x098b: 'MCCGQ02HL',
  0x0a8d: 'RTCGQ02LM',
  0x16e4: 'LYWSD02MMC',
  0x2542: 'LYWSD02MMC',
}

/** These round their humidity down to whole percents, as xiaomi-ble does, against stair-stepping readings. */
const WHOLE_HUMIDITY = new Set(['LYWSD03MMC', 'MHO-C401'])

function mibeaconObjects(payload: Buffer, model: string | null): Values {
  const values: Values = {}
  let offset = 0
  while (offset + 3 <= payload.length) {
    const type = payload.readUInt16LE(offset)
    const length = payload[offset + 2]!
    const start = offset + 3
    if (start + length > payload.length) break
    const value = payload.subarray(start, start + length)
    switch (type) {
      case 0x1004:
        if (length === 2) values.temperature = scaled(value.readInt16LE(0), 0.1)
        break
      case 0x1006:
        if (length === 2) values.humidity = model && WHOLE_HUMIDITY.has(model) ? Math.trunc(value.readUInt16LE(0) / 10) : scaled(value.readUInt16LE(0), 0.1)
        break
      case 0x100a:
      case 0x4803:
        if (length >= 1) values.battery = value[0]!
        break
      case 0x100d:
        if (length === 4) {
          values.temperature = scaled(value.readInt16LE(0), 0.1)
          values.humidity = scaled(value.readUInt16LE(2), 0.1)
        }
        break
      case 0x1007:
        if (length === 3) values.illuminance = value.readUIntLE(0, 3)
        break
      case 0x1008:
        if (length >= 1) values.moisture = value[0]!
        break
      case 0x1009:
        if (length === 2) values.conductivity = value.readUInt16LE(0)
        break
      case 0x1019:
        // 0 open, 1 closed, 2 left open; 3 is a reset, not a position.
        if (length >= 1 && value[0]! <= 2) values.open = value[0] !== 1
        break
      case 0x000f:
        values.motion = true
        break
      case 0x4c01:
        if (length === 4) values.temperature = Number(value.readFloatLE(0).toFixed(2))
        break
      case 0x4c02:
        if (length === 1) values.humidity = value[0]!
        break
    }
    offset = start + length
  }
  return values
}

function decodeMibeacon(advert: Advert, data: Buffer, keys: Map<string, Buffer>): Decoded | null {
  if (data.length < 5) return null
  const control = data.readUInt16LE(0)
  const version = control >> 12
  if ((control >> 7) & 1 || version < 2) return null
  const model = MIBEACON_MODELS[data.readUInt16LE(2)] ?? null
  const packet = data[4]!
  let index = 5
  if (control & 0x10) {
    index += 6
    if (data.length < index || !data.subarray(5, 11).equals(Buffer.from(macBytes(advert.address)).reverse())) return null
  }
  if (control & 0x20) {
    index += 1
    if (data.length >= index && data[index - 1]! & 0x20) index += 1
  }
  if (!(control & 0x40)) return null
  if (!(control & 0x08)) {
    const values = mibeaconObjects(data.subarray(index), model)
    return Object.keys(values).length > 0 ? { kind: 'reading', format: 'mibeacon', model, packet, values } : null
  }
  // Legacy (v2/v3) encryption is left aside: those devices are rare now.
  if (version < 4) return null
  const key = keys.get(advert.address)
  if (!key) return { kind: 'locked', format: 'mibeacon', model, reason: 'no-key' }
  if (data.length < index + 9) return null
  const nonce = Buffer.concat([Buffer.from(macBytes(advert.address)).reverse(), data.subarray(2, 5), data.subarray(data.length - 7, data.length - 4)])
  const plain = aesCcmDecrypt(key, nonce, data.subarray(index, data.length - 7), data.subarray(data.length - 4), Buffer.from([0x11]))
  if (!plain) return { kind: 'locked', format: 'mibeacon', model, reason: 'wrong-key' }
  return { kind: 'reading', format: 'mibeacon', model, packet, values: mibeaconObjects(plain, model) }
}

// ---------------------------------------------------------------------------------------
// Govee, SwitchBot, Ruuvi, iBeacon
// ---------------------------------------------------------------------------------------

function goveePacked(data: Buffer): { temperature?: number; humidity?: number; battery: number } {
  const packed = data.readUIntBE(0, 3)
  const magnitude = packed & 0x7fffff
  const temperature = (Math.trunc(magnitude / 1000) / 10) * (packed & 0x800000 ? -1 : 1)
  const humidity = (magnitude % 1000) / 10
  const battery = data[3]! & 0x7f
  const error = (data[3]! & 0x80) !== 0
  // Out of the sensor's range, or flagged: the reading is wrong, the battery is not.
  if (error || temperature < -40 || temperature > 100) return { battery }
  return { temperature, humidity, battery }
}

function decodeGovee(advert: Advert, raw: Buffer): Decoded | null {
  // A macOS artefact sometimes glues Apple's beacon onto the end.
  const data = raw.length > 25 && raw.includes(Buffer.from('INTELLI_ROCKS')) ? raw.subarray(0, raw.length - 25) : raw
  const name = advert.name ?? ''
  if (data.length === 6) {
    const model = /H5072/.test(name) ? 'H5072' : /H5075/.test(name) ? 'H5075' : 'H5072/H5075'
    return { kind: 'reading', format: 'govee', model, packet: null, values: goveePacked(data.subarray(1, 5)) }
  }
  if (data.length === 7) {
    return {
      kind: 'reading',
      format: 'govee',
      model: 'H5074',
      packet: null,
      values: { temperature: scaled(data.readInt16LE(1), 0.01), humidity: scaled(data.readUInt16LE(3), 0.01), battery: data[5]! },
    }
  }
  return null
}

const SWITCHBOT_METERS: Record<string, string> = { T: 'Meter', i: 'Meter Plus', w: 'Outdoor Meter', '4': 'Meter Pro', '5': 'Meter Pro CO2' }

function decodeSwitchbot(advert: Advert): Decoded | null {
  const service = advert.serviceData.get('fd3d') ?? advert.serviceData.get('0d00') ?? null
  const maker = advert.manufacturer.get(0x0969) ?? null
  if (!service || service.length < 1) return null
  const letter = String.fromCharCode(service[0]! & 0x7f)
  const model = SWITCHBOT_METERS[letter] ?? SWITCHBOT_METERS[letter.toLowerCase()] ?? null
  if (!model) return null
  const reading = maker && maker.length >= 11 ? maker.subarray(8, 11) : service.length >= 6 ? service.subarray(3, 6) : null
  if (!reading) return null
  const temperature = ((reading[1]! & 0x80 ? 1 : -1) * ((reading[1]! & 0x7f) * 10 + (reading[0]! & 0x0f))) / 10
  const humidity = reading[2]! & 0x7f
  const values: Values = { temperature, humidity }
  if (service.length >= 3) values.battery = service[2]! & 0x7f
  if (model === 'Meter Pro CO2' && maker && maker.length >= 15) {
    const co2 = maker.readUInt16BE(13)
    if (co2 <= 9999) values.co2 = co2
  }
  return { kind: 'reading', format: 'switchbot', model, packet: null, values }
}

function decodeRuuvi(data: Buffer): Decoded | null {
  if (data.length < 24 || data[0] !== 5) return null
  const values: Values = {}
  const temperature = data.readInt16BE(1)
  if (temperature !== -32768) values.temperature = scaled(temperature, 0.005)
  const humidity = data.readUInt16BE(3)
  if (humidity !== 0xffff) values.humidity = scaled(humidity, 0.0025)
  const pressure = data.readUInt16BE(5)
  if (pressure !== 0xffff) values.pressure = (pressure + 50_000) / 100
  const power = data.readUInt16BE(13)
  if (power >> 5 !== 0x7ff) values.batteryVoltage = ((power >> 5) + 1600) / 1000
  if (data[15] !== 0xff) values.motionCount = data[15]!
  const sequence = data.readUInt16BE(16)
  return { kind: 'reading', format: 'ruuvi', model: 'RuuviTag', packet: sequence === 0xffff ? null : sequence, values }
}

const THERMOBEACON_MODELS: Record<number, string> = {
  0x10: 'Lanyard/mini hygrometer',
  0x11: 'Smart hygrometer',
  0x14: 'Smart hygrometer',
  0x15: 'Smart hygrometer',
  0x18: 'Smart hygrometer',
  0x1b: 'Smart hygrometer',
  0x30: 'Smart hygrometer',
}

/** ThermoBeacon (Brifit, SensorBlue): the company id is its model; the 20-byte packet is the reading, the 22-byte one the day's extremes. */
function decodeThermobeacon(advert: Advert): Decoded | null {
  if (!advert.serviceUuids.includes('fff0')) return null
  for (const [company, payload] of advert.manufacturer) {
    const model = THERMOBEACON_MODELS[company]
    if (!model || payload.length !== 18) continue
    const volt = payload.readUInt16LE(8)
    const temperature = payload.readInt16LE(10) / 16
    const humidity = payload.readUInt16LE(12) / 16
    if (temperature > 100 || humidity > 100) return null
    const battery = volt >= 3000 ? 100 : volt >= 2600 ? 60 + (volt - 2600) * 0.1 : volt >= 2500 ? 40 + (volt - 2500) * 0.2 : volt >= 2450 ? 20 + (volt - 2450) * 0.4 : 0
    return {
      kind: 'reading',
      format: 'thermobeacon',
      model,
      packet: null,
      values: { temperature: Number(temperature.toFixed(2)), humidity: Number(humidity.toFixed(2)), batteryVoltage: volt / 1000, battery: Math.round(battery) },
    }
  }
  return null
}

function decodeIbeacon(data: Buffer): Decoded | null {
  if (data.length < 23 || data[0] !== 0x02 || data[1] !== 0x15) return null
  const id = data.subarray(2, 18).toString('hex')
  return {
    kind: 'beacon',
    uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
    major: data.readUInt16BE(18),
    minor: data.readUInt16BE(20),
    txPower: data.readInt8(22),
  }
}

/** What an advertisement says, if it is from something the house knows how to read. */
export function decode(advert: Advert, keys: Map<string, Buffer>): Decoded | null {
  const bthome = advert.serviceData.get('fcd2')
  if (bthome) return decodeBthome(advert, bthome, keys)
  const mibeacon = advert.serviceData.get('fe95')
  if (mibeacon) {
    const decoded = decodeMibeacon(advert, mibeacon, keys)
    if (decoded) return decoded
  }
  const environmental = advert.serviceData.get('181a')
  if (environmental) {
    const decoded = decode181a(advert, environmental)
    if (decoded) return decoded
  }
  const switchbot = decodeSwitchbot(advert)
  if (switchbot) return switchbot
  const govee = advert.manufacturer.get(0xec88)
  if (govee) {
    const decoded = decodeGovee(advert, govee)
    if (decoded) return decoded
  }
  const ruuvi = advert.manufacturer.get(0x0499)
  if (ruuvi) {
    const decoded = decodeRuuvi(ruuvi)
    if (decoded) return decoded
  }
  const thermobeacon = decodeThermobeacon(advert)
  if (thermobeacon) return thermobeacon
  const apple = advert.manufacturer.get(0x004c)
  if (apple) return decodeIbeacon(apple)
  return null
}

// ---------------------------------------------------------------------------------------
// In the house's vocabulary
// ---------------------------------------------------------------------------------------

export function capabilitiesFor(values: Values): CapabilityId[] {
  const capabilities: CapabilityId[] = []
  const add = (present: boolean, capability: CapabilityId) => {
    if (present) capabilities.push(capability)
  }
  add(values.temperature !== undefined, 'temperature')
  add(values.humidity !== undefined, 'humidity')
  add(values.pressure !== undefined, 'pressure')
  add(values.motion !== undefined, 'motion')
  add(values.illuminance !== undefined, 'illuminance')
  add(values.occupied !== undefined, 'occupancy')
  add(values.open !== undefined, 'contact')
  add(values.leak !== undefined, 'waterLeak')
  add(values.smoke !== undefined, 'smoke')
  add(values.co2 !== undefined || values.pm25 !== undefined || values.pm10 !== undefined || values.voc !== undefined, 'airQuality')
  add(values.power !== undefined, 'power')
  add(values.energy !== undefined, 'energy')
  add(values.battery !== undefined, 'battery')
  add((values.buttons?.length ?? 0) > 0, 'button')
  return capabilities
}

function airQualityFrom(co2: number): string {
  if (co2 < 800) return 'good'
  if (co2 < 1000) return 'fair'
  if (co2 < 1500) return 'moderate'
  if (co2 < 2000) return 'poor'
  if (co2 < 5000) return 'very_poor'
  return 'extremely_poor'
}

export function stateFrom(values: Values, now: string): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  const copy = (key: keyof Values, as: string = key) => {
    if (values[key] !== undefined) state[as] = values[key]
  }
  copy('temperature')
  copy('humidity')
  copy('battery')
  if (values.batteryLow !== undefined) state.batteryLow = values.batteryLow
  else if (values.battery !== undefined) state.batteryLow = values.battery <= 10
  copy('batteryVoltage')
  copy('pressure')
  copy('illuminance')
  if (values.motion !== undefined) {
    state.motion = values.motion
    if (values.motion) state.lastMotionAt = now
  }
  if (values.occupied !== undefined) state.occupied = values.occupied
  copy('open')
  copy('leak')
  copy('smoke')
  copy('co2')
  copy('pm25')
  copy('pm10')
  copy('voc')
  if (values.co2 !== undefined) state.airQuality = airQualityFrom(values.co2)
  else if (values.pm25 !== undefined || values.pm10 !== undefined || values.voc !== undefined) state.airQuality = 'unknown'
  copy('power')
  copy('voltage')
  copy('current')
  copy('energy', 'energyTotal')
  copy('moisture')
  copy('conductivity')
  copy('motionCount')
  const button = values.buttons?.at(-1)
  if (button) {
    state.lastEvent = button.event
    state.lastEventAt = now
    state.buttonIndex = button.index
  }
  return state
}

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

/** "A4:C1:38:02:83:F4 = e9ea...a8", one per line. Errors name the sensor, never the key. */
export function parseKeys(text: unknown): { keys: Map<string, Buffer>; errors: string[] } {
  const keys = new Map<string, Buffer>()
  const errors: string[] = []
  const lines = typeof text === 'string' ? text.split(/\r?\n|;/) : []
  lines.forEach((line, index) => {
    if (!line.trim()) return
    const match = /^\s*([0-9a-f]{2}(?:[:-]?[0-9a-f]{2}){5})\s*(?:=|:|\s)\s*(\S*)\s*$/i.exec(line)
    const address = match ? formatAddress(match[1]!) : null
    if (!match || !address) {
      errors.push(`ligne ${index + 1} : attendu "adresse = clé"`)
      return
    }
    if (!/^[0-9a-f]{32}$/i.test(match[2]!)) {
      errors.push(`ligne ${index + 1} : la clé de ${address} doit faire 32 caractères hexadécimaux`)
      return
    }
    keys.set(address, Buffer.from(match[2]!, 'hex'))
  })
  return { keys, errors }
}

export interface BeaconRule {
  name: string
  uuid: string | null
  major: number | null
  minor: number | null
  address: string | null
}

/** "Téléphone de Camille = <iBeacon UUID>[:major[:minor]]" or "Clés = <adresse>", one per line. */
export function parseBeacons(text: unknown): { beacons: BeaconRule[]; errors: string[] } {
  const beacons: BeaconRule[] = []
  const errors: string[] = []
  const lines = typeof text === 'string' ? text.split(/\r?\n/) : []
  lines.forEach((line, index) => {
    if (!line.trim()) return
    const separator = line.indexOf('=')
    const name = separator > 0 ? line.slice(0, separator).trim() : ''
    const target = separator > 0 ? line.slice(separator + 1).trim() : ''
    const beacon = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::(\d{1,5}))?(?::(\d{1,5}))?$/i.exec(target)
    const address = formatAddress(target)
    if (name && beacon) {
      beacons.push({ name, uuid: beacon[1]!.toLowerCase(), major: beacon[2] ? Number(beacon[2]) : null, minor: beacon[3] ? Number(beacon[3]) : null, address: null })
    } else if (name && address && /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(target)) {
      beacons.push({ name, uuid: null, major: null, minor: null, address })
    } else {
      errors.push(`ligne ${index + 1} : attendu "nom = identifiant iBeacon ou adresse"`)
    }
  })
  return { beacons, errors }
}
