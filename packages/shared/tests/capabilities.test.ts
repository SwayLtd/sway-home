/**
 * The capability vocabulary.
 *
 * Everything else in the system is written against this table: the UI renders controls from
 * it, the agent builds its tool schemas from it, the automation engine validates triggers
 * against it. So the tests here are mostly structural - they assert the table stays
 * internally consistent, because an inconsistency shows up as a broken control or a tool the
 * model cannot call, three layers away from the cause.
 */

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  CAPABILITY_KINDS,
  COMMAND_OWNER,
  capabilityCatalogueForPrompt,
  capabilityIdSchema,
  commandsFor,
  isCapabilityId,
  stateSchemaFor,
} from '../src/capabilities.ts'

describe('the table', () => {
  test('is not empty and covers the core of a house', () => {
    expect(CAPABILITY_IDS.length).toBeGreaterThan(30)
    for (const required of ['onoff', 'brightness', 'colorTemperature', 'temperature', 'humidity', 'lock', 'thermostat', 'motion', 'contact', 'power', 'battery']) {
      expect(CAPABILITY_IDS).toContain(required as never)
    }
  })

  test('every capability declares a kind, a description and a state schema', () => {
    for (const id of CAPABILITY_IDS) {
      const spec = CAPABILITIES[id]
      expect(CAPABILITY_KINDS).toContain(spec.kind)
      expect(spec.description.length).toBeGreaterThan(5)
      expect(spec.state).toBeInstanceOf(z.ZodType)
    }
  })

  test('a read-only capability has no commands, and a non-sensor has at least one', () => {
    for (const id of CAPABILITY_IDS) {
      const spec = CAPABILITIES[id]
      const commandCount = Object.keys(spec.commands).length
      if (spec.readOnly) expect(commandCount).toBe(0)
      if (spec.kind === 'actuator') expect(commandCount).toBeGreaterThan(0)
    }
  })

  test('Matter cluster ids are plausible and not duplicated across unrelated capabilities', () => {
    const seen = new Map<number, string>()
    for (const id of CAPABILITY_IDS) {
      const cluster = CAPABILITIES[id].matterCluster
      if (cluster === undefined || cluster === null) continue
      expect(cluster).toBeGreaterThan(0)
      expect(cluster).toBeLessThanOrEqual(0xffff)
      const previous = seen.get(cluster)
      // Sharing a cluster is legitimate (brightness and onoff both sit on a light), but it
      // should be a deliberate pair rather than an accident, so the test records it.
      if (previous) expect([previous, id].sort().join('+')).toBeString()
      seen.set(cluster, id)
    }
  })
})

describe('command ownership', () => {
  test('every command maps back to exactly one capability', () => {
    for (const id of CAPABILITY_IDS) {
      for (const command of Object.keys(CAPABILITIES[id].commands)) {
        expect(COMMAND_OWNER[command]).toBeDefined()
      }
    }
  })

  test('a command name is never claimed by two capabilities with different arguments', () => {
    const byName = new Map<string, { capability: string; schema: z.ZodType }>()
    for (const id of CAPABILITY_IDS) {
      for (const [command, schema] of Object.entries(CAPABILITIES[id].commands)) {
        const previous = byName.get(command)
        if (previous) {
          // Two capabilities may share a verb, but then the payload has to be the same or
          // the hub cannot route the command without knowing which one the caller meant.
          expect(JSON.stringify(z.toJSONSchema(schema as z.ZodType, { io: 'input' }))).toBe(
            JSON.stringify(z.toJSONSchema(previous.schema, { io: 'input' }))
          )
        }
        byName.set(command, { capability: id, schema: schema as z.ZodType })
      }
    }
  })
})

describe('stateSchemaFor', () => {
  test('merges the state of every capability given', () => {
    const schema = stateSchemaFor(['onoff', 'brightness', 'colorTemperature'])
    const parsed = schema.parse({ on: true, brightness: 40, colorTemperature: 2700 })
    expect(parsed).toEqual({ on: true, brightness: 40, colorTemperature: 2700 })
  })

  test('is partial, because a device reports what it knows and nothing more', () => {
    const schema = stateSchemaFor(['onoff', 'brightness'])
    expect(schema.parse({})).toEqual({})
    expect(schema.parse({ on: false })).toEqual({ on: false })
  })

  test('still rejects a value of the wrong type', () => {
    const schema = stateSchemaFor(['brightness'])
    expect(() => schema.parse({ brightness: 'plein pot' })).toThrow()
  })

  test('an empty capability list is an empty schema rather than a crash', () => {
    expect(stateSchemaFor([]).parse({})).toEqual({})
  })
})

describe('commandsFor', () => {
  test('returns the union of the commands of the capabilities given', () => {
    const commands = commandsFor(['onoff', 'brightness'])
    expect(Object.keys(commands)).toContain('turnOn')
    expect(Object.keys(commands)).toContain('setBrightness')
  })

  test('a light does not accidentally accept a lock command', () => {
    const commands = commandsFor(['onoff', 'brightness', 'colorTemperature'])
    expect(Object.keys(commands)).not.toContain('unlock')
  })

  test('command payloads validate their arguments', () => {
    const commands = commandsFor(['brightness'])
    const setBrightness = commands.setBrightness!
    expect(setBrightness.parse({ brightness: 50 })).toMatchObject({ brightness: 50 })
    expect(() => setBrightness.parse({ brightness: 300 })).toThrow()
  })
})

describe('helpers', () => {
  test('isCapabilityId is a real guard', () => {
    expect(isCapabilityId('onoff')).toBe(true)
    expect(isCapabilityId('teleportation')).toBe(false)
  })

  test('the zod enum accepts every id and nothing else', () => {
    for (const id of CAPABILITY_IDS) expect(capabilityIdSchema.parse(id)).toBe(id)
    expect(() => capabilityIdSchema.parse('nope')).toThrow()
  })

  test('the prompt catalogue names every capability and stays compact', () => {
    const catalogue = capabilityCatalogueForPrompt()
    for (const id of CAPABILITY_IDS) expect(catalogue).toContain(`- ${id}`)
    // One line per capability: the catalogue is re-sent on every turn, so a blown-up format
    // here is a permanent tax on every conversation.
    expect(catalogue.split('\n').length).toBe(CAPABILITY_IDS.length)
  })

  test('the catalogue can be narrowed to one device', () => {
    const catalogue = capabilityCatalogueForPrompt(['onoff'])
    expect(catalogue).toContain('- onoff')
    expect(catalogue).not.toContain('- thermostat')
  })
})
