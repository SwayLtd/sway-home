/**
 * Just enough DNS wire format to speak mDNS.
 *
 * Written by hand rather than pulled from a package: mDNS is a handful of record types
 * over UDP 5353, the parsing is 200 lines, and a dependency here would drag in a whole
 * multicast framework we would then have to fight for control of the socket. Everything
 * the scanner needs - PTR, SRV, TXT, A, AAAA, and name compression - is below.
 */

export const RECORD_TYPE = {
  A: 1,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  NSEC: 47,
  ANY: 255,
} as const

export type RecordType = (typeof RECORD_TYPE)[keyof typeof RECORD_TYPE]

export interface DnsQuestion {
  name: string
  type: number
  class: number
  unicastResponse: boolean
}

export interface DnsRecord {
  name: string
  type: number
  class: number
  ttl: number
  /** Decoded payload, shape depends on `type`. */
  data: string | string[] | SrvData | Record<string, string> | Uint8Array
}

export interface SrvData {
  priority: number
  weight: number
  port: number
  target: string
}

export interface DnsMessage {
  id: number
  flags: number
  questions: DnsQuestion[]
  answers: DnsRecord[]
  authorities: DnsRecord[]
  additionals: DnsRecord[]
}

// ---------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------

function encodeName(name: string): Uint8Array {
  const labels = name.replace(/\.$/, '').split('.')
  const parts: number[] = []
  for (const label of labels) {
    const bytes = new TextEncoder().encode(label)
    if (bytes.length > 63) throw new Error(`DNS label too long: ${label}`)
    parts.push(bytes.length, ...bytes)
  }
  parts.push(0)
  return new Uint8Array(parts)
}

/** One multicast query for several names at once; mDNS allows it and it halves the traffic. */
export function encodeQuery(names: { name: string; type: number }[], unicastResponse = false): Uint8Array {
  const header = new Uint8Array(12)
  const view = new DataView(header.buffer)
  view.setUint16(0, 0) // mDNS queries use id 0
  view.setUint16(2, 0) // standard query
  view.setUint16(4, names.length)
  view.setUint16(6, 0)
  view.setUint16(8, 0)
  view.setUint16(10, 0)

  const chunks: Uint8Array[] = [header]
  for (const { name, type } of names) {
    const encoded = encodeName(name)
    const tail = new Uint8Array(4)
    const tailView = new DataView(tail.buffer)
    tailView.setUint16(0, type)
    // Top bit of the class field is the unicast-response request (QU bit).
    tailView.setUint16(2, unicastResponse ? 0x8001 : 0x0001)
    chunks.push(encoded, tail)
  }

  return concat(chunks)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------

class Reader {
  offset = 0
  constructor(readonly bytes: Uint8Array, readonly view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)) {}

  u8(): number {
    return this.view.getUint8(this.offset++)
  }

  u16(): number {
    const value = this.view.getUint16(this.offset)
    this.offset += 2
    return value
  }

  u32(): number {
    const value = this.view.getUint32(this.offset)
    this.offset += 4
    return value
  }

  slice(length: number): Uint8Array {
    // subarray clamps silently, so a record that claims more bytes than the packet holds
    // would decode into a short value that looks valid - a four-byte A record read from
    // three bytes becomes the address "1.2.3". Refusing here makes the whole packet fail,
    // which is the correct outcome for something malformed arriving on multicast.
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new RangeError(`DNS record claims ${length} bytes, ${this.bytes.length - this.offset} remain`)
    }
    const value = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  /**
   * Names may be split across pointers into earlier parts of the message. A budget
   * prevents a malformed packet from looping forever - which is the classic way a
   * hand-written DNS parser becomes a denial of service on itself.
   */
  name(): string {
    const labels: string[] = []
    let jumped = false
    let cursor = this.offset
    let budget = 128

    while (budget-- > 0) {
      const length = this.view.getUint8(cursor)
      if (length === 0) {
        cursor += 1
        break
      }
      if ((length & 0xc0) === 0xc0) {
        const pointer = ((length & 0x3f) << 8) | this.view.getUint8(cursor + 1)
        if (!jumped) {
          this.offset = cursor + 2
          jumped = true
        }
        cursor = pointer
        continue
      }
      cursor += 1
      labels.push(new TextDecoder().decode(this.bytes.subarray(cursor, cursor + length)))
      cursor += length
    }

    if (!jumped) this.offset = cursor
    return labels.join('.')
  }
}

function decodeTxt(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  let offset = 0
  while (offset < bytes.length) {
    const length = bytes[offset]
    if (length === undefined || length === 0) break
    offset += 1
    const entry = new TextDecoder().decode(bytes.subarray(offset, offset + length))
    offset += length
    const eq = entry.indexOf('=')
    if (eq === -1) out[entry] = ''
    else out[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return out
}

function decodeRecord(reader: Reader): DnsRecord {
  const name = reader.name()
  const type = reader.u16()
  const klass = reader.u16()
  const ttl = reader.u32()
  const length = reader.u16()
  const end = reader.offset + length
  if (end > reader.bytes.length) {
    throw new RangeError(`DNS record length ${length} runs past the end of the packet`)
  }

  let data: DnsRecord['data']
  switch (type) {
    case RECORD_TYPE.A: {
      const bytes = reader.slice(4)
      data = Array.from(bytes).join('.')
      break
    }
    case RECORD_TYPE.AAAA: {
      const bytes = reader.slice(16)
      const groups: string[] = []
      for (let i = 0; i < 16; i += 2) {
        groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16))
      }
      data = groups.join(':').replace(/(^|:)(0(:0)+)(:|$)/, '::')
      break
    }
    case RECORD_TYPE.PTR:
      data = reader.name()
      break
    case RECORD_TYPE.TXT:
      data = decodeTxt(reader.slice(length))
      break
    case RECORD_TYPE.SRV: {
      const priority = reader.u16()
      const weight = reader.u16()
      const port = reader.u16()
      const target = reader.name()
      data = { priority, weight, port, target } satisfies SrvData
      break
    }
    default:
      data = reader.slice(length)
  }

  // Skip anything the record declared but we did not consume.
  reader.offset = end
  return { name, type, class: klass, ttl, data }
}

export function decodeMessage(bytes: Uint8Array): DnsMessage | null {
  if (bytes.length < 12) return null
  try {
    const reader = new Reader(bytes)
    const id = reader.u16()
    const flags = reader.u16()
    const qdCount = reader.u16()
    const anCount = reader.u16()
    const nsCount = reader.u16()
    const arCount = reader.u16()

    const questions: DnsQuestion[] = []
    for (let i = 0; i < qdCount; i += 1) {
      const name = reader.name()
      const type = reader.u16()
      const klass = reader.u16()
      questions.push({ name, type, class: klass & 0x7fff, unicastResponse: (klass & 0x8000) !== 0 })
    }

    const read = (count: number) => {
      const records: DnsRecord[] = []
      for (let i = 0; i < count; i += 1) records.push(decodeRecord(reader))
      return records
    }

    return {
      id,
      flags,
      questions,
      answers: read(anCount),
      authorities: read(nsCount),
      additionals: read(arCount),
    }
  } catch {
    // A truncated or malformed multicast packet is normal on a busy network; drop it.
    return null
  }
}
