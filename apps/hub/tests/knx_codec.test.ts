/**
 * KNX over IP, the parts that do not need a bus.
 *
 * A KNX installation is actuators and sensors talking in group addresses ("1/2/3"): a switch
 * writes "on" to the light's address, the actuator answers on its status address. The hub
 * reaches the bus through an IP interface or router, over a KNXnet/IP tunnel: UDP to port
 * 3671, one connection, every telegram acknowledged. Telegrams are cEMI frames; values are
 * datapoint types (DPT), e.g. 9.001 for a temperature in the KNX 2-byte float.
 *
 * Nothing on the bus says what an address is for: the map comes from the installer's ETS
 * project, written once in the settings.
 *
 * Sources: KNX Standard 3/8/2 (Core), 3/8/4 (Tunnelling), 3/6/3 (cEMI), 3/7/2 (Datapoint
 * Types); xknx (knxip, cemi, dpt) for the exact encodings.
 */

import { describe, expect, test } from 'bun:test'
import {
  KNX_SERVICE,
  commandTelegrams,
  connectRequest,
  connectionStateRequest,
  decodeCemi,
  decodeDpt,
  devicesFrom,
  encodeDpt,
  formatGroupAddress,
  groupRead,
  groupWrite,
  parseFrame,
  parseGroupAddress,
  parseIndividualAddress,
  parseKnxPoints,
  parseSearchResponse,
  stateFrom,
  tunnellingAck,
  tunnellingRequest,
} from '#adapters/knx_codec'

const hex = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('hex')

describe('addresses', () => {
  test('group addresses in three levels, two levels or free', () => {
    expect(parseGroupAddress('1/2/3')).toBe(0x0a03)
    expect(parseGroupAddress('31/7/255')).toBe(0xffff)
    expect(parseGroupAddress('1/515')).toBe(0x0a03)
    expect(parseGroupAddress('2563')).toBe(0x0a03)
    expect(formatGroupAddress(0x0a03)).toBe('1/2/3')
    for (const wrong of ['1/8/3', '32/0/0', '1/2/256', 'a/b/c', '']) expect(parseGroupAddress(wrong)).toBeNull()
  })

  test('individual addresses', () => {
    expect(parseIndividualAddress('1.1.250')).toBe(0x11fa)
    expect(parseIndividualAddress('15.15.255')).toBe(0xffff)
    expect(parseIndividualAddress('16.0.0')).toBeNull()
  })
})

describe('datapoint types', () => {
  test('9.001, the KNX 2-byte float: 21.5, -5, zero, and invalid', () => {
    expect(hex(encodeDpt('9.001', 21.5))).toBe('0c33')
    expect(hex(encodeDpt('9.001', -5))).toBe('860c')
    expect(decodeDpt('9.001', Buffer.from([0x0c, 0x33]))).toBe(21.5)
    expect(decodeDpt('9.001', Buffer.from([0x86, 0x0c]))).toBe(-5)
    expect(decodeDpt('9.001', Buffer.from([0x00, 0x00]))).toBe(0)
    expect(decodeDpt('9.001', Buffer.from([0x7f, 0xff]))).toBeNull()
    expect(decodeDpt('9.004', encodeDpt('9.004', 35_000))).toBeCloseTo(35_000, -2)
  })

  test('1.x is one bit, 5.001 a percentage of 255', () => {
    expect(hex(encodeDpt('1.001', true))).toBe('01')
    expect(decodeDpt('1.001', Buffer.from([0x00]))).toBe(false)
    expect(hex(encodeDpt('5.001', 100))).toBe('ff')
    expect(hex(encodeDpt('5.001', 50))).toBe('80')
    expect(decodeDpt('5.001', Buffer.from([0x80]))).toBe(50)
  })

  test('4-byte types: 14.x float, 13.x signed, 12.x unsigned', () => {
    expect(decodeDpt('14.056', encodeDpt('14.056', 1234.5))).toBeCloseTo(1234.5)
    expect(hex(encodeDpt('13.010', -2))).toBe('fffffffe')
    expect(decodeDpt('13.013', Buffer.from([0x00, 0x00, 0x30, 0x39]))).toBe(12_345)
    expect(decodeDpt('12.001', Buffer.from([0xff, 0xff, 0xff, 0xff]))).toBe(4_294_967_295)
  })
})

describe('telegrams', () => {
  test('a switch write: one bit, packed in the APCI', () => {
    expect(hex(groupWrite(0x0a03, encodeDpt('1.001', true), true))).toBe('1100bce000000a03010081')
  })

  test('a temperature write carries its two bytes after the APCI, and a read carries none', () => {
    expect(hex(groupWrite(0x0a04, encodeDpt('9.001', 21.5), false))).toBe('1100bce000000a040300800c33')
    expect(hex(groupRead(0x0a04))).toBe('1100bce000000a04010000')
  })

  test('what the bus says: writes, answers to reads, confirmations', () => {
    expect(decodeCemi(Buffer.from('2900bce011030a03010081', 'hex'))).toEqual({
      code: 'indication',
      source: '1.1.3',
      destination: 0x0a03,
      service: 'write',
      data: Buffer.from([0x01]),
      small: true,
      confirmError: false,
    })
    expect(decodeCemi(Buffer.from('2900bce011040a040300400c33', 'hex'))).toMatchObject({ service: 'response', destination: 0x0a04, data: Buffer.from([0x0c, 0x33]), small: false })
    expect(decodeCemi(Buffer.from('2e00bce000000a03010081', 'hex'))).toMatchObject({ code: 'confirmation', confirmError: false })
    expect(decodeCemi(Buffer.from('2e00bde000000a03010081', 'hex'))).toMatchObject({ code: 'confirmation', confirmError: true })
    expect(decodeCemi(Buffer.from('2900bc6011031103010081', 'hex'))).toBeNull()
  })
})

describe('KNXnet/IP', () => {
  const local = { ip: '192.168.1.10', port: 51000 }

  test('a tunnel connection request: two endpoints, then a link-layer tunnel', () => {
    expect(hex(connectRequest(local))).toBe('06100205001a' + '0801c0a8010ac738' + '0801c0a8010ac738' + '04040200')
  })

  test('heartbeats and tunnelled telegrams carry the channel', () => {
    expect(hex(connectionStateRequest(7, local))).toBe('06100207001007000801c0a8010ac738')
    expect(hex(tunnellingRequest(7, 3, groupRead(0x0a04)))).toBe('061004200015' + '04070300' + '1100bce000000a04010000')
    expect(hex(tunnellingAck(7, 3))).toBe('06100421000a04070300')
  })

  test('frames are read back into their service and fields', () => {
    expect(parseFrame(Buffer.from('061002060014' + '0700' + '0801c0a80132' + '0e57' + '040411fa', 'hex'))).toEqual({
      service: KNX_SERVICE.connectResponse,
      channel: 7,
      status: 0,
      dataEndpoint: { ip: '192.168.1.50', port: 3671 },
      individualAddress: '1.1.250',
    })
    expect(parseFrame(Buffer.from('061002080008' + '0721', 'hex'))).toEqual({ service: KNX_SERVICE.connectionStateResponse, channel: 7, status: 0x21 })
    expect(parseFrame(Buffer.from('06100421000a' + '04070300', 'hex'))).toEqual({ service: KNX_SERVICE.tunnellingAck, channel: 7, sequence: 3, status: 0 })
    expect(parseFrame(Buffer.from('061004200015' + '04070500' + '2900bce011030a03010081', 'hex'))).toMatchObject({
      service: KNX_SERVICE.tunnellingRequest,
      channel: 7,
      sequence: 5,
      cemi: Buffer.from('2900bce011030a03010081', 'hex'),
    })
    expect(parseFrame(Buffer.from('0610', 'hex'))).toBeNull()
  })

  test('a search answer names the gateway and says whether it tunnels', () => {
    const name = Buffer.alloc(30)
    name.write('MDT IP Interface', 'latin1')
    const deviceInfo = Buffer.concat([
      Buffer.from([0x36, 0x01, 0x02, 0x00, 0x11, 0x00, 0x00, 0x00]),
      Buffer.from('0083a1b2c3d4', 'hex'),
      Buffer.from([224, 0, 23, 12]),
      Buffer.from('cc1be0801234', 'hex'),
      name,
    ])
    const families = Buffer.from([0x08, 0x02, 0x02, 0x02, 0x04, 0x02, 0x05, 0x02])
    const body = Buffer.concat([Buffer.from('0801c0a801320e57', 'hex'), deviceInfo, families])
    const header = Buffer.from([0x06, 0x10, 0x02, 0x02, 0x00, 6 + body.length])
    expect(parseSearchResponse(Buffer.concat([header, body]))).toEqual({
      endpoint: { ip: '192.168.1.50', port: 3671 },
      name: 'MDT IP Interface',
      individualAddress: '1.1.0',
      serial: '0083a1b2c3d4',
      mac: 'cc:1b:e0:80:12:34',
      tunnelling: true,
      routing: true,
    })
  })
})

const MAP = JSON.stringify([
  { device: 'Plafonnier salon', role: 'onoff', write: '1/1/1', status: '1/1/2' },
  { device: 'Plafonnier salon', role: 'brightness', write: '1/1/3', status: '1/1/4' },
  { device: 'Volet chambre', role: 'position', write: '2/1/1', status: '2/1/2' },
  { device: 'Volet chambre', role: 'stop', write: '2/1/3' },
  { device: 'Thermostat bureau', role: 'temperature', status: '3/1/1' },
  { device: 'Thermostat bureau', role: 'setpoint', write: '3/1/2', status: '3/1/3' },
  { device: 'Fenêtre cuisine', role: 'contact', status: '4/1/1' },
])

describe('the map from ETS', () => {
  test('devices and their capabilities, from the roles of their addresses', () => {
    const { points, errors } = parseKnxPoints(MAP)
    expect(errors).toEqual([])
    expect(devicesFrom(points).map((device) => [device.id, device.category, device.capabilities])).toEqual([
      ['knx:plafonnier-salon', 'light', ['onoff', 'brightness']],
      ['knx:volet-chambre', 'cover', ['position']],
      ['knx:thermostat-bureau', 'climate', ['temperature', 'thermostat']],
      ['knx:fenetre-cuisine', 'sensor', ['contact']],
    ])
  })

  test('mistakes are said point by point', () => {
    const { errors } = parseKnxPoints(
      JSON.stringify([
        { device: 'A', role: 'onoff', write: '1/9/1' },
        { device: 'A', role: 'temperature' },
        { device: 'A', role: 'onoff', status: '1/1/2' },
        { device: 'A', role: 'lumière', write: '1/1/1' },
        { device: 'A', role: 'temperature', status: '1/1/5', dpt: '99.1' },
      ])
    )
    expect(errors).toEqual([
      'Point 1 : adresse de groupe "1/9/1" invalide.',
      "Point 2 : adresse d'état manquante.",
      'Point 3 : adresse de commande manquante.',
      'Point 4 : rôle "lumière" inconnu (onoff, brightness, position, stop, setpoint, temperature, humidity, illuminance, power, energy, contact, motion).',
      'Point 5 : type "99.1" non pris en charge.',
    ])
  })

  test('values heard on the bus become the state; a KNX blind at 0 % is open', () => {
    const [light, blind, thermostat, window] = devicesFrom(parseKnxPoints(MAP).points)
    const heard = new Map<number, Buffer>([
      [parseGroupAddress('1/1/2')!, Buffer.from([0x01])],
      [parseGroupAddress('1/1/4')!, Buffer.from([0x80])],
      [parseGroupAddress('2/1/2')!, Buffer.from([0x00])],
      [parseGroupAddress('3/1/1')!, Buffer.from([0x0c, 0x33])],
      [parseGroupAddress('3/1/3')!, encodeDpt('9.001', 20)],
      [parseGroupAddress('4/1/1')!, Buffer.from([0x01])],
    ])
    expect(stateFrom(light!, heard)).toEqual({ on: true, brightness: 50 })
    expect(stateFrom(blind!, heard)).toEqual({ position: 100 })
    expect(stateFrom(thermostat!, heard)).toEqual({ temperature: 21.5, currentTemperature: 21.5, targetTemperature: 20, hvacMode: 'heat' })
    expect(stateFrom(window!, heard)).toEqual({ open: true })
  })

  test('commands become group writes', () => {
    const [light, blind, thermostat, window] = devicesFrom(parseKnxPoints(MAP).points)
    expect(commandTelegrams(light!, 'turnOn', {})).toEqual({ writes: [{ address: parseGroupAddress('1/1/1')!, data: Buffer.from([0x01]), small: true }], expect: { on: true } })
    expect(commandTelegrams(light!, 'setBrightness', { brightness: 100 })).toEqual({
      writes: [{ address: parseGroupAddress('1/1/3')!, data: Buffer.from([0xff]), small: false }],
      expect: { brightness: 100, on: true },
    })
    expect(commandTelegrams(blind!, 'close', {})).toEqual({ writes: [{ address: parseGroupAddress('2/1/1')!, data: Buffer.from([0xff]), small: false }], expect: { position: 0 } })
    expect(commandTelegrams(blind!, 'stop', {})).toEqual({ writes: [{ address: parseGroupAddress('2/1/3')!, data: Buffer.from([0x01]), small: true }], expect: {} })
    expect(commandTelegrams(thermostat!, 'setTargetTemperature', { celsius: 21.5 })).toEqual({
      writes: [{ address: parseGroupAddress('3/1/2')!, data: Buffer.from([0x0c, 0x33]), small: false }],
      expect: { targetTemperature: 21.5 },
    })
    expect(commandTelegrams(window!, 'turnOn', {})).toEqual({ error: 'Fenêtre cuisine ne sait pas faire "turnOn".' })
  })
})
