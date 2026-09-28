/**
 * The hand-written DNS wire codec.
 *
 * This parser reads packets from whatever is on the local network, which means it reads
 * untrusted input by definition. The tests therefore cover two things in equal measure: that
 * it decodes real mDNS responses correctly, and that malformed or hostile packets make it
 * return null rather than loop, throw, or read out of bounds.
 */

import { describe, expect, test } from 'bun:test'
import { RECORD_TYPE, decodeMessage, encodeQuery } from '../src/dns-wire.ts'

/** Builds a DNS name in wire format: length-prefixed labels, terminated by a zero byte. */
function name(value: string): number[] {
  const out: number[] = []
  for (const label of value.split('.')) {
    out.push(label.length, ...[...label].map((c) => c.charCodeAt(0)))
  }
  out.push(0)
  return out
}

function header(counts: { questions?: number; answers?: number; authority?: number; additional?: number; flags?: number } = {}): number[] {
  const flags = counts.flags ?? 0x8400
  return [
    0, 0,
    (flags >> 8) & 0xff, flags & 0xff,
    0, counts.questions ?? 0,
    0, counts.answers ?? 0,
    0, counts.authority ?? 0,
    0, counts.additional ?? 0,
  ]
}

describe('encodeQuery', () => {
  test('writes a well-formed header with the question count', () => {
    const packet = encodeQuery([{ name: '_hap._tcp.local', type: RECORD_TYPE.PTR }])
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
    expect(view.getUint16(0)).toBe(0) // mDNS uses id 0
    expect(view.getUint16(4)).toBe(1) // one question
    expect(view.getUint16(6)).toBe(0) // no answers
  })

  test('encodes each label with its length prefix and a terminating zero', () => {
    const packet = encodeQuery([{ name: 'ab.cd', type: RECORD_TYPE.PTR }])
    const body = Array.from(packet.subarray(12))
    expect(body.slice(0, 7)).toEqual([2, 0x61, 0x62, 2, 0x63, 0x64, 0])
  })

  test('sets class IN, and the QU bit only when unicast is asked for', () => {
    const multicast = encodeQuery([{ name: 'x.local', type: RECORD_TYPE.PTR }], false)
    const unicast = encodeQuery([{ name: 'x.local', type: RECORD_TYPE.PTR }], true)
    const readClass = (packet: Uint8Array) => {
      const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
      return view.getUint16(packet.length - 2)
    }
    expect(readClass(multicast)).toBe(0x0001)
    expect(readClass(unicast)).toBe(0x8001)
  })

  test('packs several questions into one packet, which is how a browse is batched', () => {
    const packet = encodeQuery([
      { name: '_hap._tcp.local', type: RECORD_TYPE.PTR },
      { name: '_matter._tcp.local', type: RECORD_TYPE.PTR },
      { name: '_googlecast._tcp.local', type: RECORD_TYPE.PTR },
    ])
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
    expect(view.getUint16(4)).toBe(3)
  })

  test('an empty question list still produces a valid header', () => {
    const packet = encodeQuery([])
    expect(packet.length).toBe(12)
  })
})

describe('decodeMessage', () => {
  test('reads an A record and its address', () => {
    const packet = new Uint8Array([
      ...header({ answers: 1 }),
      ...name('shelly.local'),
      0, RECORD_TYPE.A,
      0x80, 0x01, // class IN, cache-flush bit set as real devices do
      0, 0, 0, 120,
      0, 4,
      192, 168, 1, 42,
    ])
    const message = decodeMessage(packet)
    expect(message).not.toBeNull()
    expect(message!.answers[0]).toMatchObject({ name: 'shelly.local', type: RECORD_TYPE.A, data: '192.168.1.42' })
  })

  test('reads a PTR record pointing at an instance name', () => {
    const packet = new Uint8Array([
      ...header({ answers: 1 }),
      ...name('_googlecast._tcp.local'),
      0, RECORD_TYPE.PTR,
      0, 1,
      0, 0, 0, 120,
      0, name('Salon._googlecast._tcp.local').length,
      ...name('Salon._googlecast._tcp.local'),
    ])
    const message = decodeMessage(packet)
    expect(message!.answers[0]!.data).toBe('Salon._googlecast._tcp.local')
  })

  test('reads an SRV record with its port', () => {
    const target = name('device.local')
    const packet = new Uint8Array([
      ...header({ answers: 1 }),
      ...name('x._hap._tcp.local'),
      0, RECORD_TYPE.SRV,
      0, 1,
      0, 0, 0, 120,
      0, 6 + target.length,
      0, 0, // priority
      0, 0, // weight
      0x1f, 0x90, // port 8080
      ...target,
    ])
    const message = decodeMessage(packet)
    expect(message!.answers[0]!.data).toMatchObject({ port: 8080, target: 'device.local' })
  })

  test('reads a TXT record as key/value pairs', () => {
    const txt = (...entries: string[]) => entries.flatMap((entry) => [entry.length, ...[...entry].map((c) => c.charCodeAt(0))])
    const body = txt('md=Shelly1', 'fw=1.14', 'standalone')
    const packet = new Uint8Array([
      ...header({ answers: 1 }),
      ...name('x._http._tcp.local'),
      0, RECORD_TYPE.TXT,
      0, 1,
      0, 0, 0, 120,
      0, body.length,
      ...body,
    ])
    const message = decodeMessage(packet)
    const data = message!.answers[0]!.data as Record<string, string>
    expect(data.md).toBe('Shelly1')
    expect(data.fw).toBe('1.14')
    // A bare key with no '=' is a flag; it must not be dropped or crash the parser.
    expect('standalone' in data).toBe(true)
  })

  test('follows a compression pointer back to an earlier name', () => {
    // The second record's name is a pointer to offset 12, where the first name starts.
    const first = name('device.local')
    const packet = new Uint8Array([
      ...header({ answers: 2 }),
      ...first,
      0, RECORD_TYPE.A, 0, 1, 0, 0, 0, 120, 0, 4, 10, 0, 0, 1,
      0xc0, 12, // pointer to offset 12
      0, RECORD_TYPE.A, 0, 1, 0, 0, 0, 120, 0, 4, 10, 0, 0, 2,
    ])
    const message = decodeMessage(packet)
    expect(message!.answers).toHaveLength(2)
    expect(message!.answers[1]!.name).toBe('device.local')
    expect(message!.answers[1]!.data).toBe('10.0.0.2')
  })

  test('a pointer loop returns rather than hanging', () => {
    // A packet whose name points at itself. Without a jump budget this spins forever, which
    // is how a hand-written DNS parser becomes a denial of service on its own hub.
    const packet = new Uint8Array([...header({ answers: 1 }), 0xc0, 12, 0, RECORD_TYPE.A, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, 4])
    const start = performance.now()
    const message = decodeMessage(packet)
    expect(performance.now() - start).toBeLessThan(1000)
    // Either it refuses the packet or it resolves the name to something finite; what it must
    // never do is loop.
    if (message) expect(typeof message.answers[0]?.name).toBe('string')
  })

  test('a truncated packet returns null instead of throwing', () => {
    const packet = new Uint8Array([...header({ answers: 1 }), ...name('x.local'), 0, RECORD_TYPE.A])
    expect(decodeMessage(packet)).toBeNull()
  })

  test('a packet shorter than a header returns null', () => {
    expect(decodeMessage(new Uint8Array([0, 0, 0]))).toBeNull()
    expect(decodeMessage(new Uint8Array([]))).toBeNull()
  })

  test('a record whose length runs past the end of the buffer returns null', () => {
    const packet = new Uint8Array([
      ...header({ answers: 1 }),
      ...name('x.local'),
      0, RECORD_TYPE.A,
      0, 1,
      0, 0, 0, 120,
      0xff, 0xff, // claims 65535 bytes of payload
      1, 2, 3,
    ])
    expect(decodeMessage(packet)).toBeNull()
  })

  test('an answer count larger than the records present returns null', () => {
    const packet = new Uint8Array([
      ...header({ answers: 40 }),
      ...name('x.local'),
      0, RECORD_TYPE.A, 0, 1, 0, 0, 0, 120, 0, 4, 1, 2, 3, 4,
    ])
    expect(decodeMessage(packet)).toBeNull()
  })

  test('random bytes never throw', () => {
    // Anything on a home network can send to 224.0.0.251:5353, including things that are
    // not mDNS at all.
    for (let seed = 0; seed < 200; seed += 1) {
      const bytes = new Uint8Array(40)
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = (seed * 31 + index * 17) % 256
      expect(() => decodeMessage(bytes)).not.toThrow()
    }
  })

  test('a query and its questions survive a round trip', () => {
    const encoded = encodeQuery([{ name: '_matter._tcp.local', type: RECORD_TYPE.PTR }])
    const decoded = decodeMessage(encoded)
    expect(decoded).not.toBeNull()
    expect(decoded!.questions[0]).toMatchObject({ name: '_matter._tcp.local', type: RECORD_TYPE.PTR })
  })
})
