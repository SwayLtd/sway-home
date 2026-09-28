/**
 * AiToolChips - types and pure helpers (Beautiful UI).
 */

export type ToolChipsStatus = 'running' | 'ok' | 'failed'

/** One line of expanded detail, under a row or inside a change chip's hover preview. */
export interface ToolChipsDetailLine {
  text: string
  tone?: 'add' | 'del' | 'ctx'
}

/**
 * A tool call (or reasoning step) row. `icon` is a Phosphor icon name suffix (e.g.
 * "lightbulb", "thermometer"); the special value "think" keeps the kit's bespoke sparkle
 * glyph instead of a Phosphor icon, for a reasoning-only row.
 */
export interface ToolChipsStep {
  id: string
  icon: 'think' | (string & {})
  label: string
  chip?: string
  mono?: boolean
  status?: ToolChipsStatus
  detail?: ToolChipsDetailLine[]
}

/**
 * A change chip summarising what a tool call changed: a before/after state
 * ("on" -> "off") or an add/remove count, like the source's file-diff chips.
 */
export interface ToolChipsChange {
  id: string
  label: string
  before?: string
  after?: string
  add?: number
  del?: number
  detail?: ToolChipsDetailLine[]
}

/** Default run header, live-counted from however many steps have streamed in so far. */
export function toolChipsHeaderLabel(count: number): string {
  return count === 1 ? "1 appel d'outil" : `${count} appels d'outils`
}
