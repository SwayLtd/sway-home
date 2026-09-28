/**
 * INSIGHT CARDS types and pure helpers (Beautiful UI, source 16_InsightCards.tsx).
 *
 * The source's `smooth()` / `makePoints()` / `smoothPoints()` turn a handful of numbers into
 * a dense, timestamped series for the chart - ported here unchanged. This is the resample
 * `components/ai/InsightCards.vue` runs before handing points to `<AiLiveChart>`; LiveChart
 * does its own curve fit on top of whatever it receives, sparse or dense.
 */

import type { LiveChartPoint } from '~/utils/aiLiveChart'

/* ---- prose: the short inline sentence above each card, with @mentions and coloured deltas ---- */

export type InsightProseSegment =
  | { kind: 'text'; text: string }
  | { kind: 'entity'; name: string; dotClass: string }
  | { kind: 'mono'; text: string; tone: 'red' | 'green' }
  | { kind: 'strong'; text: string }

/* ---- card 1: comparison of two (or more) series ---- */

export type InsightCompareSeries = {
  id: string
  name: string
  values: number[]
  /** A pre-formatted delta line, French, e.g. "+2,4 kWh vs moyenne". */
  sub: string
  tone: 'red' | 'green'
  dotClass: string
  color: string
}

export type InsightCompareData = {
  heading: string
  series: InsightCompareSeries[]
}

/* ---- card 2: anomaly, with toggled metrics ---- */

export type InsightAnomalyMetric = {
  key: string
  label: string
  values: number[]
  unit: string
  decimals?: number
  /** Shown next to the toggle when nothing is hovered; defaults to the metric's last value. */
  threshold?: number
}

export type InsightAnomalyData = {
  heading: string
  icon?: string
  metrics: InsightAnomalyMetric[]
  /** The bottom summary line always reflects metrics[0], like the source's "spent" line. */
  deltaLabel: string
  baselineLabel: string
}

/* ---- card 3: allocation segments ---- */

export type InsightAllocationSegment = {
  name: string
  label: string
  pct: number
  amount: string
  colorClass: string
  toneClass: string
  description: string
}

export type InsightAllocationData = {
  /** Header line, e.g. "Salon : part de la consommation" - the badge uses segments[0]. */
  heading: string
  segments: InsightAllocationSegment[]
}

/* ---- one page of the carousel ---- */

export type InsightCardKind = 'compare' | 'anomaly' | 'allocation'

export type InsightCardPage = {
  id: string
  kind: InsightCardKind
  prose: InsightProseSegment[]
  pill: string
  /** Where "voir plus" on this page should go, if anywhere - the integrator's @navigate follows it. */
  link?: string
  compare?: InsightCompareData
  anomaly?: InsightAnomalyData
  allocation?: InsightAllocationData
}

/* ---- Catmull-Rom resample: a sparse series -> a dense, smoothly curved one ---- */

/**
 * Turn a sparse series into a dense, smoothly curved one so both the line and a scrubbed
 * cursor glide instead of stepping between a handful of points.
 */
export function insightCardsSmooth(values: number[], perSegment = 9): number[] {
  if (values.length < 3) return values.slice()
  const out: number[] = []
  const n = values.length
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = values[Math.max(0, i - 1)]!
    const p1 = values[i]!
    const p2 = values[i + 1]!
    const p3 = values[Math.min(n - 1, i + 2)]!
    for (let s = 0; s < perSegment; s += 1) {
      const t = s / perSegment
      const t2 = t * t
      const t3 = t2 * t
      out.push(
        0.5 *
          (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
      )
    }
  }
  out.push(values[n - 1]!)
  return out
}

/**
 * Timestamps a value list ending "now", `gap` seconds apart. Anchored at call time on
 * purpose - a module-load constant goes stale, and once the points age past the chart
 * window the canvas renders empty.
 */
export function insightCardsMakePoints(values: number[], gap = 6): LiveChartPoint[] {
  const end = Math.floor(Date.now() / 1000)
  return values.map((value, index) => ({
    time: end - (values.length - 1 - index) * gap,
    value,
  }))
}

/** Dense, smoothed points spanning exactly `spanSecs` - same window, more resolution. */
export function insightCardsSmoothPoints(values: number[], spanSecs: number): LiveChartPoint[] {
  const dense = insightCardsSmooth(values)
  return insightCardsMakePoints(dense, spanSecs / (dense.length - 1))
}

/* ---- French number formatting (Intl.NumberFormat('fr-FR'), a decimal comma) ---- */

const percentFormatter = new Intl.NumberFormat('fr-FR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
})
const energyFormatter = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const shareFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })
const wholeFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })
const metricFormatters = new Map<number, Intl.NumberFormat>()

export function insightCardsFormatPercent(value: number): string {
  return `${percentFormatter.format(value)} %`
}

/** A plain share of a whole, no sign - an allocation segment's percentage. */
export function insightCardsFormatShare(value: number): string {
  return `${shareFormatter.format(value)} %`
}

export function insightCardsFormatEnergy(value: number): string {
  return `${energyFormatter.format(value)} kWh`
}

export function insightCardsFormatTemperature(value: number): string {
  return `${energyFormatter.format(value)} °C`
}

/** A metric value with its own unit and decimal count, e.g. `insightCardsFormatMetric(58, '%', 0)`. */
export function insightCardsFormatMetric(value: number, unit: string, decimals = 1): string {
  if (decimals === 0) return `${wholeFormatter.format(value)} ${unit}`
  let formatter = metricFormatters.get(decimals)
  if (!formatter) {
    formatter = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    metricFormatters.set(decimals, formatter)
  }
  return `${formatter.format(value)} ${unit}`
}
