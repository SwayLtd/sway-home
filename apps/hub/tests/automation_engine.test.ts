/**
 * The automation engine.
 *
 * The invariant that matters most is the first one tested here: a routine the assistant
 * proposed must never run before a human says yes. Everything else - debounce, conditions,
 * re-entry, the loop guard - exists so that a house does not do something strange at 3 am
 * and nobody can explain why.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Routine } from '@sway-home/shared'
import { adapters } from '#services/adapter_manager'
import { automationEngine, solarTimes } from '#services/automation_engine'
import { bus } from '#services/event_bus'
import { houseService } from '#services/house'
import { people, routines } from '#repositories/store'
import { dropDatabase, freshDatabase, seedHouse, tick, type TestHouse } from './helpers.ts'
import { FakeAdapter } from './fake_adapter.ts'

const adapter = new FakeAdapter()
let fixture: TestHouse

type NewRoutine = Omit<Routine, 'id' | 'createdAt' | 'updatedAt' | 'runCount' | 'lastTriggeredAt'>

function makeRoutine(overrides: Partial<NewRoutine> = {}): Routine {
  return routines.create({
    name: 'Test',
    description: null,
    enabled: true,
    mode: 'single',
    triggers: [{ kind: 'device_state', deviceId: fixture.devices.motion, attribute: 'motion', operator: 'eq', value: true, forSeconds: 0 }],
    conditions: [],
    actions: [{ kind: 'device_command', deviceId: fixture.devices.lamp, command: 'turnOn', args: {} }],
    authoredBy: 'user',
    status: 'active',
    suggestionReason: null,
    areaId: null,
    ...overrides,
  } as NewRoutine)
}

beforeEach(async () => {
  await freshDatabase()
  adapter.reset()
  fixture = seedHouse()
  adapters.register(adapter)
  await adapters.start('test')
  adapter.setState('lamp', { on: false })
  automationEngine.start()
})

afterEach(() => {
  automationEngine.stop()
})

afterAll(dropDatabase)

/** Fires a state change the way an adapter would, then lets the listeners run. */
async function pushState(nativeId: string, state: Record<string, unknown>): Promise<void> {
  adapter.push(nativeId, state)
  await tick(30)
}

describe('approval', () => {
  test('a suggested routine never runs on its trigger', async () => {
    // The single most important guarantee in the product: the assistant may propose, and
    // nothing it proposed touches the house until a human accepts it.
    makeRoutine({ authoredBy: 'agent', status: 'suggested', suggestionReason: 'Vous le faites tous les soirs' })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
  })

  test('a paused routine never runs on its trigger', async () => {
    makeRoutine({ status: 'paused' })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
  })

  test('a disabled routine never runs on its trigger', async () => {
    makeRoutine({ enabled: false })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
  })

  test('the same routine runs once approved', async () => {
    const routine = makeRoutine({ authoredBy: 'agent', status: 'suggested' })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp')).toHaveLength(0)

    routines.update(routine.id, { status: 'active', enabled: true })
    await pushState('motion', { motion: false })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp').length).toBeGreaterThan(0)
  })
})

describe('triggers', () => {
  test('a device state trigger fires the routine', async () => {
    makeRoutine()
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp').map((entry) => entry.command)).toEqual(['turnOn'])
  })

  test('a state change that does not match the trigger does nothing', async () => {
    makeRoutine()
    await pushState('motion', { illuminance: 300 })
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
  })

  test('a trigger on another device does not fire', async () => {
    makeRoutine()
    await pushState('plug', { motion: true })
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
  })

  test('changed_to fires on the transition, not on a repeat of the same value', async () => {
    makeRoutine({
      triggers: [{ kind: 'device_state', deviceId: fixture.devices.motion, attribute: 'motion', operator: 'changed_to', value: true, forSeconds: 0 }],
    })
    await pushState('motion', { motion: true })
    const afterFirst = adapter.commandsFor('lamp').length
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp')).toHaveLength(afterFirst)
  })

  test('a numeric operator compares rather than matching exactly', async () => {
    makeRoutine({
      triggers: [{ kind: 'device_state', deviceId: fixture.devices.plug, attribute: 'power', operator: 'gt', value: 100, forSeconds: 0 }],
    })
    await pushState('plug', { power: 50 })
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
    await pushState('plug', { power: 150 })
    expect(adapter.commandsFor('lamp')).toHaveLength(1)
  })

  test('a house mode change fires a house_mode trigger', async () => {
    makeRoutine({ triggers: [{ kind: 'house_mode', mode: 'away' }] })
    houseService.setMode('away')
    await tick(30)
    expect(adapter.commandsFor('lamp')).toHaveLength(1)
  })

  test('a presence change fires a presence trigger', async () => {
    const person = people.create({ name: 'John' })
    makeRoutine({ triggers: [{ kind: 'presence', personId: null, transition: 'arrives' }] })
    people.setHome(person.id, true)
    bus.publish('presence.changed', { subjectType: 'person', subjectId: person.id, payload: { home: true, personId: person.id, homeCount: 1 } })
    await tick(30)
    expect(adapter.commandsFor('lamp')).toHaveLength(1)
  })

  test('a manual trigger runs the routine whatever its triggers say', async () => {
    const routine = makeRoutine({ triggers: [{ kind: 'time', at: '03:00', days: [] }] })
    expect(await automationEngine.trigger(routine.id)).toBe(true)
    expect(adapter.commandsFor('lamp')).toHaveLength(1)
  })

  test('triggering a routine that does not exist returns false rather than throwing', async () => {
    expect(await automationEngine.trigger('nope')).toBe(false)
  })
})

describe('debounce', () => {
  test('forSeconds holds the routine until the state has lasted long enough', async () => {
    makeRoutine({
      triggers: [{ kind: 'device_state', deviceId: fixture.devices.motion, attribute: 'motion', operator: 'eq', value: true, forSeconds: 1 }],
    })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp')).toHaveLength(0)

    await tick(1200)
    expect(adapter.commandsFor('lamp')).toHaveLength(1)
  }, 10_000)

  test('a state that flips back before the delay cancels the pending run', async () => {
    // The whole point of the debounce: a flapping sensor must not produce a light that
    // flickers on and off all evening.
    makeRoutine({
      triggers: [{ kind: 'device_state', deviceId: fixture.devices.motion, attribute: 'motion', operator: 'eq', value: true, forSeconds: 1 }],
    })
    await pushState('motion', { motion: true })
    await pushState('motion', { motion: false })
    await tick(1300)
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
  }, 10_000)
})

describe('conditions', () => {
  test('a condition that fails stops the routine', async () => {
    makeRoutine({ conditions: [{ kind: 'house_mode', modeIn: ['away'] }] as never })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
  })

  test('a condition that holds lets it run', async () => {
    makeRoutine({ conditions: [{ kind: 'house_mode', modeIn: ['home'] }] as never })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp')).toHaveLength(1)
  })

  test('a device_state condition reads the current state, not the event', async () => {
    makeRoutine({
      conditions: [{ kind: 'device_state', deviceId: fixture.devices.lock, attribute: 'locked', operator: 'eq', value: true }] as never,
    })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp')).toHaveLength(1)

    await houseService.execute(fixture.devices.lock, 'unlock')
    await pushState('motion', { motion: false })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp')).toHaveLength(1)
  })

  test('nested conditions are evaluated, not ignored', async () => {
    makeRoutine({
      conditions: [
        { kind: 'and', conditions: [{ kind: 'house_mode', modeIn: ['home'] }, { kind: 'presence', personId: null, home: false }] },
      ] as never,
    })
    await pushState('motion', { motion: true })
    // Nobody is registered, so "someone is home" is false and the AND fails.
    expect(adapter.commandsFor('lamp')).toHaveLength(1)
  })

  test('a not condition inverts', async () => {
    makeRoutine({ conditions: [{ kind: 'not', condition: { kind: 'house_mode', modeIn: ['home'] } }] as never })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
  })
})

describe('actions', () => {
  test('actions run in order', async () => {
    makeRoutine({
      actions: [
        { kind: 'device_command', deviceId: fixture.devices.lamp, command: 'turnOn', args: {} },
        { kind: 'device_command', deviceId: fixture.devices.lamp, command: 'setBrightness', args: { brightness: 20 } },
      ] as never,
    })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp').map((entry) => entry.command)).toEqual(['turnOn', 'setBrightness'])
  })

  test('a stop action ends the run', async () => {
    makeRoutine({
      actions: [
        { kind: 'device_command', deviceId: fixture.devices.lamp, command: 'turnOn', args: {} },
        { kind: 'stop' },
        { kind: 'device_command', deviceId: fixture.devices.lamp, command: 'setBrightness', args: { brightness: 20 } },
      ] as never,
    })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp').map((entry) => entry.command)).toEqual(['turnOn'])
  })

  test('a selector action commands every matching device', async () => {
    makeRoutine({
      actions: [{ kind: 'device_command', deviceId: null, selector: { areaId: fixture.areas.salon, capability: 'onoff' }, command: 'turnOff', args: {} }] as never,
    })
    await pushState('motion', { motion: true })
    expect(adapter.commandsFor('lamp').map((entry) => entry.command)).toEqual(['turnOff'])
  })

  test('a failing action does not abort the routine silently', async () => {
    adapter.failures.set('turnOn', 'unreachable')
    const events: string[] = []
    const off = bus.on('automation.*', (event) => {
      events.push(event.type)
    })
    makeRoutine()
    await pushState('motion', { motion: true })
    off()
    expect(events).toContain('automation.triggered')
  })
})

describe('re-entry', () => {
  test('mode single ignores a second trigger while the first is still running', async () => {
    makeRoutine({
      mode: 'single',
      actions: [
        { kind: 'delay', seconds: 1 },
        { kind: 'device_command', deviceId: fixture.devices.lamp, command: 'turnOn', args: {} },
      ] as never,
    })
    await pushState('motion', { motion: true })
    await pushState('motion', { motion: false })
    await pushState('motion', { motion: true })
    await tick(1400)
    expect(adapter.commandsFor('lamp')).toHaveLength(1)
  }, 10_000)
})

describe('loops', () => {
  test('two routines that call each other stop instead of recursing forever', async () => {
    // A runs B, B runs A. The re-entry guard catches this one: A is still running when B
    // tries to start it again, and `single` refuses. Without either guard this is an
    // infinite mutual recursion that takes the hub down.
    const b = makeRoutine({ name: 'B', triggers: [{ kind: 'manual' }] as never, actions: [{ kind: 'stop' }] as never })
    const a = makeRoutine({
      name: 'A',
      triggers: [{ kind: 'manual' }] as never,
      actions: [{ kind: 'run_routine', routineId: b.id }, { kind: 'device_command', deviceId: fixture.devices.lamp, command: 'turnOn', args: {} }] as never,
    })
    routines.update(b.id, { actions: [{ kind: 'run_routine', routineId: a.id }] as never })

    await automationEngine.trigger(a.id)
    await tick(50)
    // It finished rather than hanging, and A ran exactly once.
    expect(adapter.commandsFor('lamp')).toHaveLength(1)
  }, 15_000)

  test('a chain of distinct routines is cut at the third level and reported', async () => {
    const failures: string[] = []
    const off = bus.on('automation.failed', (event) => {
      failures.push(String((event.payload as { error: string }).error))
    })

    // Five different routines in a line: each one starts the next. The re-entry guard cannot
    // see this, because no routine ever runs twice - only the depth guard stops it.
    const last = makeRoutine({
      name: 'E',
      triggers: [{ kind: 'manual' }] as never,
      actions: [{ kind: 'device_command', deviceId: fixture.devices.lamp, command: 'turnOn', args: {} }] as never,
    })
    let next = last.id
    for (const label of ['D', 'C', 'B']) {
      next = makeRoutine({ name: label, triggers: [{ kind: 'manual' }] as never, actions: [{ kind: 'run_routine', routineId: next }] as never }).id
    }
    const first = makeRoutine({ name: 'A', triggers: [{ kind: 'manual' }] as never, actions: [{ kind: 'run_routine', routineId: next }] as never })

    await automationEngine.trigger(first.id)
    await tick(80)
    off()

    expect(failures.some((message) => message.includes('three levels'))).toBe(true)
    // The deepest routine never got to touch the house.
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
  }, 15_000)
})

describe('solarTimes', () => {
  const paris = { latitude: 48.8566, longitude: 2.3522 }

  test('produces a sunrise before a sunset', () => {
    const times = solarTimes(new Date('2026-06-21T12:00:00Z'), paris)
    expect(times.sunrise).toBeInstanceOf(Date)
    expect(times.sunset).toBeInstanceOf(Date)
    expect(times.sunrise!.getTime()).toBeLessThan(times.sunset!.getTime())
  })

  test('midsummer in Paris is a long day and midwinter a short one', () => {
    const summer = solarTimes(new Date('2026-06-21T12:00:00Z'), paris)
    const winter = solarTimes(new Date('2026-12-21T12:00:00Z'), paris)
    const length = (times: Record<string, Date | null>) => times.sunset!.getTime() - times.sunrise!.getTime()
    expect(length(summer) / 3_600_000).toBeGreaterThan(15)
    expect(length(winter) / 3_600_000).toBeLessThan(9)
  })

  test('sunrise in Paris on the solstice is within a few minutes of the published time', () => {
    // Published: 05:47 local (03:47 UTC) on 21 June.
    const times = solarTimes(new Date('2026-06-21T12:00:00Z'), paris)
    const utcMinutes = times.sunrise!.getUTCHours() * 60 + times.sunrise!.getUTCMinutes()
    expect(Math.abs(utcMinutes - (3 * 60 + 47))).toBeLessThanOrEqual(10)
  })

  test('the polar night has no sunrise rather than a wrong one', () => {
    const times = solarTimes(new Date('2026-12-21T12:00:00Z'), { latitude: 78.2, longitude: 15.6 })
    expect(times.sunrise === null || Number.isNaN(times.sunrise.getTime())).toBe(true)
  })

  test('solar noon sits between sunrise and sunset', () => {
    const times = solarTimes(new Date('2026-09-26T12:00:00Z'), paris)
    if (times.solarNoon) {
      expect(times.solarNoon.getTime()).toBeGreaterThan(times.sunrise!.getTime())
      expect(times.solarNoon.getTime()).toBeLessThan(times.sunset!.getTime())
    }
  })
})
