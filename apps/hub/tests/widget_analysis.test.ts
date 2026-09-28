/**
 * "Analyse la courbe d'humidité du dernier mois."
 *
 * That sentence is the whole point of this file. It asks for four things the dashboard did
 * not do before: a window measured in weeks rather than hours, points bucketed coarsely
 * enough to draw, statistics over the window, and a verdict in French. Each one is tested
 * here against real history rows, because the failure mode of a chart is not a crash - it is
 * a plausible line that means something other than what was asked.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { describeSeries, widgetService } from '#services/widget_service'
import { database } from '#db/database'
import { parseRichText, stripRichText, type Widget, type WidgetData } from '@sway-home/shared'
import { dropDatabase, freshDatabase, recordHistory, seedHouse, type TestHouse } from './helpers.ts'

let fixture: TestHouse

beforeEach(async () => {
  await freshDatabase()
  fixture = seedHouse()
  // Seeding a house writes one reading per device, the way a first adapter poll does. These
  // suites assert exact statistics over a series they control, so that reading is cleared:
  // a stray 45 % landing in today's bucket is enough to move a month's maximum.
  database().run('DELETE FROM state_history')
})

afterAll(dropDatabase)

function widget(partial: Partial<Widget>): Widget {
  return {
    id: 'w1',
    dashboardId: 'home',
    type: 'chart',
    title: 'Test',
    subtitle: null,
    icon: null,
    size: 'lg',
    position: 0,
    source: { kind: 'house' },
    options: {},
    authoredBy: 'agent',
    reason: null,
    visible: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  } as Widget
}

/**
 * `days` days of readings, one per hour, from `shape(dayIndex, hourIndex)` where day 0 is
 * the oldest. Aligned to UTC midnight because that is where the day buckets fall: seeding
 * on rolling 24-hour blocks instead would split every shape value across two buckets and
 * make the statistics untestable.
 */
function seedMonth(deviceId: string, attribute: string, days: number, shape: (day: number, hour: number) => number): void {
  const now = Date.now()
  const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate())
  for (let day = 0; day < days; day += 1) {
    const startOfDay = midnight - (days - 1 - day) * 86_400_000
    for (let hour = 0; hour < 24; hour += 1) {
      const at = startOfDay + hour * 3_600_000
      // Nothing is written in the future: a reading dated later than now is a reading no
      // window can legitimately contain.
      if (at >= now) break
      recordHistory(deviceId, attribute, shape(day, hour), new Date(at))
    }
  }
}

describe('a month of readings', () => {
  test('is bucketed by day, so the chart stays drawable', () => {
    seedMonth(fixture.devices.thermostat, 'humidity', 30, () => 50)

    const data = widgetService.data(
      widget({ type: 'chart', source: { kind: 'history', deviceId: fixture.devices.thermostat, capability: null, areaId: null, attribute: 'humidity', hours: 720, offsetHours: 0, aggregate: 'avg', bucket: 'auto' } })
    )

    expect(data.kind).toBe('series')
    const series = data as Extract<WidgetData, { kind: 'series' }>
    // 30 days of hourly rows is 720 points. Daily buckets bring it to something a sparkline
    // can actually render.
    expect(series.points.length).toBeLessThanOrEqual(32)
    expect(series.points.length).toBeGreaterThanOrEqual(28)
    expect(series.bucket).toBe('day')
  })

  test('keeps the hourly grain over a day, because that is where the shape lives', () => {
    seedMonth(fixture.devices.thermostat, 'humidity', 2, (_day, hour) => 40 + hour)

    const data = widgetService.data(
      widget({ source: { kind: 'history', deviceId: fixture.devices.thermostat, capability: null, areaId: null, attribute: 'humidity', hours: 24, offsetHours: 0, aggregate: 'avg', bucket: 'auto' } })
    )
    const series = data as Extract<WidgetData, { kind: 'series' }>
    expect(series.bucket).toBe('hour')
    expect(series.points.length).toBeGreaterThan(12)
  })

  test('carries the statistics the question was really about', () => {
    seedMonth(fixture.devices.thermostat, 'humidity', 30, (day) => 40 + day)

    const series = widgetService.data(
      widget({ source: { kind: 'history', deviceId: fixture.devices.thermostat, capability: null, areaId: null, attribute: 'humidity', hours: 720, offsetHours: 0, aggregate: 'avg', bucket: 'auto' } })
    ) as Extract<WidgetData, { kind: 'series' }>

    expect(series.min).toBeCloseTo(40, 0)
    expect(series.max).toBeCloseTo(69, 0)
    expect(series.avg).toBeCloseTo(54.5, 0)
    expect(series.count).toBe(series.points.length)
  })

  test('a rising month reads as rising, and a falling one as falling', () => {
    seedMonth(fixture.devices.thermostat, 'humidity', 30, (day) => 40 + day)
    const rising = widgetService.data(
      widget({ source: { kind: 'history', deviceId: fixture.devices.thermostat, capability: null, areaId: null, attribute: 'humidity', hours: 720, offsetHours: 0, aggregate: 'avg', bucket: 'auto' } })
    ) as Extract<WidgetData, { kind: 'series' }>
    expect(rising.trend).toBe('up')
    expect(rising.changePct).toBeGreaterThan(20)

    seedMonth(fixture.devices.motion, 'illuminance', 30, (day) => 300 - day * 5)
    const falling = widgetService.data(
      widget({ source: { kind: 'history', deviceId: fixture.devices.motion, capability: null, areaId: null, attribute: 'illuminance', hours: 720, offsetHours: 0, aggregate: 'avg', bucket: 'auto' } })
    ) as Extract<WidgetData, { kind: 'series' }>
    expect(falling.trend).toBe('down')
  })

  test('a flat month is flat, not noise amplified into a verdict', () => {
    seedMonth(fixture.devices.thermostat, 'humidity', 30, (day) => 50 + (day % 2 === 0 ? 0.2 : -0.2))
    const series = widgetService.data(
      widget({ source: { kind: 'history', deviceId: fixture.devices.thermostat, capability: null, areaId: null, attribute: 'humidity', hours: 720, offsetHours: 0, aggregate: 'avg', bucket: 'auto' } })
    ) as Extract<WidgetData, { kind: 'series' }>
    expect(series.trend).toBe('flat')
  })
})

describe('windows that end in the past', () => {
  test('"hier" excludes today', () => {
    const now = Date.now()
    // Yesterday sat at 10; today sits at 30. A window for yesterday must not see the 30.
    for (let hour = 0; hour < 24; hour += 1) recordHistory(fixture.devices.thermostat, 'humidity', 10, new Date(now - (24 + hour) * 3_600_000))
    for (let hour = 0; hour < 20; hour += 1) recordHistory(fixture.devices.thermostat, 'humidity', 30, new Date(now - hour * 3_600_000))

    const series = widgetService.data(
      widget({ source: { kind: 'history', deviceId: fixture.devices.thermostat, capability: null, areaId: null, attribute: 'humidity', hours: 24, offsetHours: 24, aggregate: 'avg', bucket: 'auto' } })
    ) as Extract<WidgetData, { kind: 'series' }>

    expect(series.max).toBeLessThan(20)
    expect(series.avg).toBeCloseTo(10, 0)
  })
})

describe('comparing two rooms', () => {
  test('returns one named line per area', () => {
    seedMonth(fixture.devices.thermostat, 'humidity', 7, () => 45) // Salon
    seedMonth(fixture.devices.motion, 'humidity', 7, () => 62) // Chambre

    const data = widgetService.data(
      widget({
        type: 'compare',
        source: {
          kind: 'compare',
          capability: 'humidity',
          attribute: 'humidity',
          areaIds: [fixture.areas.salon, fixture.areas.chambre],
          deviceIds: [],
          hours: 168,
          offsetHours: 0,
          aggregate: 'avg',
        },
      })
    )

    expect(data.kind).toBe('multi-series')
    const multi = data as Extract<WidgetData, { kind: 'multi-series' }>
    expect(multi.series).toHaveLength(2)
    expect(multi.series.map((entry) => entry.label).sort()).toEqual(['Chambre', 'Salon'])
    const salon = multi.series.find((entry) => entry.label === 'Salon')!
    expect(salon.avg).toBeCloseTo(45, 0)
  })

  test('an area with no readings is dropped rather than drawn as a flat zero', () => {
    seedMonth(fixture.devices.thermostat, 'humidity', 7, () => 45)
    const multi = widgetService.data(
      widget({
        type: 'compare',
        source: {
          kind: 'compare',
          capability: 'humidity',
          attribute: 'humidity',
          areaIds: [fixture.areas.salon, fixture.areas.chambre],
          deviceIds: [],
          hours: 168,
          offsetHours: 0,
          aggregate: 'avg',
        },
      })
    ) as Extract<WidgetData, { kind: 'multi-series' }>

    expect(multi.series).toHaveLength(1)
    expect(multi.series[0]!.label).toBe('Salon')
  })

  test('nothing anywhere is an empty card with a reason, not a crash', () => {
    const data = widgetService.data(
      widget({
        type: 'compare',
        source: { kind: 'compare', capability: 'airQuality', attribute: 'co2', areaIds: [fixture.areas.salon], deviceIds: [], hours: 168, offsetHours: 0, aggregate: 'avg' },
      })
    )
    expect(data.kind).toBe('empty')
  })

  test('devices can be compared directly, named by device', () => {
    seedMonth(fixture.devices.thermostat, 'temperature', 3, () => 21)
    seedMonth(fixture.devices.motion, 'temperature', 3, () => 18)

    const multi = widgetService.data(
      widget({
        type: 'compare',
        source: {
          kind: 'compare',
          capability: 'temperature',
          attribute: 'temperature',
          areaIds: [],
          deviceIds: [fixture.devices.thermostat, fixture.devices.motion],
          hours: 72,
          offsetHours: 0,
          aggregate: 'avg',
        },
      })
    ) as Extract<WidgetData, { kind: 'multi-series' }>

    expect(multi.series.map((entry) => entry.label).sort()).toEqual(['Détecteur chambre', 'Thermostat salon'])
  })
})

function monthOfHumidity(): Extract<WidgetData, { kind: 'series' }> {
  return widgetService.data(
    widget({ source: { kind: 'history', deviceId: fixture.devices.thermostat, capability: null, areaId: null, attribute: 'humidity', hours: 720, offsetHours: 0, aggregate: 'avg', bucket: 'auto' } })
  ) as Extract<WidgetData, { kind: 'series' }>
}

describe('the verdict', () => {
  test('one sentence, with the numbers in it', () => {
    seedMonth(fixture.devices.thermostat, 'humidity', 30, (day) => 40 + day)
    const series = widgetService.data(
      widget({ source: { kind: 'history', deviceId: fixture.devices.thermostat, capability: null, areaId: null, attribute: 'humidity', hours: 720, offsetHours: 0, aggregate: 'avg', bucket: 'auto' } })
    ) as Extract<WidgetData, { kind: 'series' }>

    const sentence = describeSeries(series, { label: 'humidité', unit: '%', decimals: 0, period: 'sur un mois' })
    expect(sentence).toContain('%')
    expect(sentence).toMatch(/moyenne|Moyenne/)
    expect(sentence.split(String.fromCharCode(10))).toHaveLength(1)
    expect(sentence.length).toBeLessThan(160)
    // It has to say which way it went, or it is a table read aloud rather than an analysis.
    expect(sentence).toMatch(/hausse|baisse|stable/)
  })

  test('given an icon, the average and the direction are chips in the sentence', () => {
    seedMonth(fixture.devices.thermostat, 'humidity', 30, (day) => 40 + day)
    const series = monthOfHumidity()
    const sentence = describeSeries(series, { label: 'Humidité', unit: '%', decimals: 0, period: 'sur un mois', icon: 'ph:drop', goodDirection: 'none' })
    const chips = parseRichText(sentence).filter((segment) => segment.kind === 'chip')
    expect(chips[0]).toMatchObject({ icon: 'ph:drop' })
    expect((chips[0] as { text: string }).text).toMatch(/ %$/)
    expect(chips[1]).toMatchObject({ icon: 'ph:trend-up', tone: 'default' })
    expect(stripRichText(sentence)).toMatch(/^Humidité sur un mois : \d+ % en moyenne, entre \d+ % et \d+ %, en hausse de \d+ %\.$/)
  })

  test('a rise is a warning only for a measure where up is bad news', () => {
    seedMonth(fixture.devices.thermostat, 'humidity', 30, (day) => 40 + day)
    const series = monthOfHumidity()
    const worse = describeSeries(series, { label: 'CO2', unit: 'ppm', decimals: 0, icon: 'ph:wind', goodDirection: 'down' })
    expect(parseRichText(worse).find((segment) => segment.kind === 'chip' && segment.icon === 'ph:trend-up')).toMatchObject({ tone: 'warn' })
  })

  test('decimals are French, and a flat line is said in the same sentence', () => {
    for (let hour = 1; hour <= 6; hour += 1) recordHistory(fixture.devices.thermostat, 'temperature', 19.5, new Date(Date.now() - hour * 3_600_000))
    const series = widgetService.data(
      widget({ source: { kind: 'history', deviceId: fixture.devices.thermostat, capability: null, areaId: null, attribute: 'temperature', hours: 24, offsetHours: 0, aggregate: 'avg', bucket: 'auto' } })
    ) as Extract<WidgetData, { kind: 'series' }>
    const sentence = stripRichText(describeSeries(series, { label: 'Température', unit: '°C', decimals: 1, period: 'sur 24 h', icon: 'ph:thermometer-simple' }))
    expect(sentence).toBe('Température sur 24 h : 19,5 °C en moyenne, entre 19,5 °C et 19,5 °C, stable.')
  })

  test('never invents a trend it cannot see', () => {
    recordHistory(fixture.devices.thermostat, 'humidity', 50, new Date(Date.now() - 3_600_000))
    const series = widgetService.data(
      widget({ source: { kind: 'history', deviceId: fixture.devices.thermostat, capability: null, areaId: null, attribute: 'humidity', hours: 24, offsetHours: 0, aggregate: 'avg', bucket: 'auto' } })
    ) as Extract<WidgetData, { kind: 'series' }>
    expect(series.trend).toBe('flat')
    expect(describeSeries(series, { label: 'humidité', unit: '%', decimals: 0, period: 'sur 24 h' })).toContain('50')
  })
})
