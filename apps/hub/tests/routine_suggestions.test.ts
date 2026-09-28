/**
 * Suggestions that can be weighed and adjusted.
 *
 * A suggested routine is shown as a recommendation card: what it would do, why, how sure the
 * hub is, and other ways to do the same thing - every day instead of weekdays, at sunrise
 * instead of 7:00, on the first movement in the room. Picking an alternative before
 * approving replaces the trigger; the actions stay.
 *
 * Habits are read in local time. They used to be grouped by the UTC hour of the event, which
 * turned "every morning at seven" in Paris into a routine at five.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { habitConfidence, habitDays, insightEngine } from '#services/insight_engine'
import { routines } from '#repositories/store'
import { insertInto } from '#db/database'
import { dropDatabase, freshDatabase, makeDevice, seedHouse, type TestHouse } from './helpers.ts'

let fixture: TestHouse

beforeEach(async () => {
  await freshDatabase()
  fixture = seedHouse()
})

afterAll(dropDatabase)

/** A command someone sent by hand, `daysAgo` days ago at a local time. */
function pressed(deviceId: string, command: string, daysAgo: number, hour: number, minute = 5): void {
  const at = new Date()
  at.setDate(at.getDate() - daysAgo)
  at.setHours(hour, minute, 0, 0)
  insertInto('events', {
    id: randomUUID(),
    type: 'device.command_sent',
    at: at.toISOString(),
    subject_type: 'device',
    subject_id: deviceId,
    origin: 'user',
    origin_detail: null,
    payload: JSON.stringify({ command, args: {}, deviceName: 'x', latencyMs: 3, risk: 'low' }),
    correlation_id: null,
    severity: 'info',
  })
}

/** The last `count` weekdays (Monday to Friday) before today, as days ago. */
function weekdaysAgo(count: number): number[] {
  const out: number[] = []
  for (let daysAgo = 1; out.length < count; daysAgo += 1) {
    const day = new Date()
    day.setDate(day.getDate() - daysAgo)
    if (day.getDay() >= 1 && day.getDay() <= 5) out.push(daysAgo)
  }
  return out
}

describe('reading a habit', () => {
  test('the days it happens on', () => {
    expect(habitDays({ mon: 2, tue: 1, wed: 2, thu: 1, fri: 1 })).toEqual(['mon', 'tue', 'wed', 'thu', 'fri'])
    expect(habitDays({ sat: 3, sun: 3 })).toEqual(['sat', 'sun'])
    expect(habitDays({ mon: 1, sat: 1, wed: 1, sun: 1 })).toEqual([])
  })

  test('how sure the hub is grows with the evidence, and never reaches certainty', () => {
    expect(habitConfidence(4)).toBeCloseTo(0.55, 5)
    expect(habitConfidence(8)).toBeGreaterThan(habitConfidence(4))
    expect(habitConfidence(40)).toBe(0.95)
  })

  test('the hour is the local hour of the presses', () => {
    for (const daysAgo of weekdaysAgo(5)) pressed(fixture.devices.lamp, 'turnOn', daysAgo, 7)

    const [habit] = insightEngine.findHabits()

    expect(habit?.hour).toBe(7)
    expect(habit?.occurrences).toBe(5)
    expect(habit?.days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri'])
  })
})

describe('a habit becomes a suggestion with alternatives', () => {
  test('the suggestion is written in French, weighed, and offers other triggers', () => {
    for (const daysAgo of weekdaysAgo(6)) pressed(fixture.devices.lamp, 'turnOn', daysAgo, 7)

    const [routine] = insightEngine.suggestFromHabits()

    expect(routine?.name).toBe('Plafonnier salon : allumer à 7 h')
    expect(routine?.status).toBe('suggested')
    expect(routine?.suggestionReason).toBe('Fait à la main 6 fois en trois semaines, vers 7 h, en semaine.')
    expect(routine?.confidence).toBeCloseTo(habitConfidence(6), 5)
    expect(routine?.triggers).toEqual([{ kind: 'time', at: '07:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] }])
    expect(routine?.alternatives?.map((alternative) => alternative.id)).toEqual(['every-day', 'sunrise'])
    expect(routine?.alternatives?.[0]?.triggers).toEqual([{ kind: 'time', at: '07:00', days: [] }])
    expect(routine?.alternatives?.[1]?.triggers).toEqual([{ kind: 'sun', event: 'sunrise', offsetMinutes: 0 }])
  })

  test('with a motion sensor in the room, the first movement is an alternative too', () => {
    makeDevice({ nativeId: 'motion-salon', name: 'Mouvement salon', category: 'sensor', capabilities: ['motion'], state: { motion: false }, areaId: fixture.areas.salon })
    for (const daysAgo of weekdaysAgo(6)) pressed(fixture.devices.lamp, 'turnOn', daysAgo, 19)

    const [routine] = insightEngine.suggestFromHabits()

    expect(routine?.alternatives?.map((alternative) => alternative.id)).toEqual(['every-day', 'sunset', 'motion'])
    const motion = routine?.alternatives?.find((alternative) => alternative.id === 'motion')
    expect(motion?.triggers?.[0]).toMatchObject({ kind: 'device_state', attribute: 'motion', operator: 'changed_to', value: true })
    expect(motion?.conditions).toEqual([{ kind: 'time_window', after: '18:00', before: '21:00', days: [] }])
  })

  test('approving with an alternative replaces the trigger and keeps the actions', () => {
    for (const daysAgo of weekdaysAgo(6)) pressed(fixture.devices.lamp, 'turnOn', daysAgo, 7)
    const [routine] = insightEngine.suggestFromHabits()

    const approved = insightEngine.approveSuggestion(routine!.id, 'sunrise')

    expect(approved?.status).toBe('active')
    expect(approved?.enabled).toBe(true)
    expect(approved?.triggers).toEqual([{ kind: 'sun', event: 'sunrise', offsetMinutes: 0 }])
    expect(approved?.actions).toEqual(routine?.actions)
  })

  test('approving as suggested keeps it as it is; an unknown alternative is refused', () => {
    for (const daysAgo of weekdaysAgo(6)) pressed(fixture.devices.lamp, 'turnOn', daysAgo, 7)
    const [routine] = insightEngine.suggestFromHabits()

    expect(insightEngine.approveSuggestion(routine!.id, 'nope')).toBeNull()
    expect(routines.find(routine!.id)?.status).toBe('suggested')
    expect(insightEngine.approveSuggestion(routine!.id)?.triggers).toEqual(routine?.triggers)
  })
})

describe('suggestions for a new device', () => {
  test('a lock gets a nightly routine, in French, with other moments to choose from', () => {
    const [routine] = insightEngine.suggestForDevice(fixture.devices.lock)

    expect(routine?.name).toBe('Verrouiller Serrure entrée la nuit')
    expect(routine?.confidence).toBe(0.7)
    expect(routine?.alternatives?.map((alternative) => alternative.id)).toEqual(['22h', 'night-mode', 'last-leaves'])
    expect(routine?.alternatives?.find((alternative) => alternative.id === 'night-mode')?.triggers).toEqual([{ kind: 'house_mode', mode: 'night' }])
  })

  test('every suggestion for a new device has a confidence and French words', () => {
    const plug = insightEngine.suggestForDevice(fixture.devices.plug)
    const leak = insightEngine.suggestForDevice(fixture.devices.leak)
    for (const routine of [...plug, ...leak]) {
      expect(routine.confidence).toBeGreaterThan(0)
      expect(routine.suggestionReason).not.toMatch(/\b(the|was|and)\b/)
    }
  })
})
