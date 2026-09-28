/**
 * Teaching a task by doing it.
 *
 * "Apprendre une tâche" starts a recording; the person then does the thing by hand - from
 * the console or on the wall switch - and stops. What changed becomes a suggested routine:
 * the same devices, set the same way, in the same order, with the pauses that mattered.
 * Programming by demonstration, the smart-home way: trigger-action rules are easy to read
 * (Ur et al., CHI 2014) but tedious to write, and doing the task once is not.
 *
 * Only what a person did counts: sensors reporting a temperature, the assistant acting, a
 * routine running - none of that is the lesson.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { teach } from '#services/teach_service'
import { adapters } from '#services/adapter_manager'
import { houseService } from '#services/house'
import { routines } from '#repositories/store'
import { dropDatabase, freshDatabase, seedHouse, type TestHouse } from './helpers.ts'
import { FakeAdapter } from './fake_adapter.ts'

const adapter = new FakeAdapter()
let fixture: TestHouse
let now = 0
const clock = () => now

beforeEach(async () => {
  await freshDatabase()
  adapter.reset()
  fixture = seedHouse()
  adapters.register(adapter)
  await adapters.start('test')
  adapter.setState('lamp', { on: false, brightness: 60 })
  adapter.setState('plug', { on: true })
  now = Date.parse('2026-09-28T19:00:00.000Z')
})

afterEach(() => {
  teach.stop()
})

afterAll(dropDatabase)

describe('a recording', () => {
  test('captures what the person does, device by device, and becomes a suggested routine', async () => {
    teach.start({ title: 'Soirée film', clock })
    await houseService.execute(fixture.devices.lamp, 'turnOn', {}, { origin: 'user' })
    await houseService.execute(fixture.devices.lamp, 'setBrightness', { brightness: 30 }, { origin: 'user' })
    now += 2_000
    adapter.push('plug', { on: false })

    const status = teach.status()
    expect(status.active).toBe(true)
    expect(status.steps.map((step) => step.deviceName)).toEqual(['Plafonnier salon', 'Prise bureau'])

    const result = teach.stop()

    expect(result.steps).toHaveLength(2)
    const routine = result.routine!
    expect(routine.name).toBe('Tâche apprise : Soirée film')
    expect(routine.status).toBe('suggested')
    expect(routine.triggers).toEqual([{ kind: 'manual' }])
    expect(routine.actions.map((action) => (action.kind === 'device_command' ? [action.deviceId, action.command] : [action.kind]))).toEqual([
      [fixture.devices.lamp, 'turnOn'],
      [fixture.devices.lamp, 'setBrightness'],
      [fixture.devices.plug, 'turnOff'],
    ])
    expect(routines.find(routine.id)?.status).toBe('suggested')
    expect(teach.status().active).toBe(false)
  })

  test('a pause of half a minute or more is part of the task', async () => {
    teach.start({ clock })
    await houseService.execute(fixture.devices.lamp, 'turnOn', {}, { origin: 'user' })
    now += 95_000
    await houseService.execute(fixture.devices.plug, 'turnOff', {}, { origin: 'user' })

    const { routine } = teach.stop()

    expect(routine?.actions.map((action) => action.kind)).toEqual(['device_command', 'delay', 'device_command'])
    const delay = routine?.actions[1]
    expect(delay?.kind === 'delay' && delay.seconds).toBe(95)
  })

  test('what the sensors report, the assistant does, or a routine runs is not the lesson', async () => {
    teach.start({ clock })
    adapter.push('motion', { motion: true, illuminance: 40 })
    adapter.push('thermo', { currentTemperature: 21, temperature: 21 })
    await houseService.execute(fixture.devices.lamp, 'turnOn', {}, { origin: 'agent' })
    await houseService.execute(fixture.devices.plug, 'turnOff', {}, { origin: 'automation' })

    expect(teach.status().steps).toEqual([])
    expect(teach.stop()).toEqual({ routine: null, steps: [] })
    expect(routines.all('suggested')).toHaveLength(0)
  })

  test('the time it was taught is offered as a daily trigger', async () => {
    teach.start({ clock })
    await houseService.execute(fixture.devices.lamp, 'turnOn', {}, { origin: 'user' })

    const { routine } = teach.stop()

    const local = new Date(now)
    const minute = Math.round(local.getMinutes() / 5) * 5
    const hour = (local.getHours() + (minute === 60 ? 1 : 0)) % 24
    const at = `${String(hour).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
    expect(routine?.alternatives?.[0]?.triggers).toEqual([{ kind: 'time', at, days: [] }])
  })

  test('before the start and after the stop, nothing is recorded; one recording at a time', async () => {
    await houseService.execute(fixture.devices.lamp, 'turnOn', {}, { origin: 'user' })
    const first = teach.start({ clock })
    const again = teach.start({ clock })
    expect(again.id).toBe(first.id)
    teach.stop()
    await houseService.execute(fixture.devices.plug, 'turnOff', {}, { origin: 'user' })
    expect(teach.status()).toEqual({ active: false, id: null, title: null, startedAt: null, steps: [] })
  })
})
