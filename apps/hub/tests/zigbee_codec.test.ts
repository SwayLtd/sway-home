/**
 * Zigbee devices through zigbee2mqtt, read from what each device exposes.
 *
 * zigbee2mqtt describes every device with a list of "exposes": typed features with the
 * property they use in the JSON state, what can be set, and the range. Reading `state` right
 * depends on them - `state` is ON/OFF on a bulb, LOCK/UNLOCK on a lock and OPEN/CLOSE on a
 * blind - so the codec builds a profile from the exposes first and interprets payloads
 * through it, instead of guessing from property names.
 *
 * Fixtures follow https://www.zigbee2mqtt.io/guide/usage/exposes.html and
 * https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html (2.x).
 */

import { describe, expect, test } from 'bun:test'
import { commandPayload, deviceFrom, profileFrom, stateFrom, type Expose } from '#adapters/zigbee_codec'

const state = (property = 'state', on = 'ON', off = 'OFF'): Expose => ({ type: 'binary', name: 'state', property, value_on: on, value_off: off, value_toggle: 'TOGGLE', access: 7 })
const numeric = (name: string, extra: Partial<Expose> = {}): Expose => ({ type: 'numeric', name, property: name, access: 1, ...extra })
const binary = (name: string, on: unknown = true, off: unknown = false): Expose => ({ type: 'binary', name, property: name, value_on: on, value_off: off, access: 1 })

const COLOUR_BULB: Expose[] = [
  {
    type: 'light',
    features: [
      state(),
      numeric('brightness', { value_min: 0, value_max: 254, access: 7 }),
      numeric('color_temp', { value_min: 153, value_max: 500, access: 7, unit: 'mired' }),
      { type: 'composite', name: 'color_xy', property: 'color', access: 7, features: [numeric('x', { access: 7 }), numeric('y', { access: 7 })] },
      { type: 'composite', name: 'color_hs', property: 'color', access: 7, features: [numeric('hue', { access: 7 }), numeric('saturation', { access: 7 })] },
    ],
  },
  { type: 'enum', name: 'identify', property: 'identify', values: ['identify'], access: 2 },
  numeric('linkquality', { unit: 'lqi' }),
]
const XY_ONLY_BULB: Expose[] = [
  {
    type: 'light',
    features: [state(), numeric('brightness', { value_min: 0, value_max: 254, access: 7 }), { type: 'composite', name: 'color_xy', property: 'color', access: 7, features: [numeric('x'), numeric('y')] }],
  },
]
const PLUG: Expose[] = [{ type: 'switch', features: [state()] }, numeric('power', { unit: 'W' }), numeric('energy', { unit: 'kWh' }), numeric('voltage', { unit: 'V' }), numeric('current', { unit: 'A' })]
const CLIMATE_SENSOR: Expose[] = [numeric('temperature', { unit: '°C' }), numeric('humidity', { unit: '%' }), numeric('pressure', { unit: 'hPa' }), numeric('battery', { unit: '%' }), numeric('device_temperature', { unit: '°C' })]
const DOOR: Expose[] = [binary('contact', false, true), numeric('battery', { unit: '%' })]
const MOTION: Expose[] = [binary('occupancy'), numeric('illuminance', { unit: 'lx' }), numeric('battery')]
const PRESENCE: Expose[] = [binary('presence')]
const TWO_GANG: Expose[] = [
  { type: 'switch', endpoint: 'l1', features: [{ ...state('state_l1'), endpoint: 'l1' }] },
  { type: 'switch', endpoint: 'l2', features: [{ ...state('state_l2'), endpoint: 'l2' }] },
]
const TRV: Expose[] = [
  {
    type: 'climate',
    features: [
      numeric('occupied_heating_setpoint', { value_min: 5, value_max: 30, value_step: 0.5, access: 7, unit: '°C' }),
      numeric('local_temperature', { access: 5, unit: '°C' }),
      { type: 'enum', name: 'system_mode', property: 'system_mode', values: ['off', 'auto', 'heat'], access: 7 },
      { type: 'enum', name: 'running_state', property: 'running_state', values: ['idle', 'heat'], access: 5 },
    ],
  },
  numeric('battery'),
]
const BLIND: Expose[] = [{ type: 'cover', features: [state('state', 'OPEN', 'CLOSE'), numeric('position', { value_min: 0, value_max: 100, access: 7 })] }]
const LOCK: Expose[] = [{ type: 'lock', features: [state('state', 'LOCK', 'UNLOCK'), { type: 'enum', name: 'lock_state', property: 'lock_state', values: ['not_fully_locked', 'locked', 'unlocked'], access: 1 }] }]
const REMOTE: Expose[] = [{ type: 'enum', name: 'action', property: 'action', values: ['on', 'off', 'brightness_move_up', 'brightness_stop', 'double'], access: 1 }, numeric('battery')]
const LEAK: Expose[] = [binary('water_leak'), binary('battery_low'), binary('tamper')]

describe('profiles from exposes', () => {
  test('a colour bulb: every light feature, in the order Sway lists them', () => {
    expect(profileFrom(COLOUR_BULB)).toMatchObject({ category: 'light', capabilities: ['onoff', 'brightness', 'colorTemperature', 'color', 'identify', 'connectivity'] })
  })

  test('a plug with metering', () => {
    expect(profileFrom(PLUG)).toMatchObject({ category: 'outlet', capabilities: ['onoff', 'power', 'energy', 'connectivity'] })
  })

  test('a climate sensor; the chip temperature is not the room temperature', () => {
    const profile = profileFrom(CLIMATE_SENSOR)
    expect(profile.category).toBe('sensor')
    expect(profile.capabilities).toEqual(['temperature', 'humidity', 'pressure', 'battery', 'connectivity'])
  })

  test('door, motion, presence, leak', () => {
    expect(profileFrom(DOOR).capabilities).toEqual(['contact', 'battery', 'connectivity'])
    expect(profileFrom(MOTION).capabilities).toEqual(['motion', 'illuminance', 'battery', 'connectivity'])
    expect(profileFrom(PRESENCE).capabilities).toEqual(['occupancy', 'connectivity'])
    expect(profileFrom(LEAK).capabilities).toEqual(['waterLeak', 'battery', 'connectivity'])
  })

  test('a lock and a blind are not switches, whatever their `state` is called', () => {
    expect(profileFrom(LOCK)).toMatchObject({ category: 'lock', capabilities: ['lock', 'connectivity'] })
    expect(profileFrom(BLIND)).toMatchObject({ category: 'cover', capabilities: ['position', 'connectivity'] })
  })

  test('a radiator valve is a thermostat that also reads the room', () => {
    expect(profileFrom(TRV)).toMatchObject({ category: 'climate', capabilities: ['thermostat', 'temperature', 'battery', 'connectivity'] })
  })

  test('a remote is a button', () => {
    expect(profileFrom(REMOTE)).toMatchObject({ category: 'sensor', capabilities: ['button', 'battery', 'connectivity'] })
  })

  test('two gangs are two endpoints', () => {
    const profile = profileFrom(TWO_GANG)
    expect(profile.category).toBe('switch')
    expect(profile.endpoints).toEqual([
      { index: 1, name: 'l1', category: 'switch', capabilities: ['onoff'] },
      { index: 2, name: 'l2', category: 'switch', capabilities: ['onoff'] },
    ])
  })
})

describe('state payloads', () => {
  test('a bulb in white mode: level in percent, colour temperature in kelvin', () => {
    expect(stateFrom({ state: 'ON', brightness: 127, color_temp: 370, color_mode: 'color_temp', linkquality: 120 }, profileFrom(COLOUR_BULB)).state).toEqual({
      on: true,
      brightness: 50,
      colorTemperature: 2703,
      linkQuality: 120,
    })
  })

  test('a bulb in colour mode reports hue and saturation, from xy when that is all it sends', () => {
    expect(stateFrom({ color: { hue: 200, saturation: 80 }, color_mode: 'hs' }, profileFrom(COLOUR_BULB)).state).toMatchObject({ hue: 200, saturation: 80 })
    const fromXy = stateFrom({ color: { x: 0.1355, y: 0.0399 }, color_mode: 'xy' }, profileFrom(XY_ONLY_BULB)).state
    // Pure blue in CIE xy.
    expect(Number(fromXy.hue)).toBeGreaterThan(220)
    expect(Number(fromXy.hue)).toBeLessThan(260)
    expect(Number(fromXy.saturation)).toBeGreaterThan(80)
  })

  test('a plug with its meter', () => {
    expect(stateFrom({ state: 'OFF', power: 12.3, energy: 4.56, voltage: 231, current: 0.05 }, profileFrom(PLUG)).state).toEqual({ on: false, power: 12.3, energyTotal: 4.56, voltage: 231, current: 0.05 })
  })

  test('contact true means closed', () => {
    expect(stateFrom({ contact: true, battery: 90 }, profileFrom(DOOR)).state).toEqual({ open: false, battery: 90, batteryLow: false })
    expect(stateFrom({ contact: false }, profileFrom(DOOR)).state).toEqual({ open: true })
  })

  test('motion and presence', () => {
    expect(stateFrom({ occupancy: true, illuminance: 42 }, profileFrom(MOTION)).state).toMatchObject({ motion: true, illuminance: 42 })
    expect(stateFrom({ presence: true }, profileFrom(PRESENCE)).state).toEqual({ occupied: true })
  })

  test('the chip temperature never lands in `temperature`', () => {
    expect(stateFrom({ temperature: 21.4, device_temperature: 33 }, profileFrom(CLIMATE_SENSOR)).state).toEqual({ temperature: 21.4 })
  })

  test('a lock reports locked, never on', () => {
    expect(stateFrom({ state: 'LOCK', lock_state: 'locked' }, profileFrom(LOCK)).state).toEqual({ locked: true })
    expect(stateFrom({ state: 'UNLOCK', lock_state: 'unlocked' }, profileFrom(LOCK)).state).toEqual({ locked: false })
  })

  test('a blind reports its position, never on', () => {
    expect(stateFrom({ state: 'OPEN', position: 60 }, profileFrom(BLIND)).state).toEqual({ position: 60 })
  })

  test('a radiator valve', () => {
    expect(stateFrom({ occupied_heating_setpoint: 21, local_temperature: 19.2, system_mode: 'heat', running_state: 'heat' }, profileFrom(TRV)).state).toEqual({
      targetTemperature: 21,
      currentTemperature: 19.2,
      temperature: 19.2,
      hvacMode: 'heat',
      hvacAction: 'heating',
    })
  })

  test('each gang reports on its own endpoint, the first one on the device too', () => {
    const read = stateFrom({ state_l1: 'ON', state_l2: 'OFF' }, profileFrom(TWO_GANG))
    expect(read.state).toEqual({ on: true })
    expect(read.endpoints).toEqual({ 1: { on: true }, 2: { on: false } })
  })

  test('a button press is an event, and the last press is remembered', () => {
    const read = stateFrom({ action: 'brightness_move_up', battery: 15 }, profileFrom(REMOTE))
    expect(read.events).toEqual(['brightness_move_up'])
    expect(read.state).toMatchObject({ lastEvent: 'hold', battery: 15, batteryLow: true })
    expect(stateFrom({ action: 'double' }, profileFrom(REMOTE)).state).toMatchObject({ lastEvent: 'double' })
    // An empty action is zigbee2mqtt clearing the field, not a press.
    expect(stateFrom({ action: '' }, profileFrom(REMOTE)).events).toEqual([])
  })

  test('a low-battery flag without a level', () => {
    expect(stateFrom({ water_leak: true, battery_low: true }, profileFrom(LEAK)).state).toEqual({ leak: true, batteryLow: true })
  })
})

describe('commands as /set payloads', () => {
  const bulb = profileFrom(COLOUR_BULB)

  test('on and off, with the transition in seconds', () => {
    expect(commandPayload('turnOn', { transitionMs: 500 }, bulb)).toEqual({ state: 'ON', transition: 0.5 })
    expect(commandPayload('turnOff', {}, bulb)).toEqual({ state: 'OFF' })
    expect(commandPayload('toggle', {}, bulb)).toEqual({ state: 'TOGGLE' })
  })

  test('brightness in the device range; zero is off', () => {
    expect(commandPayload('setBrightness', { brightness: 50 }, bulb)).toEqual({ state: 'ON', brightness: 127 })
    expect(commandPayload('setBrightness', { brightness: 0 }, bulb)).toEqual({ state: 'OFF' })
    expect(commandPayload('stepBrightness', { delta: 10 }, bulb)).toEqual({ brightness_step: 25 })
  })

  test('colour temperature in mireds, held inside what the bulb accepts', () => {
    expect(commandPayload('setColorTemperature', { kelvin: 2700 }, bulb)).toEqual({ state: 'ON', color_temp: 370 })
    expect(commandPayload('setColorTemperature', { kelvin: 1000 }, bulb)).toEqual({ state: 'ON', color_temp: 500 })
  })

  test('colour as hue and saturation where supported, as RGB where the bulb only knows xy', () => {
    expect(commandPayload('setColor', { hue: 200, saturation: 80 }, bulb)).toEqual({ state: 'ON', color: { hue: 200, saturation: 80 } })
    expect(commandPayload('setColor', { hue: 0, saturation: 100 }, profileFrom(XY_ONLY_BULB))).toEqual({ state: 'ON', color: { r: 255, g: 0, b: 0 } })
    expect(commandPayload('setColorRgb', { r: 1, g: 2, b: 3 }, bulb)).toEqual({ state: 'ON', color: { r: 1, g: 2, b: 3 } })
  })

  test('identify, where the device has it', () => {
    expect(commandPayload('identify', {}, bulb)).toEqual({ identify: 'identify' })
    expect(commandPayload('identify', {}, profileFrom(PLUG))).toBeNull()
  })

  test('blinds, locks and valves use their own vocabulary', () => {
    expect(commandPayload('setPosition', { position: 30 }, profileFrom(BLIND))).toEqual({ position: 30 })
    expect(commandPayload('open', {}, profileFrom(BLIND))).toEqual({ state: 'OPEN' })
    expect(commandPayload('stop', {}, profileFrom(BLIND))).toEqual({ state: 'STOP' })
    expect(commandPayload('lock', {}, profileFrom(LOCK))).toEqual({ state: 'LOCK' })
    expect(commandPayload('unlock', {}, profileFrom(LOCK))).toEqual({ state: 'UNLOCK' })
  })

  test('a set point snapped to the valve step and range; a mode it does not have is refused', () => {
    const trv = profileFrom(TRV)
    expect(commandPayload('setTargetTemperature', { celsius: 21.3 }, trv)).toEqual({ occupied_heating_setpoint: 21.5 })
    expect(commandPayload('setTargetTemperature', { celsius: 40 }, trv)).toEqual({ occupied_heating_setpoint: 30 })
    expect(commandPayload('setHvacMode', { mode: 'heat' }, trv)).toEqual({ system_mode: 'heat' })
    expect(commandPayload('setHvacMode', { mode: 'cool' }, trv)).toBeNull()
  })

  test('a gang is addressed by its endpoint', () => {
    expect(commandPayload('turnOn', {}, profileFrom(TWO_GANG), 2)).toEqual({ state_l2: 'ON' })
    expect(commandPayload('turnOn', {}, profileFrom(TWO_GANG))).toEqual({ state_l1: 'ON' })
  })

  test('what the device cannot do is refused', () => {
    expect(commandPayload('setBrightness', { brightness: 50 }, profileFrom(PLUG))).toBeNull()
    expect(commandPayload('turnOn', {}, profileFrom(CLIMATE_SENSOR))).toBeNull()
    expect(commandPayload('turnOn', {}, profileFrom(LOCK))).toBeNull()
  })
})

describe('devices from bridge/devices', () => {
  const entry = (patch: Record<string, unknown>) => ({
    ieee_address: '0x00158d0001a2b3c4',
    friendly_name: 'Capteur salon',
    type: 'EndDevice',
    supported: true,
    disabled: false,
    interview_completed: true,
    power_source: 'Battery',
    definition: { model: 'WSDCGQ11LM', vendor: 'Aqara', description: 'Temperature, humidity and pressure sensor', exposes: CLIMATE_SENSOR },
    ...patch,
  })

  test('keyed by IEEE address, which survives a rename', () => {
    expect(deviceFrom(entry({}))).toMatchObject({
      adapterId: 'zigbee',
      nativeId: '0x00158d0001a2b3c4',
      uid: 'zigbee:0x00158d0001a2b3c4',
      name: 'Capteur salon',
      category: 'sensor',
      transport: 'zigbee',
      manufacturer: 'Aqara',
      model: 'WSDCGQ11LM',
      meta: { friendlyName: 'Capteur salon', powerSource: 'Battery' },
    })
  })

  test('the coordinator, disabled devices and unfinished interviews are not devices yet', () => {
    expect(deviceFrom(entry({ type: 'Coordinator' }))).toBeNull()
    expect(deviceFrom(entry({ disabled: true }))).toBeNull()
    expect(deviceFrom(entry({ interview_completed: false, interview_state: 'IN_PROGRESS' }))).toBeNull()
  })

  test('an unsupported device with nothing exposed is skipped rather than shown empty', () => {
    expect(deviceFrom(entry({ supported: false, definition: null }))).toBeNull()
  })
})
