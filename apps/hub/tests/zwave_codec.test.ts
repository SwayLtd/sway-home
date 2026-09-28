/**
 * Z-Wave nodes, read from the values Z-Wave JS reports.
 *
 * zwave-js-server hands over each node as a list of values, one per command class,
 * endpoint and property: Binary Switch `currentValue`, Multilevel Switch 0..99, Door Lock
 * `currentMode` 0/255, Meter readings by unit, Notification events by number. The codec turns
 * that list into Sway capabilities and state, and a Sway command into the value to write.
 *
 * Value ids and numbers follow the Z-Wave JS documentation and the Z-Wave command class
 * specifications (Notification CC event numbers, Multilevel Switch 99 = full, Door Lock 255
 * = secured). Node status: Unknown 0, Asleep 1, Awake 2, Dead 3, Alive 4
 * (zwave-js packages/core/src/definitions/NodeStatus.ts).
 */

import { describe, expect, test } from 'bun:test'
import { nodeDevice, nodeState, setValueFor, type ZwaveNode, type ZwaveValue } from '#adapters/zwave_codec'

const value = (commandClass: number, property: string | number, v: unknown, extra: Partial<ZwaveValue> = {}): ZwaveValue => ({
  commandClass,
  endpoint: 0,
  property,
  value: v,
  metadata: { readable: true, writeable: false },
  ...extra,
})
const writable = (commandClass: number, property: string, extra: Partial<ZwaveValue> = {}): ZwaveValue => value(commandClass, property, undefined, { metadata: { readable: false, writeable: true }, ...extra })

function node(nodeId: number, generic: string, values: ZwaveValue[], patch: Partial<ZwaveNode> = {}): ZwaveNode {
  return {
    nodeId,
    name: '',
    location: '',
    status: 4,
    ready: true,
    isControllerNode: false,
    deviceClass: { generic: { label: generic }, specific: { label: '' } },
    deviceConfig: { manufacturer: 'Vendor', label: 'MODEL', description: 'Device' },
    values,
    ...patch,
  }
}

const METERED_SWITCH = node(5, 'Binary Switch', [
  value(37, 'currentValue', true),
  writable(37, 'targetValue'),
  value(50, 'value', 1.234, { propertyKey: 65537, metadata: { readable: true, writeable: false, unit: 'kWh' } }),
  value(50, 'value', 42.5, { propertyKey: 66049, metadata: { readable: true, writeable: false, unit: 'W' } }),
], { name: 'Prise four', deviceConfig: { manufacturer: 'AEON Labs', label: 'ZW139', description: 'Nano Switch' } })

const DIMMER = node(6, 'Multilevel Switch', [value(38, 'currentValue', 49), writable(38, 'targetValue'), value(50, 'value', 12, { propertyKey: 66049, metadata: { readable: true, writeable: false, unit: 'W' } })], {
  deviceClass: { generic: { label: 'Multilevel Switch' }, specific: { label: 'Multilevel Power Switch' } },
})

const SHUTTER = node(7, 'Multilevel Switch', [value(38, 'currentValue', 99), writable(38, 'targetValue'), writable(38, 'Up'), writable(38, 'Down')], {
  deviceClass: { generic: { label: 'Multilevel Switch' }, specific: { label: 'Motor Control Class C' } },
})

const LOCK = node(8, 'Entry Control', [value(98, 'currentMode', 255), writable(98, 'targetMode'), value(128, 'level', 80)])

const MULTISENSOR = node(9, 'Multilevel Sensor', [
  value(49, 'Air temperature', 21.5, { metadata: { readable: true, writeable: false, unit: '°C' } }),
  value(49, 'Humidity', 45, { metadata: { readable: true, writeable: false, unit: '%' } }),
  value(49, 'Illuminance', 120, { metadata: { readable: true, writeable: false, unit: 'Lux' } }),
  value(113, 'Home Security', 8, { propertyKey: 'Motion sensor status' }),
  value(128, 'level', 90),
])

const DOOR = node(10, 'Notification Sensor', [value(113, 'Access Control', 22, { propertyKey: 'Door state' }), value(128, 'level', 15), value(128, 'isLow', true)])
const LEAK = node(11, 'Notification Sensor', [value(113, 'Water Alarm', 2, { propertyKey: 'Sensor status' })])

const THERMOSTAT = node(12, 'Thermostat', [
  value(67, 'setpoint', 20.5, { propertyKey: 1, metadata: { readable: true, writeable: true, unit: '°C' } }),
  value(64, 'mode', 1, { metadata: { readable: true, writeable: true, states: { 0: 'Off', 1: 'Heat', 2: 'Cool', 3: 'Auto' } } }),
  value(66, 'state', 1),
  value(49, 'Air temperature', 66.2, { metadata: { readable: true, writeable: false, unit: '°F' } }),
])

const DOUBLE_RELAY = node(13, 'Binary Switch', [
  value(37, 'currentValue', true, { endpoint: 1 }),
  writable(37, 'targetValue', { endpoint: 1 }),
  value(37, 'currentValue', false, { endpoint: 2 }),
  writable(37, 'targetValue', { endpoint: 2 }),
])

const SIREN = node(14, 'Siren', [value(37, 'currentValue', false), writable(37, 'targetValue')])
const CONTROLLER = node(1, 'Static Controller', [], { isControllerNode: true })

describe('what a node is', () => {
  test('a metered switch: on/off, power and energy, named after the node', () => {
    expect(nodeDevice(METERED_SWITCH, 3967882672)).toMatchObject({
      adapterId: 'zwave',
      nativeId: '5',
      uid: 'zwave:3967882672:5',
      name: 'Prise four',
      category: 'outlet',
      capabilities: ['onoff', 'power', 'energy'],
      transport: 'zwave',
      manufacturer: 'AEON Labs',
      model: 'ZW139',
    })
  })

  test('a node with no name is named by what it is', () => {
    expect(nodeDevice(DIMMER, 1)?.name).toBe('Device (nœud 6)')
  })

  test('a dimmer is a light; a motor on the same command class is a blind', () => {
    expect(nodeDevice(DIMMER, 1)).toMatchObject({ category: 'light', capabilities: ['onoff', 'brightness', 'power'] })
    expect(nodeDevice(SHUTTER, 1)).toMatchObject({ category: 'cover', capabilities: ['position'] })
  })

  test('a lock, a multisensor, a door sensor, a leak sensor', () => {
    expect(nodeDevice(LOCK, 1)).toMatchObject({ category: 'lock', capabilities: ['lock', 'battery'] })
    expect(nodeDevice(MULTISENSOR, 1)).toMatchObject({ category: 'sensor', capabilities: ['temperature', 'humidity', 'illuminance', 'motion', 'battery'] })
    expect(nodeDevice(DOOR, 1)).toMatchObject({ category: 'sensor', capabilities: ['contact', 'battery'] })
    expect(nodeDevice(LEAK, 1)).toMatchObject({ category: 'sensor', capabilities: ['waterLeak'] })
  })

  test('a thermostat, and a siren that is a switch underneath', () => {
    expect(nodeDevice(THERMOSTAT, 1)).toMatchObject({ category: 'climate', capabilities: ['thermostat', 'temperature'] })
    expect(nodeDevice(SIREN, 1)).toMatchObject({ category: 'appliance', capabilities: ['siren'] })
  })

  test('a two-channel relay is two endpoints', () => {
    expect(nodeDevice(DOUBLE_RELAY, 1)?.endpoints).toEqual([
      { index: 1, name: 'Canal 1', category: 'switch', capabilities: ['onoff'] },
      { index: 2, name: 'Canal 2', category: 'switch', capabilities: ['onoff'] },
    ])
  })

  test('the controller itself is not a device', () => {
    expect(nodeDevice(CONTROLLER, 1)).toBeNull()
  })
})

describe('state', () => {
  test('a metered switch', () => {
    expect(nodeState(METERED_SWITCH).state).toEqual({ on: true, power: 42.5, energyTotal: 1.234 })
  })

  test('Multilevel Switch runs 0 to 99: 99 is full, and a dimmer at 0 is off', () => {
    expect(nodeState(DIMMER).state).toMatchObject({ on: true, brightness: 49 })
    expect(nodeState(SHUTTER).state).toEqual({ position: 100 })
    expect(nodeState(node(6, 'Multilevel Switch', [value(38, 'currentValue', 0)], { deviceClass: DIMMER.deviceClass })).state).toMatchObject({ on: false, brightness: 0 })
  })

  test('Door Lock mode 255 is secured, anything else is not', () => {
    expect(nodeState(LOCK).state).toMatchObject({ locked: true, battery: 80 })
    expect(nodeState(node(8, 'Entry Control', [value(98, 'currentMode', 0)])).state).toMatchObject({ locked: false })
  })

  test('sensors, with motion from the Notification event number', () => {
    expect(nodeState(MULTISENSOR).state).toEqual({ temperature: 21.5, humidity: 45, illuminance: 120, motion: true, battery: 90, batteryLow: false })
    expect(nodeState(node(9, 'Multilevel Sensor', [value(113, 'Home Security', 0, { propertyKey: 'Motion sensor status' })])).state).toEqual({ motion: false })
  })

  test('door state 22 is open, 23 closed; the battery flag wins over the level', () => {
    expect(nodeState(DOOR).state).toEqual({ open: true, battery: 15, batteryLow: true })
    expect(nodeState(node(10, 'Notification Sensor', [value(113, 'Access Control', 23, { propertyKey: 'Door state' })])).state).toEqual({ open: false })
  })

  test('a water leak', () => {
    expect(nodeState(LEAK).state).toEqual({ leak: true })
  })

  test('a thermostat in Sway units, whatever unit the node reports in', () => {
    expect(nodeState(THERMOSTAT).state).toEqual({ targetTemperature: 20.5, hvacMode: 'heat', hvacAction: 'heating', temperature: 19, currentTemperature: 19 })
  })

  test('each channel of a relay on its own endpoint', () => {
    const read = nodeState(DOUBLE_RELAY)
    expect(read.endpoints).toEqual({ 1: { on: true }, 2: { on: false } })
    expect(read.state).toEqual({ on: true })
  })
})

describe('commands as values to write', () => {
  test('on and off on a binary switch', () => {
    expect(setValueFor(METERED_SWITCH, 'turnOn', {})).toEqual({ valueId: { commandClass: 37, endpoint: 0, property: 'targetValue' }, value: true })
    expect(setValueFor(METERED_SWITCH, 'turnOff', {})).toMatchObject({ value: false })
  })

  test('a dimmer: on restores the last level, a level is capped at 99', () => {
    expect(setValueFor(DIMMER, 'turnOn', {})).toEqual({ valueId: { commandClass: 38, endpoint: 0, property: 'targetValue' }, value: 255 })
    expect(setValueFor(DIMMER, 'turnOff', {})).toMatchObject({ value: 0 })
    expect(setValueFor(DIMMER, 'setBrightness', { brightness: 100 })).toMatchObject({ value: 99 })
    expect(setValueFor(DIMMER, 'setBrightness', { brightness: 40 })).toMatchObject({ value: 40 })
  })

  test('a blind: open, close, a position, and stop', () => {
    expect(setValueFor(SHUTTER, 'open', {})).toMatchObject({ value: 99 })
    expect(setValueFor(SHUTTER, 'close', {})).toMatchObject({ value: 0 })
    expect(setValueFor(SHUTTER, 'setPosition', { position: 30 })).toMatchObject({ value: 30 })
    expect(setValueFor(SHUTTER, 'stop', {})).toEqual({ valueId: { commandClass: 38, endpoint: 0, property: 'Up' }, value: false })
  })

  test('a lock', () => {
    expect(setValueFor(LOCK, 'lock', {})).toEqual({ valueId: { commandClass: 98, endpoint: 0, property: 'targetMode' }, value: 255 })
    expect(setValueFor(LOCK, 'unlock', {})).toMatchObject({ value: 0 })
  })

  test('a thermostat: the heating set point, and a mode by its name', () => {
    expect(setValueFor(THERMOSTAT, 'setTargetTemperature', { celsius: 21 })).toEqual({ valueId: { commandClass: 67, endpoint: 0, property: 'setpoint', propertyKey: 1 }, value: 21 })
    expect(setValueFor(THERMOSTAT, 'setHvacMode', { mode: 'auto' })).toEqual({ valueId: { commandClass: 64, endpoint: 0, property: 'mode' }, value: 3 })
    expect(setValueFor(THERMOSTAT, 'setHvacMode', { mode: 'dry' })).toBeNull()
  })

  test('a siren', () => {
    expect(setValueFor(SIREN, 'triggerSiren', {})).toMatchObject({ value: true })
    expect(setValueFor(SIREN, 'silenceSiren', {})).toMatchObject({ value: false })
  })

  test('a relay channel by its endpoint; without one, the first channel', () => {
    expect(setValueFor(DOUBLE_RELAY, 'turnOn', {}, 2)).toEqual({ valueId: { commandClass: 37, endpoint: 2, property: 'targetValue' }, value: true })
    expect(setValueFor(DOUBLE_RELAY, 'turnOn', {})).toMatchObject({ valueId: { endpoint: 1 } })
  })

  test('what the node cannot do is refused', () => {
    expect(setValueFor(MULTISENSOR, 'turnOn', {})).toBeNull()
    expect(setValueFor(LOCK, 'setBrightness', { brightness: 10 })).toBeNull()
  })
})
