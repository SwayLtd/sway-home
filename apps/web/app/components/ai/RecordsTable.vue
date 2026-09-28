<script setup lang="ts">
/**
 * RECORDS TABLE - an AI spreadsheet grid (Beautiful UI).
 *
 * Rows are records, columns are *properties*: click a header to open its configuration popover
 * (type, tool, grounding, inputs, prompt, run), add a new AI property from the "+" header, watch
 * cells resolve row by row while a column calculates. Fully data-driven: `columns` describes every
 * property (its type, how its cell renders, its footer stat...) and `rows` carry only values -
 * the source's five hard-coded gelato-shop columns become any number of real ones (see the demo's
 * nine device properties). The row-by-row "Calculating..." sweep is driven by the `calculating`
 * prop, not an internal timer: the parent (or the demo replaying the source's staggered timeline)
 * shrinks `pendingIds` one row at a time.
 *
 * Beyond the source: a toolbar (live-hub indicator, a filter menu over one status-like column,
 * selection clearing) and a footer scroll cue, using `.records-toolbar` / `.records-filter-*` /
 * `.records-footer*` classes the kit ships but the source's own single-page demo never exercises.
 */
const props = withDefaults(
  defineProps<{
    columns: RecordsTableColumn[]
    rows: RecordsTableRow[]
    /** Fills the parent's height, borderless, like the source's `fill`. */
    fill?: boolean
    /** v-model:selected - ids of the selected rows. */
    selected?: string[]
    /** v-model:pinned - keys of the pinned columns (cosmetic, like the source's pin). */
    pinned?: string[]
    calculating?: RecordsTableCalculating | null
    /** Models offered by the Tool picker; selecting one always sets toolKind "model". A plain
     *  string is always available (the source's single "Sway IA"); an object also carries
     *  whether it can run right now and why not, from the hub's own model picker. */
    models?: (string | RecordsTableModelOption)[]
    /** Shows the toolbar's filter menu, over the first `render: 'status'` column unless
     *  `filterColumnKey` names another one. */
    filterable?: boolean
    filterColumnKey?: string
    caption?: string
  }>(),
  {
    fill: false,
    selected: () => [],
    pinned: () => [],
    calculating: null,
    models: () => ['Sway IA'],
    filterable: true,
    filterColumnKey: undefined,
    caption: 'Tableau de données. Faites défiler horizontalement et verticalement pour voir toutes les colonnes et tous les enregistrements.',
  }
)

const emit = defineEmits<{
  'update:selected': [ids: string[]]
  'update:pinned': [keys: string[]]
  select: [rows: RecordsTableRow[]]
  open: [row: RecordsTableRow]
  addColumn: [kind: RecordsTablePropertyKind]
  removeColumn: [columnKey: string]
  updateColumn: [columnKey: string, patch: RecordsTableColumnPatch]
  runColumn: [columnKey: string]
}>()

const primaryColumn = computed(() => props.columns.find((column) => column.primary) ?? props.columns[0])
const otherColumns = computed(() => props.columns.filter((column) => column !== primaryColumn.value))
/** The primary column always renders first regardless of its position in `columns`; colgroup and
 *  the width measurement must follow that same rendered order, not the prop's raw order. */
const orderedColumns = computed(() => (primaryColumn.value ? [primaryColumn.value, ...otherColumns.value] : otherColumns.value))

function statusOption(column: RecordsTableColumn, row: RecordsTableRow) {
  return column.options?.find((option) => option.value === row.values[column.key])
}
function asTags(value: RecordsTableCellValue): string[] {
  return Array.isArray(value) ? value : []
}
function footerValue(column: RecordsTableColumn) {
  return recordsFooterValue(column, visibleRows.value)
}

// -- selection --------------------------------------------------------------
const selectedSet = computed(() => new Set(props.selected))
const allSelected = computed(() => visibleRows.value.length > 0 && visibleRows.value.every((row) => selectedSet.value.has(row.id)))
const partiallySelected = computed(() => !allSelected.value && visibleRows.value.some((row) => selectedSet.value.has(row.id)))

function emitSelection(ids: string[]) {
  emit('update:selected', ids)
  emit(
    'select',
    props.rows.filter((row) => ids.includes(row.id))
  )
}
function toggleRow(id: string) {
  const next = selectedSet.value.has(id) ? props.selected.filter((item) => item !== id) : [...props.selected, id]
  emitSelection(next)
}
function toggleAll() {
  const ids = visibleRows.value.map((row) => row.id)
  const next = allSelected.value ? props.selected.filter((id) => !ids.includes(id)) : Array.from(new Set([...props.selected, ...ids]))
  emitSelection(next)
}
function clearSelection() {
  emitSelection([])
}

// -- sort ---------------------------------------------------------------
const sort = ref<RecordsTableSort>({ key: primaryColumn.value?.key ?? '', dir: 1 })
function toggleSort(key: string) {
  sort.value = sort.value.key === key ? { key, dir: (sort.value.dir * -1) as RecordsTableSortDir } : { key, dir: 1 }
}
function onSortKeydown(event: KeyboardEvent, key: string) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  event.stopPropagation()
  toggleSort(key)
}

// -- filter (toolbar) -----------------------------------------------------
const filterColumn = computed(() => {
  if (!props.filterable) return null
  if (props.filterColumnKey) return props.columns.find((column) => column.key === props.filterColumnKey) ?? null
  return props.columns.find((column) => column.render === 'status') ?? null
})
const filterValue = ref<string | null>(null)
const filterMenuOpen = ref(false)
function setFilter(value: string | null) {
  filterValue.value = value
  filterMenuOpen.value = false
}
const filter = computed<RecordsTableFilter>(() => (filterColumn.value && filterValue.value ? { columnKey: filterColumn.value.key, value: filterValue.value } : null))

const visibleRows = computed(() => recordsSortRows(recordsFilterRows(props.rows, filter.value), sort.value, props.columns))

// -- column widths: fill available space once, capture it, then every column is explicit --------
const columnWidths = ref<Record<string, number>>(
  Object.fromEntries(props.columns.map((column) => [column.key, column.width ?? RECORDS_DEFAULT_COLUMN_WIDTH]))
)
const actionColumnWidth = ref(RECORDS_DEFAULT_ACTION_COLUMN_WIDTH)
const columnWidthsLocked = ref(false)
const initialColumnWidths = ref<Record<string, number> | null>(null)
const resizingColumn = ref<string | null>(null)
const tableRef = ref<HTMLTableElement | null>(null)
const scrollerRef = ref<HTMLDivElement | null>(null)

watch(
  () => props.columns.map((column) => column.key),
  () => {
    for (const column of props.columns) {
      if (!(column.key in columnWidths.value)) columnWidths.value = { ...columnWidths.value, [column.key]: column.width ?? RECORDS_DEFAULT_COLUMN_WIDTH }
    }
  }
)

function widthOf(key: string) {
  return columnWidths.value[key] ?? RECORDS_DEFAULT_COLUMN_WIDTH
}
const tableWidth = computed(() => props.columns.reduce((sum, column) => sum + widthOf(column.key), 0) + actionColumnWidth.value)

function measureAndLockWidths() {
  if (columnWidthsLocked.value || !tableRef.value) return
  const headers = Array.from(tableRef.value.querySelectorAll<HTMLTableCellElement>('thead th'))
  if (headers.length < orderedColumns.value.length + 1) return
  const measured: Record<string, number> = {}
  orderedColumns.value.forEach((column, index) => {
    measured[column.key] = headers[index]?.getBoundingClientRect().width ?? widthOf(column.key)
  })
  initialColumnWidths.value = measured
  columnWidths.value = measured
  actionColumnWidth.value = headers[headers.length - 1]?.getBoundingClientRect().width ?? actionColumnWidth.value
  columnWidthsLocked.value = true
}

function startColumnResize(key: string, minWidth = 120) {
  return (event: PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    closeAllPopovers()

    const startX = event.clientX
    const startWidth = widthOf(key)
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    resizingColumn.value = key

    const move = (moveEvent: PointerEvent) => {
      columnWidths.value = { ...columnWidths.value, [key]: Math.max(minWidth, startWidth + moveEvent.clientX - startX) }
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelection
      resizingColumn.value = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }
}

// -- scroll cue: does the table overflow the scroller? ---------------------
const scrollerWidth = ref(0)
let scrollerObserver: ResizeObserver | null = null
const overflowing = computed(() => tableWidth.value > scrollerWidth.value)

// -- popovers: property config, "+" new property, "..." table options ------
const propOpen = ref<{ key: string; x: number; y: number } | null>(null)
const addOpen = ref<{ x: number; y: number } | null>(null)
const tableMenuOpen = ref<{ x: number; y: number } | null>(null)

function closeAllPopovers() {
  propOpen.value = null
  addOpen.value = null
  tableMenuOpen.value = null
  filterMenuOpen.value = false
}

function openProp(key: string, event: MouseEvent) {
  const th = (event.currentTarget as Element).closest('th')
  if (!th) return
  addOpen.value = null
  tableMenuOpen.value = null
  if (propOpen.value?.key === key) {
    propOpen.value = null
    return
  }
  const rect = th.getBoundingClientRect()
  propOpen.value = { key, x: Math.min(rect.left, window.innerWidth - 336), y: rect.bottom + 6 }
}
function openAdd(event: MouseEvent) {
  propOpen.value = null
  tableMenuOpen.value = null
  const rect = (event.currentTarget as Element).getBoundingClientRect()
  addOpen.value = addOpen.value ? null : { x: Math.min(rect.left, window.innerWidth - 276), y: rect.bottom + 6 }
}
function openTableMenu(event: MouseEvent) {
  propOpen.value = null
  addOpen.value = null
  const rect = (event.currentTarget as Element).getBoundingClientRect()
  tableMenuOpen.value = tableMenuOpen.value ? null : { x: Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228)), y: rect.bottom + 6 }
}

let ignoreScroll = false
function onScroll() {
  if (ignoreScroll) {
    ignoreScroll = false
    return
  }
  closeAllPopovers()
}
function onDocumentPointerdown(event: PointerEvent) {
  if (!propOpen.value && !addOpen.value && !tableMenuOpen.value && !filterMenuOpen.value) return
  if (!(event.target as Element).closest('[data-recpop]')) closeAllPopovers()
}

// -- "+" add a property: emit, then once the parent appends it, scroll it into view and open it --
const awaitingNewColumn = ref(false)
function pickNewPropertyKind(kind: RecordsTablePropertyKind) {
  addOpen.value = null
  awaitingNewColumn.value = true
  emit('addColumn', kind)
}
watch(
  () => props.columns.length,
  (length, previous) => {
    if (!awaitingNewColumn.value || length <= previous) return
    awaitingNewColumn.value = false
    const last = props.columns[props.columns.length - 1]
    if (!last) return
    nextTick(() => {
      const th = tableRef.value?.querySelector<HTMLElement>(`[data-col-key="${last.key}"]`)
      if (!th) return
      const scroller = th.closest('.records-scroll') as HTMLElement | null
      if (scroller) {
        ignoreScroll = true
        scroller.scrollLeft = scroller.scrollWidth
      }
      const rect = th.getBoundingClientRect()
      propOpen.value = { key: last.key, x: Math.min(rect.left, window.innerWidth - 336), y: rect.bottom + 6 }
    })
  }
)

// -- table options menu ------------------------------------------------
function addPropertyFromMenu() {
  const position = tableMenuOpen.value
  tableMenuOpen.value = null
  if (!position) return
  addOpen.value = { x: Math.min(position.x, window.innerWidth - 276), y: position.y }
}
function compactColumns() {
  columnWidths.value = recordsCompactWidths(props.columns)
  tableMenuOpen.value = null
}
function resetColumnWidths() {
  columnWidths.value = initialColumnWidths.value
    ? { ...initialColumnWidths.value }
    : Object.fromEntries(props.columns.map((column) => [column.key, column.width ?? RECORDS_DEFAULT_COLUMN_WIDTH]))
  tableMenuOpen.value = null
}
function clearSelectionFromMenu() {
  clearSelection()
  tableMenuOpen.value = null
}

// -- property popover wiring ---------------------------------------------
const propColumn = computed(() => props.columns.find((column) => column.key === propOpen.value?.key) ?? null)
const propAvailableInputs = computed(() => props.columns.filter((column) => column.key !== propOpen.value?.key).map((column) => ({ key: column.key, label: column.label })))
function handleColumnUpdate(patch: RecordsTableColumnPatch) {
  if (propOpen.value) emit('updateColumn', propOpen.value.key, patch)
}
function handleColumnRun() {
  if (propOpen.value) emit('runColumn', propOpen.value.key)
  propOpen.value = null
}
function handleColumnTogglePin() {
  if (!propOpen.value) return
  const key = propOpen.value.key
  const next = props.pinned.includes(key) ? props.pinned.filter((item) => item !== key) : [...props.pinned, key]
  emit('update:pinned', next)
}
function handleColumnRemove() {
  if (propOpen.value) emit('removeColumn', propOpen.value.key)
  propOpen.value = null
}

const busy = computed(() => !!props.calculating)

onMounted(() => {
  nextTick(measureAndLockWidths)
  document.addEventListener('pointerdown', onDocumentPointerdown)
  scrollerObserver = new ResizeObserver((entries) => {
    scrollerWidth.value = entries[0]?.contentRect.width ?? 0
  })
  if (scrollerRef.value) scrollerObserver.observe(scrollerRef.value)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerdown)
  scrollerObserver?.disconnect()
})
</script>

<template>
  <div class="records-shell" :class="{ 'is-fill': fill }">
    <div class="records-toolbar">
      <div class="records-toolbar-left">
        <span class="records-database-icon"><Icon name="ph:database" class="size-3.5" /></span>
        <span class="text-[12px] font-medium text-ink-2">Connecté au hub</span>
      </div>
      <div class="records-toolbar-right">
        <template v-if="selectedSet.size > 0">
          <span class="text-[12px] text-ink-2">{{ selectedSet.size }} sélectionné{{ selectedSet.size > 1 ? 's' : '' }}</span>
          <button type="button" class="records-quiet-button" @click="clearSelection">Désélectionner</button>
        </template>
        <div v-if="filterColumn" class="records-filter-wrap" data-recpop>
          <button type="button" class="records-select-button" :class="{ 'is-active': filterMenuOpen }" :aria-expanded="filterMenuOpen" @click="filterMenuOpen = !filterMenuOpen">
            <Icon name="ph:funnel" class="size-3.5" />
            {{ filterValue ? filterColumn.options?.find((option) => option.value === filterValue)?.label : 'Filtrer' }}
            <span v-if="filterValue" class="records-filter-dot" />
          </button>
          <div v-if="filterMenuOpen" class="records-filter-menu">
            <div class="records-filter-label">{{ filterColumn.label }}</div>
            <button type="button" :class="{ 'is-selected': !filterValue }" @click="setFilter(null)">
              <span class="records-menu-check"><Icon v-if="!filterValue" name="ph:check-bold" class="size-3" /></span>Toutes
            </button>
            <button v-for="option in filterColumn.options" :key="option.value" type="button" :class="{ 'is-selected': filterValue === option.value }" @click="setFilter(option.value)">
              <span class="records-menu-check"><Icon v-if="filterValue === option.value" name="ph:check-bold" class="size-3" /></span>{{ option.label }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div ref="scrollerRef" class="records-scroll" tabindex="0" :aria-label="caption" @scroll="onScroll">
      <table ref="tableRef" class="records-table" :style="{ width: columnWidthsLocked ? `${tableWidth}px` : '100%', minWidth: `${tableWidth}px` }">
        <colgroup>
          <col v-for="column in orderedColumns" :key="column.key" :style="{ width: `${widthOf(column.key)}px` }" />
          <col :style="{ width: `${actionColumnWidth}px` }" />
        </colgroup>
        <thead>
          <tr>
            <th v-if="primaryColumn" :data-col-key="primaryColumn.key" class="records-header-cell records-sticky-cell" :class="{ 'is-colsel': propOpen?.key === primaryColumn.key }">
              <div class="records-company-header" style="cursor: pointer" @click="openProp(primaryColumn.key, $event)">
                <AiRecordsCheckbox :checked="allSelected" :mixed="partiallySelected" label="Tout sélectionner" @change="toggleAll" />
                <span>{{ primaryColumn.label }}</span>
                <span
                  v-if="primaryColumn.sortable"
                  role="button"
                  tabindex="0"
                  :aria-label="`Trier par ${primaryColumn.label}`"
                  class="records-sort"
                  :class="{ 'is-visible': sort.key === primaryColumn.key }"
                  :style="{ transform: sort.key === primaryColumn.key && sort.dir === -1 ? 'rotate(180deg)' : undefined }"
                  @click.stop="toggleSort(primaryColumn.key)"
                  @keydown="onSortKeydown($event, primaryColumn.key)"
                >
                  <Icon name="ph:arrow-down" class="size-3" />
                </span>
              </div>
              <span
                role="separator"
                aria-orientation="vertical"
                :aria-label="`Redimensionner la colonne ${primaryColumn.label}`"
                class="records-resize-handle"
                :class="{ 'is-resizing': resizingColumn === primaryColumn.key }"
                @pointerdown="startColumnResize(primaryColumn.key, 180)($event)"
              />
            </th>
            <th v-for="column in otherColumns" :key="column.key" :data-col-key="column.key" class="records-header-cell" :class="{ 'is-colsel': propOpen?.key === column.key }">
              <button type="button" class="records-header-button" @click="openProp(column.key, $event)">
                <span class="records-header-icon"><Icon :name="recordsColumnIcon(column)" class="size-[15px]" /></span>
                <span class="truncate">{{ column.label }}</span>
                <span
                  v-if="column.sortable"
                  role="button"
                  tabindex="0"
                  :aria-label="`Trier par ${column.label}`"
                  class="records-sort"
                  :class="{ 'is-visible': sort.key === column.key }"
                  :style="{ transform: sort.key === column.key && sort.dir === -1 ? 'rotate(180deg)' : undefined }"
                  @click.stop="toggleSort(column.key)"
                  @keydown="onSortKeydown($event, column.key)"
                >
                  <Icon name="ph:arrow-down" class="size-3" />
                </span>
              </button>
              <span
                role="separator"
                aria-orientation="vertical"
                :aria-label="`Redimensionner la colonne ${column.label}`"
                class="records-resize-handle"
                :class="{ 'is-resizing': resizingColumn === column.key }"
                @pointerdown="startColumnResize(column.key)($event)"
              />
            </th>
            <th class="records-header-cell">
              <div class="flex h-[35px] items-center gap-1 px-2">
                <button type="button" aria-label="Nouvelle propriété" data-recpop class="flex size-7 items-center justify-center rounded-[7px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink" @click="openAdd">
                  <Icon name="ph:plus" class="size-[15px]" />
                </button>
                <button
                  type="button"
                  aria-label="Options du tableau"
                  :aria-expanded="!!tableMenuOpen"
                  data-recpop
                  class="flex size-7 items-center justify-center rounded-[7px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
                  @click="openTableMenu"
                >
                  <Icon name="ph:dots-three-bold" class="size-[15px]" />
                </button>
              </div>
            </th>
          </tr>
        </thead>
        <!-- data cells stay silent - the source keeps its click sound for chrome, not row scanning -->
        <tbody data-sound-silent>
          <tr v-for="(row, index) in visibleRows" :key="row.id" class="records-row" :class="{ 'is-selected': selectedSet.has(row.id) }">
            <td v-if="primaryColumn" class="records-cell records-sticky-cell records-company-cell" :class="{ 'is-colsel': propOpen?.key === primaryColumn.key }">
              <span class="records-rownum">{{ index + 1 }}</span>
              <AiRecordsCheckbox :checked="selectedSet.has(row.id)" :label="`Sélectionner ${recordsDisplayText(row.values[primaryColumn.key])}`" @change="toggleRow(row.id)" />
              <span class="records-company-mark">
                <Icon v-if="row.icon" :name="row.icon" class="size-3.5" />
                <template v-else>{{ recordsInitials(recordsDisplayText(row.values[primaryColumn.key])) }}</template>
              </span>
              <button
                v-if="row.openable !== false"
                type="button"
                class="records-company-name has-link border-0 bg-transparent p-0 text-left"
                :title="recordsDisplayText(row.values[primaryColumn.key])"
                @click="emit('open', row)"
              >
                {{ recordsDisplayText(row.values[primaryColumn.key]) }}
              </button>
              <span v-else class="records-company-name" :title="recordsDisplayText(row.values[primaryColumn.key])">{{ recordsDisplayText(row.values[primaryColumn.key]) }}</span>
            </td>

            <td v-for="column in otherColumns" :key="column.key" class="records-cell" :class="{ 'is-colsel': propOpen?.key === column.key }">
              <span v-if="recordsIsPending(calculating, column.key, row.id)" class="records-calc">
                <span class="records-muted">Calcul en cours...</span>
                <span class="records-pulse" />
              </span>
              <template v-else>
                <AiRecordsTagList v-if="column.render === 'tags' && !recordsIsEmpty(row.values[column.key])" :tags="asTags(row.values[column.key])" :tag-colors="column.tagColors" />
                <span v-else-if="column.render === 'status' && !recordsIsEmpty(row.values[column.key])" class="records-strength">
                  <span class="records-strength-dot" :style="{ background: statusOption(column, row)?.color ?? 'var(--ink-3)' }" />{{ statusOption(column, row)?.label ?? row.values[column.key] }}
                </span>
                <a v-else-if="column.render === 'link' && !recordsIsEmpty(row.values[column.key])" class="records-link" :href="String(row.values[column.key])" :title="String(row.values[column.key])" target="_blank" rel="noreferrer">
                  <span class="records-link-label">{{ row.values[column.key] }}</span>
                  <Icon name="ph:arrow-up-right" class="size-3" />
                </a>
                <span v-else-if="column.render === 'percent' && typeof row.values[column.key] === 'number'" :class="`text-${recordsPercentTone(Number(row.values[column.key]), column.thresholds)}`">
                  {{ recordsFormatNumber(Number(row.values[column.key])) }} %
                </span>
                <span v-else-if="recordsIsEmpty(row.values[column.key])" class="records-muted">-</span>
                <span v-else>{{ recordsDisplayText(row.values[column.key]) }}</span>
              </template>
            </td>

            <td class="records-cell" />
          </tr>
        </tbody>
        <tfoot>
          <tr class="records-calculation-row">
            <td class="records-cell records-sticky-cell">
              <span class="records-footer-value records-calculation-label"><span class="records-calculation-number">{{ visibleRows.length }}</span> enregistrements</span>
            </td>
            <td v-for="column in otherColumns" :key="column.key" class="records-cell" :class="{ 'records-muted': !footerValue(column) && column.footer?.kind !== 'ghost' }">
              <button v-if="column.footer?.kind === 'ghost'" type="button" class="records-add-calculation"><Icon name="ph:plus" class="size-[15px]" />Ajouter un calcul</button>
              <span v-else-if="footerValue(column)" class="records-footer-value" :class="{ 'records-average': footerValue(column)?.dot }">
                <span v-if="footerValue(column)?.dot" class="records-strength-dot" :style="{ background: footerValue(column)?.dot }" />{{ footerValue(column)?.text }}
              </span>
              <span v-else class="records-footer-value records-muted">-</span>
            </td>
            <td class="records-cell" />
          </tr>
        </tfoot>
      </table>
    </div>

    <div class="records-footer">
      <span><strong>{{ visibleRows.length }}</strong> {{ visibleRows.length === 1 ? 'enregistrement affiché' : 'enregistrements affichés' }}</span>
      <span v-if="overflowing" class="records-footer-hint">
        <span class="records-scroll-cue"><Icon name="ph:arrows-left-right" class="size-3.5" /></span>
        Défiler pour voir plus
      </span>
    </div>

    <AiRecordsPopover v-if="propOpen && propColumn" :key="propOpen.key" :x="propOpen.x" :y="propOpen.y" :width="320">
      <AiRecordsPropertyPopover
        :column="propColumn"
        :available-inputs="propAvailableInputs"
        :models="models"
        :pinned="pinned.includes(propOpen.key)"
        :busy="busy"
        :removable="!!propColumn.removable"
        @update="handleColumnUpdate"
        @run="handleColumnRun"
        @toggle-pin="handleColumnTogglePin"
        @remove="handleColumnRemove"
      />
    </AiRecordsPopover>

    <AiRecordsPopover v-if="addOpen" :x="addOpen.x" :y="addOpen.y" :width="260">
      <div data-recpop class="p-1.5">
        <div class="px-2 pb-1 pt-1 text-[12px] font-medium text-ink-3">Nouvelle propriété</div>
        <AiGlideMenu class="flex flex-col gap-px">
          <button
            v-for="kind in RECORDS_NEW_PROPERTY_KINDS"
            :key="kind"
            data-menu-row
            type="button"
            class="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink"
            @click="pickNewPropertyKind(kind)"
          >
            <span class="text-ink-2"><Icon :name="RECORDS_PROPERTY_KIND_ICONS[kind]" class="size-[15px]" /></span>
            {{ RECORDS_PROPERTY_KIND_LABELS[kind] }}
          </button>
        </AiGlideMenu>
      </div>
    </AiRecordsPopover>

    <AiRecordsPopover v-if="tableMenuOpen" :x="tableMenuOpen.x" :y="tableMenuOpen.y" :width="220" align="right">
      <div data-recpop class="p-1.5">
        <div class="px-2 pb-1 pt-1 text-[12px] font-medium text-ink-3">Options du tableau</div>
        <AiGlideMenu class="flex flex-col gap-px">
          <button data-menu-row type="button" class="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink" @click="addPropertyFromMenu">
            <span class="text-ink-2"><Icon name="ph:plus" class="size-[15px]" /></span>
            Ajouter une propriété
          </button>
          <button data-menu-row type="button" class="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink" @click="compactColumns">
            <span class="text-ink-2"><Icon name="ph:arrows-in-line-horizontal" class="size-[15px]" /></span>
            Colonnes compactes
          </button>
          <button data-menu-row type="button" class="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink" @click="resetColumnWidths">
            <span class="text-ink-2"><Icon name="ph:arrow-counter-clockwise" class="size-[15px]" /></span>
            Réinitialiser les largeurs
          </button>
          <div class="my-1 h-px bg-line" />
          <button data-menu-row type="button" class="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2 text-left text-[13px] text-ink" @click="clearSelectionFromMenu">
            <span class="text-ink-2"><Icon name="ph:x" class="size-[15px]" /></span>
            Effacer la sélection
          </button>
        </AiGlideMenu>
      </div>
    </AiRecordsPopover>
  </div>
</template>

<style scoped>
/* ai.css reveals .records-sort on hover for .records-header-button (every non-primary header);
   the primary column's header is .records-company-header instead (it also carries the checkbox),
   so it needs the same reveal rule here. */
.records-company-header:hover .records-sort {
  opacity: 1;
}
</style>
