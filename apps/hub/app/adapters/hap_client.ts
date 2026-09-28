/**
 * The HomeKit Accessory Protocol over IP, controller side: pairing, then an encrypted HTTP
 * session with the accessory.
 *
 *  - **Pair setup** (HAP 5.6): SRP with the setup code proves both ends know it; then each
 *    signs its long-term Ed25519 key for the other. The accessory keeps the hub's key, the hub
 *    keeps the accessory's: that is the pairing, and the code is never needed again.
 *  - **Pair verify** (HAP 5.7): at every connection, an X25519 exchange signed with those
 *    long-term keys gives the session keys; from then on every byte travels in sealed frames
 *    (see `HapSession`).
 *  - **The session** is HTTP/1.1, one request at a time, answers in order, with the
 *    accessory's own "EVENT/1.0" messages slipped in between when a subscribed characteristic
 *    changes.
 *
 * Messages follow aiohomekit, the controller Home Assistant uses, step for step.
 */

import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { HapSession, hapNonce, hkdf, open, seal, SrpClient, tlvDecode, tlvEncode } from '#adapters/hap_crypto'

/** TLV types (HAP table 5-6). */
const T = { method: 0, identifier: 1, salt: 2, publicKey: 3, proof: 4, encryptedData: 5, state: 6, error: 7, retryDelay: 8, signature: 10 } as const
const METHOD = { pairSetup: 0, removePairing: 4 } as const

/** The hub as a HomeKit controller: one identity, shared by every accessory it pairs with. */
export interface ControllerIdentity {
  id: string
  /** Ed25519 seed and public key, raw. */
  privateKey: Buffer
  publicKey: Buffer
}

export interface AccessoryKeys {
  accessoryId: string
  /** The accessory's long-term Ed25519 public key. */
  accessoryKey: Buffer
}

export function newControllerIdentity(): ControllerIdentity {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string }
  return { id: randomUUID().toUpperCase(), privateKey: Buffer.from(jwk.d, 'base64url'), publicKey: Buffer.from(jwk.x, 'base64url') }
}

function signingKey(identity: ControllerIdentity): KeyObject {
  return createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: identity.privateKey.toString('base64url'), x: identity.publicKey.toString('base64url') }, format: 'jwk' })
}

function verifyingKey(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
}

export class HapError extends Error {
  constructor(
    message: string,
    readonly code: 'authentication' | 'backoff' | 'max-peers' | 'max-tries' | 'unavailable' | 'busy' | 'protocol' | 'network'
  ) {
    super(message)
  }
}

const TLV_ERRORS: Record<number, [HapError['code'], string]> = {
  1: ['protocol', "l'accessoire a refusé la demande"],
  2: ['authentication', "l'accessoire refuse ce code"],
  3: ['backoff', "l'accessoire demande d'attendre avant un nouvel essai"],
  4: ['max-peers', "l'accessoire a déjà autant de contrôleurs qu'il peut en avoir"],
  5: ['max-tries', "trop d'essais : l'accessoire n'accepte plus de code avant sa remise à zéro"],
  6: ['unavailable', "l'accessoire est déjà appairé (à Maison ou à un autre contrôleur) : le retirer de là d'abord, ou le remettre à zéro"],
  7: ['busy', "l'accessoire est occupé par un autre appairage"],
}

function checkTlv(items: Map<number, Buffer>, expectedState: number): void {
  const error = items.get(T.error)
  if (error) {
    const [code, message] = TLV_ERRORS[error[0]!] ?? ['protocol', `erreur ${error[0]}`]
    const delay = items.get(T.retryDelay)
    throw new HapError(delay ? `${message} (${delay.readUIntLE(0, delay.length)} s)` : message, code)
  }
  const state = items.get(T.state)
  if (state && state[0] !== expectedState) throw new HapError(`étape ${state[0]} au lieu de ${expectedState}`, 'protocol')
}

// ---------------------------------------------------------------------------------------
// HTTP over a byte stream
// ---------------------------------------------------------------------------------------

export interface HttpMessage {
  kind: 'response' | 'event'
  status: number
  headers: Record<string, string>
  body: Buffer
}

/** Cuts HTTP/1.1 responses and EVENT/1.0 messages out of a stream of bytes. */
export class HttpStream {
  #buffer = Buffer.alloc(0)

  push(data: Buffer): HttpMessage[] {
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(data) : Buffer.concat([this.#buffer, data])
    const messages: HttpMessage[] = []
    for (;;) {
      const end = this.#buffer.indexOf('\r\n\r\n')
      if (end < 0) break
      const head = this.#buffer.subarray(0, end).toString('latin1').split('\r\n')
      const status = /^(HTTP\/1\.[01]|EVENT\/1\.0) (\d{3})/.exec(head[0] ?? '')
      if (!status) throw new HapError(`réponse illisible : ${head[0]}`, 'protocol')
      const headers: Record<string, string> = {}
      for (const line of head.slice(1)) {
        const colon = line.indexOf(':')
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      const start = end + 4
      let body: Buffer
      let consumed: number
      if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
        const chunked = this.#chunked(start)
        if (!chunked) break
        ;[body, consumed] = chunked
      } else {
        const length = Number(headers['content-length'] ?? 0)
        if (this.#buffer.length < start + length) break
        body = Buffer.from(this.#buffer.subarray(start, start + length))
        consumed = start + length
      }
      this.#buffer = this.#buffer.subarray(consumed)
      messages.push({ kind: status[1] === 'EVENT/1.0' ? 'event' : 'response', status: Number(status[2]), headers, body })
    }
    return messages
  }

  #chunked(start: number): [Buffer, number] | null {
    const parts: Buffer[] = []
    let offset = start
    for (;;) {
      const lineEnd = this.#buffer.indexOf('\r\n', offset)
      if (lineEnd < 0) return null
      const size = parseInt(this.#buffer.subarray(offset, lineEnd).toString('latin1'), 16)
      if (!Number.isFinite(size)) throw new HapError('corps HTTP en morceaux illisible', 'protocol')
      if (this.#buffer.length < lineEnd + 2 + size + 2) return null
      if (size === 0) return [Buffer.concat(parts), lineEnd + 4]
      parts.push(this.#buffer.subarray(lineEnd + 2, lineEnd + 2 + size))
      offset = lineEnd + 2 + size + 2
    }
  }
}

// ---------------------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------------------

export interface CharacteristicEvent {
  aid: number
  iid: number
  value: unknown
}

interface Pending {
  resolve: (message: HttpMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class HapConnection {
  readonly host: string
  readonly port: number
  #socket: Socket
  #stream = new HttpStream()
  #session: HapSession | null = null
  #pending: Pending[] = []
  #queue: Promise<unknown> = Promise.resolve()
  #closed = false
  #timeoutMs: number
  onEvent: (events: CharacteristicEvent[]) => void = () => undefined
  onClose: (reason: string) => void = () => undefined

  private constructor(socket: Socket, host: string, port: number, timeoutMs: number) {
    this.#socket = socket
    this.host = host
    this.port = port
    this.#timeoutMs = timeoutMs
    socket.on('data', (data) => this.#received(data))
    socket.on('close', () => this.#close('connexion fermée par l\'accessoire'))
    socket.on('error', (error) => this.#close(error.message))
  }

  static async connect(host: string, port: number, timeoutMs = 10_000): Promise<HapConnection> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const attempt = connect({ host, port })
      const timer = setTimeout(() => {
        attempt.destroy()
        reject(new HapError(`${host}:${port} ne répond pas`, 'network'))
      }, timeoutMs)
      attempt.once('connect', () => {
        clearTimeout(timer)
        attempt.setNoDelay(true)
        attempt.setKeepAlive(true, 10_000)
        resolve(attempt)
      })
      attempt.once('error', (error) => {
        clearTimeout(timer)
        reject(new HapError(`${host}:${port} injoignable : ${error.message}`, 'network'))
      })
    })
    return new HapConnection(socket, host, port, timeoutMs)
  }

  get closed(): boolean {
    return this.#closed
  }

  #received(data: Buffer): void {
    let plain: Buffer
    try {
      plain = this.#session ? this.#session.decrypt(data) : data
    } catch (error) {
      this.#socket.destroy()
      this.#close((error as Error).message)
      return
    }
    if (plain.length === 0) return
    let messages: HttpMessage[]
    try {
      messages = this.#stream.push(plain)
    } catch (error) {
      this.#socket.destroy()
      this.#close((error as Error).message)
      return
    }
    for (const message of messages) {
      if (message.kind === 'event') {
        try {
          const events = (JSON.parse(message.body.toString('utf8')) as { characteristics?: CharacteristicEvent[] }).characteristics ?? []
          this.onEvent(events)
        } catch {
          // An event that is not JSON is dropped; the next report will carry the value.
        }
        continue
      }
      const pending = this.#pending.shift()
      if (!pending) continue
      clearTimeout(pending.timer)
      pending.resolve(message)
    }
  }

  #close(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.splice(0)) {
      clearTimeout(pending.timer)
      pending.reject(new HapError(reason, 'network'))
    }
    this.onClose(reason)
  }

  close(): void {
    this.#socket.destroy()
    this.#close('fermée par le hub')
  }

  /** One request at a time: HAP answers in order and nothing else keeps them apart. */
  request(method: string, path: string, body?: Buffer, contentType?: string): Promise<HttpMessage> {
    const run = () =>
      new Promise<HttpMessage>((resolve, reject) => {
        if (this.#closed) {
          reject(new HapError('connexion fermée', 'network'))
          return
        }
        const head = [`${method} ${path} HTTP/1.1`, `Host: ${this.host}:${this.port}`]
        if (body) head.push(`Content-Type: ${contentType ?? 'application/hap+json'}`, `Content-Length: ${body.length}`)
        const raw = Buffer.concat([Buffer.from(`${head.join('\r\n')}\r\n\r\n`, 'latin1'), body ?? Buffer.alloc(0)])
        const timer = setTimeout(() => {
          const index = this.#pending.findIndex((entry) => entry.timer === timer)
          if (index >= 0) this.#pending.splice(index, 1)
          // Out of step with the accessory: nothing sent after this could be trusted.
          this.#socket.destroy()
          this.#close("l'accessoire ne répond plus")
          reject(new HapError("l'accessoire ne répond pas", 'network'))
        }, this.#timeoutMs)
        this.#pending.push({ resolve, reject, timer })
        this.#socket.write(this.#session ? this.#session.encrypt(raw) : raw)
      })
    const next = this.#queue.then(run, run)
    this.#queue = next.catch(() => undefined)
    return next
  }

  async #tlv(path: string, items: Parameters<typeof tlvEncode>[0], expectedState: number): Promise<Map<number, Buffer>> {
    const response = await this.request('POST', path, tlvEncode(items), 'application/pairing+tlv8')
    if (response.status >= 400 && response.body.length === 0) throw new HapError(`${path} : HTTP ${response.status}`, 'protocol')
    const reply = tlvDecode(response.body)
    checkTlv(reply, expectedState)
    return reply
  }

  /** Pair setup, M1 to M6: the code proves itself, then long-term keys are exchanged. */
  async pairSetup(code: string, controller: ControllerIdentity): Promise<AccessoryKeys> {
    const m2 = await this.#tlv('/pair-setup', [[T.state, 1], [T.method, METHOD.pairSetup]], 2)
    const salt = m2.get(T.salt)
    const serverKey = m2.get(T.publicKey)
    if (!salt || !serverKey) throw new HapError("l'accessoire n'a pas envoyé sa clé", 'protocol')
    const srp = new SrpClient('Pair-Setup', code)
    srp.setSalt(salt)
    srp.setServerPublicKey(serverKey)

    const m4 = await this.#tlv('/pair-setup', [[T.state, 3], [T.publicKey, srp.publicKey], [T.proof, srp.proof]], 4)
    const serverProof = m4.get(T.proof)
    if (!serverProof || !srp.verifyServerProof(serverProof)) throw new HapError("l'accessoire n'a pas prouvé connaître le code", 'authentication')

    const sessionKey = srp.sessionKey
    const encryptKey = hkdf(sessionKey, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info')
    const controllerX = hkdf(sessionKey, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info')
    const identifier = Buffer.from(controller.id)
    const signature = sign(null, Buffer.concat([controllerX, identifier, controller.publicKey]), signingKey(controller))
    const sealed = seal(encryptKey, hapNonce('PS-Msg05'), tlvEncode([[T.identifier, identifier], [T.publicKey, controller.publicKey], [T.signature, signature]]))

    const m6 = await this.#tlv('/pair-setup', [[T.state, 5], [T.encryptedData, sealed]], 6)
    const opened = m6.get(T.encryptedData) ? open(encryptKey, hapNonce('PS-Msg06'), m6.get(T.encryptedData)!) : null
    if (!opened) throw new HapError("réponse de l'accessoire illisible", 'protocol')
    const accessory = tlvDecode(opened)
    const accessoryId = accessory.get(T.identifier)
    const accessoryKey = accessory.get(T.publicKey)
    const accessorySignature = accessory.get(T.signature)
    if (!accessoryId || !accessoryKey || !accessorySignature) throw new HapError("l'accessoire n'a pas donné son identité", 'protocol')
    const accessoryX = hkdf(sessionKey, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info')
    if (!verify(null, Buffer.concat([accessoryX, accessoryId, accessoryKey]), verifyingKey(accessoryKey), accessorySignature)) {
      throw new HapError("la signature de l'accessoire ne correspond pas", 'authentication')
    }
    return { accessoryId: accessoryId.toString('utf8'), accessoryKey: Buffer.from(accessoryKey) }
  }

  /** Pair verify, M1 to M4, then everything after is sealed. */
  async pairVerify(keys: AccessoryKeys, controller: ControllerIdentity): Promise<void> {
    const ephemeral = generateKeyPairSync('x25519')
    const ours = Buffer.from((ephemeral.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
    const m2 = await this.#tlv('/pair-verify', [[T.state, 1], [T.publicKey, ours]], 2)
    const theirs = m2.get(T.publicKey)
    const encrypted = m2.get(T.encryptedData)
    if (!theirs || !encrypted) throw new HapError("l'accessoire n'a pas répondu à la vérification", 'protocol')
    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: theirs.toString('base64url') }, format: 'jwk' }) })
    const verifyKey = hkdf(shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info')
    const opened = open(verifyKey, hapNonce('PV-Msg02'), encrypted)
    if (!opened) throw new HapError('vérification illisible', 'authentication')
    const accessory = tlvDecode(opened)
    const accessoryId = accessory.get(T.identifier)?.toString('utf8')
    const accessorySignature = accessory.get(T.signature)
    if (accessoryId !== keys.accessoryId || !accessorySignature) throw new HapError("ce n'est pas l'accessoire appairé", 'authentication')
    if (!verify(null, Buffer.concat([theirs, Buffer.from(accessoryId), ours]), verifyingKey(keys.accessoryKey), accessorySignature)) {
      throw new HapError("la signature de l'accessoire ne correspond pas à celle de l'appairage", 'authentication')
    }
    const identifier = Buffer.from(controller.id)
    const signature = sign(null, Buffer.concat([ours, identifier, theirs]), signingKey(controller))
    const sealed = seal(verifyKey, hapNonce('PV-Msg03'), tlvEncode([[T.identifier, identifier], [T.signature, signature]]))
    await this.#tlv('/pair-verify', [[T.state, 3], [T.encryptedData, sealed]], 4)
    this.#session = new HapSession(hkdf(shared, 'Control-Salt', 'Control-Write-Encryption-Key'), hkdf(shared, 'Control-Salt', 'Control-Read-Encryption-Key'))
  }

  /** A GET answered in JSON; 207 is a read where some characteristics failed, each with its status. */
  async getJson(path: string): Promise<unknown> {
    const response = await this.request('GET', path)
    if (response.status !== 200 && response.status !== 207) throw new HapError(`${path} : HTTP ${response.status}`, 'protocol')
    return JSON.parse(response.body.toString('utf8'))
  }

  /** PUT /characteristics: 204 when everything was done, 207 with a status per item otherwise. */
  async putCharacteristics(items: Record<string, unknown>[]): Promise<{ aid: number; iid: number; status: number }[]> {
    const response = await this.request('PUT', '/characteristics', Buffer.from(JSON.stringify({ characteristics: items })))
    if (response.status === 204 || response.body.length === 0) return []
    const parsed = JSON.parse(response.body.toString('utf8')) as { characteristics?: { aid: number; iid: number; status: number }[] }
    return (parsed.characteristics ?? []).filter((entry) => entry.status !== 0)
  }

  /** Remove a pairing from the accessory (the hub's own, to leave it). */
  async removePairing(controllerId: string): Promise<void> {
    await this.#tlv('/pairings', [[T.state, 1], [T.method, METHOD.removePairing], [T.identifier, controllerId]], 2)
  }
}

/** Status codes an accessory puts in a 207 answer (HAP table 6-11), in words. */
export function statusText(status: number): string {
  const known: Record<number, string> = {
    [-70401]: 'accès refusé',
    [-70402]: "l'accessoire est occupé",
    [-70403]: "l'accessoire est occupé",
    [-70404]: 'caractéristique en lecture seule',
    [-70405]: 'caractéristique en écriture seule',
    [-70406]: 'notifications non prises en charge',
    [-70407]: "l'accessoire manque de ressources",
    [-70408]: "l'accessoire n'a pas répondu à temps",
    [-70409]: 'caractéristique inexistante',
    [-70410]: 'valeur refusée',
    [-70411]: 'authentification insuffisante',
  }
  return known[status] ?? `erreur ${status}`
}
