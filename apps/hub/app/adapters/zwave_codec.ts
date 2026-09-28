/**
 * Z-Wave nodes, translated from the values Z-Wave JS reports.
 *
 * zwave-js-server describes each node as a flat list of values - command class, endpoint,
 * property, optional property key, the value and its metadata. Pure functions here turn that
 * list into Sway capabilities and state, and a Sway command into the one value to write.
 *
 * Command classes used (numbers from the Z-Wave specification):
 *   37 Binary Switch   38 Multilevel Switch (0..99, 255 = restore)   48 Binary Sensor
 *   49 Multilevel Sensor   50 Meter   64 Thermostat Mode   66 Thermostat Operating State
 *   67 Thermostat Setpoint   98 Door Lock (255 = secured)   113 Notification   128 Battery
 * Values: https://zwave-js.github.io/zwave-js/#/api/valueid
 */

import { fahrenheitToCelsius, type CapabilityId, type DeviceCategory, type DiscoveredDevice } from '@sway-home/shared'

export interface ZwaveValue {
  commandClass: number
  endpoint?: number
  property: string | number
  propertyKey?: string | number
  value?: unknown
  metadata?: { readable?: boolean; writeable?: boolean; unit?: string; states?: Record<string, string>; label?: string; min?: number; max?: number }
}

export interface ZwaveNode {
  nodeId: number
  name?: string
  location?: string
  /** Unknown 0, Asleep 1, Awake 2, Dead 3, Alive 4. */
  status?: number
  ready?: boolean
  isControllerNode?: boolean
  deviceClass?: { generic?: { label?: string }; specific?: { label?: string } } | null
  deviceConfig?: { manufacturer?: string; label?: string; description?: string } | null
  manufacturerId?: number
  productId?: number
  firmwareVersion?: string
  values: ZwaveValue[]
}

export interface ValueId {
  commandClass: number
  endpoint: number
  property: string | number
  propertyKey?: string | number
}

const CC = {
  binarySwitch: 37,
  multilevelSwitch: 38,
  binarySensor: 48,
  multilevelSensor: 49,
  meter: 50,
  thermostatMode: 64,
  thermostatOperatingState: 66,
  thermostatSetpoint: 67,
  doorLock: 98,
  notification: 113,
  battery: 128,
} as const

/** The order capabilities are listed in, whatever order the node reports its values. */
const ORDER: CapabilityId[] = ['onoff', 'brightness', 'position', 'lock', 'thermostat', 'siren', 'temperature', 'humidity', 'illuminance', 'pressure', 'contact', 'motion', 'waterLeak', 'smoke', 'carbonMonoxide', 'power', 'energy', 'battery']

function endpointOf(value: ZwaveValue): number {
  return value.endpoint ?? 0
}

function find(node: ZwaveNode, commandClass: number, property: string | number, endpoint?: number): ZwaveValue | undefined {
  return node.values.find((value) => value.commandClass === commandClass && value.property === property && (endpoint === undefined || endpointOf(value) === endpoint))
}

function isMotor(node: ZwaveNode): boolean {
  return /motor|window covering|blind|shutter/i.test(`${node.deviceClass?.specific?.label ?? ''} ${node.deviceClass?.generic?.label ?? ''}`)
}

function isSiren(node: ZwaveNode): boolean {
  return /siren|sound switch/i.test(`${node.deviceClass?.generic?.label ?? ''} ${node.deviceClass?.specific?.label ?? ''}`)
}

/** The endpoints carrying a switch, when there is more than one: one Sway endpoint each. */
function channels(node: ZwaveNode): number[] {
  const endpoints = new Set(
    node.values
      .filter((value) => (value.commandClass === CC.binarySwitch || value.commandClass === CC.multilevelSwitch) && value.property === 'targetValue' && endpointOf(value) > 0)
      .map(endpointOf)
  )
  return [...endpoints].sort((a, b) => a - b)
}

function celsius(value: number, unit: string | undefined): number {
  return unit === '°F' ? Math.round(fahrenheitToCelsius(value) * 10) / 10 : value
}

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

export interface ZwaveReading {
  state: Record<string, unknown>
  endpoints: Record<number, Record<string, unknown>>
  capabilities: CapabilityId[]
}

/** A notification variable's event number, as the state it means. */
function notificationState(type: string, variable: string, event: number): Record<string, unknown> | null {
  const key = `${type}/${variable}`.toLowerCase()
  if (key === 'home security/motion sensor status') return { motion: event === 7 || event === 8 }
  if (key === 'access control/door state') return event === 22 ? { open: true } : event === 23 ? { open: false } : null
  if (key === 'water alarm/sensor status') return { leak: event === 1 || event === 2 }
  if (key === 'smoke alarm/sensor status') return { smoke: event === 1 || event === 2 }
  if (key === 'co alarm/sensor status') return { co: event === 1 || event === 2 }
  return null
}

const NOTIFICATION_CAPABILITY: Record<string, CapabilityId> = { motion: 'motion', open: 'contact', leak: 'waterLeak', smoke: 'smoke', co: 'carbonMonoxide' }

function switchState(node: ZwaveNode, endpoint: number | undefined): Record<string, unknown> | null {
  const binary = find(node, CC.binarySwitch, 'currentValue', endpoint)
  if (binary && typeof binary.value === 'boolean') return { on: binary.value }
  const level = find(node, CC.multilevelSwitch, 'currentValue', endpoint)
  if (level && typeof level.value === 'number' && !isMotor(node)) {
    return { on: level.value > 0, brightness: level.value >= 99 ? 100 : level.value }
  }
  return null
}

export function nodeState(node: ZwaveNode): ZwaveReading {
  const state: Record<string, unknown> = {}
  const endpoints: Record<number, Record<string, unknown>> = {}
  const capabilities = new Set<CapabilityId>()
  const gangs = channels(node)
  const siren = isSiren(node)

  if (gangs.length > 1) {
    for (const endpoint of gangs) {
      const read = switchState(node, endpoint)
      if (read) endpoints[endpoint] = read
    }
    Object.assign(state, endpoints[gangs[0]!] ?? {})
    capabilities.add('onoff')
  }

  for (const value of node.values) {
    const v = value.value
    switch (value.commandClass) {
      case CC.binarySwitch:
        if (value.property === 'targetValue' || value.property === 'currentValue') capabilities.add(siren ? 'siren' : 'onoff')
        if (value.property === 'currentValue' && typeof v === 'boolean' && gangs.length <= 1) Object.assign(state, siren ? { sounding: v } : { on: v })
        break
      case CC.multilevelSwitch:
        if (isMotor(node)) {
          capabilities.add('position')
          if (value.property === 'currentValue' && typeof v === 'number') state.position = v >= 99 ? 100 : v
        } else if (value.property === 'targetValue' || value.property === 'currentValue') {
          capabilities.add('onoff')
          capabilities.add('brightness')
          if (value.property === 'currentValue' && typeof v === 'number' && gangs.length <= 1) Object.assign(state, switchState(node, endpointOf(value)))
        }
        break
      case CC.doorLock:
        if (value.property === 'currentMode' || value.property === 'targetMode') capabilities.add('lock')
        if (value.property === 'currentMode' && typeof v === 'number') state.locked = v === 255
        break
      case CC.multilevelSensor: {
        if (typeof v !== 'number') break
        const unit = value.metadata?.unit
        const type = String(value.property).toLowerCase()
        if (type === 'air temperature') {
          capabilities.add('temperature')
          state.temperature = celsius(v, unit)
          if (find(node, CC.thermostatSetpoint, 'setpoint')) state.currentTemperature = state.temperature
        } else if (type === 'humidity') {
          capabilities.add('humidity')
          state.humidity = v
        } else if (type === 'illuminance') {
          capabilities.add('illuminance')
          state.illuminance = v
        } else if (type === 'atmospheric pressure' || type === 'barometric pressure') {
          capabilities.add('pressure')
          state.pressure = unit === 'kPa' ? Math.round(v * 100) / 10 : v
        } else if (type === 'power') {
          capabilities.add('power')
          state.power = v
        }
        break
      }
      case CC.meter: {
        if (typeof v !== 'number') break
        const unit = value.metadata?.unit ?? ({ 65537: 'kWh', 66049: 'W', 66561: 'V', 66817: 'A' } as Record<number, string>)[Number(value.propertyKey)]
        if (unit === 'kWh') {
          capabilities.add('energy')
          state.energyTotal = v
        } else if (unit === 'W') {
          capabilities.add('power')
          state.power = v
        } else if (unit === 'V') state.voltage = v
        else if (unit === 'A') state.current = v
        break
      }
      case CC.thermostatSetpoint:
        if (value.property === 'setpoint' && Number(value.propertyKey ?? 1) === 1 && typeof v === 'number') {
          capabilities.add('thermostat')
          state.targetTemperature = celsius(v, value.metadata?.unit)
        }
        break
      case CC.thermostatMode:
        if (value.property === 'mode' && typeof v === 'number') {
          capabilities.add('thermostat')
          const label = (value.metadata?.states?.[String(v)] ?? '').toLowerCase()
          state.hvacMode = label === 'heat' ? 'heat' : label === 'cool' ? 'cool' : label === 'auto' ? 'auto' : label.includes('dry') ? 'dry' : label.includes('fan') ? 'fan_only' : label === 'off' ? 'off' : 'heat'
        }
        break
      case CC.thermostatOperatingState:
        if (value.property === 'state' && typeof v === 'number') state.hvacAction = v === 1 ? 'heating' : v === 2 ? 'cooling' : v === 3 ? 'fan' : 'idle'
        break
      case CC.notification: {
        if (typeof v !== 'number' || value.propertyKey === undefined) break
        const read = notificationState(String(value.property), String(value.propertyKey), v)
        if (!read) break
        Object.assign(state, read)
        for (const key of Object.keys(read)) capabilities.add(NOTIFICATION_CAPABILITY[key]!)
        break
      }
      case CC.binarySensor: {
        if (typeof v !== 'boolean') break
        const type = String(value.property).toLowerCase()
        const read: Record<string, unknown> | null = type.includes('door') || type.includes('window') ? { open: v } : type.includes('motion') ? { motion: v } : type.includes('water') ? { leak: v } : type.includes('smoke') ? { smoke: v } : type === 'co' ? { co: v } : null
        if (!read) break
        Object.assign(state, read)
        for (const key of Object.keys(read)) capabilities.add(NOTIFICATION_CAPABILITY[key]!)
        break
      }
      case CC.battery:
        if (value.property === 'level' && typeof v === 'number') {
          capabilities.add('battery')
          state.battery = v
          if (state.batteryLow === undefined) state.batteryLow = v <= 20
        }
        if (value.property === 'isLow' && typeof v === 'boolean') {
          capabilities.add('battery')
          state.batteryLow = v
        }
        break
    }
  }

  return { state, endpoints, capabilities: ORDER.filter((id) => capabilities.has(id)) }
}

// ---------------------------------------------------------------------------------------
// The node as a device
// ---------------------------------------------------------------------------------------

export function nodeDevice(node: ZwaveNode, homeId: number): DiscoveredDevice | null {
  if (node.isControllerNode) return null
  const { capabilities } = nodeState(node)
  if (capabilities.length === 0) return null

  const gangs = channels(node)
  const has = (id: CapabilityId) => capabilities.includes(id)
  const category: DeviceCategory = has('lock')
    ? 'lock'
    : has('thermostat')
      ? 'climate'
      : has('position')
        ? 'cover'
        : has('siren')
          ? 'appliance'
          : has('brightness')
            ? 'light'
            : has('onoff')
              ? has('power') || has('energy') ? 'outlet' : 'switch'
              : 'sensor'

  const description = node.deviceConfig?.description ?? node.deviceConfig?.label ?? 'Appareil Z-Wave'
  return {
    adapterId: 'zwave',
    nativeId: String(node.nodeId),
    uid: `zwave:${homeId}:${node.nodeId}`,
    name: node.name?.trim() || `${description} (nœud ${node.nodeId})`,
    category,
    capabilities,
    transport: 'zwave',
    manufacturer: node.deviceConfig?.manufacturer ?? null,
    model: node.deviceConfig?.label ?? null,
    firmwareVersion: node.firmwareVersion ?? null,
    confidence: 0.97,
    ...(gangs.length > 1
      ? { endpoints: gangs.map((endpoint) => ({ index: endpoint, name: `Canal ${endpoint}`, category: 'switch' as DeviceCategory, capabilities: ['onoff'] as CapabilityId[] })) }
      : {}),
    meta: { nodeId: node.nodeId, location: node.location || null },
  }
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

function target(node: ZwaveNode, commandClass: number, property: string | number, endpoint?: number): ValueId | null {
  const candidates = node.values.filter((value) => value.commandClass === commandClass && value.property === property && value.metadata?.writeable !== false)
  const chosen = endpoint !== undefined ? candidates.find((value) => endpointOf(value) === endpoint) : [...candidates].sort((a, b) => endpointOf(a) - endpointOf(b))[0]
  if (!chosen) return null
  return { commandClass, endpoint: endpointOf(chosen), property, ...(chosen.propertyKey !== undefined ? { propertyKey: chosen.propertyKey } : {}) }
}

export function setValueFor(node: ZwaveNode, command: string, args: Record<string, unknown>, endpointIndex?: number): { valueId: ValueId; value: unknown } | null {
  const write = (valueId: ValueId | null, value: unknown) => (valueId ? { valueId, value } : null)
  const binary = target(node, CC.binarySwitch, 'targetValue', endpointIndex)
  const level = isMotor(node) ? null : target(node, CC.multilevelSwitch, 'targetValue', endpointIndex)
  const motor = isMotor(node) ? target(node, CC.multilevelSwitch, 'targetValue') : null

  switch (command) {
    case 'turnOn':
      return isSiren(node) ? null : binary ? write(binary, true) : write(level, 255)
    case 'turnOff':
      return isSiren(node) ? null : binary ? write(binary, false) : write(level, 0)
    case 'setBrightness': {
      const percent = Math.round(Number(args.brightness))
      return write(level, Math.min(99, Math.max(0, percent)))
    }
    case 'triggerSiren':
      return isSiren(node) ? write(binary, true) : null
    case 'silenceSiren':
      return isSiren(node) ? write(binary, false) : null
    case 'open':
      return write(motor, 99)
    case 'close':
      return write(motor, 0)
    case 'setPosition':
      return write(motor, Math.min(99, Math.max(0, Math.round(Number(args.position)))))
    case 'stop':
      return motor ? write(target(node, CC.multilevelSwitch, 'Up'), false) : null
    case 'lock':
      return write(target(node, CC.doorLock, 'targetMode'), 255)
    case 'unlock':
      return write(target(node, CC.doorLock, 'targetMode'), 0)
    case 'setTargetTemperature': {
      const setpoint = node.values.find((value) => value.commandClass === CC.thermostatSetpoint && value.property === 'setpoint' && Number(value.propertyKey ?? 1) === 1)
      if (!setpoint) return null
      const wanted = Number(args.celsius)
      const inUnit = setpoint.metadata?.unit === '°F' ? Math.round((wanted * 9) / 5 + 32) : wanted
      return { valueId: { commandClass: CC.thermostatSetpoint, endpoint: endpointOf(setpoint), property: 'setpoint', propertyKey: setpoint.propertyKey ?? 1 }, value: inUnit }
    }
    case 'setHvacMode': {
      const mode = node.values.find((value) => value.commandClass === CC.thermostatMode && value.property === 'mode')
      if (!mode?.metadata?.states) return null
      const wanted = String(args.mode)
      const label = wanted === 'fan_only' ? 'fan only' : wanted
      const entry = Object.entries(mode.metadata.states).find(([, name]) => name.toLowerCase() === label)
      return entry ? { valueId: { commandClass: CC.thermostatMode, endpoint: endpointOf(mode), property: 'mode' }, value: Number(entry[0]) } : null
    }
    default:
      return null
  }
}
