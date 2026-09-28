/**
 * The fixture every hub suite starts from.
 *
 * One in-memory database per test file, migrated from scratch, seeded with a small but
 * realistic house: two rooms, a light, a thermostat, a motion sensor, a leak sensor and a
 * lock. Realistic matters - a fixture of three identical dummy devices passes tests that a
 * real house would fail, because half the logic branches on capability and category.
 */

import { closeDatabase, database, openDatabase } from '#db/database'
import { adapters } from '#services/adapter_manager'
import { runMigrations } from '#db/migrate'
import { deviceRepository } from '#repositories/device_repository'
import { places, settings } from '#repositories/store'
import type { CapabilityId, DeviceCategory } from '@sway-home/shared'

export interface TestHouse {
  areas: { salon: string; chambre: string }
  devices: {
    lamp: string
    thermostat: string
    motion: string
    leak: string
    lock: string
    plug: string
  }
}

/** Opens a fresh in-memory database and runs every migration against it. */
export async function freshDatabase(): Promise<void> {
  // bun test runs every file in one process, so the adapter registry and the database
  // handle are shared. Both are torn down here, or a suite inherits the previous file's
  // adapter instance and its commands vanish into an object nobody is asserting on.
  await adapters.reset()
  closeDatabase()
  await openDatabase(':memory:')
  await runMigrations({ silent: true })
}

export function dropDatabase(): void {
  closeDatabase()
}

interface DeviceSpec {
  nativeId: string
  name: string
  category: DeviceCategory
  capabilities: CapabilityId[]
  state?: Record<string, unknown>
  areaId?: string | null
  adapterId?: string
}

export function makeDevice(spec: DeviceSpec): string {
  const { device } = deviceRepository.upsertFromAdapter({
    adapterId: spec.adapterId ?? 'test',
    nativeId: spec.nativeId,
    uid: `${spec.adapterId ?? 'test'}:${spec.nativeId}`,
    name: spec.name,
    category: spec.category,
    capabilities: spec.capabilities,
    transport: 'virtual',
    state: spec.state ?? {},
    online: true,
  } as never)
  if (spec.areaId !== undefined) deviceRepository.update(device.id, { areaId: spec.areaId })
  // upsertFromAdapter registers the device; the state arrives separately, the way it does in
  // production when the adapter's first poll comes back. Merging it here means the fixture
  // looks like a device that has actually reported rather than one that was just declared.
  if (spec.state && Object.keys(spec.state).length > 0) deviceRepository.mergeState(device.id, spec.state, null)
  return device.id
}

/** A small house with the device kinds the engines actually branch on. */
export function seedHouse(): TestHouse {
  const salon = places.createArea({ name: 'Salon', kind: 'living_room' }).id
  const chambre = places.createArea({ name: 'Chambre', kind: 'bedroom' }).id

  settings.set('house.mode', 'home')
  settings.set('energy', { pricePerKwh: 0.2516, currency: 'EUR', contractKva: 9 })

  return {
    areas: { salon, chambre },
    devices: {
      lamp: makeDevice({
        nativeId: 'lamp',
        name: 'Plafonnier salon',
        category: 'light',
        capabilities: ['onoff', 'brightness', 'colorTemperature', 'power'],
        state: { on: false, brightness: 60, colorTemperature: 2700, power: 0 },
        areaId: salon,
      }),
      thermostat: makeDevice({
        nativeId: 'thermo',
        name: 'Thermostat salon',
        category: 'climate',
        capabilities: ['thermostat', 'temperature', 'humidity'],
        state: { currentTemperature: 19.5, targetTemperature: 20, hvacMode: 'heat', hvacAction: 'idle', temperature: 19.5, humidity: 45 },
        areaId: salon,
      }),
      motion: makeDevice({
        nativeId: 'motion',
        name: 'Détecteur chambre',
        category: 'sensor',
        capabilities: ['motion', 'illuminance', 'battery'],
        state: { motion: false, illuminance: 120, battery: 88 },
        areaId: chambre,
      }),
      leak: makeDevice({
        nativeId: 'leak',
        name: 'Détecteur de fuite',
        category: 'sensor',
        capabilities: ['waterLeak', 'battery'],
        state: { leak: false, battery: 75 },
        areaId: salon,
      }),
      lock: makeDevice({
        nativeId: 'lock',
        name: 'Serrure entrée',
        category: 'lock',
        capabilities: ['lock', 'battery'],
        state: { locked: true, battery: 60 },
        areaId: salon,
      }),
      plug: makeDevice({
        nativeId: 'plug',
        name: 'Prise bureau',
        category: 'outlet',
        capabilities: ['onoff', 'power', 'energy'],
        state: { on: true, power: 42, energy: 1.5 },
        areaId: chambre,
      }),
    },
  }
}

/** Writes a state history row directly, for the roll-up and chart tests. */
export function recordHistory(deviceId: string, attribute: string, value: number, at: Date): void {
  // id is an INTEGER AUTOINCREMENT column, so it is left for SQLite to assign.
  database().run(
    'INSERT INTO state_history (device_id, endpoint_id, attribute, value_num, value_text, at) VALUES (?, NULL, ?, ?, NULL, ?)',
    [deviceId, attribute, value, at.toISOString()]
  )
}

/** Waits for the next macrotask, so a listener that publishes asynchronously has run. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
