/**
 * Types and pure helpers for RecordsTable (Beautiful UI's AI spreadsheet grid).
 *
 * The source (beautifului.dev) hard-codes five gelato-shop columns. Sway's table is a real
 * spreadsheet over house data, so columns are fully data-driven: every property (name, room,
 * battery...) is a `RecordsTableColumn` with a `kind` (what it is, shown in the config popover)
 * and a `render` (how the cell draws). Rows only carry values keyed by column, never markup.
 */

// ---------------------------------------------------------------------------
// Property kinds (the "Type" picker in the column configuration popover)
// ---------------------------------------------------------------------------

export type RecordsTablePropertyKind =
  | 'text'
  | 'file'
  | 'collection'
  | 'single-select'
  | 'multi-select'
  | 'url'
  | 'reference'
  | 'json'
  | 'file-splitter'
  | 'date'
  | 'number'

export const RECORDS_PROPERTY_KIND_LABELS: Record<RecordsTablePropertyKind, string> = {
  text: 'Texte',
  file: 'Fichier',
  collection: 'Collection',
  'single-select': 'Choix unique',
  'multi-select': 'Choix multiple',
  url: 'URL',
  reference: 'Référence',
  json: 'JSON',
  'file-splitter': 'Séparateur de fichier',
  date: 'Date',
  number: 'Nombre',
}

export const RECORDS_PROPERTY_KIND_ICONS: Record<RecordsTablePropertyKind, string> = {
  text: 'ph:text-align-left',
  file: 'ph:file',
  collection: 'ph:database',
  'single-select': 'ph:check-circle',
  'multi-select': 'ph:list-checks',
  url: 'ph:link-simple',
  reference: 'ph:arrow-up-right',
  json: 'ph:brackets-curly',
  'file-splitter': 'ph:files',
  date: 'ph:calendar-blank',
  number: 'ph:hash',
}

/** The "+" new-property menu offers these kinds, like the source's NEW_PROPERTY_TYPES. Date is
 *  assignable to a column (see the demo's "dernière activité") but, faithfully to the source,
 *  is not one of the choices offered when creating a property from scratch. */
export const RECORDS_NEW_PROPERTY_KINDS: RecordsTablePropertyKind[] = [
  'text',
  'file',
  'collection',
  'single-select',
  'multi-select',
  'url',
  'reference',
  'json',
  'file-splitter',
]

/** `device` extends the source's three tool kinds (model/web/user) for a real house: state,
 *  battery and signal come from the device's own telemetry, not from a person or the model. */
export type RecordsTableToolKind = 'model' | 'web' | 'user' | 'device'

/** `model` keeps the source's bespoke 4-point sparkle path (drawn inline, not a Phosphor icon). */
export const RECORDS_TOOL_KIND_ICONS: Record<'web' | 'user' | 'device', string> = {
  web: 'ph:globe',
  user: 'ph:user',
  device: 'ph:radio',
}

// ---------------------------------------------------------------------------
// Cell rendering
// ---------------------------------------------------------------------------

export type RecordsTableRenderKind = 'text' | 'link' | 'tags' | 'status' | 'percent' | 'date'

export type RecordsTableStatusOption = { value: string; label: string; color: string; rank?: number }

export type RecordsTableDateValue = { display: string; sortValue?: number; muted?: boolean }

/** A cell's raw value; how it is drawn depends on the column's `render`. */
export type RecordsTableCellValue = string | string[] | number | RecordsTableDateValue | null | undefined

export type RecordsTableTone = 'red' | 'orange' | 'green' | 'ink'

export type RecordsTablePrompt = { before: string; chip?: string; after?: string }

export type RecordsTableFooterStat =
  | { kind: 'count' }
  | { kind: 'filled'; suffix?: string }
  | { kind: 'match'; value: string; suffix?: string }
  | { kind: 'average' }
  | { kind: 'ghost' }
  | { kind: 'none' }

export type RecordsTableColumn = {
  key: string
  label: string
  /** What the property is, shown (and editable) in the config popover's Type row. */
  kind: RecordsTablePropertyKind
  /** How the cell is drawn. Independent of `kind`: a Date kind can render as plain text, etc. */
  render: RecordsTableRenderKind
  /** Phosphor icon override; defaults to the icon for `kind`. */
  icon?: string
  width?: number
  minWidth?: number
  sortable?: boolean
  /** The sticky, checkbox-carrying identity column. Exactly one column should set this. */
  primary?: boolean
  /** Whether "Masquer" (hide/remove) is offered in the column menu. */
  removable?: boolean
  tool?: string
  toolKind?: RecordsTableToolKind
  /** Other column keys this AI property reads from. */
  inputs?: string[]
  prompt?: RecordsTablePrompt
  grounding?: boolean
  required?: boolean
  allowEmpty?: boolean
  showConfidence?: boolean
  /** Value -> label/color/rank for `render: 'status'`. */
  options?: RecordsTableStatusOption[]
  /** Tag name -> palette key override for `render: 'tags'`; unmapped names hash to a palette entry. */
  tagColors?: Record<string, string>
  /** Colour bands for `render: 'percent'`, e.g. battery under 20% shown red. */
  thresholds?: { max: number; tone: RecordsTableTone }[]
  footer?: RecordsTableFooterStat
}

export type RecordsTableRow = {
  id: string
  values: Record<string, RecordsTableCellValue>
  /** Whether the primary cell is clickable (emits `open`); default true. */
  openable?: boolean
  /** Phosphor icon shown in the primary column's mark instead of the initials letter - a
   *  device table reads better with its category icon than with a one-letter avatar. */
  icon?: string
}

/** Drives the row-by-row "resolving" animation from the outside: the parent (or the demo replaying
 *  the source's staggered timeline) shrinks `pendingIds` one row at a time. */
export type RecordsTableCalculating = { columnKey: string; pendingIds: string[] }

export type RecordsTableColumnPatch = Partial<Omit<RecordsTableColumn, 'key'>>

export type RecordsTableSortDir = 1 | -1
export type RecordsTableSort = { key: string; dir: RecordsTableSortDir }
export type RecordsTableFilter = { columnKey: string; value: string } | null

export const RECORDS_DEFAULT_COLUMN_WIDTH = 200
export const RECORDS_DEFAULT_ACTION_COLUMN_WIDTH = 100

const RECORDS_COMPACT_WIDTH_BY_RENDER: Record<RecordsTableRenderKind, number> = {
  text: 150,
  link: 150,
  tags: 160,
  status: 150,
  percent: 110,
  date: 140,
}

export function recordsColumnIcon(column: RecordsTableColumn): string {
  return column.icon ?? RECORDS_PROPERTY_KIND_ICONS[column.kind]
}

/** Compact-columns preset (table options menu), a generic analogue of the source's hard-coded
 *  per-column pixel values. */
export function recordsCompactWidths(columns: RecordsTableColumn[]): Record<string, number> {
  const widths: Record<string, number> = {}
  for (const column of columns) {
    widths[column.key] = column.primary ? 200 : RECORDS_COMPACT_WIDTH_BY_RENDER[column.render] ?? RECORDS_DEFAULT_COLUMN_WIDTH
  }
  return widths
}

export function recordsInitials(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?'
}

export function recordsDisplayText(value: RecordsTableCellValue): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return value.display
  return String(value)
}

export function recordsIsEmpty(value: RecordsTableCellValue): boolean {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  return false
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export function recordsCompareCells(a: RecordsTableCellValue, b: RecordsTableCellValue, column: RecordsTableColumn): number {
  if (column.render === 'status') {
    const rankOf = (value: RecordsTableCellValue) => column.options?.find((option) => option.value === value)?.rank ?? -1
    return rankOf(a) - rankOf(b)
  }
  if (column.render === 'percent') {
    const numberOf = (value: RecordsTableCellValue) => (typeof value === 'number' ? value : Number.NEGATIVE_INFINITY)
    return numberOf(a) - numberOf(b)
  }
  if (column.render === 'date') {
    const dateOf = (value: RecordsTableCellValue) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null)
    const da = dateOf(a)
    const db = dateOf(b)
    if (da?.sortValue != null && db?.sortValue != null) return da.sortValue - db.sortValue
  }
  return recordsDisplayText(a).localeCompare(recordsDisplayText(b), 'fr')
}

export function recordsSortRows(rows: RecordsTableRow[], sort: RecordsTableSort | null, columns: RecordsTableColumn[]): RecordsTableRow[] {
  if (!sort) return rows
  const column = columns.find((candidate) => candidate.key === sort.key)
  if (!column) return rows
  return [...rows].sort((a, b) => recordsCompareCells(a.values[sort.key], b.values[sort.key], column) * sort.dir)
}

// ---------------------------------------------------------------------------
// Filtering (the toolbar's filter menu: one column, one value)
// ---------------------------------------------------------------------------

export function recordsFilterRows(rows: RecordsTableRow[], filter: RecordsTableFilter): RecordsTableRow[] {
  if (!filter) return rows
  return rows.filter((row) => row.values[filter.columnKey] === filter.value)
}

// ---------------------------------------------------------------------------
// The row-by-row calculation animation
// ---------------------------------------------------------------------------

export function recordsIsPending(calculating: RecordsTableCalculating | null | undefined, columnKey: string, rowId: string): boolean {
  return !!calculating && calculating.columnKey === columnKey && calculating.pendingIds.includes(rowId)
}

// ---------------------------------------------------------------------------
// Tag colour (same color-mix pattern as FilterTable's status chips)
// ---------------------------------------------------------------------------

export type RecordsTableTagColor = { base: string }

/** A single mid-lightness base hue per tag; .records-tag derives background/text/border from it
 *  via color-mix() against the theme tokens, so chips adapt to light and dark automatically. */
export const RECORDS_TAG_PALETTE: Record<string, RecordsTableTagColor> = {
  amber: { base: 'oklch(0.76 0.13 70)' },
  lime: { base: 'oklch(0.77 0.16 122)' },
  yellow: { base: 'oklch(0.80 0.15 101)' },
  purple: { base: 'oklch(0.62 0.18 293)' },
  orange: { base: 'oklch(0.71 0.16 48)' },
  cyan: { base: 'oklch(0.72 0.10 221)' },
  red: { base: 'oklch(0.64 0.19 27)' },
  magenta: { base: 'oklch(0.66 0.21 323)' },
  green: { base: 'oklch(0.70 0.13 162)' },
  pink: { base: 'oklch(0.67 0.19 3)' },
}

const RECORDS_TAG_PALETTE_KEYS = Object.keys(RECORDS_TAG_PALETTE)

// ---------------------------------------------------------------------------
// Model choices (the property popover's "Outil" menu)
// ---------------------------------------------------------------------------

/** A model offered by the property popover's Tool menu. The source only ever had one model
 *  ("Sway IA"), so the `models` prop started as a plain `string[]`; a real hub lists several,
 *  each with whether it can run right now, so this object form carries that without breaking
 *  the plain-string callers (the gallery demo still passes none and gets the `['Sway IA']`
 *  default). */
export type RecordsTableModelOption = { label: string; available?: boolean; reason?: string }

export function recordsModelLabel(model: string | RecordsTableModelOption): string {
  return typeof model === 'string' ? model : model.label
}
export function recordsModelAvailable(model: string | RecordsTableModelOption): boolean {
  return typeof model === 'string' ? true : model.available !== false
}
export function recordsModelReason(model: string | RecordsTableModelOption): string | undefined {
  return typeof model === 'string' ? undefined : model.reason
}

/** Turns a list of option labels into status options, each a distinct, deterministic colour
 *  from the tag palette - used by the property popover's Choix editor and by any column built
 *  from a stored list of choices (a select-kind AI property, for instance). */
export function recordsOptionsFromLabels(labels: string[]): RecordsTableStatusOption[] {
  const palette = Object.values(RECORDS_TAG_PALETTE)
  return labels.map((label, index) => ({ value: label, label, color: palette[index % palette.length]!.base, rank: index }))
}

/** Resolves a tag's colour: an explicit override first, else a deterministic hash of its name so
 *  the same tag always lands on the same hue without a hand-curated map (unlike the source, which
 *  hand-picks a colour per literal gelato-shop tag). */
export function recordsTagColor(name: string, overrides?: Record<string, string>): RecordsTableTagColor {
  const overrideKey = overrides?.[name]
  if (overrideKey && RECORDS_TAG_PALETTE[overrideKey]) return RECORDS_TAG_PALETTE[overrideKey]
  let hash = 0
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  return RECORDS_TAG_PALETTE[RECORDS_TAG_PALETTE_KEYS[hash % RECORDS_TAG_PALETTE_KEYS.length]!]!
}

// ---------------------------------------------------------------------------
// Formatting and footer calculations
// ---------------------------------------------------------------------------

export function recordsFormatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat('fr-FR', options).format(value)
}

export function recordsPercentTone(value: number, thresholds?: { max: number; tone: RecordsTableTone }[]): RecordsTableTone {
  if (!thresholds || !thresholds.length) return 'ink'
  const sorted = [...thresholds].sort((a, b) => a.max - b.max)
  return sorted.find((threshold) => value <= threshold.max)?.tone ?? 'ink'
}

/** The tfoot value for one column, or null when it shows nothing (a plain dash) or the inert
 *  "Add calculation" ghost button - both are the caller's job to render. */
export function recordsFooterValue(column: RecordsTableColumn, rows: RecordsTableRow[]): { text: string; dot?: string } | null {
  const stat = column.footer ?? { kind: 'none' as const }

  if (stat.kind === 'count') return { text: `${recordsFormatNumber(rows.length)} enregistrements` }

  if (stat.kind === 'filled') {
    const filled = rows.filter((row) => !recordsIsEmpty(row.values[column.key])).length
    return { text: `${recordsFormatNumber(filled)}${stat.suffix ? ` ${stat.suffix}` : ''}` }
  }

  if (stat.kind === 'match') {
    const count = rows.filter((row) => row.values[column.key] === stat.value).length
    return { text: `${recordsFormatNumber(count)}${stat.suffix ? ` ${stat.suffix}` : ''}` }
  }

  if (stat.kind === 'average') {
    if (column.render === 'status' && column.options?.length) {
      const maxRank = Math.max(...column.options.map((option) => option.rank ?? 0), 1)
      const sum = rows.reduce((total, row) => total + (column.options!.find((option) => option.value === row.values[column.key])?.rank ?? 0), 0)
      const pct = rows.length ? Math.round(((sum / rows.length) / maxRank) * 100) : 0
      return { text: `${recordsFormatNumber(pct)} % en moyenne`, dot: 'var(--orange)' }
    }
    if (column.render === 'percent') {
      const values = rows.map((row) => row.values[column.key]).filter((value): value is number => typeof value === 'number')
      const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
      return { text: `${recordsFormatNumber(Math.round(average))} % en moyenne` }
    }
  }

  return null
}
