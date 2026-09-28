/**
 * A WebSocket client for LAN devices that sign their own TLS certificate.
 *
 * TVs (LG on 3001, Samsung on 8002) serve TLS with a certificate no authority vouches for.
 * Switching verification off, as most integrations do, hands the pairing key or token to
 * whoever answers in the device's place. This client does trust on first use instead: the
 * SHA-256 of the certificate seen the first time goes back to the caller, who keeps it; a
 * later connection that shows another certificate is dropped right after the TLS handshake,
 * before the HTTP upgrade, so no key, token or command ever reaches it.
 *
 * It is a small RFC 6455 client over `node:tls` (or `node:net` for ws://) because the
 * built-in WebSocket does not expose the peer certificate. It speaks the `SocketLike` shape
 * the adapters already use: `onopen`, `onmessage({ data })`, `onerror`, `onclose({ code,
 * reason })`, `send(text)`, `close()`.
 */

import { createHash, randomBytes } from 'node:crypto'
import { connect as tcpConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { SocketLike } from '#adapters/homeassistant'

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_HANDSHAKE_BYTES = 16 * 1024
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const

/** The device showed another certificate than the one kept at pairing. */
export class CertificateMismatchError extends Error {
  constructor(
    readonly seen: string,
    readonly expected: string
  ) {
    super(`Certificat inattendu : ${seen} au lieu de ${expected}.`)
    this.name = 'CertificateMismatchError'
  }
}

/** A frame stream that breaks RFC 6455; `code` is the close code to answer with. */
export class WebSocketProtocolError extends Error {
  constructor(
    message: string,
    readonly code = 1002
  ) {
    super(message)
    this.name = 'WebSocketProtocolError'
  }
}

export type FrameEvent =
  | { kind: 'text'; data: string }
  | { kind: 'binary'; data: Buffer }
  | { kind: 'ping'; data: Buffer }
  | { kind: 'pong'; data: Buffer }
  | { kind: 'close'; code: number; reason: string }

/** Lowercase hex without separators: a pin copied with colons or in capitals still matches. */
export function normaliseFingerprint(value: string): string {
  return value.replace(/[^0-9a-f]/gi, '').toLowerCase()
}

function xor(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length)
  for (let index = 0; index < payload.length; index++) out[index] = payload[index]! ^ mask[index & 3]!
  return out
}

/** One frame. A client masks everything it sends (`mask`); a server never does (`null`). */
export function encodeFrame(opcode: number, payload: Buffer, options: { mask: Buffer | null; fin?: boolean }): Buffer {
  const first = ((options.fin ?? true) ? 0x80 : 0) | opcode
  const maskBit = options.mask ? 0x80 : 0
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([first, maskBit | length])
  } else if (length < 0x10000) {
    header = Buffer.alloc(4)
    header[1] = maskBit | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = maskBit | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = first
  return options.mask ? Buffer.concat([header, options.mask, xor(payload, options.mask)]) : Buffer.concat([header, payload])
}

/** Bytes in, whole messages and control frames out, whatever way the stream was cut. */
export class FrameReader {
  #buffer: Buffer = Buffer.alloc(0)
  #fragments: Buffer[] = []
  #fragmentBytes = 0
  #fragmentOpcode: number | null = null
  readonly #maxBytes: number

  constructor(options: { maxBytes?: number } = {}) {
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_MESSAGE_BYTES
  }

  push(chunk: Buffer): FrameEvent[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const events: FrameEvent[] = []
    for (let frame = this.#next(); frame; frame = this.#next()) {
      const event = this.#handle(frame.fin, frame.opcode, frame.payload)
      if (event) events.push(event)
    }
    return events
  }

  #next(): { fin: boolean; opcode: number; payload: Buffer } | null {
    const buffer = this.#buffer
    if (buffer.length < 2) return null
    if (buffer[0]! & 0x70) throw new WebSocketProtocolError('Bits réservés utilisés sans extension négociée.')
    const fin = (buffer[0]! & 0x80) !== 0
    const opcode = buffer[0]! & 0x0f
    const masked = (buffer[1]! & 0x80) !== 0
    let length = buffer[1]! & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return null
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return null
      const declared = buffer.readBigUInt64BE(2)
      if (declared > BigInt(this.#maxBytes)) throw new WebSocketProtocolError('Message trop long.', 1009)
      length = Number(declared)
      offset = 10
    }
    if (length > this.#maxBytes) throw new WebSocketProtocolError('Message trop long.', 1009)
    const maskAt = offset
    if (masked) offset += 4
    if (buffer.length < offset + length) return null
    const body = buffer.subarray(offset, offset + length)
    const payload = masked ? xor(body, buffer.subarray(maskAt, maskAt + 4)) : Buffer.from(body)
    this.#buffer = buffer.subarray(offset + length)
    return { fin, opcode, payload }
  }

  #handle(fin: boolean, opcode: number, payload: Buffer): FrameEvent | null {
    if (opcode >= 0x8) {
      if (!fin || payload.length > 125) throw new WebSocketProtocolError('Trame de contrôle fragmentée ou trop longue.')
      switch (opcode) {
        case OPCODE.close:
          return payload.length >= 2 ? { kind: 'close', code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') } : { kind: 'close', code: 1005, reason: '' }
        case OPCODE.ping:
          return { kind: 'ping', data: payload }
        case OPCODE.pong:
          return { kind: 'pong', data: payload }
        default:
          throw new WebSocketProtocolError(`Code de trame inconnu : ${opcode}.`)
      }
    }

    if (opcode === OPCODE.continuation) {
      if (this.#fragmentOpcode === null) throw new WebSocketProtocolError('Suite de message sans début.')
      this.#fragmentBytes += payload.length
      if (this.#fragmentBytes > this.#maxBytes) throw new WebSocketProtocolError('Message trop long.', 1009)
      this.#fragments.push(payload)
      if (!fin) return null
      const whole = Buffer.concat(this.#fragments)
      const kind = this.#fragmentOpcode
      this.#fragments = []
      this.#fragmentBytes = 0
      this.#fragmentOpcode = null
      return message(kind, whole)
    }

    if (opcode !== OPCODE.text && opcode !== OPCODE.binary) throw new WebSocketProtocolError(`Code de trame inconnu : ${opcode}.`)
    if (this.#fragmentOpcode !== null) throw new WebSocketProtocolError('Nouveau message au milieu d\'un message fragmenté.')
    if (fin) return message(opcode, payload)
    this.#fragmentOpcode = opcode
    this.#fragments = [payload]
    this.#fragmentBytes = payload.length
    return null
  }
}

function message(opcode: number, payload: Buffer): FrameEvent {
  return opcode === OPCODE.text ? { kind: 'text', data: payload.toString('utf8') } : { kind: 'binary', data: payload }
}

function closeBody(code: number | null, reason = ''): Buffer {
  if (code === null) return Buffer.alloc(0)
  const head = Buffer.alloc(2)
  head.writeUInt16BE(code, 0)
  return Buffer.concat([head, Buffer.from(reason, 'utf8').subarray(0, 123)])
}

/** What a TLS connection checks the device against, and how a first certificate is kept. */
export interface Trust {
  /** SHA-256 of the certificate the device showed first (any case, colons allowed); null before any TLS contact. */
  pin: string | null
  /** Called on a first TLS contact (no pin) with the certificate's SHA-256, for the caller to keep. */
  onPin?: (fingerprint: string) => void
}

export interface PinnedWebSocketOptions extends Trust {
  /** Connection, TLS handshake and HTTP upgrade all within this delay. */
  timeoutMs?: number
  headers?: Record<string, string>
  maxMessageBytes?: number
}

type ReadyState = 'connecting' | 'open' | 'closing' | 'closed'

class PinnedWebSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  readonly #socket: Socket | TLSSocket
  readonly #reader: FrameReader
  readonly #key = randomBytes(16).toString('base64')
  #state: ReadyState = 'connecting'
  #handshake: Buffer = Buffer.alloc(0)
  #timer: ReturnType<typeof setTimeout> | null
  #closeTimer: ReturnType<typeof setTimeout> | null = null
  #closeEvent: { code: number; reason: string } | null = null
  #errored = false

  constructor(url: URL, options: PinnedWebSocketOptions) {
    const secure = url.protocol === 'wss:'
    if (!secure && url.protocol !== 'ws:') throw new TypeError(`Adresse WebSocket attendue : ${url.href}`)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = Number(url.port) || (secure ? 443 : 80)
    this.#reader = new FrameReader({ maxBytes: options.maxMessageBytes })
    this.#timer = setTimeout(() => this.#fail(new Error(`${url.host} : pas de réponse.`)), options.timeoutMs ?? 5000)

    if (secure) {
      // Verification is done here, against the pin, rather than against authorities that
      // never signed a TV's certificate.
      const socket = tlsConnect({ host, port, rejectUnauthorized: false, ...(isIP(host) ? {} : { servername: host }) })
      socket.once('secureConnect', () => {
        const raw = socket.getPeerCertificate(true)?.raw
        if (!raw) return this.#fail(new Error("L'appareil n'a présenté aucun certificat."))
        const seen = createHash('sha256').update(raw).digest('hex')
        const pin = options.pin ? normaliseFingerprint(options.pin) : null
        if (pin && pin !== seen) return this.#fail(new CertificateMismatchError(seen, pin))
        if (!pin) options.onPin?.(seen)
        this.#upgrade(url, host, port, options.headers)
      })
      this.#socket = socket
    } else {
      const socket = tcpConnect({ host, port })
      socket.once('connect', () => this.#upgrade(url, host, port, options.headers))
      this.#socket = socket
    }
    this.#socket.setNoDelay(true)
    this.#socket.on('data', (chunk: Buffer) => this.#onData(chunk))
    this.#socket.on('error', (error: Error) => this.#fail(error))
    this.#socket.on('close', () => this.#finish())
  }

  send(data: string): void {
    if (this.#state !== 'open') return
    this.#write(OPCODE.text, Buffer.from(data, 'utf8'))
  }

  close(code = 1000, reason = ''): void {
    if (this.#state === 'connecting') {
      this.#closeEvent = { code: 1006, reason: '' }
      this.#socket.destroy()
      this.#finish()
      return
    }
    if (this.#state !== 'open') return
    this.#state = 'closing'
    this.#write(OPCODE.close, closeBody(code, reason))
    // The other side answers with its own close frame; one that never does is cut off.
    this.#closeTimer = setTimeout(() => this.#socket.destroy(), 1000)
  }

  #upgrade(url: URL, host: string, port: number, headers: Record<string, string> = {}): void {
    const clean = (value: string) => value.replace(/[\r\n]/g, '')
    const lines = [
      `GET ${url.pathname || '/'}${url.search} HTTP/1.1`,
      `Host: ${isIP(host) === 6 ? `[${host}]` : host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${this.#key}`,
      'Sec-WebSocket-Version: 13',
      ...Object.entries(headers).map(([name, value]) => `${clean(name)}: ${clean(value)}`),
    ]
    this.#socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  }

  #onData(chunk: Buffer): void {
    if (this.#state === 'closed') return
    if (this.#state !== 'connecting') return this.#frames(chunk)

    this.#handshake = Buffer.concat([this.#handshake, chunk])
    const end = this.#handshake.indexOf('\r\n\r\n')
    if (end < 0) {
      if (this.#handshake.length > MAX_HANDSHAKE_BYTES) this.#fail(new Error('Réponse de connexion trop longue.'))
      return
    }
    const [status = '', ...lines] = this.#handshake.subarray(0, end).toString('latin1').split('\r\n')
    const rest = this.#handshake.subarray(end + 4)
    this.#handshake = Buffer.alloc(0)
    if (!/^HTTP\/1\.[01] 101\b/.test(status)) return this.#fail(new Error(`Connexion WebSocket refusée : ${status}`))
    const accept = lines.find((line) => /^sec-websocket-accept\s*:/i.test(line))?.replace(/^[^:]*:/, '').trim()
    if (accept !== createHash('sha1').update(this.#key + HANDSHAKE_GUID).digest('base64')) return this.#fail(new Error('Réponse de connexion WebSocket invalide.'))

    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#state = 'open'
    this.onopen?.({ type: 'open' })
    if (rest.length > 0) this.#frames(rest)
  }

  #frames(chunk: Buffer): void {
    let events: FrameEvent[]
    try {
      events = this.#reader.push(chunk)
    } catch (error) {
      this.#write(OPCODE.close, closeBody(error instanceof WebSocketProtocolError ? error.code : 1002))
      return this.#fail(error as Error)
    }
    for (const event of events) {
      if (this.#state === 'closed' || this.#closeEvent) return
      switch (event.kind) {
        case 'text':
        case 'binary':
          if (this.#state === 'open') this.onmessage?.({ data: event.data })
          break
        case 'ping':
          this.#write(OPCODE.pong, event.data)
          break
        case 'pong':
          break
        case 'close':
          this.#closeEvent = { code: event.code, reason: event.reason }
          // Answer a close we did not start, echoing its code; then the TCP side ends.
          if (this.#state === 'open') this.#write(OPCODE.close, closeBody(event.code === 1005 ? null : event.code))
          this.#state = 'closing'
          this.#socket.end()
          break
      }
    }
  }

  #write(opcode: number, payload: Buffer): void {
    if (this.#socket.destroyed || !this.#socket.writable) return
    this.#socket.write(encodeFrame(opcode, payload, { mask: randomBytes(4) }))
  }

  #fail(error: Error): void {
    if (this.#state === 'closed') return
    if (!this.#errored) {
      this.#errored = true
      this.onerror?.({ type: 'error', error, message: error.message })
    }
    this.#closeEvent = { code: 1006, reason: '' }
    this.#socket.destroy()
    this.#finish()
  }

  #finish(): void {
    if (this.#state === 'closed') return
    const handshaking = this.#state === 'connecting'
    this.#state = 'closed'
    if (this.#timer) clearTimeout(this.#timer)
    if (this.#closeTimer) clearTimeout(this.#closeTimer)
    if (handshaking && !this.#errored) {
      this.#errored = true
      this.onerror?.({ type: 'error', error: new Error('Connexion fermée avant la fin de la négociation.') })
    }
    this.onclose?.(this.#closeEvent ?? { code: 1006, reason: '' })
  }
}

/** A WebSocket to `ws://` or `wss://`; for wss, the certificate is checked against `pin`. */
export function pinnedWebSocket(url: string, options: PinnedWebSocketOptions): SocketLike {
  return new PinnedWebSocket(new URL(url), options)
}
