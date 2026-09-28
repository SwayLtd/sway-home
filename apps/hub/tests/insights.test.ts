/**
 * The insight cards.
 *
 * The carousel shows three readings of the house, each drawn as a small chart:
 *
 *  - **Energy, today against yesterday**: two cumulative curves on the same clock, and how far
 *    today is ahead or behind at this hour.
 *  - **Something unusual**: the room whose temperature strayed furthest from its own week,
 *    with the hours that stand out marked on the curve.
 *  - **Where the energy went**: the week split by room.
 *
 * All three come from the hourly roll-ups, whose hours are UTC keys; days and hours shown to
 * a person are local.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { insights } from '#services/insights'
import { insertInto } from '#db/database'
import { dropDatabase, freshDatabase, makeDevice, seedHouse, type TestHouse } from './helpers.ts'

let fixture: TestHouse

beforeEach(async () => {
  await freshDatabase()
  fixture = seedHouse()
})

afterAll(dropDatabase)

/** The UTC hour key of a local hour, `daysAgo` days before today. */
function hourKey(daysAgo: number, hour: number): string {
  const at = new Date()
  at.setDate(at.getDate() - daysAgo)
  at.setHours(hour, 0, 0, 0)
  return at.toISOString().slice(0, 13)
}

function energy(deviceId: string, daysAgo: number, hour: number, kwh: number): void {
  insertInto('energy_hourly', { device_id: deviceId, hour: hourKey(daysAgo, hour), kwh, avg_power: kwh * 1000, max_power: kwh * 1000, cost: kwh * 0.25 })
}

function reading(deviceId: string, attribute: string, daysAgo: number, hour: number, value: number): void {
  insertInto('sensor_hourly', { device_id: deviceId, attribute, hour: hourKey(daysAgo, hour), min_value: value, max_value: value, avg_value: value, samples: 12 })
}

describe('energy today against yesterday', () => {
  test('two cumulative curves on today\'s clock, and the gap at this hour', () => {
    const now = new Date().getHours()
    for (let hour = 0; hour < 24; hour += 1) energy(fixture.devices.plug, 1, hour, 0.1)
    for (let hour = 0; hour <= now; hour += 1) energy(fixture.devices.plug, 0, hour, 0.2)

    const card = insights.energyComparison(new Date())

    expect(card?.kind).toBe('comparison')
    expect(card?.unit).toBe('kWh')
    expect(card?.value).toBeCloseTo(0.2 * (now + 1), 5)
    expect(card?.series.map((series) => series.label)).toEqual(["Aujourd'hui", 'Hier'])
    const [today, yesterday] = card!.series
    expect(today?.points).toHaveLength(now + 1)
    expect(yesterday?.points).toHaveLength(24)
    expect(yesterday?.points.at(-1)?.y).toBeCloseTo(2.4, 5)
    // Both curves share today's clock, so yesterday at 3:00 sits under today at 3:00.
    expect(yesterday?.points[3]?.x).toBe(today?.points[3]?.x)
    expect(card?.delta).toBeCloseTo(1, 5)
  })

  test('no energy recorded, no card', () => {
    expect(insights.energyComparison(new Date())).toBeNull()
  })
})

describe('something unusual', () => {
  test('the hour that strays from the week is marked, with a sentence about it', () => {
    for (let daysAgo = 6; daysAgo >= 1; daysAgo -= 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        if (daysAgo === 1 && hour === 21) continue
        reading(fixture.devices.thermostat, 'temperature', daysAgo, hour, 20 + (hour % 2) * 0.4)
      }
    }
    reading(fixture.devices.thermostat, 'temperature', 1, 21, 26.5)
    reading(fixture.devices.thermostat, 'humidity', 1, 21, 45)

    const card = insights.anomaly(new Date())

    expect(card?.kind).toBe('anomaly')
    expect(card?.title).toBe('Salon')
    const temperature = card?.metrics.find((metric) => metric.id === 'temperature')
    expect(temperature?.unit).toBe('°C')
    expect(temperature?.anomalies).toHaveLength(1)
    expect(temperature?.anomalies[0]?.y).toBe(26.5)
    expect(card?.note).toBe('Pic inhabituel hier à 21 h : 26,5 °C.')
  })

  test('a quiet week says so', () => {
    for (let daysAgo = 6; daysAgo >= 0; daysAgo -= 1) {
      for (let hour = 0; hour < 24; hour += 1) reading(fixture.devices.thermostat, 'temperature', daysAgo, hour, 20)
    }
    const card = insights.anomaly(new Date())
    expect(card?.metrics[0]?.anomalies).toEqual([])
    expect(card?.note).toBe("Rien d'inhabituel sur deux jours.")
  })
})

describe('where the energy went', () => {
  test('the week split by room, largest first, with each share', () => {
    const heater = makeDevice({ nativeId: 'heater', name: 'Radiateur', category: 'climate', capabilities: ['power'], areaId: null })
    energy(fixture.devices.lamp, 2, 20, 1)
    energy(fixture.devices.plug, 2, 20, 3)
    energy(heater, 3, 8, 1)

    const card = insights.energySplit(new Date())

    expect(card?.kind).toBe('allocation')
    expect(card?.total).toBeCloseTo(5, 5)
    expect(card?.segments.map((segment) => [segment.label, segment.value])).toEqual([
      ['Chambre', 3],
      ['Salon', 1],
      ['Sans pièce', 1],
    ])
    expect(card?.segments[0]?.share).toBeCloseTo(0.6, 5)
  })
})

describe('the carousel', () => {
  test('only the cards that have something to show', () => {
    energy(fixture.devices.plug, 2, 20, 3)
    const cards = insights.all(new Date())
    expect(cards.map((card) => card.kind)).toEqual(['allocation'])
  })
})
