/**
 * Turns what GET /api/insights returns into AiInsightCards pages.
 *
 * The hub only ever answers the insights it has data for (`insights.all()` drops the null
 * ones), so this file never invents a card - it maps whatever kinds are present, in the
 * order the hub sent them. Types here mirror apps/hub/app/services/insights.ts's response
 * shape; they cannot import it directly (a different app), so they are kept in step by hand.
 *
 * French grammar note: a room's gender is not known from its name ("le salon", "la cuisine"),
 * so prose here never puts an article directly in front of one - it leads with the room as a
 * label (an @mention, or "X : ...") instead of guessing "le" or "la".
 */

import {
  insightCardsFormatEnergy,
  insightCardsFormatShare,
  type InsightAllocationSegment,
  type InsightAnomalyMetric,
  type InsightCardPage,
  type InsightCompareSeries,
  type InsightProseSegment,
} from '~/utils/aiInsightCards'

export interface HubInsightPoint {
  x: number
  y: number
}

export interface HubComparisonInsight {
  id: string
  kind: 'comparison'
  title: string
  subtitle: string
  value: number
  unit: string
  delta: number | null
  series: { id: string; label: string; points: HubInsightPoint[] }[]
}

export interface HubAnomalyMetric {
  id: string
  label: string
  unit: string
  points: HubInsightPoint[]
  anomalies: HubInsightPoint[]
  mean: number
}

export interface HubAnomalyInsight {
  id: string
  kind: 'anomaly'
  title: string
  subtitle: string
  areaId: string | null
  metrics: HubAnomalyMetric[]
  note: string
}

export interface HubAllocationInsight {
  id: string
  kind: 'allocation'
  title: string
  subtitle: string
  total: number
  unit: string
  segments: { id: string; label: string; value: number; share: number }[]
}

export type HubInsight = HubComparisonInsight | HubAnomalyInsight | HubAllocationInsight

// ---- French number formatting for the deltas the kit's own helpers do not cover ----------

const SIGNED_PERCENT = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' })
const signedMetricFormatters = new Map<number, Intl.NumberFormat>()

/** `delta` is a fraction (0.184 is +18.4 %), same convention as ComparisonInsight.delta. */
function formatSignedPercent(delta: number): string {
  return `${SIGNED_PERCENT.format(delta * 100)} %`
}

function formatSignedMetric(value: number, unit: string, decimals: number): string {
  let formatter = signedMetricFormatters.get(decimals)
  if (!formatter) {
    formatter = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, signDisplay: 'exceptZero' })
    signedMetricFormatters.set(decimals, formatter)
  }
  return `${formatter.format(value)} ${unit}`
}

function toPercent(share: number): number {
  return Math.round(share * 1000) / 10
}

// ---- card 1: today vs yesterday, whole house -----------------------------------------

function comparisonPage(insight: HubComparisonInsight): InsightCardPage {
  const series: InsightCompareSeries[] = insight.series.map((entry, index) => {
    const isToday = index === 0
    return {
      id: entry.id,
      name: entry.label,
      values: entry.points.map((point) => point.y),
      sub: isToday ? (insight.delta === null ? 'Comparaison indisponible' : `${formatSignedPercent(insight.delta)} vs hier`) : 'Référence de la veille',
      tone: isToday && insight.delta !== null && insight.delta >= 0 ? 'red' : 'green',
      dotClass: isToday ? 'bg-orange' : 'bg-green',
      color: isToday ? 'var(--orange)' : 'var(--green)',
    }
  })

  const prose: InsightProseSegment[] =
    insight.delta === null
      ? [{ kind: 'text', text: "Aujourd'hui, la maison a déjà consommé " }, { kind: 'strong', text: insightCardsFormatEnergy(insight.value) }, { kind: 'text', text: '.' }]
      : [
          { kind: 'text', text: "Aujourd'hui, la maison consomme " },
          { kind: 'mono', text: formatSignedPercent(insight.delta), tone: insight.delta >= 0 ? 'red' : 'green' },
          { kind: 'text', text: ' par rapport à hier, à la même heure.' },
        ]

  return {
    id: insight.id,
    kind: 'compare',
    prose,
    pill: "Comment réduire la consommation aujourd'hui ?",
    compare: { heading: 'Courbe du jour', series },
  }
}

// ---- card 2: the room whose temperature strayed furthest ------------------------------

function anomalyPage(insight: HubAnomalyInsight): InsightCardPage {
  const decimalsFor = (id: string) => (id === 'humidity' ? 0 : 1)

  const metrics: InsightAnomalyMetric[] = insight.metrics.map((metric) => ({
    key: metric.id,
    label: metric.label,
    unit: metric.unit,
    decimals: decimalsFor(metric.id),
    values: metric.points.map((point) => point.y),
    threshold: metric.mean,
  }))

  // The bottom summary always reads metrics[0] - the hub puts temperature there when present.
  const primary = insight.metrics[0]
  const last = primary?.points.at(-1)?.y ?? primary?.mean ?? 0
  const deltaLabel = primary ? formatSignedMetric(last - primary.mean, primary.unit, decimalsFor(primary.id)) : ''

  // The hub always sends the room that strayed furthest, unusual or not; only the flagged
  // points make it unusual, and the card must not say so when the note says the opposite.
  const strayed = insight.metrics.find((metric) => metric.anomalies.length > 0)

  return {
    id: insight.id,
    kind: 'anomaly',
    prose: [{ kind: 'entity', name: insight.title, dotClass: strayed ? 'bg-orange' : 'bg-green' }, { kind: 'text', text: ` - ${insight.note}` }],
    pill: strayed ? `Pourquoi cette variation dans « ${insight.title} » ?` : `Comment évolue le climat dans « ${insight.title} » ?`,
    anomaly: {
      heading: strayed ? `${insight.title} : ${strayed.label.toLowerCase()} inhabituelle` : `${insight.title} : rien d'inhabituel`,
      icon: primary && last < primary.mean ? 'ph:trend-down' : 'ph:trend-up',
      metrics,
      deltaLabel,
      baselineLabel: 'vs moyenne 7 jours',
    },
  }
}

// ---- card 3: the week's energy, by room ------------------------------------------------

/** Vivid to neutral, ranked: the biggest consumer stands out, the tail fades into grey. */
const ALLOCATION_PALETTE: { colorClass: string; toneClass: string }[] = [
  { colorClass: 'bg-orange', toneClass: 'text-orange' },
  { colorClass: 'bg-bui-accent', toneClass: 'text-bui-accent-ink' },
  { colorClass: 'bg-green', toneClass: 'text-green' },
  { colorClass: 'bg-line-strong', toneClass: 'text-ink-2' },
  { colorClass: 'bg-line', toneClass: 'text-ink-3' },
]

function allocationPage(insight: HubAllocationInsight): InsightCardPage {
  const top = insight.segments[0]

  const segments: InsightAllocationSegment[] = insight.segments.map((segment, index) => {
    const palette = ALLOCATION_PALETTE[Math.min(index, ALLOCATION_PALETTE.length - 1)]!
    const pct = toPercent(segment.share)
    return {
      name: segment.label,
      label: segment.label,
      pct,
      amount: insightCardsFormatEnergy(segment.value),
      colorClass: palette.colorClass,
      toneClass: palette.toneClass,
      description: `${insightCardsFormatShare(pct)} de la consommation de la maison sur les sept derniers jours.`,
    }
  })

  return {
    id: insight.id,
    kind: 'allocation',
    prose: top
      ? [
          { kind: 'entity', name: top.label, dotClass: 'bg-orange' },
          { kind: 'text', text: " concentre l'essentiel de la consommation - " },
          { kind: 'strong', text: insightCardsFormatShare(toPercent(top.share)) },
          { kind: 'text', text: ' du total sur sept jours.' },
        ]
      : [{ kind: 'text', text: insight.subtitle }],
    pill: top ? `Comment réduire la consommation de « ${top.label} » ?` : 'Comment réduire la consommation ?',
    allocation: { heading: top ? `${top.label} : part de la consommation` : insight.title, segments },
  }
}

/** In order, one page per insight the hub had data for - never padded, never reordered. */
export function insightsToPages(insights: HubInsight[]): InsightCardPage[] {
  return insights.map((insight) => {
    if (insight.kind === 'comparison') return comparisonPage(insight)
    if (insight.kind === 'anomaly') return anomalyPage(insight)
    return allocationPage(insight)
  })
}
