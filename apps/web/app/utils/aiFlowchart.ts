/**
 * FLOWCHART types and layout helpers (Beautiful UI, source 15_Flowchart.tsx).
 *
 * The source draws exactly two hard-coded cards (a Trigger and an If/Else condition).
 * A Sway routine (packages/shared/src/automation.ts) has any number of OR-ed triggers,
 * one set of AND-ed top-level conditions (shown as chip rows in a single condition card),
 * then N actions that run strictly in sequence - there is no if/else action. So nodes carry
 * a `row` and edges are derived from rows instead of being hand-listed: every node in row i
 * connects to every node in row i + 1, which draws OR-ed triggers converging on one
 * condition card, then a straight chain down the action cards.
 */

export type FlowchartConditionOption = {
  name: string
  tag?: string
}

/** One cell of a condition row: fixed words, a static source chip, or a dropdown. */
export type FlowchartConditionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'source'; icon: string; text: string }
  | {
      kind: 'select'
      id: string
      value: string
      options: FlowchartConditionOption[]
      width: string
      align?: 'left' | 'right'
      dot?: boolean
    }

export type FlowchartConditionRow = {
  id: string
  /** "Si" on the first row, "et" after, unless set - see flowchartRowConnector. */
  connector?: string
  segments: FlowchartConditionSegment[]
}

export type FlowchartNodeKind = {
  label: string
  hue: string
}

export type FlowchartNode = {
  id: string
  /** 0 = trigger row, 1 = condition row, 2..n = action rows, run in that order. */
  row: number
  /** 0-1, center of the card as a fraction of the canvas width, like the source. */
  x: number
  w: number
  kind?: FlowchartNodeKind
  /** Icon tint for a step card (trigger/action); unused by condition cards. */
  hue?: string
  icon?: string
  title?: string
  caption?: string
  condition?: { rows: FlowchartConditionRow[] }
}

export type FlowchartEdge = {
  from: string
  to: string
}

export const FLOWCHART_PAD_Y = 24
export const FLOWCHART_ROW_GAP = 64
export const FLOWCHART_PILL_OFFSET = 30
export const FLOWCHART_FALLBACK_HEIGHT = 90

/** Same helper as the source: blend a hue into a theme base so it reads in both themes. */
export function flowchartMix(hue: string, pct: number, base = 'var(--surface)'): string {
  return `color-mix(in srgb, ${hue} ${pct}%, ${base})`
}

export function flowchartRows(nodes: FlowchartNode[]): number[] {
  return [...new Set(nodes.map((node) => node.row))].sort((a, b) => a - b)
}

/** Row i joins row i + 1, node to node - OR-ed triggers fan into the single condition card. */
export function flowchartEdges(nodes: FlowchartNode[]): FlowchartEdge[] {
  const rows = flowchartRows(nodes)
  const edges: FlowchartEdge[] = []
  for (let i = 0; i < rows.length - 1; i += 1) {
    const from = nodes.filter((node) => node.row === rows[i])
    const to = nodes.filter((node) => node.row === rows[i + 1])
    for (const a of from) {
      for (const b of to) edges.push({ from: a.id, to: b.id })
    }
  }
  return edges
}

export type FlowchartRowLayout = {
  rows: number[]
  rowHeight: number[]
  rowY: number[]
  canvasHeight: number
}

/** Row Y offsets from measured card heights - the same accumulation as the source. */
export function flowchartRowLayout(nodes: FlowchartNode[], heights: Record<string, number>): FlowchartRowLayout {
  const rows = flowchartRows(nodes)
  const rowHeight = rows.map((row) =>
    Math.max(...nodes.filter((node) => node.row === row).map((node) => heights[node.id] ?? FLOWCHART_FALLBACK_HEIGHT))
  )
  const rowY: number[] = []
  rows.forEach((_, i) => {
    rowY[i] = i === 0 ? FLOWCHART_PAD_Y : rowY[i - 1]! + rowHeight[i - 1]! + FLOWCHART_ROW_GAP
  })
  const lastRow = rows.length - 1
  const canvasHeight = lastRow >= 0 ? rowY[lastRow]! + rowHeight[lastRow]! + FLOWCHART_PAD_Y : FLOWCHART_PAD_Y * 2
  return { rows, rowHeight, rowY, canvasHeight }
}

export function flowchartClamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Same cubic-bezier shape as the source: a vertical S-curve between two anchor points. */
export function flowchartBezier(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const k = flowchartClamp(Math.abs(to.y - from.y) * 0.55, 24, 84)
  return `M ${from.x} ${from.y} C ${from.x} ${from.y + k}, ${to.x} ${to.y - k}, ${to.x} ${to.y}`
}

export function flowchartRowConnector(row: FlowchartConditionRow, index: number): string {
  return row.connector ?? (index === 0 ? 'Si' : 'et')
}

/**
 * Default icon per trigger/action kind, for callers that build nodes straight from a
 * Sway routine and do not want to pick an icon for every node themselves. Keyed loosely
 * (not against the zod union) so this file stays usable without importing automation.ts.
 */
export const FLOWCHART_TRIGGER_ICON: Record<string, string> = {
  device_state: 'ph:cpu',
  device_event: 'ph:lightning-a',
  capability_state: 'ph:sliders-horizontal',
  time: 'ph:alarm',
  cron: 'ph:calendar',
  sun: 'ph:sun-dim',
  presence: 'ph:users',
  house_mode: 'ph:house-line',
  interval: 'ph:timer',
  webhook: 'ph:webhooks-logo',
  voice_intent: 'ph:microphone',
  manual: 'ph:cursor-click',
}

export const FLOWCHART_ACTION_ICON: Record<string, string> = {
  device_command: 'ph:sliders-horizontal',
  scene: 'ph:film-strip',
  delay: 'ph:hourglass',
  notify: 'ph:chat-circle-dots',
  speak: 'ph:speaker-high',
  set_house_mode: 'ph:house-line',
  run_routine: 'ph:flow-arrow',
  webhook: 'ph:webhooks-logo',
  ask_agent: 'ph:robot',
  wait_until: 'ph:hourglass',
  stop: 'ph:flag',
}

export const FLOWCHART_DEFAULT_ICON = 'ph:flow-arrow'
