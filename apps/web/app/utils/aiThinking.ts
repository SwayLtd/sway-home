/**
 * AiThinking - types and pure helpers (Beautiful UI).
 *
 * The component itself never schedules anything: the hub streams `rows` in and flips
 * `working` to false when the run settles, and the trace reacts to those prop changes.
 */

export type ThinkingVariant = 'Steps' | 'Reasoning' | 'Search' | 'Coding'

export const THINKING_VARIANTS: ThinkingVariant[] = ['Steps', 'Reasoning', 'Search', 'Coding']

/** Tone of a Search row's leading dot; cycles when a row does not set one, like the source. */
export type ThinkingTone = 'accent' | 'orange' | 'green'

export interface ThinkingRow {
  id: string
  primary: string
  secondary?: string
  /** Render `secondary` and the add/del counts in the monospace face, e.g. a file path. */
  mono?: boolean
  add?: number
  del?: number
  /** Search rows only: internal paths route through NuxtLink, everything else opens in a new tab. */
  href?: string
  tone?: ThinkingTone
}

/** Default header labels per variant, used when a caller does not pass activeLabel/doneLabel. */
export const THINKING_LABELS: Record<ThinkingVariant, { active: string; done: string }> = {
  Steps: { active: 'Réflexion en cours', done: 'Terminé' },
  Reasoning: { active: 'Réflexion en cours', done: 'Terminé' },
  Search: { active: 'Recherche sur le web', done: 'Recherche terminée' },
  Coding: { active: 'Exécution des outils', done: 'Outils exécutés' },
}

const THINKING_DOT_CYCLE: ThinkingTone[] = ['accent', 'orange', 'green']

/** The Search dot's tone: the row's own tone, or a cycling default, as the source does. */
export function thinkingDotTone(row: ThinkingRow, index: number): ThinkingTone {
  return row.tone ?? THINKING_DOT_CYCLE[index % THINKING_DOT_CYCLE.length]!
}

/** True when a Search row's href leaves the app - those open in a new tab instead of routing. */
export function thinkingIsExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href)
}
