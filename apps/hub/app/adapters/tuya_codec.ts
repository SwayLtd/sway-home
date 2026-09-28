/**
 * Tuya local protocol (3.3, 3.4, 3.5): frames, encryption, session keys, announcements and
 * data points. No I/O.
 *
 *  - **3.3**: 0x000055AA frames with a CRC32; JSON payloads encrypted with the device's local
 *    key (AES-128-ECB); commands carry "3.3" and twelve zero bytes before the ciphertext.
 *  - **3.4**: a session key is agreed first (two nonces, HMAC-SHA256 proofs); frames are
 *    signed with HMAC-SHA256 and the version header moves inside the encryption.
 *  - **3.5**: 0x00006699 frames, AES-GCM with the frame header as additional data.
 *
 * Devices announce themselves by UDP: 6666 in clear, 6667 encrypted with a fixed key known to
 * every Tuya app, 7000 for 3.5 (which only speaks when asked).
 *
 * Values are data points ("dps") numbered by product category (Tuya's standard instruction
 * sets): a plug's 1 is its switch and 19 its power in tenths of a watt; a v2 bulb's 20 is its
 * switch and 22 its brightness from 10 to 1000; a curtain's 1 is open/stop/close.
 *
 * Sources: tinytuya (core/header.py, message_helper.py, crypto_helper.py, XenonDevice.py,
 * udp_helper.py, scanner.py).
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { NAMED_COLOURS, rgbToHs, type CapabilityId } from '@sway-home/shared'

export const TUYA_PORT = 6668
export const TUYA_UDP_PORTS = [6666, 6667, 7000] as const
/** The key every Tuya app uses for LAN announcements. */
export const UDP_KEY = createHash('md5').update('yGAdlopoPVldABfn').digest()

export const COMMAND = {
  sessKeyNegStart: 3,
  sessKeyNegResp: 4,
  sessKeyNegFinish: 5,
  control: 7,
  status: 8,
  heartbeat: 9,
  dpQuery: 10,
  controlNew: 13,
  dpQueryNew: 16,
  reqDevinfo: 0x25,
} as const

export type TuyaVersion = '3.3' | '3.4' | '3.5'
export const TUYA_VERSIONS: TuyaVersion[] = ['3.3', '3.4', '3.5']

/** Commands sent without the version header. */
const NO_HEADER = new Set<number>([COMMAND.dpQuery, COMMAND.dpQueryNew, 0x12, COMMAND.heartbeat, COMMAND.sessKeyNegStart, COMMAND.sessKeyNegResp, COMMAND.sessKeyNegFinish, 0x40])

const PREFIX_55AA = 0x000055aa
const SUFFIX_55AA = 0x0000aa55
const PREFIX_6699 = 0x00006699
const SUFFIX_6699 = 0x00009966
const MAX_PAYLOAD = 1440

// ---------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface FrameSpec {
  format: '55aa' | '6699'
  seq: number
  cmd: number
  payload: Buffer
  /** 55AA: the HMAC key (3.4), CRC32 without one. 6699: the AES-GCM key. */
  key?: Buffer | null
  /** Present in frames a device sends. */
  retcode?: number
  iv?: Buffer
}

const uint32 = (value: number) => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value >>> 0, 0)
  return buffer
}

export function packFrame(spec: FrameSpec): Buffer {
  const retcode = spec.retcode === undefined ? Buffer.alloc(0) : uint32(spec.retcode)
  if (spec.format === '55aa') {
    const endLength = spec.key ? 36 : 8
    const header = Buffer.concat([uint32(PREFIX_55AA), uint32(spec.seq), uint32(spec.cmd), uint32(retcode.length + spec.payload.length + endLength)])
    const body = Buffer.concat([header, retcode, spec.payload])
    const check = spec.key ? createHmac('sha256', spec.key).update(body).digest() : uint32(crc32(body))
    return Buffer.concat([body, check, uint32(SUFFIX_55AA)])
  }
  if (!spec.key) throw new Error('A 6699 frame needs a key.')
  const plain = Buffer.concat([retcode, spec.payload])
  const header = Buffer.alloc(18)
  header.writeUInt32BE(PREFIX_6699, 0)
  header.writeUInt16BE(0, 4)
  header.writeUInt32BE(spec.seq >>> 0, 6)
  header.writeUInt32BE(spec.cmd >>> 0, 10)
  header.writeUInt32BE(12 + plain.length + 16, 14)
  const iv = spec.iv ?? randomBytes(12)
  const cipher = createCipheriv('aes-128-gcm', spec.key, iv)
  cipher.setAAD(header.subarray(4))
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([header, iv, sealed, cipher.getAuthTag(), uint32(SUFFIX_6699)])
}

export interface TuyaFrame {
  seq: number
  cmd: number
  retcode: number | null
  payload: Buffer
  /** CRC, HMAC or GCM tag checked out. */
  valid: boolean
}

export class TuyaProtocolError extends Error {}

/** Frames out of a TCP or UDP stream, whatever way it was cut. */
export class TuyaReader {
  #buffer: Buffer = Buffer.alloc(0)

  constructor(private readonly options: { key: () => Buffer | null; hmac: boolean; retcode: boolean }) {}

  push(chunk: Buffer): TuyaFrame[] {
    return [...this.read(chunk)]
  }

  /**
   * Frames one at a time, each opened only when the previous one has been handled: the frame
   * that ends a key negotiation changes the key the next one is checked with.
   */
  *read(chunk: Buffer): Generator<TuyaFrame> {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    for (;;) {
      const start = this.#findPrefix()
      if (start < 0) {
        // Keep the last three bytes: a prefix may be arriving in pieces.
        this.#buffer = this.#buffer.subarray(Math.max(0, this.#buffer.length - 3))
        return
      }
      if (start > 0) this.#buffer = this.#buffer.subarray(start)
      const frame = this.#next()
      if (frame === undefined) return
      if (frame) yield frame
    }
  }

  #findPrefix(): number {
    for (let index = 0; index + 4 <= this.#buffer.length; index++) {
      const value = this.#buffer.readUInt32BE(index)
      if (value === PREFIX_55AA || value === PREFIX_6699) return index
    }
    return -1
  }

  /** undefined: wait for more bytes; null: a frame skipped. */
  #next(): TuyaFrame | null | undefined {
    const buffer = this.#buffer
    if (buffer.length < 4) return undefined
    const is6699 = buffer.readUInt32BE(0) === PREFIX_6699
    const headerLength = is6699 ? 18 : 16
    if (buffer.length < headerLength) return undefined
    const length = buffer.readUInt32BE(is6699 ? 14 : 12)
    if (length > MAX_PAYLOAD + 64) {
      this.#buffer = buffer.subarray(4)
      return null
    }
    const total = headerLength + length + (is6699 ? 4 : 0)
    if (buffer.length < total) return undefined
    const raw = buffer.subarray(0, total)
    this.#buffer = buffer.subarray(total)
    return is6699 ? this.#open6699(raw) : this.#open55aa(raw)
  }

  #open55aa(raw: Buffer): TuyaFrame {
    const key = this.options.hmac ? this.options.key() : null
    const endLength = key ? 36 : 8
    const retcodeLength = this.options.retcode ? 4 : 0
    const bodyEnd = raw.length - endLength
    const check = raw.subarray(bodyEnd, bodyEnd + endLength - 4)
    const expected = key ? createHmac('sha256', key).update(raw.subarray(0, bodyEnd)).digest() : uint32(crc32(raw.subarray(0, bodyEnd)))
    const valid = check.length === expected.length && timingSafeEqual(check, expected)
    return {
      seq: raw.readUInt32BE(4),
      cmd: raw.readUInt32BE(8),
      retcode: retcodeLength ? raw.readUInt32BE(16) : null,
      payload: Buffer.from(raw.subarray(16 + retcodeLength, bodyEnd)),
      valid,
    }
  }

  #open6699(raw: Buffer): TuyaFrame {
    const seq = raw.readUInt32BE(6)
    const cmd = raw.readUInt32BE(10)
    const key = this.options.key()
    const iv = raw.subarray(18, 30)
    const tag = raw.subarray(raw.length - 20, raw.length - 4)
    const sealed = raw.subarray(30, raw.length - 20)
    if (!key) return { seq, cmd, retcode: null, payload: Buffer.alloc(0), valid: false }
    try {
      const decipher = createDecipheriv('aes-128-gcm', key, iv)
      decipher.setAAD(raw.subarray(4, 18))
      decipher.setAuthTag(tag)
      let plain = Buffer.concat([decipher.update(sealed), decipher.final()])
      let retcode: number | null = null
      if (this.options.retcode && plain.length >= 4) {
        retcode = plain.readUInt32BE(0)
        plain = plain.subarray(4)
      }
      return { seq, cmd, retcode, payload: Buffer.from(plain), valid: true }
    } catch {
      return { seq, cmd, retcode: null, payload: Buffer.alloc(0), valid: false }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------------------

/** ECB because 3.3 and 3.4 devices speak nothing else; 3.5 moved to GCM. */
export function aesEcbEncrypt(key: Buffer, data: Buffer, pad = true): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(pad)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

export function aesEcbDecrypt(key: Buffer, data: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

export function versionHeader(version: TuyaVersion): Buffer {
  return Buffer.concat([Buffer.from(version, 'latin1'), Buffer.alloc(12)])
}

export function commandFor(version: TuyaVersion, kind: 'control' | 'query'): number {
  if (version === '3.3') return kind === 'control' ? COMMAND.control : COMMAND.dpQuery
  return kind === 'control' ? COMMAND.controlNew : COMMAND.dpQueryNew
}

export function requestJson(version: TuyaVersion, kind: 'control' | 'query' | 'heartbeat', devId: string, dps?: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
  const seconds = Math.floor(now / 1000)
  if (kind === 'heartbeat') return { gwId: devId, devId }
  if (version === '3.3') {
    return kind === 'control' ? { devId, uid: devId, t: String(seconds), dps: dps ?? {} } : { gwId: devId, devId, uid: devId, t: String(seconds) }
  }
  return kind === 'control' ? { protocol: 5, t: seconds, data: { dps: dps ?? {} } } : {}
}

/** The payload of a request frame: JSON with the version header where it goes, encrypted where it is. */
export function encodeRequest(version: TuyaVersion, cmd: number, json: Record<string, unknown>, key: Buffer): Buffer {
  const body = Buffer.from(JSON.stringify(json), 'utf8')
  const header = NO_HEADER.has(cmd) ? Buffer.alloc(0) : versionHeader(version)
  if (version === '3.3') return Buffer.concat([header, aesEcbEncrypt(key, body)])
  if (version === '3.4') return aesEcbEncrypt(key, Buffer.concat([header, body]))
  return Buffer.concat([header, body])
}

/** What a device sent back, as JSON with `dps` at the top; `{ error }` for the device's own complaints. */
export function decodeResponse(version: TuyaVersion, payload: Buffer, key: Buffer): Record<string, unknown> | null {
  if (payload.length === 0) return null
  let data = payload
  try {
    if (version === '3.4') data = aesEcbDecrypt(key, data)
    if (data.subarray(0, 3).toString('latin1') === version) data = data.subarray(15)
    if (version === '3.3' && data[0] !== 0x7b) data = aesEcbDecrypt(key, data)
  } catch {
    return null
  }
  const text = data.toString('utf8').replace(/\0+$/, '')
  if (/data unvalid/.test(text)) return { error: 'data unvalid' }
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    const inner = json.data as { dps?: unknown } | undefined
    if (json.dps === undefined && inner && typeof inner === 'object' && inner.dps !== undefined) json.dps = inner.dps
    return json
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------
// The 3.4 and 3.5 session key
// ---------------------------------------------------------------------------------------

/** The first negotiation payload: the client's nonce, encrypted with the local key in 3.4. */
export function negotiateStart(version: '3.4' | '3.5', localKey: Buffer, localNonce: Buffer): Buffer {
  return version === '3.4' ? aesEcbEncrypt(localKey, localNonce) : Buffer.from(localNonce)
}

/**
 * The device's answer checked (its nonce and the HMAC of ours prove it has the same local
 * key), the last negotiation payload, and the session key both sides now use.
 */
export function negotiateFinish(version: '3.4' | '3.5', localKey: Buffer, localNonce: Buffer, answer: Buffer): { finish: Buffer; sessionKey: Buffer } | { error: string } {
  const wrong = { error: 'La clé locale ne correspond pas à cet appareil.' }
  let plain: Buffer
  try {
    plain = version === '3.4' ? aesEcbDecrypt(localKey, answer) : answer
  } catch {
    return wrong
  }
  if (plain.length < 48) return wrong
  const remoteNonce = plain.subarray(0, 16)
  const proof = createHmac('sha256', localKey).update(localNonce).digest()
  if (!timingSafeEqual(proof, plain.subarray(16, 48))) return wrong

  const answerProof = createHmac('sha256', localKey).update(remoteNonce).digest()
  const mixed = Buffer.from(localNonce.map((byte, index) => byte ^ remoteNonce[index]!))
  let sessionKey: Buffer
  if (version === '3.4') {
    sessionKey = aesEcbEncrypt(localKey, mixed, false)
  } else {
    const cipher = createCipheriv('aes-128-gcm', localKey, localNonce.subarray(0, 12))
    sessionKey = Buffer.concat([cipher.update(mixed), cipher.final()]).subarray(0, 16)
  }
  return { finish: version === '3.4' ? aesEcbEncrypt(localKey, answerProof) : answerProof, sessionKey }
}

// ---------------------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------------------

export interface TuyaAnnounce {
  id: string
  ip: string
  version: string
  productKey: string | null
}

/** A device's UDP announcement, whichever port and version it came on. */
export function decodeBroadcast(message: Buffer): TuyaAnnounce | null {
  let text: string | null = null
  const prefix = message.length >= 4 ? message.readUInt32BE(0) : 0
  try {
    if (prefix === PREFIX_6699) {
      const [frame] = new TuyaReader({ key: () => UDP_KEY, hmac: false, retcode: false }).push(message)
      if (!frame?.valid) return null
      const body = frame.payload[0] === 0x7b ? frame.payload : frame.payload.subarray(4)
      text = body.toString('utf8')
    } else if (prefix === PREFIX_55AA) {
      const [frame] = new TuyaReader({ key: () => null, hmac: false, retcode: true }).push(message)
      if (!frame) return null
      text = (frame.payload[0] === 0x7b ? frame.payload : aesEcbDecrypt(UDP_KEY, frame.payload)).toString('utf8')
    } else {
      text = aesEcbDecrypt(UDP_KEY, message).toString('utf8')
    }
  } catch {
    return null
  }
  try {
    const json = JSON.parse(text.replace(/\0+$/, '')) as Record<string, unknown>
    if (typeof json.gwId !== 'string' || typeof json.ip !== 'string') return null
    return { id: json.gwId, ip: json.ip, version: typeof json.version === 'string' ? json.version : '3.3', productKey: typeof json.productKey === 'string' ? json.productKey : null }
  } catch {
    return null
  }
}

/** What makes 3.5 devices announce themselves (sent to port 7000). */
export function discoveryRequest(localIp: string): Buffer {
  return packFrame({ format: '6699', seq: 0, cmd: COMMAND.reqDevinfo, payload: Buffer.from(JSON.stringify({ from: 'app', ip: localIp })), key: UDP_KEY })
}

// ---------------------------------------------------------------------------------------
// Data points
// ---------------------------------------------------------------------------------------

export const TUYA_PROFILES = ['switch', 'plug', 'bulb', 'bulb_v1', 'cover'] as const
export type TuyaProfile = (typeof TUYA_PROFILES)[number]
export type Dps = Record<string, unknown>

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const COVER_WORDS = new Set(['open', 'stop', 'close', 'continue', 'on', 'off'])

export function detectProfile(dps: Dps): TuyaProfile | null {
  if (typeof dps['20'] === 'boolean' && (isNumber(dps['22']) || typeof dps['21'] === 'string')) return 'bulb'
  if (typeof dps['1'] === 'string' && COVER_WORDS.has(dps['1'])) return 'cover'
  if (typeof dps['1'] === 'boolean' && typeof dps['2'] === 'string' && isNumber(dps['3'])) return 'bulb_v1'
  if (typeof dps['1'] === 'boolean' && (isNumber(dps['19']) || isNumber(dps['5']))) return 'plug'
  if (typeof dps['1'] === 'boolean') return 'switch'
  return null
}

export function capabilitiesFor(profile: TuyaProfile, dps: Dps): CapabilityId[] {
  switch (profile) {
    case 'switch':
      return ['onoff']
    case 'plug':
      return ['onoff', 'power']
    case 'bulb':
      return ['onoff', 'brightness', ...(dps['23'] !== undefined ? (['colorTemperature'] as const) : []), ...(dps['24'] !== undefined ? (['color'] as const) : [])]
    case 'bulb_v1':
      return ['onoff', 'brightness', ...(dps['4'] !== undefined ? (['colorTemperature'] as const) : []), ...(dps['5'] !== undefined ? (['color'] as const) : [])]
    case 'cover':
      return ['position']
  }
}

const KELVIN_MIN = 2700
const KELVIN_MAX = 6500
const round1 = (value: number) => Math.round(value * 10) / 10

/** HHHHSSSSVVVV: hue 0-360, saturation and value 0-1000, four hex digits each. */
function parseColourV2(value: unknown): { hue: number; saturation: number; value: number } | null {
  if (typeof value !== 'string' || !/^[0-9a-f]{12}$/i.test(value)) return null
  return { hue: parseInt(value.slice(0, 4), 16), saturation: parseInt(value.slice(4, 8), 16), value: parseInt(value.slice(8, 12), 16) }
}

const hex = (value: number, digits: number) => Math.round(value).toString(16).padStart(digits, '0')

export function stateFromDps(profile: TuyaProfile, dps: Dps): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  switch (profile) {
    case 'switch':
      if (typeof dps['1'] === 'boolean') state.on = dps['1']
      return state
    case 'plug': {
      if (typeof dps['1'] === 'boolean') state.on = dps['1']
      const newer = isNumber(dps['19'])
      const power = newer ? dps['19'] : dps['5']
      const voltage = newer ? dps['20'] : dps['6']
      const current = newer ? dps['18'] : dps['4']
      if (isNumber(power)) state.power = round1(power / 10)
      if (isNumber(voltage)) state.voltage = round1(voltage / 10)
      if (isNumber(current)) state.current = Math.round(current) / 1000
      return state
    }
    case 'bulb': {
      if (typeof dps['20'] === 'boolean') state.on = dps['20']
      const colour = dps['21'] === 'colour' ? parseColourV2(dps['24']) : null
      if (colour) {
        state.brightness = Math.round(colour.value / 10)
        state.hue = colour.hue
        state.saturation = Math.round(colour.saturation / 10)
        return state
      }
      if (isNumber(dps['22'])) state.brightness = Math.max(0, Math.min(100, Math.round(((dps['22'] - 10) / 990) * 100)))
      if (isNumber(dps['23'])) state.colorTemperature = Math.round(KELVIN_MIN + (dps['23'] / 1000) * (KELVIN_MAX - KELVIN_MIN))
      return state
    }
    case 'bulb_v1': {
      if (typeof dps['1'] === 'boolean') state.on = dps['1']
      if (isNumber(dps['3'])) state.brightness = Math.max(0, Math.min(100, Math.round(((dps['3'] - 25) / 230) * 100)))
      if (isNumber(dps['4'])) state.colorTemperature = Math.round(KELVIN_MIN + (dps['4'] / 255) * (KELVIN_MAX - KELVIN_MIN))
      const colour = dps['2'] === 'colour' && typeof dps['5'] === 'string' && dps['5'].length === 14 ? dps['5'] : null
      if (colour) {
        state.hue = parseInt(colour.slice(6, 10), 16)
        state.saturation = Math.round((parseInt(colour.slice(10, 12), 16) / 255) * 100)
      }
      return state
    }
    case 'cover': {
      const position = isNumber(dps['3']) ? dps['3'] : dps['2']
      if (isNumber(position)) state.position = Math.max(0, Math.min(100, position))
      return state
    }
  }
}

/** The points a command writes, and the state it should leave. */
export function dpsForCommand(profile: TuyaProfile, command: string, args: Record<string, unknown>, dps: Dps): { dps: Dps; expect: Record<string, unknown> } | { error: string } {
  const cannot = { error: `Cet appareil Tuya ne sait pas faire "${command}".` }
  const bulb = profile === 'bulb' || profile === 'bulb_v1'
  const switchPoint = profile === 'bulb' ? '20' : '1'

  if (command === 'turnOn' || command === 'turnOff' || command === 'toggle') {
    if (profile === 'cover') return cannot
    const on = command === 'toggle' ? dps[switchPoint] !== true : command === 'turnOn'
    return { dps: { [switchPoint]: on }, expect: { on } }
  }

  if (profile === 'cover') {
    switch (command) {
      case 'open':
        return { dps: { 1: 'open' }, expect: { position: 100 } }
      case 'close':
        return { dps: { 1: 'close' }, expect: { position: 0 } }
      case 'stop':
        return { dps: { 1: 'stop' }, expect: {} }
      case 'setPosition': {
        const position = Math.round(Math.min(100, Math.max(0, Number(args.position))))
        return Number.isFinite(position) ? { dps: { 2: position }, expect: { position } } : { error: 'Position manquante.' }
      }
      default:
        return cannot
    }
  }
  if (!bulb) return cannot

  const current = stateFromDps(profile, dps)
  const colourFor = (hue: number, saturation: number): { dps: Dps; expect: Record<string, unknown> } => {
    const brightness = typeof current.brightness === 'number' && current.brightness > 0 ? current.brightness : 100
    if (profile === 'bulb') {
      return { dps: { 20: true, 21: 'colour', 24: hex(hue, 4) + hex(saturation * 10, 4) + hex(brightness * 10, 4) }, expect: { on: true, hue, saturation } }
    }
    const [r, g, b] = hsvToRgb(hue, saturation, brightness)
    return {
      dps: { 1: true, 2: 'colour', 5: hex(r, 2) + hex(g, 2) + hex(b, 2) + hex(hue, 4) + hex((saturation / 100) * 255, 2) + hex((brightness / 100) * 255, 2) },
      expect: { on: true, hue, saturation },
    }
  }

  switch (command) {
    case 'setBrightness':
    case 'stepBrightness': {
      const base = typeof current.brightness === 'number' ? current.brightness : 0
      const brightness = Math.round(Math.min(100, Math.max(1, command === 'setBrightness' ? Number(args.brightness) : base + Number(args.delta ?? 0))))
      if (!Number.isFinite(brightness)) return { error: 'Luminosité manquante.' }
      if (profile === 'bulb' && dps['21'] === 'colour' && typeof current.hue === 'number') {
        return { dps: { 20: true, 24: hex(current.hue, 4) + hex(Number(current.saturation ?? 100) * 10, 4) + hex(brightness * 10, 4) }, expect: { on: true, brightness } }
      }
      return profile === 'bulb'
        ? { dps: { 20: true, 22: Math.round(10 + (brightness / 100) * 990) }, expect: { on: true, brightness } }
        : { dps: { 1: true, 3: Math.round(25 + (brightness / 100) * 230) }, expect: { on: true, brightness } }
    }
    case 'setColorTemperature': {
      const kelvin = Math.round(Math.min(KELVIN_MAX, Math.max(KELVIN_MIN, Number(args.kelvin))))
      if (!Number.isFinite(kelvin)) return { error: 'Température de couleur manquante.' }
      const ratio = (kelvin - KELVIN_MIN) / (KELVIN_MAX - KELVIN_MIN)
      return profile === 'bulb'
        ? { dps: { 20: true, 21: 'white', 23: Math.round(ratio * 1000) }, expect: { on: true, colorTemperature: kelvin } }
        : { dps: { 1: true, 2: 'white', 4: Math.round(ratio * 255) }, expect: { on: true, colorTemperature: kelvin } }
    }
    case 'setColor':
      return colourFor(Math.round(Number(args.hue) % 360), Math.round(Math.min(100, Math.max(0, Number(args.saturation)))))
    case 'setColorRgb': {
      const [hue, saturation] = rgbToHs(Number(args.r), Number(args.g), Number(args.b))
      return colourFor(Math.round(hue), Math.round(saturation))
    }
    case 'setColorName': {
      const named = NAMED_COLOURS[String(args.name ?? '').toLowerCase().trim()]
      return named ? colourFor(named[0], named[1]) : { error: `Couleur inconnue : ${String(args.name ?? '')}.` }
    }
    default:
      return cannot
  }
}

function hsvToRgb(hue: number, saturation: number, value: number): [number, number, number] {
  const s = saturation / 100
  const v = value / 100
  const c = v * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

// ---------------------------------------------------------------------------------------
// The local keys in the settings
// ---------------------------------------------------------------------------------------

export interface TuyaDeviceConfig {
  id: string
  key: string
  name: string | null
  profile: TuyaProfile | null
  ip: string | null
  version: TuyaVersion | null
}

/**
 * `{"<device id>": "<local key>"}`, or an object per device with a name, a kind, an address
 * and a version. Errors never repeat the key.
 */
export function parseLocalKeys(text: string): { devices: TuyaDeviceConfig[]; errors: string[] } {
  if (text.trim().length === 0) return { devices: [], errors: [] }
  let map: unknown
  try {
    map = JSON.parse(text)
  } catch {
    return { devices: [], errors: ['Clés locales Tuya : JSON illisible.'] }
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { devices: [], errors: ['Clés locales Tuya : un objet {"id": "clé"} est attendu.'] }

  const devices: TuyaDeviceConfig[] = []
  const errors: string[] = []
  for (const [id, value] of Object.entries(map as Record<string, unknown>)) {
    const entry = typeof value === 'string' ? { key: value } : ((value ?? {}) as Record<string, unknown>)
    const key = typeof entry.key === 'string' ? entry.key : ''
    const profile = entry.type === undefined ? null : (entry.type as TuyaProfile)
    const version = entry.version === undefined ? null : String(entry.version)
    if (key.length !== 16) errors.push(`${id} : une clé locale de 16 caractères est attendue.`)
    else if (profile !== null && !TUYA_PROFILES.includes(profile)) errors.push(`${id} : type "${String(entry.type)}" inconnu (${TUYA_PROFILES.join(', ')}).`)
    else if (version !== null && !TUYA_VERSIONS.includes(version as TuyaVersion)) errors.push(`${id} : version "${version}" non prise en charge (${TUYA_VERSIONS.join(', ')}).`)
    else {
      devices.push({
        id,
        key,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null,
        profile,
        ip: typeof entry.ip === 'string' && entry.ip.trim() ? entry.ip.trim() : null,
        version: version as TuyaVersion | null,
      })
    }
  }
  return { devices, errors }
}
