<script setup lang="ts">
/**
 * DIFF TABLE - a proposal that changes several things at once (Beautiful UI).
 *
 * The edit plays once on mount: rows tint in, then any added rows reveal, then the footer
 * appears and rests on the completed diff. Each changed row is the control: click it (or
 * Enter/Space) to include or exclude that addition/removal/change before applying.
 *
 * Props: `rows`, `labels?` (includes `title`).
 * Emits: `apply(includedIds)`, `discard`.
 */

const props = defineProps<{
  rows: DiffTableRow[]
  labels?: Partial<DiffTableLabels>
}>()

const emit = defineEmits<{
  apply: [includedIds: string[]]
  discard: []
}>()

const t = computed(() => ({ ...DIFF_TABLE_DEFAULT_LABELS, ...props.labels }))

/* the edit's entrance plays once on mount: 0 plain -> 1 tinted (removals/changes) -> 2 settled (additions reveal, footer appears) */
const STAGE_DELAYS = [180, 260]
const stage = ref(0)
let stageTimer: ReturnType<typeof setTimeout> | null = null
function runStage() {
  if (stage.value >= STAGE_DELAYS.length) return
  stageTimer = setTimeout(() => {
    stage.value += 1
    runStage()
  }, STAGE_DELAYS[stage.value])
}
onMounted(runStage)
onBeforeUnmount(() => {
  if (stageTimer) clearTimeout(stageTimer)
})

const tinted = computed(() => stage.value >= 1)
const settled = computed(() => stage.value >= 2)

function initIncluded(rows: DiffTableRow[]): Record<string, boolean> {
  return Object.fromEntries(rows.map((row) => [row.id, true]))
}
const included = ref<Record<string, boolean>>(initIncluded(props.rows))
// A new proposal (a different set of row ids) starts every row included again.
watch(
  () => props.rows.map((row) => row.id).join('|'),
  () => {
    included.value = initIncluded(props.rows)
    accepted.value = false
    discarded.value = false
    stage.value = 0
    if (stageTimer) clearTimeout(stageTimer)
    runStage()
  }
)

const accepted = ref(false)
const discarded = ref(false)

const existingRows = computed(() => props.rows.filter((row) => row.kind !== 'add'))
const addRows = computed(() => props.rows.filter((row) => row.kind === 'add'))
const hasMeta = computed(() => props.rows.some((row) => row.meta))
const includedCount = computed(() => diffTableIncludedCount(props.rows, included.value))
const summary = computed(() => diffTableSummary(props.rows, included.value))

const META_DOT: Record<DiffTableTone, string> = {
  accent: 'bg-bui-accent',
  neutral: 'bg-ink-3',
  orange: 'bg-orange',
  green: 'bg-green',
  red: 'bg-red',
}

function markClass(kind: DiffTableRowKind): string {
  if (kind === 'remove') return 'bg-red text-white'
  if (kind === 'add') return 'bg-green text-white'
  return 'bg-bui-accent text-primary-content'
}

type RowVisual = { bg?: string; text: string; struck: boolean; dim: boolean }
function rowVisual(row: DiffTableRow): RowVisual {
  const on = included.value[row.id] ?? false
  if (row.kind === 'remove') {
    const active = tinted.value && on
    return { bg: active ? 'var(--red-tint)' : undefined, text: active ? 'var(--red)' : 'var(--ink)', struck: active, dim: !on }
  }
  if (row.kind === 'change') {
    const active = tinted.value && on
    return { bg: active ? 'var(--accent-tint)' : undefined, text: active ? 'var(--accent-ink)' : 'var(--ink)', struck: false, dim: !on }
  }
  return { bg: on ? 'var(--green-tint)' : undefined, text: on ? 'var(--green)' : 'var(--ink-3)', struck: false, dim: false }
}

function valueText(row: DiffTableRow): string {
  if (row.kind === 'change') return [row.before, row.after].filter(Boolean).join(' -> ')
  return (row.kind === 'remove' ? row.before : row.after) ?? ''
}

function interactive(): boolean {
  return settled.value && !accepted.value && !discarded.value
}

function toggleIncluded(id: string) {
  included.value = { ...included.value, [id]: !included.value[id] }
}

function onRowKeydown(event: KeyboardEvent, id: string) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    toggleIncluded(id)
  }
}

function applyChanges() {
  const ids = props.rows.filter((row) => included.value[row.id]).map((row) => row.id)
  accepted.value = true
  emit('apply', ids)
}

function discardProposal() {
  discarded.value = true
  emit('discard')
}
</script>

<template>
  <div class="w-full max-w-95">
    <div class="relative overflow-hidden rounded-card bg-surface shadow-card">
      <div class="primitive-card-bar flex items-center justify-between border-b border-line">
        <span class="text-[12.5px] font-medium text-ink">{{ t.title }}</span>
        <span v-if="settled && !accepted && !discarded" class="text-[11px] text-ink-3">{{ t.hint }}</span>
      </div>

      <table class="w-full table-fixed border-collapse text-left">
        <colgroup>
          <col :class="hasMeta ? 'w-[34%]' : 'w-[46%]'" />
          <col v-if="hasMeta" class="w-[30%]" />
          <col :class="hasMeta ? 'w-[36%]' : 'w-[54%]'" />
        </colgroup>
        <thead>
          <tr class="border-b border-line">
            <th class="primitive-table-cell text-[12px] font-medium text-ink-3">{{ t.itemHeader }}</th>
            <th v-if="hasMeta" class="primitive-table-cell text-[12px] font-medium text-ink-3">{{ t.categoryHeader }}</th>
            <th class="primitive-table-cell text-[12px] font-medium text-ink-3">{{ t.changeHeader }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in existingRows"
            :key="row.id"
            :tabindex="interactive() ? 0 : undefined"
            :aria-selected="included[row.id]"
            class="border-b border-line transition-[background-color,filter,opacity] duration-150 last:border-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bui-accent"
            :class="interactive() ? 'cursor-pointer hover:brightness-[0.985]' : ''"
            :style="{ background: rowVisual(row).bg }"
            @click="interactive() && toggleIncluded(row.id)"
            @keydown="interactive() && onRowKeydown($event, row.id)"
          >
            <td class="primitive-table-cell text-[13px] font-medium tabular-nums transition-colors duration-200" :style="{ color: rowVisual(row).text }">
              {{ row.label }}
            </td>
            <td v-if="hasMeta" class="primitive-table-cell">
              <span v-if="row.meta" class="inline-flex h-5.5 items-center gap-1.5 rounded-full bg-inset px-2 text-[11.5px] font-medium shadow-hairline transition-opacity duration-200" :style="{ opacity: rowVisual(row).dim ? 0.55 : 1 }">
                <span class="size-1.5 rounded-full" :class="META_DOT[row.metaTone ?? 'neutral']" />
                <span class="text-ink-2">{{ row.meta }}</span>
              </span>
            </td>
            <td
              class="primitive-table-cell text-[12.5px] whitespace-nowrap transition-colors duration-200"
              :style="{
                color: rowVisual(row).text,
                textDecorationLine: rowVisual(row).struck ? 'line-through' : 'none',
                textDecorationColor: 'color-mix(in srgb, var(--red) 50%, transparent)',
              }"
            >
              <span class="flex items-center justify-between gap-2">
                <span class="min-w-0 truncate">{{ valueText(row) }}</span>
                <span
                  v-if="settled"
                  aria-hidden="true"
                  class="flex size-4.5 shrink-0 items-center justify-center rounded-[5px] transition-[background-color,color,transform] duration-150"
                  :class="included[row.id] ? markClass(row.kind) : 'bg-inset text-ink-3 shadow-hairline'"
                  :style="{ transform: included[row.id] ? 'scale(1)' : 'scale(0.92)' }"
                >
                  <Icon v-if="included[row.id]" name="ph:check-bold" class="size-2.5" />
                </span>
              </span>
            </td>
          </tr>

          <!-- added rows reveal once settled -->
          <tr v-for="row in addRows" :key="row.id">
            <td colspan="3" class="p-0">
              <div
                class="grid transition-[grid-template-rows,opacity] duration-200"
                :style="{ gridTemplateRows: settled ? '1fr' : '0fr', opacity: settled ? 1 : 0, transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)' }"
              >
                <div class="overflow-hidden">
                  <div
                    role="checkbox"
                    :tabindex="interactive() ? 0 : -1"
                    :aria-checked="included[row.id]"
                    :aria-label="`Inclure : ${row.label}`"
                    class="grid items-center border-t border-line transition-[background-color,filter,opacity] duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bui-accent"
                    :class="[hasMeta ? 'grid-cols-[34%_30%_36%]' : 'grid-cols-[46%_54%]', interactive() ? 'cursor-pointer hover:brightness-[0.985]' : '']"
                    :style="{ background: rowVisual(row).bg }"
                    @click="interactive() && toggleIncluded(row.id)"
                    @keydown="interactive() && onRowKeydown($event, row.id)"
                  >
                    <span class="primitive-table-cell text-[13px] font-medium tabular-nums transition-colors duration-200" :style="{ color: rowVisual(row).text }">{{ row.label }}</span>
                    <span v-if="hasMeta" class="primitive-table-cell">
                      <span v-if="row.meta" class="inline-flex h-5.5 items-center gap-1.5 rounded-full bg-surface px-2 text-[11.5px] font-medium shadow-hairline">
                        <span class="size-1.5 rounded-full" :class="META_DOT[row.metaTone ?? 'green']" />
                        <span class="text-ink-2">{{ row.meta }}</span>
                      </span>
                    </span>
                    <span class="primitive-table-cell text-[13px] transition-colors duration-200" :style="{ color: rowVisual(row).text }">
                      <span class="flex items-center justify-between gap-2">
                        <span class="min-w-0 truncate">{{ valueText(row) }}</span>
                        <span
                          aria-hidden="true"
                          class="flex size-4.5 shrink-0 items-center justify-center rounded-[5px] transition-[background-color,color,transform] duration-150"
                          :class="included[row.id] ? markClass(row.kind) : 'bg-inset text-ink-3 shadow-hairline'"
                          :style="{ transform: included[row.id] ? 'scale(1)' : 'scale(0.92)' }"
                        >
                          <Icon v-if="included[row.id]" name="ph:check-bold" class="size-2.5" />
                        </span>
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- footer - the summary follows the row-level selection -->
      <div v-if="settled" class="primitive-card-footer flex min-h-11 items-center justify-between border-t border-line" style="animation: fade-up 180ms cubic-bezier(0.23, 1, 0.32, 1) both">
        <span v-if="discarded" class="inline-flex items-center gap-1.5 rounded-full bg-inset px-2.5 py-1 text-[12.5px] font-medium text-ink-2" style="animation: pop-in 180ms cubic-bezier(0.23, 1, 0.32, 1) both">
          <Icon name="ph:x-circle" class="size-3.5" />
          {{ t.discarded }}
        </span>
        <template v-else-if="accepted">
          <span class="inline-flex items-center gap-1.5 rounded-full bg-green-tint py-1 pl-1 pr-2.5 text-[12.5px] font-medium text-green" style="animation: pop-in 180ms cubic-bezier(0.23, 1, 0.32, 1) both">
            <span class="flex size-4.5 items-center justify-center rounded-full bg-green text-white">
              <Icon name="ph:check-bold" class="size-2.5" />
            </span>
            {{ diffTableAppliedLabel(includedCount) }}
          </span>
        </template>
        <template v-else>
          <span class="text-[11.5px] tabular-nums text-ink-3">{{ summary || diffTableCount(0, 'modification', 'modifications') }}</span>
          <span class="flex items-center gap-1.5">
            <AiButton variant="ghost" size="sm" @click="discardProposal">{{ t.discard }}</AiButton>
            <AiButton variant="accent" size="sm" :disabled="includedCount === 0" class="text-[12px]" @click="applyChanges">
              {{ diffTableApplyLabel(includedCount) }}
            </AiButton>
          </span>
        </template>
      </div>
    </div>
  </div>
</template>
