/**
 * A WebSocket to a device that signs its own certificate, trusted on first use.
 *
 * TVs serve their TLS port with a certificate they made themselves: no authority can vouch
 * for it, so the usual answer (Home Assistant's aiowebostv included) is to switch
 * verification off, and then anyone on the LAN who answers in the TV's place receives the
 * pairing key. Here the certificate seen the first time is kept, and a later connection that
 * shows another one is dropped right after the TLS handshake, before a single HTTP byte, so
 * the key never leaves.
 *
 * The client is a small RFC 6455 implementation over `node:tls`, because the built-in
 * WebSocket does not show the peer certificate. The frame tests pin down the parts a TV
 * exercises: long messages, fragments, pings and the close handshake.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server as NetServer } from 'node:net'
import type { SocketLike } from '#adapters/homeassistant'
import { CertificateMismatchError, FrameReader, WebSocketProtocolError, encodeFrame, pinnedWebSocket } from '#adapters/pinned_websocket'
import { eventually } from './adapter_harness.ts'
import { selfSignedCertificate } from './self_signed.ts'

const certificate = selfSignedCertificate()

interface EchoState {
  requests: { path: string; headers: Record<string, string> }[]
  closes: { code: number; reason: string }[]
  pongs: number
}

const servers: { stop: () => void }[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

function echoServer(options: { tls?: boolean; refuse?: boolean } = {}): { url: string; state: EchoState } {
  const state: EchoState = { requests: [], closes: [], pongs: 0 }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    ...(options.tls === false ? {} : { tls: { cert: certificate.cert, key: certificate.key } }),
    fetch(request, bun) {
      const url = new URL(request.url)
      state.requests.push({ path: url.pathname + url.search, headers: Object.fromEntries(request.headers) })
      if (options.refuse) return new Response('forbidden', { status: 403 })
      return bun.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 })
    },
    websocket: {
      message(ws, message) {
        const text = String(message)
        if (text === 'big') return void ws.send('x'.repeat(70_000))
        if (text === 'ping') return void ws.ping('are you there')
        if (text === 'bye') return ws.close(1001, 'standby')
        ws.send(`echo:${text}`)
      },
      close(_ws, code, reason) {
        state.closes.push({ code, reason })
      },
      pong() {
        state.pongs += 1
      },
    },
  })
  servers.push({ stop: () => server.stop(true) })
  return { url: `${options.tls === false ? 'ws' : 'wss'}://127.0.0.1:${server.port}`, state }
}

interface Watched {
  socket: SocketLike
  opened: Promise<void>
  messages: unknown[]
  errors: unknown[]
  closed: Promise<{ code: number; reason: string }>
}

function watch(socket: SocketLike): Watched {
  const messages: unknown[] = []
  const errors: unknown[] = []
  let opened!: () => void
  let failed!: (error: unknown) => void
  const openedPromise = new Promise<void>((resolve, reject) => {
    opened = resolve
    failed = reject
  })
  openedPromise.catch(() => undefined)
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.onclose = (event) => {
      failed(new Error('closed before open'))
      resolve(event)
    }
  })
  socket.onopen = () => opened()
  socket.onmessage = (event) => void messages.push(event.data)
  socket.onerror = (event) => {
    errors.push(event)
    failed(event)
  }
  return { socket, opened: openedPromise, messages, errors, closed }
}

const errorOf = (event: unknown) => (event as { error?: unknown }).error

describe('trust on first use', () => {
  test('the first time: the certificate is reported, and the socket works both ways', async () => {
    const { url, state } = echoServer()
    const pins: string[] = []
    const watched = watch(pinnedWebSocket(`${url}/api/v2/channels/remote?name=SGVsbG8%3D`, { pin: null, onPin: (fingerprint) => pins.push(fingerprint) }))
    await watched.opened
    expect(pins).toEqual([certificate.fingerprint])
    expect(state.requests[0]?.path).toBe('/api/v2/channels/remote?name=SGVsbG8%3D')

    watched.socket.send('bonjour')
    await eventually(() => watched.messages.includes('echo:bonjour'))
    watched.socket.close()
  })

  test('the same certificate later: connects without a word', async () => {
    const { url } = echoServer()
    const pins: string[] = []
    const watched = watch(pinnedWebSocket(url, { pin: certificate.fingerprint, onPin: (fingerprint) => pins.push(fingerprint) }))
    await watched.opened
    expect(pins).toEqual([])
    watched.socket.close()
  })

  test('a pin is recognised however it was written down', async () => {
    const { url } = echoServer()
    const written = certificate.fingerprint.toUpperCase().match(/.{2}/g)!.join(':')
    const watched = watch(pinnedWebSocket(url, { pin: written }))
    await watched.opened
    watched.socket.close()
  })

  test('another certificate: dropped before a single HTTP byte, so no key or token leaves', async () => {
    const { url, state } = echoServer()
    const watched = watch(pinnedWebSocket(`${url}/?token=secret`, { pin: 'ab'.repeat(32) }))
    await expect(watched.opened).rejects.toBeDefined()
    const error = errorOf(watched.errors[0])
    expect(error).toBeInstanceOf(CertificateMismatchError)
    expect((error as CertificateMismatchError).seen).toBe(certificate.fingerprint)
    expect((await watched.closed).code).toBe(1006)
    expect(state.requests).toEqual([])
  })
})

describe('the WebSocket', () => {
  test('plain ws:// works the same, with no certificate involved', async () => {
    const { url } = echoServer({ tls: false })
    const pins: string[] = []
    const watched = watch(pinnedWebSocket(url, { pin: null, onPin: (fingerprint) => pins.push(fingerprint) }))
    await watched.opened
    watched.socket.send('salut')
    await eventually(() => watched.messages.includes('echo:salut'))
    expect(pins).toEqual([])
    watched.socket.close()
  })

  test('long messages both ways: 16-bit and 64-bit lengths', async () => {
    const { url } = echoServer()
    const watched = watch(pinnedWebSocket(url, { pin: null }))
    await watched.opened
    watched.socket.send('big')
    await eventually(() => watched.messages.some((message) => typeof message === 'string' && message.length === 70_000))

    const medium = 'm'.repeat(300)
    const long = 'l'.repeat(80_000)
    watched.socket.send(medium)
    watched.socket.send(long)
    await eventually(() => watched.messages.includes(`echo:${medium}`) && watched.messages.includes(`echo:${long}`))
    watched.socket.close()
  })

  test('a ping from the other side is answered', async () => {
    const { url, state } = echoServer()
    const watched = watch(pinnedWebSocket(url, { pin: null }))
    await watched.opened
    watched.socket.send('ping')
    await eventually(() => state.pongs === 1)
    watched.socket.close()
  })

  test('closed by the other side: its code and reason come through', async () => {
    const { url } = echoServer()
    const watched = watch(pinnedWebSocket(url, { pin: null }))
    await watched.opened
    watched.socket.send('bye')
    expect(await watched.closed).toEqual({ code: 1001, reason: 'standby' })
  })

  test('closed from here: a proper close frame, and one close event', async () => {
    const { url, state } = echoServer()
    const watched = watch(pinnedWebSocket(url, { pin: null }))
    let closes = 0
    await watched.opened
    const onclose = watched.socket.onclose
    watched.socket.onclose = (event) => {
      closes += 1
      onclose?.(event)
    }
    watched.socket.close()
    await eventually(() => state.closes.length === 1)
    expect(state.closes[0]?.code).toBe(1000)
    await watched.closed
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(closes).toBe(1)
  })

  test('an upgrade refused by the server: an error, then a close, never an open', async () => {
    const { url } = echoServer({ refuse: true })
    const watched = watch(pinnedWebSocket(url, { pin: null }))
    await expect(watched.opened).rejects.toBeDefined()
    expect(String(errorOf(watched.errors[0]))).toContain('403')
    expect((await watched.closed).code).toBe(1006)
  })

  test('a device that accepts the connection and then says nothing: given up after the delay', async () => {
    const silent: NetServer = createServer(() => undefined)
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    servers.push({ stop: () => silent.close() })
    const port = (silent.address() as { port: number }).port
    const watched = watch(pinnedWebSocket(`wss://127.0.0.1:${port}`, { pin: null, timeoutMs: 150 }))
    await expect(watched.opened).rejects.toBeDefined()
    expect((await watched.closed).code).toBe(1006)
  })
})

describe('frames', () => {
  const frame = (opcode: number, payload: string | Buffer, fin = true) => encodeFrame(opcode, typeof payload === 'string' ? Buffer.from(payload) : payload, { mask: null, fin })

  test('a text frame that arrives one byte at a time is still one message', () => {
    const reader = new FrameReader()
    const bytes = frame(0x1, 'bonjour')
    const events = [...bytes].flatMap((byte) => reader.push(Buffer.from([byte])))
    expect(events).toEqual([{ kind: 'text', data: 'bonjour' }])
  })

  test('fragments are joined; a ping in between is its own event', () => {
    const reader = new FrameReader()
    const events = reader.push(Buffer.concat([frame(0x1, 'Bon', false), frame(0x9, 'p'), frame(0x0, 'jo', false), frame(0x0, 'ur')]))
    expect(events).toEqual([
      { kind: 'ping', data: Buffer.from('p') },
      { kind: 'text', data: 'Bonjour' },
    ])
  })

  test('what the client sends is masked, and reads back the same', () => {
    const payload = Buffer.from('é'.repeat(40_000))
    const sent = encodeFrame(0x1, payload, { mask: Buffer.from([1, 2, 3, 4]) })
    expect(sent[1]! & 0x80).toBe(0x80)
    expect(sent[1]! & 0x7f).toBe(127)
    expect(new FrameReader().push(sent)).toEqual([{ kind: 'text', data: payload.toString('utf8') }])
    expect(encodeFrame(0x1, Buffer.alloc(200), { mask: null })[1]).toBe(126)
    expect(encodeFrame(0x1, Buffer.alloc(125), { mask: null })[1]).toBe(125)
  })

  test('the close frame carries its code and reason', () => {
    const body = Buffer.concat([Buffer.from([0x03, 0xe9]), Buffer.from('standby')])
    expect(new FrameReader().push(frame(0x8, body))).toEqual([{ kind: 'close', code: 1001, reason: 'standby' }])
    expect(new FrameReader().push(frame(0x8, Buffer.alloc(0)))).toEqual([{ kind: 'close', code: 1005, reason: '' }])
  })

  test('broken streams are refused: a stray continuation, a fragmented ping, a message too large', () => {
    expect(() => new FrameReader().push(frame(0x0, 'x'))).toThrow(WebSocketProtocolError)
    expect(() => new FrameReader().push(frame(0x9, 'x', false))).toThrow(WebSocketProtocolError)
    const huge = Buffer.from([0x81, 127, 0, 0, 0, 1, 0, 0, 0, 0])
    let error: unknown = null
    try {
      new FrameReader({ maxBytes: 1024 }).push(huge)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(WebSocketProtocolError)
    expect((error as WebSocketProtocolError).code).toBe(1009)
  })
})
