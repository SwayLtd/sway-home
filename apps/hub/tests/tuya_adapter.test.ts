/**
 * The Tuya adapter against devices that speak the real local protocol over TCP and UDP.
 *
 * Each fake device listens like the firmware (TCP, one frame format per version), agrees on a
 * session key in 3.4 and 3.5 and drops a connection whose frames do not check out, answers
 * status queries (or "data unvalid" for the odd 22-character-id devices, which then want to
 * be asked with the list of points), applies commands and pushes its new status, and
 * announces itself by UDP broadcast.
 *
 * What is pinned down is what a person notices: a plug, a bulb and a curtain show up with
 * their real state once their local keys are in the settings, commands work in all three
 * versions, the button on the plug shows up in the app, a wrong key is said in words, and a
 * device found without its key asks for it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createCipheriv, createHmac, randomBytes } from 'node:crypto'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { createServer, type Server, type Socket } from 'node:net'
import { TuyaAdapter, type TuyaOptions } from '#adapters/tuya'
import {
  COMMAND,
  TuyaReader,
  UDP_KEY,
  aesEcbDecrypt,
  aesEcbEncrypt,
  decodeResponse,
  encodeRequest,
  packFrame,
  type Dps,
  type TuyaVersion,
} from '#adapters/tuya_codec'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'

class FakeTuyaDevice {
  server: Server | null = null
  sockets = new Set<Socket>()
  udp: UdpSocket | null = null
  sessionKey: Buffer | null = null
  received: { cmd: number; json: Record<string, unknown> | null }[] = []
  /** Answers "data unvalid" to a plain status query, like 22-character-id devices. */
  device22 = false
  #seq = 0

  constructor(
    readonly id: string,
    readonly version: TuyaVersion,
    readonly key: Buffer,
    public dps: Dps
  ) {}

  get port(): number {
    return (this.server!.address() as { port: number }).port
  }

  async start(): Promise<void> {
    this.server = createServer((socket) => this.#serve(socket))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
  }

  stop(): void {
    for (const socket of this.sockets) socket.destroy()
    this.server?.close()
    this.udp?.close()
  }

  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  /** The device's own UDP announcement, sent to the hub's listening port. */
  announce(port: number): void {
    const json = Buffer.from(JSON.stringify({ ip: '127.0.0.1', gwId: this.id, active: 2, encrypt: true, productKey: 'fakekey', version: this.version }))
    const frame =
      this.version === '3.5'
        ? packFrame({ format: '6699', seq: 0, cmd: 0x13, payload: Buffer.concat([Buffer.alloc(4), json]), key: UDP_KEY })
        : packFrame({ format: '55aa', seq: 0, cmd: 0x13, payload: aesEcbEncrypt(UDP_KEY, json), retcode: 0 })
    const socket = createSocket('udp4')
    socket.send(frame, port, '127.0.0.1', () => socket.close())
  }

  /** A 3.5 device answers a discovery request by announcing itself. */
  async listenForRequests(answerTo: () => number): Promise<number> {
    this.udp = createSocket('udp4')
    this.udp.on('message', (message) => {
      if (message.readUInt32BE(0) === 0x6699 && message.readUInt32BE(10) === COMMAND.reqDevinfo) this.announce(answerTo())
    })
    await new Promise<void>((resolve) => this.udp!.bind(0, '127.0.0.1', resolve))
    return this.udp.address().port
  }

  /** The button on the device: a status pushed to every connection. */
  press(changes: Dps): void {
    Object.assign(this.dps, changes)
    for (const socket of this.sockets) this.#send(socket, COMMAND.status, { dps: changes, t: 1 })
  }

  #key(): Buffer {
    return this.sessionKey ?? this.key
  }

  #send(socket: Socket, cmd: number, json: Record<string, unknown> | null, raw?: Buffer): void {
    const payload = raw ?? (json ? encodeRequest(this.version, cmd, json, this.#key()) : Buffer.alloc(0))
    const frame =
      this.version === '3.5'
        ? packFrame({ format: '6699', seq: this.#seq++, cmd, payload, key: this.#key(), retcode: 0 })
        : packFrame({ format: '55aa', seq: this.#seq++, cmd, payload, key: this.version === '3.4' ? this.#key() : null, retcode: 0 })
    socket.write(frame)
  }

  #serve(socket: Socket): void {
    this.sockets.add(socket)
    this.sessionKey = null
    let localNonce: Buffer = Buffer.alloc(0)
    let remoteNonce: Buffer = Buffer.alloc(0)
    const reader = new TuyaReader({ key: () => this.#key(), hmac: this.version === '3.4', retcode: false })
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => undefined)
    socket.on('data', (chunk) => {
      for (const frame of reader.read(chunk)) {
        if (!frame.valid) return void socket.destroy()
        if (frame.cmd === COMMAND.sessKeyNegStart) {
          localNonce = this.version === '3.4' ? aesEcbDecrypt(this.key, frame.payload) : frame.payload
          remoteNonce = randomBytes(16)
          const proof = createHmac('sha256', this.key).update(localNonce).digest()
          const answer = Buffer.concat([remoteNonce, proof])
          this.#send(socket, COMMAND.sessKeyNegResp, null, this.version === '3.4' ? aesEcbEncrypt(this.key, answer) : answer)
          continue
        }
        if (frame.cmd === COMMAND.sessKeyNegFinish) {
          const finish = this.version === '3.4' ? aesEcbDecrypt(this.key, frame.payload) : frame.payload
          if (!finish.equals(createHmac('sha256', this.key).update(remoteNonce).digest())) return void socket.destroy()
          const mixed = Buffer.from(localNonce.map((byte, index) => byte ^ remoteNonce[index]!))
          if (this.version === '3.4') {
            this.sessionKey = aesEcbEncrypt(this.key, mixed, false)
          } else {
            const cipher = createCipheriv('aes-128-gcm', this.key, localNonce.subarray(0, 12))
            this.sessionKey = Buffer.concat([cipher.update(mixed), cipher.final()])
          }
          continue
        }
        const json = decodeResponse(this.version, frame.payload, this.#key())
        this.received.push({ cmd: frame.cmd, json })
        this.#handle(socket, frame.cmd, json)
      }
    })
  }

  #handle(socket: Socket, cmd: number, json: Record<string, unknown> | null): void {
    switch (cmd) {
      case COMMAND.heartbeat:
        return this.#send(socket, COMMAND.heartbeat, null)
      case COMMAND.dpQuery:
        if (this.device22) return this.#send(socket, COMMAND.dpQuery, null, aesEcbEncrypt(this.#key(), Buffer.from('json obj data unvalid')))
        return this.#send(socket, COMMAND.dpQuery, { devId: this.id, dps: this.dps })
      case COMMAND.dpQueryNew:
        return this.#send(socket, COMMAND.dpQueryNew, { protocol: 4, t: 1, data: { dps: this.dps } })
      case COMMAND.control:
      case COMMAND.controlNew: {
        const asked = ((json?.dps ?? (json?.data as { dps?: Dps } | undefined)?.dps ?? {}) as Dps)
        // 22-character-id devices are asked for their status with the points set to null.
        if (Object.values(asked).every((value) => value === null)) return this.#send(socket, COMMAND.status, { dps: this.dps, t: 1 })
        Object.assign(this.dps, asked)
        this.#send(socket, cmd, null)
        return this.#send(socket, COMMAND.status, this.version === '3.3' ? { dps: asked, t: 1 } : { protocol: 4, t: 1, data: { dps: asked } })
      }
      default:
        return
    }
  }
}

const PLUG_ID = 'bf0000000000000000plug'
const BULB_ID = 'bf0000000000000000bulb'
const COVER_ID = 'bf00000000000000curtain'
const KEYS = {
  plug: Buffer.from('plugkey012345678'),
  bulb: Buffer.from('bulbkey012345678'),
  cover: Buffer.from('coverkey01234567'),
}

let context: RecordingContext
let adapter: TuyaAdapter
let devices: FakeTuyaDevice[]

async function device(id: string, version: TuyaVersion, key: Buffer, dps: Dps): Promise<FakeTuyaDevice> {
  const fake = new FakeTuyaDevice(id, version, key, dps)
  await fake.start()
  devices.push(fake)
  return fake
}

function makeAdapter(tcpPort: number, extra: Partial<TuyaOptions> = {}): TuyaAdapter {
  return new TuyaAdapter({ udpPorts: [0, 0, 0], tcpPort, broadcastAddress: '127.0.0.1', requestTimeoutMs: 400, heartbeatMs: 60_000, reconnectMs: 30, listenMs: 300, ...extra })
}

function keys(entries: Record<string, unknown>): Record<string, unknown> {
  return { localKeys: JSON.stringify(entries) }
}

beforeEach(() => {
  context = recordingContext()
  devices = []
})

afterEach(async () => {
  await adapter?.shutdown()
  for (const fake of devices) fake.stop()
})

describe('three versions of the protocol', () => {
  test('3.3: a plug found by its announcement, with its switch and its power', async () => {
    const plug = await device(PLUG_ID, '3.3', KEYS.plug, { 1: true, 18: 1200, 19: 2543, 20: 2301 })
    adapter = makeAdapter(plug.port)
    await adapter.init(context, keys({ [PLUG_ID]: { key: KEYS.plug.toString(), name: 'Prise salon' } }))
    plug.announce(adapter.listeningPorts()[1]!)

    const [found] = await adapter.discover([])
    expect(found).toMatchObject({ nativeId: PLUG_ID, name: 'Prise salon', category: 'outlet', capabilities: ['onoff', 'power'], requiresPairing: null })
    await eventually(() => context.stateOf(PLUG_ID).power === 254.3)
    expect(context.stateOf(PLUG_ID)).toMatchObject({ on: true, voltage: 230.1, current: 1.2 })

    expect((await adapter.execute(PLUG_ID, 'turnOff', {})).ok).toBe(true)
    expect(plug.dps['1']).toBe(false)
    await eventually(() => context.stateOf(PLUG_ID).on === false)
  })

  test('3.4: a bulb, after a session key, dims and changes colour', async () => {
    const bulb = await device(BULB_ID, '3.4', KEYS.bulb, { 20: true, 21: 'white', 22: 505, 23: 0, 24: '000003e803e8' })
    adapter = makeAdapter(bulb.port)
    await adapter.init(context, keys({ [BULB_ID]: { key: KEYS.bulb.toString(), ip: '127.0.0.1', version: '3.4' } }))
    const [found] = await adapter.discover([])
    expect(found).toMatchObject({ category: 'light', capabilities: ['onoff', 'brightness', 'colorTemperature', 'color'] })
    await eventually(() => context.stateOf(BULB_ID).brightness === 50)
    expect(bulb.sessionKey).not.toBeNull()

    expect((await adapter.execute(BULB_ID, 'setBrightness', { brightness: 100 })).ok).toBe(true)
    expect(bulb.dps['22']).toBe(1000)
    expect((await adapter.execute(BULB_ID, 'setColorName', { name: 'bleu' })).ok).toBe(true)
    expect(bulb.dps['21']).toBe('colour')
    await eventually(() => context.stateOf(BULB_ID).hue === 220)
  })

  test('3.5: a curtain over AES-GCM, found when asked to speak', async () => {
    const cover = await device(COVER_ID, '3.5', KEYS.cover, { 1: 'stop', 2: 0, 3: 0 })
    const requestPort = await cover.listenForRequests(() => adapter.listeningPorts()[2]!)
    adapter = makeAdapter(cover.port, { broadcastPort: requestPort })
    await adapter.init(context, keys({ [COVER_ID]: { key: KEYS.cover.toString(), name: 'Rideau chambre' } }))

    const [found] = await adapter.discover([])
    expect(found).toMatchObject({ nativeId: COVER_ID, category: 'cover', capabilities: ['position'] })
    await eventually(() => context.stateOf(COVER_ID).position === 0)
    expect((await adapter.execute(COVER_ID, 'setPosition', { position: 40 })).ok).toBe(true)
    expect(cover.dps['2']).toBe(40)
  })

  test('22-character-id devices that refuse the plain query are asked with their points', async () => {
    const plug = await device(PLUG_ID, '3.3', KEYS.plug, { 1: false, 19: 0 })
    plug.device22 = true
    adapter = makeAdapter(plug.port)
    await adapter.init(context, keys({ [PLUG_ID]: { key: KEYS.plug.toString(), ip: '127.0.0.1', version: '3.3' } }))
    await adapter.discover([])
    await eventually(() => context.stateOf(PLUG_ID).on === false)
    expect(plug.received.some((entry) => entry.cmd === COMMAND.controlNew)).toBe(true)
  })
})

describe('living with the devices', () => {
  test('the button on the plug shows up in the app', async () => {
    const plug = await device(PLUG_ID, '3.3', KEYS.plug, { 1: true, 19: 100 })
    adapter = makeAdapter(plug.port)
    await adapter.init(context, keys({ [PLUG_ID]: { key: KEYS.plug.toString(), ip: '127.0.0.1', version: '3.3' } }))
    await adapter.discover([])
    await eventually(() => context.stateOf(PLUG_ID).on === true)
    plug.press({ 1: false })
    await eventually(() => context.stateOf(PLUG_ID).on === false)
  })

  test('a dropped connection is opened again', async () => {
    const bulb = await device(BULB_ID, '3.4', KEYS.bulb, { 20: true, 22: 1000 })
    adapter = makeAdapter(bulb.port)
    await adapter.init(context, keys({ [BULB_ID]: { key: KEYS.bulb.toString(), ip: '127.0.0.1', version: '3.4' } }))
    await adapter.discover([])
    await eventually(() => context.stateOf(BULB_ID).brightness === 100)
    bulb.dropConnections()
    // Connected again: a new session key, and the status asked again.
    await eventually(() => bulb.sockets.size === 1 && bulb.received.filter((entry) => entry.cmd === COMMAND.dpQueryNew).length >= 2)
    bulb.press({ 22: 505 })
    await eventually(() => context.stateOf(BULB_ID).brightness === 50)
  })

  test('a wrong local key is said in words, for that device', async () => {
    const bulb = await device(BULB_ID, '3.4', KEYS.bulb, { 20: true, 22: 1000 })
    adapter = makeAdapter(bulb.port)
    await adapter.init(context, keys({ [BULB_ID]: { key: 'wrongkey01234567', ip: '127.0.0.1', version: '3.4' } }))
    await adapter.discover([])
    await eventually(() => /clé locale/.test(adapter.status().message ?? ''))
    expect(adapter.status().health).toBe('degraded')
    const result = await adapter.execute(BULB_ID, 'turnOff', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/clé locale/)
  })

  test('a device announced without its key asks for it', async () => {
    const plug = await device(PLUG_ID, '3.3', KEYS.plug, { 1: true })
    adapter = makeAdapter(plug.port)
    await adapter.init(context, {})
    plug.announce(adapter.listeningPorts()[1]!)
    const [found] = await adapter.discover([])
    expect(found).toMatchObject({ nativeId: PLUG_ID, requiresPairing: { kind: 'token' } })
    expect(found?.requiresPairing?.instructions).toMatch(/clé locale/)
    expect(adapter.status()).toMatchObject({ health: 'needs_setup' })
  })

  test('a broken settings map: which device, never the key', async () => {
    adapter = makeAdapter(1)
    await adapter.init(context, { localKeys: JSON.stringify({ bf1: 'secret-but-short' }) })
    expect(adapter.status().health).toBe('degraded')
    expect(adapter.status().message).toContain('bf1')
    expect(adapter.status().message).not.toContain('secret')
  })

  test('the heartbeat keeps the connection busy', async () => {
    const plug = await device(PLUG_ID, '3.3', KEYS.plug, { 1: true })
    adapter = makeAdapter(plug.port, { heartbeatMs: 40 })
    await adapter.init(context, keys({ [PLUG_ID]: { key: KEYS.plug.toString(), ip: '127.0.0.1', version: '3.3' } }))
    await adapter.discover([])
    await eventually(() => plug.received.filter((entry) => entry.cmd === COMMAND.heartbeat).length >= 2)
  })
})
