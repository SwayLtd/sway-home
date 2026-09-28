<script setup lang="ts">
/**
 * FILTER TABLE - status chips filter a table (Beautiful UI).
 *
 * A row of chips above a table; picking one shows only the matching rows, with the row's own
 * height and opacity animating out rather than the row just vanishing. "Toutes" and every chip's
 * count are always derived from `rows`, never passed in stale. Real use: routines with statuses
 * (à valider / active / en pause), or hub jobs.
 */
const props = withDefaults(
  defineProps<{
    rows: FilterTableRow[]
    statuses: FilterTableStatus[]
    labels?: FilterTableColumnLabels
    /** v-model:filter - the active chip key, "all" by default. */
    filter?: string
    /** Highlights one row, e.g. the one shown in a detail panel next to the table. Optional: a
     *  caller that never selects a row never sees this class applied. */
    selectedId?: string | null
  }>(),
  {
    labels: () => FILTER_TABLE_DEFAULT_LABELS,
    filter: FILTER_TABLE_ALL,
    selectedId: null,
  }
)

/** `select` is optional for callers with no row-detail view - the source has none, and emitting
 *  it costs nothing when nobody listens. Enter mirrors the click for keyboard users. */
const emit = defineEmits<{ 'update:filter': [key: string]; select: [row: FilterTableRow] }>()

const internalFilter = ref(props.filter)
watch(
  () => props.filter,
  (value) => {
    if (value !== undefined) internalFilter.value = value
  }
)
function setFilter(key: string) {
  internalFilter.value = key
  emit('update:filter', key)
}

const counts = computed(() => filterTableCounts(props.rows, props.statuses))
</script>

<template>
  <div class="w-full max-w-105">
    <!-- filter chips -->
    <div class="-mx-1 mb-1 flex items-center gap-1 overflow-x-auto px-1 py-1" style="scrollbar-width: none">
      <button
        type="button"
        :aria-pressed="internalFilter === FILTER_TABLE_ALL"
        class="flex h-6.5 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-[background-color,box-shadow,color] duration-200"
        :class="internalFilter === FILTER_TABLE_ALL ? 'bg-surface text-ink shadow-btn' : 'text-ink-2 hover:bg-hover'"
        @click="setFilter(FILTER_TABLE_ALL)"
      >
        Toutes
        <span class="rounded-[4px] px-1 text-[10.5px] tabular-nums" :class="internalFilter === FILTER_TABLE_ALL ? 'bg-field text-ink-2' : 'text-ink-3'">{{ counts[FILTER_TABLE_ALL] }}</span>
      </button>
      <button
        v-for="status in statuses"
        :key="status.key"
        type="button"
        :aria-pressed="internalFilter === status.key"
        class="flex h-6.5 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-[background-color,box-shadow,color] duration-200"
        :class="internalFilter === status.key ? 'bg-surface text-ink shadow-btn' : 'text-ink-2 hover:bg-hover'"
        @click="setFilter(status.key)"
      >
        <span class="size-1.5 rounded-full" :style="{ background: FILTER_TABLE_TONE_DOTS[status.tone] }" />
        {{ status.label }}
        <span class="rounded-[4px] px-1 text-[10.5px] tabular-nums" :class="internalFilter === status.key ? 'bg-field text-ink-2' : 'text-ink-3'">{{ counts[status.key] ?? 0 }}</span>
      </button>
    </div>

    <!-- table -->
    <div aria-label="Tableau filtrable" class="overflow-x-auto rounded-card bg-surface shadow-card" role="region" tabindex="0" style="scrollbar-width: none">
      <div class="min-w-[420px]">
        <div class="grid grid-cols-[minmax(0,1.3fr)_minmax(0,0.6fr)_minmax(0,0.95fr)_minmax(0,0.9fr)] border-b border-[var(--grid-line)] text-[12.5px] font-medium text-ink-2">
          <span class="border-r border-[var(--grid-line)] px-3 py-2">{{ labels.label }}</span>
          <span class="border-r border-[var(--grid-line)] px-3 py-2">{{ labels.date }}</span>
          <span class="border-r border-[var(--grid-line)] px-3 py-2">{{ labels.status }}</span>
          <span class="px-3 py-2">{{ labels.owner }}</span>
        </div>
        <div
          v-for="row in rows"
          :key="row.id"
          class="grid transition-[grid-template-rows,opacity] duration-300"
          :style="{
            gridTemplateRows: filterTableIsVisible(row, internalFilter) ? '1fr' : '0fr',
            opacity: filterTableIsVisible(row, internalFilter) ? 1 : 0,
            transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
          }"
        >
          <div class="overflow-hidden">
            <div
              role="button"
              tabindex="0"
              class="grid cursor-pointer grid-cols-[minmax(0,1.3fr)_minmax(0,0.6fr)_minmax(0,0.95fr)_minmax(0,0.9fr)] border-b border-[var(--grid-line)] text-[13px] transition-colors duration-100 hover:bg-hover"
              :class="row.id === selectedId ? 'bg-hover' : ''"
              @click="emit('select', row)"
              @keydown.enter="emit('select', row)"
            >
              <span class="flex min-w-0 items-center border-r border-[var(--grid-line)] px-3 py-2">
                <span class="truncate font-medium text-ink">{{ row.label }}</span>
              </span>
              <span class="flex items-center whitespace-nowrap border-r border-[var(--grid-line)] px-3 py-2 text-ink-2 tabular-nums">{{ row.date }}</span>
              <span class="flex items-center border-r border-[var(--grid-line)] px-3 py-2">
                <span
                  class="inline-flex h-[23px] shrink-0 items-center whitespace-nowrap rounded-[8px] border px-[7px] text-[13px] font-medium"
                  :class="FILTER_TABLE_TONE_CLASSES[filterTableStatus(statuses, row.status)?.tone ?? 'warning']"
                >
                  {{ filterTableStatus(statuses, row.status)?.label ?? row.status }}
                </span>
              </span>
              <span class="flex min-w-0 items-center px-3 py-2 text-ink-2">
                <span class="truncate">{{ row.owner }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
