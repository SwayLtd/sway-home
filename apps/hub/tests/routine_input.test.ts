/**
 * What may be written into a routine.
 *
 * The routine editor (the flowchart) writes routines through the API, and so can anything on
 * the network that speaks HTTP. The hub used to store whatever arrived; a trigger of an
 * unknown kind was then silently never fired, and an action without a command failed at
 * seven in the morning instead of at the moment it was written. Now a routine is checked
 * against the shared schema before it is kept, and the answer says what is wrong in words.
 */

import { describe, expect, test } from 'bun:test'
import { parseRoutineInput } from '#services/routine_input'

const VALID = {
  name: 'Réveil en douceur',
  triggers: [{ kind: 'time', at: '07:00', days: ['mon', 'tue'] }],
  conditions: [{ kind: 'presence', personId: null, home: true }],
  actions: [
    { kind: 'device_command', deviceId: 'lamp', command: 'setBrightness', args: { brightness: 30 } },
    { kind: 'delay', seconds: 600 },
    { kind: 'scene', sceneId: 'morning' },
  ],
}

describe('a whole routine', () => {
  test('a valid routine passes, with the defaults filled in', () => {
    const result = parseRoutineInput(VALID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.name).toBe('Réveil en douceur')
    expect(result.value.mode).toBe('single')
    expect(result.value.enabled).toBe(true)
    expect(result.value.actions[0]).toEqual({ kind: 'device_command', deviceId: 'lamp', selector: null, command: 'setBrightness', args: { brightness: 30 } })
  })

  test('each problem is named, in words, with where it is', () => {
    const result = parseRoutineInput({
      name: '  ',
      triggers: [{ kind: 'teleport' }, { kind: 'time', at: '7h' }],
      actions: [{ kind: 'delay', seconds: -5 }],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toContain('Nom : obligatoire')
    expect(result.errors).toContain('Déclencheur 1 : type inconnu (teleport)')
    expect(result.errors.some((error) => error.startsWith('Déclencheur 2 : '))).toBe(true)
    expect(result.errors.some((error) => error.startsWith('Action 1 : '))).toBe(true)
  })

  test('a routine needs a trigger and an action', () => {
    const result = parseRoutineInput({ name: 'Vide', triggers: [], actions: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toEqual(['Déclencheurs : au moins un', 'Actions : au moins une'])
  })

  test('nested conditions are checked all the way down', () => {
    const result = parseRoutineInput({
      ...VALID,
      conditions: [{ kind: 'or', conditions: [{ kind: 'house_mode', modeIn: ['night'] }, { kind: 'moon_phase' }] }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toStartWith('Condition 1 : ')
  })

  test('what the hub owns cannot be written from outside', () => {
    const result = parseRoutineInput({ ...VALID, id: 'forged', runCount: 99, authoredBy: 'agent', suggestionReason: 'x', lastTriggeredAt: '2020-01-01T00:00:00.000Z' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.value).sort()).toEqual(['actions', 'areaId', 'conditions', 'description', 'enabled', 'mode', 'name', 'status', 'triggers'])
  })

  test('a person may create a routine active or paused, not suggested or archived', () => {
    expect(parseRoutineInput({ ...VALID, status: 'paused' }).ok).toBe(true)
    const suggested = parseRoutineInput({ ...VALID, status: 'suggested' })
    expect(suggested.ok).toBe(false)
  })
})

describe('a change to a routine', () => {
  test('only what is sent is checked and kept', () => {
    const result = parseRoutineInput({ name: 'Nouveau nom' }, { partial: true })
    expect(result).toEqual({ ok: true, value: { name: 'Nouveau nom' } })
  })

  test('a partial change is still checked', () => {
    const result = parseRoutineInput({ actions: [{ kind: 'device_command' }] }, { partial: true })
    expect(result.ok).toBe(false)
  })

  test('archiving is a change a person may make', () => {
    expect(parseRoutineInput({ status: 'archived' }, { partial: true }).ok).toBe(true)
  })
})
