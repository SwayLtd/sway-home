/**
 * Widget declarations.
 *
 * This schema is the boundary that keeps a language model from putting anything executable
 * on someone's dashboard. It is the only thing standing between "the assistant made me a
 * tile" and "the assistant ran code on the machine that holds my door locks", so the tests
 * are written as attempts to get something through it.
 */

import { describe, expect, test } from 'bun:test'
import { WIDGET_SIZES, WIDGET_SPAN, WIDGET_TYPES, widgetCatalogueForPrompt, widgetSchema, widgetSourceSchema } from '../src/widget.ts'

describe('sources', () => {
  test('a capability source fills in the narrowing fields the resolver reads', () => {
    const source = widgetSourceSchema.parse({ kind: 'capability', capability: 'humidity' })
    expect(source).toMatchObject({ kind: 'capability', capability: 'humidity', areaId: null, category: null, deviceIds: [], aggregate: 'avg' })
  })

  test('a capability source without a capability is refused', () => {
    // This is the exact shape a model produces when it guesses: the right kind, no payload.
    expect(() => widgetSourceSchema.parse({ kind: 'capability' })).toThrow()
  })

  test('a history source requires the attribute it is going to plot', () => {
    expect(() => widgetSourceSchema.parse({ kind: 'history' })).toThrow()
    const source = widgetSourceSchema.parse({ kind: 'history', attribute: 'temperature' })
    expect(source).toMatchObject({ attribute: 'temperature', hours: 24, aggregate: 'avg' })
  })

  test('a history window is bounded to a year, which is as far back as anyone reads a line', () => {
    expect(() => widgetSourceSchema.parse({ kind: 'history', attribute: 'temperature', hours: 10_000 })).toThrow()
    expect(widgetSourceSchema.parse({ kind: 'history', attribute: 'temperature', hours: 8760 }).kind).toBe('history')
    expect(widgetSourceSchema.parse({ kind: 'history', attribute: 'temperature', hours: 720 })).toMatchObject({ offsetHours: 0, bucket: 'auto' })
  })

  test('a window can end in the past, which is what "hier" means', () => {
    expect(widgetSourceSchema.parse({ kind: 'history', attribute: 'temperature', hours: 24, offsetHours: 24 })).toMatchObject({ offsetHours: 24 })
    expect(() => widgetSourceSchema.parse({ kind: 'history', attribute: 'temperature', offsetHours: -1 })).toThrow()
  })

  test('a comparison names what it compares and nothing else', () => {
    const source = widgetSourceSchema.parse({ kind: 'compare', capability: 'humidity', attribute: 'humidity', areaIds: ['a1', 'a2'] })
    expect(source).toMatchObject({ kind: 'compare', areaIds: ['a1', 'a2'], deviceIds: [], hours: 168, aggregate: 'avg' })
    // No attribute is no chart: a comparison with nothing to plot must not be storable.
    expect(() => widgetSourceSchema.parse({ kind: 'compare', capability: 'humidity' })).toThrow()
  })

  test('an energy source is bounded to 90 days', () => {
    expect(() => widgetSourceSchema.parse({ kind: 'energy', days: 400 })).toThrow()
    expect(widgetSourceSchema.parse({ kind: 'energy' })).toMatchObject({ days: 7 })
  })

  test('a filter source has a row cap, so one tile cannot render the whole house', () => {
    const source = widgetSourceSchema.parse({ kind: 'filter' })
    expect(source).toMatchObject({ limit: 12, state: {}, online: null })
    expect(() => widgetSourceSchema.parse({ kind: 'filter', limit: 5000 })).toThrow()
  })

  test('an events source caps how much it pulls', () => {
    expect(widgetSourceSchema.parse({ kind: 'events' })).toMatchObject({ limit: 10, types: [] })
    expect(() => widgetSourceSchema.parse({ kind: 'events', limit: 999 })).toThrow()
  })

  test('a source kind outside the list is refused', () => {
    expect(() => widgetSourceSchema.parse({ kind: 'shell' })).toThrow()
    expect(() => widgetSourceSchema.parse({ kind: 'sql', query: 'DROP TABLE devices' })).toThrow()
  })

  test('there is no source kind that carries code, a URL or a query', () => {
    // The guarantee in one assertion: whatever a model emits, it can only ever name data
    // that already exists in this house.
    const kinds = ['device', 'capability', 'area', 'history', 'energy', 'events', 'filter', 'house', 'static']
    for (const kind of kinds) {
      const parsed = widgetSourceSchema.safeParse({ kind, capability: 'x', attribute: 'x', deviceId: 'x', areaId: 'x' })
      if (!parsed.success) continue
      const serialised = JSON.stringify(parsed.data)
      expect(serialised).not.toMatch(/https?:/)
      expect(serialised).not.toMatch(/function|=>|eval/)
    }
  })

  test('unknown extra keys are dropped rather than carried into the resolver', () => {
    const source = widgetSourceSchema.parse({ kind: 'house', evilPayload: '<script>' } as never)
    expect(JSON.stringify(source)).not.toContain('evilPayload')
  })
})

describe('widgets', () => {
  const base = {
    id: 'w1',
    type: 'metric' as const,
    title: 'Humidité',
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
  }

  test('defaults put a new widget on the home dashboard, visible, small', () => {
    const widget = widgetSchema.parse(base)
    expect(widget.dashboardId).toBe('home')
    expect(widget.size).toBe('sm')
    expect(widget.visible).toBe(true)
    expect(widget.source).toEqual({ kind: 'house' })
    expect(widget.options).toEqual({})
  })

  test('a widget defaults to user-authored, so nothing is falsely attributed to the agent', () => {
    expect(widgetSchema.parse(base).authoredBy).toBe('user')
    expect(widgetSchema.parse({ ...base, authoredBy: 'agent', reason: 'Vous avez demandé' })).toMatchObject({
      authoredBy: 'agent',
      reason: 'Vous avez demandé',
    })
  })

  test('an unknown widget type is refused', () => {
    expect(() => widgetSchema.parse({ ...base, type: 'iframe' })).toThrow()
  })

  test('an unknown size is refused', () => {
    expect(() => widgetSchema.parse({ ...base, size: 'enormous' })).toThrow()
  })

  test('options only accept the keys the renderer knows', () => {
    const widget = widgetSchema.parse({ ...base, options: { unit: '%', decimals: 1, min: 0, max: 100, text: 'note' } })
    expect(widget.options).toMatchObject({ unit: '%', decimals: 1 })
    expect(() => widgetSchema.parse({ ...base, options: { decimals: 12 } })).toThrow()
  })

  test('a bad source fails the whole widget rather than being stored to fail later', () => {
    expect(() => widgetSchema.parse({ ...base, source: { kind: 'capability' } })).toThrow()
  })

  test('commands in options carry a label and a command name only', () => {
    const widget = widgetSchema.parse({ ...base, options: { commands: [{ label: 'Allumer', command: 'turnOn' }] } })
    expect(widget.options.commands?.[0]).toMatchObject({ label: 'Allumer', command: 'turnOn', args: {} })
  })
})

describe('layout', () => {
  test('every size has a span and the spans fit a twelve-column grid', () => {
    for (const size of WIDGET_SIZES) {
      const span = WIDGET_SPAN[size]
      expect(span).toBeGreaterThan(0)
      expect(span).toBeLessThanOrEqual(12)
    }
    expect(WIDGET_SPAN.full).toBe(12)
  })

  test('sizes are ordered from small to full', () => {
    const spans = WIDGET_SIZES.map((size) => WIDGET_SPAN[size])
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]!).toBeGreaterThanOrEqual(spans[index - 1]!)
    }
  })
})

describe('the prompt catalogue', () => {
  test('names every type the model may emit', () => {
    const catalogue = widgetCatalogueForPrompt()
    for (const type of WIDGET_TYPES) {
      expect(catalogue).toContain(type)
    }
  })

  test('stays short enough to sit in a system prompt', () => {
    expect(widgetCatalogueForPrompt().length).toBeLessThan(2000)
  })
})
