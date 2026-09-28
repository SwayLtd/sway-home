/**
 * The cryptography of the HomeKit Accessory Protocol, controller side.
 *
 *  - **ChaCha20-Poly1305** (RFC 8439): every pairing message and every byte of a paired
 *    session is sealed with it. Bun has no implementation of it (oven-sh/bun#8072), so it is
 *    written here, block function, one-time key and MAC, from the RFC.
 *  - **SRP-6a** (RFC 5054, 3072-bit group, SHA-512): how the setup code proves itself without
 *    ever crossing the network. HomeKit's variant pads A, B and S to the modulus size and uses
 *    k = H(N | PAD(g)); it is checked against fast-srp-hap, the server HAP-NodeJS runs.
 *  - **TLV8**: the pairing messages' format - type, length, value, values over 255 bytes cut
 *    into fragments of the same type.
 *  - **The session framing**: after pair-verify, HTTP travels in frames of at most 1024 bytes,
 *    each [length (2 bytes, little-endian)][sealed data][16-byte tag], the length serving as
 *    additional data and a per-direction counter as nonce.
 *
 * Ed25519, X25519, SHA-512 and HKDF come from the runtime; only what it lacks is here.
 */

import { createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

// ---------------------------------------------------------------------------------------
// ChaCha20-Poly1305 (RFC 8439)
// ---------------------------------------------------------------------------------------

const rotate = (value: number, bits: number) => ((value << bits) | (value >>> (32 - bits))) >>> 0

function quarterRound(state: Uint32Array, a: number, b: number, c: number, d: number): void {
  state[a] = (state[a]! + state[b]!) >>> 0
  state[d] = rotate(state[d]! ^ state[a]!, 16)
  state[c] = (state[c]! + state[d]!) >>> 0
  state[b] = rotate(state[b]! ^ state[c]!, 12)
  state[a] = (state[a]! + state[b]!) >>> 0
  state[d] = rotate(state[d]! ^ state[a]!, 8)
  state[c] = (state[c]! + state[d]!) >>> 0
  state[b] = rotate(state[b]! ^ state[c]!, 7)
}

/** The ChaCha20 block function (RFC 8439 2.3): 64 bytes of key stream. */
function chachaBlock(key: Buffer, counter: number, nonce: Buffer): Buffer {
  const initial = new Uint32Array(16)
  initial[0] = 0x61707865
  initial[1] = 0x3320646e
  initial[2] = 0x79622d32
  initial[3] = 0x6b206574
  for (let index = 0; index < 8; index++) initial[4 + index] = key.readUInt32LE(index * 4)
  initial[12] = counter >>> 0
  for (let index = 0; index < 3; index++) initial[13 + index] = nonce.readUInt32LE(index * 4)
  const state = new Uint32Array(initial)
  for (let round = 0; round < 10; round++) {
    quarterRound(state, 0, 4, 8, 12)
    quarterRound(state, 1, 5, 9, 13)
    quarterRound(state, 2, 6, 10, 14)
    quarterRound(state, 3, 7, 11, 15)
    quarterRound(state, 0, 5, 10, 15)
    quarterRound(state, 1, 6, 11, 12)
    quarterRound(state, 2, 7, 8, 13)
    quarterRound(state, 3, 4, 9, 14)
  }
  const out = Buffer.alloc(64)
  for (let index = 0; index < 16; index++) out.writeUInt32LE((state[index]! + initial[index]!) >>> 0, index * 4)
  return out
}

/** ChaCha20 encryption (RFC 8439 2.4): the data XORed with the key stream from `counter`. */
export function chacha20(key: Buffer, nonce: Buffer, counter: number, data: Buffer): Buffer {
  if (key.length !== 32 || nonce.length !== 12) throw new Error('ChaCha20 wants a 32-byte key and a 12-byte nonce')
  const out = Buffer.alloc(data.length)
  for (let offset = 0, block = counter; offset < data.length; offset += 64, block++) {
    const stream = chachaBlock(key, block, nonce)
    const end = Math.min(offset + 64, data.length)
    for (let index = offset; index < end; index++) out[index] = data[index]! ^ stream[index - offset]!
  }
  return out
}

const P1305 = (1n << 130n) - 5n
const CLAMP = 0x0ffffffc0ffffffc0ffffffc0fffffffn

function littleEndian(bytes: Buffer): bigint {
  let value = 0n
  for (let index = bytes.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[index]!)
  return value
}

/** Poly1305 (RFC 8439 2.5): a 16-byte tag for a message under a one-time key. */
export function poly1305(key: Buffer, message: Buffer): Buffer {
  const r = littleEndian(key.subarray(0, 16)) & CLAMP
  const s = littleEndian(key.subarray(16, 32))
  let accumulator = 0n
  for (let offset = 0; offset < message.length; offset += 16) {
    const block = message.subarray(offset, Math.min(offset + 16, message.length))
    const n = littleEndian(block) + (1n << BigInt(8 * block.length))
    accumulator = ((accumulator + n) * r) % P1305
  }
  let tag = (accumulator + s) & ((1n << 128n) - 1n)
  const out = Buffer.alloc(16)
  for (let index = 0; index < 16; index++) {
    out[index] = Number(tag & 0xffn)
    tag >>= 8n
  }
  return out
}

const pad16 = (length: number) => Buffer.alloc((16 - (length % 16)) % 16)

function aeadTag(key: Buffer, nonce: Buffer, ciphertext: Buffer, aad: Buffer): Buffer {
  const oneTimeKey = chachaBlock(key, 0, nonce).subarray(0, 32)
  const lengths = Buffer.alloc(16)
  lengths.writeBigUInt64LE(BigInt(aad.length), 0)
  lengths.writeBigUInt64LE(BigInt(ciphertext.length), 8)
  return poly1305(oneTimeKey, Buffer.concat([aad, pad16(aad.length), ciphertext, pad16(ciphertext.length), lengths]))
}

/** AEAD_CHACHA20_POLY1305 (RFC 8439 2.8): the ciphertext followed by its 16-byte tag. */
export function seal(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer = Buffer.alloc(0)): Buffer {
  const ciphertext = chacha20(key, nonce, 1, plaintext)
  return Buffer.concat([ciphertext, aeadTag(key, nonce, ciphertext, aad)])
}

/** The plaintext, or null when the data or the additional data was not what was sealed. */
export function open(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer = Buffer.alloc(0)): Buffer | null {
  if (sealed.length < 16) return null
  const ciphertext = sealed.subarray(0, sealed.length - 16)
  const tag = sealed.subarray(sealed.length - 16)
  if (!timingSafeEqual(tag, aeadTag(key, nonce, ciphertext, aad))) return null
  return chacha20(key, nonce, 1, ciphertext)
}

/** Pairing messages: four zero bytes, then the message's 8-character label ("PS-Msg05"). */
export function hapNonce(label: string): Buffer {
  return Buffer.concat([Buffer.alloc(4), Buffer.from(label, 'ascii')])
}

/** Session frames: four zero bytes, then the frame counter as 64-bit little-endian. */
export function counterNonce(counter: number | bigint): Buffer {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64LE(BigInt(counter), 4)
  return nonce
}

export function hkdf(ikm: Buffer, salt: string, info: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha512', ikm, Buffer.from(salt), Buffer.from(info), length))
}

// ---------------------------------------------------------------------------------------
// SRP-6a (RFC 5054), HomeKit's way
// ---------------------------------------------------------------------------------------

const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF'
const N = BigInt(`0x${N_HEX}`)
const G = 5n
const LENGTH = 384

const sha512 = (...parts: Buffer[]) => createHash('sha512').update(Buffer.concat(parts)).digest()

function toBytes(value: bigint, length = LENGTH): Buffer {
  const hex = value.toString(16).padStart(length * 2, '0')
  return Buffer.from(hex.length > length * 2 ? hex.slice(-length * 2) : hex, 'hex')
}

const toBigInt = (bytes: Buffer) => (bytes.length === 0 ? 0n : BigInt(`0x${bytes.toString('hex')}`))

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let square = ((base % modulus) + modulus) % modulus
  let rest = exponent
  while (rest > 0n) {
    if (rest & 1n) result = (result * square) % modulus
    square = (square * square) % modulus
    rest >>= 1n
  }
  return result
}

/** k = H(N | PAD(g)): fixed for the group, the same for every HomeKit controller. */
export const SRP_K = toBigInt(sha512(toBytes(N), toBytes(G)))
/** H(N) xor H(g), with g hashed as its single byte, as HomeKit does. */
const H_GROUP = (() => {
  const n = sha512(toBytes(N))
  const g = sha512(Buffer.from([5]))
  return Buffer.from(n.map((byte, index) => byte ^ g[index]!))
})()

export class SrpClient {
  readonly #username: string
  readonly #password: string
  readonly #a: bigint
  readonly #A: Buffer
  #salt: Buffer | null = null
  #B: Buffer | null = null
  #K: Buffer | null = null
  #M1: Buffer | null = null

  constructor(username: string, password: string, privateKey: Buffer = randomBytes(32)) {
    this.#username = username
    this.#password = password
    this.#a = toBigInt(privateKey)
    this.#A = toBytes(modPow(G, this.#a, N))
  }

  get publicKey(): Buffer {
    return this.#A
  }

  setSalt(salt: Buffer): void {
    this.#salt = Buffer.from(salt)
  }

  setServerPublicKey(key: Buffer): void {
    const B = toBigInt(key)
    if (B % N === 0n) throw new Error("clé publique de l'accessoire invalide")
    this.#B = toBytes(B)
    this.#K = null
    this.#M1 = null
  }

  /** K = H(PAD(S)), the key both ends derive without ever sending it. */
  get sessionKey(): Buffer {
    if (this.#K) return this.#K
    if (!this.#salt || !this.#B) throw new Error('SRP: salt and server key first')
    const u = toBigInt(sha512(this.#A, this.#B))
    if (u === 0n) throw new Error("clé publique de l'accessoire invalide")
    const x = toBigInt(sha512(this.#salt, sha512(Buffer.from(`${this.#username}:${this.#password}`))))
    const v = modPow(G, x, N)
    const base = (((toBigInt(this.#B) - SRP_K * v) % N) + N) % N
    const S = modPow(base, this.#a + u * x, N)
    this.#K = sha512(toBytes(S))
    return this.#K
  }

  /** M1 = H(H(N) xor H(g), H(I), s, A, B, K): the client's proof. */
  get proof(): Buffer {
    if (this.#M1) return this.#M1
    this.#M1 = sha512(H_GROUP, sha512(Buffer.from(this.#username)), this.#salt!, this.#A, this.#B!, this.sessionKey)
    return this.#M1
  }

  /** M2 = H(A, M1, K): the accessory knew the code too. */
  verifyServerProof(proof: Buffer): boolean {
    const expected = sha512(this.#A, this.proof, this.sessionKey)
    return proof.length === expected.length && timingSafeEqual(proof, expected)
  }
}

// ---------------------------------------------------------------------------------------
// TLV8
// ---------------------------------------------------------------------------------------

export type TlvValue = Buffer | number | string

export function tlvEncode(items: [type: number, value: TlvValue][]): Buffer {
  const parts: Buffer[] = []
  for (const [type, raw] of items) {
    const value = typeof raw === 'number' ? Buffer.from([raw]) : typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw
    if (value.length === 0) {
      parts.push(Buffer.from([type, 0]))
      continue
    }
    for (let offset = 0; offset < value.length; offset += 255) {
      const chunk = value.subarray(offset, offset + 255)
      parts.push(Buffer.from([type, chunk.length]), chunk)
    }
  }
  return Buffer.concat(parts)
}

/** Items by type; a fragment of 255 bytes continues into the next item of the same type. */
export function tlvDecode(data: Buffer): Map<number, Buffer> {
  const items = new Map<number, Buffer>()
  let previous: { type: number; length: number } | null = null
  for (let offset = 0; offset + 2 <= data.length; ) {
    const type = data[offset]!
    const length = data[offset + 1]!
    const value = data.subarray(offset + 2, offset + 2 + length)
    offset += 2 + length
    if (previous && previous.type === type && previous.length === 255) items.set(type, Buffer.concat([items.get(type)!, value]))
    else items.set(type, Buffer.from(value))
    previous = { type, length }
  }
  return items
}

// ---------------------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------------------

/** One end of a paired session: seals what it sends, opens what it receives, in order. */
export class HapSession {
  readonly #writeKey: Buffer
  readonly #readKey: Buffer
  #writeCounter = 0n
  #readCounter = 0n
  #pending = Buffer.alloc(0)

  constructor(writeKey: Buffer, readKey: Buffer) {
    this.#writeKey = writeKey
    this.#readKey = readKey
  }

  encrypt(payload: Buffer): Buffer {
    const frames: Buffer[] = []
    for (let offset = 0; offset < payload.length || (offset === 0 && payload.length === 0); offset += 1024) {
      const chunk = payload.subarray(offset, offset + 1024)
      const length = Buffer.alloc(2)
      length.writeUInt16LE(chunk.length)
      frames.push(length, seal(this.#writeKey, counterNonce(this.#writeCounter++), chunk, length))
      if (payload.length === 0) break
    }
    return Buffer.concat(frames)
  }

  /** What the frames received so far carry; an incomplete frame waits for the rest. */
  decrypt(data: Buffer): Buffer {
    this.#pending = this.#pending.length === 0 ? Buffer.from(data) : Buffer.concat([this.#pending, data])
    const out: Buffer[] = []
    while (this.#pending.length >= 2) {
      const length = this.#pending.readUInt16LE(0)
      if (this.#pending.length < 2 + length + 16) break
      const aad = this.#pending.subarray(0, 2)
      const plain = open(this.#readKey, counterNonce(this.#readCounter), this.#pending.subarray(2, 2 + length + 16), aad)
      if (!plain) throw new Error('trame HomeKit altérée ou hors séquence')
      this.#readCounter++
      out.push(plain)
      this.#pending = this.#pending.subarray(2 + length + 16)
    }
    return Buffer.concat(out)
  }
}
