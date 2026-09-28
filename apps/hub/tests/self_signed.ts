/**
 * A self-signed certificate made on the spot, for tests that need a TLS server.
 *
 * TVs and boxes on a LAN serve certificates they signed themselves; tests reproduce that with
 * a fresh P-256 key and a minimal X.509 v3 certificate encoded by hand, so no fixture key is
 * checked in and no `openssl` binary is needed.
 */

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

function der(tag: number, content: Buffer): Buffer {
  const length = content.length
  const header =
    length < 0x80
      ? [tag, length]
      : length < 0x100
        ? [tag, 0x81, length]
        : length < 0x10000
          ? [tag, 0x82, length >> 8, length & 0xff]
          : [tag, 0x83, length >> 16, (length >> 8) & 0xff, length & 0xff]
  return Buffer.concat([Buffer.from(header), content])
}

const sequence = (...items: Buffer[]) => der(0x30, Buffer.concat(items))
const set = (...items: Buffer[]) => der(0x31, Buffer.concat(items))
const integer = (value: Buffer) => der(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value)
const utf8 = (text: string) => der(0x0c, Buffer.from(text, 'utf8'))

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number)
  const bytes = [parts[0]! * 40 + parts[1]!]
  for (const part of parts.slice(2)) {
    const chunk: number[] = []
    let value = part
    do {
      chunk.unshift(value & 0x7f)
      value = Math.floor(value / 128)
    } while (value > 0)
    for (let index = 0; index < chunk.length - 1; index++) chunk[index]! |= 0x80
    bytes.push(...chunk)
  }
  return der(0x06, Buffer.from(bytes))
}

function time(date: Date): Buffer {
  const digits = `${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`
  return date.getUTCFullYear() >= 2050 ? der(0x18, Buffer.from(digits)) : der(0x17, Buffer.from(digits.slice(2)))
}

export interface SelfSigned {
  cert: string
  key: string
  /** SHA-256 of the DER certificate, lowercase hex: what a client pins. */
  fingerprint: string
}

/** A subjectAltName extension: DNS names, and IPv4 addresses written as such. */
function altNames(names: string[]): Buffer {
  const entries = names.map((name) =>
    /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ? der(0x87, Buffer.from(name.split('.').map(Number))) : der(0x82, Buffer.from(name, 'ascii'))
  )
  return der(0xa3, sequence(sequence(oid('2.5.29.17'), der(0x04, sequence(...entries)))))
}

/**
 * `altNames` makes the certificate valid for those names under full verification: a client
 * given it as its certificate authority then accepts the server, as it would a box signed by
 * its maker's own authority.
 */
export function selfSignedCertificate(commonName = 'LG webOS TV', options: { altNames?: string[] } = {}): SelfSigned {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const algorithm = sequence(oid('1.2.840.10045.4.3.2'))
  const name = sequence(set(sequence(oid('2.5.4.3'), utf8(commonName))))
  const serial = randomBytes(8)
  serial[0]! &= 0x7f
  const now = Date.now()
  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    sequence(time(new Date(now - 86_400_000)), time(new Date(now + 3650 * 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    ...(options.altNames?.length ? [altNames(options.altNames)] : [])
  )
  const signature = sign('sha256', tbs, privateKey)
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])))
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    fingerprint: createHash('sha256').update(certificate).digest('hex'),
  }
}
