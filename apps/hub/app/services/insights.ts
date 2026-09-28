/**
 * The insight cards: three readings of the house, each small enough for a chart in a card.
 *
 *  - **comparison**: energy used today against yesterday, as two cumulative curves on today's
 *    clock, and how far today is ahead or behind at this hour.
 *  - **anomaly**: the room whose temperature strayed furthest from its own week over the
 *    last two days, with the hours that stand out marked on the curve.
 *  - **allocation**: where the week's energy went, room by room.
 *
 * They are read from the hourly roll-ups. Those are keyed by UTC hour ('YYYY-MM-DDTHH'); every
 * day and hour shown to a person is local. A card with nothing to show is not returned: an
 * empty chart in a carousel is a card nobody needed.
 */

import { database } from '#db/database'
import { deviceRepository } from '#repositories/device_repository'
import { places } from '#repositories/store'

export interface InsightPoint {
  /** Milliseconds since the epoch, on the clock the card is drawn on. */
  x: number
  y: number
}

export interface InsightSeries {
  id: string
  label: string
  points: InsightPoint[]
}

export interface ComparisonInsight {
  id: 'energy-today'
  kind: 'comparison'
  title: string
  subtitle: string
  value: number
  unit: string
  /** Today against yesterday at the same hour, as a fraction: 0.2 is 20 % more. */
  delta: number | null
  series: InsightSeries[]
}

export interface AnomalyMetric {
  id: string
  label: string
  unit: string
  points: InsightPoint[]
  anomalies: InsightPoint[]
  mean: number
}

export interface AnomalyInsight {
  id: 'climate-anomaly'
  kind: 'anomaly'
  title: string
  subtitle: string
  areaId: string | null
  metrics: AnomalyMetric[]
  note: string
}

export interface AllocationInsight {
  id: 'energy-split'
  kind: 'allocation'
  title: string
  subtitle: string
  total: number
  unit: string
  segments: { id: string; label: string; value: number; share: number }[]
}

export type Insight = ComparisonInsight | AnomalyInsight | AllocationInsight

const HOUR = 3_600_000
const NUMBER = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })
/** How far from the week's mean an hour must be, in standard deviations, to be unusual. */
const UNUSUAL = 2.5
/** Below this spread a room is simply steady, and a tenth of a degree is not a spike. */
const MIN_SPREAD = 0.3

function startOfLocalDay(now: Date, daysAgo = 0): Date {
  const day = new Date(now)
  day.setDate(day.getDate() - daysAgo)
  day.setHours(0, 0, 0, 0)
  return day
}

function key(date: Date): string {
  return date.toISOString().slice(0, 13)
}

function parseKey(hour: string): number {
  return Date.parse(`${hour}:00:00.000Z`)
}

/** Energy of the whole house per hour key, between two instants. */
function energyByHour(from: Date, to: Date): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of database().all<{ hour: string; kwh: number }>(
    'SELECT hour, SUM(kwh) AS kwh FROM energy_hourly WHERE hour >= ? AND hour < ? GROUP BY hour',
    [key(from), key(to)]
  )) {
    out.set(row.hour, Number(row.kwh))
  }
  return out
}

/** A cumulative curve over the local hours of one day, drawn on today's clock. */
function cumulative(byHour: Map<string, number>, day: Date, hours: number, shiftMs: number): InsightPoint[] {
  const points: InsightPoint[] = []
  let total = 0
  for (let hour = 0; hour < hours; hour += 1) {
    const at = new Date(day)
    at.setHours(hour)
    total += byHour.get(key(at)) ?? 0
    points.push({ x: at.getTime() + shiftMs, y: Math.round(total * 1000) / 1000 })
  }
  return points
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

function deviation(values: number[], average: number): number {
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)))
}

export const insights = {
  energyComparison(now: Date): ComparisonInsight | null {
    const today = startOfLocalDay(now)
    const yesterday = startOfLocalDay(now, 1)
    const byHour = energyByHour(yesterday, new Date(now.getTime() + HOUR))
    if (byHour.size === 0) return null

    const hoursToday = now.getHours() + 1
    const todayCurve = cumulative(byHour, today, hoursToday, 0)
    const dayMs = today.getTime() - yesterday.getTime()
    const yesterdayCurve = cumulative(byHour, yesterday, 24, dayMs)

    const value = todayCurve.at(-1)?.y ?? 0
    const sameTime = yesterdayCurve[hoursToday - 1]?.y ?? 0
    return {
      id: 'energy-today',
      kind: 'comparison',
      title: 'Consommation',
      subtitle: "Aujourd'hui et hier, à la même heure",
      value,
      unit: 'kWh',
      delta: sameTime > 0 ? value / sameTime - 1 : null,
      series: [
        { id: 'today', label: "Aujourd'hui", points: todayCurve },
        { id: 'yesterday', label: 'Hier', points: yesterdayCurve },
      ],
    }
  },

  anomaly(now: Date): AnomalyInsight | null {
    const weekStart = startOfLocalDay(now, 7)
    const recentStart = new Date(now.getTime() - 48 * HOUR)
    const rows = database().all<{ device_id: string; attribute: string; hour: string; avg_value: number }>(
      `SELECT device_id, attribute, hour, avg_value FROM sensor_hourly
        WHERE attribute IN ('temperature', 'humidity') AND hour >= ? AND avg_value IS NOT NULL
        ORDER BY hour`,
      [key(weekStart)]
    )
    if (rows.length === 0) return null

    const series = new Map<string, InsightPoint[]>()
    for (const row of rows) {
      const id = `${row.device_id}|${row.attribute}`
      const points = series.get(id) ?? []
      points.push({ x: parseKey(row.hour), y: Number(row.avg_value) })
      series.set(id, points)
    }

    // The temperature sensor whose last two days strayed furthest from its own week.
    let best: { deviceId: string; score: number } | null = null
    for (const [id, points] of series) {
      const [deviceId, attribute] = id.split('|') as [string, string]
      if (attribute !== 'temperature') continue
      const values = points.map((point) => point.y)
      const average = mean(values)
      const spread = Math.max(deviation(values, average), MIN_SPREAD)
      const score = Math.max(0, ...points.filter((point) => point.x >= recentStart.getTime()).map((point) => Math.abs(point.y - average) / spread))
      if (!best || score > best.score) best = { deviceId, score }
    }
    if (!best) return null

    const device = deviceRepository.find(best.deviceId)
    const area = device?.areaId ? places.areas().find((candidate) => candidate.id === device.areaId) ?? null : null

    const metric = (attribute: 'temperature' | 'humidity', label: string, unit: string): AnomalyMetric | null => {
      const points = series.get(`${best!.deviceId}|${attribute}`)
      if (!points?.length) return null
      const values = points.map((point) => point.y)
      const average = mean(values)
      const spread = Math.max(deviation(values, average), MIN_SPREAD)
      const recent = points.filter((point) => point.x >= recentStart.getTime())
      return {
        id: attribute,
        label,
        unit,
        points: recent,
        anomalies: recent.filter((point) => Math.abs(point.y - average) / spread >= UNUSUAL),
        mean: Math.round(average * 10) / 10,
      }
    }

    const metrics = [metric('temperature', 'Température', '°C'), metric('humidity', 'Humidité', '%')].filter((entry): entry is AnomalyMetric => entry !== null)
    const peak = metrics[0]?.anomalies.reduce<InsightPoint | null>((top, point) => (!top || Math.abs(point.y - metrics[0]!.mean) > Math.abs(top.y - metrics[0]!.mean) ? point : top), null)

    let note = "Rien d'inhabituel sur deux jours."
    if (peak) {
      const at = new Date(peak.x)
      const day = at.getTime() >= startOfLocalDay(now).getTime() ? "aujourd'hui" : 'hier'
      const word = peak.y >= (metrics[0]?.mean ?? 0) ? 'Pic' : 'Creux'
      note = `${word} inhabituel ${day} à ${at.getHours()} h : ${NUMBER.format(peak.y)} °C.`
    }

    return {
      id: 'climate-anomaly',
      kind: 'anomaly',
      title: area?.name ?? device?.name ?? 'Température',
      subtitle: `Deux derniers jours, moyenne de la semaine ${NUMBER.format(metrics[0]?.mean ?? 0)} °C`,
      areaId: area?.id ?? null,
      metrics,
      note,
    }
  },

  energySplit(now: Date): AllocationInsight | null {
    const since = startOfLocalDay(now, 7)
    const rows = database().all<{ device_id: string; kwh: number }>(
      'SELECT device_id, SUM(kwh) AS kwh FROM energy_hourly WHERE hour >= ? GROUP BY device_id',
      [key(since)]
    )
    const areas = places.areas()
    const byArea = new Map<string, { label: string; value: number }>()
    for (const row of rows) {
      const device = deviceRepository.find(row.device_id)
      const area = device?.areaId ? areas.find((candidate) => candidate.id === device.areaId) : undefined
      const id = area?.id ?? 'none'
      const entry = byArea.get(id) ?? { label: area?.name ?? 'Sans pièce', value: 0 }
      entry.value += Number(row.kwh)
      byArea.set(id, entry)
    }

    const total = [...byArea.values()].reduce((sum, entry) => sum + entry.value, 0)
    if (total <= 0) return null

    const sorted = [...byArea.entries()].sort((a, b) => b[1].value - a[1].value || a[1].label.localeCompare(b[1].label, 'fr'))
    const top = sorted.slice(0, 5)
    const rest = sorted.slice(5).reduce((sum, [, entry]) => sum + entry.value, 0)
    const segments = top.map(([id, entry]) => ({ id, label: entry.label, value: Math.round(entry.value * 1000) / 1000, share: entry.value / total }))
    if (rest > 0) segments.push({ id: 'other', label: 'Autres', value: Math.round(rest * 1000) / 1000, share: rest / total })

    return {
      id: 'energy-split',
      kind: 'allocation',
      title: "Où part l'énergie",
      subtitle: 'Sept derniers jours, par pièce',
      total: Math.round(total * 1000) / 1000,
      unit: 'kWh',
      segments,
    }
  },

  all(now = new Date()): Insight[] {
    return [insights.energyComparison(now), insights.anomaly(now), insights.energySplit(now)].filter((card): card is Insight => card !== null)
  },
}
