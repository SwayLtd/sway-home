/**
 * Modbus TCP, the parts that do not need a device.
 *
 * A request is an MBAP header (transaction, protocol 0, length, unit) around a PDU (function
 * code and data); an answer repeats the transaction id, and an exception is the function code
 * with its high bit set, followed by a one-byte code. Nothing on the wire says what a register
 * means: that comes either from SunSpec, which solar inverters and meters use to describe
 * themselves ("SunS" at 40000, then a chain of models with scale factors), or from a map the
 * person writes for their heat pump or relay board.
 *
 * Sources: Modbus Application Protocol v1.1b3 and Messaging on TCP/IP v1.0b; the SunSpec
 * information models (github.com/sunspec/models, json/model_1, 103, 113, 203, 213).
 */

import { describe, expect, test } from 'bun:test'
import {
  AduReader,
  commandWrites,
  commonFrom,
  decodeString,
  decodeValue,
  devicesFrom,
  encodeValue,
  frame,
  parseAnswer,
  parsePoints,
  readPdu,
  stateFrom,
  sunspecState,
  writeCoilPdu,
  writeRegisterPdu,
  writeRegistersPdu,
} from '#adapters/modbus_codec'

const words = (text: string, length: number) => {
  const bytes = Buffer.alloc(length * 2)
  bytes.write(text, 'ascii')
  return Array.from({ length }, (_, index) => bytes.readUInt16BE(index * 2))
}
const signed = (value: number) => (value < 0 ? value + 0x10000 : value)

describe('the wire', () => {
  test('a read of holding registers, framed for TCP', () => {
    expect([...frame(0x0102, 1, readPdu('holding', 40000, 2))]).toEqual([0x01, 0x02, 0, 0, 0, 6, 1, 0x03, 0x9c, 0x40, 0, 2])
    expect([...readPdu('input', 30775, 2)]).toEqual([0x04, 0x78, 0x37, 0, 2])
    expect([...readPdu('coil', 16, 3)]).toEqual([0x01, 0, 16, 0, 3])
    expect([...readPdu('discrete', 0, 8)]).toEqual([0x02, 0, 0, 0, 8])
  })

  test('writes: a coil is FF00 or 0000, registers one or several', () => {
    expect([...writeCoilPdu(5, true)]).toEqual([0x05, 0, 5, 0xff, 0x00])
    expect([...writeCoilPdu(5, false)]).toEqual([0x05, 0, 5, 0x00, 0x00])
    expect([...writeRegisterPdu(100, 215)]).toEqual([0x06, 0, 100, 0, 215])
    expect([...writeRegistersPdu(200, [0x4148, 0x0000])]).toEqual([0x10, 0, 200, 0, 2, 4, 0x41, 0x48, 0, 0])
  })

  test('answers are cut out of the stream however it arrives', () => {
    const answer = (tid: number, pdu: number[]) => frame(tid, 1, Buffer.from(pdu))
    const stream = Buffer.concat([answer(7, [0x03, 4, 0x53, 0x75, 0x6e, 0x53]), answer(8, [0x83, 0x02])])
    const reader = new AduReader()
    const out = [...stream].flatMap((byte) => reader.push(Buffer.from([byte])))
    expect(out.map((adu) => [adu.transactionId, adu.unitId, [...adu.pdu]])).toEqual([
      [7, 1, [0x03, 4, 0x53, 0x75, 0x6e, 0x53]],
      [8, 1, [0x83, 0x02]],
    ])
  })

  test('registers, bits, echoes and exceptions', () => {
    expect(parseAnswer(readPdu('holding', 40000, 2), Buffer.from([0x03, 4, 0x53, 0x75, 0x6e, 0x53]))).toEqual({ registers: [0x5375, 0x6e53] })
    expect(parseAnswer(readPdu('coil', 0, 10), Buffer.from([0x01, 2, 0b0000_0101, 0b0000_0010]))).toEqual({
      bits: [true, false, true, false, false, false, false, false, false, true],
    })
    expect(parseAnswer(writeCoilPdu(5, true), writeCoilPdu(5, true))).toEqual({ written: true })
    expect(parseAnswer(readPdu('holding', 40000, 2), Buffer.from([0x83, 0x02]))).toEqual({ exception: 2, message: 'adresse de registre invalide' })
    expect(parseAnswer(readPdu('holding', 0, 1), Buffer.from([0x83, 0x0b]))).toEqual({ exception: 11, message: "passerelle : l'appareil ne répond pas" })
  })
})

describe('values', () => {
  test('16 and 32 bits, signed or not, in either word order', () => {
    expect(decodeValue([0xff38], 'int16')).toBe(-200)
    expect(decodeValue([0xff38], 'uint16')).toBe(65336)
    expect(decodeValue([0x0001, 0x86a0], 'uint32')).toBe(100_000)
    expect(decodeValue([0x86a0, 0x0001], 'uint32', 'little')).toBe(100_000)
    expect(decodeValue([0xffff, 0xfffe], 'int32')).toBe(-2)
    expect(decodeValue([0x41ac, 0x0000], 'float32')).toBeCloseTo(21.5)
    expect(decodeValue([0x0000, 0x41ac], 'float32', 'little')).toBeCloseTo(21.5)
  })

  test('SunSpec "not implemented" reads as nothing', () => {
    expect(decodeValue([0x8000], 'int16', 'big', { sunspec: true })).toBeNull()
    expect(decodeValue([0xffff], 'uint16', 'big', { sunspec: true })).toBeNull()
    expect(decodeValue([0x7fc0, 0x0000], 'float32', 'big', { sunspec: true })).toBeNull()
    expect(decodeValue([0x8000], 'int16')).toBe(-32768)
  })

  test('encoding is the inverse, for writes', () => {
    expect(encodeValue(-200, 'int16')).toEqual([0xff38])
    expect(encodeValue(100_000, 'uint32', 'little')).toEqual([0x86a0, 0x0001])
    expect(decodeValue(encodeValue(21.5, 'float32'), 'float32')).toBeCloseTo(21.5)
  })

  test('text is two characters a register, cut at the first NUL', () => {
    expect(decodeString(words('Fronius', 16))).toBe('Fronius')
    expect(decodeString(words('SN-12345 ', 4))).toBe('SN-12345')
  })
})

describe('SunSpec', () => {
  test('the common model names the device', () => {
    const common = [...words('Fronius', 16), ...words('Symo 5.0-3-M', 16), ...words('', 8), ...words('3.21.4', 8), ...words('31415926', 16), 1, 0]
    expect(commonFrom(common)).toEqual({ manufacturer: 'Fronius', model: 'Symo 5.0-3-M', version: '3.21.4', serial: '31415926' })
  })

  test('an inverter with scale factors: power, energy and voltage', () => {
    const block = new Array(50).fill(0)
    block[0] = 213 // A
    block[4] = signed(-2) // A_SF: 2.13 A
    block[8] = 2312 // PhVphA
    block[11] = signed(-1) // V_SF: 231.2 V
    block[12] = 4521 // W
    block[13] = signed(-1) // W_SF: 452.1 W
    block[22] = 0x0012 // WH, acc32: 1 234 567 Wh
    block[23] = 0xd687
    block[24] = 0 // WH_SF
    block[36] = 4 // St: MPPT, producing
    expect(sunspecState(103, block)).toEqual({ power: 452.1, voltage: 231.2, current: 2.13, energyTotal: 1234.567, producing: true })
  })

  test('a float inverter, and one asleep at night', () => {
    const block = new Array(60).fill(0)
    const put = (offset: number, value: number) => {
      const [high, low] = encodeValue(value, 'float32')
      block[offset] = high!
      block[offset + 1] = low!
    }
    put(0, 1.5)
    put(14, 230)
    put(20, 345)
    put(30, 5_000_000)
    block[46] = 2 // St: sleeping
    expect(sunspecState(113, block)).toEqual({ power: 345, voltage: 230, current: 1.5, energyTotal: 5000, producing: false })
  })

  test('a meter: power as the meter sees it, energy bought and sold', () => {
    const block = new Array(105).fill(0)
    block[0] = 65 // A
    block[4] = signed(-1) // A_SF: 6.5 A
    block[5] = 2300 // PhV
    block[13] = signed(-1) // V_SF: 230.0 V
    block[16] = signed(-1500) // W
    block[20] = 0 // W_SF
    block[36] = 0x0001 // TotWhExp: 65 536 Wh x 10
    block[37] = 0x0000
    block[44] = 0x0002 // TotWhImp: 131 072 Wh x 10
    block[45] = 0x0000
    block[52] = 1 // TotWh_SF
    expect(sunspecState(203, block)).toEqual({ power: -1500, voltage: 230, current: 6.5, energyTotal: 1310.72, energyReturned: 655.36 })
  })

  test('models it does not know give nothing', () => {
    expect(sunspecState(64110, new Array(10).fill(0))).toBeNull()
  })
})

const POINTS = JSON.stringify([
  { device: 'Pompe à chaleur', host: '192.168.1.60', table: 'input', address: 10, type: 'int16', scale: 0.1, role: 'temperature' },
  { device: 'Pompe à chaleur', host: '192.168.1.60', table: 'holding', address: 20, type: 'int16', scale: 0.1, role: 'setpoint' },
  { device: 'Pompe à chaleur', host: '192.168.1.60', table: 'coil', address: 0, role: 'onoff' },
  { device: 'Compteur garage', host: '192.168.1.61', unit: 3, table: 'input', address: 0, type: 'float32', role: 'power' },
  { device: 'Compteur garage', host: '192.168.1.61', unit: 3, table: 'input', address: 2, type: 'uint32', scale: 0.001, role: 'energy' },
])

describe('points written by hand', () => {
  test('a map groups into devices with the capabilities their points give', () => {
    const { points, errors } = parsePoints(POINTS)
    expect(errors).toEqual([])
    const devices = devicesFrom(points)
    expect(devices.map((device) => [device.id, device.name, device.category, device.capabilities])).toEqual([
      ['custom:pompe-a-chaleur', 'Pompe à chaleur', 'climate', ['temperature', 'thermostat', 'onoff']],
      ['custom:compteur-garage', 'Compteur garage', 'energy', ['power', 'energy']],
    ])
  })

  test('mistakes are said point by point, in words', () => {
    const { points, errors } = parsePoints(
      JSON.stringify([
        { device: 'PAC', host: '192.168.1.60', table: 'holding', role: 'temperature' },
        { device: 'PAC', host: '192.168.1.60', table: 'input', address: 3, role: 'onoff' },
        { device: 'PAC', host: '192.168.1.60', table: 'holding', address: 4, role: 'volume' },
      ])
    )
    expect(points).toEqual([])
    expect(errors).toEqual([
      'Point 1 : adresse manquante.',
      "Point 2 : un registre d'entrée ne s'écrit pas, il ne peut pas allumer ou éteindre.",
      'Point 3 : rôle "volume" inconnu (temperature, humidity, power, energy, onoff, setpoint, position, valve).',
    ])
    expect(parsePoints('{ pas du json').errors[0]).toMatch(/JSON/)
    expect(parsePoints('')).toEqual({ points: [], errors: [] })
  })

  test('readings become the capability state, scaled', () => {
    const [heatPump] = devicesFrom(parsePoints(POINTS).points)
    const values = new Map<string, number | boolean | null>([
      [heatPump!.points[0]!.key, 215],
      [heatPump!.points[1]!.key, 200],
      [heatPump!.points[2]!.key, true],
    ])
    expect(stateFrom(heatPump!, values)).toEqual({ temperature: 21.5, targetTemperature: 20, currentTemperature: 21.5, hvacMode: 'heat', on: true })
  })

  test('commands become writes, unscaled back to the raw register', () => {
    const [heatPump, meter] = devicesFrom(parsePoints(POINTS).points)
    expect(commandWrites(heatPump!, 'setTargetTemperature', { celsius: 21.5 }, new Map())).toEqual({ writes: [{ point: heatPump!.points[1], registers: [215] }], expect: { targetTemperature: 21.5 } })
    expect(commandWrites(heatPump!, 'turnOff', {}, new Map())).toEqual({ writes: [{ point: heatPump!.points[2], coil: false }], expect: { on: false } })
    expect(commandWrites(heatPump!, 'toggle', {}, new Map([[heatPump!.points[2]!.key, false]]))).toEqual({
      writes: [{ point: heatPump!.points[2], coil: true }],
      expect: { on: true },
    })
    expect(commandWrites(meter!, 'turnOn', {}, new Map())).toEqual({ error: 'Compteur garage ne sait pas faire "turnOn".' })
  })
})
