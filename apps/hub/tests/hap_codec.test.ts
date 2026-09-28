/**
 * HomeKit accessories in the house's vocabulary.
 *
 * The accessory database is the real answer HAP-NodeJS gives to GET /accessories for the test
 * bridge (fixtures/hap_accessories.json): a bridge, a colour bulb, a thermometer with its
 * battery, a door contact, a lock, a button and a shade. Services and characteristics are
 * identified by Apple's short UUIDs, checked against HAP-NodeJS's definitions.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buttonAction,
  capabilitiesOf,
  categoryOf,
  isBridge,
  parseAccessories,
  parseAdvert,
  parseSetupCode,
  planWrite,
  setupHash,
  shortUuid,
  stateOf,
  type HapService,
} from '#adapters/hap_codec'

const accessories = parseAccessories(JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'hap_accessories.json'), 'utf8')))
const services = (aid: number) => accessories.find((accessory) => accessory.aid === aid)!.services

describe('the accessory database', () => {
  test('short and long UUIDs are the same thing', () => {
    expect(shortUuid('00000025-0000-1000-8000-0026BB765291')).toBe('25')
    expect(shortUuid('25')).toBe('25')
    expect(shortUuid('000000ce-0000-1000-8000-0026bb765291')).toBe('CE')
    expect(shortUuid('E863F10A-079E-48FF-8F27-9C2605A29F52')).toBe('E863F10A-079E-48FF-8F27-9C2605A29F52')
  })

  test('a bridge and what it bridges, each with its own identity', () => {
    expect(accessories.map((accessory) => accessory.aid)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(isBridge(accessories)).toBe(true)
    expect(accessories[0]!.info).toMatchObject({ manufacturer: 'Sway Test', model: 'Pont de test', firmware: '1.2.3' })
    expect(accessories[1]!.info).toMatchObject({ name: 'Lampe du salon', model: 'Modèle Lampe du salon', serialNumber: 'light-CC:22:3D:E3:CE:F8' })
    expect(isBridge([accessories[1]!])).toBe(false)
  })
})

describe('what each accessory is and can do', () => {
  test('a colour bulb', () => {
    expect(categoryOf(services(2))).toBe('light')
    expect(capabilitiesOf(services(2))).toEqual(['onoff', 'brightness', 'colorTemperature', 'color', 'identify'])
    expect(stateOf(services(2))).toEqual({ on: false, brightness: 40, colorTemperature: 4000, colorTemperatureRange: [2000, 7143], hue: 0, saturation: 0 })
  })

  test('a thermometer with its battery', () => {
    expect(categoryOf(services(3))).toBe('sensor')
    expect(capabilitiesOf(services(3))).toEqual(['temperature', 'humidity', 'battery', 'identify'])
    expect(stateOf(services(3))).toEqual({ temperature: 21.5, humidity: 48, battery: 87, batteryLow: false })
  })

  test('a door, a lock, a button, a shade', () => {
    expect(capabilitiesOf(services(4))).toEqual(['contact', 'identify'])
    expect(stateOf(services(4))).toEqual({ open: false })
    expect(categoryOf(services(5))).toBe('lock')
    expect(stateOf(services(5))).toEqual({ locked: true, jammed: false })
    expect(categoryOf(services(6))).toBe('switch')
    expect(capabilitiesOf(services(6))).toEqual(['button', 'identify'])
    expect(stateOf(services(6))).toEqual({})
    expect(categoryOf(services(7))).toBe('cover')
    expect(stateOf(services(7))).toEqual({ position: 100, moving: 'idle' })
  })

  test('the bridge itself does nothing but bridge', () => {
    expect(categoryOf(services(1))).toBe('gateway')
    expect(capabilitiesOf(services(1))).toEqual(['identify'])
  })
})

/** A service built by hand, for the kinds the test bridge does not carry. */
function service(type: string, characteristics: [type: string, value: unknown, extra?: Record<string, unknown>][]): HapService[] {
  return [
    {
      aid: 1,
      iid: 8,
      type,
      name: null,
      characteristics: characteristics.map(([charType, value, extra], index) => ({ aid: 1, iid: 9 + index, type: charType, value, perms: ['pr', 'pw', 'ev'], ...extra })),
    },
  ]
}

describe('more kinds of accessories', () => {
  test('a thermostat, in its mode', () => {
    const heating = service('4A', [
      ['F', 1],
      ['33', 1],
      ['11', 19.5],
      ['35', 21],
      ['36', 0],
    ])
    expect(categoryOf(heating)).toBe('climate')
    expect(stateOf(heating)).toEqual({ currentTemperature: 19.5, targetTemperature: 21, hvacMode: 'heat', hvacAction: 'heating' })
    const auto = service('4A', [
      ['F', 0],
      ['33', 3],
      ['11', 22],
      ['35', 21],
      ['12', 19],
      ['D', 24],
    ])
    expect(stateOf(auto)).toEqual({ currentTemperature: 22, targetTemperature: 21, hvacMode: 'auto', hvacAction: 'idle', targetTemperatureRange: [19, 24] })
    expect(stateOf(service('4A', [['F', 0], ['33', 0], ['11', 18], ['35', 20]]))).toMatchObject({ hvacMode: 'off', hvacAction: 'off' })
  })

  test('motion, presence, leaks, smoke and air', () => {
    const at = '2026-09-26T20:00:00.000Z'
    expect(stateOf(service('85', [['22', true]]), at)).toEqual({ motion: true, lastMotionAt: at })
    expect(stateOf(service('86', [['71', 1]]))).toEqual({ occupied: true })
    expect(stateOf(service('83', [['70', 1]]))).toEqual({ leak: true })
    expect(stateOf(service('87', [['76', 0]]))).toEqual({ smoke: false })
    expect(stateOf(service('7F', [['69', 1]]))).toEqual({ co: true })
    expect(stateOf(service('84', [['6B', 320.5]]))).toEqual({ illuminance: 320.5 })
    expect(stateOf(service('8D', [['95', 3], ['93', 950], ['C6', 12], ['C8', 80]]))).toEqual({ airQuality: 'fair', co2: 950, pm25: 12, voc: 80 })
  })

  test('a fan, a valve, a garage door, an outlet', () => {
    expect(capabilitiesOf(service('B7', [['B0', 1], ['29', 60], ['B6', 1]]))).toEqual(['onoff', 'fan'])
    expect(stateOf(service('B7', [['B0', 1], ['29', 60], ['B6', 1]]))).toEqual({ on: true, fanSpeed: 60, fanMode: 'medium', oscillating: true })
    expect(stateOf(service('B7', [['B0', 0], ['29', 60]]))).toMatchObject({ on: false, fanMode: 'off' })
    expect(stateOf(service('D0', [['B0', 1], ['D2', 1]]))).toEqual({ valveOpen: true })
    expect(capabilitiesOf(service('41', [['E', 2], ['32', 0], ['24', false]]))).toEqual(['garage'])
    expect(stateOf(service('41', [['E', 2], ['32', 0], ['24', false]]))).toEqual({ doorState: 'opening' })
    expect(categoryOf(service('47', [['25', true]]))).toBe('outlet')
    expect(stateOf(service('47', [['25', true]]))).toEqual({ on: true })
  })
})

describe('what a command becomes', () => {
  test('a bulb: on, off, brightness, white and colour', () => {
    expect(planWrite(services(2), 'turnOn', {})).toEqual({ writes: [{ aid: 2, iid: 10, value: true }] })
    expect(planWrite(services(2), 'toggle', {})).toEqual({ writes: [{ aid: 2, iid: 10, value: true }] })
    expect(planWrite(services(2), 'setBrightness', { brightness: 50 })).toEqual({
      writes: [
        { aid: 2, iid: 10, value: true },
        { aid: 2, iid: 11, value: 50 },
      ],
    })
    expect(planWrite(services(2), 'setBrightness', { brightness: 0 })).toEqual({ writes: [{ aid: 2, iid: 10, value: false }] })
    expect(planWrite(services(2), 'stepBrightness', { delta: -15 })).toMatchObject({ writes: [{ iid: 10, value: true }, { iid: 11, value: 25 }] })
    expect(planWrite(services(2), 'setColorTemperature', { kelvin: 2700 })).toEqual({ writes: [{ aid: 2, iid: 14, value: 370 }] })
    expect(planWrite(services(2), 'setColorTemperature', { kelvin: 10000 })).toEqual({ writes: [{ aid: 2, iid: 14, value: 140 }] })
    expect(planWrite(services(2), 'setColor', { hue: 120, saturation: 100 })).toEqual({
      writes: [
        { aid: 2, iid: 12, value: 120 },
        { aid: 2, iid: 13, value: 100 },
      ],
    })
    expect(planWrite(services(2), 'setColorName', { name: 'rouge' })).toMatchObject({ writes: [{ iid: 12, value: 0 }, { iid: 13, value: 100 }] })
    expect(planWrite(services(2), 'identify', {})).toEqual({ writes: [{ aid: 2, iid: 2, value: true }] })
  })

  test('a lock, a shade', () => {
    expect(planWrite(services(5), 'unlock', {})).toEqual({ writes: [{ aid: 5, iid: 11, value: 0 }] })
    expect(planWrite(services(5), 'lock', {})).toEqual({ writes: [{ aid: 5, iid: 11, value: 1 }] })
    expect(planWrite(services(7), 'setPosition', { position: 30 })).toEqual({ writes: [{ aid: 7, iid: 12, value: 30 }] })
    expect(planWrite(services(7), 'close', {})).toEqual({ writes: [{ aid: 7, iid: 12, value: 0 }] })
    expect(planWrite(services(7), 'open', {})).toEqual({ writes: [{ aid: 7, iid: 12, value: 100 }] })
  })

  test('a thermostat and a fan', () => {
    const thermostat = service('4A', [['F', 1], ['33', 1], ['11', 19.5], ['35', 21]])
    expect(planWrite(thermostat, 'setTargetTemperature', { celsius: 22.5 })).toEqual({ writes: [{ aid: 1, iid: 12, value: 22.5 }] })
    expect(planWrite(thermostat, 'setHvacMode', { mode: 'cool' })).toEqual({ writes: [{ aid: 1, iid: 10, value: 2 }] })
    expect(planWrite(thermostat, 'setHvacMode', { mode: 'dry' })).toEqual({ error: expect.stringMatching(/dry/) })
    const fan = service('B7', [['B0', 0], ['29', 0], ['B6', 0]])
    expect(planWrite(fan, 'setFanSpeed', { speed: 70 })).toEqual({ writes: [{ aid: 1, iid: 9, value: 1 }, { aid: 1, iid: 10, value: 70 }] })
    expect(planWrite(fan, 'setOscillating', { oscillating: true })).toEqual({ writes: [{ aid: 1, iid: 11, value: 1 }] })
    expect(planWrite(fan, 'turnOff', {})).toEqual({ writes: [{ aid: 1, iid: 9, value: 0 }] })
  })

  test('what it cannot do is refused before anything is sent', () => {
    expect(planWrite(services(3), 'turnOn', {})).toEqual({ error: expect.stringMatching(/turnOn/) })
    expect(planWrite(services(4), 'setPosition', { position: 3 })).toEqual({ error: expect.stringMatching(/setPosition/) })
  })
})

describe('buttons and codes', () => {
  test('a programmable switch says single, double or long', () => {
    expect(buttonAction(0)).toBe('single')
    expect(buttonAction(1)).toBe('double')
    expect(buttonAction(2)).toBe('hold')
    expect(buttonAction(7)).toBeNull()
    expect(buttonAction(null)).toBeNull()
  })

  test('a setup code as it is printed, typed, or in a QR code', () => {
    expect(parseSetupCode('031-45-154')).toEqual({ code: '031-45-154', setupId: null, category: null })
    expect(parseSetupCode('03145154')).toEqual({ code: '031-45-154', setupId: null, category: null })
    expect(parseSetupCode('0314-5154')).toMatchObject({ code: '031-45-154' })
    expect(parseSetupCode('X-HM://0023ISYWY7OSX')).toEqual({ code: '031-45-154', setupId: '7OSX', category: 2 })
    expect(parseSetupCode('x-hm://00527813XAB12')).toEqual({ code: '111-22-333', setupId: 'AB12', category: 5 })
    expect(parseSetupCode('123-45-678')).toEqual({ error: expect.stringMatching(/interdit/) })
    expect(parseSetupCode('111-11-111')).toEqual({ error: expect.stringMatching(/interdit/) })
    expect(parseSetupCode('12-34')).toEqual({ error: expect.stringMatching(/8 chiffres/) })
  })

  test('the setup hash an accessory advertises, from its setup id and device id', () => {
    expect(setupHash('7OSX', 'cc:22:3d:e3:ce:f6')).toBe('3sDeIg==')
  })
})

describe('what an accessory advertises', () => {
  // The record HAP-NodeJS advertised for the test bridge (fixtures/hap_accessory.mjs) before
  // its pairing, and the QR code it showed.
  const txt = { 'c#': '2', ff: '0', id: 'AA:BB:CC:DD:EE:01', md: 'Pont de test', pv: '1.1', 's#': '1', sf: '1', ci: '2', sh: 'MxmKqg==' }
  const heard = (changes: Partial<Parameters<typeof parseAdvert>[0]> = {}) =>
    parseAdvert({ name: 'Pont HomeKit 4534', addresses: ['fe80::1', '192.168.1.40'], port: 52811, txt, ...changes })

  test('who it is, where, and whether it waits for a controller', () => {
    expect(heard()).toEqual({
      id: 'AA:BB:CC:DD:EE:01',
      name: 'Pont HomeKit 4534',
      host: '192.168.1.40',
      port: 52811,
      paired: false,
      category: 2,
      configNumber: 2,
      setupHash: 'MxmKqg==',
      model: 'Pont de test',
    })
    expect(heard({ txt: { ...txt, sf: '0' } })?.paired).toBe(true)
    // Bit 2 flags a problem; it says nothing about pairing.
    expect(heard({ txt: { ...txt, sf: '4' } })?.paired).toBe(true)
    expect(heard({ txt: { ...txt, sf: '5' } })?.paired).toBe(false)
    expect(heard({ addresses: ['fe80::1'] })?.host).toBe('fe80::1')
  })

  test('its QR code names it among others, by the setup hash', () => {
    const code = parseSetupCode('X-HM://0023ISYWYR4UY')
    expect(code).toMatchObject({ code: '031-45-154', setupId: 'R4UY', category: 2 })
    expect(setupHash('R4UY', heard()!.id)).toBe('MxmKqg==')
  })

  test('a record it could not be reached by is no accessory', () => {
    expect(heard({ txt: { ...txt, id: '' } })).toBeNull()
    expect(heard({ addresses: [] })).toBeNull()
    expect(heard({ port: null })).toBeNull()
  })
})
