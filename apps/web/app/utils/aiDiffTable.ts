/**
 * Types and pure helpers for AiDiffTable - a proposal that changes several things at once,
 * reviewed row by row before it is applied (Beautiful UI).
 */

export type DiffTableRowKind = 'add' | 'remove' | 'change'
/** Tone of the row's meta chip - reuses the same palette as AiValuePill. */
export type DiffTableTone = 'accent' | 'neutral' | 'orange' | 'green' | 'red'

export type DiffTableRow = {
  id: string
  label: string
  /** Shown for 'remove' and 'change' rows. */
  before?: string
  /** Shown for 'add' and 'change' rows. */
  after?: string
  kind: DiffTableRowKind
  /** Small chip next to the label, e.g. a room name. */
  meta?: string
  metaTone?: DiffTableTone
}

export type DiffTableLabels = {
  title: string
  hint: string
  itemHeader: string
  categoryHeader: string
  changeHeader: string
  discard: string
  discarded: string
}

export const DIFF_TABLE_DEFAULT_LABELS: DiffTableLabels = {
  title: 'Modifications proposées',
  hint: 'Cliquez les lignes pour les inclure ou les exclure',
  itemHeader: 'Élément',
  categoryHeader: 'Catégorie',
  changeHeader: 'Modification',
  discard: 'Ignorer',
  discarded: 'Proposition ignorée',
}

/** "N suppression(s)" with correct French agreement. */
export function diffTableCount(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/** How many rows are currently included, given the id -> included map. */
export function diffTableIncludedCount(rows: DiffTableRow[], included: Record<string, boolean>): number {
  return rows.reduce((total, row) => total + (included[row.id] ? 1 : 0), 0)
}

/** "2 suppressions · 1 ajout · 1 modification" - only the kinds actually present are listed. */
export function diffTableSummary(rows: DiffTableRow[], included: Record<string, boolean>): string {
  const counts: Record<DiffTableRowKind, number> = { add: 0, remove: 0, change: 0 }
  for (const row of rows) if (included[row.id]) counts[row.kind] += 1
  const parts: string[] = []
  if (counts.remove) parts.push(diffTableCount(counts.remove, 'suppression', 'suppressions'))
  if (counts.add) parts.push(diffTableCount(counts.add, 'ajout', 'ajouts'))
  if (counts.change) parts.push(diffTableCount(counts.change, 'modification', 'modifications'))
  return parts.join(' · ')
}

export function diffTableApplyLabel(n: number): string {
  return `Appliquer ${diffTableCount(n, 'modification', 'modifications')}`
}

export function diffTableAppliedLabel(n: number): string {
  return n === 1 ? `${n} modification appliquée` : `${n} modifications appliquées`
}
