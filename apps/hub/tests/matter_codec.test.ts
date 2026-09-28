/**
 * Matter, as a lookup: what an endpoint is, what it can do, what its attributes say in the
 * house's vocabulary, and which cluster command or attribute write a capability command
 * becomes.
 *
 * The codec works on plain data shaped like matter.js's cached cluster state (enums as
 * numbers, bitmaps as objects of booleans, `featureMap` inside each cluster), so it is tested
 * without a node. The conversions follow the Matter specification and match what Home
 * Assistant's Matter integration does with the same attributes. The pairing codes are checked
 * against the specification's example and against matter.js's own encoder.
 */

import { describe, expect, test } from 'bun:test'
import {
  buttonAction,
  capabilitiesOf,
  categoryOf,
  lockActor,
  parsePairingCode,
  planCommand,
  stateOf,
  type EndpointView,
} from '#adapters/matter_codec'

const LIGHT: EndpointView = {
  id: 1,
  deviceTypes: [0x010d],
  clusters: {
    identify: { identifyTime: 0, featureMap: {} },
    onOff: { onOff: true, featureMap: { lighting: true } },
    levelControl: { currentLevel: 127, minLevel: 1, maxLevel: 254, onLevel: null, featureMap: { onOff: true, lighting: true } },
    colorControl: {
      colorMode: 2,
      currentHue: 0,
      currentSaturation: 0,
      currentX: 24939,
      currentY: 24701,
      colorTemperatureMireds: 370,
      colorTempPhysicalMinMireds: 153,
      colorTempPhysicalMaxMireds: 500,
      featureMap: { hueSaturation: true, xy: true, colorTemperature: true },
    },
  },
}

const view = (deviceTypes: number[], clusters: EndpointView['clusters']): EndpointView => ({ id: 1, deviceTypes, clusters })

describe('pairing codes', () => {
  test('the 11-digit code from the specification', () => {
    expect(parsePairingCode('34970112332')).toEqual({ kind: 'manual', passcode: 20202021, shortDiscriminator: 15, vendorId: null, productId: null })
    expect(parsePairingCode('3497-011-2332')).toMatchObject({ passcode: 20202021, shortDiscriminator: 15 })
  })

  test('the QR payload from the specification', () => {
    expect(parsePairingCode('MT:Y.K9042C00KA0648G00')).toEqual({
      kind: 'qr',
      passcode: 20202021,
      longDiscriminator: 3840,
      vendorId: 0xfff1,
      productId: 0x8000,
      discovery: { softAp: false, ble: true, onNetwork: false },
    })
  })

  test('codes matter.js printed for a test light', () => {
    expect(parsePairingCode('24970112330')).toMatchObject({ passcode: 20202021, shortDiscriminator: 3001 >> 8 })
    expect(parsePairingCode('MT:-24J0IRV01T70648G00')).toMatchObject({ passcode: 20202021, longDiscriminator: 3001, vendorId: 0xfff1, productId: 0x8001 })
  })

  test('the same answers as matter.js, for many codes', async () => {
    const { ManualPairingCodeCodec, QrPairingCodeCodec } = await import('@matter/main/types')
    for (let index = 0; index < 200; index++) {
      const passcode = 1 + ((index * 1_234_567) % 99_999_997)
      const discriminator = (index * 37) % 4096
      const manual = ManualPairingCodeCodec.encode({ discriminator, passcode })
      expect(parsePairingCode(manual)).toMatchObject({ passcode, shortDiscriminator: discriminator >> 8 })
      const qr = QrPairingCodeCodec.encode([{ version: 0, vendorId: 0xfff1, productId: index, flowType: 0, discoveryCapabilities: 4, discriminator, passcode }])
      expect(parsePairingCode(qr)).toMatchObject({ passcode, longDiscriminator: discriminator, productId: index, discovery: { onNetwork: true } })
    }
  })

  test('a code mistyped, or one no device may carry, is said plainly', () => {
    expect(parsePairingCode('34970112333')).toEqual({ error: expect.stringMatching(/dernier chiffre/) })
    expect(parsePairingCode('1234')).toEqual({ error: expect.stringMatching(/11 ou 21 chiffres/) })
    expect(parsePairingCode('MT:@@@')).toEqual({ error: expect.stringMatching(/QR/) })
    // 12345678 is on the specification's list of passcodes no device may use (matter.js
    // refuses to encode it, so the code is spelled out: discriminator 15, check digit 3).
    expect(parsePairingCode('35767807533')).toEqual({ error: expect.stringMatching(/interdit/) })
  })
})

describe('what an endpoint is', () => {
  test('by its device type, skipping the utility ones', () => {
    expect(categoryOf([0x010d])).toBe('light')
    expect(categoryOf([0x0100])).toBe('light')
    expect(categoryOf([0x010a])).toBe('outlet')
    expect(categoryOf([0x0015])).toBe('sensor')
    expect(categoryOf([0x0202])).toBe('cover')
    expect(categoryOf([0x000a])).toBe('lock')
    expect(categoryOf([0x0301])).toBe('climate')
    expect(categoryOf([0x002b])).toBe('climate')
    expect(categoryOf([0x000f])).toBe('switch')
    expect(categoryOf([0x0074])).toBe('vacuum')
    expect(categoryOf([0x000e])).toBe('gateway')
    expect(categoryOf([0x0011, 0x0510, 0x0302])).toBe('sensor')
    expect(categoryOf([0x9999])).toBe('unknown')
  })

  test('what it can do comes from the clusters it serves', () => {
    expect(capabilitiesOf(LIGHT)).toEqual(['onoff', 'brightness', 'colorTemperature', 'color', 'identify'])
    expect(capabilitiesOf(view([0x0015], { booleanState: { stateValue: true } }))).toEqual(['contact'])
    expect(capabilitiesOf(view([0x0043], { booleanState: { stateValue: false } }))).toEqual(['waterLeak'])
    expect(capabilitiesOf(view([0x0107], { occupancySensing: { occupancy: { occupied: false }, featureMap: { passiveInfrared: true } } }))).toEqual(['motion'])
    expect(capabilitiesOf(view([0x0107], { occupancySensing: { occupancy: { occupied: false }, featureMap: { radar: true } } }))).toEqual(['occupancy'])
    expect(
      capabilitiesOf(view([0x0076], { smokeCoAlarm: { smokeState: 0, coState: 0, featureMap: { smokeAlarm: true, coAlarm: true } }, powerSource: { batPercentRemaining: 200, featureMap: { battery: true } } }))
    ).toEqual(['smoke', 'carbonMonoxide', 'battery'])
    expect(
      capabilitiesOf(
        view([0x010a, 0x0510], {
          onOff: { onOff: false, featureMap: {} },
          electricalPowerMeasurement: { activePower: 0 },
          electricalEnergyMeasurement: { cumulativeEnergyImported: { energy: 0 } },
        })
      )
    ).toEqual(['onoff', 'power', 'energy'])
    expect(capabilitiesOf(view([0x0202], { windowCovering: { currentPositionLiftPercent100ths: 0, featureMap: { lift: true, positionAwareLift: true, tilt: true, positionAwareTilt: true } } }))).toEqual([
      'position',
      'tilt',
    ])
    expect(capabilitiesOf(view([0x000f], { switch: { numberOfPositions: 2, currentPosition: 0, featureMap: { momentarySwitch: true } } }))).toEqual(['button'])
    // A power source without a battery (mains) is not a battery.
    expect(capabilitiesOf(view([0x0100], { onOff: { onOff: true }, powerSource: { featureMap: { wired: true } } }))).toEqual(['onoff'])
  })
})

describe('what its attributes say', () => {
  test('a colour light in white mode', () => {
    expect(stateOf(LIGHT)).toEqual({
      on: true,
      brightness: 50,
      colorTemperature: 2703,
      colorTemperatureRange: [2000, 6536],
      hue: 0,
      saturation: 0,
      identifying: false,
    })
  })

  test('a colour light in hue and saturation mode', () => {
    const state = stateOf({ ...LIGHT, clusters: { ...LIGHT.clusters, colorControl: { ...LIGHT.clusters.colorControl, colorMode: 0, currentHue: 170, currentSaturation: 254 } } })
    expect(state).toMatchObject({ hue: 241, saturation: 100 })
  })

  test('a colour light in xy mode reads as hue and saturation', () => {
    const state = stateOf({ ...LIGHT, clusters: { ...LIGHT.clusters, colorControl: { ...LIGHT.clusters.colorControl, colorMode: 1, currentX: Math.round(0.7006 * 65536), currentY: Math.round(0.2993 * 65536) } } })
    expect(state.hue as number).toBeLessThan(10)
    expect(state.saturation as number).toBeGreaterThan(90)
  })

  test('a level that is not known yet says nothing', () => {
    const state = stateOf(view([0x0101], { onOff: { onOff: false }, levelControl: { currentLevel: null, featureMap: { onOff: true } } }))
    expect(state).toEqual({ on: false })
  })

  test('sensors, in the units the house uses', () => {
    expect(stateOf(view([0x0302], { temperatureMeasurement: { measuredValue: 2150 } }))).toEqual({ temperature: 21.5 })
    expect(stateOf(view([0x0307], { relativeHumidityMeasurement: { measuredValue: 4550 } }))).toEqual({ humidity: 45.5 })
    expect(stateOf(view([0x0106], { illuminanceMeasurement: { measuredValue: 30001 } }))).toEqual({ illuminance: 1000 })
    expect(stateOf(view([0x0106], { illuminanceMeasurement: { measuredValue: 0 } }))).toEqual({ illuminance: 0 })
    expect(stateOf(view([0x0305], { pressureMeasurement: { measuredValue: 1013 } }))).toEqual({ pressure: 1013 })
    expect(stateOf(view([0x0302], { temperatureMeasurement: { measuredValue: null } }))).toEqual({})
  })

  test('a door is open when the contact is broken; a leak is a leak', () => {
    expect(stateOf(view([0x0015], { booleanState: { stateValue: true } }))).toEqual({ open: false })
    expect(stateOf(view([0x0015], { booleanState: { stateValue: false } }))).toEqual({ open: true })
    expect(stateOf(view([0x0043], { booleanState: { stateValue: true } }))).toEqual({ leak: true })
  })

  test('motion is dated; presence is not', () => {
    const at = '2026-09-26T18:00:00.000Z'
    expect(stateOf(view([0x0107], { occupancySensing: { occupancy: { occupied: true }, featureMap: { passiveInfrared: true } } }), at)).toEqual({ motion: true, lastMotionAt: at })
    expect(stateOf(view([0x0107], { occupancySensing: { occupancy: { occupied: false }, featureMap: { passiveInfrared: true } } }), at)).toEqual({ motion: false })
    expect(stateOf(view([0x0107], { occupancySensing: { occupancy: { occupied: true }, featureMap: { radar: true } } }), at)).toEqual({ occupied: true })
  })

  test('alarms, air and batteries', () => {
    expect(stateOf(view([0x0076], { smokeCoAlarm: { smokeState: 2, coState: 0, testInProgress: false, featureMap: { smokeAlarm: true, coAlarm: true } } }))).toEqual({
      smoke: true,
      testing: false,
      co: false,
    })
    expect(
      stateOf(
        view([0x002c], {
          airQuality: { airQuality: 3 },
          carbonDioxideConcentrationMeasurement: { measuredValue: 850, measurementUnit: 0 },
          pm25ConcentrationMeasurement: { measuredValue: 12.5, measurementUnit: 4 },
          totalVolatileOrganicCompoundsConcentrationMeasurement: { measuredValue: 120, measurementUnit: 1 },
        })
      )
    ).toEqual({ airQuality: 'moderate', co2: 850, pm25: 12.5, voc: 120 })
    expect(stateOf(view([0x0302], { powerSource: { batPercentRemaining: 180, batChargeLevel: 0, batChargeState: 0, featureMap: { battery: true } } }))).toEqual({ battery: 90, batteryLow: false })
    expect(stateOf(view([0x0302], { powerSource: { batPercentRemaining: 15, batChargeLevel: 1, batChargeState: 1, featureMap: { battery: true, rechargeable: true } } }))).toEqual({
      battery: 8,
      batteryLow: true,
      charging: true,
    })
  })

  test('power and energy, from milliwatts and milliwatt-hours', () => {
    expect(
      stateOf(
        view([0x010a], {
          onOff: { onOff: true },
          electricalPowerMeasurement: { activePower: 12500, voltage: 230000, activeCurrent: 54 },
          electricalEnergyMeasurement: { cumulativeEnergyImported: { energy: 1234567890 }, cumulativeEnergyExported: { energy: 5_000_000n } },
        })
      )
    ).toEqual({ on: true, power: 12.5, voltage: 230, current: 0.054, energyTotal: 1234.568, energyReturned: 5 })
  })

  test('a cover counts 100 as open, the other way round from Matter', () => {
    expect(stateOf(view([0x0202], { windowCovering: { currentPositionLiftPercent100ths: 2500, operationalStatus: { global: 0 }, featureMap: { lift: true, positionAwareLift: true } } }))).toEqual({
      position: 75,
      moving: 'idle',
    })
    expect(
      stateOf(view([0x0202], { windowCovering: { currentPositionLiftPercent100ths: 10000, operationalStatus: { global: 1 }, currentPositionTiltPercent100ths: 5000, featureMap: { lift: true, positionAwareLift: true, tilt: true, positionAwareTilt: true } } }))
    ).toEqual({ position: 0, moving: 'opening', tilt: 50 })
  })

  test('a thermostat, in its mode', () => {
    const heating = view([0x0301], {
      thermostat: {
        localTemperature: 2150,
        occupiedHeatingSetpoint: 2000,
        occupiedCoolingSetpoint: 2600,
        systemMode: 4,
        thermostatRunningState: { heat: true, cool: false, fan: false },
        featureMap: { heating: true, cooling: true },
      },
    })
    expect(stateOf(heating)).toEqual({ currentTemperature: 21.5, targetTemperature: 20, hvacMode: 'heat', hvacAction: 'heating' })
    const cooling = { ...heating, clusters: { thermostat: { ...heating.clusters.thermostat, systemMode: 3, thermostatRunningState: {} } } }
    expect(stateOf(cooling)).toEqual({ currentTemperature: 21.5, targetTemperature: 26, hvacMode: 'cool', hvacAction: 'idle' })
    const auto = { ...heating, clusters: { thermostat: { ...heating.clusters.thermostat, systemMode: 1, featureMap: { heating: true, cooling: true, autoMode: true } } } }
    expect(stateOf(auto)).toMatchObject({ hvacMode: 'auto', targetTemperature: 20, targetTemperatureRange: [20, 26] })
    const off = { ...heating, clusters: { thermostat: { ...heating.clusters.thermostat, systemMode: 0 } } }
    expect(stateOf(off)).toMatchObject({ hvacMode: 'off', hvacAction: 'off', targetTemperature: 20 })
  })

  test('a lock, a fan, a valve', () => {
    expect(stateOf(view([0x000a], { doorLock: { lockState: 1 } }))).toEqual({ locked: true })
    expect(stateOf(view([0x000a], { doorLock: { lockState: 3 } }))).toEqual({ locked: false })
    expect(stateOf(view([0x000a], { doorLock: { lockState: null } }))).toEqual({})
    expect(stateOf(view([0x002b], { fanControl: { fanMode: 2, percentCurrent: 50, rockSetting: { rockLeftRight: false }, featureMap: { rocking: true } } }))).toEqual({
      fanMode: 'medium',
      fanSpeed: 50,
      oscillating: false,
    })
    expect(stateOf(view([0x0042], { valveConfigurationAndControl: { currentState: 1, currentLevel: 80, featureMap: { level: true } } }))).toEqual({ valveOpen: true, valveLevel: 80 })
  })
})

describe('what a command becomes', () => {
  const invoke = (cluster: string, command: string, args?: Record<string, unknown>) => ({ invoke: { cluster, command, ...(args ? { args } : {}) } })
  const write = (cluster: string, values: Record<string, unknown>) => ({ write: { cluster, values } })
  const options = { optionsMask: {}, optionsOverride: {} }

  test('on, off, toggle', () => {
    expect(planCommand(LIGHT, 'turnOn', {})).toEqual({ actions: [invoke('onOff', 'on')] })
    expect(planCommand(LIGHT, 'turnOff', {})).toEqual({ actions: [invoke('onOff', 'off')] })
    expect(planCommand(LIGHT, 'toggle', {})).toEqual({ actions: [invoke('onOff', 'toggle')] })
  })

  test('brightness, with its fade in tenths of a second', () => {
    expect(planCommand(LIGHT, 'setBrightness', { brightness: 50, transitionMs: 1500 })).toEqual({
      actions: [invoke('levelControl', 'moveToLevelWithOnOff', { level: 127, transitionTime: 15, ...options })],
    })
    expect(planCommand(LIGHT, 'setBrightness', { brightness: 0 })).toEqual({ actions: [invoke('onOff', 'off')] })
    expect(planCommand(LIGHT, 'setBrightness', { brightness: 0.1 })).toEqual({
      actions: [invoke('levelControl', 'moveToLevelWithOnOff', { level: 1, transitionTime: null, ...options })],
    })
    expect(planCommand(LIGHT, 'stepBrightness', { delta: -20 })).toEqual({
      actions: [invoke('levelControl', 'moveToLevelWithOnOff', { level: 76, transitionTime: null, ...options })],
    })
  })

  test('white and colour', () => {
    expect(planCommand(LIGHT, 'setColorTemperature', { kelvin: 2700 })).toEqual({
      actions: [invoke('colorControl', 'moveToColorTemperature', { colorTemperatureMireds: 370, transitionTime: 0, ...options })],
    })
    expect(planCommand(LIGHT, 'setColorTemperature', { kelvin: 10000 })).toEqual({
      actions: [invoke('colorControl', 'moveToColorTemperature', { colorTemperatureMireds: 153, transitionTime: 0, ...options })],
    })
    expect(planCommand(LIGHT, 'setColor', { hue: 120, saturation: 100 })).toEqual({
      actions: [invoke('colorControl', 'moveToHueAndSaturation', { hue: 85, saturation: 254, transitionTime: 0, ...options })],
    })
    expect(planCommand(LIGHT, 'setColorName', { name: 'Rouge' })).toEqual({
      actions: [invoke('colorControl', 'moveToHueAndSaturation', { hue: 0, saturation: 254, transitionTime: 0, ...options })],
    })
    expect(planCommand(LIGHT, 'setColorRgb', { r: 0, g: 0, b: 255 })).toEqual({
      actions: [invoke('colorControl', 'moveToHueAndSaturation', { hue: 169, saturation: 254, transitionTime: 0, ...options })],
    })
    expect(planCommand(LIGHT, 'setColorName', { name: 'chartreuse fluo' })).toEqual({ error: expect.stringMatching(/Couleur inconnue/) })
  })

  test('a light that only speaks xy gets xy', () => {
    const xyOnly = { ...LIGHT, clusters: { ...LIGHT.clusters, colorControl: { ...LIGHT.clusters.colorControl, featureMap: { xy: true, colorTemperature: true } } } }
    const plan = planCommand(xyOnly, 'setColor', { hue: 120, saturation: 100 }) as unknown as { actions: { invoke: { command: string; args: { colorX: number; colorY: number } } }[] }
    expect(plan.actions[0]!.invoke.command).toBe('moveToColor')
    // Pure green, through the same sRGB-to-CIE conversion the Hue adapter uses.
    expect(plan.actions[0]!.invoke.args.colorX / 65536).toBeCloseTo(0.1724, 3)
    expect(plan.actions[0]!.invoke.args.colorY / 65536).toBeCloseTo(0.7468, 3)
  })

  test('covers, the other way round', () => {
    const cover = view([0x0202], { windowCovering: { currentPositionLiftPercent100ths: 0, featureMap: { lift: true, positionAwareLift: true } } })
    expect(planCommand(cover, 'setPosition', { position: 30 })).toEqual({ actions: [invoke('windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 7000 })] })
    expect(planCommand(cover, 'open', {})).toEqual({ actions: [invoke('windowCovering', 'upOrOpen')] })
    expect(planCommand(cover, 'close', {})).toEqual({ actions: [invoke('windowCovering', 'downOrClose')] })
    expect(planCommand(cover, 'stop', {})).toEqual({ actions: [invoke('windowCovering', 'stopMotion')] })
    const blind = view([0x0202], { windowCovering: { featureMap: { lift: true } } })
    expect(planCommand(blind, 'setPosition', { position: 30 })).toEqual({ error: expect.stringMatching(/position/) })
  })

  test('a thermostat is written to', () => {
    const thermostat = view([0x0301], { thermostat: { systemMode: 4, occupiedHeatingSetpoint: 2000, occupiedCoolingSetpoint: 2600, featureMap: { heating: true, cooling: true } } })
    expect(planCommand(thermostat, 'setTargetTemperature', { celsius: 21.5 })).toEqual({ actions: [write('thermostat', { occupiedHeatingSetpoint: 2150 })] })
    const cooling = view([0x0301], { thermostat: { systemMode: 3, featureMap: { heating: true, cooling: true } } })
    expect(planCommand(cooling, 'setTargetTemperature', { celsius: 24 })).toEqual({ actions: [write('thermostat', { occupiedCoolingSetpoint: 2400 })] })
    expect(planCommand(thermostat, 'setHvacMode', { mode: 'cool' })).toEqual({ actions: [write('thermostat', { systemMode: 3 })] })
    expect(planCommand(thermostat, 'setHvacMode', { mode: 'off' })).toEqual({ actions: [write('thermostat', { systemMode: 0 })] })
  })

  test('a lock; one that wants a code from afar says so', () => {
    const lock = view([0x000a], { doorLock: { lockState: 1, featureMap: {} } })
    expect(planCommand(lock, 'lock', {})).toEqual({ actions: [invoke('doorLock', 'lockDoor', {})] })
    expect(planCommand(lock, 'unlock', {})).toEqual({ actions: [invoke('doorLock', 'unlockDoor', {})] })
    const bolted = view([0x000a], { doorLock: { lockState: 1, featureMap: { unbolting: true } } })
    expect(planCommand(bolted, 'unlock', {})).toEqual({ actions: [invoke('doorLock', 'unboltDoor', {})] })
    const guarded = view([0x000a], { doorLock: { lockState: 1, requirePinForRemoteOperation: true, featureMap: { pinCredential: true, credentialOverTheAirAccess: true } } })
    expect(planCommand(guarded, 'unlock', {})).toEqual({ error: expect.stringMatching(/code/) })
  })

  test('a fan, a valve, identify', () => {
    const fan = view([0x002b], { fanControl: { fanMode: 0, rockSupport: { rockUpDown: true }, featureMap: { rocking: true } } })
    expect(planCommand(fan, 'setFanSpeed', { speed: 70 })).toEqual({ actions: [write('fanControl', { percentSetting: 70 })] })
    expect(planCommand(fan, 'setFanMode', { mode: 'auto' })).toEqual({ actions: [write('fanControl', { fanMode: 5 })] })
    expect(planCommand(fan, 'setOscillating', { oscillating: true })).toEqual({ actions: [write('fanControl', { rockSetting: { rockUpDown: true } })] })
    expect(planCommand(fan, 'setOscillating', { oscillating: false })).toEqual({ actions: [write('fanControl', { rockSetting: {} })] })
    const valve = view([0x0042], { valveConfigurationAndControl: { currentState: 0, featureMap: { level: true } } })
    expect(planCommand(valve, 'openValve', { level: 50 })).toEqual({ actions: [invoke('valveConfigurationAndControl', 'open', { targetLevel: 50 })] })
    expect(planCommand(valve, 'closeValve', {})).toEqual({ actions: [invoke('valveConfigurationAndControl', 'close')] })
    expect(planCommand(LIGHT, 'identify', { seconds: 10 })).toEqual({ actions: [invoke('identify', 'identify', { identifyTime: 10 })] })
  })

  test('what the endpoint cannot do is refused before anything is sent', () => {
    const sensor = view([0x0302], { temperatureMeasurement: { measuredValue: 2000 } })
    expect(planCommand(sensor, 'turnOn', {})).toEqual({ error: expect.stringMatching(/turnOn/) })
    expect(planCommand(LIGHT, 'setPosition', { position: 3 })).toEqual({ error: expect.stringMatching(/setPosition/) })
  })
})

describe('buttons and locks', () => {
  const full = { momentarySwitch: true, momentarySwitchRelease: true, momentarySwitchLongPress: true, momentarySwitchMultiPress: true }

  test('a switch that counts presses says how many once it is done', () => {
    expect(buttonAction('initialPress', { newPosition: 1 }, full)).toBeNull()
    expect(buttonAction('shortRelease', { previousPosition: 1 }, full)).toBeNull()
    expect(buttonAction('multiPressComplete', { previousPosition: 1, totalNumberOfPressesCounted: 1 }, full)).toEqual({ action: 'single', position: 1 })
    expect(buttonAction('multiPressComplete', { previousPosition: 1, totalNumberOfPressesCounted: 2 }, full)).toEqual({ action: 'double', position: 1 })
    expect(buttonAction('multiPressComplete', { previousPosition: 2, totalNumberOfPressesCounted: 3 }, full)).toEqual({ action: 'triple', position: 2 })
    expect(buttonAction('multiPressComplete', { previousPosition: 1, totalNumberOfPressesCounted: 0 }, full)).toBeNull()
    expect(buttonAction('longPress', { newPosition: 1 }, full)).toEqual({ action: 'hold', position: 1 })
    expect(buttonAction('longRelease', { previousPosition: 1 }, full)).toEqual({ action: 'release', position: 1 })
  })

  test('simpler switches say what they can', () => {
    expect(buttonAction('shortRelease', { previousPosition: 1 }, { momentarySwitch: true, momentarySwitchRelease: true })).toEqual({ action: 'single', position: 1 })
    expect(buttonAction('initialPress', { newPosition: 1 }, { momentarySwitch: true, momentarySwitchRelease: true })).toBeNull()
    expect(buttonAction('initialPress', { newPosition: 1 }, { momentarySwitch: true })).toEqual({ action: 'single', position: 1 })
    expect(buttonAction('switchLatched', { newPosition: 1 }, { latchingSwitch: true })).toBeNull()
  })

  test('who moved the lock', () => {
    expect(lockActor(1)).toBe('manual')
    expect(lockActor(3)).toBe('keypad')
    expect(lockActor(7)).toBe('remote')
    expect(lockActor(0)).toBeNull()
    expect(lockActor(99)).toBeNull()
  })
})
