/**
 * Matter in the house's vocabulary.
 *
 * The capability list was drawn after Matter's clusters from the start, so this is a lookup
 * rather than a translation layer: which capabilities an endpoint's clusters give, what their
 * attributes say in the house's units, and which cluster command or attribute write a
 * capability command becomes. Everything here works on plain data shaped like matter.js's
 * cached cluster state - enums as numbers, bitmaps as objects of booleans, `featureMap`
 * inside each cluster - so it never loads matter.js, which the hub only pays for once a
 * Matter device is actually in the house.
 *
 * The conversions follow the Matter specification (Application Cluster Specification 1.4)
 * and agree with Home Assistant's Matter integration: a contact sensor is open when its
 * BooleanState is false, a covering's lift is 0 when open (the house counts 100 as open), an
 * illuminance is 10 000 x log10(lux) + 1, a battery is reported in half-percent.
 *
 * The pairing codes are decoded here too (Core Specification 5.1.3 and 5.1.4), so a code
 * typed by hand is checked before the hub starts a Matter controller for it.
 */

import {
  clamp,
  degreesToHue254,
  hsToRgb,
  hue254ToDegrees,
  kelvinToMired,
  level254ToPercent,
  miredToKelvin,
  NAMED_COLOURS,
  percentToLevel254,
  rgbToHs,
  rgbToXy,
  xyToRgb,
} from '@sway-home/shared'
import type { CapabilityId, DeviceCategory } from '@sway-home/shared'

/** One endpoint of a node, as matter.js caches it. */
export interface EndpointView {
  id: number
  deviceTypes: number[]
  /** Cluster state by matter.js's behavior name (`onOff`, `levelControl`...), featureMap included. */
  clusters: Record<string, Record<string, unknown>>
}

// ---------------------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------------------

export type PairingCode =
  | { kind: 'manual'; passcode: number; shortDiscriminator: number; vendorId: number | null; productId: number | null }
  | {
      kind: 'qr'
      passcode: number
      longDiscriminator: number
      vendorId: number
      productId: number
      discovery: { softAp: boolean; ble: boolean; onNetwork: boolean }
    }

/** Core Specification 5.1.7.1: passcodes too easy to guess, which no device may carry. */
const FORBIDDEN_PASSCODES = new Set([0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999, 12345678, 87654321])

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]

/** The manual code ends with a Verhoeff check digit: true when the whole code checks out. */
function verhoeffValid(digits: string): boolean {
  let check = 0
  const reversed = [...digits].reverse()
  reversed.forEach((digit, index) => {
    check = VERHOEFF_D[check]![VERHOEFF_P[index % 8]![Number(digit)]!]!
  })
  return check === 0
}

const BASE38 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.'

function base38Decode(text: string): Uint8Array | null {
  const bytes: number[] = []
  for (let start = 0; start < text.length; start += 5) {
    const chunk = text.slice(start, start + 5)
    // 5 characters carry 3 bytes, 4 carry 2, 2 carry 1.
    const size = chunk.length === 5 ? 3 : chunk.length === 4 ? 2 : chunk.length === 2 ? 1 : 0
    if (size === 0) return null
    let value = 0
    for (let index = chunk.length - 1; index >= 0; index--) {
      const digit = BASE38.indexOf(chunk[index]!)
      if (digit < 0) return null
      value = value * 38 + digit
    }
    if (value >= 2 ** (8 * size)) return null
    for (let index = 0; index < size; index++) {
      bytes.push(value & 0xff)
      value = Math.floor(value / 256)
    }
  }
  return new Uint8Array(bytes)
}

function passcodeProblem(passcode: number): string | null {
  if (passcode < 1 || passcode > 99_999_998 || FORBIDDEN_PASSCODES.has(passcode)) {
    return 'Ce code est interdit par la norme Matter (trop facile à deviner) : aucun appareil ne le porte, il est sans doute mal recopié.'
  }
  return null
}

/**
 * A code as a person has it: the 11- or 21-digit number printed under the QR code (dashes and
 * spaces allowed), or the QR payload itself ("MT:...").
 */
export function parsePairingCode(input: string): PairingCode | { error: string } {
  const text = input.trim()
  if (/^MT:/i.test(text)) {
    const payload = text.slice(3).split('*')[0]!.toUpperCase()
    const bytes = base38Decode(payload)
    if (!bytes || bytes.length < 11) return { error: 'Ce QR code Matter est illisible : le recopier en entier, "MT:" compris, ou utiliser le code à 11 chiffres.' }
    let offset = 0
    const read = (bits: number) => {
      let value = 0
      for (let bit = 0; bit < bits; bit++, offset++) {
        if ((bytes[offset >> 3]! >> (offset & 7)) & 1) value += 2 ** bit
      }
      return value
    }
    const version = read(3)
    const vendorId = read(16)
    const productId = read(16)
    read(2) // commissioning flow: standard, user-intent or custom; the hub pairs over the network either way
    const capabilities = read(8)
    const longDiscriminator = read(12)
    const passcode = read(27)
    if (version !== 0) return { error: 'Ce QR code Matter est d\'une version que le hub ne connaît pas encore.' }
    const problem = passcodeProblem(passcode)
    if (problem) return { error: problem }
    return {
      kind: 'qr',
      passcode,
      longDiscriminator,
      vendorId,
      productId,
      discovery: { softAp: (capabilities & 1) !== 0, ble: (capabilities & 2) !== 0, onNetwork: (capabilities & 4) !== 0 },
    }
  }

  const digits = text.replace(/[\s.-]/g, '')
  if (!/^\d+$/.test(digits) || (digits.length !== 11 && digits.length !== 21)) {
    return { error: 'Un code Matter fait 11 ou 21 chiffres (souvent écrit 1234-567-8901), ou commence par "MT:".' }
  }
  if (!verhoeffValid(digits)) return { error: 'Code mal recopié : le dernier chiffre ne correspond pas aux autres.' }
  const first = Number(digits[0])
  if (first > 7) return { error: 'Ce code ne commence pas comme un code Matter (premier chiffre de 0 à 7).' }
  const long = (first & 4) !== 0
  if (long !== (digits.length === 21)) return { error: 'Code mal recopié : sa longueur ne correspond pas à son premier chiffre.' }
  const chunk2 = Number(digits.slice(1, 6))
  const chunk3 = Number(digits.slice(6, 10))
  const shortDiscriminator = ((first & 3) << 2) | (chunk2 >> 14)
  const passcode = (chunk2 & 0x3fff) + chunk3 * 2 ** 14
  const problem = passcodeProblem(passcode)
  if (problem) return { error: problem }
  return {
    kind: 'manual',
    passcode,
    shortDiscriminator,
    vendorId: long ? Number(digits.slice(10, 15)) : null,
    productId: long ? Number(digits.slice(15, 20)) : null,
  }
}

// ---------------------------------------------------------------------------------------
// Device types
// ---------------------------------------------------------------------------------------

/** Device types that describe an endpoint's plumbing rather than what it is. */
const UTILITY_TYPES = new Set([0x0011, 0x0012, 0x0013, 0x0014, 0x0016, 0x0019, 0x050d, 0x0510, 0x0511])

/** Matter Device Library 1.4, by device type id. */
const CATEGORIES: Record<number, DeviceCategory> = {
  0x000a: 'lock',
  0x000b: 'lock',
  0x000e: 'gateway',
  0x000f: 'switch',
  0x0015: 'sensor',
  0x0022: 'speaker',
  0x0023: 'media',
  0x0024: 'media',
  0x0027: 'appliance',
  0x0028: 'media',
  0x0029: 'media',
  0x002a: 'media',
  0x002b: 'climate',
  0x002c: 'sensor',
  0x002d: 'climate',
  0x0041: 'sensor',
  0x0042: 'appliance',
  0x0043: 'sensor',
  0x0044: 'sensor',
  0x0045: 'sensor',
  0x0070: 'appliance',
  0x0071: 'appliance',
  0x0072: 'climate',
  0x0073: 'appliance',
  0x0074: 'vacuum',
  0x0075: 'appliance',
  0x0076: 'sensor',
  0x0077: 'appliance',
  0x0078: 'appliance',
  0x0079: 'appliance',
  0x007a: 'appliance',
  0x007b: 'appliance',
  0x007c: 'appliance',
  0x0090: 'network',
  0x0091: 'network',
  0x0100: 'light',
  0x0101: 'light',
  0x0103: 'switch',
  0x0104: 'switch',
  0x0105: 'switch',
  0x0106: 'sensor',
  0x0107: 'sensor',
  0x010a: 'outlet',
  0x010b: 'outlet',
  0x010c: 'light',
  0x010d: 'light',
  0x010f: 'switch',
  0x0110: 'switch',
  0x0142: 'camera',
  0x0143: 'camera',
  0x0145: 'camera',
  0x0202: 'cover',
  0x0203: 'cover',
  0x0300: 'climate',
  0x0301: 'climate',
  0x0302: 'sensor',
  0x0303: 'appliance',
  0x0304: 'appliance',
  0x0305: 'sensor',
  0x0306: 'sensor',
  0x0307: 'sensor',
  0x0309: 'climate',
  0x050c: 'appliance',
  0x050f: 'appliance',
  0x0510: 'energy',
  0x0850: 'sensor',
}

/** Light, dimmable plug or dimmer: the device types where a level is a brightness. */
const DIMMABLE = new Set<DeviceCategory>(['light', 'outlet', 'switch'])

export function categoryOf(deviceTypes: number[]): DeviceCategory {
  const meaningful = deviceTypes.filter((type) => !UTILITY_TYPES.has(type))
  for (const type of meaningful) {
    const category = CATEGORIES[type]
    if (category) return category
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------------------

type Attributes = Record<string, unknown>

const features = (cluster: Attributes | undefined): Record<string, boolean> => (cluster?.featureMap ?? {}) as Record<string, boolean>

const number = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

const round = (value: number, digits: number) => Number(value.toFixed(digits))

/** Radar, RF sensing and vision detect someone being there; PIR and the rest, something moving. */
function isPresenceSensor(cluster: Attributes): boolean {
  const feature = features(cluster)
  return Boolean(feature.radar || feature.rfSensing || feature.vision)
}

export function capabilitiesOf(view: EndpointView): CapabilityId[] {
  const c = view.clusters
  const category = categoryOf(view.deviceTypes)
  const list: CapabilityId[] = []
  const add = (present: unknown, capability: CapabilityId) => {
    if (present && !list.includes(capability)) list.push(capability)
  }
  const color = features(c.colorControl)
  const covering = features(c.windowCovering)
  const alarm = features(c.smokeCoAlarm)
  add(c.onOff, 'onoff')
  add(c.levelControl && DIMMABLE.has(category), 'brightness')
  add(c.colorControl && color.colorTemperature, 'colorTemperature')
  add(c.colorControl && (color.hueSaturation || color.xy), 'color')
  add(c.windowCovering && covering.lift !== false, 'position')
  add(c.windowCovering && covering.tilt, 'tilt')
  add(c.thermostat, 'thermostat')
  add(c.fanControl, 'fan')
  add(c.doorLock, 'lock')
  add(c.valveConfigurationAndControl, 'valve')
  add(c.temperatureMeasurement, 'temperature')
  add(c.relativeHumidityMeasurement, 'humidity')
  add(c.pressureMeasurement, 'pressure')
  add(c.illuminanceMeasurement, 'illuminance')
  add(c.occupancySensing && !isPresenceSensor(c.occupancySensing), 'motion')
  add(c.occupancySensing && isPresenceSensor(c.occupancySensing), 'occupancy')
  add(c.booleanState && view.deviceTypes.includes(0x0015), 'contact')
  add(c.booleanState && view.deviceTypes.includes(0x0043), 'waterLeak')
  add(c.smokeCoAlarm && alarm.smokeAlarm !== false, 'smoke')
  add(c.smokeCoAlarm && alarm.coAlarm, 'carbonMonoxide')
  add(
    c.airQuality ||
      c.carbonDioxideConcentrationMeasurement ||
      c.pm25ConcentrationMeasurement ||
      c.totalVolatileOrganicCompoundsConcentrationMeasurement,
    'airQuality'
  )
  add(c.electricalPowerMeasurement, 'power')
  add(c.electricalEnergyMeasurement, 'energy')
  add(c.powerSource && features(c.powerSource).battery, 'battery')
  add(c.switch && !features(c.switch).latchingSwitch, 'button')
  add(c.identify, 'identify')
  return list
}

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

const AIR_QUALITY = ['unknown', 'good', 'fair', 'moderate', 'poor', 'very_poor', 'extremely_poor'] as const
const SYSTEM_MODES: Record<number, 'off' | 'heat' | 'cool' | 'auto' | 'dry' | 'fan_only'> = {
  0: 'off',
  1: 'auto',
  3: 'cool',
  4: 'heat',
  5: 'heat',
  6: 'cool',
  7: 'fan_only',
  8: 'dry',
  9: 'auto',
}
const FAN_MODES: Record<number, 'off' | 'low' | 'medium' | 'high' | 'auto'> = { 0: 'off', 1: 'low', 2: 'medium', 3: 'high', 4: 'high', 5: 'auto', 6: 'auto' }

/** A concentration in the unit the house reports, from Matter's MeasurementUnitEnum. */
function concentration(cluster: Attributes | undefined, target: 'ppm' | 'ugm3' | 'as-is'): number | null {
  const value = number(cluster?.measuredValue)
  if (value === null) return null
  const unit = number(cluster?.measurementUnit)
  if (target === 'ppm') return unit === 1 ? value / 1000 : unit === 2 ? value / 1_000_000 : value
  if (target === 'ugm3') return unit === 3 ? value * 1000 : unit === 5 ? value / 1000 : value
  return value
}

function colourState(cluster: Attributes): { hue: number; saturation: number } | null {
  const feature = features(cluster)
  const mode = number(cluster.colorMode)
  const fromXy = () => {
    const x = number(cluster.currentX)
    const y = number(cluster.currentY)
    if (x === null || y === null) return null
    const [hue, saturation] = rgbToHs(...xyToRgb(x / 65536, y / 65536))
    return { hue: Math.round(hue), saturation: Math.round(saturation) }
  }
  const fromHue = () => {
    const hue = number(cluster.currentHue)
    const saturation = number(cluster.currentSaturation)
    if (hue === null || saturation === null) return null
    return { hue: hue254ToDegrees(hue), saturation: clamp(Math.round((saturation / 254) * 100), 0, 100) }
  }
  if (mode === 1) return fromXy()
  if (feature.hueSaturation) return fromHue()
  if (feature.xy) return fromXy()
  return null
}

/** Everything the endpoint's attributes say, in the house's vocabulary. */
export function stateOf(view: EndpointView, now: string = new Date().toISOString()): Record<string, unknown> {
  const c = view.clusters
  const state: Record<string, unknown> = {}
  const set = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) state[key] = value
  }
  const capabilities = capabilitiesOf(view)

  if (c.onOff) set('on', typeof c.onOff.onOff === 'boolean' ? c.onOff.onOff : null)
  if (capabilities.includes('brightness')) {
    const level = number(c.levelControl?.currentLevel)
    if (level !== null) set('brightness', level254ToPercent(level))
  }
  if (c.colorControl) {
    const mireds = number(c.colorControl.colorTemperatureMireds)
    if (capabilities.includes('colorTemperature') && mireds !== null && mireds > 0) {
      set('colorTemperature', miredToKelvin(mireds))
      const coolest = number(c.colorControl.colorTempPhysicalMinMireds)
      const warmest = number(c.colorControl.colorTempPhysicalMaxMireds)
      if (coolest && warmest) set('colorTemperatureRange', [miredToKelvin(warmest), miredToKelvin(coolest)])
    }
    if (capabilities.includes('color')) {
      const colour = colourState(c.colorControl)
      if (colour) Object.assign(state, colour)
    }
  }
  if (c.windowCovering) {
    const lift = number(c.windowCovering.currentPositionLiftPercent100ths)
    if (lift !== null) set('position', 100 - Math.floor(lift / 100))
    const status = number((c.windowCovering.operationalStatus as Attributes | undefined)?.global)
    if (status !== null) set('moving', status === 1 ? 'opening' : status === 2 ? 'closing' : 'idle')
    const tilt = number(c.windowCovering.currentPositionTiltPercent100ths)
    if (tilt !== null && features(c.windowCovering).tilt) set('tilt', 100 - Math.floor(tilt / 100))
  }
  if (c.thermostat) Object.assign(state, thermostatState(c.thermostat))
  if (c.fanControl) {
    set('fanMode', FAN_MODES[number(c.fanControl.fanMode) ?? -1] ?? null)
    set('fanSpeed', number(c.fanControl.percentCurrent) ?? number(c.fanControl.percentSetting))
    const rock = c.fanControl.rockSetting as Record<string, boolean> | undefined
    if (features(c.fanControl).rocking && rock) set('oscillating', Object.values(rock).some(Boolean))
  }
  if (c.doorLock) {
    const lockState = number(c.doorLock.lockState)
    if (lockState !== null) set('locked', lockState === 1)
  }
  if (c.valveConfigurationAndControl) {
    const current = number(c.valveConfigurationAndControl.currentState)
    if (current !== null && current !== 2) set('valveOpen', current === 1)
    if (features(c.valveConfigurationAndControl).level) set('valveLevel', number(c.valveConfigurationAndControl.currentLevel))
  }

  const measured = (cluster: Attributes | undefined) => number(cluster?.measuredValue)
  const temperature = measured(c.temperatureMeasurement)
  if (temperature !== null) set('temperature', round(temperature / 100, 2))
  const humidity = measured(c.relativeHumidityMeasurement)
  if (humidity !== null) set('humidity', round(humidity / 100, 2))
  const pressure = measured(c.pressureMeasurement)
  if (pressure !== null) set('pressure', pressure)
  const illuminance = measured(c.illuminanceMeasurement)
  if (illuminance !== null) set('illuminance', illuminance === 0 ? 0 : round(10 ** ((illuminance - 1) / 10000), 1))

  if (c.occupancySensing) {
    const occupied = (c.occupancySensing.occupancy as Record<string, boolean> | undefined)?.occupied
    if (typeof occupied === 'boolean') {
      if (isPresenceSensor(c.occupancySensing)) set('occupied', occupied)
      else {
        set('motion', occupied)
        if (occupied) set('lastMotionAt', now)
      }
    }
  }
  if (c.booleanState && typeof c.booleanState.stateValue === 'boolean') {
    if (capabilities.includes('contact')) set('open', !c.booleanState.stateValue)
    if (capabilities.includes('waterLeak')) set('leak', c.booleanState.stateValue)
  }
  if (c.smokeCoAlarm) {
    if (capabilities.includes('smoke')) {
      const smoke = number(c.smokeCoAlarm.smokeState)
      if (smoke !== null) set('smoke', smoke !== 0)
      if (typeof c.smokeCoAlarm.testInProgress === 'boolean') set('testing', c.smokeCoAlarm.testInProgress)
    }
    if (capabilities.includes('carbonMonoxide')) {
      const co = number(c.smokeCoAlarm.coState)
      if (co !== null) set('co', co !== 0)
    }
  }
  if (capabilities.includes('airQuality')) {
    const quality = number(c.airQuality?.airQuality)
    const co2 = concentration(c.carbonDioxideConcentrationMeasurement, 'ppm')
    set('airQuality', quality !== null ? (AIR_QUALITY[quality] ?? 'unknown') : co2 !== null ? airQualityFromCo2(co2) : 'unknown')
    set('co2', co2)
    set('pm25', concentration(c.pm25ConcentrationMeasurement, 'ugm3'))
    set('pm10', concentration(c.pm10ConcentrationMeasurement, 'ugm3'))
    set('voc', concentration(c.totalVolatileOrganicCompoundsConcentrationMeasurement, 'as-is'))
  }
  if (c.electricalPowerMeasurement) {
    const power = number(c.electricalPowerMeasurement.activePower)
    const voltage = number(c.electricalPowerMeasurement.voltage)
    const current = number(c.electricalPowerMeasurement.activeCurrent)
    if (power !== null) set('power', round(power / 1000, 3))
    if (voltage !== null) set('voltage', round(voltage / 1000, 3))
    if (current !== null) set('current', round(current / 1000, 3))
  }
  if (c.electricalEnergyMeasurement) {
    const imported = number((c.electricalEnergyMeasurement.cumulativeEnergyImported as Attributes | null | undefined)?.energy)
    const exported = number((c.electricalEnergyMeasurement.cumulativeEnergyExported as Attributes | null | undefined)?.energy)
    if (imported !== null) set('energyTotal', round(imported / 1_000_000, 3))
    if (exported !== null) set('energyReturned', round(exported / 1_000_000, 3))
  }
  if (capabilities.includes('battery')) {
    const half = number(c.powerSource!.batPercentRemaining)
    if (half !== null) set('battery', Math.round(half / 2))
    const level = number(c.powerSource!.batChargeLevel)
    if (level !== null) set('batteryLow', level !== 0)
    const charge = number(c.powerSource!.batChargeState)
    if (features(c.powerSource).rechargeable && charge !== null && charge !== 0) set('charging', charge === 1)
  }
  if (c.identify) {
    const time = number(c.identify.identifyTime)
    if (time !== null) set('identifying', time > 0)
  }
  return state
}

function airQualityFromCo2(co2: number): string {
  if (co2 < 800) return 'good'
  if (co2 < 1000) return 'fair'
  if (co2 < 1500) return 'moderate'
  if (co2 < 2000) return 'poor'
  if (co2 < 5000) return 'very_poor'
  return 'extremely_poor'
}

function thermostatState(cluster: Attributes): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  const feature = features(cluster)
  const celsius = (value: unknown) => {
    const raw = number(value)
    return raw === null ? null : round(raw / 100, 2)
  }
  const current = celsius(cluster.localTemperature)
  if (current !== null) state.currentTemperature = current
  const mode = SYSTEM_MODES[number(cluster.systemMode) ?? -1]
  if (mode) state.hvacMode = mode
  const heating = celsius(cluster.occupiedHeatingSetpoint)
  const cooling = celsius(cluster.occupiedCoolingSetpoint)
  const target = mode === 'cool' ? cooling : mode === 'heat' ? heating : feature.heating !== false && heating !== null ? heating : cooling
  if (target !== null) state.targetTemperature = target
  if (mode === 'auto' && heating !== null && cooling !== null) state.targetTemperatureRange = [heating, cooling]
  if (mode === 'off') state.hvacAction = 'off'
  else if (cluster.thermostatRunningState && typeof cluster.thermostatRunningState === 'object') {
    const running = cluster.thermostatRunningState as Record<string, boolean>
    state.hvacAction =
      running.heat || running.heatStage2 ? 'heating' : running.cool || running.coolStage2 ? 'cooling' : running.fan || running.fanStage2 || running.fanStage3 ? 'fan' : 'idle'
  }
  return state
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

export type MatterAction =
  | { invoke: { cluster: string; command: string; args?: Record<string, unknown> } }
  | { write: { cluster: string; values: Record<string, unknown> } }

export type CommandPlan = { actions: MatterAction[] } | { error: string }

const invoke = (cluster: string, command: string, args?: Record<string, unknown>): MatterAction => ({ invoke: { cluster, command, ...(args ? { args } : {}) } })
const write = (cluster: string, values: Record<string, unknown>): MatterAction => ({ write: { cluster, values } })
/** Level and colour commands take these two bitmaps; empty means "follow the device's own options". */
const OPTIONS = { optionsMask: {}, optionsOverride: {} }

/** Milliseconds to the tenths of a second Matter counts transitions in. */
function tenths(args: Record<string, unknown>): number | null {
  const ms = number(args.transitionMs)
  return ms === null ? null : clamp(Math.round(ms / 100), 0, 65534)
}

const HVAC_TO_SYSTEM_MODE: Record<string, number> = { off: 0, auto: 1, cool: 3, heat: 4, fan_only: 7, dry: 8 }
const FAN_TO_MODE: Record<string, number> = { off: 0, low: 1, quiet: 1, medium: 2, high: 3, boost: 3, auto: 5 }

export function planCommand(view: EndpointView, command: string, args: Record<string, unknown>): CommandPlan {
  const c = view.clusters
  const capabilities = capabilitiesOf(view)
  const cannot: CommandPlan = { error: `Cet appareil Matter ne sait pas faire "${command}".` }
  const colour = (hue: number, saturation: number): CommandPlan => {
    const feature = features(c.colorControl)
    const transitionTime = tenths(args) ?? 0
    if (feature.hueSaturation) {
      return {
        actions: [
          invoke('colorControl', 'moveToHueAndSaturation', {
            hue: degreesToHue254(((hue % 360) + 360) % 360),
            saturation: clamp(Math.round((saturation / 100) * 254), 0, 254),
            transitionTime,
            ...OPTIONS,
          }),
        ],
      }
    }
    const [x, y] = rgbToXy(...hsToRgb(hue, saturation))
    return {
      actions: [
        invoke('colorControl', 'moveToColor', {
          colorX: clamp(Math.round(x * 65536), 0, 65279),
          colorY: clamp(Math.round(y * 65536), 0, 65279),
          transitionTime,
          ...OPTIONS,
        }),
      ],
    }
  }
  const level = (percent: number): CommandPlan => {
    if (percent <= 0) return { actions: [invoke('onOff', 'off')] }
    const min = number(c.levelControl?.minLevel) ?? 1
    const max = number(c.levelControl?.maxLevel) ?? 254
    return {
      actions: [
        invoke('levelControl', 'moveToLevelWithOnOff', {
          level: clamp(percentToLevel254(percent), Math.max(1, min), max),
          transitionTime: tenths(args),
          ...OPTIONS,
        }),
      ],
    }
  }

  switch (command) {
    case 'turnOn':
      return capabilities.includes('onoff') ? { actions: [invoke('onOff', 'on')] } : cannot
    case 'turnOff':
      return capabilities.includes('onoff') ? { actions: [invoke('onOff', 'off')] } : cannot
    case 'toggle':
      return capabilities.includes('onoff') ? { actions: [invoke('onOff', 'toggle')] } : cannot
    case 'setBrightness':
      return capabilities.includes('brightness') ? level(clamp(number(args.brightness) ?? 0, 0, 100)) : cannot
    case 'stepBrightness': {
      if (!capabilities.includes('brightness')) return cannot
      const current = level254ToPercent(number(c.levelControl?.currentLevel) ?? 0)
      return level(clamp(current + (number(args.delta) ?? 0), 0, 100))
    }
    case 'setColorTemperature': {
      if (!capabilities.includes('colorTemperature')) return cannot
      const coolest = number(c.colorControl?.colorTempPhysicalMinMireds) ?? 1
      const warmest = number(c.colorControl?.colorTempPhysicalMaxMireds) ?? 65279
      const mireds = clamp(kelvinToMired(number(args.kelvin) ?? 4000), coolest, warmest)
      return { actions: [invoke('colorControl', 'moveToColorTemperature', { colorTemperatureMireds: mireds, transitionTime: tenths(args) ?? 0, ...OPTIONS })] }
    }
    case 'setColor':
      return capabilities.includes('color') ? colour(number(args.hue) ?? 0, clamp(number(args.saturation) ?? 100, 0, 100)) : cannot
    case 'setColorRgb': {
      if (!capabilities.includes('color')) return cannot
      const [hue, saturation] = rgbToHs(number(args.r) ?? 0, number(args.g) ?? 0, number(args.b) ?? 0)
      return colour(Math.round(hue), Math.round(saturation))
    }
    case 'setColorName': {
      if (!capabilities.includes('color')) return cannot
      const named = NAMED_COLOURS[String(args.name ?? '').toLowerCase().trim()]
      return named ? colour(named[0], named[1]) : { error: `Couleur inconnue : ${String(args.name ?? '')}.` }
    }
    case 'open':
      return capabilities.includes('position') ? { actions: [invoke('windowCovering', 'upOrOpen')] } : cannot
    case 'close':
      return capabilities.includes('position') ? { actions: [invoke('windowCovering', 'downOrClose')] } : cannot
    case 'stop':
      return capabilities.includes('position') ? { actions: [invoke('windowCovering', 'stopMotion')] } : cannot
    case 'setPosition': {
      if (!capabilities.includes('position')) return cannot
      if (!features(c.windowCovering).positionAwareLift) return { error: 'Ce volet sait monter et descendre, pas aller à une position.' }
      const position = clamp(Math.round(number(args.position) ?? 0), 0, 100)
      return { actions: [invoke('windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: (100 - position) * 100 })] }
    }
    case 'setTilt': {
      if (!capabilities.includes('tilt')) return cannot
      if (!features(c.windowCovering).positionAwareTilt) return { error: 'Ce volet ne sait pas aller à une inclinaison.' }
      const tilt = clamp(Math.round(number(args.tilt) ?? 0), 0, 100)
      return { actions: [invoke('windowCovering', 'goToTiltPercentage', { tiltPercent100thsValue: (100 - tilt) * 100 })] }
    }
    case 'setTargetTemperature': {
      if (!capabilities.includes('thermostat')) return cannot
      const feature = features(c.thermostat)
      const mode = SYSTEM_MODES[number(c.thermostat!.systemMode) ?? -1]
      const value = Math.round((number(args.celsius) ?? 20) * 100)
      const cooling = mode === 'cool' || (feature.heating === false && feature.cooling)
      return { actions: [write('thermostat', cooling ? { occupiedCoolingSetpoint: value } : { occupiedHeatingSetpoint: value })] }
    }
    case 'setHvacMode': {
      if (!capabilities.includes('thermostat')) return cannot
      const mode = HVAC_TO_SYSTEM_MODE[String(args.mode)]
      return mode === undefined ? { error: `Mode inconnu : ${String(args.mode)}.` } : { actions: [write('thermostat', { systemMode: mode })] }
    }
    case 'lock':
      return capabilities.includes('lock') ? { actions: [invoke('doorLock', 'lockDoor', {})] } : cannot
    case 'unlock': {
      if (!capabilities.includes('lock')) return cannot
      if (c.doorLock!.requirePinForRemoteOperation === true) {
        return { error: 'Cette serrure demande son code pour être ouverte à distance : la déverrouiller depuis son clavier ou son application.' }
      }
      return { actions: [invoke('doorLock', features(c.doorLock).unbolting ? 'unboltDoor' : 'unlockDoor', {})] }
    }
    case 'setFanSpeed':
      return capabilities.includes('fan') ? { actions: [write('fanControl', { percentSetting: clamp(Math.round(number(args.speed) ?? 0), 0, 100) })] } : cannot
    case 'setFanMode': {
      if (!capabilities.includes('fan')) return cannot
      const mode = FAN_TO_MODE[String(args.mode)]
      return mode === undefined ? { error: `Mode inconnu : ${String(args.mode)}.` } : { actions: [write('fanControl', { fanMode: mode })] }
    }
    case 'setOscillating': {
      if (!capabilities.includes('fan')) return cannot
      if (!features(c.fanControl).rocking) return { error: 'Ce ventilateur ne sait pas osciller.' }
      const support = (c.fanControl!.rockSupport ?? {}) as Record<string, boolean>
      const axis = Object.keys(support).find((key) => support[key]) ?? 'rockLeftRight'
      return { actions: [write('fanControl', { rockSetting: args.oscillating ? { [axis]: true } : {} })] }
    }
    case 'openValve': {
      if (!capabilities.includes('valve')) return cannot
      const target = number(args.level)
      const withLevel = features(c.valveConfigurationAndControl).level && target !== null
      return { actions: [invoke('valveConfigurationAndControl', 'open', withLevel ? { targetLevel: clamp(Math.round(target!), 0, 100) } : {})] }
    }
    case 'closeValve':
      return capabilities.includes('valve') ? { actions: [invoke('valveConfigurationAndControl', 'close')] } : cannot
    case 'identify':
      return capabilities.includes('identify') ? { actions: [invoke('identify', 'identify', { identifyTime: clamp(Math.round(number(args.seconds) ?? 5), 1, 60) })] } : cannot
    default:
      return cannot
  }
}

// ---------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------

export type ButtonAction = 'single' | 'double' | 'triple' | 'hold' | 'release'

/**
 * A Switch cluster event as a button press. A switch that counts presses reports each one as
 * it goes and then once more with the total: only the total is a press, or a double press
 * would read as three.
 */
export function buttonAction(
  event: string,
  data: Record<string, unknown>,
  feature: Record<string, boolean>
): { action: ButtonAction; position: number } | null {
  const position = number(data.newPosition) ?? number(data.previousPosition) ?? 1
  if (feature.latchingSwitch) return null
  switch (event) {
    case 'multiPressComplete': {
      const presses = number(data.totalNumberOfPressesCounted) ?? 0
      const action: ButtonAction | null = presses === 1 ? 'single' : presses === 2 ? 'double' : presses >= 3 ? 'triple' : null
      return action ? { action, position } : null
    }
    case 'longPress':
      return { action: 'hold', position }
    case 'longRelease':
      return { action: 'release', position }
    case 'shortRelease':
      return feature.momentarySwitchMultiPress ? null : { action: 'single', position }
    case 'initialPress':
      return feature.momentarySwitchRelease || feature.momentarySwitchMultiPress ? null : { action: 'single', position }
    default:
      return null
  }
}

const OPERATION_SOURCES: Record<number, string> = {
  1: 'manual',
  2: 'remote',
  3: 'keypad',
  4: 'auto',
  5: 'button',
  6: 'schedule',
  7: 'remote',
  8: 'rfid',
  9: 'biometric',
  10: 'aliro',
}

/** Who or what moved a lock, from its LockOperation event's operationSource. */
export function lockActor(source: number): string | null {
  return OPERATION_SOURCES[source] ?? null
}
