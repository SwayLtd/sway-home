/**
 * The LIFX adapter against simulated bulbs.
 *
 * The fake network below speaks the real wire format through the same codec the adapter
 * uses, so these tests exercise discovery, request/response matching, acknowledgements and
 * retries exactly as a real bulb would see them - minus the radio. What they pin down is the
 * behaviour a user notices: a bulb is found with its own name, a brightness change keeps the
 * colour, and a bulb that stops answering fails clearly instead of hanging the agent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { LifxAdapter, type LifxTransport } from '#adapters/lifx'
import {
  LIFX_PORT,
  LIFX_TYPE,
  decodeLifx,
  encodeLifx,
  lightStatePayload,
  targetFromMac,
  type DecodedLifx,
  type Hsbk,
} from '#adapters/lifx_codec'
import type { AdapterContext, NetworkHost } from '@sway-home/shared'

class FakeBulb {
  hsbk: Hsbk = { hue: 0, saturation: 0, brightness: 65535, kelvin: 3500 }
  power = 0
  received: DecodedLifx[] = []
  /** Packets to ignore before answering again, to exercise retries. */
  dropNext = 0
  silent = false

  constructor(
    readonly mac: string,
    readonly ip: string,
    public label: string
  ) {}

  handle(packet: DecodedLifx, reply: (bytes: Uint8Array) => void): void {
    this.received.push(packet)
    if (this.silent) return
    if (this.dropNext > 0) {
      this.dropNext -= 1
      return
    }
    const answer = (type: number, payload?: Uint8Array) =>
      reply(encodeLifx({ type, source: packet.source, sequence: packet.sequence, target: targetFromMac(this.mac), payload }))

    switch (packet.type) {
      case LIFX_TYPE.GetService: {
        const payload = new Uint8Array(5)
        payload[0] = 1
        new DataView(payload.buffer).setUint32(1, LIFX_PORT, true)
        answer(LIFX_TYPE.StateService, payload)
        break
      }
      case LIFX_TYPE.GetColor:
        answer(LIFX_TYPE.LightState, lightStatePayload(this.hsbk, this.power, this.label))
        break
      case LIFX_TYPE.SetColor: {
        const view = new DataView(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength)
        this.hsbk = { hue: view.getUint16(1, true), saturation: view.getUint16(3, true), brightness: view.getUint16(5, true), kelvin: view.getUint16(7, true) }
        if (packet.ackRequired) answer(LIFX_TYPE.Acknowledgement)
        break
      }
      case LIFX_TYPE.SetLightPower: {
        this.power = new DataView(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength).getUint16(0, true)
        if (packet.ackRequired) answer(LIFX_TYPE.Acknowledgement)
        break
      }
      default:
        break
    }
  }
}

class FakeNetwork implements LifxTransport {
  bulbs: FakeBulb[] = []
  #handler: ((bytes: Uint8Array, ip: string) => void) | null = null
  /** Something else on the LAN answering on the same port with bytes that are not LIFX. */
  noise = false

  send(bytes: Uint8Array, ip: string): void {
    const bulb = this.bulbs.find((candidate) => candidate.ip === ip)
    const packet = decodeLifx(bytes)
    if (!bulb || !packet) return
    bulb.handle(packet, (reply) => queueMicrotask(() => this.#handler?.(reply, bulb.ip)))
  }

  broadcast(bytes: Uint8Array): void {
    if (this.noise) queueMicrotask(() => this.#handler?.(new Uint8Array([9, 9, 9, 9]), '192.168.1.99'))
    for (const bulb of this.bulbs) this.send(bytes, bulb.ip)
  }

  onMessage(handler: (bytes: Uint8Array, ip: string) => void): void {
    this.#handler = handler
  }

  close(): void {
    this.#handler = null
  }
}

function context(): AdapterContext {
  const store = new Map<string, unknown>()
  return {
    emitState: () => undefined,
    emitEvent: () => undefined,
    emitAvailability: () => undefined,
    emitDiscovered: () => undefined,
    log: () => undefined,
    store: {
      get: async <T,>(key: string) => (store.get(key) as T) ?? null,
      set: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
    },
    network: { localIp: '192.168.1.10', cidr: '192.168.1.0/24', gateway: '192.168.1.1', interfaceName: 'test' },
    signal: new AbortController().signal,
  }
}

let network: FakeNetwork
let adapter: LifxAdapter
let bulb: FakeBulb

beforeEach(async () => {
  network = new FakeNetwork()
  bulb = new FakeBulb('d0:73:d5:00:13:37', '192.168.1.40', 'Lampe salon')
  network.bulbs.push(bulb)
  adapter = new LifxAdapter({ transport: network, timeoutMs: 40, retries: 2, discoveryMs: 30 })
  await adapter.init(context(), {})
})

// The adapter polls on an interval; a test that leaves it running keeps the process alive.
afterEach(async () => {
  await adapter.shutdown()
})

describe('discovery', () => {
  test('finds a bulb by broadcast, named by its own label', async () => {
    const found = await adapter.discover([])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      adapterId: 'lifx',
      nativeId: 'd0:73:d5:00:13:37',
      uid: 'lifx:d073d5001337',
      name: 'Lampe salon',
      category: 'light',
      network: { ip: '192.168.1.40', mac: 'd0:73:d5:00:13:37' },
    })
    expect(found[0]!.capabilities).toEqual(expect.arrayContaining(['onoff', 'brightness', 'color', 'colorTemperature']))
  })

  test('finds several bulbs in one pass', async () => {
    network.bulbs.push(new FakeBulb('d0:73:d5:aa:bb:cc', '192.168.1.41', 'Chevet'))
    const found = await adapter.discover([])
    expect(found.map((device) => device.name).sort()).toEqual(['Chevet', 'Lampe salon'])
  })

  test('ignores whatever else answers on the port', async () => {
    network.noise = true
    expect(await adapter.discover([])).toHaveLength(1)
  })

  test('a scanned host with a LIFX MAC is probed directly, for networks that drop broadcast', async () => {
    const hosts = [{ ip: '192.168.1.40', mac: 'd0:73:d5:00:13:37', openPorts: [], hostname: null } as unknown as NetworkHost]
    const direct = new LifxAdapter({ transport: { ...network, broadcast: () => undefined, send: network.send.bind(network), onMessage: network.onMessage.bind(network), close: () => undefined }, timeoutMs: 40, retries: 1, discoveryMs: 30 })
    await direct.init(context(), {})
    expect(await direct.discover(hosts)).toHaveLength(1)
  })
})

describe('state', () => {
  test('reads power, brightness and colour in the house vocabulary', async () => {
    await adapter.discover([])
    bulb.power = 65535
    bulb.hsbk = { hue: 21845, saturation: 65535, brightness: 32768, kelvin: 3500 }
    const state = await adapter.getState(bulb.mac)
    expect(state).toMatchObject({ on: true, brightness: 50, hue: 120, saturation: 100 })
  })

  test('a white bulb reports its colour temperature', async () => {
    await adapter.discover([])
    bulb.hsbk = { hue: 0, saturation: 0, brightness: 65535, kelvin: 2700 }
    expect(await adapter.getState(bulb.mac)).toMatchObject({ colorTemperature: 2700 })
  })
})

describe('commands', () => {
  beforeEach(async () => {
    await adapter.discover([])
  })

  test('turnOn switches the bulb on and says how to undo it', async () => {
    const result = await adapter.execute(bulb.mac, 'turnOn', { transitionMs: 500 })
    expect(result.ok).toBe(true)
    expect(bulb.power).toBe(65535)
    expect(result.undo).toEqual({ command: 'turnOff', args: {} })
  })

  test('turnOff switches it off', async () => {
    bulb.power = 65535
    await adapter.execute(bulb.mac, 'turnOff', {})
    expect(bulb.power).toBe(0)
  })

  test('a brightness change keeps the colour it had', async () => {
    bulb.hsbk = { hue: 43690, saturation: 65535, brightness: 65535, kelvin: 3500 }
    await adapter.execute(bulb.mac, 'setBrightness', { brightness: 25 })
    expect(bulb.hsbk).toMatchObject({ hue: 43690, saturation: 65535, brightness: Math.round(0xffff * 0.25) })
  })

  test('setColor speaks degrees and percent, the wire gets Uint16s', async () => {
    await adapter.execute(bulb.mac, 'setColor', { hue: 120, saturation: 100 })
    expect(bulb.hsbk.hue).toBe(21845)
    expect(bulb.hsbk.saturation).toBe(65535)
  })

  test('a colour temperature is white: saturation goes to zero', async () => {
    bulb.hsbk = { hue: 21845, saturation: 65535, brightness: 65535, kelvin: 3500 }
    await adapter.execute(bulb.mac, 'setColorTemperature', { kelvin: 2700 })
    expect(bulb.hsbk).toMatchObject({ saturation: 0, kelvin: 2700 })
  })

  test('setting a colour on a bulb that is off turns it on, as every other light does', async () => {
    bulb.power = 0
    await adapter.execute(bulb.mac, 'setColor', { hue: 240, saturation: 100 })
    expect(bulb.power).toBe(65535)
  })

  test('a lost packet is retried, and the command still succeeds', async () => {
    bulb.dropNext = 1
    const result = await adapter.execute(bulb.mac, 'turnOn', {})
    expect(result.ok).toBe(true)
    expect(bulb.power).toBe(65535)
  })

  test('a bulb that stops answering fails clearly instead of hanging', async () => {
    bulb.silent = true
    const started = Date.now()
    const result = await adapter.execute(bulb.mac, 'turnOn', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/répond|answer/i)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('an unknown bulb is refused, not guessed', async () => {
    const result = await adapter.execute('d0:73:d5:ff:ff:ff', 'turnOn', {})
    expect(result.ok).toBe(false)
  })

  test('an unsupported command is refused by name', async () => {
    const result = await adapter.execute(bulb.mac, 'lock', {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain('lock')
  })
})

describe('the descriptor', () => {
  test('is implemented, local and zero-config', () => {
    expect(adapter.descriptor).toMatchObject({ id: 'lifx', implemented: true, cloud: false, zeroConfig: true })
  })
})
