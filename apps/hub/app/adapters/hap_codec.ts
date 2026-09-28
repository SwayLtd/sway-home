/**
 * HomeKit accessories in the house's vocabulary.
 *
 * An accessory is a list of services, each a list of characteristics identified by Apple's
 * UUIDs - short forms here ("25" is On), checked against HAP-NodeJS's generated definitions.
 * This module reads GET /accessories, says what each accessory is and can do, turns its
 * characteristic values into the house's state and a capability command into characteristic
 * writes. It knows nothing of sockets or keys.
 *
 * Conventions that differ from Matter or Zigbee and are easy to get backwards: a contact
 * sensor's state 0 means contact detected (closed); a window covering's position is already
 * 100 = open; a colour temperature is in mireds (140-500); LockCurrentState 2 is jammed.
 */

import { clamp, kelvinToMired, miredToKelvin, NAMED_COLOURS, rgbToHs } from '@sway-home/shared'
import type { CapabilityId, DeviceCategory } from '@sway-home/shared'
import { createHash } from 'node:crypto'

export interface HapCharacteristic {
  aid: number
  iid: number
  type: string
  value?: unknown
  perms: string[]
  format?: string
  minValue?: number
  maxValue?: number
}

export interface HapService {
  aid: number
  iid: number
  type: string
  name: string | null
  characteristics: HapCharacteristic[]
}

export interface HapAccessory {
  aid: number
  services: HapService[]
  info: { name: string | null; manufacturer: string | null; model: string | null; serialNumber: string | null; firmware: string | null }
}

const APPLE_BASE = '-0000-1000-8000-0026BB765291'

/** Apple's UUIDs in their short form ("00000025-0000-1000-8000-0026BB765291" is "25"). */
export function shortUuid(type: string): string {
  const upper = type.toUpperCase()
  if (upper.endsWith(APPLE_BASE)) return upper.slice(0, 8).replace(/^0+/, '') || '0'
  return upper.replace(/^0+(?=.)/, '')
}

/** Services (HAP-NodeJS ServiceDefinitions). */
export const S = {
  info: '3E',
  protocol: 'A2',
  lightbulb: '43',
  outlet: '47',
  switch: '49',
  thermostat: '4A',
  temperature: '8A',
  humidity: '82',
  contact: '80',
  motion: '85',
  occupancy: '86',
  lock: '45',
  covering: '8C',
  light: '84',
  leak: '83',
  smoke: '87',
  carbonMonoxide: '7F',
  air: '8D',
  battery: '96',
  button: '89',
  fan: '40',
  fanV2: 'B7',
  garage: '41',
  valve: 'D0',
  doorbell: '121',
} as const

/** Characteristics (HAP-NodeJS CharacteristicDefinitions). */
export const C = {
  identify: '14',
  manufacturer: '20',
  model: '21',
  name: '23',
  serialNumber: '30',
  firmware: '52',
  on: '25',
  brightness: '8',
  hue: '13',
  saturation: '2F',
  colorTemperature: 'CE',
  currentTemperature: '11',
  targetTemperature: '35',
  currentHeatingCooling: 'F',
  targetHeatingCooling: '33',
  coolingThreshold: 'D',
  heatingThreshold: '12',
  humidity: '10',
  contact: '6A',
  motion: '22',
  occupancy: '71',
  lockCurrent: '1D',
  lockTarget: '1E',
  currentPosition: '6D',
  targetPosition: '7C',
  positionState: '72',
  holdPosition: '6F',
  lightLevel: '6B',
  leak: '70',
  smoke: '76',
  carbonMonoxide: '69',
  airQuality: '95',
  co2: '93',
  pm25: 'C6',
  pm10: 'C7',
  voc: 'C8',
  batteryLevel: '68',
  lowBattery: '79',
  charging: '8F',
  switchEvent: '73',
  labelIndex: 'CB',
  active: 'B0',
  rotationSpeed: '29',
  swing: 'B6',
  targetFanState: 'BF',
  currentDoor: 'E',
  targetDoor: '32',
} as const

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'boolean' ? Number(value) : null)

/** GET /accessories, parsed; types in their short form. */
export function parseAccessories(json: unknown): HapAccessory[] {
  const list = (json as { accessories?: unknown[] })?.accessories
  if (!Array.isArray(list)) return []
  return list.flatMap((raw) => {
    const accessory = raw as { aid?: number; services?: unknown[] }
    if (typeof accessory.aid !== 'number' || !Array.isArray(accessory.services)) return []
    const aid = accessory.aid
    const services: HapService[] = accessory.services.map((rawService) => {
      const serviceJson = rawService as { iid: number; type: string; characteristics?: unknown[] }
      const characteristics = (serviceJson.characteristics ?? []).map((rawCharacteristic) => {
        const characteristic = rawCharacteristic as Record<string, unknown>
        return {
          aid,
          iid: Number(characteristic.iid),
          type: shortUuid(String(characteristic.type)),
          value: characteristic.value,
          perms: Array.isArray(characteristic.perms) ? (characteristic.perms as string[]) : [],
          format: typeof characteristic.format === 'string' ? characteristic.format : undefined,
          minValue: num(characteristic.minValue) ?? undefined,
          maxValue: num(characteristic.maxValue) ?? undefined,
        }
      })
      const name = characteristics.find((characteristic) => characteristic.type === C.name)
      return { aid, iid: Number(serviceJson.iid), type: shortUuid(String(serviceJson.type)), name: text(name?.value), characteristics }
    })
    const info = services.find((service) => service.type === S.info)
    const field = (type: string) => text(info?.characteristics.find((characteristic) => characteristic.type === type)?.value)
    return [
      {
        aid,
        services,
        info: { name: field(C.name), manufacturer: field(C.manufacturer), model: field(C.model), serialNumber: field(C.serialNumber), firmware: field(C.firmware) },
      },
    ]
  })
}

/** A bridge: accessory 1 does nothing itself and others hang off it. */
export function isBridge(accessories: HapAccessory[]): boolean {
  const first = accessories.find((accessory) => accessory.aid === 1)
  return accessories.length > 1 && !!first && first.services.every((service) => !CATEGORIES[service.type])
}

const CATEGORIES: Record<string, DeviceCategory> = {
  [S.lightbulb]: 'light',
  [S.outlet]: 'outlet',
  [S.switch]: 'switch',
  [S.thermostat]: 'climate',
  [S.fan]: 'climate',
  [S.fanV2]: 'climate',
  [S.lock]: 'lock',
  [S.covering]: 'cover',
  [S.garage]: 'cover',
  [S.valve]: 'appliance',
  [S.button]: 'switch',
  [S.doorbell]: 'switch',
  [S.temperature]: 'sensor',
  [S.humidity]: 'sensor',
  [S.contact]: 'sensor',
  [S.motion]: 'sensor',
  [S.occupancy]: 'sensor',
  [S.light]: 'sensor',
  [S.leak]: 'sensor',
  [S.smoke]: 'sensor',
  [S.carbonMonoxide]: 'sensor',
  [S.air]: 'sensor',
}

/** A service that is the accessory's reason to be, as opposed to its battery or its label. */
export function isMeaningful(service: HapService): boolean {
  return !!CATEGORIES[service.type]
}

export function categoryOf(services: HapService[]): DeviceCategory {
  for (const service of services) {
    const category = CATEGORIES[service.type]
    if (category) return category
  }
  return services.some((service) => service.type === S.protocol) ? 'gateway' : 'unknown'
}

const find = (services: HapService[], serviceType: string, characteristicType: string) =>
  services.find((service) => service.type === serviceType)?.characteristics.find((characteristic) => characteristic.type === characteristicType)

const has = (services: HapService[], serviceType: string, characteristicType?: string) =>
  characteristicType ? !!find(services, serviceType, characteristicType) : services.some((service) => service.type === serviceType)

export function capabilitiesOf(services: HapService[]): CapabilityId[] {
  const list: CapabilityId[] = []
  const add = (present: boolean, capability: CapabilityId) => {
    if (present && !list.includes(capability)) list.push(capability)
  }
  add(has(services, S.lightbulb) || has(services, S.outlet) || has(services, S.switch) || has(services, S.fanV2, C.active) || has(services, S.fan, C.on), 'onoff')
  add(has(services, S.lightbulb, C.brightness), 'brightness')
  add(has(services, S.lightbulb, C.colorTemperature), 'colorTemperature')
  add(has(services, S.lightbulb, C.hue) && has(services, S.lightbulb, C.saturation), 'color')
  add(has(services, S.covering), 'position')
  add(has(services, S.garage), 'garage')
  add(has(services, S.thermostat), 'thermostat')
  add(has(services, S.fan) || has(services, S.fanV2), 'fan')
  add(has(services, S.lock), 'lock')
  add(has(services, S.valve), 'valve')
  add(has(services, S.temperature), 'temperature')
  add(has(services, S.humidity), 'humidity')
  add(has(services, S.light), 'illuminance')
  add(has(services, S.motion), 'motion')
  add(has(services, S.occupancy), 'occupancy')
  add(has(services, S.contact), 'contact')
  add(has(services, S.leak), 'waterLeak')
  add(has(services, S.smoke), 'smoke')
  add(has(services, S.carbonMonoxide), 'carbonMonoxide')
  add(has(services, S.air), 'airQuality')
  add(has(services, S.battery, C.batteryLevel), 'battery')
  add(has(services, S.button), 'button')
  add(has(services, S.doorbell), 'doorbell')
  add(has(services, S.info, C.identify), 'identify')
  return list
}

const AIR_QUALITY = ['unknown', 'good', 'good', 'fair', 'poor', 'very_poor'] as const
const HVAC_MODES = ['off', 'heat', 'cool', 'auto'] as const
const DOOR_STATES = ['open', 'closed', 'opening', 'closing', 'stopped'] as const

function fanModeFor(speed: number | null): string {
  if (speed === null) return 'auto'
  return speed <= 33 ? 'low' : speed <= 66 ? 'medium' : 'high'
}

/** What the characteristics' current values say, in the house's vocabulary. */
export function stateOf(services: HapService[], now: string = new Date().toISOString()): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  const value = (serviceType: string, characteristicType: string) => find(services, serviceType, characteristicType)?.value
  const number = (serviceType: string, characteristicType: string) => num(value(serviceType, characteristicType))
  const set = (key: string, entry: unknown) => {
    if (entry !== null && entry !== undefined) state[key] = entry
  }

  for (const type of [S.lightbulb, S.outlet, S.switch]) {
    const on = number(type, C.on)
    if (on !== null) set('on', on !== 0)
  }
  set('brightness', number(S.lightbulb, C.brightness))
  const mireds = number(S.lightbulb, C.colorTemperature)
  if (mireds !== null && mireds > 0) {
    set('colorTemperature', miredToKelvin(mireds))
    const characteristic = find(services, S.lightbulb, C.colorTemperature)!
    if (characteristic.minValue && characteristic.maxValue) set('colorTemperatureRange', [miredToKelvin(characteristic.maxValue), miredToKelvin(characteristic.minValue)])
  }
  set('hue', number(S.lightbulb, C.hue))
  set('saturation', number(S.lightbulb, C.saturation))

  if (has(services, S.covering)) {
    set('position', number(S.covering, C.currentPosition))
    const moving = number(S.covering, C.positionState)
    if (moving !== null) set('moving', moving === 0 ? 'closing' : moving === 1 ? 'opening' : 'idle')
  }
  const door = number(S.garage, C.currentDoor)
  if (door !== null) set('doorState', DOOR_STATES[door] ?? null)

  if (has(services, S.thermostat)) {
    set('currentTemperature', number(S.thermostat, C.currentTemperature))
    set('targetTemperature', number(S.thermostat, C.targetTemperature))
    const mode = number(S.thermostat, C.targetHeatingCooling)
    const hvacMode = mode !== null ? (HVAC_MODES[mode] ?? null) : null
    set('hvacMode', hvacMode)
    const running = number(S.thermostat, C.currentHeatingCooling)
    if (hvacMode === 'off') set('hvacAction', 'off')
    else if (running !== null) set('hvacAction', running === 1 ? 'heating' : running === 2 ? 'cooling' : 'idle')
    const low = number(S.thermostat, C.heatingThreshold)
    const high = number(S.thermostat, C.coolingThreshold)
    if (hvacMode === 'auto' && low !== null && high !== null) set('targetTemperatureRange', [low, high])
  }

  for (const type of [S.fanV2, S.fan]) {
    if (!has(services, type)) continue
    const active = type === S.fanV2 ? number(type, C.active) : number(type, C.on)
    const speed = number(type, C.rotationSpeed)
    if (active !== null) set('on', active !== 0)
    set('fanSpeed', speed)
    set('fanMode', active === 0 ? 'off' : number(type, C.targetFanState) === 1 ? 'auto' : fanModeFor(speed))
    const swing = number(type, C.swing)
    if (swing !== null) set('oscillating', swing === 1)
  }

  const lock = number(S.lock, C.lockCurrent)
  if (lock !== null && lock !== 3) {
    set('locked', lock === 1)
    set('jammed', lock === 2)
  }
  const valve = number(S.valve, C.active)
  if (valve !== null) set('valveOpen', valve === 1)

  set('temperature', number(S.temperature, C.currentTemperature))
  set('humidity', number(S.humidity, C.humidity))
  set('illuminance', number(S.light, C.lightLevel))
  const contact = number(S.contact, C.contact)
  if (contact !== null) set('open', contact === 1)
  const motion = value(S.motion, C.motion)
  if (typeof motion === 'boolean' || typeof motion === 'number') {
    set('motion', Boolean(motion))
    if (motion) set('lastMotionAt', now)
  }
  const occupied = number(S.occupancy, C.occupancy)
  if (occupied !== null) set('occupied', occupied === 1)
  const leak = number(S.leak, C.leak)
  if (leak !== null) set('leak', leak === 1)
  const smoke = number(S.smoke, C.smoke)
  if (smoke !== null) set('smoke', smoke === 1)
  const co = number(S.carbonMonoxide, C.carbonMonoxide)
  if (co !== null) set('co', co === 1)
  if (has(services, S.air)) {
    const quality = number(S.air, C.airQuality)
    set('airQuality', quality !== null ? (AIR_QUALITY[quality] ?? 'unknown') : 'unknown')
    set('co2', number(S.air, C.co2))
    set('pm25', number(S.air, C.pm25))
    set('pm10', number(S.air, C.pm10))
    set('voc', number(S.air, C.voc))
  }
  if (has(services, S.battery, C.batteryLevel)) {
    set('battery', number(S.battery, C.batteryLevel))
    const low = number(S.battery, C.lowBattery)
    if (low !== null) set('batteryLow', low === 1)
    const charging = number(S.battery, C.charging)
    if (charging !== null && charging !== 2) set('charging', charging === 1)
  }
  return state
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

export interface HapWrite {
  aid: number
  iid: number
  value: unknown
}

export type WritePlan = { writes: HapWrite[] } | { error: string }

export function planWrite(services: HapService[], command: string, args: Record<string, unknown>): WritePlan {
  const cannot: WritePlan = { error: `Cet accessoire HomeKit ne sait pas faire "${command}".` }
  const characteristic = (serviceTypes: string[], characteristicType: string) => {
    for (const type of serviceTypes) {
      const found = find(services, type, characteristicType)
      if (found) return found
    }
    return null
  }
  const write = (target: HapCharacteristic | null, value: unknown): HapWrite[] => (target ? [{ aid: target.aid, iid: target.iid, value }] : [])
  const power = characteristic([S.lightbulb, S.outlet, S.switch, S.fan], C.on)
  const active = characteristic([S.fanV2, S.valve], C.active)
  const switchTo = (on: boolean): HapWrite[] => (power ? write(power, on) : active && find(services, S.fanV2, C.active) ? write(active, on ? 1 : 0) : [])
  const plan = (writes: HapWrite[]): WritePlan => (writes.length > 0 ? { writes } : cannot)
  const colour = (hue: number, saturation: number) =>
    plan([...write(characteristic([S.lightbulb], C.hue), Math.round(((hue % 360) + 360) % 360)), ...write(characteristic([S.lightbulb], C.saturation), Math.round(clamp(saturation, 0, 100)))])

  switch (command) {
    case 'turnOn':
      return plan(switchTo(true))
    case 'turnOff':
      return plan(switchTo(false))
    case 'toggle': {
      const current = power ? num(power.value) : active ? num(active.value) : null
      return plan(switchTo(!current))
    }
    case 'setBrightness':
    case 'stepBrightness': {
      const target = characteristic([S.lightbulb], C.brightness)
      if (!target) return cannot
      const level = command === 'setBrightness' ? Number(args.brightness) : (num(target.value) ?? 0) + Number(args.delta ?? 0)
      const brightness = Math.round(clamp(Number.isFinite(level) ? level : 0, 0, 100))
      return brightness === 0 ? plan(switchTo(false)) : plan([...switchTo(true), ...write(target, brightness)])
    }
    case 'setColorTemperature': {
      const target = characteristic([S.lightbulb], C.colorTemperature)
      if (!target) return cannot
      return plan(write(target, clamp(kelvinToMired(Number(args.kelvin) || 4000), target.minValue ?? 140, target.maxValue ?? 500)))
    }
    case 'setColor':
      return colour(Number(args.hue) || 0, Number(args.saturation ?? 100))
    case 'setColorRgb': {
      const [hue, saturation] = rgbToHs(Number(args.r) || 0, Number(args.g) || 0, Number(args.b) || 0)
      return colour(hue, saturation)
    }
    case 'setColorName': {
      const named = NAMED_COLOURS[String(args.name ?? '').toLowerCase().trim()]
      return named ? colour(named[0], named[1]) : { error: `Couleur inconnue : ${String(args.name ?? '')}.` }
    }
    case 'setPosition':
      return plan(write(characteristic([S.covering], C.targetPosition), Math.round(clamp(Number(args.position) || 0, 0, 100))))
    case 'open':
      return plan(write(characteristic([S.covering], C.targetPosition), 100))
    case 'close':
      return plan(write(characteristic([S.covering], C.targetPosition), 0))
    case 'stop': {
      const hold = characteristic([S.covering], C.holdPosition)
      if (hold) return plan(write(hold, true))
      const current = characteristic([S.covering], C.currentPosition)
      return current ? plan(write(characteristic([S.covering], C.targetPosition), num(current.value) ?? 0)) : cannot
    }
    case 'openDoor':
      return plan(write(characteristic([S.garage], C.targetDoor), 0))
    case 'closeDoor':
      return plan(write(characteristic([S.garage], C.targetDoor), 1))
    case 'setTargetTemperature':
      return plan(write(characteristic([S.thermostat], C.targetTemperature), Math.round((Number(args.celsius) || 20) * 10) / 10))
    case 'setHvacMode': {
      const index = (HVAC_MODES as readonly string[]).indexOf(String(args.mode))
      if (index < 0) return has(services, S.thermostat) ? { error: `Un thermostat HomeKit ne connaît pas le mode "${String(args.mode)}".` } : cannot
      return plan(write(characteristic([S.thermostat], C.targetHeatingCooling), index))
    }
    case 'lock':
      return plan(write(characteristic([S.lock], C.lockTarget), 1))
    case 'unlock':
      return plan(write(characteristic([S.lock], C.lockTarget), 0))
    case 'setFanSpeed': {
      const speed = Math.round(clamp(Number(args.speed) || 0, 0, 100))
      const target = characteristic([S.fanV2, S.fan], C.rotationSpeed)
      if (!target) return cannot
      return plan([...switchTo(speed > 0), ...(speed > 0 ? write(target, speed) : [])])
    }
    case 'setFanMode': {
      const mode = String(args.mode)
      if (mode === 'off') return plan(switchTo(false))
      const automatic = characteristic([S.fanV2], C.targetFanState)
      if (mode === 'auto') return automatic ? plan([...switchTo(true), ...write(automatic, 1)]) : cannot
      const speed = { low: 25, quiet: 15, medium: 50, high: 100, boost: 100 }[mode]
      const target = characteristic([S.fanV2, S.fan], C.rotationSpeed)
      if (speed === undefined || !target) return cannot
      return plan([...switchTo(true), ...(automatic ? write(automatic, 0) : []), ...write(target, speed)])
    }
    case 'setOscillating':
      return plan(write(characteristic([S.fanV2, S.fan], C.swing), args.oscillating ? 1 : 0))
    case 'openValve':
      return plan(write(characteristic([S.valve], C.active), 1))
    case 'closeValve':
      return plan(write(characteristic([S.valve], C.active), 0))
    case 'identify':
      return plan(write(characteristic([S.info], C.identify), true))
    default:
      return cannot
  }
}

// ---------------------------------------------------------------------------------------
// Buttons and codes
// ---------------------------------------------------------------------------------------

/** ProgrammableSwitchEvent: 0 single press, 1 double press, 2 long press. */
export function buttonAction(value: unknown): 'single' | 'double' | 'hold' | null {
  return value === 0 ? 'single' : value === 1 ? 'double' : value === 2 ? 'hold' : null
}

/** HAP specification 5.4: codes too easy to guess, which no accessory may use. */
const FORBIDDEN_CODES = new Set(['00000000', '11111111', '22222222', '33333333', '44444444', '55555555', '66666666', '77777777', '88888888', '99999999', '12345678', '87654321'])

/**
 * A setup code as printed ("031-45-154"), typed without dashes, or read from the QR code
 * ("X-HM://" + 9 base-36 characters + a 4-character setup id). The QR payload packs the code
 * in its low 27 bits, the transport flags above, the category from bit 31 up.
 */
export function parseSetupCode(input: string): { code: string; setupId: string | null; category: number | null } | { error: string } {
  const raw = input.trim()
  let digits: string
  let setupId: string | null = null
  let category: number | null = null
  const uri = /^X-HM:\/\/([0-9A-Z]{9})([0-9A-Z]{4})$/i.exec(raw)
  if (uri) {
    const payload = BigInt(parseInt(uri[1]!.toUpperCase(), 36))
    digits = String(Number(payload & 0x7ffffffn)).padStart(8, '0')
    category = Number(payload >> 31n)
    setupId = uri[2]!.toUpperCase()
  } else {
    digits = raw.replace(/[\s.-]/g, '')
    if (!/^\d{8}$/.test(digits)) return { error: 'Un code HomeKit fait 8 chiffres (écrit 123-45-678 sous l\'appareil), ou commence par "X-HM://".' }
  }
  if (FORBIDDEN_CODES.has(digits)) return { error: 'Ce code est interdit par HomeKit (trop facile à deviner) : aucun accessoire ne le porte, il est sans doute mal recopié.' }
  return { code: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`, setupId, category }
}

/** The "sh" an accessory advertises: the first 4 bytes of SHA-512(setup id + device id), base64. */
export function setupHash(setupId: string, deviceId: string): string {
  return createHash('sha512').update(setupId + deviceId.toUpperCase()).digest().subarray(0, 4).toString('base64')
}

// ---------------------------------------------------------------------------------------
// What an accessory advertises
// ---------------------------------------------------------------------------------------

/** A HomeKit accessory as it advertises itself over mDNS (`_hap._tcp`, HAP table 6-7). */
export interface HapAdvert {
  /** The device id, "AA:BB:CC:DD:EE:FF": also the identifier its pairing carries. */
  id: string
  name: string
  host: string
  port: number
  /** Status flag bit 0 clear: some controller already holds a pairing with it. */
  paired: boolean
  category: number | null
  /** "c#": goes up whenever the accessory's database changes (an accessory added to a bridge). */
  configNumber: number | null
  setupHash: string | null
  model: string | null
}

export function parseAdvert(service: { name: string; addresses: string[]; port: number | null; txt: Record<string, string> }): HapAdvert | null {
  const txt = Object.fromEntries(Object.entries(service.txt).map(([key, value]) => [key.toLowerCase(), String(value).trim()]))
  const id = txt.id?.toUpperCase()
  const host = service.addresses.find((address) => /^\d{1,3}(\.\d{1,3}){3}$/.test(address)) ?? service.addresses[0]
  if (!id || !host || !service.port) return null
  const int = (value: string | undefined) => {
    const parsed = Number.parseInt(value ?? '', 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  const flags = int(txt.sf)
  return {
    id,
    name: service.name,
    host,
    port: service.port,
    paired: flags === null || (flags & 1) === 0,
    category: int(txt.ci),
    configNumber: int(txt['c#']),
    setupHash: txt.sh || null,
    model: txt.md || null,
  }
}
