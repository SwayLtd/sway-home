/**
 * Bluetooth LE advertisements, the parts that need no radio.
 *
 * Passive sensors never connect: they shout their readings in advertisements, as service
 * data (BTHome on 0xFCD2, Xiaomi's MiBeacon on 0xFE95, pvvx and ATC firmwares on 0x181A,
 * SwitchBot on 0xFD3D) or manufacturer data (Govee 0xEC88, Ruuvi 0x0499, SwitchBot 0x0969,
 * Apple's iBeacon on 0x004C). Some are encrypted with a per-device key (BTHome, MiBeacon
 * v4/v5): AES-CCM with a 4-byte tag.
 *
 * Every vector below is either the specification's own example or a real advertisement: from
 * the reference parsers' test suites (bthome.io, xiaomi-ble, govee-ble, pySwitchbot, Ruuvi's
 * data format 5), or captured on this machine by the Windows scanner.
 */

import { describe, expect, test } from 'bun:test'
import {
  advertFromGateway,
  advertFromSections,
  capabilitiesFor,
  decode,
  parseBeacons,
  parseKeys,
  parseScannerLine,
  stateFrom,
  type Advert,
} from '#adapters/ble_codec'

const service = (address: string, uuid: string, hex: string, name: string | null = null): Advert => ({
  address,
  rssi: -60,
  name,
  manufacturer: new Map(),
  serviceData: new Map([[uuid, Buffer.from(hex, 'hex')]]),
  serviceUuids: [],
})

const maker = (address: string, company: number, hex: string, name: string | null = null): Advert => ({
  address,
  rssi: -60,
  name,
  manufacturer: new Map([[company, Buffer.from(hex, 'hex')]]),
  serviceData: new Map(),
  serviceUuids: [],
})

const NO_KEYS = new Map<string, Buffer>()

describe('advertisements as they arrive', () => {
  test('a line from the Windows scanner: address, signal, and its data sections', () => {
    const advert = parseScannerLine('{"address":"ec9a34897f2d","rssi":-81,"sections":["0106","ff4c000215e20a39f473f54bc4186417d1ad07a9628549a0a900"]}')
    expect(advert?.address).toBe('EC:9A:34:89:7F:2D')
    expect(advert?.rssi).toBe(-81)
    expect(advert?.manufacturer.get(0x004c)?.toString('hex')).toBe('0215e20a39f473f54bc4186417d1ad07a9628549a0a900')
    expect(parseScannerLine('{"stopped":"RadioNotAvailable"}')).toBeNull()
    expect(parseScannerLine('not json')).toBeNull()
  })

  test('sections: names, 16-bit service data and service lists', () => {
    const advert = advertFromSections('632ee877cab4', -82, ['039ffe', '169ffe025a2d30505f', '0954482d53656e736f72'])
    expect(advert.serviceUuids).toEqual(['fe9f'])
    expect(advert.serviceData.get('fe9f')?.toString('hex')).toBe('025a2d30505f')
    expect(advert.name).toBe('TH-Sensor')
  })

  test('a gateway message (Theengs, OpenMQTTGateway): raw data, or what the gateway decoded itself', () => {
    const raw = advertFromGateway({ id: 'A4:C1:38:02:83:F4', rssi: -70, manufacturerdata: '88ec000341c26400', servicedata: '40ca09', servicedatauuid: '0xfcd2', name: 'GVH5075_2762' })
    expect(raw?.advert.address).toBe('A4:C1:38:02:83:F4')
    expect(raw?.advert.manufacturer.get(0xec88)?.toString('hex')).toBe('000341c26400')
    expect(raw?.advert.serviceData.get('fcd2')?.toString('hex')).toBe('40ca09')
    expect(raw?.decoded).toBeNull()
    const decoded = advertFromGateway({ id: 'A4:C1:38:02:83:F4', rssi: -70, model_id: 'LYWSD03MMC', tempc: 21.3, hum: 44.2, batt: 91 })
    expect(decoded?.decoded).toEqual({ temperature: 21.3, humidity: 44.2, battery: 91 })
    expect(advertFromGateway({ rssi: -70 })).toBeNull()
  })
})

describe('BTHome v2', () => {
  test("the specification's temperature and humidity", () => {
    expect(decode(service('A4:C1:38:00:00:01', 'fcd2', '4002ca0903bf13'), NO_KEYS)).toEqual({
      kind: 'reading',
      format: 'bthome',
      model: null,
      packet: null,
      values: { temperature: 25.06, humidity: 50.55 },
    })
  })

  test('packet id, battery, a button press, a window, pressure, light, power', () => {
    const reading = decode(service('A4:C1:38:00:00:02', 'fcd2', '44000c0164' + '04138a01' + '05138a14' + '0b021b00' + '2d01' + '3a01'), NO_KEYS)
    expect(reading).toMatchObject({
      packet: 12,
      values: { battery: 100, pressure: 1008.83, illuminance: 13460.67, power: 69.14, open: true, buttons: [{ index: 0, event: 'single' }] },
    })
  })

  test('parsing stops at an object it does not know, keeping what came before', () => {
    expect(decode(service('A4:C1:38:00:00:03', 'fcd2', '4002ca09f7aa03bf13'), NO_KEYS)).toMatchObject({ values: { temperature: 25.06 } })
    expect((decode(service('A4:C1:38:00:00:03', 'fcd2', '4002ca09f7aa03bf13'), NO_KEYS) as { values: object }).values).not.toHaveProperty('humidity')
  })

  test("encrypted: the specification's example, a wrong key, no key", () => {
    const advert = service('54:48:E6:8F:80:A5', 'fcd2', '41e445f3c9962b332211006c7c4519')
    const keys = new Map([['54:48:E6:8F:80:A5', Buffer.from('231d39c1d7cc1ab1aee224cd096db932', 'hex')]])
    expect(decode(advert, keys)).toMatchObject({ kind: 'reading', format: 'bthome', values: { temperature: 25.06, humidity: 50.55 } })
    expect(decode(advert, new Map([['54:48:E6:8F:80:A5', Buffer.alloc(16, 1)]]))).toEqual({ kind: 'locked', format: 'bthome', model: null, reason: 'wrong-key' })
    expect(decode(advert, NO_KEYS)).toEqual({ kind: 'locked', format: 'bthome', model: null, reason: 'no-key' })
  })
})

describe('Xiaomi', () => {
  test('pvvx firmware, its own format: hundredths, and the battery in millivolts', () => {
    expect(decode(service('A4:C1:38:12:34:56', '181a', '56341238c1a45908a911860b4e1205'), NO_KEYS)).toEqual({
      kind: 'reading',
      format: 'pvvx',
      model: null,
      packet: 0x12,
      values: { temperature: 21.37, humidity: 45.21, batteryVoltage: 2.95, battery: 78 },
    })
  })

  test('ATC1441 format: tenths, big-endian, below zero', () => {
    expect(decode(service('A4:C1:38:12:34:56', '181a', 'a4c138123456ffdd435b0bc47a'), NO_KEYS)).toEqual({
      kind: 'reading',
      format: 'atc1441',
      model: null,
      packet: 0x7a,
      values: { temperature: -3.5, humidity: 67, battery: 91, batteryVoltage: 3.012 },
    })
  })

  test('MiBeacon in clear: a Mi Flora plant sensor', () => {
    expect(decode(service('C4:7C:8D:6B:4F:F3', 'fe95', '7120980012f34f6b8d7cc40d041002c400'), NO_KEYS)).toEqual({
      kind: 'reading',
      format: 'mibeacon',
      model: 'HHCCJCY01',
      packet: 0x12,
      values: { temperature: 19.6 },
    })
  })

  test('MiBeacon v5 encrypted: thermometers and a door sensor, with their bind keys', () => {
    const lywsd03 = service('A4:C1:38:02:83:F4', 'fe95', '58585b0550f4830238c1a495ef58763c26000097e2abb5')
    expect(decode(lywsd03, new Map([['A4:C1:38:02:83:F4', Buffer.from('e9ea895fac7cca6d30532432a516f3a8', 'hex')]]))).toMatchObject({
      kind: 'reading',
      model: 'LYWSD03MMC',
      values: { humidity: 46 },
    })
    const lywsd02 = service('A4:C1:38:56:53:84', 'fe95', '5858e4162c84535638c1a42b6ef2e91200006c884d9e')
    expect(decode(lywsd02, new Map([['A4:C1:38:56:53:84', Buffer.from('a115210eed7a88e50ad52662e732a9fb', 'hex')]]))).toMatchObject({ values: { humidity: 58 } })
    const door = service('E4:AA:EC:81:21:AE', 'fe95', '58588b09a3ae2181ecaae40e2c553c040000d28a500c')
    expect(decode(door, new Map([['E4:AA:EC:81:21:AE', Buffer.from('017e52d2684779298709b117c0a75a7b', 'hex')]]))).toMatchObject({ model: 'MCCGQ02HL', values: { open: true } })
    expect(decode(door, NO_KEYS)).toEqual({ kind: 'locked', format: 'mibeacon', model: 'MCCGQ02HL', reason: 'no-key' })
    expect(decode(door, new Map([['E4:AA:EC:81:21:AE', Buffer.alloc(16)]]))).toMatchObject({ kind: 'locked', reason: 'wrong-key' })
  })
})

describe('other makers', () => {
  test('Govee H5075 and H5072: temperature and humidity packed in three bytes', () => {
    expect(decode(maker('A4:C1:38:DD:DB:F8', 0xec88, '00034db26400', 'GVH5075_DBF8'), NO_KEYS)).toEqual({
      kind: 'reading',
      format: 'govee',
      model: 'H5075',
      packet: null,
      values: { temperature: 21.6, humidity: 49.8, battery: 100 },
    })
    expect(decode(maker('A4:C1:38:DD:DB:F8', 0xec88, '00030fc93500'), NO_KEYS)).toMatchObject({ values: { temperature: 20, humidity: 64.9, battery: 53 } })
    // A macOS artefact glues Apple's beacon onto the end; still the same reading.
    expect(decode(maker('A4:C1:38:DD:DB:F8', 0xec88, '000341c264004c000215494e54454c4c495f524f434b535f48575075f2ff0c'), NO_KEYS)).toMatchObject({ values: { temperature: 21.3, humidity: 44.2, battery: 100 } })
  })

  test('Govee: an impossible reading is dropped, the battery kept', () => {
    expect(decode(maker('A4:C1:38:DD:DB:F8', 0xec88, '00bc00043e27'), NO_KEYS)).toMatchObject({ values: { battery: 62 } })
    expect((decode(maker('A4:C1:38:DD:DB:F8', 0xec88, '00bc00043e27'), NO_KEYS) as { values: object }).values).not.toHaveProperty('temperature')
  })

  test('Govee H5074: little-endian hundredths', () => {
    expect(decode(maker('E3:5E:CC:21:5F:F4', 0xec88, '00e609bc126402'), NO_KEYS)).toMatchObject({ model: 'H5074', values: { temperature: 25.34, humidity: 47.96, battery: 100 } })
  })

  test('SwitchBot Meter from service data, Meter Pro from manufacturer data, Meter Pro CO2 with its CO2', () => {
    expect(decode(service('D7:C1:00:00:00:01', 'fd3d', '5400e4069835'), NO_KEYS)).toEqual({
      kind: 'reading',
      format: 'switchbot',
      model: 'Meter',
      packet: null,
      values: { temperature: 24.6, humidity: 53, battery: 100 },
    })
    const pro: Advert = { ...maker('B0:E9:FE:52:DD:84', 0x0969, 'b0e9fe52dd840664 08972c0005'.replace(' ', '')), serviceData: new Map([['fd3d', Buffer.from('340064', 'hex')]]) }
    expect(decode(pro, NO_KEYS)).toMatchObject({ model: 'Meter Pro', values: { temperature: 23.8, humidity: 44, battery: 100 } })
    const co2: Advert = { ...maker('B0:E9:FE:54:32:15', 0x0969, 'b0e9fe543215b7e4079ba4003702d500'), serviceData: new Map([['fd3d', Buffer.from('350064', 'hex')]]) }
    expect(decode(co2, NO_KEYS)).toMatchObject({ model: 'Meter Pro CO2', values: { temperature: 27.7, humidity: 36, co2: 725 } })
  })

  test("RuuviTag data format 5: Ruuvi's own vector, and its invalid values left out", () => {
    expect(decode(maker('CB:B8:33:4C:88:4F', 0x0499, '0512fc5394c37c0004fffc040cac364200cdcbb8334c884f'), NO_KEYS)).toEqual({
      kind: 'reading',
      format: 'ruuvi',
      model: 'RuuviTag',
      packet: 205,
      values: { temperature: 24.3, humidity: 53.49, pressure: 1000.44, batteryVoltage: 2.977, motionCount: 66 },
    })
    expect(decode(maker('CB:B8:33:4C:88:4F', 0x0499, '058000ffffffff800080008000ffffffffffffffffffffff'), NO_KEYS)).toMatchObject({ values: {}, packet: null })
    expect((decode(maker('CB:B8:33:4C:88:4F', 0x0499, '058000ffffffff800080008000ffffffffffffffffffffff'), NO_KEYS) as { values: object }).values).toEqual({})
  })

  test('ThermoBeacon: the reference vector, and the one in this room, heard by the Windows scanner', () => {
    const reference: Advert = { ...maker('AA:BB:CC:DD:EE:FF', 0x0030, '00008b0100005d44d60b590159034400 0c00'.replace(' ', ''), 'ThermoBeacon'), serviceUuids: ['fff0'] }
    expect(decode(reference, NO_KEYS)).toEqual({
      kind: 'reading',
      format: 'thermobeacon',
      model: 'Smart hygrometer',
      packet: null,
      values: { temperature: 21.56, humidity: 53.56, batteryVoltage: 3.03, battery: 100 },
    })
    const here = parseScannerLine('{"address":"e9d2000000de","rssi":-77,"sections":["0106","02f0ff","ff1b000000de000000d2e9f80a5c015c0487403100"]}')!
    expect(decode(here, NO_KEYS)).toMatchObject({ format: 'thermobeacon', values: { temperature: 21.75, humidity: 69.75, batteryVoltage: 2.808, battery: 81 } })
    // Its other packet carries the day's extremes, not the current reading.
    expect(decode(parseScannerLine('{"address":"e9d2000000de","rssi":-77,"sections":["0106","02f0ff","ff1b000000de000000d2e97c01193300001c01a6002400"]}')!, NO_KEYS)).toBeNull()
  })

  test('iBeacon, captured here: the identity a phone app can broadcast', () => {
    const advert = parseScannerLine('{"address":"d80f99319252","rssi":-68,"sections":["ff4c00021550765cb7d9ea4e2199a4fa879613a49281d9f5ebce"]}')!
    expect(decode(advert, NO_KEYS)).toEqual({ kind: 'beacon', uuid: '50765cb7-d9ea-4e21-99a4-fa879613a492', major: 33241, minor: 62955, txPower: -50 })
  })

  test('the rest of the air is nothing to the house', () => {
    expect(decode(parseScannerLine('{"address":"ffac1ada9dad","rssi":-86,"sections":["ff4c0012020000"]}')!, NO_KEYS)).toBeNull()
    expect(decode(parseScannerLine('{"address":"632ee877cab4","rssi":-82,"sections":["039ffe","169ffe0000000000000000000000000000000000000000"]}')!, NO_KEYS)).toBeNull()
  })
})

describe('what the house makes of it', () => {
  test('capabilities from what a sensor reports', () => {
    expect(capabilitiesFor({ temperature: 21, humidity: 40, battery: 90 })).toEqual(['temperature', 'humidity', 'battery'])
    expect(capabilitiesFor({ open: true, battery: 90, buttons: [{ index: 0, event: 'single' }] })).toEqual(['contact', 'battery', 'button'])
    expect(capabilitiesFor({ motion: true, illuminance: 12, co2: 800 })).toEqual(['motion', 'illuminance', 'airQuality'])
  })

  test('state in the shared vocabulary', () => {
    const now = '2026-09-26T10:00:00.000Z'
    expect(stateFrom({ temperature: 21.37, humidity: 45.21, battery: 8, batteryVoltage: 2.95 }, now)).toEqual({ temperature: 21.37, humidity: 45.21, battery: 8, batteryLow: true, batteryVoltage: 2.95 })
    expect(stateFrom({ motion: true }, now)).toEqual({ motion: true, lastMotionAt: now })
    expect(stateFrom({ co2: 1250 }, now)).toEqual({ co2: 1250, airQuality: 'moderate' })
    expect(stateFrom({ buttons: [{ index: 1, event: 'double' }] }, now)).toEqual({ lastEvent: 'double', lastEventAt: now, buttonIndex: 1 })
    expect(stateFrom({ energy: 1346.067, power: 69.14, voltage: 230.1 }, now)).toEqual({ energyTotal: 1346.067, power: 69.14, voltage: 230.1 })
  })

  test('bind keys from the settings, one per sensor; mistakes named without the key', () => {
    const { keys, errors } = parseKeys('A4:C1:38:02:83:F4 = e9ea895fac7cca6d30532432a516f3a8\n54-48-e6-8f-80-a5 231d39c1d7cc1ab1aee224cd096db932\nE4:AA:EC:81:21:AE = 0123\nnot a line')
    expect([...keys.keys()]).toEqual(['A4:C1:38:02:83:F4', '54:48:E6:8F:80:A5'])
    expect(errors).toEqual(['ligne 3 : la clé de E4:AA:EC:81:21:AE doit faire 32 caractères hexadécimaux', 'ligne 4 : attendu "adresse = clé"'])
    expect(errors.join(' ')).not.toContain('0123')
  })

  test('beacons that stand for a person: by iBeacon identity, or by address', () => {
    const { beacons, errors } = parseBeacons('Téléphone de Camille = 50765cb7-d9ea-4e21-99a4-fa879613a492:33241\nClés de Sam = EC:9A:34:89:7F:2D\nOubli = ')
    expect(beacons).toEqual([
      { name: 'Téléphone de Camille', uuid: '50765cb7-d9ea-4e21-99a4-fa879613a492', major: 33241, minor: null, address: null },
      { name: 'Clés de Sam', uuid: null, major: null, minor: null, address: 'EC:9A:34:89:7F:2D' },
    ])
    expect(errors).toEqual(['ligne 3 : attendu "nom = identifiant iBeacon ou adresse"'])
  })
})
