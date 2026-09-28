/**
 * LIVE CHART types and pure math (Beautiful UI's cards use the React-only `liveline`
 * package; this is what components/ai/LiveChart.vue reproduces of it in Vue: a smooth
 * line through sparse points, an optional area fill, several series sharing one scale,
 * and the index math behind the hover cursor).
 */

export type LiveChartPoint = {
  time: number
  value: number
}

export type LiveChartSeries = {
  id: string
  /** Shown in the default tooltip row; falls back to `id` when absent. */
  label?: string
  /** Sparse or dense - the chart always draws a smooth curve through whatever it gets. */
  data: LiveChartPoint[]
  /** CSS color: a token (`var(--red)`) or a literal both work, SVG resolves either. */
  color: string
  /** Area fill under the line, tinted from `color`. Defaults to true. */
  fill?: boolean
}

export type LiveChartPadding = { top?: number; right?: number; bottom?: number; left?: number }

export type LiveChartHoverPoint = {
  seriesId: string
  color: string
  point: LiveChartPoint
}

export type LiveChartHover = {
  index: number
  /** 0-1 across the plotted width, to anchor a tooltip like the source's cards do. */
  xFraction: number
  points: LiveChartHoverPoint[]
}

export type LiveChartVec = { x: number; y: number }

/** Min/max of a value list, padded a little when every value is equal (a flat line). */
export function liveChartExtent(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1]
  let min = values[0]!
  let max = values[0]!
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1
    return [min - pad, max + pad]
  }
  return [min, max]
}

/** A linear scale, domain to range, the small building block behind x/y positioning. */
export function liveChartScale(domain: [number, number], range: [number, number]): (value: number) => number {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0 || 1
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0)
}

/**
 * Catmull-Rom spline through arbitrary points, expressed as SVG cubic-bezier segments
 * (tension 1/6, the standard conversion) - this is the "smooth line from sparse points"
 * liveline advertises, reproduced without the package.
 */
export function liveChartCatmullRomPath(points: LiveChartVec[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`
  if (points.length === 2) return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`

  const last = points.length - 1
  const segments: string[] = [`M ${points[0]!.x} ${points[0]!.y}`]
  for (let i = 0; i < last; i += 1) {
    const p0 = points[Math.max(0, i - 1)]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[Math.min(last, i + 2)]!
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    segments.push(`C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`)
  }
  return segments.join(' ')
}

/** The same spline, closed down to a baseline - the area fill under a line series. */
export function liveChartAreaPath(points: LiveChartVec[], baselineY: number): string {
  if (points.length === 0) return ''
  const line = liveChartCatmullRomPath(points)
  const first = points[0]!
  const last = points[points.length - 1]!
  return `${line} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`
}

/** Nearest point index for a pointer at `fraction` (0-1) across `count` points. */
export function liveChartIndexFromFraction(fraction: number, count: number): number {
  if (count <= 0) return 0
  const clamped = Math.min(1, Math.max(0, fraction))
  return Math.round(clamped * (count - 1))
}
