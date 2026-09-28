/**
 * zigbee2mqtt, translated through what each device exposes.
 *
 * zigbee2mqtt describes every device with "exposes": typed features naming the property
 * they use in the JSON state, whether it can be set, and its range. The same word means
 * different things on different devices - `state` is ON/OFF on a bulb, LOCK/UNLOCK on a lock,
 * OPEN/CLOSE on a blind - so everything here goes through a profile built from the exposes
 * first, never through guesses on property names.
 *
 * Exposes: https://www.zigbee2mqtt.io/guide/usage/exposes.html
 * Topics:  https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html
 */

import {
  hsToRgb,
  kelvinToMired,
  level254ToPercent,
  miredToKelvin,
  percentToLevel254,
  rgbToHs,
  xyToRgb,
  type CapabilityId,
  type DeviceCategory,
  type DiscoveredDevice,
} from '@sway-home/shared'

export interface Expose {
  type: string
  name?: string
  property?: string
  endpoint?: string
  access?: number
  value_on?: unknown
  value_off?: unknown
  value_toggle?: unknown
  value_min?: number
  value_max?: number
  value_step?: number
  values?: string[]
  unit?: string
  features?: Expose[]
}

const SETTABLE = 2

interface Switchable {
  property: string
  on: unknown
  off: unknown
  toggle: unknown
}

interface LightProfile extends Switchable {
  brightness: { property: string; max: number } | null
  colorTemp: { property: string; min: number; max: number } | null
  hs: boolean
  xy: boolean
}

export interface ZigbeeEndpoint {
  index: number
  name: string
  category: DeviceCategory
  capabilities: CapabilityId[]
  light: LightProfile
}

export interface ZigbeeProfile {
  category: DeviceCategory
  capabilities: CapabilityId[]
  /** The main light or switch; for a multi-gang device, its first gang. */
  light: LightProfile | null
  endpoints: { index: number; name: string; category: DeviceCategory; capabilities: CapabilityId[] }[]
  gangs: ZigbeeEndpoint[]
  cover: { state: Switchable | null; position: string | null; tilt: string | null } | null
  lock: { property: string; lock: unknown; unlock: unknown; stateProperty: string | null } | null
  climate: {
    setpoint: { property: string; min: number; max: number; step: number } | null
    local: string | null
    mode: { property: string; values: string[] } | null
    running: string | null
  } | null
  identify: { property: string; value: string } | null
  /** Top-level sensor properties this device reports, by the property name z2m uses. */
  sensors: Set<string>
}

/** Sensor properties and the capability each one carries. Order is the order capabilities are listed in. */
const SENSORS: [property: string, capability: CapabilityId | null][] = [
  ['contact', 'contact'],
  ['occupancy', 'motion'],
  ['presence', 'occupancy'],
  ['water_leak', 'waterLeak'],
  ['smoke', 'smoke'],
  ['carbon_monoxide', 'carbonMonoxide'],
  ['temperature', 'temperature'],
  ['humidity', 'humidity'],
  ['pressure', 'pressure'],
  ['illuminance', 'illuminance'],
  ['illuminance_lux', 'illuminance'],
  ['co2', 'airQuality'],
  ['pm25', 'airQuality'],
  ['voc', 'airQuality'],
  ['power', 'power'],
  ['energy', 'energy'],
  ['voltage', null],
  ['current', null],
  ['action', 'button'],
  ['battery', 'battery'],
  ['battery_low', 'battery'],
  ['linkquality', null],
]

function switchable(feature: Expose | undefined): Switchable | null {
  if (!feature?.property) return null
  return { property: feature.property, on: feature.value_on ?? 'ON', off: feature.value_off ?? 'OFF', toggle: feature.value_toggle ?? null }
}

function lightFrom(expose: Expose): LightProfile | null {
  const features = expose.features ?? []
  const base = switchable(features.find((feature) => feature.name === 'state'))
  if (!base) return null
  const brightness = features.find((feature) => feature.name === 'brightness' && feature.property)
  const colorTemp = features.find((feature) => feature.name === 'color_temp' && feature.property)
  return {
    ...base,
    brightness: brightness ? { property: brightness.property!, max: brightness.value_max ?? 254 } : null,
    colorTemp: colorTemp ? { property: colorTemp.property!, min: colorTemp.value_min ?? 150, max: colorTemp.value_max ?? 500 } : null,
    hs: features.some((feature) => feature.name === 'color_hs'),
    xy: features.some((feature) => feature.name === 'color_xy'),
  }
}

function lightCapabilities(light: LightProfile): CapabilityId[] {
  const capabilities: CapabilityId[] = ['onoff']
  if (light.brightness) capabilities.push('brightness')
  if (light.colorTemp) capabilities.push('colorTemperature')
  if (light.hs || light.xy) capabilities.push('color')
  return capabilities
}

export function profileFrom(exposes: Expose[]): ZigbeeProfile {
  const profile: ZigbeeProfile = {
    category: 'sensor',
    capabilities: [],
    light: null,
    endpoints: [],
    gangs: [],
    cover: null,
    lock: null,
    climate: null,
    identify: null,
    sensors: new Set(),
  }
  const add = (...capabilities: CapabilityId[]) => {
    for (const capability of capabilities) if (!profile.capabilities.includes(capability)) profile.capabilities.push(capability)
  }
  let category: DeviceCategory | null = null

  // Lights and switches first: they name the device, and a multi-gang one becomes endpoints.
  const switches = exposes.filter((expose) => expose.type === 'light' || expose.type === 'switch')
  switches.forEach((expose, index) => {
    const light = lightFrom(expose)
    if (!light) return
    const gangCategory: DeviceCategory = expose.type === 'light' ? 'light' : 'switch'
    profile.gangs.push({ index: index + 1, name: expose.endpoint ?? String(index + 1), category: gangCategory, capabilities: lightCapabilities(light), light })
  })
  if (profile.gangs.length > 0) {
    const first = profile.gangs[0]!
    profile.light = first.light
    category = first.category
    add(...first.capabilities)
    if (profile.gangs.length > 1) {
      profile.endpoints = profile.gangs.map(({ index, name, category: kind, capabilities }) => ({ index, name, category: kind, capabilities }))
    }
  }

  for (const expose of exposes) {
    const features = expose.features ?? []
    if (expose.type === 'cover') {
      const position = features.find((feature) => feature.name === 'position')?.property ?? null
      const tilt = features.find((feature) => feature.name === 'tilt')?.property ?? null
      profile.cover = { state: switchable(features.find((feature) => feature.name === 'state')), position, tilt }
      category ??= 'cover'
      add('position')
      if (tilt) add('tilt')
    }
    if (expose.type === 'lock') {
      const control = features.find((feature) => feature.name === 'state')
      if (control?.property) {
        profile.lock = { property: control.property, lock: control.value_on ?? 'LOCK', unlock: control.value_off ?? 'UNLOCK', stateProperty: features.find((feature) => feature.name === 'lock_state')?.property ?? null }
        category ??= 'lock'
        add('lock')
      }
    }
    if (expose.type === 'climate') {
      const setpoint = features.find((feature) => feature.name === 'occupied_heating_setpoint' || feature.name === 'current_heating_setpoint')
      const mode = features.find((feature) => feature.name === 'system_mode')
      profile.climate = {
        setpoint: setpoint?.property ? { property: setpoint.property, min: setpoint.value_min ?? 5, max: setpoint.value_max ?? 35, step: setpoint.value_step ?? 0.5 } : null,
        local: features.find((feature) => feature.name === 'local_temperature')?.property ?? null,
        mode: mode?.property ? { property: mode.property, values: mode.values ?? [] } : null,
        running: features.find((feature) => feature.name === 'running_state')?.property ?? null,
      }
      category ??= 'climate'
      add('thermostat')
      if (profile.climate.local) add('temperature')
    }
    if (expose.type === 'enum' && expose.name === 'identify' && expose.property && ((expose.access ?? 0) & SETTABLE)) {
      profile.identify = { property: expose.property, value: expose.values?.[0] ?? 'identify' }
    }
  }

  // Top-level sensors, in a fixed order so the capability list reads the same every time.
  const topLevel = new Set(exposes.filter((expose) => expose.property && !expose.endpoint).map((expose) => expose.property!))
  for (const [property, capability] of SENSORS) {
    if (!topLevel.has(property)) continue
    profile.sensors.add(property)
    if (capability) add(capability)
  }
  // After the device's own features: finding it in a room, then the radio it is on.
  if (profile.identify) add('identify')
  add('connectivity')

  profile.category = category === 'switch' && profile.sensors.has('power') ? 'outlet' : category ?? 'sensor'
  return profile
}

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

export interface ZigbeeReading {
  state: Record<string, unknown>
  /** Per-gang state for multi-gang devices, keyed by endpoint index. */
  endpoints: Record<number, Record<string, unknown>>
  /** Button actions carried by this payload, as zigbee2mqtt names them. */
  events: string[]
}

function lightState(payload: Record<string, unknown>, light: LightProfile): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  const value = payload[light.property]
  if (value !== undefined) state.on = value === light.on
  if (light.brightness && typeof payload[light.brightness.property] === 'number') {
    state.brightness = light.brightness.max === 254 ? level254ToPercent(payload[light.brightness.property] as number) : Math.round(((payload[light.brightness.property] as number) / light.brightness.max) * 100)
  }
  if (light.colorTemp && typeof payload[light.colorTemp.property] === 'number' && payload.color_mode !== 'hs' && payload.color_mode !== 'xy') {
    state.colorTemperature = miredToKelvin(payload[light.colorTemp.property] as number)
  }
  const colour = payload.color as Record<string, number> | undefined
  if ((light.hs || light.xy) && colour && payload.color_mode !== 'color_temp') {
    if (typeof colour.hue === 'number') {
      state.hue = Math.round(colour.hue)
      state.saturation = Math.round(colour.saturation ?? 100)
    } else if (typeof colour.x === 'number' && typeof colour.y === 'number') {
      const [hue, saturation] = rgbToHs(...xyToRgb(colour.x, colour.y))
      state.hue = Math.round(hue)
      state.saturation = Math.round(saturation)
    }
  }
  return state
}

function buttonEvent(action: string): string {
  if (/double/.test(action)) return 'double'
  if (/triple/.test(action)) return 'triple'
  if (/rotate_left|rotate_ccw|anticlockwise/.test(action)) return 'rotate_left'
  if (/rotate_right|rotate_cw|clockwise/.test(action)) return 'rotate_right'
  if (/release|stop/.test(action)) return 'release'
  if (/hold|long|move/.test(action)) return 'hold'
  return 'single'
}

export function stateFrom(payload: Record<string, unknown>, profile: ZigbeeProfile): ZigbeeReading {
  const reading: ZigbeeReading = { state: {}, endpoints: {}, events: [] }
  const state = reading.state

  if (profile.gangs.length > 1) {
    for (const gang of profile.gangs) {
      const gangState = lightState(payload, gang.light)
      if (Object.keys(gangState).length > 0) reading.endpoints[gang.index] = gangState
    }
    Object.assign(state, reading.endpoints[profile.gangs[0]!.index] ?? {})
  } else if (profile.light) {
    Object.assign(state, lightState(payload, profile.light))
  }

  if (profile.cover) {
    if (profile.cover.position && typeof payload[profile.cover.position] === 'number') state.position = payload[profile.cover.position]
    if (profile.cover.tilt && typeof payload[profile.cover.tilt] === 'number') state.tilt = payload[profile.cover.tilt]
  }
  if (profile.lock) {
    const detailed = profile.lock.stateProperty ? payload[profile.lock.stateProperty] : undefined
    if (typeof detailed === 'string') state.locked = detailed === 'locked'
    else if (payload[profile.lock.property] !== undefined) state.locked = payload[profile.lock.property] === profile.lock.lock
  }
  if (profile.climate) {
    const { setpoint, local, mode, running } = profile.climate
    if (setpoint && typeof payload[setpoint.property] === 'number') state.targetTemperature = payload[setpoint.property]
    if (local && typeof payload[local] === 'number') {
      state.currentTemperature = payload[local]
      state.temperature = payload[local]
    }
    if (mode && typeof payload[mode.property] === 'string') {
      const value = payload[mode.property] as string
      state.hvacMode = ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'].includes(value) ? value : value === 'heat_cool' ? 'auto' : 'off'
    }
    if (running && typeof payload[running] === 'string') {
      const value = payload[running] as string
      state.hvacAction = value === 'heat' ? 'heating' : value === 'cool' ? 'cooling' : value === 'fan_only' ? 'fan' : 'idle'
    }
  }

  const sensors = profile.sensors
  const number = (property: string) => (sensors.has(property) && typeof payload[property] === 'number' ? (payload[property] as number) : null)
  const flag = (property: string) => (sensors.has(property) && typeof payload[property] === 'boolean' ? (payload[property] as boolean) : null)

  const contact = flag('contact')
  if (contact !== null) state.open = !contact
  const occupancy = flag('occupancy')
  if (occupancy !== null) state.motion = occupancy
  const presence = flag('presence')
  if (presence !== null) state.occupied = presence
  const leak = flag('water_leak')
  if (leak !== null) state.leak = leak
  const smoke = flag('smoke')
  if (smoke !== null) state.smoke = smoke
  const co = flag('carbon_monoxide')
  if (co !== null) state.co = co

  for (const [property, key] of [
    ['temperature', 'temperature'],
    ['humidity', 'humidity'],
    ['pressure', 'pressure'],
    ['co2', 'co2'],
    ['pm25', 'pm25'],
    ['voc', 'voc'],
    ['power', 'power'],
    ['energy', 'energyTotal'],
    ['voltage', 'voltage'],
    ['current', 'current'],
    ['linkquality', 'linkQuality'],
  ] as const) {
    const value = number(property)
    if (value !== null) state[key] = value
  }
  const lux = number('illuminance_lux') ?? number('illuminance')
  if (lux !== null) state.illuminance = lux

  const battery = number('battery')
  if (battery !== null) {
    state.battery = battery
    state.batteryLow = battery <= 20
  }
  const low = flag('battery_low')
  if (low !== null) state.batteryLow = low

  const action = sensors.has('action') ? payload.action : undefined
  if (typeof action === 'string' && action.length > 0) {
    reading.events.push(action)
    state.lastEvent = buttonEvent(action)
    state.lastEventAt = new Date().toISOString()
  }

  return reading
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

export function commandPayload(command: string, args: Record<string, unknown>, profile: ZigbeeProfile, endpointIndex?: number): Record<string, unknown> | null {
  const gang = endpointIndex !== undefined ? profile.gangs.find((candidate) => candidate.index === endpointIndex)?.light ?? null : profile.light
  const transition = typeof args.transitionMs === 'number' ? { transition: args.transitionMs / 1000 } : {}

  if (gang) {
    switch (command) {
      case 'turnOn':
        return { [gang.property]: gang.on, ...transition }
      case 'turnOff':
        return { [gang.property]: gang.off, ...transition }
      case 'toggle':
        return gang.toggle === null ? null : { [gang.property]: gang.toggle }
      case 'setBrightness': {
        if (!gang.brightness) return null
        const percent = Number(args.brightness)
        if (percent <= 0) return { [gang.property]: gang.off, ...transition }
        const level = gang.brightness.max === 254 ? percentToLevel254(percent) : Math.round((percent / 100) * gang.brightness.max)
        return { [gang.property]: gang.on, [gang.brightness.property]: level, ...transition }
      }
      case 'stepBrightness':
        return gang.brightness ? { [`${gang.brightness.property}_step`]: Math.round((Number(args.delta) / 100) * gang.brightness.max), ...transition } : null
      case 'setColorTemperature': {
        if (!gang.colorTemp) return null
        const mired = Math.min(gang.colorTemp.max, Math.max(gang.colorTemp.min, kelvinToMired(Number(args.kelvin))))
        return { [gang.property]: gang.on, [gang.colorTemp.property]: mired, ...transition }
      }
      case 'setColor': {
        if (gang.hs) return { [gang.property]: gang.on, color: { hue: Number(args.hue), saturation: Number(args.saturation) }, ...transition }
        if (!gang.xy) return null
        // A bulb that only speaks xy gets RGB, which zigbee2mqtt converts for it.
        const [r, g, b] = hsToRgb(Number(args.hue), Number(args.saturation))
        return { [gang.property]: gang.on, color: { r, g, b }, ...transition }
      }
      case 'setColorRgb':
        return gang.hs || gang.xy ? { [gang.property]: gang.on, color: { r: Number(args.r), g: Number(args.g), b: Number(args.b) }, ...transition } : null
    }
  }

  if (profile.cover) {
    const control = profile.cover.state?.property ?? 'state'
    if (command === 'open') return { [control]: profile.cover.state?.on ?? 'OPEN' }
    if (command === 'close') return { [control]: profile.cover.state?.off ?? 'CLOSE' }
    if (command === 'stop') return { [control]: 'STOP' }
    if (command === 'setPosition' && profile.cover.position) return { [profile.cover.position]: Math.round(Number(args.position)) }
    if (command === 'setTilt' && profile.cover.tilt) return { [profile.cover.tilt]: Math.round(Number(args.tilt)) }
  }

  if (profile.lock) {
    if (command === 'lock') return { [profile.lock.property]: profile.lock.lock }
    if (command === 'unlock') return { [profile.lock.property]: profile.lock.unlock }
  }

  if (profile.climate) {
    const { setpoint, mode } = profile.climate
    if (command === 'setTargetTemperature' && setpoint) {
      const snapped = Math.round(Number(args.celsius) / setpoint.step) * setpoint.step
      return { [setpoint.property]: Math.min(setpoint.max, Math.max(setpoint.min, Number(snapped.toFixed(2)))) }
    }
    if (command === 'setHvacMode' && mode) {
      const wanted = String(args.mode)
      const value = mode.values.includes(wanted) ? wanted : wanted === 'auto' && mode.values.includes('heat_cool') ? 'heat_cool' : null
      return value ? { [mode.property]: value } : null
    }
  }

  if (command === 'identify' && profile.identify) return { [profile.identify.property]: profile.identify.value }
  return null
}

// ---------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------

export interface BridgeDevice {
  ieee_address?: string
  friendly_name?: string
  type?: string
  supported?: boolean
  disabled?: boolean
  interview_completed?: boolean
  interview_state?: string
  power_source?: string
  manufacturer?: string
  model_id?: string
  definition?: { model?: string; vendor?: string; description?: string; exposes?: Expose[] } | null
}

export function deviceFrom(entry: BridgeDevice): (DiscoveredDevice & { profile: ZigbeeProfile }) | null {
  const ieee = entry.ieee_address
  if (!ieee || entry.type === 'Coordinator' || entry.disabled) return null
  // 2.x reports `interview_state`; 1.x a boolean. A device mid-interview has no exposes yet.
  if (entry.interview_state ? entry.interview_state !== 'SUCCESSFUL' : entry.interview_completed === false) return null
  const exposes = entry.definition?.exposes ?? []
  if (exposes.length === 0) return null

  const profile = profileFrom(exposes)
  const friendlyName = entry.friendly_name ?? ieee
  return {
    adapterId: 'zigbee',
    nativeId: ieee,
    uid: `zigbee:${ieee}`,
    name: friendlyName,
    category: profile.category,
    capabilities: profile.capabilities,
    transport: 'zigbee',
    manufacturer: entry.definition?.vendor ?? entry.manufacturer ?? null,
    model: entry.definition?.model ?? entry.model_id ?? null,
    serialNumber: ieee,
    confidence: 0.97,
    ...(profile.endpoints.length > 0 ? { endpoints: profile.endpoints } : {}),
    meta: { friendlyName, powerSource: entry.power_source ?? null },
    profile,
  }
}
