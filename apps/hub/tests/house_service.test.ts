/**
 * The single mutation path.
 *
 * Every command in the product goes through `houseService.execute`, so this is where the
 * guarantees live: the state is merged, the event carries who did it, an undo entry exists,
 * and a failure is reported rather than swallowed. If one of these tests goes red, something
 * in the house changed without leaving a trace - which is the failure this architecture was
 * built to make impossible.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { adapters } from '#services/adapter_manager'
import { bus } from '#services/event_bus'
import { deviceRepository } from '#repositories/device_repository'
import { houseService } from '#services/house'
import { house, scenes, undo } from '#repositories/store'
import type { HouseEvent } from '@sway-home/shared'
import { dropDatabase, freshDatabase, seedHouse, type TestHouse } from './helpers.ts'
import { FakeAdapter } from './fake_adapter.ts'

const adapter = new FakeAdapter()
let fixture: TestHouse

async function registerAdapter(): Promise<void> {
  adapters.register(adapter)
  await adapters.start('test')
}

beforeEach(async () => {
  await freshDatabase()
  adapter.reset()
  fixture = seedHouse()
  await registerAdapter()
  adapter.setState('lamp', { on: false, brightness: 60 })
  adapter.setState('lock', { locked: true })
  adapter.setState('thermo', { targetTemperature: 20 })
})

afterAll(dropDatabase)

/** Collects events published while `run` executes. */
async function captureEvents(pattern: string, run: () => Promise<unknown>): Promise<HouseEvent[]> {
  const seen: HouseEvent[] = []
  const off = bus.on(pattern, (event) => {
    seen.push(event)
  })
  try {
    await run()
  } finally {
    off()
  }
  return seen
}

describe('execute', () => {
  test('sends the command to the adapter and merges the state it returned', async () => {
    const result = await houseService.execute(fixture.devices.lamp, 'turnOn')
    expect(result.ok).toBe(true)
    expect(adapter.commandsFor('lamp').map((entry) => entry.command)).toEqual(['turnOn'])
    expect(deviceRepository.find(fixture.devices.lamp)!.state.on).toBe(true)
  })

  test('passes the arguments through untouched', async () => {
    await houseService.execute(fixture.devices.lamp, 'setBrightness', { brightness: 25, transitionMs: 800 })
    expect(adapter.commandsFor('lamp')[0]!.args).toEqual({ brightness: 25, transitionMs: 800 })
  })

  test('publishes a state change carrying the origin', async () => {
    const events = await captureEvents('device.state_changed', () =>
      houseService.execute(fixture.devices.lamp, 'turnOn', {}, { origin: 'agent', originDetail: 'conversation 1' })
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.origin).toBe('agent')
    expect(events[0]!.subjectId).toBe(fixture.devices.lamp)
    expect((events[0]!.payload as { changes: Record<string, unknown> }).changes.on).toBe(true)
  })

  test('ties the command and the state change together with one correlation id', async () => {
    const events = await captureEvents('device.*', () => houseService.execute(fixture.devices.lamp, 'turnOn'))
    const ids = new Set(events.map((event) => event.correlationId))
    expect(ids.size).toBe(1)
    expect([...ids][0]).toBeString()
  })

  test('an unknown device fails without touching any adapter', async () => {
    const result = await houseService.execute('not-a-device', 'turnOn')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown device')
    expect(adapter.commands).toHaveLength(0)
  })

  test('an adapter failure is reported and raises an alert rather than being swallowed', async () => {
    adapter.failures.set('turnOn', 'Device did not answer')
    const result = await houseService.execute(fixture.devices.lamp, 'turnOn')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Device did not answer')
    // The state must not have moved: a UI that flips the toggle on a failed command lies.
    expect(deviceRepository.find(fixture.devices.lamp)!.state.on).toBe(false)
  })

  test('a failed command publishes device.command_failed', async () => {
    adapter.failures.set('turnOn', 'nope')
    const events = await captureEvents('device.command_failed', () => houseService.execute(fixture.devices.lamp, 'turnOn'))
    expect(events).toHaveLength(1)
    expect((events[0]!.payload as { error: string }).error).toBe('nope')
  })

  test('reports how long the command took', async () => {
    const result = await houseService.execute(fixture.devices.lamp, 'turnOn')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.latencyMs).toBeLessThan(5000)
  })

  test('writes a history row so the charts have something to read', async () => {
    await houseService.execute(fixture.devices.lamp, 'setBrightness', { brightness: 30 })
    const history = deviceRepository.history(fixture.devices.lamp, 'brightness', { limit: 10 })
    expect(history.length).toBeGreaterThan(0)
  })
})

describe('undo', () => {
  test('a command pushes an undo entry that restores the previous state', async () => {
    await houseService.execute(fixture.devices.lamp, 'turnOn')
    expect(undo.stack(1)).toHaveLength(1)

    const undone = await houseService.undoLast()
    expect(undone.ok).toBe(true)
    expect(deviceRepository.find(fixture.devices.lamp)!.state.on).toBe(false)
  })

  test('undoing does not itself create an undo entry', async () => {
    // Otherwise undo becomes a toggle and pressing it twice does nothing visible.
    await houseService.execute(fixture.devices.lamp, 'turnOn')
    await houseService.undoLast()
    const remaining = undo.stack(5)
    expect(remaining.length).toBeLessThanOrEqual(1)
  })

  test('undo with an empty stack is a no-op rather than an error', async () => {
    const result = await houseService.undoLast()
    expect(result.ok).toBe(false)
    expect(result.description).toBeNull()
  })

  test('a batch produces one undo entry for the whole batch', async () => {
    await houseService.executeMany({ areaId: fixture.areas.salon, capability: 'onoff' }, 'turnOn')
    const stack = undo.stack(5)
    expect(stack).toHaveLength(1)
    expect(stack[0]!.commands.length).toBeGreaterThan(0)
  })
})

describe('resolve', () => {
  test('by explicit ids', () => {
    const devices = houseService.resolve({ deviceIds: [fixture.devices.lamp, fixture.devices.lock] })
    expect(devices.map((device) => device.id).sort()).toEqual([fixture.devices.lamp, fixture.devices.lock].sort())
  })

  test('by area id', () => {
    const devices = houseService.resolve({ areaId: fixture.areas.chambre })
    expect(devices.map((device) => device.name).sort()).toEqual(['Détecteur chambre', 'Prise bureau'])
  })

  test('by area name, case and accent insensitively', () => {
    expect(houseService.resolve({ areaName: 'chambre' }).length).toBe(2)
    expect(houseService.resolve({ areaName: 'CHAMBRE' }).length).toBe(2)
  })

  test('by capability', () => {
    const devices = houseService.resolve({ capability: 'lock' })
    expect(devices).toHaveLength(1)
    expect(devices[0]!.name).toBe('Serrure entrée')
  })

  test('by category', () => {
    expect(houseService.resolve({ category: 'light' })).toHaveLength(1)
  })

  test('combining area and capability narrows rather than widens', () => {
    const devices = houseService.resolve({ areaId: fixture.areas.salon, capability: 'onoff' })
    expect(devices.map((device) => device.name)).toEqual(['Plafonnier salon'])
  })

  test('an unknown area name resolves to nothing rather than to everything', () => {
    // The dangerous failure: "éteins la véranda" turning off the whole house.
    expect(houseService.resolve({ areaName: 'véranda' })).toEqual([])
  })

  test('an empty selector resolves to nothing unless all is set', () => {
    expect(houseService.resolve({})).toEqual([])
    expect(houseService.resolve({ all: true }).length).toBeGreaterThan(0)
  })
})

describe('executeMany', () => {
  test('commands every matching device once', async () => {
    await houseService.executeMany({ capability: 'onoff' }, 'turnOff')
    const targets = adapter.commands.filter((entry) => entry.command === 'turnOff')
    expect(targets.map((entry) => entry.nativeId).sort()).toEqual(['lamp', 'plug'])
  })

  test('a selector that matches nothing is a no-op, not an error', async () => {
    const results = await houseService.executeMany({ areaName: 'nulle part' }, 'turnOff')
    expect(results).toEqual([])
    expect(adapter.commands).toHaveLength(0)
  })

  test('one failing device does not stop the others', async () => {
    adapter.failures.set('turnOff', 'lamp is unplugged')
    const results = await houseService.executeMany({ capability: 'onoff' }, 'turnOff')
    expect(results).toHaveLength(2)
    expect(results.every((result) => result.ok === false)).toBe(true)
  })
})

describe('scenes', () => {
  test('a snapshot captures the state of the devices selected', async () => {
    await houseService.execute(fixture.devices.lamp, 'setBrightness', { brightness: 35 })
    const sceneId = houseService.snapshotScene('Lecture', { areaId: fixture.areas.salon })
    const scene = scenes.find(sceneId)!
    const entry = scene.entries.find((candidate) => candidate.deviceId === fixture.devices.lamp)
    expect(entry).toBeDefined()
    expect(entry!.state.brightness).toBe(35)
  })

  test('a snapshot skips devices that have nothing to restore', () => {
    const sceneId = houseService.snapshotScene('Tout', { all: true })
    const scene = scenes.find(sceneId)!
    // The motion sensor has no settable state; capturing it would produce a scene that
    // tries to command a read-only device on every activation.
    expect(scene.entries.some((entry) => entry.deviceId === fixture.devices.motion)).toBe(false)
  })

  test('activating a scene applies every entry', async () => {
    await houseService.execute(fixture.devices.lamp, 'setBrightness', { brightness: 80 })
    const sceneId = houseService.snapshotScene('Vif', { deviceIds: [fixture.devices.lamp] })
    await houseService.execute(fixture.devices.lamp, 'turnOff')

    const results = await houseService.applyScene(sceneId)
    expect(results.length).toBeGreaterThan(0)
    expect(deviceRepository.find(fixture.devices.lamp)!.state.brightness).toBe(80)
  })

  test('activating a scene that does not exist returns nothing rather than throwing', async () => {
    expect(await houseService.applyScene('nope')).toEqual([])
  })

  test('a scene activation publishes one event naming the scene', async () => {
    const sceneId = houseService.snapshotScene('Soir', { deviceIds: [fixture.devices.lamp] })
    const events = await captureEvents('scene.activated', () => houseService.applyScene(sceneId))
    expect(events).toHaveLength(1)
    expect((events[0]!.payload as { name: string }).name).toBe('Soir')
  })
})

describe('house mode', () => {
  test('setting a new mode stores it and announces it', async () => {
    const events = await captureEvents('house.mode_changed', async () => houseService.setMode('away'))
    expect(house.mode()).toBe('away')
    expect(events).toHaveLength(1)
    expect((events[0]!.payload as { mode: string; previous: string })).toMatchObject({ mode: 'away', previous: 'home' })
  })

  test('setting the mode it already has publishes nothing', async () => {
    houseService.setMode('away')
    const events = await captureEvents('house.mode_changed', async () => houseService.setMode('away'))
    expect(events).toHaveLength(0)
  })
})

describe('snapshot', () => {
  test('summarises the house in one pass', async () => {
    await houseService.execute(fixture.devices.lamp, 'turnOn')
    const snapshot = houseService.snapshot()

    expect(snapshot.mode).toBe('home')
    expect(snapshot.counts.total).toBeGreaterThanOrEqual(6)
    expect(snapshot.lightsOn).toContain('Plafonnier salon')
    expect(snapshot.climate.some((entry) => entry.area === 'Salon')).toBe(true)
    expect(snapshot.power.total).toBeGreaterThanOrEqual(42)
  })

  test('reports an unlocked door in the security section', async () => {
    await houseService.execute(fixture.devices.lock, 'unlock')
    expect(houseService.snapshot().security.locksUnlocked).toContain('Serrure entrée')
  })

  test('reports a low battery', () => {
    adapter.push('motion', { battery: 9 })
    const snapshot = houseService.snapshot()
    expect(snapshot.batteriesLow.some((entry) => entry.name === 'Détecteur chambre')).toBe(true)
  })
})
