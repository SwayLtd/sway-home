/**
 * Resolving a widget declaration into numbers.
 *
 * Two things are being protected here. One: a declaration the assistant wrote must never be
 * able to reach anything but this house's own data. Two: a declaration that points at
 * something absent must resolve to an explanation, not to a crash and not to a plausible
 * wrong number - a tile showing 0 °C because the sensor is missing is worse than a tile
 * saying the sensor is missing.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Widget } from '@sway-home/shared'
import { alerts, people, scenes } from '#repositories/store'
import { widgets } from '#repositories/widget_repository'
import { widgetService } from '#services/widget_service'
import { deviceRepository } from '#repositories/device_repository'
import { dropDatabase, freshDatabase, recordHistory, seedHouse, type TestHouse } from './helpers.ts'

let fixture: TestHouse

/**
 * WidgetData is a discriminated union, which is right for the renderer and tiresome in a
 * test that already knows which arm it expects. `resolve` widens it once so assertions read
 * as assertions rather than as type narrowing.
 */
function resolve(widget: Widget): Record<string, any> {
  return widgetService.data(widget) as unknown as Record<string, any>
}

function declare(overrides: Partial<Widget> & Pick<Widget, 'type'>): Widget {
  const at = new Date().toISOString()
  return {
    id: 'preview',
    dashboardId: 'home',
    title: 'Test',
    subtitle: null,
    icon: null,
    size: 'sm',
    position: 0,
    source: { kind: 'house' },
    options: {},
    authoredBy: 'user',
    reason: null,
    visible: true,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as Widget
}

beforeEach(async () => {
  await freshDatabase()
  fixture = seedHouse()
})

afterAll(dropDatabase)

describe('metric', () => {
  test('averages a capability across the house', () => {
    const data = resolve(declare({ type: 'metric', source: { kind: 'capability', capability: 'humidity', areaId: null, category: null, deviceIds: [], aggregate: 'avg' } }))
    expect(data.kind).toBe('metric')
    expect(data).toMatchObject({ value: 45, unit: '%' })
  })

  test('narrows to one area', () => {
    deviceRepository.mergeState(fixture.devices.thermostat, { humidity: 80 }, null)
    const salon = resolve(declare({ type: 'metric', source: { kind: 'capability', capability: 'humidity', areaId: fixture.areas.salon, category: null, deviceIds: [], aggregate: 'avg' } }))
    expect(salon).toMatchObject({ value: 80 })
  })

  test('sums rather than averages when asked', () => {
    deviceRepository.mergeState(fixture.devices.lamp, { power: 8 }, null)
    const data = resolve(declare({ type: 'metric', source: { kind: 'capability', capability: 'power', areaId: null, category: null, deviceIds: [], aggregate: 'sum' } }))
    expect(data).toMatchObject({ value: 50 })
  })

  test('counts devices', () => {
    const data = resolve(declare({ type: 'metric', source: { kind: 'capability', capability: 'battery', areaId: null, category: null, deviceIds: [], aggregate: 'count' } }))
    expect(data).toMatchObject({ value: 3 })
  })

  test('a capability nothing reports resolves to an explanation, not to zero', () => {
    const data = resolve(declare({ type: 'metric', source: { kind: 'capability', capability: 'airQuality', areaId: null, category: null, deviceIds: [], aggregate: 'avg' } }))
    expect(data.kind).toBe('empty')
    expect(data.message).toContain('Aucun')
  })

  test('a boolean capability is counted rather than averaged', () => {
    const data = resolve(declare({ type: 'metric', source: { kind: 'capability', capability: 'waterLeak', areaId: null, category: null, deviceIds: [], aggregate: 'avg' } }))
    expect(data.kind).toBe('metric')
    expect(data).toMatchObject({ value: 0, unit: '/ 1' })
  })

  test('thresholds colour the value', () => {
    const warm = widgetService.data(
      declare({
        type: 'metric',
        source: { kind: 'capability', capability: 'humidity', areaId: null, category: null, deviceIds: [], aggregate: 'avg' },
        options: { warnAbove: 40 },
      })
    )
    expect(warm).toMatchObject({ tone: 'warning' })

    const critical = widgetService.data(
      declare({
        type: 'metric',
        source: { kind: 'capability', capability: 'humidity', areaId: null, category: null, deviceIds: [], aggregate: 'avg' },
        options: { criticalAbove: 40 },
      })
    )
    expect(critical).toMatchObject({ tone: 'error' })
  })

  test('decimals are honoured', () => {
    deviceRepository.mergeState(fixture.devices.thermostat, { humidity: 45.678 }, null)
    const data = resolve(
      declare({ type: 'metric', source: { kind: 'capability', capability: 'humidity', areaId: fixture.areas.salon, category: null, deviceIds: [], aggregate: 'avg' }, options: { decimals: 2 } })
    )
    expect(data).toMatchObject({ value: 45.68 })
  })
})

describe('chart', () => {
  test('reads history and reports the range', () => {
    const now = Date.now()
    for (let index = 0; index < 10; index += 1) {
      recordHistory(fixture.devices.thermostat, 'temperature', 18 + index * 0.5, new Date(now - (10 - index) * 60_000))
    }
    const data = resolve(
      declare({ type: 'chart', source: { kind: 'history', deviceId: fixture.devices.thermostat, capability: null, attribute: 'temperature', areaId: null, hours: 6, offsetHours: 0, bucket: 'auto', aggregate: 'avg' } })
    )
    expect(data.kind).toBe('series')
    expect(data.points!.length).toBeGreaterThan(5)
    expect(data.min).toBeCloseTo(18, 1)
    expect(data.max).toBeCloseTo(22.5, 1)
    // `last` is the most recent point in time, which here is the reading the fixture itself
    // wrote when the device first reported - not the highest value in the series.
    expect(data.last).toBe(data.points.at(-1).value)
  })

  test('an attribute that was never recorded says so rather than drawing a flat line', () => {
    const data = resolve(
      declare({ type: 'chart', source: { kind: 'history', deviceId: fixture.devices.lamp, capability: null, attribute: 'pressure', areaId: null, hours: 6, offsetHours: 0, bucket: 'auto', aggregate: 'avg' } })
    )
    expect(data.kind).toBe('empty')
  })

  test('a device that has never reported anything says so', () => {
    const data = resolve(
      declare({ type: 'chart', source: { kind: 'history', deviceId: 'no-such-device', capability: null, attribute: 'temperature', areaId: null, hours: 6, offsetHours: 0, bucket: 'auto', aggregate: 'avg' } })
    )
    expect(data.kind).toBe('empty')
  })

  test('history can be gathered by capability across devices', () => {
    const now = Date.now()
    recordHistory(fixture.devices.thermostat, 'temperature', 20, new Date(now - 60_000))
    recordHistory(fixture.devices.thermostat, 'temperature', 21, new Date(now - 30_000))
    const data = resolve(
      declare({ type: 'chart', source: { kind: 'history', deviceId: null, capability: 'temperature', attribute: 'temperature', areaId: null, hours: 6, offsetHours: 0, bucket: 'auto', aggregate: 'avg' } })
    )
    expect(data.kind).toBe('series')
  })

  test('points come back in chronological order', () => {
    const now = Date.now()
    for (let index = 0; index < 6; index += 1) {
      recordHistory(fixture.devices.thermostat, 'temperature', 20, new Date(now - index * 120_000))
    }
    const data = resolve(
      declare({ type: 'chart', source: { kind: 'history', deviceId: fixture.devices.thermostat, capability: null, attribute: 'temperature', areaId: null, hours: 6, offsetHours: 0, bucket: 'auto', aggregate: 'avg' } })
    )
    const times = data.points!.map((point: { at: string }) => point.at)
    expect([...times].sort()).toEqual(times)
  })
})

describe('device lists', () => {
  test('a filter selects by category and state', () => {
    deviceRepository.mergeState(fixture.devices.lamp, { on: true }, null)
    const data = resolve(
      declare({ type: 'toggle-row', source: { kind: 'filter', category: 'light', areaId: null, capability: null, state: { on: true }, online: null, limit: 12 } })
    )
    expect(data.kind).toBe('devices')
    expect(data.deviceIds).toEqual([fixture.devices.lamp])
  })

  test('a filter that matches nothing returns an empty list, not every device', () => {
    const data = resolve(
      declare({ type: 'toggle-row', source: { kind: 'filter', category: 'camera', areaId: null, capability: null, state: {}, online: null, limit: 12 } })
    )
    expect(data.kind).toBe('devices')
    expect(data.deviceIds).toEqual([])
  })

  test('the limit is respected', () => {
    const data = resolve(
      declare({ type: 'devices', source: { kind: 'filter', category: null, areaId: null, capability: null, state: {}, online: null, limit: 2 } })
    )
    expect(data.deviceIds!.length).toBeLessThanOrEqual(2)
  })

  test('a room widget lists what is in that room', () => {
    const data = resolve(declare({ type: 'room', source: { kind: 'area', areaId: fixture.areas.chambre } }))
    expect(data.kind).toBe('devices')
    expect(data.deviceIds).toHaveLength(2)
  })

  test('a room widget with no area explains itself', () => {
    const data = resolve(declare({ type: 'room', source: { kind: 'house' } }))
    expect(data.kind).toBe('empty')
  })
})

describe('house widgets', () => {
  test('alerts resolve to rows, and to an empty list when all is well', () => {
    expect(resolve(declare({ type: 'alerts' }))).toMatchObject({ kind: 'rows', rows: [] })
    alerts.raise({ kind: 'leak', severity: 'critical', title: 'Fuite', subjectId: fixture.devices.leak })
    const data = resolve(declare({ type: 'alerts' }))
    expect(data.rows).toHaveLength(1)
    expect(data.rows![0]).toMatchObject({ label: 'Fuite', tone: 'critical' })
  })

  test('climate lists the rooms that actually report', () => {
    const data = resolve(declare({ type: 'climate' }))
    expect(data.kind).toBe('rows')
    expect(data.rows!.some((row: { label: string }) => row.label === 'Salon')).toBe(true)
  })

  test('energy reports live draw and the day so far', () => {
    const data = resolve(declare({ type: 'energy' }))
    expect(data.kind).toBe('metric')
    expect(data).toMatchObject({ unit: 'W' })
    expect(data.label).toContain('kWh')
  })

  test('presence says who is home once someone exists', () => {
    expect(resolve(declare({ type: 'presence' })).kind).toBe('empty')
    const person = people.create({ name: 'John' })
    people.setHome(person.id, true)
    const data = resolve(declare({ type: 'presence' }))
    expect(data.rows![0]).toMatchObject({ label: 'John', value: 'à la maison' })
  })

  test('scenes list what can be activated', () => {
    expect(resolve(declare({ type: 'scenes' })).kind).toBe('empty')
    scenes.create({ name: 'Film', entries: [{ deviceId: fixture.devices.lamp, endpointId: null, state: { on: true }, transitionMs: 400 }] })
    expect(resolve(declare({ type: 'scenes' })).rows![0]).toMatchObject({ label: 'Film' })
  })

  test('a note carries its text through', () => {
    const data = resolve(declare({ type: 'note', source: { kind: 'static' }, options: { text: 'Penser au filtre' } }))
    expect(data).toMatchObject({ kind: 'text', text: 'Penser au filtre' })
  })
})

describe('validation', () => {
  test('a malformed source resolves to an explanation rather than throwing', () => {
    const data = resolve(declare({ type: 'metric', source: { kind: 'capability' } as never }))
    expect(data.kind).toBe('empty')
    expect(data.message).toContain('Source invalide')
  })

  test('an unknown source kind is refused', () => {
    const data = resolve(declare({ type: 'metric', source: { kind: 'exec', command: 'rm -rf /' } as never }))
    expect(data.kind).toBe('empty')
  })

  test('defaults missing from a stored row are filled in on the way out', () => {
    // A row written before a field existed must not crash the dashboard on read.
    const data = resolve(declare({ type: 'metric', source: { kind: 'capability', capability: 'humidity' } as never }))
    expect(data.kind).toBe('metric')
  })

  test('an unknown widget type resolves to empty rather than throwing', () => {
    expect(resolve(declare({ type: 'hologram' as never })).kind).toBe('empty')
  })
})

describe('the dashboard', () => {
  test('seeding is idempotent', () => {
    widgetService.seedDefaults()
    const first = widgets.all().length
    widgetService.seedDefaults()
    expect(widgets.all()).toHaveLength(first)
    expect(first).toBeGreaterThan(4)
  })

  test('all() resolves every visible widget in one call', () => {
    widgetService.seedDefaults()
    const resolved = widgetService.all()
    expect(resolved.length).toBeGreaterThan(4)
    for (const widget of resolved) expect(widget.data).toBeDefined()
  })

  test('a hidden widget is not returned', () => {
    const widget = widgets.create({ type: 'alerts', title: 'Caché', visible: false })
    expect(widgetService.all().some((entry) => entry.id === widget.id)).toBe(false)
  })

  test('vocabulary lists only what this house really has', () => {
    const vocabulary = widgetService.vocabulary()
    expect(vocabulary.areas.map((area) => area.name).sort()).toEqual(['Chambre', 'Salon'])
    expect(vocabulary.capabilities).toContain('humidity')
    expect(vocabulary.capabilities).not.toContain('vacuum')
    expect(vocabulary.categories).toContain('light')
  })
})
