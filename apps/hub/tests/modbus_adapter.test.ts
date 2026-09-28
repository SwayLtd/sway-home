/**
 * The Modbus adapter against a device that speaks real Modbus TCP.
 *
 * The fake device keeps register banks per unit id and answers like the firmware: registers
 * that do not exist are exception 2, a unit id nobody answers for is exception 11 behind a
 * gateway (or silence), and a device can answer every unit id with the same data, as many
 * inverters do.
 *
 * What is pinned down is what a person notices: a solar inverter and its meter show up after
 * a scan with their real names and live readings, with nothing to configure; a heat pump
 * mapped by hand can be read, set and switched; mistakes in the map are said point by point;
 * a device that stops answering goes offline and comes back.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'
import type { NetworkHost } from '@sway-home/shared'
import { ModbusAdapter } from '#adapters/modbus'
import { AduReader, encodeValue, frame } from '#adapters/modbus_codec'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'

interface Bank {
  holding: Map<number, number>
  input: Map<number, number>
  coils: Map<number, boolean>
}

const emptyBank = (): Bank => ({ holding: new Map(), input: new Map(), coils: new Map() })

class FakeModbus {
  server: Server | null = null
  sockets = new Set<Socket>()
  units = new Map<number, Bank>()
  /** Every unit id gets unit 1's answers, as many inverters do. */
  anyUnit = false
  /** Unit ids that never answer (no gateway in between to say so). */
  silentUnits = new Set<number>()
  silent = false
  refuseWrites = new Set<number>()
  requests: { unit: number; code: number; address: number }[] = []

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.add(socket)
      const reader = new AduReader()
      socket.on('data', (chunk) => {
        for (const adu of reader.push(chunk)) this.#answer(socket, adu.transactionId, adu.unitId, adu.pdu)
      })
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
  }

  get port(): number {
    return (this.server!.address() as { port: number }).port
  }

  stop(): void {
    for (const socket of this.sockets) socket.destroy()
    this.server?.close()
  }

  bank(unit: number): Bank {
    if (!this.units.has(unit)) this.units.set(unit, emptyBank())
    return this.units.get(unit)!
  }

  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  #answer(socket: Socket, transactionId: number, unit: number, pdu: Buffer): void {
    const code = pdu[0]!
    const address = pdu.readUInt16BE(1)
    this.requests.push({ unit, code, address })
    if (this.silent || this.silentUnits.has(unit)) return
    const reply = (body: number[] | Buffer): void => void socket.write(frame(transactionId, unit, Buffer.isBuffer(body) ? body : Buffer.from(body)))
    const bank = this.anyUnit ? this.units.get(1) : this.units.get(unit)
    if (!bank) return reply([code | 0x80, 0x0b])

    switch (code) {
      case 0x03:
      case 0x04: {
        const count = pdu.readUInt16BE(3)
        const table = code === 0x03 ? bank.holding : bank.input
        const values: number[] = []
        for (let index = 0; index < count; index++) {
          const value = table.get(address + index)
          if (value === undefined) return reply([code | 0x80, 0x02])
          values.push(value)
        }
        const body = Buffer.alloc(2 + count * 2)
        body[0] = code
        body[1] = count * 2
        values.forEach((value, index) => body.writeUInt16BE(value, 2 + index * 2))
        return reply(body)
      }
      case 0x01: {
        const count = pdu.readUInt16BE(3)
        const bytes = Buffer.alloc(Math.ceil(count / 8))
        for (let index = 0; index < count; index++) {
          const value = bank.coils.get(address + index)
          if (value === undefined) return reply([code | 0x80, 0x02])
          if (value) bytes[index >> 3]! |= 1 << (index & 7)
        }
        return reply(Buffer.concat([Buffer.from([code, bytes.length]), bytes]))
      }
      case 0x05:
        if (this.refuseWrites.has(address)) return reply([code | 0x80, 0x03])
        bank.coils.set(address, pdu.readUInt16BE(3) === 0xff00)
        return reply(pdu)
      case 0x06:
        if (this.refuseWrites.has(address)) return reply([code | 0x80, 0x03])
        bank.holding.set(address, pdu.readUInt16BE(3))
        return reply(pdu)
      case 0x10: {
        if (this.refuseWrites.has(address)) return reply([code | 0x80, 0x03])
        const count = pdu.readUInt16BE(3)
        for (let index = 0; index < count; index++) bank.holding.set(address + index, pdu.readUInt16BE(6 + index * 2))
        return reply(pdu.subarray(0, 5))
      }
      default:
        return reply([code | 0x80, 0x01])
    }
  }
}

const words = (text: string, length: number) => {
  const bytes = Buffer.alloc(length * 2)
  bytes.write(text, 'ascii')
  return Array.from({ length }, (_, index) => bytes.readUInt16BE(index * 2))
}
const signed = (value: number) => (value < 0 ? value + 0x10000 : value)

function inverterBlock(watts: number, wattHours: number): number[] {
  const block = new Array(50).fill(0)
  block[0] = 213
  block[4] = signed(-2)
  block[8] = 2312
  block[11] = signed(-1)
  block[12] = watts * 10
  block[13] = signed(-1)
  block[22] = Math.floor(wattHours / 0x10000)
  block[23] = wattHours % 0x10000
  block[36] = 4
  return block
}

function meterBlock(watts: number): number[] {
  const block = new Array(105).fill(0)
  block[5] = 2300
  block[13] = signed(-1)
  block[16] = signed(watts)
  block[44] = 0x0002
  block[52] = 1
  return block
}

/** "SunS" at 40000, the common model, then the given models and the end marker. */
function loadSunSpec(bank: Bank, identity: { manufacturer: string; model: string; serial: string }, models: [number, number[]][]): Map<number, number> {
  const registers = [0x5375, 0x6e53, 1, 66, ...words(identity.manufacturer, 16), ...words(identity.model, 16), ...words('', 8), ...words('1.0', 8), ...words(identity.serial, 16), 1, 0]
  const starts = new Map<number, number>()
  for (const [id, block] of models) {
    starts.set(id, 40000 + registers.length + 2)
    registers.push(id, block.length, ...block)
  }
  registers.push(0xffff, 0)
  registers.forEach((value, index) => bank.holding.set(40000 + index, value))
  return starts
}

function modbusHost(patch: Partial<NetworkHost> = {}): NetworkHost {
  return {
    ip: '127.0.0.1',
    mac: '00:03:ac:12:34:56',
    macVendor: 'Fronius International GmbH',
    hostname: null,
    openPorts: [80, 502],
    mdnsServices: [],
    mdnsTxt: {},
    ssdp: null,
    httpBanner: null,
    httpTitle: null,
    rttMs: 1,
    firstSeenAt: '2026-09-26T10:00:00.000Z',
    lastSeenAt: '2026-09-26T10:00:00.000Z',
    source: ['arp', 'tcp'],
    ...patch,
  }
}

let device: FakeModbus
let context: RecordingContext
let adapter: ModbusAdapter

function makeAdapter(): ModbusAdapter {
  return new ModbusAdapter({ port: device.port, requestTimeoutMs: 150, pollMs: 40, offlineAfter: 2 })
}

beforeEach(async () => {
  device = new FakeModbus()
  await device.start()
  context = recordingContext()
})

afterEach(async () => {
  await adapter?.shutdown()
  device.stop()
})

const FRONIUS = { manufacturer: 'Fronius', model: 'Symo 5.0-3-M', serial: '31415926' }

describe('SunSpec, with nothing to configure', () => {
  test('an inverter and its meter are found, named after themselves, and read', async () => {
    loadSunSpec(device.bank(1), FRONIUS, [
      [103, inverterBlock(452, 1_234_567)],
      [203, meterBlock(-1500)],
    ])
    adapter = makeAdapter()
    await adapter.init(context, {})
    const found = await adapter.discover([modbusHost()])
    expect(found.map((entry) => [entry.name, entry.category, entry.capabilities, entry.manufacturer, entry.model])).toEqual([
      ['Fronius Symo 5.0-3-M', 'energy', ['power', 'energy'], 'Fronius', 'Symo 5.0-3-M'],
      ['Compteur (Fronius Symo 5.0-3-M)', 'energy', ['power', 'energy'], 'Fronius', 'Symo 5.0-3-M'],
    ])
    const [inverter, meter] = found
    expect(inverter!.nativeId).toBe('sunspec:31415926:1:103')
    expect(inverter!.requiresPairing ?? null).toBeNull()

    await eventually(() => context.stateOf(inverter!.nativeId).power === 452)
    expect(context.stateOf(inverter!.nativeId)).toMatchObject({ power: 452, voltage: 231.2, energyTotal: 1234.567, producing: true })
    await eventually(() => context.stateOf(meter!.nativeId).power === -1500)
    expect(context.stateOf(meter!.nativeId)).toMatchObject({ voltage: 230, energyTotal: 1310.72 })
  })

  test('readings follow the device', async () => {
    const starts = loadSunSpec(device.bank(1), FRONIUS, [[103, inverterBlock(452, 1000)]])
    adapter = makeAdapter()
    await adapter.init(context, {})
    const [inverter] = await adapter.discover([modbusHost()])
    await eventually(() => context.stateOf(inverter!.nativeId).power === 452)
    device.bank(1).holding.set(starts.get(103)! + 12, 3100)
    await eventually(() => context.stateOf(inverter!.nativeId).power === 310)
  })

  test('a device that answers on every unit id is found once', async () => {
    loadSunSpec(device.bank(1), FRONIUS, [[103, inverterBlock(452, 1000)]])
    device.anyUnit = true
    adapter = makeAdapter()
    await adapter.init(context, {})
    expect(await adapter.discover([modbusHost()])).toHaveLength(1)
  })

  test('port 502 open without SunSpec: nothing is claimed', async () => {
    device.bank(1).holding.set(0, 1)
    adapter = makeAdapter()
    await adapter.init(context, {})
    expect(await adapter.discover([modbusHost()])).toEqual([])
  })

  test('a unit id that never answers costs one delay, not one per address', async () => {
    loadSunSpec(device.bank(1), FRONIUS, [[103, inverterBlock(452, 1000)]])
    device.silentUnits.add(126)
    device.silentUnits.add(240)
    adapter = makeAdapter()
    await adapter.init(context, {})
    const started = Date.now()
    expect(await adapter.discover([modbusHost()])).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(device.requests.filter((request) => request.unit === 126)).toHaveLength(1)
  })

  test('addresses given in the settings are looked at too, with their port', async () => {
    loadSunSpec(device.bank(1), FRONIUS, [[103, inverterBlock(452, 1000)]])
    adapter = new ModbusAdapter({ requestTimeoutMs: 150, pollMs: 40 })
    await adapter.init(context, { hosts: `127.0.0.1:${device.port}` })
    expect(await adapter.discover([])).toHaveLength(1)
  })

  test('an inverter is read, not commanded', async () => {
    loadSunSpec(device.bank(1), FRONIUS, [[103, inverterBlock(452, 1000)]])
    adapter = makeAdapter()
    await adapter.init(context, {})
    const [inverter] = await adapter.discover([modbusHost()])
    const result = await adapter.execute(inverter!.nativeId, 'turnOff', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/lecture/i)
  })
})

function heatPumpPoints(port: number): string {
  return JSON.stringify([
    { device: 'Pompe à chaleur', host: '127.0.0.1', port, table: 'input', address: 10, type: 'int16', scale: 0.1, role: 'temperature' },
    { device: 'Pompe à chaleur', host: '127.0.0.1', port, table: 'holding', address: 20, type: 'int16', scale: 0.1, role: 'setpoint' },
    { device: 'Pompe à chaleur', host: '127.0.0.1', port, table: 'coil', address: 0, role: 'onoff' },
  ])
}

describe('points written by hand', () => {
  beforeEach(() => {
    const bank = device.bank(1)
    bank.input.set(10, 215)
    bank.holding.set(20, 200)
    bank.coils.set(0, false)
  })

  test('a heat pump is read, set and switched', async () => {
    adapter = makeAdapter()
    await adapter.init(context, { points: heatPumpPoints(device.port) })
    const [pump] = await adapter.discover([])
    expect(pump).toMatchObject({ nativeId: 'custom:pompe-a-chaleur', name: 'Pompe à chaleur', category: 'climate', capabilities: ['temperature', 'thermostat', 'onoff'] })

    await eventually(() => context.stateOf('custom:pompe-a-chaleur').temperature === 21.5)
    expect(context.stateOf('custom:pompe-a-chaleur')).toMatchObject({ targetTemperature: 20, currentTemperature: 21.5, hvacMode: 'heat', on: false })

    const set = await adapter.execute('custom:pompe-a-chaleur', 'setTargetTemperature', { celsius: 22 })
    expect(set.ok).toBe(true)
    expect(device.bank(1).holding.get(20)).toBe(220)
    expect(set.undo).toEqual({ command: 'setTargetTemperature', args: { celsius: 20 } })

    expect((await adapter.execute('custom:pompe-a-chaleur', 'turnOn', {})).ok).toBe(true)
    expect(device.bank(1).coils.get(0)).toBe(true)
    await eventually(() => context.stateOf('custom:pompe-a-chaleur').on === true)
  })

  test("the device's refusal is said in words", async () => {
    device.refuseWrites.add(20)
    adapter = makeAdapter()
    await adapter.init(context, { points: heatPumpPoints(device.port) })
    await adapter.discover([])
    const result = await adapter.execute('custom:pompe-a-chaleur', 'setTargetTemperature', { celsius: 22 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('valeur refusée')
  })

  test('a broken map: the status says which point, the rest still works', async () => {
    const points = JSON.parse(heatPumpPoints(device.port)) as Record<string, unknown>[]
    points.push({ device: 'Pompe à chaleur', host: '127.0.0.1', table: 'input', address: 3, role: 'volume' })
    adapter = makeAdapter()
    await adapter.init(context, { points: JSON.stringify(points) })
    expect(await adapter.discover([])).toHaveLength(1)
    expect(adapter.status()).toMatchObject({ health: 'degraded' })
    expect(adapter.status().message).toContain('Point 4')
  })

  test('a device that stops answering goes offline, then comes back', async () => {
    adapter = makeAdapter()
    await adapter.init(context, { points: heatPumpPoints(device.port) })
    await adapter.discover([])
    await eventually(() => context.stateOf('custom:pompe-a-chaleur').temperature === 21.5)

    device.silent = true
    await eventually(() => context.availability.some((entry) => entry.nativeId === 'custom:pompe-a-chaleur' && !entry.online))
    expect(adapter.status().health).toBe('degraded')

    device.silent = false
    await eventually(() => context.availability.at(-1)?.online === true)
    expect(adapter.status().health).toBe('ok')
  })

  test('a connection closed by the device is opened again', async () => {
    adapter = makeAdapter()
    await adapter.init(context, { points: heatPumpPoints(device.port) })
    await adapter.discover([])
    await eventually(() => context.stateOf('custom:pompe-a-chaleur').temperature === 21.5)
    device.dropConnections()
    device.bank(1).input.set(10, 230)
    await eventually(() => context.stateOf('custom:pompe-a-chaleur').temperature === 23)
  })
})

describe('the encoding round trip', () => {
  test('a float set point is written as a float', async () => {
    const bank = device.bank(1)
    bank.holding.set(30, 0)
    bank.holding.set(31, 0)
    adapter = makeAdapter()
    await adapter.init(context, {
      points: JSON.stringify([{ device: 'VMC', host: '127.0.0.1', port: device.port, table: 'holding', address: 30, type: 'float32', role: 'setpoint' }]),
    })
    await adapter.discover([])
    expect((await adapter.execute('custom:vmc', 'setTargetTemperature', { celsius: 19.5 })).ok).toBe(true)
    expect([bank.holding.get(30), bank.holding.get(31)]).toEqual(encodeValue(19.5, 'float32'))
  })
})
