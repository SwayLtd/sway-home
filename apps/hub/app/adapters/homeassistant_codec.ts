/**
 * Home Assistant, translated.
 *
 * Pure functions, no socket: an entity's state and attributes become capability state in
 * Sway units, a Sway command becomes a service call, and the entities HA registered under
 * one physical device become one Sway device again. The WebSocket conversation that feeds
 * them lives in `homeassistant.ts`.
 *
 * Entity model: https://developers.home-assistant.io/docs/core/entity/
 * Services per domain: https://www.home-assistant.io/integrations/ (light, cover, climate...)
 */

import { airQualityFrom, COMMAND_OWNER, fahrenheitToCelsius, type CapabilityId, type DeviceCategory } from '@sway-home/shared'

export interface HaState {
  entity_id: string
  state: string
  attributes: Record<string, unknown>
  last_changed?: string
  last_updated?: string
}

export interface HaEntityEntry {
  entity_id: string
  device_id: string | null
  area_id: string | null
  /** 'config', 'diagnostic', or null for a primary entity. */
  entity_category: string | null
  disabled_by: string | null
  hidden_by: string | null
  name?: string | null
}

export interface HaDeviceEntry {
  id: string
  name: string | null
  name_by_user: string | null
  manufacturer: string | null
  model: string | null
  sw_version: string | null
  area_id: string | null
}

export interface HaAreaEntry {
  area_id: string
  name: string
}

export interface HaRegistry {
  entities: HaEntityEntry[]
  devices: HaDeviceEntry[]
  areas: HaAreaEntry[]
}

export interface EntityReading {
  category: DeviceCategory | null
  capabilities: CapabilityId[]
  state: Record<string, unknown>
  /** False for `unavailable` and `unknown`: the entity exists but says nothing right now. */
  available: boolean
}

export interface HaServiceCall {
  domain: string
  service: string
  service_data: Record<string, unknown>
  target: { entity_id: string }
}

const OFFLINE = new Set(['unavailable', 'unknown'])

function domainOf(entityId: string): string {
  return entityId.slice(0, entityId.indexOf('.'))
}

function number(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const NONE: EntityReading = { category: null, capabilities: [], state: {}, available: true }

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

export function readEntity(entity: HaState): EntityReading {
  const domain = domainOf(entity.entity_id)
  const reading = readByDomain(domain, entity)
  if (OFFLINE.has(entity.state)) return { ...reading, state: {}, available: false }
  return reading
}

function readByDomain(domain: string, entity: HaState): EntityReading {
  const a = entity.attributes
  const on = entity.state === 'on'

  switch (domain) {
    case 'light':
      return readLight(entity)

    case 'switch':
    case 'input_boolean':
      return { category: a.device_class === 'outlet' ? 'outlet' : 'switch', capabilities: ['onoff'], state: { on }, available: true }

    case 'fan': {
      const state: Record<string, unknown> = { on }
      const percentage = number(a.percentage)
      if (percentage !== null) state.fanSpeed = percentage
      if (typeof a.oscillating === 'boolean') state.oscillating = a.oscillating
      return { category: 'climate', capabilities: percentage === null ? ['onoff'] : ['onoff', 'fan'], state, available: true }
    }

    case 'cover': {
      if (a.device_class === 'garage' || a.device_class === 'gate') {
        const doorState = ['open', 'closed', 'opening', 'closing'].includes(entity.state) ? entity.state : 'stopped'
        return { category: 'cover', capabilities: ['garage'], state: { doorState }, available: true }
      }
      const position = number(a.current_position) ?? (entity.state === 'open' ? 100 : entity.state === 'closed' ? 0 : null)
      const moving = entity.state === 'opening' ? 'opening' : entity.state === 'closing' ? 'closing' : 'idle'
      const capabilities: CapabilityId[] = ['position']
      const state: Record<string, unknown> = { moving }
      if (position !== null) state.position = position
      const tilt = number(a.current_tilt_position)
      if (tilt !== null) {
        capabilities.push('tilt')
        state.tilt = tilt
      }
      return { category: 'cover', capabilities, state: position === null ? state : { position, ...state }, available: true }
    }

    case 'valve': {
      const level = number(a.current_position)
      const state: Record<string, unknown> = { valveOpen: entity.state === 'open' || entity.state === 'opening' }
      if (level !== null) state.valveLevel = level
      return { category: 'appliance', capabilities: ['valve'], state, available: true }
    }

    case 'climate': {
      const state: Record<string, unknown> = {}
      const target = number(a.temperature)
      const current = number(a.current_temperature)
      if (target !== null) state.targetTemperature = target
      if (current !== null) {
        state.currentTemperature = current
        state.temperature = current
      }
      state.hvacMode = hvacModeFrom(entity.state)
      const action = hvacActionFrom(a.hvac_action)
      if (action) state.hvacAction = action
      if (typeof a.preset_mode === 'string') state.preset = a.preset_mode
      return { category: 'climate', capabilities: current === null ? ['thermostat'] : ['thermostat', 'temperature'], state, available: true }
    }

    case 'lock':
      return { category: 'lock', capabilities: ['lock'], state: { locked: entity.state === 'locked', jammed: entity.state === 'jammed' }, available: true }

    case 'media_player':
      return readMediaPlayer(entity)

    case 'vacuum': {
      const vacuumState = ({ docked: 'docked', cleaning: 'cleaning', returning: 'returning', paused: 'paused', error: 'error', idle: 'idle' } as Record<string, string>)[entity.state] ?? 'idle'
      const state: Record<string, unknown> = { vacuumState }
      const battery = number(a.battery_level)
      if (battery !== null) state.battery = battery
      return { category: 'vacuum', capabilities: battery === null ? ['vacuum'] : ['vacuum', 'battery'], state, available: true }
    }

    case 'siren':
      return { category: 'appliance', capabilities: ['siren'], state: { sounding: on }, available: true }

    case 'camera': {
      const state: Record<string, unknown> = { streaming: entity.state === 'streaming', recording: entity.state === 'recording' }
      if (typeof a.entity_picture === 'string') state.snapshotUrl = a.entity_picture
      return { category: 'camera', capabilities: ['camera'], state, available: true }
    }

    case 'person':
      return { category: 'phone', capabilities: ['presence'], state: { home: entity.state === 'home', source: 'network' }, available: true }

    case 'sensor':
      return readSensor(entity)

    case 'binary_sensor':
      return readBinarySensor(entity)

    default:
      return NONE
  }
}

function readLight(entity: HaState): EntityReading {
  const a = entity.attributes
  const modes = Array.isArray(a.supported_color_modes) ? (a.supported_color_modes as string[]) : ['onoff']
  const capabilities: CapabilityId[] = ['onoff']
  const dims = modes.some((mode) => mode !== 'onoff')
  const white = modes.includes('color_temp')
  const colour = modes.some((mode) => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(mode))
  if (dims) capabilities.push('brightness')
  if (white) capabilities.push('colorTemperature')
  if (colour) capabilities.push('color')

  const state: Record<string, unknown> = { on: entity.state === 'on' }
  const brightness = number(a.brightness)
  if (dims && brightness !== null) state.brightness = Math.round((brightness / 255) * 100)
  const kelvin = number(a.color_temp_kelvin)
  if (white && kelvin !== null) state.colorTemperature = kelvin
  if (colour && Array.isArray(a.hs_color) && a.hs_color.length === 2) {
    state.hue = Math.round(Number(a.hs_color[0]))
    state.saturation = Math.round(Number(a.hs_color[1]))
  }
  return { category: 'light', capabilities, state, available: true }
}

function readMediaPlayer(entity: HaState): EntityReading {
  const a = entity.attributes
  const category: DeviceCategory = a.device_class === 'tv' ? 'display' : a.device_class === 'speaker' ? 'speaker' : 'media'
  const playback = ({ playing: 'playing', paused: 'paused', buffering: 'buffering', idle: 'idle', on: 'idle', standby: 'stopped', off: 'stopped' } as Record<string, string>)[entity.state] ?? 'idle'

  const state: Record<string, unknown> = { on: entity.state !== 'off' && entity.state !== 'standby', playback }
  const volume = number(a.volume_level)
  if (volume !== null) state.volume = Math.round(volume * 100)
  if (typeof a.is_volume_muted === 'boolean') state.muted = a.is_volume_muted
  if ('media_title' in a) state.title = a.media_title ?? null
  if ('media_artist' in a) state.artist = a.media_artist ?? null
  if ('media_album_name' in a) state.album = a.media_album_name ?? null
  if (typeof a.source === 'string') state.source = a.source
  if (Array.isArray(a.source_list)) state.availableSources = a.source_list
  if (typeof a.app_name === 'string') state.app = a.app_name
  return { category, capabilities: ['onoff', 'mediaPlayback', 'volume', 'mediaSource'], state, available: true }
}

/** Pressure units HA may report, to hectopascals. */
const TO_HPA: Record<string, number> = { hPa: 1, mbar: 1, kPa: 10, Pa: 0.01, bar: 1000, inHg: 33.8639, mmHg: 1.33322, psi: 68.9476 }

function readSensor(entity: HaState): EntityReading {
  const a = entity.attributes
  const value = number(entity.state)
  const unit = typeof a.unit_of_measurement === 'string' ? a.unit_of_measurement : ''
  const sensor = (capabilities: CapabilityId[], state: Record<string, unknown>): EntityReading => ({ category: 'sensor', capabilities, state, available: true })
  if (value === null) return OFFLINE.has(entity.state) ? { ...NONE, capabilities: capabilityOfSensor(a.device_class), category: 'sensor' } : NONE

  switch (a.device_class) {
    case 'temperature': {
      const celsius = unit === '°F' ? fahrenheitToCelsius(value) : unit === 'K' ? value - 273.15 : value
      return sensor(['temperature'], { temperature: round(celsius, 1) })
    }
    case 'humidity':
      return sensor(['humidity'], { humidity: value })
    case 'illuminance':
      return sensor(['illuminance'], { illuminance: value })
    case 'pressure':
    case 'atmospheric_pressure':
      return sensor(['pressure'], { pressure: round(value * (TO_HPA[unit] ?? 1), 1) })
    case 'power':
      return sensor(['power'], { power: round(unit === 'kW' ? value * 1000 : unit === 'MW' ? value * 1_000_000 : value, 2) })
    case 'energy':
      return sensor(['energy'], { energyTotal: round(unit === 'Wh' ? value / 1000 : unit === 'MWh' ? value * 1000 : value, 3) })
    case 'battery':
      return sensor(['battery'], { battery: value, batteryLow: value <= 20 })
    case 'carbon_dioxide':
      return sensor(['airQuality'], { co2: value, airQuality: airQualityFrom({ co2: value }) })
    case 'pm25':
      return sensor(['airQuality'], { pm25: value, airQuality: airQualityFrom({ pm25: value }) })
    case 'pm10':
      return sensor(['airQuality'], { pm10: value, airQuality: 'unknown' })
    case 'volatile_organic_compounds':
    case 'volatile_organic_compounds_parts':
      return sensor(['airQuality'], { voc: value, airQuality: 'unknown' })
    default:
      return NONE
  }
}

function capabilityOfSensor(deviceClass: unknown): CapabilityId[] {
  const map: Record<string, CapabilityId> = {
    temperature: 'temperature',
    humidity: 'humidity',
    illuminance: 'illuminance',
    pressure: 'pressure',
    atmospheric_pressure: 'pressure',
    power: 'power',
    energy: 'energy',
    battery: 'battery',
    carbon_dioxide: 'airQuality',
    pm25: 'airQuality',
  }
  const capability = typeof deviceClass === 'string' ? map[deviceClass] : undefined
  return capability ? [capability] : []
}

function readBinarySensor(entity: HaState): EntityReading {
  const on = entity.state === 'on'
  const sensor = (capabilities: CapabilityId[], state: Record<string, unknown>): EntityReading => ({ category: 'sensor', capabilities, state, available: true })
  switch (entity.attributes.device_class) {
    case 'motion':
      return sensor(['motion'], { motion: on })
    case 'occupancy':
    case 'presence':
      return sensor(['occupancy'], { occupied: on })
    case 'door':
    case 'window':
    case 'opening':
    case 'garage_door':
      return sensor(['contact'], { open: on })
    case 'moisture':
      return sensor(['waterLeak'], { leak: on })
    case 'smoke':
      return sensor(['smoke'], { smoke: on })
    case 'carbon_monoxide':
    case 'gas':
      return sensor(['carbonMonoxide'], { co: on })
    case 'battery':
      return sensor([], { batteryLow: on })
    default:
      return NONE
  }
}

function hvacModeFrom(state: string): string {
  if (state === 'heat_cool') return 'auto'
  return ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'].includes(state) ? state : 'off'
}

function hvacActionFrom(action: unknown): string | null {
  if (typeof action !== 'string') return null
  const map: Record<string, string> = { heating: 'heating', preheating: 'heating', defrosting: 'heating', cooling: 'cooling', drying: 'drying', fan: 'fan', idle: 'idle', off: 'off' }
  return map[action] ?? null
}

// ---------------------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------------------

export interface HaGroup {
  /** The HA device id when the group is a whole device, else the entity id. */
  nativeId: string
  name: string
  category: DeviceCategory
  capabilities: CapabilityId[]
  /** Which entity carries each capability, so a command reaches the right one. */
  bindings: Partial<Record<CapabilityId, string>>
  entities: string[]
  manufacturer: string | null
  model: string | null
  firmware: string | null
  area: string | null
}

const ACTUATORS = new Set(['light', 'switch', 'input_boolean', 'fan', 'cover', 'valve', 'climate', 'lock', 'media_player', 'vacuum', 'siren', 'camera'])

/**
 * One Sway device per HA device, the way a person thinks of it: a plug is its switch plus
 * its power and energy sensors. A device with two actuators - a dual relay - becomes one
 * Sway device per actuator instead, because "turn on the relay" would otherwise be
 * ambiguous; its sensors, if any, form one more device.
 *
 * Diagnostic entities are dropped, except the battery: a relay's chip temperature is marked
 * diagnostic precisely because it is not the air in the room.
 */
export function groupEntities(states: HaState[], registry: HaRegistry): HaGroup[] {
  const entries = new Map(registry.entities.map((entry) => [entry.entity_id, entry]))
  const devices = new Map(registry.devices.map((device) => [device.id, device]))
  const areas = new Map(registry.areas.map((area) => [area.area_id, area.name]))

  const usable = states
    .map((state) => ({ state, entry: entries.get(state.entity_id) ?? null, reading: readEntity(state) }))
    .filter(({ entry, reading, state }) => {
      if (entry?.disabled_by || entry?.hidden_by) return false
      if (reading.capabilities.length === 0 && !('batteryLow' in reading.state)) return false
      if (entry?.entity_category === 'config') return false
      if (entry?.entity_category === 'diagnostic' && state.attributes.device_class !== 'battery') return false
      return true
    })

  const byDevice = new Map<string, typeof usable>()
  const loose: typeof usable = []
  for (const item of usable) {
    const deviceId = item.entry?.device_id ?? null
    if (deviceId && devices.has(deviceId)) byDevice.set(deviceId, [...(byDevice.get(deviceId) ?? []), item])
    else loose.push(item)
  }

  const groups: HaGroup[] = []
  const nameOf = (state: HaState) => (typeof state.attributes.friendly_name === 'string' ? state.attributes.friendly_name : state.entity_id)

  for (const item of loose) {
    groups.push(build(item.state.entity_id, nameOf(item.state), [item], null, areas.get(item.entry?.area_id ?? '') ?? null))
  }

  for (const [deviceId, items] of byDevice) {
    const device = devices.get(deviceId)!
    const deviceName = device.name_by_user ?? device.name ?? nameOf(items[0]!.state)
    const actuators = items.filter((item) => ACTUATORS.has(domainOf(item.state.entity_id)))
    const sensors = items.filter((item) => !ACTUATORS.has(domainOf(item.state.entity_id)))
    const areaOf = (item: (typeof items)[number]) => areas.get(item.entry?.area_id ?? device.area_id ?? '') ?? null

    if (actuators.length <= 1) {
      groups.push(build(deviceId, deviceName, items, device, areaOf(actuators[0] ?? items[0]!)))
      continue
    }
    for (const actuator of actuators) groups.push(build(actuator.state.entity_id, nameOf(actuator.state), [actuator], device, areaOf(actuator)))
    if (sensors.length > 0) groups.push(build(deviceId, deviceName, sensors, device, areaOf(sensors[0]!)))
  }

  return groups
}

function build(
  nativeId: string,
  name: string,
  items: { state: HaState; reading: EntityReading }[],
  device: HaDeviceEntry | null,
  area: string | null
): HaGroup {
  const bindings: Partial<Record<CapabilityId, string>> = {}
  const capabilities: CapabilityId[] = []
  // The actuator names the category; sensors only when there is nothing else.
  const ordered = [...items].sort((a, b) => Number(ACTUATORS.has(domainOf(b.state.entity_id))) - Number(ACTUATORS.has(domainOf(a.state.entity_id))))
  let category: DeviceCategory | null = null

  for (const { state, reading } of ordered) {
    category ??= reading.category
    for (const capability of reading.capabilities) {
      if (bindings[capability]) continue
      bindings[capability] = state.entity_id
      capabilities.push(capability)
    }
  }

  return {
    nativeId,
    name,
    category: category ?? 'sensor',
    capabilities,
    bindings,
    entities: items.map((item) => item.state.entity_id),
    manufacturer: device?.manufacturer ?? null,
    model: device?.model ?? null,
    firmware: device?.sw_version ?? null,
    area,
  }
}

/** The entity a command goes to: the one bound to the capability that owns the command. */
export function entityForCommand(group: HaGroup, command: string): string | null {
  const capability = COMMAND_OWNER[command]
  if (!capability) return null
  return group.bindings[capability] ?? null
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

export function toServiceCall(entityId: string, command: string, args: Record<string, unknown>, current?: HaState): HaServiceCall | null {
  const domain = domainOf(entityId)
  const call = (service: string, service_data: Record<string, unknown> = {}, serviceDomain = domain): HaServiceCall => ({
    domain: serviceDomain,
    service,
    service_data,
    target: { entity_id: entityId },
  })
  const transition = typeof args.transitionMs === 'number' && domain === 'light' ? { transition: args.transitionMs / 1000 } : {}

  switch (command) {
    case 'turnOn':
    case 'turnOff':
    case 'toggle': {
      if (!['light', 'switch', 'input_boolean', 'fan', 'media_player', 'siren', 'climate'].includes(domain)) return null
      const service = command === 'turnOn' ? 'turn_on' : command === 'turnOff' ? 'turn_off' : 'toggle'
      return call(service, command === 'toggle' ? {} : transition)
    }
  }

  switch (domain) {
    case 'light':
      if (command === 'setBrightness') return call('turn_on', { ...transition, brightness_pct: Number(args.brightness) })
      if (command === 'stepBrightness') return call('turn_on', { ...transition, brightness_step_pct: Number(args.delta) })
      if (command === 'setColorTemperature') return call('turn_on', { ...transition, color_temp_kelvin: Number(args.kelvin) })
      if (command === 'setColor') return call('turn_on', { ...transition, hs_color: [Number(args.hue), Number(args.saturation)] })
      if (command === 'setColorRgb') return call('turn_on', { ...transition, rgb_color: [Number(args.r), Number(args.g), Number(args.b)] })
      if (command === 'setColorName') return call('turn_on', { ...transition, color_name: String(args.name) })
      return null

    case 'cover':
      if (command === 'open' || command === 'openDoor') return call('open_cover')
      if (command === 'close' || command === 'closeDoor') return call('close_cover')
      if (command === 'stop' || command === 'stopDoor') return call('stop_cover')
      if (command === 'setPosition') return call('set_cover_position', { position: Number(args.position) })
      if (command === 'setTilt') return call('set_cover_tilt_position', { tilt_position: Number(args.tilt) })
      return null

    case 'valve':
      if (command === 'openValve') return typeof args.level === 'number' ? call('set_valve_position', { position: args.level }) : call('open_valve')
      if (command === 'closeValve') return call('close_valve')
      return null

    case 'fan':
      if (command === 'setFanSpeed') return call('set_percentage', { percentage: Number(args.speed) })
      if (command === 'setOscillating') return call('oscillate', { oscillating: Boolean(args.oscillating) })
      return null

    case 'climate': {
      if (command === 'setTargetTemperature') return call('set_temperature', { temperature: Number(args.celsius) })
      if (command === 'setPreset') return call('set_preset_mode', { preset_mode: String(args.preset) })
      if (command === 'setHvacMode') {
        let mode = String(args.mode)
        // Sway says "auto" for "keep it comfortable"; HA splits that into heat_cool (two
        // set points) and auto (the device decides). Use whichever the device offers.
        const offered = Array.isArray(current?.attributes.hvac_modes) ? (current!.attributes.hvac_modes as string[]) : []
        if (mode === 'auto' && !offered.includes('auto') && offered.includes('heat_cool')) mode = 'heat_cool'
        return call('set_hvac_mode', { hvac_mode: mode })
      }
      return null
    }

    case 'lock':
      if (command === 'lock') return call('lock')
      if (command === 'unlock') return call('unlock')
      return null

    case 'media_player': {
      const transport: Record<string, string> = { play: 'media_play', pause: 'media_pause', stopPlayback: 'media_stop', next: 'media_next_track', previous: 'media_previous_track' }
      if (transport[command]) return call(transport[command])
      if (command === 'setVolume') return call('volume_set', { volume_level: round(Number(args.volume) / 100, 2) })
      if (command === 'stepVolume') {
        const level = number(current?.attributes.volume_level) ?? 0.5
        return call('volume_set', { volume_level: round(Math.min(1, Math.max(0, level + Number(args.delta) / 100)), 2) })
      }
      if (command === 'setMuted') return call('volume_mute', { is_volume_muted: Boolean(args.muted) })
      if (command === 'setSource') return call('select_source', { source: String(args.source) })
      if (command === 'seek') return call('media_seek', { seek_position: Number(args.positionSeconds) })
      return null
    }

    case 'vacuum': {
      const services: Record<string, string> = { startCleaning: 'start', pauseCleaning: 'pause', returnToDock: 'return_to_base', locateVacuum: 'locate' }
      return services[command] ? call(services[command]) : null
    }

    case 'siren':
      if (command === 'triggerSiren') return call('turn_on', typeof args.durationSeconds === 'number' ? { duration: args.durationSeconds } : {})
      if (command === 'silenceSiren') return call('turn_off')
      return null

    default:
      return null
  }
}
