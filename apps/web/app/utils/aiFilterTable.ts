/**
 * Types and pure helpers for FilterTable (Beautiful UI): status chips that filter a table.
 *
 * The source hard-codes three task statuses (todo/progress/done) with fixed English labels and
 * pre-computed counts. Sway's version takes rows and statuses as props - real use is a routine
 * list (à valider / active / en pause) or a job list - and counts are always derived from the
 * rows, never passed in stale.
 */

/** ai.css ships exactly three status pill looks (`.filter-status-todo/-progress/-done`, mapped
 *  to the warning/info/success theme colours). `tone` picks one; `key` and `label` are free. */
export type FilterTableTone = 'warning' | 'info' | 'success'

export const FILTER_TABLE_TONE_CLASSES: Record<FilterTableTone, string> = {
  warning: 'filter-status-todo',
  info: 'filter-status-progress',
  success: 'filter-status-done',
}

/** Solid theme tokens for the filter chip's dot - deliberately not the pale color-mix tint the
 *  pill itself uses, so the small dot still reads at a glance. */
export const FILTER_TABLE_TONE_DOTS: Record<FilterTableTone, string> = {
  warning: 'var(--color-warning)',
  info: 'var(--color-info)',
  success: 'var(--color-success)',
}

export type FilterTableStatus = { key: string; label: string; tone: FilterTableTone }

export type FilterTableRow = { id: string; label: string; date: string; status: string; owner: string }

export type FilterTableColumnLabels = { label: string; date: string; status: string; owner: string }

export const FILTER_TABLE_DEFAULT_LABELS: FilterTableColumnLabels = { label: 'Nom', date: 'Date', status: 'Statut', owner: 'Responsable' }

export const FILTER_TABLE_ALL = 'all'

/** One count per chip, "all" included, always derived from the current rows. */
export function filterTableCounts(rows: FilterTableRow[], statuses: FilterTableStatus[]): Record<string, number> {
  const counts: Record<string, number> = { [FILTER_TABLE_ALL]: rows.length }
  for (const status of statuses) counts[status.key] = rows.filter((row) => row.status === status.key).length
  return counts
}

export function filterTableIsVisible(row: FilterTableRow, filter: string): boolean {
  return filter === FILTER_TABLE_ALL || row.status === filter
}

export function filterTableStatus(statuses: FilterTableStatus[], key: string): FilterTableStatus | undefined {
  return statuses.find((status) => status.key === key)
}
