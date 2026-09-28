/**
 * The event vocabulary and its wildcard matcher.
 *
 * `eventMatches` decides which listener wakes up for which event, so a bug here is either a
 * routine that never fires or one that fires on everything. The prefix cases are the ones
 * worth pinning: `device.*` must not match `devices.added`, and `*` must match everything.
 */

import { describe, expect, test } from 'bun:test'
import { EVENT_TYPES, eventMatches, houseEventSchema, type EventType } from '../src/events.ts'

describe('the event list', () => {
  test('has no duplicates', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length)
  })

  test('every type is dotted namespace.verb', () => {
    for (const type of EVENT_TYPES) {
      expect(type).toMatch(/^[a-z]+\.[a-z_]+$/)
    }
  })

  test('covers the namespaces the rest of the system subscribes to', () => {
    const namespaces = new Set(EVENT_TYPES.map((type) => type.split('.')[0]))
    for (const required of ['device', 'automation', 'agent', 'alert', 'scan', 'house', 'presence', 'system']) {
      expect(namespaces).toContain(required)
    }
  })
})

describe('eventMatches', () => {
  test('an exact type matches only itself', () => {
    expect(eventMatches('device.added', 'device.added')).toBe(true)
    expect(eventMatches('device.added', 'device.removed')).toBe(false)
  })

  test('a star matches everything', () => {
    for (const type of EVENT_TYPES) expect(eventMatches('*', type)).toBe(true)
  })

  test('a namespace wildcard matches only that namespace', () => {
    expect(eventMatches('device.*', 'device.state_changed')).toBe(true)
    expect(eventMatches('device.*', 'agent.message')).toBe(false)
    expect(eventMatches('agent.*', 'agent.tool_call')).toBe(true)
  })

  test('a wildcard does not leak into a namespace that merely starts the same', () => {
    // 'device.*' becomes the prefix 'device.', so a hypothetical 'devices.added' must not
    // match. This is the classic off-by-one in prefix matching.
    expect(eventMatches('device.*', 'devices.added' as EventType)).toBe(false)
  })

  test('an unknown pattern matches nothing rather than everything', () => {
    expect(eventMatches('nope', 'device.added')).toBe(false)
    expect(eventMatches('', 'device.added')).toBe(false)
  })
})

describe('houseEventSchema', () => {
  const minimal = { id: 'e1', type: 'device.added' as const, at: '2026-09-26T10:00:00.000Z' }

  test('fills in the defaults the bus relies on', () => {
    const event = houseEventSchema.parse(minimal)
    expect(event.subjectType).toBe('system')
    expect(event.subjectId).toBeNull()
    expect(event.origin).toBe('system')
    expect(event.payload).toEqual({})
    expect(event.correlationId).toBeNull()
    expect(event.severity).toBe('info')
  })

  test('rejects a type outside the vocabulary', () => {
    expect(() => houseEventSchema.parse({ ...minimal, type: 'device.exploded' })).toThrow()
  })

  test('rejects a timestamp that is not ISO', () => {
    expect(() => houseEventSchema.parse({ ...minimal, at: 'hier soir' })).toThrow()
  })

  test('keeps origin and correlation, which is how the journal answers who did this', () => {
    const event = houseEventSchema.parse({
      ...minimal,
      origin: 'agent',
      originDetail: 'conversation 7',
      correlationId: 'abc',
      severity: 'warning',
    })
    expect(event.origin).toBe('agent')
    expect(event.originDetail).toBe('conversation 7')
    expect(event.correlationId).toBe('abc')
    expect(event.severity).toBe('warning')
  })
})
