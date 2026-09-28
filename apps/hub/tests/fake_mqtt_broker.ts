/**
 * A small MQTT 3.1.1 broker for tests, on a real TCP socket.
 *
 * It speaks the wire format the hub's hand-written client speaks - CONNECT/CONNACK,
 * SUBSCRIBE/SUBACK with `+` and `#` filters, PUBLISH with retained messages, PINGREQ,
 * DISCONNECT - so adapter tests exercise the client exactly as a Mosquitto would, and the
 * client itself finally has something to be tested against.
 * Spec: https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html
 */

import net from 'node:net'

interface Session {
  socket: net.Socket
  buffer: Buffer
  filters: string[]
  clientId: string | null
}

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

function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  const header = Buffer.alloc(2)
  header.writeUInt16BE(bytes.length, 0)
  return Buffer.concat([header, bytes])
}

/** MQTT topic filter matching: `+` is one level, `#` is the rest. */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/')
  const t = topic.split('/')
  for (let index = 0; index < f.length; index += 1) {
    if (f[index] === '#') return true
    if (index >= t.length) return false
    if (f[index] !== '+' && f[index] !== t[index]) return false
  }
  return f.length === t.length
}

export class FakeMqttBroker {
  /** Every PUBLISH a client sent, in order. */
  published: { topic: string; payload: string; retain: boolean; clientId: string | null }[] = []
  connects: { clientId: string; username: string | null; password: string | null }[] = []
  /** When set, CONNECT is answered with this return code (5 = not authorised). */
  refuseWith: number | null = null
  #server: net.Server | null = null
  #sessions = new Set<Session>()
  #retained = new Map<string, string>()
  /** Called for every client PUBLISH, so a test can play the device on the other side. */
  onPublish: (topic: string, payload: string) => void = () => undefined

  async start(): Promise<number> {
    this.#server = net.createServer((socket) => {
      const session: Session = { socket, buffer: Buffer.alloc(0), filters: [], clientId: null }
      this.#sessions.add(session)
      socket.on('data', (chunk) => {
        session.buffer = Buffer.concat([session.buffer, chunk])
        this.#drain(session)
      })
      socket.on('close', () => this.#sessions.delete(session))
      socket.on('error', () => this.#sessions.delete(session))
    })
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve))
    return (this.#server!.address() as net.AddressInfo).port
  }

  async stop(): Promise<void> {
    for (const session of this.#sessions) session.socket.destroy()
    this.#sessions.clear()
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()))
  }

  /** Drops every client, the way a broker restart does. */
  kick(): void {
    for (const session of this.#sessions) session.socket.destroy()
    this.#sessions.clear()
  }

  get clients(): number {
    return this.#sessions.size
  }

  /** Publishes from "another client" - zigbee2mqtt, a device - to every matching subscriber. */
  publish(topic: string, payload: string | object, options: { retain?: boolean } = {}): void {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    if (options.retain) this.#retained.set(topic, text)
    for (const session of this.#sessions) {
      if (session.filters.some((filter) => topicMatches(filter, topic))) this.#deliver(session, topic, text, false)
    }
  }

  #deliver(session: Session, topic: string, payload: string, retained: boolean): void {
    const body = Buffer.concat([encodeString(topic), Buffer.from(payload, 'utf8')])
    session.socket.write(Buffer.concat([Buffer.from([(3 << 4) | (retained ? 1 : 0)]), encodeLength(body.length), body]))
  }

  #drain(session: Session): void {
    for (;;) {
      if (session.buffer.length < 2) return
      let length = 0
      let multiplier = 1
      let bytes = 0
      for (;;) {
        if (1 + bytes >= session.buffer.length) return
        const byte = session.buffer[1 + bytes]!
        bytes += 1
        length += (byte & 0x7f) * multiplier
        if ((byte & 0x80) === 0) break
        multiplier *= 128
      }
      const total = 1 + bytes + length
      if (session.buffer.length < total) return
      const first = session.buffer[0]!
      const body = session.buffer.subarray(1 + bytes, total)
      session.buffer = session.buffer.subarray(total)
      this.#packet(session, first >> 4, first & 0x0f, body)
    }
  }

  #packet(session: Session, type: number, flags: number, body: Buffer): void {
    switch (type) {
      case 1: {
        // CONNECT: protocol name, level, flags, keep-alive, then client id [, username, password].
        let offset = 2 + body.readUInt16BE(0)
        const connectFlags = body[offset + 1]!
        offset += 4
        const read = () => {
          const size = body.readUInt16BE(offset)
          const value = body.subarray(offset + 2, offset + 2 + size).toString('utf8')
          offset += 2 + size
          return value
        }
        const clientId = read()
        const username = connectFlags & 0x80 ? read() : null
        const password = connectFlags & 0x40 ? read() : null
        session.clientId = clientId
        this.connects.push({ clientId, username, password })
        session.socket.write(Buffer.from([0x20, 0x02, 0x00, this.refuseWith ?? 0]))
        if (this.refuseWith) session.socket.end()
        return
      }
      case 3: {
        const qos = (flags >> 1) & 0x03
        const size = body.readUInt16BE(0)
        const topic = body.subarray(2, 2 + size).toString('utf8')
        let offset = 2 + size
        if (qos > 0) {
          const id = body.readUInt16BE(offset)
          offset += 2
          session.socket.write(Buffer.from([0x40, 0x02, id >> 8, id & 0xff]))
        }
        const payload = body.subarray(offset).toString('utf8')
        const retain = (flags & 0x01) === 1
        this.published.push({ topic, payload, retain, clientId: session.clientId })
        this.publish(topic, payload, { retain })
        this.onPublish(topic, payload)
        return
      }
      case 8: {
        const id = body.readUInt16BE(0)
        let offset = 2
        const added: string[] = []
        while (offset < body.length) {
          const size = body.readUInt16BE(offset)
          added.push(body.subarray(offset + 2, offset + 2 + size).toString('utf8'))
          offset += 2 + size + 1
        }
        session.filters.push(...added)
        session.socket.write(Buffer.concat([Buffer.from([0x90]), encodeLength(2 + added.length), Buffer.from([id >> 8, id & 0xff, ...added.map(() => 0)])]))
        // Retained messages follow the SUBACK, one per matching topic, flagged as retained.
        for (const filter of added) {
          for (const [topic, payload] of this.#retained) if (topicMatches(filter, topic)) this.#deliver(session, topic, payload, true)
        }
        return
      }
      case 12:
        session.socket.write(Buffer.from([0xd0, 0x00]))
        return
      case 14:
        session.socket.end()
        return
    }
  }
}
