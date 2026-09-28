/**
 * Turning a widget declaration into numbers.
 *
 * One resolver per source kind, all of them reading the same tables the rest of the hub
 * reads. Nothing here evaluates anything the assistant wrote: it picks a branch from a
 * fixed set and runs a parameterised query. A widget that asks for something absent
 * resolves to an empty state with a sentence saying what is missing, never to a crash -
 * the assistant will get a source wrong sometimes, and the dashboard has to survive it.
 */

import type { CapabilityId, Device, ResolvedWidget, Widget, WidgetData, WidgetSource } from '@sway-home/shared'
import { CAPABILITIES, areaIcon, chip, deviceIcon, formatQuantity, widgetSourceSchema, type ChipTone } from '@sway-home/shared'
import { database } from '#db/database'
import { deviceRepository } from '#repositories/device_repository'
import { alerts, people, places, routines, scenes, settings } from '#repositories/store'
import { widgets } from '#repositories/widget_repository'
import { houseService, isOutdoorArea } from '#services/house'
import { queryEvents } from '#services/event_bus'

/** The tiles a new house gets. Deleted like any other, and never re-created behind the user. */
export const DEFAULT_WIDGETS: (Partial<Widget> & Pick<Widget, 'type' | 'title'>)[] = [
  { type: 'alerts', title: 'À surveiller', icon: 'ph:warning', size: 'md', authoredBy: 'system' },
  { type: 'climate', title: 'Climat', icon: 'ph:thermometer-simple', size: 'md', authoredBy: 'system' },
  { type: 'energy', title: 'Énergie', icon: 'ph:lightning', size: 'sm', authoredBy: 'system' },
  { type: 'presence', title: 'Présence', icon: 'ph:user', size: 'sm', authoredBy: 'system' },
  {
    type: 'toggle-row',
    title: 'Lumières allumées',
    icon: 'ph:lightbulb-filament',
    size: 'lg',
    authoredBy: 'system',
    source: { kind: 'filter', category: 'light', areaId: null, capability: null, state: { on: true }, online: null, limit: 12 },
  },
  { type: 'scenes', title: 'Scènes', icon: 'ph:sparkle', size: 'md', authoredBy: 'system' },
  { type: 'media', title: 'En lecture', icon: 'ph:play-circle', size: 'md', authoredBy: 'system' },
  { type: 'agent-suggestions', title: "Propositions de l'assistant", icon: 'ph:lightbulb', size: 'lg', authoredBy: 'system' },
  { type: 'timeline', title: 'Activité', icon: 'ph:pulse', size: 'lg', authoredBy: 'system' },
]

function empty(message: string): WidgetData {
  return { kind: 'empty', message }
}

function aggregate(values: number[], how: string): number | null {
  if (values.length === 0) return null
  switch (how) {
    case 'sum':
      return values.reduce((total, value) => total + value, 0)
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
    case 'count':
      return values.length
    case 'first':
      return values[0] ?? null
    default:
      return values.reduce((total, value) => total + value, 0) / values.length
  }
}

/** The devices a source points at, in one place so every widget type filters identically. */
function devicesFor(source: WidgetSource): Device[] {
  const all = deviceRepository.all({ limit: 1000 })
  switch (source.kind) {
    case 'device': {
      const device = all.find((entry) => entry.id === source.deviceId || entry.nativeId === source.deviceId)
      return device ? [device] : []
    }
    case 'capability':
      return all.filter((device) => {
        if (!device.capabilities.includes(source.capability as CapabilityId)) return false
        if (source.areaId && device.areaId !== source.areaId) return false
        if (source.category && device.category !== source.category) return false
        if (source.deviceIds.length > 0 && !source.deviceIds.includes(device.id)) return false
        return true
      })
    case 'area':
      return all.filter((device) => device.areaId === source.areaId)
    case 'filter':
      return all
        .filter((device) => {
          if (source.category && device.category !== source.category) return false
          if (source.areaId && device.areaId !== source.areaId) return false
          if (source.capability && !device.capabilities.includes(source.capability as CapabilityId)) return false
          if (source.online !== null && device.online !== source.online) return false
          for (const [key, value] of Object.entries(source.state)) {
            if (device.state[key] !== value) return false
          }
          return true
        })
        .slice(0, source.limit)
    default:
      return []
  }
}

/** The state key a capability reads from, so `capability: 'temperature'` needs no attribute. */
function attributeFor(source: WidgetSource): string | null {
  if (source.kind === 'device') return source.attribute ?? null
  if (source.kind === 'capability') {
    if (source.attribute) return source.attribute
    const spec = CAPABILITIES[source.capability as keyof typeof CAPABILITIES]
    if (!spec) return null
    // A capability's state schema names its own keys; the first one is the reading.
    const shape = (spec.state as { shape?: Record<string, unknown> }).shape
    return shape ? (Object.keys(shape)[0] ?? null) : null
  }
  return null
}

function unitFor(source: WidgetSource, fallback?: string): string | null {
  if (source.kind === 'capability') {
    const spec = CAPABILITIES[source.capability as keyof typeof CAPABILITIES]
    if (spec?.unit) return spec.unit
  }
  return fallback ?? null
}

// ---------------------------------------------------------------------------------------
// Per-type resolvers
// ---------------------------------------------------------------------------------------

function resolveMetric(widget: Widget): WidgetData {
  const source = widget.source

  if (source.kind === 'energy') {
    const since = new Date(Date.now() - source.days * 86_400_000).toISOString().slice(0, 13)
    const clauses = ['hour >= ?']
    const parameters: unknown[] = [since]
    if (source.deviceId) {
      clauses.push('device_id = ?')
      parameters.push(source.deviceId)
    }
    const row = database().get<{ kwh: number; cost: number }>(
      `SELECT SUM(kwh) AS kwh, SUM(cost) AS cost FROM energy_hourly WHERE ${clauses.join(' AND ')}`,
      parameters
    )
    const tariff = settings.get('energy', { currency: 'EUR' })
    const showCost = widget.options.unit === tariff.currency || widget.options.unit === 'EUR'
    return {
      kind: 'metric',
      value: Number(((showCost ? row?.cost : row?.kwh) ?? 0).toFixed(widget.options.decimals ?? 2)),
      unit: showCost ? tariff.currency : 'kWh',
      label: `sur ${source.days} jour${source.days > 1 ? 's' : ''}`,
    }
  }

  if (source.kind === 'history') {
    const series = resolveSeries(widget)
    if (series.kind !== 'series' || series.last === null) return empty('Pas encore de relevés pour cette mesure.')
    return { kind: 'metric', value: series.last, unit: series.unit, label: `sur ${source.hours} h` }
  }

  if (source.kind === 'house') {
    const snapshot = houseService.snapshot()
    return { kind: 'metric', value: snapshot.power.total, unit: 'W', label: 'consommation instantanée' }
  }

  const attribute = attributeFor(source)
  const list = devicesFor(source)
  if (!attribute || list.length === 0) return empty('Aucun appareil ne fournit cette mesure.')

  const numbers = list
    .map((device) => device.state[attribute])
    .filter((value): value is number => typeof value === 'number')

  if (numbers.length === 0) {
    // Not every capability is numeric: a contact sensor answers true or false.
    const booleans = list.map((device) => device.state[attribute]).filter((value) => typeof value === 'boolean')
    if (booleans.length > 0) {
      const on = booleans.filter(Boolean).length
      return { kind: 'metric', value: on, unit: `/ ${booleans.length}`, tone: on > 0 ? 'warning' : 'default' }
    }
    return empty('Aucune valeur pour le moment.')
  }

  const how = source.kind === 'capability' ? source.aggregate : 'avg'
  const value = aggregate(numbers, how)
  const decimals = widget.options.decimals ?? (how === 'count' ? 0 : 1)

  let tone: 'default' | 'success' | 'warning' | 'error' = 'default'
  if (value !== null) {
    const { warnAbove, warnBelow, criticalAbove, criticalBelow } = widget.options
    if ((criticalAbove !== undefined && value > criticalAbove) || (criticalBelow !== undefined && value < criticalBelow)) tone = 'error'
    else if ((warnAbove !== undefined && value > warnAbove) || (warnBelow !== undefined && value < warnBelow)) tone = 'warning'
  }

  return {
    kind: 'metric',
    value: value === null ? null : Number(value.toFixed(decimals)),
    unit: widget.options.unit ?? unitFor(source),
    label: list.length > 1 ? `${list.length} appareils` : list[0]?.name,
    tone,
  }
}

function resolveSeries(widget: Widget): WidgetData {
  const source = widget.source
  if (source.kind !== 'history') {
    // A chart on a live source still has history behind it: same attribute, last 24 hours.
    const attribute = attributeFor(source)
    const list = devicesFor(source)
    if (!attribute || list.length === 0) return empty('Aucune donnée à tracer.')
    return seriesFromHistory(list.map((device) => device.id), attribute, 24, 'avg', widget.options.unit ?? unitFor(source))
  }

  const ids = source.deviceId
    ? [source.deviceId]
    : devicesFor({
        kind: 'capability',
        capability: source.capability ?? '',
        areaId: source.areaId,
        category: null,
        deviceIds: [],
        aggregate: 'avg',
      }).map((device) => device.id)

  if (ids.length === 0) return empty('Aucun appareil pour cette mesure.')
  return seriesFromHistory(ids, source.attribute, source.hours, source.aggregate, widget.options.unit ?? null, source.offsetHours, source.bucket)
}

/**
 * Several lines on one chart.
 *
 * Groups are *not* filtered by declared capability, on purpose: what makes a line drawable
 * is having readings, and a device that reports humidity without advertising the capability
 * is common enough in the wild that filtering on the declaration loses real data. A group
 * with no rows drops out entirely rather than being drawn as a flat zero, which would read
 * as "this room is at 0 %" instead of "this room does not measure that".
 */
function resolveCompare(widget: Widget): WidgetData {
  const source = widget.source
  if (source.kind !== 'compare') return empty('Cette carte attend une source de comparaison.')

  const all = deviceRepository.all({ limit: 1000 })
  const groups: { id: string; label: string; deviceIds: string[] }[] = []

  if (source.areaIds.length > 0) {
    const areas = places.areas()
    for (const areaId of source.areaIds) {
      const ids = all.filter((device) => device.areaId === areaId).map((device) => device.id)
      if (ids.length > 0) groups.push({ id: areaId, label: areas.find((area) => area.id === areaId)?.name ?? 'Pièce', deviceIds: ids })
    }
  } else {
    for (const deviceId of source.deviceIds) {
      const device = all.find((entry) => entry.id === deviceId || entry.nativeId === deviceId)
      if (device) groups.push({ id: device.id, label: device.name, deviceIds: [device.id] })
    }
  }

  if (groups.length === 0) return empty('Rien à comparer : ces pièces ou ces appareils sont introuvables.')

  const unit = widget.options.unit ?? unitFor({ kind: 'capability', capability: source.capability, areaId: null, category: null, deviceIds: [], aggregate: 'avg' })
  const lines = groups
    .map((group) => ({ group, data: seriesFromHistory(group.deviceIds, source.attribute, source.hours, source.aggregate, unit, source.offsetHours) }))
    .filter((entry): entry is { group: (typeof groups)[number]; data: Extract<WidgetData, { kind: 'series' }> } => entry.data.kind === 'series')
    .map((entry) => ({
      id: entry.group.id,
      label: entry.group.label,
      points: entry.data.points,
      min: entry.data.min,
      max: entry.data.max,
      avg: entry.data.avg,
      last: entry.data.last,
    }))

  if (lines.length === 0) return empty('Pas encore d historique pour cette comparaison.')
  return { kind: 'multi-series', unit, series: lines }
}

/**
 * Rooms or devices in order: what draws the most right now, what used the most over a week,
 * the warmest room, the driest bedroom.
 *
 * Right now reads the live state of online devices - an offline plug's last reading is what
 * it drew when it dropped, not what it draws. A window reads history instead, and for power
 * that means energy: "what used the most this week" is answered in kWh, the unit of the bill.
 */
function resolveRanking(widget: Widget): WidgetData {
  const source = widget.source
  if (source.kind !== 'ranking') return empty('Cette carte attend une source de classement.')

  const areas = new Map(places.areas().map((area) => [area.id, area]))
  const candidates = deviceRepository.all({ limit: 1000 }).filter((device) => {
    if (source.areaId && device.areaId !== source.areaId) return false
    if (!source.indoor || !device.areaId) return true
    const area = areas.get(device.areaId)
    return !area || !isOutdoorArea(area)
  })

  let unit = widget.options.unit ?? unitFor({ kind: 'capability', capability: source.capability, areaId: null, category: null, deviceIds: [], aggregate: 'avg' }) ?? (source.attribute === 'power' ? 'W' : null)
  let adds = source.aggregate === 'sum'
  // Energy over the whole house is a bill, and a bill counts a device removed since: the
  // card's total has to be the figure the sentence says, not the sum of the rows it lists.
  let billTotal: number | null = null
  const readings: { device: Device; value: number }[] = []

  if (source.hours === 0) {
    for (const device of candidates) {
      const value = device.state[source.attribute]
      if (device.online && typeof value === 'number' && Number.isFinite(value)) readings.push({ device, value })
    }
  } else if (source.attribute === 'power') {
    const byDevice = energyByDevice(source.hours, source.offsetHours)
    for (const device of candidates) {
      const used = byDevice.get(device.id)
      if (used) readings.push({ device, value: used.kwh })
    }
    unit = 'kWh'
    adds = true
    if (!source.areaId && !source.indoor) billTotal = [...byDevice.values()].reduce((sum, used) => sum + used.kwh, 0)
  } else {
    const how = source.aggregate === 'sum' ? 'avg' : source.aggregate
    for (const device of candidates) {
      if (!device.capabilities.includes(source.capability as CapabilityId) && typeof device.state[source.attribute] !== 'number') continue
      const series = seriesFromHistory([device.id], source.attribute, source.hours, how, unit, source.offsetHours)
      if (series.kind !== 'series') continue
      const value = how === 'min' ? series.min : how === 'max' ? series.max : series.avg
      if (value !== null) readings.push({ device, value })
    }
  }

  if (readings.length === 0) return empty('Rien à classer : aucun appareil ne mesure cette valeur.')

  const groups = new Map<string, { id: string; label: string; icon: string; values: number[] }>()
  for (const { device, value } of readings) {
    const area = device.areaId ? areas.get(device.areaId) : undefined
    const key = source.by === 'device' ? device.id : area?.id ?? 'none'
    const group =
      groups.get(key) ??
      (source.by === 'device'
        ? { id: device.id, label: device.name, icon: deviceIcon(device), values: [] }
        : { id: key, label: area?.name ?? 'Sans pièce', icon: area ? areaIcon(area) : 'ph:house-line', values: [] })
    group.values.push(value)
    groups.set(key, group)
  }

  // Rounded once here, so the card, the sentence and a test all read the same number.
  const round = (value: number) => Number(value.toFixed(unit === 'kWh' ? 3 : 2))
  const all = [...groups.values()]
    .map((group) => ({ id: group.id, label: group.label, icon: group.icon, value: round(aggregate(group.values, adds ? 'sum' : source.aggregate) ?? 0) }))
    .sort((a, b) => (source.order === 'desc' ? b.value - a.value : a.value - b.value) || a.label.localeCompare(b.label))

  const total = adds ? round(billTotal ?? all.reduce((sum, entry) => sum + entry.value, 0)) : null
  return {
    kind: 'ranking',
    unit,
    by: source.by,
    order: source.order,
    total,
    count: all.length,
    entries: all.slice(0, source.limit).map((entry) => ({ ...entry, share: total !== null && total > 0 ? entry.value / total : total === 0 ? 0 : null })),
  }
}

/**
 * Energy per device over a window, in kWh and money.
 *
 * The hourly roll-ups first, then the raw power readings for the hours not rolled up yet -
 * the same tail `seriesFromHistory` reads, for the same reason: without it, today's figure
 * lags an hour behind and a fresh hub reports nothing at all. The tail uses the roll-up's own
 * rule (mean power over the hour) so both halves agree, and the current hour counts only the
 * part of it that has elapsed.
 */
export function energyByDevice(hours: number, offsetHours = 0): Map<string, { kwh: number; cost: number }> {
  const now = Date.now()
  const until = new Date(now - offsetHours * 3_600_000)
  const since = new Date(until.getTime() - hours * 3_600_000)
  const sinceHour = since.toISOString().slice(0, 13)
  const untilHour = until.toISOString().slice(0, 13)
  const price = settings.get<{ pricePerKwh: number }>('energy', { pricePerKwh: 0.2516 }).pricePerKwh

  const out = new Map<string, { kwh: number; cost: number }>()
  const rolled = new Set<string>()
  const add = (deviceId: string, kwh: number, cost: number) => {
    const current = out.get(deviceId) ?? { kwh: 0, cost: 0 }
    current.kwh += kwh
    current.cost += cost
    out.set(deviceId, current)
  }

  // A window that ends now keeps its last hour; one that ended in the past stops before it.
  for (const row of database().all<{ device_id: string; hour: string; kwh: number; cost: number }>(
    `SELECT device_id, hour, kwh, cost FROM energy_hourly WHERE hour >= ? AND ${offsetHours === 0 ? 'hour <= ?' : 'hour < ?'}`,
    [sinceHour, untilHour]
  )) {
    rolled.add(`${row.device_id}|${row.hour}`)
    add(row.device_id, Number(row.kwh), Number(row.cost))
  }

  const currentHour = new Date(now).toISOString().slice(0, 13)
  for (const row of database().all<{ device_id: string; hour: string; avg_power: number }>(
    `SELECT device_id, substr(at, 1, 13) AS hour, AVG(value_num) AS avg_power
       FROM state_history
      WHERE attribute = 'power' AND value_num IS NOT NULL AND at >= ? AND at < ?
      GROUP BY device_id, hour`,
    [since.toISOString(), until.toISOString()]
  )) {
    if (rolled.has(`${row.device_id}|${row.hour}`)) continue
    const elapsed = row.hour === currentHour ? (now - Date.parse(`${row.hour}:00:00.000Z`)) / 3_600_000 : 1
    const kwh = (Number(row.avg_power) / 1000) * Math.min(1, Math.max(0, elapsed))
    add(row.device_id, kwh, kwh * price)
  }

  return out
}

type Grain = 'minute' | 'hour' | 'day'

/**
 * How wide one point is. A month of hourly readings is 720 points, which is not a chart -
 * it is a smear. The grain follows the window so a line always has between roughly twenty
 * and two hundred points, whatever was asked for.
 */
function grainFor(hours: number, requested: 'auto' | Grain): Grain {
  if (requested !== 'auto') return requested
  if (hours <= 6) return 'minute'
  if (hours <= 24 * 7) return 'hour'
  return 'day'
}

const GRAIN_KEY_LENGTH: Record<Grain, number> = { minute: 16, hour: 13, day: 10 }

interface Bucket {
  sum: number
  count: number
  min: number
  max: number
}

/** ISO 8601 back out of a truncated bucket key, so the console can format a date from it. */
function bucketInstant(key: string, grain: Grain): string {
  if (grain === 'day') return `${key}T00:00:00.000Z`
  if (grain === 'hour') return `${key}:00:00.000Z`
  return `${key}:00.000Z`
}

/**
 * Hourly roll-ups where they exist, raw history for the tail that has not been compacted
 * yet, both folded into the same buckets. Without the raw fallback a fresh chart is empty
 * for an hour after the hub starts, which reads as "broken".
 *
 * Devices are aggregated separately before being combined, because `sum` across four plugs
 * in one hour is not the sum of every sample those plugs emitted in that hour.
 */
function seriesFromHistory(
  deviceIds: string[],
  attribute: string,
  hours: number,
  how: string,
  unit: string | null,
  offsetHours = 0,
  requested: 'auto' | Grain = 'auto'
): WidgetData {
  if (deviceIds.length === 0) return empty('Aucun appareil pour cette mesure.')

  const grain = grainFor(hours, requested)
  const keyLength = GRAIN_KEY_LENGTH[grain]
  const until = new Date(Date.now() - offsetHours * 3_600_000)
  const since = new Date(until.getTime() - hours * 3_600_000)
  const placeholders = deviceIds.map(() => '?').join(',')

  const perDevice = new Map<string, Map<string, Bucket>>()
  const rolledHours = new Set<string>()

  function add(deviceId: string, at: string, value: number, low: number, high: number, samples: number): void {
    if (!Number.isFinite(value)) return
    const key = at.slice(0, keyLength)
    let buckets = perDevice.get(deviceId)
    if (!buckets) {
      buckets = new Map<string, Bucket>()
      perDevice.set(deviceId, buckets)
    }
    const current = buckets.get(key)
    if (!current) {
      buckets.set(key, { sum: value * samples, count: samples, min: low, max: high })
      return
    }
    current.sum += value * samples
    current.count += samples
    current.min = Math.min(current.min, low)
    current.max = Math.max(current.max, high)
  }

  for (const row of database().all<{ device_id: string; hour: string; min_value: number | null; max_value: number | null; avg_value: number; samples: number }>(
    `SELECT device_id, hour, min_value, max_value, avg_value, samples
       FROM sensor_hourly
      WHERE device_id IN (${placeholders}) AND attribute = ? AND hour >= ? AND hour < ?`,
    [...deviceIds, attribute, since.toISOString().slice(0, 13), until.toISOString().slice(0, 13)]
  )) {
    const average = Number(row.avg_value)
    rolledHours.add(`${row.device_id}|${row.hour}`)
    add(row.device_id, `${row.hour}:00:00.000Z`, average, Number(row.min_value ?? average), Number(row.max_value ?? average), Math.max(1, Number(row.samples) || 1))
  }

  for (const row of database().all<{ device_id: string; at: string; value: number }>(
    `SELECT device_id, at, value_num AS value
       FROM state_history
      WHERE device_id IN (${placeholders}) AND attribute = ? AND at >= ? AND at < ? AND value_num IS NOT NULL`,
    [...deviceIds, attribute, since.toISOString(), until.toISOString()]
  )) {
    // An hour already rolled up is skipped rather than added twice: the roll-up is the same
    // samples, pre-averaged, and counting both weights that hour double.
    if (rolledHours.has(`${row.device_id}|${row.at.slice(0, 13)}`)) continue
    const value = Number(row.value)
    add(row.device_id, row.at, value, value, value, 1)
  }

  const keys = [...new Set([...perDevice.values()].flatMap((buckets) => [...buckets.keys()]))].sort()
  if (keys.length === 0) return empty('Pas encore d historique pour cette mesure.')

  const points = keys
    .map((key) => {
      const readings: number[] = []
      for (const buckets of perDevice.values()) {
        const bucket = buckets.get(key)
        if (!bucket || bucket.count === 0) continue
        readings.push(how === 'min' ? bucket.min : how === 'max' ? bucket.max : bucket.sum / bucket.count)
      }
      return { at: bucketInstant(key, grain), value: aggregate(readings, how) }
    })
    .filter((point): point is { at: string; value: number } => point.value !== null && Number.isFinite(point.value))

  if (points.length === 0) return empty('Pas encore d historique pour cette mesure.')

  const values = points.map((point) => point.value)
  const average = values.reduce((total, value) => total + value, 0) / values.length
  const { trend, changePct } = trendOf(values)

  return {
    kind: 'series',
    points,
    unit,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: average,
    last: values.at(-1) ?? null,
    count: points.length,
    bucket: grain,
    trend,
    changePct,
  }
}

/**
 * Which way the line went, from the mean of its first third to the mean of its last third.
 * Thirds rather than first and last point, because one cold night at the end of a month
 * would otherwise turn a whole month into "en baisse".
 *
 * The threshold is deliberately generous: an assistant that announces a trend from noise is
 * worse than one that says "stable" a bit too often.
 */
function trendOf(values: number[]): { trend: 'up' | 'down' | 'flat'; changePct: number | null } {
  if (values.length < 4) return { trend: 'flat', changePct: null }

  const third = Math.max(1, Math.floor(values.length / 3))
  const mean = (list: number[]) => list.reduce((total, value) => total + value, 0) / list.length
  const start = mean(values.slice(0, third))
  const end = mean(values.slice(-third))
  const delta = end - start
  const spread = Math.max(...values) - Math.min(...values)
  const threshold = Math.max(Math.abs(start) * 0.02, spread * 0.05)
  const changePct = start === 0 ? null : (delta / Math.abs(start)) * 100

  if (Math.abs(delta) <= threshold) return { trend: 'flat', changePct }
  return { trend: delta > 0 ? 'up' : 'down', changePct }
}

/**
 * The one sentence that turns a chart into an answer.
 *
 * "Analyse la courbe d'humidité du dernier mois" wants a verdict, not a table: the numbers
 * that matter are the average, the range and the direction, and they fit in a line that can
 * also be spoken out loud.
 */
export function describeSeries(
  data: WidgetData,
  options: { label: string; unit: string | null; decimals?: number; period?: string; icon?: string; goodDirection?: 'up' | 'down' | 'none' }
): string {
  if (data.kind !== 'series' || data.count === 0) return 'Pas assez de relevés pour analyser.'

  const decimals = options.decimals ?? 1
  const unit = options.unit ?? data.unit
  const format = (value: number | null) => (value === null ? '?' : formatQuantity(value, unit, decimals))
  // With an icon, the two things worth finding at a glance - the level and the direction -
  // are set in the sentence as chips; without one it stays plain text for the model.
  const set = (icon: string, text: string, tone: ChipTone = 'default') => (options.icon ? chip(icon, text, tone) : text)

  const window = options.period ? ` ${options.period}` : ''
  const head = `${options.label}${window} : ${set(options.icon ?? '', format(data.avg))} en moyenne, entre ${format(data.min)} et ${format(data.max)}`

  if (data.trend === 'flat') return `${head}, stable.`
  const change = `en ${data.trend === 'up' ? 'hausse' : 'baisse'}${data.changePct === null ? '' : ` de ${Math.abs(Math.round(data.changePct))} %`}`
  // A rise is only bad news where up is the wrong way: CO2 climbing is a warning, humidity
  // climbing is a fact.
  const worse = (options.goodDirection === 'down' && data.trend === 'up') || (options.goodDirection === 'up' && data.trend === 'down')
  return `${head}, ${set(data.trend === 'up' ? 'ph:trend-up' : 'ph:trend-down', change, worse ? 'warn' : 'default')}.`
}

function resolveRows(widget: Widget): WidgetData {
  const list = devicesFor(widget.source)
  if (list.length === 0) return empty('Aucun appareil ne correspond.')
  const attribute = attributeFor(widget.source)
  return {
    kind: 'rows',
    rows: list.map((device) => ({
      id: device.id,
      label: device.name,
      value: attribute && device.state[attribute] !== undefined ? String(device.state[attribute]) : summarise(device),
      tone: device.online ? undefined : 'offline',
      to: `/devices/${device.id}`,
    })),
  }
}

function summarise(device: Device): string {
  const state = device.state
  if (typeof state.on === 'boolean') return state.on ? 'allumé' : 'éteint'
  if (typeof state.temperature === 'number') return `${state.temperature} °C`
  if (typeof state.open === 'boolean') return state.open ? 'ouvert' : 'fermé'
  if (typeof state.locked === 'boolean') return state.locked ? 'verrouillé' : 'déverrouillé'
  if (typeof state.battery === 'number') return `${state.battery} %`
  return device.online ? 'en ligne' : 'hors ligne'
}

// ---------------------------------------------------------------------------------------

export const widgetService = {
  /** Creates the starter dashboard once, and only if the user has never had one. */
  seedDefaults(): void {
    if (settings.get('dashboard.seeded', false)) return
    for (const widget of DEFAULT_WIDGETS) widgets.create(widget)
    settings.set('dashboard.seeded', true)
  },

  resolve(widget: Widget): ResolvedWidget {
    return { ...widget, data: widgetService.data(widget) }
  },

  all(dashboardId = 'home'): ResolvedWidget[] {
    return widgets
      .all(dashboardId)
      .filter((widget) => widget.visible)
      .map((widget) => widgetService.resolve(widget))
  },

  data(rawWidget: Widget): WidgetData {
    // The source is re-validated on the way in rather than trusted from the row. It reaches
    // here from three places - the seed, the REST API and a tool call the model wrote - and
    // only this parse fills in the defaults the resolvers read (`deviceIds`, `areaId`...).
    const parsed = widgetSourceSchema.safeParse(rawWidget.source)
    if (!parsed.success) {
      return empty(`Source invalide: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'kind'} ${issue.message}`).join('; ')}`)
    }
    const widget: Widget = { ...rawWidget, source: parsed.data }

    try {
      switch (widget.type) {
        case 'metric':
        case 'gauge':
          return resolveMetric(widget)

        case 'compare':
          return resolveCompare(widget)

        case 'ranking':
          return resolveRanking(widget)

        case 'chart':
          return resolveSeries(widget)

        case 'devices':
        case 'toggle-row':
          return { kind: 'devices', deviceIds: devicesFor(widget.source).map((device) => device.id) }

        case 'list':
          return resolveRows(widget)

        case 'room': {
          const areaId = widget.source.kind === 'area' ? widget.source.areaId : null
          if (!areaId) return empty('Cette carte n est rattachée à aucune pièce.')
          return { kind: 'devices', deviceIds: devicesFor({ kind: 'area', areaId }).map((device) => device.id) }
        }

        case 'alerts': {
          const open = alerts.open()
          if (open.length === 0) return { kind: 'rows', rows: [] }
          return {
            kind: 'rows',
            rows: open.map((alert) => ({
              id: alert.id,
              label: alert.title,
              value: alert.detail ?? '',
              tone: alert.severity,
              to: alert.subjectId ? `/devices/${alert.subjectId}` : undefined,
            })),
          }
        }

        case 'climate': {
          const snapshot = houseService.snapshot()
          return {
            kind: 'rows',
            rows: snapshot.climate
              .filter((entry) => entry.temperature !== null || entry.humidity !== null)
              .map((entry) => ({
                id: entry.area,
                label: entry.area,
                value: [
                  entry.temperature !== null ? `${entry.temperature.toFixed(1)} °C` : null,
                  entry.humidity !== null ? `${Math.round(entry.humidity)} %` : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
              })),
          }
        }

        case 'energy': {
          const snapshot = houseService.snapshot()
          const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 13)
          const today = database().get<{ kwh: number; cost: number }>(
            'SELECT SUM(kwh) AS kwh, SUM(cost) AS cost FROM energy_hourly WHERE hour >= ?',
            [since]
          )
          const tariff = settings.get('energy', { currency: 'EUR', pricePerKwh: 0.2516 })
          return {
            kind: 'metric',
            value: snapshot.power.total,
            unit: 'W',
            label: `${(today?.kwh ?? 0).toFixed(1)} kWh aujourd hui · ${(today?.cost ?? 0).toFixed(2)} ${tariff.currency}`,
          }
        }

        case 'presence': {
          const list = people.all()
          if (list.length === 0) return empty('Personne n est encore enregistré.')
          return {
            kind: 'rows',
            rows: list.map((person) => ({
              id: person.id,
              label: person.name,
              value: person.home ? 'à la maison' : 'absent',
              tone: person.home ? 'success' : undefined,
            })),
          }
        }

        case 'media': {
          const playing = deviceRepository
            .all({ limit: 1000 })
            .filter((device) => device.state.playback === 'playing' || typeof device.state.title === 'string')
          if (playing.length === 0) return empty('Rien en lecture.')
          return { kind: 'devices', deviceIds: playing.map((device) => device.id) }
        }

        case 'scenes': {
          const list = scenes.all()
          if (list.length === 0) return empty('Aucune scène. Réglez une pièce puis capturez son état.')
          return {
            kind: 'rows',
            rows: list.map((scene) => ({ id: scene.id, label: scene.name, value: scene.icon ?? 'ph:sparkle' })),
          }
        }

        case 'agent-suggestions': {
          const suggested = routines.all('suggested')
          if (suggested.length === 0) return empty("L'assistant n'a rien à proposer pour l'instant.")
          return {
            kind: 'rows',
            rows: suggested.map((routine) => ({
              id: routine.id,
              label: routine.name,
              value: routine.suggestionReason ?? routine.description ?? '',
              to: '/routines',
            })),
          }
        }

        case 'timeline': {
          const source = widget.source
          const events = queryEvents({
            limit: source.kind === 'events' ? source.limit : 8,
            types: source.kind === 'events' && source.types.length > 0 ? source.types : undefined,
            subjectId: source.kind === 'events' ? source.subjectId ?? undefined : undefined,
          })
          return {
            kind: 'events',
            events: events.map((event) => ({
              id: event.id,
              at: event.at,
              type: event.type,
              origin: event.origin,
              severity: event.severity,
              subjectId: event.subjectId,
              payload: event.payload,
            })),
          }
        }

        case 'note':
          return { kind: 'text', text: widget.options.text ?? '' }

        default:
          return empty('Type de widget inconnu.')
      }
    } catch (error) {
      // A widget that throws must not take the dashboard with it.
      return empty(`Cette carte n a pas pu être calculée: ${(error as Error).message}`)
    }
  },

  /** Every area, category and capability the assistant may point a widget at. */
  vocabulary(): { areas: { id: string; name: string }[]; capabilities: string[]; categories: string[] } {
    const devices = deviceRepository.all({ limit: 1000 })
    const capabilities = new Set<string>()
    const categories = new Set<string>()
    for (const device of devices) {
      for (const capability of device.capabilities) capabilities.add(capability)
      categories.add(device.category)
    }
    return {
      areas: places.areas().map((area) => ({ id: area.id, name: area.name })),
      capabilities: [...capabilities].sort(),
      categories: [...categories].sort(),
    }
  },
}
