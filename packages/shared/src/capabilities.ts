/**
 * The capability vocabulary.
 *
 * A device is not "a Hue bulb" or "a Shelly relay" to the rest of the system: it is a set
 * of capabilities. An adapter's whole job is to map a vendor protocol onto this list, and
 * everything above it (automations, the agent, the UI, the mobile app later) is written
 * against the list and never against a vendor.
 *
 * The list is deliberately close to Matter's cluster model, because Matter is the target
 * everything else is converging on. Where a capability exists in Matter, the cluster id is
 * recorded next to it so the Matter adapter is a lookup rather than a translation layer,
 * and so a future hub firmware can expose Sway devices *as* Matter devices ("bridge mode")
 * without a second vocabulary.
 */

import { z } from 'zod'
import { UNITS, type Unit } from './units.ts'

export const CAPABILITY_KINDS = [
  'actuator',
  'sensor',
  'climate',
  'access',
  'media',
  'security',
  'energy',
  'appliance',
  'meta',
] as const
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number]

/** Matter cluster ids, for the capabilities that have one. */
export const MATTER_CLUSTER = {
  identify: 0x0003,
  groups: 0x0004,
  scenes: 0x0062,
  onOff: 0x0006,
  levelControl: 0x0008,
  colorControl: 0x0300,
  doorLock: 0x0101,
  windowCovering: 0x0102,
  thermostat: 0x0201,
  fanControl: 0x0202,
  temperatureMeasurement: 0x0402,
  pressureMeasurement: 0x0403,
  flowMeasurement: 0x0404,
  relativeHumidityMeasurement: 0x0405,
  illuminanceMeasurement: 0x0400,
  occupancySensing: 0x0406,
  booleanState: 0x0045,
  smokeCoAlarm: 0x005c,
  airQuality: 0x005b,
  carbonDioxideConcentration: 0x040d,
  pm25Concentration: 0x042a,
  totalVolatileOrganicCompoundsConcentration: 0x042e,
  powerSource: 0x002f,
  electricalPowerMeasurement: 0x0090,
  electricalEnergyMeasurement: 0x0091,
  valveConfigurationAndControl: 0x0081,
  mediaPlayback: 0x0506,
  levelControlForSound: 0x0508,
  mediaInput: 0x0507,
  rvcRunMode: 0x0061,
  switchCluster: 0x003b,
  thermostatUserInterfaceConfiguration: 0x0204,
  temperatureControl: 0x0056,
  operationalState: 0x0060,
  laundryWasherMode: 0x0051,
  refrigeratorAndTemperatureControlledCabinetMode: 0x0052,
  dishwasherMode: 0x0059,
  microwaveOvenMode: 0x005e,
  ovenCavityOperationalState: 0x0048,
} as const

// ---------------------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------------------

const transition = z
  .object({ transitionMs: z.number().int().min(0).max(3_600_000).optional() })
  .describe('Optional fade time in milliseconds. Adapters that cannot fade ignore it.')

const noArgs = z.object({}).describe('No arguments.')

// ---------------------------------------------------------------------------------------
// Capability specs
// ---------------------------------------------------------------------------------------

export interface CapabilitySpec<TState extends z.ZodType = z.ZodType> {
  id: string
  kind: CapabilityKind
  /** One sentence, written for the agent's system prompt as much as for a developer. */
  description: string
  /** Shape of the state this capability contributes to a device's state object. */
  state: TState
  /** Commands the capability accepts, with their argument schema. */
  commands: Record<string, z.ZodType>
  unit?: Unit
  range?: [number, number]
  matterCluster?: number
  /** True when the capability only ever reports; the agent must not try to command it. */
  readOnly?: boolean
  /** Capability ids that must be present for this one to make sense. */
  requires?: string[]
}

function spec<T extends z.ZodType>(s: CapabilitySpec<T>): CapabilitySpec<T> {
  return s
}

export const CAPABILITIES = {
  // ---- actuators ----------------------------------------------------------------------
  onoff: spec({
    id: 'onoff',
    kind: 'actuator',
    description: 'Can be switched on or off.',
    state: z.object({ on: z.boolean() }),
    commands: {
      turnOn: transition,
      turnOff: transition,
      toggle: noArgs,
    },
    matterCluster: MATTER_CLUSTER.onOff,
  }),

  brightness: spec({
    id: 'brightness',
    kind: 'actuator',
    description: 'Dimmable, 0 to 100 percent.',
    state: z.object({ brightness: z.number().min(0).max(100) }),
    commands: {
      setBrightness: transition.extend({ brightness: z.number().min(0).max(100) }),
      stepBrightness: transition.extend({ delta: z.number().min(-100).max(100) }),
    },
    unit: UNITS.percent,
    range: [0, 100],
    matterCluster: MATTER_CLUSTER.levelControl,
    requires: ['onoff'],
  }),

  colorTemperature: spec({
    id: 'colorTemperature',
    kind: 'actuator',
    description: 'White colour temperature in kelvin. Lower is warmer.',
    state: z.object({
      colorTemperature: z.number().min(1000).max(10000),
      colorTemperatureRange: z.tuple([z.number(), z.number()]).optional(),
    }),
    commands: {
      setColorTemperature: transition.extend({ kelvin: z.number().min(1000).max(10000) }),
    },
    unit: UNITS.kelvin,
    range: [2000, 6500],
    matterCluster: MATTER_CLUSTER.colorControl,
    requires: ['onoff'],
  }),

  color: spec({
    id: 'color',
    kind: 'actuator',
    description: 'Full colour, expressed as hue in degrees plus saturation in percent.',
    state: z.object({
      hue: z.number().min(0).max(360),
      saturation: z.number().min(0).max(100),
    }),
    commands: {
      setColor: transition.extend({
        hue: z.number().min(0).max(360),
        saturation: z.number().min(0).max(100),
      }),
      setColorRgb: transition.extend({
        r: z.number().int().min(0).max(255),
        g: z.number().int().min(0).max(255),
        b: z.number().int().min(0).max(255),
      }),
      setColorName: transition.extend({ name: z.string().min(2).max(40) }),
    },
    matterCluster: MATTER_CLUSTER.colorControl,
    requires: ['onoff'],
  }),

  effect: spec({
    id: 'effect',
    kind: 'actuator',
    description: 'Named light effect or animation, for strips and panels that carry one.',
    state: z.object({
      effect: z.string().nullable(),
      availableEffects: z.array(z.string()).default([]),
    }),
    commands: {
      setEffect: z.object({ effect: z.string(), speed: z.number().min(0).max(100).optional() }),
      clearEffect: noArgs,
    },
    requires: ['onoff'],
  }),

  position: spec({
    id: 'position',
    kind: 'actuator',
    description: 'Blind, curtain, shutter or awning position. 0 is fully closed, 100 fully open.',
    state: z.object({
      position: z.number().min(0).max(100),
      moving: z.enum(['opening', 'closing', 'idle']).default('idle'),
    }),
    commands: {
      open: noArgs,
      close: noArgs,
      stop: noArgs,
      setPosition: z.object({ position: z.number().min(0).max(100) }),
    },
    unit: UNITS.percent,
    range: [0, 100],
    matterCluster: MATTER_CLUSTER.windowCovering,
  }),

  tilt: spec({
    id: 'tilt',
    kind: 'actuator',
    description: 'Slat tilt angle for venetian blinds, 0 to 100 percent.',
    state: z.object({ tilt: z.number().min(0).max(100) }),
    commands: { setTilt: z.object({ tilt: z.number().min(0).max(100) }) },
    unit: UNITS.percent,
    range: [0, 100],
    matterCluster: MATTER_CLUSTER.windowCovering,
    requires: ['position'],
  }),

  fan: spec({
    id: 'fan',
    kind: 'climate',
    description: 'Fan speed and mode.',
    state: z.object({
      fanSpeed: z.number().min(0).max(100),
      fanMode: z.enum(['off', 'low', 'medium', 'high', 'auto', 'quiet', 'boost']).default('auto'),
      oscillating: z.boolean().optional(),
    }),
    commands: {
      setFanSpeed: z.object({ speed: z.number().min(0).max(100) }),
      setFanMode: z.object({ mode: z.enum(['off', 'low', 'medium', 'high', 'auto', 'quiet', 'boost']) }),
      setOscillating: z.object({ oscillating: z.boolean() }),
    },
    unit: UNITS.percent,
    range: [0, 100],
    matterCluster: MATTER_CLUSTER.fanControl,
  }),

  valve: spec({
    id: 'valve',
    kind: 'actuator',
    description: 'Water or gas valve that opens and closes.',
    state: z.object({ valveOpen: z.boolean(), valveLevel: z.number().min(0).max(100).optional() }),
    commands: {
      openValve: z.object({ level: z.number().min(0).max(100).optional() }),
      closeValve: noArgs,
    },
    matterCluster: MATTER_CLUSTER.valveConfigurationAndControl,
  }),

  siren: spec({
    id: 'siren',
    kind: 'security',
    description: 'Audible or visual alarm that can be triggered.',
    state: z.object({ sounding: z.boolean() }),
    commands: {
      triggerSiren: z.object({ durationSeconds: z.number().int().min(1).max(900).optional() }),
      silenceSiren: noArgs,
    },
  }),

  // ---- climate ------------------------------------------------------------------------
  thermostat: spec({
    id: 'thermostat',
    kind: 'climate',
    description: 'Heating and/or cooling set point with a mode.',
    state: z.object({
      targetTemperature: z.number().min(-20).max(60),
      currentTemperature: z.number().min(-60).max(100).optional(),
      hvacMode: z.enum(['off', 'heat', 'cool', 'auto', 'dry', 'fan_only']),
      hvacAction: z.enum(['idle', 'heating', 'cooling', 'drying', 'fan', 'off']).optional(),
      targetTemperatureRange: z.tuple([z.number(), z.number()]).optional(),
      preset: z.string().nullable().optional(),
    }),
    commands: {
      setTargetTemperature: z.object({ celsius: z.number().min(-20).max(60) }),
      setHvacMode: z.object({ mode: z.enum(['off', 'heat', 'cool', 'auto', 'dry', 'fan_only']) }),
      setPreset: z.object({ preset: z.string() }),
      boost: z.object({ minutes: z.number().int().min(5).max(480).default(60) }),
    },
    unit: UNITS.celsius,
    matterCluster: MATTER_CLUSTER.thermostat,
  }),

  // ---- access -------------------------------------------------------------------------
  lock: spec({
    id: 'lock',
    kind: 'access',
    description: 'Door lock. Unlocking is a sensitive action and always needs confirmation.',
    state: z.object({
      locked: z.boolean(),
      jammed: z.boolean().default(false),
      lastActor: z.string().nullable().optional(),
    }),
    commands: {
      lock: noArgs,
      unlock: z.object({ reason: z.string().max(200).optional() }),
    },
    matterCluster: MATTER_CLUSTER.doorLock,
  }),

  garage: spec({
    id: 'garage',
    kind: 'access',
    description: 'Garage or gate door.',
    state: z.object({ doorState: z.enum(['open', 'closed', 'opening', 'closing', 'stopped']) }),
    commands: { openDoor: noArgs, closeDoor: noArgs, stopDoor: noArgs },
  }),

  // ---- sensors ------------------------------------------------------------------------
  temperature: spec({
    id: 'temperature',
    kind: 'sensor',
    description: 'Measured air temperature.',
    state: z.object({ temperature: z.number().min(-60).max(150) }),
    commands: {},
    unit: UNITS.celsius,
    matterCluster: MATTER_CLUSTER.temperatureMeasurement,
    readOnly: true,
  }),

  humidity: spec({
    id: 'humidity',
    kind: 'sensor',
    description: 'Measured relative humidity.',
    state: z.object({ humidity: z.number().min(0).max(100) }),
    commands: {},
    unit: UNITS.percent,
    range: [0, 100],
    matterCluster: MATTER_CLUSTER.relativeHumidityMeasurement,
    readOnly: true,
  }),

  illuminance: spec({
    id: 'illuminance',
    kind: 'sensor',
    description: 'Measured ambient light level.',
    state: z.object({ illuminance: z.number().min(0) }),
    commands: {},
    unit: UNITS.lux,
    matterCluster: MATTER_CLUSTER.illuminanceMeasurement,
    readOnly: true,
  }),

  pressure: spec({
    id: 'pressure',
    kind: 'sensor',
    description: 'Barometric pressure.',
    state: z.object({ pressure: z.number().min(0) }),
    commands: {},
    unit: UNITS.hectopascal,
    matterCluster: MATTER_CLUSTER.pressureMeasurement,
    readOnly: true,
  }),

  motion: spec({
    id: 'motion',
    kind: 'sensor',
    description: 'Movement detected in the sensor field of view.',
    state: z.object({ motion: z.boolean(), lastMotionAt: z.iso.datetime().nullable().optional() }),
    commands: {},
    matterCluster: MATTER_CLUSTER.occupancySensing,
    readOnly: true,
  }),

  occupancy: spec({
    id: 'occupancy',
    kind: 'sensor',
    description: 'Room occupancy, held true while someone is present rather than only on movement.',
    state: z.object({ occupied: z.boolean() }),
    commands: {},
    matterCluster: MATTER_CLUSTER.occupancySensing,
    readOnly: true,
  }),

  contact: spec({
    id: 'contact',
    kind: 'security',
    description: 'Door or window open/closed contact.',
    state: z.object({ open: z.boolean(), lastChangedAt: z.iso.datetime().nullable().optional() }),
    commands: {},
    matterCluster: MATTER_CLUSTER.booleanState,
    readOnly: true,
  }),

  waterLeak: spec({
    id: 'waterLeak',
    kind: 'security',
    description: 'Water leak detected.',
    state: z.object({ leak: z.boolean() }),
    commands: {},
    matterCluster: MATTER_CLUSTER.booleanState,
    readOnly: true,
  }),

  smoke: spec({
    id: 'smoke',
    kind: 'security',
    description: 'Smoke alarm state.',
    state: z.object({ smoke: z.boolean(), testing: z.boolean().default(false) }),
    commands: {},
    matterCluster: MATTER_CLUSTER.smokeCoAlarm,
    readOnly: true,
  }),

  carbonMonoxide: spec({
    id: 'carbonMonoxide',
    kind: 'security',
    description: 'Carbon monoxide alarm state.',
    state: z.object({ co: z.boolean(), coPpm: z.number().min(0).optional() }),
    commands: {},
    unit: UNITS.ppm,
    matterCluster: MATTER_CLUSTER.smokeCoAlarm,
    readOnly: true,
  }),

  airQuality: spec({
    id: 'airQuality',
    kind: 'sensor',
    description: 'Aggregated indoor air quality plus the readings behind it.',
    state: z.object({
      airQuality: z.enum(['unknown', 'good', 'fair', 'moderate', 'poor', 'very_poor', 'extremely_poor']),
      co2: z.number().min(0).optional(),
      pm25: z.number().min(0).optional(),
      pm10: z.number().min(0).optional(),
      voc: z.number().min(0).optional(),
    }),
    commands: {},
    matterCluster: MATTER_CLUSTER.airQuality,
    readOnly: true,
  }),

  button: spec({
    id: 'button',
    kind: 'sensor',
    description: 'Physical button or scene controller. Reports presses rather than a level.',
    state: z.object({
      lastEvent: z.enum(['single', 'double', 'triple', 'hold', 'release', 'rotate_left', 'rotate_right']).nullable(),
      lastEventAt: z.iso.datetime().nullable(),
      buttonIndex: z.number().int().min(0).default(0),
    }),
    commands: {},
    matterCluster: MATTER_CLUSTER.switchCluster,
    readOnly: true,
  }),

  presence: spec({
    id: 'presence',
    kind: 'sensor',
    description: 'A person or phone is home. Derived from network presence, geofence or mmWave.',
    state: z.object({
      home: z.boolean(),
      confidence: z.number().min(0).max(1).default(1),
      source: z.enum(['network', 'geofence', 'mmwave', 'bluetooth', 'manual']).default('network'),
    }),
    commands: { setPresence: z.object({ home: z.boolean() }) },
  }),

  // ---- energy -------------------------------------------------------------------------
  power: spec({
    id: 'power',
    kind: 'energy',
    description: 'Instantaneous electrical power draw.',
    state: z.object({
      power: z.number(),
      voltage: z.number().optional(),
      current: z.number().optional(),
      powerFactor: z.number().min(-1).max(1).optional(),
    }),
    commands: {},
    unit: UNITS.watt,
    matterCluster: MATTER_CLUSTER.electricalPowerMeasurement,
    readOnly: true,
  }),

  energy: spec({
    id: 'energy',
    kind: 'energy',
    description: 'Cumulative energy meter.',
    state: z.object({
      energyTotal: z.number().min(0),
      energyToday: z.number().min(0).optional(),
      energyReturned: z.number().min(0).optional(),
    }),
    commands: { resetEnergy: noArgs },
    unit: UNITS.kilowattHour,
    matterCluster: MATTER_CLUSTER.electricalEnergyMeasurement,
  }),

  battery: spec({
    id: 'battery',
    kind: 'meta',
    description: 'Battery level of a wireless device.',
    state: z.object({
      battery: z.number().min(0).max(100),
      charging: z.boolean().optional(),
      batteryLow: z.boolean().default(false),
    }),
    commands: {},
    unit: UNITS.percent,
    range: [0, 100],
    matterCluster: MATTER_CLUSTER.powerSource,
    readOnly: true,
  }),

  // ---- media --------------------------------------------------------------------------
  mediaPlayback: spec({
    id: 'mediaPlayback',
    kind: 'media',
    description: 'Transport controls and what is currently playing.',
    state: z.object({
      playback: z.enum(['playing', 'paused', 'stopped', 'buffering', 'idle']),
      title: z.string().nullable().optional(),
      artist: z.string().nullable().optional(),
      album: z.string().nullable().optional(),
      artworkUrl: z.string().nullable().optional(),
      durationSeconds: z.number().min(0).nullable().optional(),
      positionSeconds: z.number().min(0).nullable().optional(),
      app: z.string().nullable().optional(),
    }),
    commands: {
      play: noArgs,
      pause: noArgs,
      stopPlayback: noArgs,
      next: noArgs,
      previous: noArgs,
      seek: z.object({ positionSeconds: z.number().min(0) }),
      playMedia: z.object({ query: z.string(), kind: z.enum(['track', 'album', 'playlist', 'radio', 'url']).optional() }),
    },
    matterCluster: MATTER_CLUSTER.mediaPlayback,
  }),

  volume: spec({
    id: 'volume',
    kind: 'media',
    description: 'Output volume and mute.',
    state: z.object({ volume: z.number().min(0).max(100), muted: z.boolean() }),
    commands: {
      setVolume: z.object({ volume: z.number().min(0).max(100) }),
      stepVolume: z.object({ delta: z.number().min(-100).max(100) }),
      setMuted: z.object({ muted: z.boolean() }),
    },
    unit: UNITS.percent,
    range: [0, 100],
    matterCluster: MATTER_CLUSTER.levelControlForSound,
  }),

  mediaSource: spec({
    id: 'mediaSource',
    kind: 'media',
    description: 'Selected input or app on a TV, receiver or speaker.',
    state: z.object({ source: z.string().nullable(), availableSources: z.array(z.string()).default([]) }),
    commands: { setSource: z.object({ source: z.string() }) },
    matterCluster: MATTER_CLUSTER.mediaInput,
  }),

  speech: spec({
    id: 'speech',
    kind: 'media',
    description: 'Can speak a sentence out loud. The agent uses this to answer in a room.',
    state: z.object({ speaking: z.boolean().default(false) }),
    commands: {
      speak: z.object({
        text: z.string().min(1).max(1000),
        voice: z.string().optional(),
        volume: z.number().min(0).max(100).optional(),
      }),
    },
  }),

  camera: spec({
    id: 'camera',
    kind: 'security',
    description: 'Camera with a snapshot and a stream.',
    state: z.object({
      streaming: z.boolean().default(false),
      snapshotUrl: z.string().nullable().optional(),
      streamUrl: z.string().nullable().optional(),
      recording: z.boolean().default(false),
    }),
    commands: {
      snapshot: noArgs,
      startRecording: z.object({ seconds: z.number().int().min(1).max(600).optional() }),
      stopRecording: noArgs,
      ptz: z.object({ pan: z.number().min(-1).max(1).optional(), tilt: z.number().min(-1).max(1).optional(), zoom: z.number().min(0).max(1).optional() }),
    },
  }),

  doorbell: spec({
    id: 'doorbell',
    kind: 'security',
    description: 'Doorbell press events.',
    state: z.object({ lastRingAt: z.iso.datetime().nullable() }),
    commands: {},
    readOnly: true,
  }),

  // ---- appliances ---------------------------------------------------------------------
  vacuum: spec({
    id: 'vacuum',
    kind: 'appliance',
    description: 'Robot vacuum or mop.',
    state: z.object({
      vacuumState: z.enum(['docked', 'cleaning', 'returning', 'paused', 'error', 'idle']),
      fanPower: z.number().min(0).max(100).optional(),
      areas: z.array(z.string()).default([]),
    }),
    commands: {
      startCleaning: z.object({ area: z.string().optional() }),
      pauseCleaning: noArgs,
      returnToDock: noArgs,
      locateVacuum: noArgs,
    },
    matterCluster: MATTER_CLUSTER.rvcRunMode,
  }),

  appliance: spec({
    id: 'appliance',
    kind: 'appliance',
    description: 'Washer, dryer, dishwasher or oven with a program and a remaining time.',
    state: z.object({
      operationalState: z.enum(['stopped', 'running', 'paused', 'error', 'finished']),
      program: z.string().nullable().optional(),
      remainingSeconds: z.number().min(0).nullable().optional(),
      doorOpen: z.boolean().optional(),
    }),
    commands: {
      startProgram: z.object({ program: z.string().optional(), delayMinutes: z.number().int().min(0).max(1440).optional() }),
      pauseProgram: noArgs,
      stopProgram: noArgs,
    },
    matterCluster: MATTER_CLUSTER.operationalState,
  }),

  // ---- meta ---------------------------------------------------------------------------
  identify: spec({
    id: 'identify',
    kind: 'meta',
    description: 'Makes the device announce itself physically, so a human can find it in a room.',
    state: z.object({ identifying: z.boolean().default(false) }),
    commands: { identify: z.object({ seconds: z.number().int().min(1).max(60).default(5) }) },
    matterCluster: MATTER_CLUSTER.identify,
  }),

  firmware: spec({
    id: 'firmware',
    kind: 'meta',
    description: 'Firmware version and whether an update is waiting.',
    state: z.object({
      firmwareVersion: z.string().nullable(),
      updateAvailable: z.boolean().default(false),
      latestVersion: z.string().nullable().optional(),
    }),
    commands: { installUpdate: noArgs },
  }),

  connectivity: spec({
    id: 'connectivity',
    kind: 'meta',
    description: 'Link quality of the radio the device is on.',
    state: z.object({
      rssi: z.number().optional(),
      linkQuality: z.number().min(0).max(255).optional(),
      ssid: z.string().nullable().optional(),
    }),
    commands: {},
    readOnly: true,
  }),

  scene: spec({
    id: 'scene',
    kind: 'meta',
    description: 'A stored set of device states that can be recalled.',
    state: z.object({ activeScene: z.string().nullable() }),
    commands: {
      activateScene: z.object({ scene: z.string() }),
      storeScene: z.object({ scene: z.string() }),
    },
    matterCluster: MATTER_CLUSTER.scenes,
  }),

  notify: spec({
    id: 'notify',
    kind: 'meta',
    description: 'Can display or deliver a notification to a person.',
    state: z.object({}),
    commands: {
      notify: z.object({
        message: z.string().min(1).max(500),
        title: z.string().max(120).optional(),
        priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
      }),
    },
  }),
} as const satisfies Record<string, CapabilitySpec>

export type CapabilityId = keyof typeof CAPABILITIES
export const CAPABILITY_IDS = Object.keys(CAPABILITIES) as CapabilityId[]

export const capabilityIdSchema = z.enum(CAPABILITY_IDS as [CapabilityId, ...CapabilityId[]])

/** Every command name in the vocabulary, mapped back to the capability that owns it. */
export const COMMAND_OWNER: Record<string, CapabilityId> = Object.fromEntries(
  CAPABILITY_IDS.flatMap((capId) =>
    Object.keys(CAPABILITIES[capId].commands).map((command) => [command, capId] as const)
  )
)

export function isCapabilityId(value: string): value is CapabilityId {
  return value in CAPABILITIES
}

/** The state shape a device with these capabilities can report. */
export function stateSchemaFor(capabilities: readonly CapabilityId[]): z.ZodObject<z.ZodRawShape> {
  let shape: z.ZodRawShape = {}
  for (const id of capabilities) {
    const capState = CAPABILITIES[id].state
    if (capState instanceof z.ZodObject) {
      shape = { ...shape, ...(capState.shape as z.ZodRawShape) }
    }
  }
  return z.object(shape).partial()
}

/** Commands a device with these capabilities accepts. */
export function commandsFor(capabilities: readonly CapabilityId[]): Record<string, z.ZodType> {
  const commands: Record<string, z.ZodType> = {}
  for (const id of capabilities) {
    Object.assign(commands, CAPABILITIES[id].commands)
  }
  return commands
}

/**
 * A short, dense capability catalogue for the agent's system prompt. Kept as a function so
 * the prompt can never drift from the code: there is one list, and it is this one.
 */
export function capabilityCatalogueForPrompt(capabilities?: readonly CapabilityId[]): string {
  const ids = capabilities ?? CAPABILITY_IDS
  return ids
    .map((id) => {
      const cap = CAPABILITIES[id]
      const commands = Object.keys(cap.commands)
      const unit = cap.unit ? ` [${cap.unit}]` : ''
      const verbs = commands.length ? ` commands: ${commands.join(', ')}` : ' read-only'
      return `- ${id}${unit}: ${cap.description}${verbs}`
    })
    .join('\n')
}

export type AirQualityLevel = 'unknown' | 'good' | 'fair' | 'moderate' | 'poor' | 'very_poor' | 'extremely_poor'

const AIR_LEVELS: AirQualityLevel[] = ['good', 'fair', 'moderate', 'poor', 'very_poor']

/**
 * The `airQuality` level from the readings behind it, for sensors that only report CO2 or
 * fine particles. CO2 steps follow the usual ventilation guidance (800 / 1000 / 1400 / 2000
 * ppm); PM2.5 steps follow the WHO interim targets. The worse of the two wins.
 */
export function airQualityFrom(readings: { co2?: number | null; pm25?: number | null }): AirQualityLevel {
  const levels: number[] = []
  const { co2, pm25 } = readings
  if (typeof co2 === 'number' && Number.isFinite(co2)) levels.push(co2 > 2000 ? 4 : co2 > 1400 ? 3 : co2 > 1000 ? 2 : co2 > 800 ? 1 : 0)
  if (typeof pm25 === 'number' && Number.isFinite(pm25)) levels.push(pm25 > 55 ? 4 : pm25 > 35 ? 3 : pm25 > 20 ? 2 : pm25 > 12 ? 1 : 0)
  if (levels.length === 0) return 'unknown'
  return AIR_LEVELS[Math.max(...levels)]!
}
