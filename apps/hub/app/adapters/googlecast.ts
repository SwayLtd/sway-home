/**
 * Google Cast: Chromecast, Google TV, Nest speakers and displays, and every third-party
 * speaker with Cast built in.
 *
 * Cast speaks CASTV2 - protobuf frames over TLS on port 8009 - and the usual answer is to
 * pull in a protobuf runtime plus a client library. That is a lot of dependency for a
 * message with six fields, all of them scalar, so the wire format is written out by hand
 * below. The whole codec is about sixty lines and it has no dependencies at all.
 *
 * Frame: 4-byte big-endian length, then a CastMessage:
 *   1 protocol_version (varint)   2 source_id (string)     3 destination_id (string)
 *   4 namespace (string)          5 payload_type (varint)  6 payload_utf8 (string)
 */

import tls from 'node:tls'
import type { AdapterDescriptor, CapabilityId, CommandResult as Result, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { PollingAdapter } from '#adapters/base'

const CAST_PORT = 8009
const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection'
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat'
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver'
const NS_MEDIA = 'urn:x-cast:com.google.cast.media'
const DEFAULT_RECEIVER = 'CC1AD845' // the standard media receiver

const CAST_CAPABILITIES: CapabilityId[] = ['mediaPlayback', 'volume', 'mediaSource', 'speech', 'notify', 'connectivity']

// ---------------------------------------------------------------------------------------
// Minimal protobuf codec for CastMessage
// ---------------------------------------------------------------------------------------

function writeVarint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining >>>= 7
    if (remaining > 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining > 0)
  return Buffer.from(bytes)
}

function writeField(fieldNumber: number, wireType: number, payload: Buffer): Buffer {
  return Buffer.concat([writeVarint((fieldNumber << 3) | wireType), payload])
}

function writeString(fieldNumber: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return writeField(fieldNumber, 2, Buffer.concat([writeVarint(bytes.length), bytes]))
}

function encodeCastMessage(message: { sourceId: string; destinationId: string; namespace: string; payload: string }): Buffer {
  const body = Buffer.concat([
    writeField(1, 0, writeVarint(0)), // protocol_version = CASTV2_1_0
    writeString(2, message.sourceId),
    writeString(3, message.destinationId),
    writeString(4, message.namespace),
    writeField(5, 0, writeVarint(0)), // payload_type = STRING
    writeString(6, message.payload),
  ])
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

function readVarint(buffer: Buffer, offset: number): { value: number; offset: number } {
  let value = 0
  let shift = 0
  let cursor = offset
  for (;;) {
    const byte = buffer[cursor] ?? 0
    cursor += 1
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
    if (shift > 35) break
  }
  return { value: value >>> 0, offset: cursor }
}

function decodeCastMessage(body: Buffer): { namespace: string; payload: string; sourceId: string } {
  let offset = 0
  let namespace = ''
  let payload = ''
  let sourceId = ''

  while (offset < body.length) {
    const key = readVarint(body, offset)
    offset = key.offset
    const fieldNumber = key.value >> 3
    const wireType = key.value & 0x07

    if (wireType === 0) {
      offset = readVarint(body, offset).offset
      continue
    }
    if (wireType !== 2) break

    const length = readVarint(body, offset)
    offset = length.offset
    const value = body.subarray(offset, offset + length.value).toString('utf8')
    offset += length.value

    if (fieldNumber === 2) sourceId = value
    if (fieldNumber === 4) namespace = value
    if (fieldNumber === 6) payload = value
  }

  return { namespace, payload, sourceId }
}

// ---------------------------------------------------------------------------------------
// One connection per device
// ---------------------------------------------------------------------------------------

interface CastStatus {
  volume: { level: number; muted: boolean }
  applications?: { appId: string; displayName: string; sessionId: string; transportId: string; statusText?: string }[]
}

class CastConnection {
  #socket: tls.TLSSocket | null = null
  #buffer = Buffer.alloc(0)
  #requestId = 1
  #pending = new Map<number, (payload: Record<string, unknown>) => void>()
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #connectedDestinations = new Set<string>()
  readonly sourceId = 'sender-sway'

  constructor(
    readonly ip: string,
    private readonly onMessage: (namespace: string, payload: Record<string, unknown>) => void,
    private readonly onClose: () => void
  ) {}

  async connect(timeoutMs = 6000): Promise<boolean> {
    if (this.#socket && !this.#socket.destroyed) return true

    return new Promise((resolve) => {
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        resolve(ok)
      }

      // Cast devices present a self-signed certificate; the connection is local and the
      // protocol has no other transport, so verification is off by design here.
      const socket = tls.connect({ host: this.ip, port: CAST_PORT, rejectUnauthorized: false, timeout: timeoutMs }, () => {
        this.#socket = socket
        this.#send(DEFAULT_RECEIVER_CONNECTION_TARGET, NS_CONNECTION, { type: 'CONNECT' })
        this.#connectedDestinations.add(DEFAULT_RECEIVER_CONNECTION_TARGET)
        this.#heartbeat = setInterval(() => this.#send(DEFAULT_RECEIVER_CONNECTION_TARGET, NS_HEARTBEAT, { type: 'PING' }), 5000)
        finish(true)
      })

      socket.on('data', (chunk: Buffer) => this.#consume(chunk))
      socket.on('error', () => {
        this.destroy()
        finish(false)
      })
      socket.on('close', () => {
        this.destroy()
        this.onClose()
      })
      socket.setTimeout(timeoutMs, () => {
        if (!settled) {
          socket.destroy()
          finish(false)
        }
      })
    })
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    for (;;) {
      if (this.#buffer.length < 4) return
      const length = this.#buffer.readUInt32BE(0)
      if (this.#buffer.length < length + 4) return
      const body = this.#buffer.subarray(4, length + 4)
      this.#buffer = this.#buffer.subarray(length + 4)

      const message = decodeCastMessage(body)
      if (!message.payload) continue
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(message.payload) as Record<string, unknown>
      } catch {
        continue
      }

      if (message.namespace === NS_HEARTBEAT) continue

      const requestId = Number(payload.requestId ?? 0)
      const resolver = this.#pending.get(requestId)
      if (resolver) {
        this.#pending.delete(requestId)
        resolver(payload)
      }
      this.onMessage(message.namespace, payload)
    }
  }

  #send(destinationId: string, namespace: string, payload: Record<string, unknown>): void {
    if (!this.#socket || this.#socket.destroyed) return
    this.#socket.write(encodeCastMessage({ sourceId: this.sourceId, destinationId, namespace, payload: JSON.stringify(payload) }))
  }

  /** Send and wait for the answer carrying the same requestId. */
  async request(destinationId: string, namespace: string, payload: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown> | null> {
    if (!(await this.connect())) return null
    if (!this.#connectedDestinations.has(destinationId)) {
      this.#send(destinationId, NS_CONNECTION, { type: 'CONNECT' })
      this.#connectedDestinations.add(destinationId)
    }

    const requestId = this.#requestId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId)
        resolve(null)
      }, timeoutMs)
      this.#pending.set(requestId, (response) => {
        clearTimeout(timer)
        resolve(response)
      })
      this.#send(destinationId, namespace, { ...payload, requestId })
    })
  }

  destroy(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
    this.#connectedDestinations.clear()
    this.#pending.clear()
    this.#socket?.destroy()
    this.#socket = null
  }
}

const DEFAULT_RECEIVER_CONNECTION_TARGET = 'receiver-0'

// ---------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------

export class GoogleCastAdapter extends PollingAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'googlecast',
    name: 'Google Cast',
    vendor: 'Google',
    transports: ['wifi', 'ethernet'],
    capabilities: CAST_CAPABILITIES,
    zeroConfig: true,
    cloud: false,
    implemented: true,
    docsUrl: 'https://developers.google.com/cast',
    configSchema: [{ key: 'pollIntervalMs', label: 'Poll interval (ms)', type: 'number', default: 10000 }],
  }

  protected override pollIntervalMs = 10_000
  #connections = new Map<string, CastConnection>()
  /**
   * Cast devices broadcast MEDIA_STATUS without a request id when playback changes, so a
   * reply-matched GET_STATUS can legitimately come back empty while a session is running.
   * Caching whatever id has been seen is what makes pause and seek work reliably.
   */
  #mediaSessions = new Map<string, number>()
  /**
   * Last known state per device, kept fresh by the push handler. Every CASTV2 round trip
   * is a second or more on a TV, and `execute` needs the state twice (before, for undo,
   * and after, to report). Reading the cache when it is under two seconds old turns a
   * five-second volume change into an instant one.
   */
  #stateCache = new Map<string, { at: number; state: Record<string, unknown> }>()

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    const candidates = hosts.filter(
      (host) => host.mdnsServices.some((service) => service.includes('_googlecast')) || host.openPorts.includes(CAST_PORT) || host.openPorts.includes(8008)
    )

    const found: DiscoveredDevice[] = []
    for (const host of candidates) {
      // The mDNS TXT record carries everything needed to identify the device, and every
      // Cast device publishes it, so no connection is required just to list them.
      const txt = host.mdnsTxt
      const uuid = txt.id ?? txt.ID ?? null
      const friendly = txt.fn ?? txt.FN ?? host.hostname ?? `Cast ${host.ip}`
      const model = txt.md ?? txt.MD ?? 'Google Cast'

      // Without a TXT record, prove it is a Cast device by opening the port.
      let confirmed = uuid !== null
      if (!confirmed) {
        const connection = this.#connection(host.ip)
        confirmed = await connection.connect(3000)
        if (!confirmed) continue
      }

      this.devices.set(host.ip, { ip: host.ip, meta: { uuid } })
      found.push({
        adapterId: 'googlecast',
        nativeId: host.ip,
        uid: `googlecast:${uuid ?? host.mac ?? host.ip}`,
        name: friendly,
        category: /tv|display|shield|android/i.test(model) ? 'display' : 'speaker',
        capabilities: CAST_CAPABILITIES,
        transport: 'wifi',
        manufacturer: 'Google',
        model,
        serialNumber: uuid,
        confidence: uuid ? 0.95 : 0.8,
        network: { ip: host.ip, mac: host.mac, hostname: host.hostname },
        meta: { uuid, castType: txt.ca ?? null, rawTxt: txt },
      })
    }

    return found
  }

  async getState(nativeId: string, maxAgeMs = 0): Promise<Record<string, unknown>> {
    const cached = this.#stateCache.get(nativeId)
    if (cached && maxAgeMs > 0 && Date.now() - cached.at < maxAgeMs) return { ...cached.state }

    const connection = this.#connection(nativeId)
    const response = await connection.request(DEFAULT_RECEIVER_CONNECTION_TARGET, NS_RECEIVER, { type: 'GET_STATUS' })
    const status = response?.status as CastStatus | undefined
    if (!status) return { ...(this.#stateCache.get(nativeId)?.state ?? {}) }

    const state: Record<string, unknown> = {
      volume: Math.round((status.volume?.level ?? 0) * 100),
      muted: status.volume?.muted === true,
    }

    const application = status.applications?.[0]
    if (!application) {
      state.playback = 'idle'
      state.app = null
      state.title = null
      state.artist = null
      this.#stateCache.set(nativeId, { at: Date.now(), state })
      return state
    }

    state.app = application.displayName
    state.source = application.displayName

    // Media details live on the running session, not on the receiver.
    const media = await connection.request(application.transportId, NS_MEDIA, { type: 'GET_STATUS' })
    const first = (media?.status as Record<string, any>[] | undefined)?.[0]
    if (!first) {
      // An app can be running with no media session: the receiver is up but whatever it was
      // playing has finished. Reporting "playing" there is how a UI ends up showing a
      // transport bar for a stream that ended ten minutes ago.
      state.playback = 'idle'
      this.#mediaSessions.delete(nativeId)
      this.#stateCache.set(nativeId, { at: Date.now(), state })
      return state
    }

    state.playback =
      first.playerState === 'PLAYING' ? 'playing' : first.playerState === 'PAUSED' ? 'paused' : first.playerState === 'BUFFERING' ? 'buffering' : 'stopped'
    state.positionSeconds = typeof first.currentTime === 'number' ? Math.round(first.currentTime) : null
    const metadata = first.media?.metadata as Record<string, any> | undefined
    if (metadata) {
      state.title = metadata.title ?? null
      state.artist = metadata.artist ?? metadata.subtitle ?? null
      state.album = metadata.albumName ?? null
      state.artworkUrl = metadata.images?.[0]?.url ?? null
    }
    if (typeof first.media?.duration === 'number') state.durationSeconds = Math.round(first.media.duration)

    this.#stateCache.set(nativeId, { at: Date.now(), state })
    return state
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<Result> {
    const connection = this.#connection(nativeId)
    // Two seconds is short enough that the undo entry is honest and long enough that a
    // burst of commands does not pay for a round trip each.
    const before = await this.getState(nativeId, 2000)

    switch (command) {
      case 'setVolume': {
        const level = Math.max(0, Math.min(100, Number(args.volume ?? 0))) / 100
        const response = await connection.request(DEFAULT_RECEIVER_CONNECTION_TARGET, NS_RECEIVER, { type: 'SET_VOLUME', volume: { level } })
        if (!response) return this.fail(nativeId, command, 'Device did not answer')
        return this.ok(nativeId, command, { volume: Math.round(level * 100) }, { command: 'setVolume', args: { volume: Number(before.volume ?? 0) } })
      }
      case 'stepVolume': {
        const next = Math.max(0, Math.min(100, Number(before.volume ?? 0) + Number(args.delta ?? 0)))
        return this.execute(nativeId, 'setVolume', { volume: next })
      }
      case 'setMuted': {
        const muted = args.muted === true
        const response = await connection.request(DEFAULT_RECEIVER_CONNECTION_TARGET, NS_RECEIVER, { type: 'SET_VOLUME', volume: { muted } })
        if (!response) return this.fail(nativeId, command, 'Device did not answer')
        return this.ok(nativeId, command, { muted }, { command: 'setMuted', args: { muted: before.muted === true } })
      }
      case 'play':
      case 'pause':
      case 'stopPlayback':
      case 'next':
      case 'previous':
      case 'seek': {
        const transportId = await this.#transportId(connection)
        if (!transportId) return this.fail(nativeId, command, 'Nothing is playing on this device')
        const mediaSessionId = await this.#mediaSessionId(connection, transportId)
        if (mediaSessionId === null) return this.fail(nativeId, command, 'No media session')

        const types: Record<string, string> = { play: 'PLAY', pause: 'PAUSE', stopPlayback: 'STOP', next: 'QUEUE_NEXT', previous: 'QUEUE_PREV', seek: 'SEEK' }
        const payload: Record<string, unknown> = { type: types[command], mediaSessionId }
        if (command === 'seek') payload.currentTime = Number(args.positionSeconds ?? 0)

        const response = await connection.request(transportId, NS_MEDIA, payload)
        if (!response) return this.fail(nativeId, command, 'Device did not answer')
        return this.ok(nativeId, command, await this.getState(nativeId), command === 'play' ? { command: 'pause', args: {} } : null)
      }
      case 'stop':
        return this.execute(nativeId, 'stopPlayback', {})
      case 'setSource': {
        const response = await connection.request(DEFAULT_RECEIVER_CONNECTION_TARGET, NS_RECEIVER, { type: 'LAUNCH', appId: String(args.source ?? DEFAULT_RECEIVER) }, 15_000)
        if (!response) return this.fail(nativeId, command, 'Device did not answer')
        return this.ok(nativeId, command, await this.getState(nativeId))
      }
      case 'turnOff': {
        // A Cast device has no power switch; stopping the session is the closest honest act.
        this.#mediaSessions.delete(nativeId)
        const response = await connection.request(DEFAULT_RECEIVER_CONNECTION_TARGET, NS_RECEIVER, { type: 'STOP' })
        if (!response) return this.fail(nativeId, command, 'Device did not answer')
        return this.ok(nativeId, command, { playback: 'idle' })
      }
      case 'playMedia': {
        const url = String(args.query ?? '')
        if (!/^https?:\/\//.test(url)) {
          return this.fail(nativeId, command, 'Cast needs a media URL. Searching a streaming service is not in the local protocol.')
        }
        // Launching an app on a TV is slow: the receiver has to start before it answers.
        // Fifteen seconds, then poll, because the answer sometimes arrives as an unsolicited
        // RECEIVER_STATUS rather than as a reply carrying our request id.
        const launch = await connection.request(DEFAULT_RECEIVER_CONNECTION_TARGET, NS_RECEIVER, { type: 'LAUNCH', appId: DEFAULT_RECEIVER }, 15_000)
        let transportId = (launch?.status as CastStatus | undefined)?.applications?.[0]?.transportId ?? null
        for (let attempt = 0; attempt < 8 && !transportId; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 700))
          transportId = await this.#transportId(connection)
        }
        if (!transportId) return this.fail(nativeId, command, 'Could not start the media receiver')
        const response = await connection.request(transportId, NS_MEDIA, {
          type: 'LOAD',
          autoplay: true,
          currentTime: 0,
          media: { contentId: url, streamType: 'BUFFERED', contentType: guessContentType(url) },
        })
        if (!response) return this.fail(nativeId, command, 'Device refused the media')
        return this.ok(nativeId, command, await this.getState(nativeId))
      }
      case 'speak':
        return this.fail(nativeId, command, 'Speech needs a rendered audio URL; the hub does that through the voice service.')
      default:
        return this.fail(nativeId, command, `Google Cast does not support ${command}`)
    }
  }

  async #transportId(connection: CastConnection): Promise<string | null> {
    const response = await connection.request(DEFAULT_RECEIVER_CONNECTION_TARGET, NS_RECEIVER, { type: 'GET_STATUS' })
    return (response?.status as CastStatus | undefined)?.applications?.[0]?.transportId ?? null
  }

  async #mediaSessionId(connection: CastConnection, transportId: string): Promise<number | null> {
    const response = await connection.request(transportId, NS_MEDIA, { type: 'GET_STATUS' }, 6000)
    const first = (response?.status as Record<string, any>[] | undefined)?.[0]
    if (typeof first?.mediaSessionId === 'number') {
      this.#mediaSessions.set(connection.ip, first.mediaSessionId)
      return first.mediaSessionId
    }
    // Fall back to whatever the device broadcast last: an unsolicited MEDIA_STATUS carries
    // the same session and arrives whether or not our request was matched.
    return this.#mediaSessions.get(connection.ip) ?? null
  }

  /** Update the cache and tell the hub in one step, so the two can never disagree. */
  #patchCache(ip: string, patch: Record<string, unknown>): void {
    const current = this.#stateCache.get(ip)?.state ?? {}
    this.#stateCache.set(ip, { at: Date.now(), state: { ...current, ...patch } })
    this.context?.emitState(ip, patch)
  }

  #connection(ip: string): CastConnection {
    const existing = this.#connections.get(ip)
    if (existing) return existing
    const connection = new CastConnection(
      ip,
      (namespace, payload) => {
        if (namespace === NS_MEDIA) {
          const first = (payload.status as Record<string, any>[] | undefined)?.[0]
          if (typeof first?.mediaSessionId === 'number') this.#mediaSessions.set(ip, first.mediaSessionId)
          if (typeof first?.playerState === 'string') {
            this.#patchCache(ip, {
              playback:
                first.playerState === 'PLAYING' ? 'playing'
                : first.playerState === 'PAUSED' ? 'paused'
                : first.playerState === 'BUFFERING' ? 'buffering'
                : 'stopped',
            })
          }
          return
        }

        // Receiver pushes a status message whenever volume or the running app changes, so
        // the UI updates without waiting for the next poll.
        if (namespace !== NS_RECEIVER || payload.type !== 'RECEIVER_STATUS') return
        const status = payload.status as CastStatus | undefined
        if (!status) return
        this.#patchCache(ip, {
          volume: Math.round((status.volume?.level ?? 0) * 100),
          muted: status.volume?.muted === true,
          app: status.applications?.[0]?.displayName ?? null,
        })
      },
      () => this.#connections.delete(ip)
    )
    this.#connections.set(ip, connection)
    return connection
  }

  override async shutdown(): Promise<void> {
    for (const connection of this.#connections.values()) connection.destroy()
    this.#connections.clear()
    await super.shutdown()
  }
}

function guessContentType(url: string): string {
  if (/\.mp3(\?|$)/i.test(url)) return 'audio/mpeg'
  if (/\.wav(\?|$)/i.test(url)) return 'audio/wav'
  if (/\.m4a|\.aac(\?|$)/i.test(url)) return 'audio/aac'
  if (/\.m3u8(\?|$)/i.test(url)) return 'application/x-mpegURL'
  if (/\.mp4(\?|$)/i.test(url)) return 'video/mp4'
  return 'audio/mpeg'
}
