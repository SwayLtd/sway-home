/**
 * The KNX adapter against a gateway that speaks real KNXnet/IP over UDP.
 *
 * The fake gateway answers searches, holds a limited number of tunnels, acknowledges every
 * tunnelled frame and confirms each telegram (L_Data.con) the way an IP interface does, and
 * stands in for the bus behind it: actuators answer reads from their status addresses and
 * echo their new state after a write, and a push button on the wall can be pressed.
 *
 * What is pinned down is what a person notices: the gateway is found without typing its
 * address, the lights show their real state, a switch on the wall shows up in the app, a
 * command is either confirmed by the bus or said to have failed, and a gateway that restarts
 * does not leave the house deaf.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createSocket, type Socket } from 'node:dgram'
import { KnxAdapter, type KnxOptions } from '#adapters/knx'
import {
  KNX_SERVICE,
  connectResponse,
  connectionStateResponse,
  decodeCemi,
  disconnectResponse,
  lData,
  parseFrame,
  parseGroupAddress,
  tunnellingAck,
  tunnellingRequest,
  type Endpoint,
} from '#adapters/knx_codec'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'

const ga = (text: string) => parseGroupAddress(text)!

class FakeGateway {
  socket: Socket = createSocket('udp4')
  endpoint: Endpoint = { ip: '127.0.0.1', port: 0 }
  channel = 7
  maxConnections = 1
  connected: Endpoint | null = null
  connections = 0
  searches = 0
  disconnects = 0
  heartbeats = 0
  /** The bus: the last value on each group address. */
  bus = new Map<number, Buffer>()
  /** Write address -> status address, for actuators that echo their state. */
  echoes = new Map<number, number>()
  written: { address: string; data: string }[] = []
  tunnelled = 0
  dropAcks = 0
  confirmError = false
  #expected = 0
  #outgoing = 0

  async start(): Promise<void> {
    this.socket.on('message', (message, remote) => this.#onMessage(message, { ip: remote.address, port: remote.port }))
    await new Promise<void>((resolve) => this.socket.bind(0, '127.0.0.1', resolve))
    this.endpoint = { ip: '127.0.0.1', port: this.socket.address().port }
  }

  stop(): void {
    try {
      this.socket.close()
    } catch {
      // Already closed.
    }
  }

  /** Forget every tunnel, as a gateway does when it restarts. */
  restart(): void {
    this.connected = null
    this.channel += 1
    this.#expected = 0
    this.#outgoing = 0
  }

  /** A push button on the wall writes to the bus. */
  press(address: number, data: Buffer, small = true): void {
    this.bus.set(address, data)
    this.#toClient(lData({ code: 'indication', source: 0x1103, destination: address, service: 'write', data, small }))
  }

  #send(frame: Buffer, to: Endpoint): void {
    this.socket.send(frame, to.port, to.ip)
  }

  #toClient(cemi: Buffer): void {
    if (!this.connected) return
    this.#send(tunnellingRequest(this.channel, this.#outgoing, cemi), this.connected)
    this.#outgoing = (this.#outgoing + 1) & 0xff
  }

  #onMessage(message: Buffer, remote: Endpoint): void {
    if (message.readUInt16BE(2) === KNX_SERVICE.searchRequest) {
      this.searches += 1
      return this.#send(this.#searchResponse(), remote)
    }
    const frame = parseFrame(message)
    if (!frame) return
    switch (frame.service) {
      case KNX_SERVICE.connectRequest: {
        if (this.connected || this.maxConnections === 0) return this.#send(connectResponse(0, 0x24), remote)
        this.connections += 1
        this.connected = frame.data && frame.data.ip !== '0.0.0.0' ? frame.data : remote
        this.#expected = 0
        this.#outgoing = 0
        return this.#send(connectResponse(this.channel, 0, this.endpoint, 0x11fa), remote)
      }
      case KNX_SERVICE.connectionStateRequest:
        this.heartbeats += 1
        return this.#send(connectionStateResponse(frame.channel, this.connected && frame.channel === this.channel ? 0 : 0x21), remote)
      case KNX_SERVICE.disconnectRequest:
        this.disconnects += 1
        if (frame.channel === this.channel) this.connected = null
        return this.#send(disconnectResponse(frame.channel), remote)
      case KNX_SERVICE.tunnellingRequest: {
        if (!this.connected || frame.channel !== this.channel) return
        this.tunnelled += 1
        if (this.dropAcks > 0) {
          this.dropAcks -= 1
          return
        }
        this.#send(tunnellingAck(this.channel, frame.sequence), this.connected)
        // A repeated frame is acknowledged again but not passed to the bus twice.
        if (frame.sequence !== this.#expected) return
        this.#expected = (this.#expected + 1) & 0xff
        return this.#onTelegram(frame.cemi)
      }
      default:
        return
    }
  }

  #onTelegram(cemi: Buffer): void {
    const telegram = decodeCemi(cemi)
    if (!telegram || telegram.code !== 'request') return
    const confirmation = Buffer.from(cemi)
    confirmation[0] = 0x2e
    if (this.confirmError) confirmation[2] = confirmation[2]! | 0x01
    setTimeout(() => this.#toClient(confirmation), 5)
    if (this.confirmError) return

    if (telegram.service === 'write') {
      this.written.push({ address: `${telegram.destination >> 11}/${(telegram.destination >> 8) & 7}/${telegram.destination & 0xff}`, data: telegram.data.toString('hex') })
      this.bus.set(telegram.destination, telegram.data)
      const status = this.echoes.get(telegram.destination)
      if (status !== undefined) {
        this.bus.set(status, telegram.data)
        setTimeout(() => this.#toClient(lData({ code: 'indication', source: 0x1105, destination: status, service: 'write', data: telegram.data, small: telegram.small })), 10)
      }
    }
    if (telegram.service === 'read') {
      const value = this.bus.get(telegram.destination)
      if (!value) return
      setTimeout(() => this.#toClient(lData({ code: 'indication', source: 0x1105, destination: telegram.destination, service: 'response', data: value, small: value.length === 1 && value[0]! <= 0x3f && this.#isBit(telegram.destination) })), 10)
    }
  }

  #isBit(address: number): boolean {
    return [ga('1/1/2'), ga('4/1/1'), ga('1/1/1')].includes(address)
  }

  #searchResponse(): Buffer {
    const name = Buffer.alloc(30)
    name.write('Fake IP Interface', 'latin1')
    const deviceInfo = Buffer.concat([
      Buffer.from([0x36, 0x01, 0x02, 0x00, 0x11, 0x00, 0x00, 0x00]),
      Buffer.from('0083a1b2c3d4', 'hex'),
      Buffer.from([224, 0, 23, 12]),
      Buffer.from('cc1be0801234', 'hex'),
      name,
    ])
    const families = Buffer.from([0x06, 0x02, 0x02, 0x02, 0x04, 0x02])
    const hpai = Buffer.from([0x08, 0x01, 127, 0, 0, 1, this.endpoint.port >> 8, this.endpoint.port & 0xff])
    const body = Buffer.concat([hpai, deviceInfo, families])
    return Buffer.concat([Buffer.from([0x06, 0x10, 0x02, 0x02, 0x00, 6 + body.length]), body])
  }
}

const MAP = JSON.stringify([
  { device: 'Plafonnier salon', role: 'onoff', write: '1/1/1', status: '1/1/2' },
  { device: 'Plafonnier salon', role: 'brightness', write: '1/1/3', status: '1/1/4' },
  { device: 'Thermostat bureau', role: 'temperature', status: '3/1/1' },
  { device: 'Thermostat bureau', role: 'setpoint', write: '3/1/2', status: '3/1/3' },
  { device: 'Fenêtre cuisine', role: 'contact', status: '4/1/1' },
])

let gateway: FakeGateway
let context: RecordingContext
let adapter: KnxAdapter

function makeAdapter(extra: Partial<KnxOptions> = {}): KnxAdapter {
  return new KnxAdapter({
    searchTargets: [gateway.endpoint],
    localIp: '127.0.0.1',
    searchMs: 150,
    requestTimeoutMs: 300,
    ackTimeoutMs: 100,
    confirmTimeoutMs: 300,
    heartbeatMs: 60_000,
    reconnectMs: 50,
    readSpacingMs: 0,
    ...extra,
  })
}

beforeEach(async () => {
  gateway = new FakeGateway()
  await gateway.start()
  gateway.bus.set(ga('1/1/2'), Buffer.from([0x01]))
  gateway.bus.set(ga('1/1/4'), Buffer.from([0x80]))
  gateway.bus.set(ga('3/1/1'), Buffer.from([0x0c, 0x33]))
  gateway.bus.set(ga('3/1/3'), Buffer.from([0x07, 0xd0]))
  gateway.bus.set(ga('4/1/1'), Buffer.from([0x00]))
  gateway.echoes.set(ga('1/1/1'), ga('1/1/2'))
  gateway.echoes.set(ga('1/1/3'), ga('1/1/4'))
  gateway.echoes.set(ga('3/1/2'), ga('3/1/3'))
  context = recordingContext()
})

afterEach(async () => {
  await adapter?.shutdown()
  gateway.stop()
})

describe('the gateway', () => {
  test('found by itself; the map comes alive with the state read from the bus', async () => {
    adapter = makeAdapter()
    await adapter.init(context, { points: MAP })
    await eventually(() => context.stateOf('knx:plafonnier-salon').brightness === 50)
    expect(context.stateOf('knx:plafonnier-salon')).toEqual({ on: true, brightness: 50 })
    await eventually(() => context.stateOf('knx:thermostat-bureau').targetTemperature === 20)
    expect(context.stateOf('knx:thermostat-bureau')).toMatchObject({ temperature: 21.5, currentTemperature: 21.5 })
    await eventually(() => context.stateOf('knx:fenetre-cuisine').open === false)

    const devices = await adapter.discover([])
    expect(devices.map((device) => [device.nativeId, device.category])).toEqual([
      ['knx:plafonnier-salon', 'light'],
      ['knx:thermostat-bureau', 'climate'],
      ['knx:fenetre-cuisine', 'sensor'],
    ])
    expect(adapter.status()).toMatchObject({ health: 'ok' })
  })

  test('the address given in the settings is used without searching', async () => {
    adapter = makeAdapter({ searchTargets: [] })
    await adapter.init(context, { points: MAP, gateway: `127.0.0.1:${gateway.endpoint.port}` })
    await eventually(() => context.stateOf('knx:plafonnier-salon').on === true)
    expect(gateway.searches).toBe(0)
  })

  test('without a map, the gateway is found but no tunnel is held', async () => {
    adapter = makeAdapter()
    await adapter.init(context, {})
    await eventually(() => /adresses de groupe/.test(adapter.status().message ?? ''))
    expect(adapter.status().message).toContain('Fake IP Interface')
    expect(gateway.connections).toBe(0)
  })

  test('no gateway anywhere: said plainly', async () => {
    gateway.stop()
    adapter = makeAdapter()
    await adapter.init(context, { points: MAP })
    await eventually(() => adapter.status().health === 'needs_setup')
    expect(adapter.status().message).toMatch(/passerelle/i)
  })

  test('a gateway with every tunnel taken: the status says why', async () => {
    gateway.maxConnections = 0
    adapter = makeAdapter()
    await adapter.init(context, { points: MAP })
    await eventually(() => /liaisons/.test(adapter.status().message ?? ''))
    expect(adapter.status().health).toBe('degraded')
  })

  test('a gateway that restarts: the tunnel comes back by itself', async () => {
    adapter = makeAdapter({ heartbeatMs: 80 })
    await adapter.init(context, { points: MAP })
    await eventually(() => context.stateOf('knx:plafonnier-salon').on === true)
    gateway.restart()
    await eventually(() => gateway.connections === 2 && adapter.status().health === 'ok')
    expect((await adapter.execute('knx:plafonnier-salon', 'turnOff', {})).ok).toBe(true)
    expect(gateway.bus.get(ga('1/1/1'))).toEqual(Buffer.from([0x00]))
  })

  test('shutting down closes the tunnel on the gateway too', async () => {
    adapter = makeAdapter()
    await adapter.init(context, { points: MAP })
    await eventually(() => gateway.connected !== null)
    await adapter.shutdown()
    expect(gateway.disconnects).toBe(1)
    expect(gateway.connected).toBeNull()
  })
})

describe('the bus', () => {
  async function ready(): Promise<void> {
    adapter = makeAdapter()
    await adapter.init(context, { points: MAP })
    await eventually(() => context.stateOf('knx:plafonnier-salon').on === true)
  }

  test('a light switched from the hub is written, confirmed, and its echo heard', async () => {
    await ready()
    const result = await adapter.execute('knx:plafonnier-salon', 'turnOff', {})
    expect(result).toMatchObject({ ok: true, undo: { command: 'turnOn', args: {} } })
    expect(gateway.written).toContainEqual({ address: '1/1/1', data: '00' })
    await eventually(() => context.stateOf('knx:plafonnier-salon').on === false)

    expect((await adapter.execute('knx:thermostat-bureau', 'setTargetTemperature', { celsius: 21.5 })).ok).toBe(true)
    expect(gateway.written).toContainEqual({ address: '3/1/2', data: '0c33' })
  })

  test('a push button on the wall shows up in the app', async () => {
    await ready()
    gateway.press(ga('1/1/2'), Buffer.from([0x00]))
    await eventually(() => context.stateOf('knx:plafonnier-salon').on === false)
    gateway.press(ga('4/1/1'), Buffer.from([0x01]))
    await eventually(() => context.stateOf('knx:fenetre-cuisine').open === true)
  })

  test('a lost acknowledgement is repeated once, and the bus sees the telegram once', async () => {
    await ready()
    const before = gateway.written.length
    gateway.dropAcks = 1
    expect((await adapter.execute('knx:plafonnier-salon', 'turnOff', {})).ok).toBe(true)
    expect(gateway.written.length - before).toBe(1)
  })

  test('a telegram the bus does not confirm is a failed command, with a reason', async () => {
    await ready()
    gateway.confirmError = true
    const result = await adapter.execute('knx:plafonnier-salon', 'turnOff', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/confirm/i)
  })

  test('what a device cannot do is refused before the bus', async () => {
    await ready()
    const tunnelled = gateway.tunnelled
    const result = await adapter.execute('knx:fenetre-cuisine', 'turnOn', {})
    expect(result).toMatchObject({ ok: false, error: 'Fenêtre cuisine ne sait pas faire "turnOn".' })
    expect(gateway.tunnelled).toBe(tunnelled)
  })
})
