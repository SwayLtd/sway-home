/**
 * Routine, scene and trigger schemas.
 *
 * These schemas are the contract between three authors: a human filling a form, the agent
 * writing a routine from a sentence, and the insight engine proposing one from a habit. A
 * field that silently defaults wrong produces a routine that runs at the wrong time, which
 * is the worst failure mode in the product, so the defaults are pinned here.
 */

import { describe, expect, test } from 'bun:test'
import { HOUSE_MODES, actionSchema, conditionSchema, routineSchema, sceneSchema, triggerSchema } from '../src/automation.ts'

describe('triggers', () => {
  test('a device state trigger keeps its attribute, operator and value', () => {
    const trigger = triggerSchema.parse({ kind: 'device_state', deviceId: 'd1', attribute: 'on', operator: 'eq', value: true })
    expect(trigger).toMatchObject({ kind: 'device_state', deviceId: 'd1', attribute: 'on', operator: 'eq', value: true })
  })

  test('forSeconds defaults to zero, so a trigger fires immediately unless debounced', () => {
    const trigger = triggerSchema.parse({ kind: 'device_state', deviceId: 'd1', attribute: 'motion', operator: 'changed_to', value: true })
    expect((trigger as { forSeconds: number }).forSeconds).toBe(0)
  })

  test('forSeconds is capped at a day, because a longer debounce is a bug not a setting', () => {
    expect(() => triggerSchema.parse({ kind: 'device_state', deviceId: 'd1', attribute: 'on', operator: 'eq', forSeconds: 90_000 })).toThrow()
  })

  test('an operator outside the vocabulary is rejected', () => {
    expect(() => triggerSchema.parse({ kind: 'device_state', deviceId: 'd1', attribute: 'on', operator: 'kinda' })).toThrow()
  })

  test('a time trigger requires HH:MM and rejects prose', () => {
    expect(() => triggerSchema.parse({ kind: 'time' })).toThrow()
    expect(() => triggerSchema.parse({ kind: 'time', at: 'le soir' })).toThrow()
    expect(triggerSchema.parse({ kind: 'time', at: '07:30' })).toMatchObject({ at: '07:30', days: [] })
  })

  test('a sun trigger accepts an offset in both directions and clamps the absurd', () => {
    expect(triggerSchema.parse({ kind: 'sun', event: 'sunset', offsetMinutes: -30 })).toMatchObject({ offsetMinutes: -30 })
    expect(triggerSchema.parse({ kind: 'sun', event: 'sunrise' })).toMatchObject({ offsetMinutes: 0 })
    expect(() => triggerSchema.parse({ kind: 'sun', event: 'sunrise', offsetMinutes: 5000 })).toThrow()
  })

  test('an interval cannot be faster than ten seconds', () => {
    expect(() => triggerSchema.parse({ kind: 'interval', everySeconds: 1 })).toThrow()
    expect(triggerSchema.parse({ kind: 'interval', everySeconds: 60 })).toMatchObject({ everySeconds: 60 })
  })

  test('a capability trigger can cover a whole area at once', () => {
    const trigger = triggerSchema.parse({ kind: 'capability_state', capability: 'motion', attribute: 'motion', operator: 'eq', value: true, areaId: 'a1' })
    expect(trigger).toMatchObject({ capability: 'motion', areaId: 'a1' })
  })

  test('an unknown trigger kind is rejected rather than ignored', () => {
    expect(() => triggerSchema.parse({ kind: 'telepathy' })).toThrow()
  })
})

describe('conditions', () => {
  test('a flat state condition parses', () => {
    const condition = conditionSchema.parse({ kind: 'device_state', deviceId: 'd1', attribute: 'on', operator: 'eq', value: true })
    expect(condition).toMatchObject({ kind: 'device_state', attribute: 'on' })
  })

  test('conditions nest, because "if it is dark AND someone is home" is the normal case', () => {
    const condition = conditionSchema.parse({
      kind: 'and',
      conditions: [
        { kind: 'presence', home: true },
        { kind: 'or', conditions: [{ kind: 'house_mode', modeIn: ['home'] }, { kind: 'sun_position', state: 'below_horizon' }] },
      ],
    })
    expect(condition.kind).toBe('and')
  })

  test('a negation wraps a single condition', () => {
    const condition = conditionSchema.parse({ kind: 'not', condition: { kind: 'presence', home: true } })
    expect(condition.kind).toBe('not')
  })

  test('a time window keeps both ends and rejects a malformed clock', () => {
    expect(conditionSchema.parse({ kind: 'time_window', after: '22:00', before: '06:00' })).toMatchObject({ after: '22:00', before: '06:00' })
    expect(() => conditionSchema.parse({ kind: 'time_window', after: '22h', before: '06:00' })).toThrow()
  })

  test('a nested condition is validated as deeply as a flat one', () => {
    expect(() =>
      conditionSchema.parse({ kind: 'and', conditions: [{ kind: 'presence', home: 'oui' }] })
    ).toThrow()
  })
})

describe('actions', () => {
  test('a device command action defaults its arguments to an empty object', () => {
    const action = actionSchema.parse({ kind: 'device_command', deviceId: 'd1', command: 'turnOn' })
    expect((action as { args: Record<string, unknown> }).args).toEqual({})
  })

  test('a delay is expressed in seconds and cannot be negative', () => {
    expect(actionSchema.parse({ kind: 'delay', seconds: 10 })).toMatchObject({ seconds: 10 })
    expect(() => actionSchema.parse({ kind: 'delay', seconds: -1 })).toThrow()
    expect(() => actionSchema.parse({ kind: 'delay', ms: 1000 })).toThrow()
  })

  test('a webhook action defaults to POST and only allows GET or POST', () => {
    expect(actionSchema.parse({ kind: 'webhook', url: 'https://example.com/hook' })).toMatchObject({ method: 'POST', body: {} })
    expect(() => actionSchema.parse({ kind: 'webhook', url: 'https://example.com', method: 'DELETE' })).toThrow()
  })

  test('a webhook action rejects a value that is not a URL', () => {
    expect(() => actionSchema.parse({ kind: 'webhook', url: 'chez-moi' })).toThrow()
  })

  test('wait_until has a bounded timeout, so a routine cannot hang forever', () => {
    const action = actionSchema.parse({ kind: 'wait_until', condition: { kind: 'presence', home: true } })
    expect((action as { timeoutSeconds: number }).timeoutSeconds).toBe(300)
    expect(() => actionSchema.parse({ kind: 'wait_until', condition: {}, timeoutSeconds: 99_999 })).toThrow()
  })
})

describe('routines', () => {
  const base = {
    id: 'r1',
    name: 'Soirée',
    triggers: [{ kind: 'time', at: '20:00' }],
    actions: [{ kind: 'device_command', deviceId: 'd1', command: 'turnOn' }],
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
  }

  test('mode defaults to single so a re-trigger cannot stack runs', () => {
    expect(routineSchema.parse(base).mode).toBe('single')
  })

  test('a routine needs at least one trigger and one action', () => {
    expect(() => routineSchema.parse({ ...base, triggers: [] })).toThrow()
    expect(() => routineSchema.parse({ ...base, actions: [] })).toThrow()
  })

  test('conditions default to empty, meaning "always"', () => {
    expect(routineSchema.parse(base).conditions).toEqual([])
  })

  test('the schema describes stored rows, including an approved agent routine', () => {
    // It is deliberately permissive: an agent routine that a human approved is `active` with
    // `authoredBy: 'agent'`. What stops an unapproved one from running is the engine, which
    // only ever selects `status = 'active' AND enabled = 1` - asserted in the engine tests.
    const approved = routineSchema.parse({ ...base, authoredBy: 'agent', status: 'active' })
    expect(approved.authoredBy).toBe('agent')
    expect(approved.status).toBe('active')

    const proposed = routineSchema.parse({ ...base, authoredBy: 'agent', status: 'suggested', suggestionReason: 'Vous le faites tous les soirs.' })
    expect(proposed.status).toBe('suggested')
    expect(proposed.suggestionReason).toBe('Vous le faites tous les soirs.')
  })

  test('runCount and lastTriggeredAt start empty', () => {
    const routine = routineSchema.parse(base)
    expect(routine.runCount).toBe(0)
    expect(routine.lastTriggeredAt).toBeNull()
  })

  test('a malformed trigger inside an otherwise valid routine fails the whole routine', () => {
    expect(() => routineSchema.parse({ ...base, triggers: [{ kind: 'time', at: 'tard' }] })).toThrow()
  })
})

describe('scenes', () => {
  test('entries carry a device, a state and a transition', () => {
    const scene = sceneSchema.parse({
      id: 's1',
      name: 'Film',
      entries: [{ deviceId: 'd1', state: { on: true, brightness: 20 } }],
      createdAt: '2026-09-26T10:00:00.000Z',
      updatedAt: '2026-09-26T10:00:00.000Z',
    })
    expect(scene.entries[0]).toMatchObject({ deviceId: 'd1' })
    expect(typeof scene.entries[0]!.transitionMs).toBe('number')
  })

  test('a scene with no entries is allowed, because capture writes them afterwards', () => {
    const scene = sceneSchema.parse({
      id: 's2',
      name: 'Vide',
      entries: [],
      createdAt: '2026-09-26T10:00:00.000Z',
      updatedAt: '2026-09-26T10:00:00.000Z',
    })
    expect(scene.entries).toEqual([])
  })
})

describe('house modes', () => {
  test('the modes the rest of the system branches on all exist', () => {
    for (const mode of ['home', 'away', 'night', 'vacation']) {
      expect(HOUSE_MODES).toContain(mode as never)
    }
  })
})
