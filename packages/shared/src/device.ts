/**
 * The device model.
 *
 * One physical thing is one `Device`. A thing that exposes several independent controls
 * (a two-gang switch, a power strip, a TV that is also a speaker) exposes several
 * `DeviceEndpoint`s, which is exactly Matter's endpoint model and maps cleanly onto
 * Zigbee endpoints, Shelly channels and Sonos groups.
 */

import { z } from 'zod'
import { capabilityIdSchema, type CapabilityId } from './capabilities.ts'

export const DEVICE_CATEGORIES = [
  'light',
  'switch',
  'outlet',
  'sensor',
  'climate',
  'cover',
  'lock',
  'camera',
  'media',
  'speaker',
  'display',
  'appliance',
  'vacuum',
  'energy',
  'network',
  'computer',
  'phone',
  'wearable',
  'vehicle',
  'hub',
  'printer',
  'gateway',
  'unknown',
] as const
export type DeviceCategory = (typeof DEVICE_CATEGORIES)[number]
export const deviceCategorySchema = z.enum(DEVICE_CATEGORIES)

export const TRANSPORTS = [
  'wifi',
  'ethernet',
  'matter',
  'thread',
  'zigbee',
  'zwave',
  'bluetooth',
  'ble',
  'mqtt',
  'cloud',
  'infrared',
  'rf433',
  'knx',
  'modbus',
  'virtual',
  'unknown',
] as const
export type Transport = (typeof TRANSPORTS)[number]
export const transportSchema = z.enum(TRANSPORTS)

/**
 * How sure the hub is that it identified a device correctly. Discovery guesses; a working
 * adapter proves. The UI shows the difference, because a wrong guess that looks certain is
 * worse than an honest "probably".
 */
export const IDENTIFICATION_CONFIDENCE = ['confirmed', 'high', 'medium', 'low', 'guess'] as const
export type IdentificationConfidence = (typeof IDENTIFICATION_CONFIDENCE)[number]

export const deviceEndpointSchema = z.object({
  id: z.string(),
  index: z.number().int().min(0),
  name: z.string(),
  category: deviceCategorySchema,
  capabilities: z.array(capabilityIdSchema),
  state: z.record(z.string(), z.unknown()).default({}),
})
export type DeviceEndpoint = z.infer<typeof deviceEndpointSchema>

export const deviceSchema = z.object({
  id: z.string(),
  /**
   * Stable across IP changes and re-pairings. Built from the strongest identifier the
   * transport offers: Matter node id, Zigbee IEEE address, MAC, serial, then a hash of
   * (adapter, native id) as a last resort.
   */
  uid: z.string(),
  name: z.string(),
  /** What the human calls it out loud. Fed to the agent's entity resolver. */
  aliases: z.array(z.string()).default([]),
  category: deviceCategorySchema,
  capabilities: z.array(capabilityIdSchema),
  endpoints: z.array(deviceEndpointSchema).default([]),

  manufacturer: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  firmwareVersion: z.string().nullable().default(null),
  serialNumber: z.string().nullable().default(null),

  adapterId: z.string(),
  /** Whatever the adapter needs to address the device: IP, topic, node id, token. */
  nativeId: z.string(),
  transport: transportSchema,

  areaId: z.string().nullable().default(null),
  /** Devices the hub believes are the same physical object seen by two adapters. */
  linkedDeviceIds: z.array(z.string()).default([]),

  online: z.boolean().default(false),
  reachableVia: z.enum(['lan', 'cloud', 'radio', 'bridge', 'virtual']).default('lan'),
  lastSeenAt: z.iso.datetime().nullable().default(null),
  state: z.record(z.string(), z.unknown()).default({}),

  identificationConfidence: z.enum(IDENTIFICATION_CONFIDENCE).default('guess'),
  /** Free-form notes the agent may read: "the one above the sink". */
  notes: z.string().nullable().default(null),
  favourite: z.boolean().default(false),
  hidden: z.boolean().default(false),
  /** Devices flagged critical never get touched by autonomous mode without confirmation. */
  critical: z.boolean().default(false),

  network: z
    .object({
      ip: z.string().nullable().default(null),
      mac: z.string().nullable().default(null),
      hostname: z.string().nullable().default(null),
      macVendor: z.string().nullable().default(null),
      openPorts: z.array(z.number().int()).default([]),
      mdnsServices: z.array(z.string()).default([]),
      randomisedMac: z.boolean().default(false),
    })
    .default({
      ip: null,
      mac: null,
      hostname: null,
      macVendor: null,
      openPorts: [],
      mdnsServices: [],
      randomisedMac: false,
    }),

  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type Device = z.infer<typeof deviceSchema>

// ---------------------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------------------

export const AREA_KINDS = [
  'living_room',
  'kitchen',
  'bedroom',
  'bathroom',
  'office',
  'hallway',
  'entrance',
  'garage',
  'garden',
  'balcony',
  'basement',
  'attic',
  'laundry',
  'dining_room',
  'kids_room',
  'guest_room',
  'other',
] as const
export type AreaKind = (typeof AREA_KINDS)[number]

export const areaSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(AREA_KINDS).default('other'),
  floorId: z.string().nullable().default(null),
  icon: z.string().nullable().default(null),
  /** Optional floor-plan polygon, so the UI can draw a real map rather than a grid. */
  polygon: z.array(z.tuple([z.number(), z.number()])).nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type Area = z.infer<typeof areaSchema>

export const floorSchema = z.object({
  id: z.string(),
  name: z.string(),
  level: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type Floor = z.infer<typeof floorSchema>

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

export const deviceCommandSchema = z.object({
  deviceId: z.string(),
  endpointId: z.string().optional(),
  command: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  /** Who asked: a human, a routine, the agent on its own, or a device. */
  origin: z.enum(['user', 'automation', 'agent', 'device', 'schedule', 'api']).default('user'),
  originDetail: z.string().optional(),
  /** Set by the agent when it acted without being asked; used by the undo stack. */
  reversible: z.boolean().default(true),
})
export type DeviceCommand = z.infer<typeof deviceCommandSchema>

export const commandResultSchema = z.object({
  ok: z.boolean(),
  deviceId: z.string(),
  command: z.string(),
  error: z.string().optional(),
  /** State the adapter observed after the command, when it can read it back. */
  state: z.record(z.string(), z.unknown()).optional(),
  latencyMs: z.number().optional(),
  /** Enough to put the device back the way it was. */
  undo: z
    .object({ command: z.string(), args: z.record(z.string(), z.unknown()) })
    .nullable()
    .optional(),
})
export type CommandResult = z.infer<typeof commandResultSchema>

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

/** Capabilities of the device itself plus every endpoint, de-duplicated. */
export function allCapabilities(device: Pick<Device, 'capabilities' | 'endpoints'>): CapabilityId[] {
  const set = new Set<CapabilityId>(device.capabilities)
  for (const endpoint of device.endpoints) {
    for (const capability of endpoint.capabilities) set.add(capability)
  }
  return [...set]
}

export function hasCapability(device: Pick<Device, 'capabilities' | 'endpoints'>, capability: CapabilityId): boolean {
  return allCapabilities(device).includes(capability)
}

/**
 * A MAC whose second least-significant bit of the first octet is set is locally
 * administered: a privacy-randomised address. Treat it as a weak identifier, because it
 * changes and will otherwise create a new "device" every few days.
 */
export function isRandomisedMac(mac: string): boolean {
  const first = Number.parseInt(mac.replace(/[^0-9a-f]/gi, '').slice(0, 2), 16)
  return Number.isFinite(first) && (first & 0b10) !== 0
}

export function normaliseMac(mac: string): string {
  const hex = mac.replace(/[^0-9a-f]/gi, '').toLowerCase()
  return hex.length === 12 ? (hex.match(/.{2}/g) ?? []).join(':') : mac.toLowerCase()
}
