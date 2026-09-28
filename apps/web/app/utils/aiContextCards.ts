/**
 * AiContextCards - types and pure helpers (Beautiful UI).
 *
 * What the assistant read before answering: memories, device states, routines. Cards enter
 * once (staggered, key by id) and then stay put as more context is cited over the run.
 */

/** What kind of thing was read. Badge tones are pure visual grouping, not severity - `doc`
 *  keeps the source's own PDF-is-red choice, the rest are picked for contrast, not meaning. */
export type ContextCardsKind = 'memory' | 'device' | 'routine' | 'scene' | 'doc'

export type ContextCardsItem = {
  id: string
  kind: ContextCardsKind
  title: string
  excerpt: string
  /** short trailing fact (a timestamp, a room name...); wins over `score` when both are set */
  meta?: string
  /** 0..1 confidence or similarity, shown as a percentage when there is no `meta` */
  score?: number
  href?: string
}

export type ContextCardsLabels = {
  /** heading above the count badge */
  header: string
}

export const CONTEXT_CARDS_KIND: Record<ContextCardsKind, { icon: string; label: string; tone: string }> = {
  memory: { icon: 'ph:brain', label: 'Mémoire', tone: 'bg-ink-3' },
  device: { icon: 'ph:cpu', label: 'Appareil', tone: 'bg-green' },
  routine: { icon: 'ph:flow-arrow', label: 'Routine', tone: 'bg-orange' },
  scene: { icon: 'ph:sparkle', label: 'Scène', tone: 'bg-ink-3' },
  doc: { icon: 'ph:file-text', label: 'Document', tone: 'bg-red' },
}

/** "92 %", French-formatted, for a 0..1 confidence score. */
export function contextCardsScoreLabel(score: number): string {
  return new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 0 }).format(score)
}

/** The card bar's trailing text: `meta` if the caller set one, else the score as a
 *  percentage, else nothing. */
export function contextCardsTrailing(item: ContextCardsItem): string {
  if (item.meta) return item.meta
  if (typeof item.score === 'number') return contextCardsScoreLabel(item.score)
  return ''
}
