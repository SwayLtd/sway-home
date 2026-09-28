<script setup lang="ts">
/**
 * THINKING - expandable agent trace (Beautiful UI).
 *
 *   Steps      step list, spinner on the active row, then muted checks
 *   Reasoning  prose reasoning that expands, then settles
 *   Search     web-search trace: query line, then sources read as links
 *   Coding     tool trace: files read, edits, commands - rows are selectable
 *
 * Content is entirely prop-driven: the hub streams `rows` in and flips `working` to false when
 * the run settles - there is no internal timeline. The trace auto-expands while working, holds
 * open for one beat once it settles (so the reader can see the result land, like the source's
 * staged demo does), then collapses unless the person opened it by hand.
 *
 * Props: `variant`, `working`, `rows`, `query?` (Search), `more?`, `activeLabel?`, `doneLabel?`,
 * `expanded?` (v-model). Emits: `update:expanded(value)`, `select(row | null)` (Coding). Slots: `#icon`.
 */
import type { ThinkingRow, ThinkingVariant } from '~/utils/aiThinking'

const props = withDefaults(
  defineProps<{
    variant?: ThinkingVariant
    /** True while the run is in flight: shimmering header, auto-expanded trace. */
    working?: boolean
    rows?: ThinkingRow[]
    /** Search only: the query line shown above the sources. */
    query?: string
    /** The trailing "+N autres" line, shown whenever set. */
    more?: string
    activeLabel?: string
    doneLabel?: string
    /** Controlled expand state. Omit it to let the trace manage itself. */
    expanded?: boolean
    /** Fill the parent instead of the gallery's fixed measure and reserved height. */
    fill?: boolean
  }>(),
  { variant: 'Steps', working: false, rows: () => [], fill: false }
)

const emit = defineEmits<{
  'update:expanded': [value: boolean]
  /** Coding only: the tool row the person selected, or null once they deselect it. */
  select: [row: ThinkingRow | null]
}>()

const activeText = computed(() => props.activeLabel ?? THINKING_LABELS[props.variant].active)
const doneText = computed(() => props.doneLabel ?? THINKING_LABELS[props.variant].done)

/* The trace holds open for one beat after settling - the source's own staged timing - before it
   auto-collapses, unless the person already opened or closed it by hand in the meantime. */
const SETTLE_HOLD_MS = 2600
const manualExpanded = ref<boolean | null>(null)
const holding = ref(false)
let holdTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.working,
  (working, wasWorking) => {
    if (!wasWorking || working) return
    holding.value = true
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = setTimeout(() => {
      holding.value = false
    }, SETTLE_HOLD_MS)
  }
)
onBeforeUnmount(() => {
  if (holdTimer) clearTimeout(holdTimer)
})

const autoExpanded = computed(() => props.working || holding.value)
const expanded = computed(() => props.expanded ?? manualExpanded.value ?? autoExpanded.value)

function toggleExpanded() {
  const next = !expanded.value
  manualExpanded.value = next
  emit('update:expanded', next)
}

const selectedId = ref<string | null>(null)
function toggleSelect(row: ThinkingRow) {
  const next = selectedId.value === row.id ? null : row.id
  selectedId.value = next
  emit('select', next ? row : null)
}

/* Steps: every row before the active one is a check; the active one spins while working. */
function stepDone(index: number) {
  return index < props.rows.length - 1 || !props.working
}

const DOT_TONE_CLASS: Record<ThinkingTone, string> = {
  accent: 'bg-bui-accent',
  orange: 'bg-orange',
  green: 'bg-green',
}

function rowIsExternal(row: ThinkingRow) {
  return !!row.href && thinkingIsExternalHref(row.href)
}
/* Search rows route through NuxtLink for internal paths, a plain external link otherwise;
   Coding rows are a selectable button; Steps/Reasoning rows are static. */
function rowTag(row: ThinkingRow) {
  if (props.variant === 'Search') return rowIsExternal(row) ? 'a' : 'NuxtLink'
  if (props.variant === 'Coding') return 'button'
  return 'div'
}
function rowAttrs(row: ThinkingRow) {
  if (props.variant === 'Search') {
    return rowIsExternal(row) ? { href: row.href, target: '_blank', rel: 'noreferrer' } : { to: row.href ?? '#' }
  }
  if (props.variant === 'Coding') {
    return { type: 'button', 'aria-pressed': selectedId.value === row.id, onClick: () => toggleSelect(row) }
  }
  return {}
}
function rowStateClass(row: ThinkingRow) {
  if (props.variant === 'Search') return 'transition-colors duration-150 hover:bg-hover'
  if (props.variant === 'Coding') return selectedId.value === row.id ? 'bg-inset' : 'transition-colors duration-150 hover:bg-hover'
  return ''
}
function rowAnim(index: number) {
  return { animation: `fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${index * 120}ms both` }
}

/* Vertical timeline rule: its height tracks the trace's own content height, live. */
const traceEl = ref<HTMLElement | null>(null)
const lineHeight = ref(0)
let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  if (!traceEl.value) return
  resizeObserver = new ResizeObserver(() => {
    lineHeight.value = traceEl.value?.offsetHeight ?? 0
  })
  resizeObserver.observe(traceEl.value)
  lineHeight.value = traceEl.value.offsetHeight
})
onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <div
    class="flex w-full flex-col"
    :class="fill ? '' : 'max-w-95'"
    :style="{ minHeight: !fill && (working || expanded) ? '176px' : undefined, transition: 'min-height 400ms cubic-bezier(0.23,1,0.32,1)' }"
  >
    <!-- header - shared across variants -->
    <button
      type="button"
      :aria-expanded="expanded"
      class="-mx-1.5 flex w-fit items-center gap-2 rounded-control px-1.5 py-1 transition-colors duration-100 hover:bg-hover-2"
      @click="toggleExpanded"
    >
      <span class="flex shrink-0 transition-colors duration-200" :style="{ color: working ? 'var(--ink-2)' : 'var(--ink-3)' }">
        <slot name="icon">
          <svg width="16" height="16" viewBox="0 0 24 24" :fill="working ? 'var(--ink-2)' : 'var(--ink-3)'">
            <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
          </svg>
        </slot>
      </span>
      <span role="status" class="contents">
        <span
          v-if="working"
          class="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
          :style="{
            backgroundImage: 'linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)',
            backgroundSize: '200% 100%',
            animation: 'shimmer-text 1.4s linear infinite',
          }"
        >{{ activeText }}</span>
        <span v-else class="text-[13px] font-medium whitespace-nowrap text-ink-2" style="animation: fade-in 350ms ease-out both">{{ doneText }}</span>
      </span>
      <Icon
        name="ph:caret-down"
        class="size-3.5 shrink-0 text-ink-3 transition-transform duration-300"
        :style="{ transform: expanded ? 'rotate(180deg)' : 'rotate(0)' }"
      />
    </button>

    <!-- expandable trace -->
    <div
      class="grid transition-[grid-template-rows,opacity] duration-400"
      :style="{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0, transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)' }"
    >
      <div class="overflow-hidden">
        <div class="relative mt-1 ml-[5px] pl-4">
          <span
            aria-hidden="true"
            class="absolute left-[3px] w-px bg-line"
            :style="{ top: '-8px', height: lineHeight ? `${lineHeight - 2}px` : '0px', transition: 'height 500ms cubic-bezier(0.23,1,0.32,1)' }"
          />
          <div ref="traceEl" class="flex flex-col gap-1 py-1">
            <div
              v-if="query"
              class="flex h-6 items-center gap-2 px-1.5"
              :style="expanded ? { animation: 'fade-up 300ms cubic-bezier(0.23,1,0.32,1) both' } : undefined"
            >
              <Icon name="ph:magnifying-glass" class="size-3.5 shrink-0 text-ink-3" />
              <span class="text-[12.5px] text-ink-2">{{ query }}</span>
            </div>

            <component
              :is="rowTag(row)"
              v-for="(row, index) in rows"
              :key="row.id"
              v-bind="rowAttrs(row)"
              class="flex min-h-7 w-full items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left"
              :class="rowStateClass(row)"
              :style="rowAnim(index)"
            >
              <span
                v-if="variant === 'Search'"
                class="flex size-3.5 shrink-0 items-center justify-center rounded-full text-white"
                :class="DOT_TONE_CLASS[thinkingDotTone(row, index)]"
              >
                <Icon name="ph:globe" class="size-[9px]" />
              </span>
              <Icon v-else-if="variant === 'Steps' && stepDone(index)" name="ph:check" class="size-3.5 shrink-0 text-ink-3" />
              <span
                v-else-if="variant === 'Steps'"
                aria-hidden="true"
                class="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2"
                style="animation: spin 700ms linear infinite"
              />

              <span
                class="min-w-0 truncate text-[12.5px]"
                :class="[variant === 'Reasoning' ? 'whitespace-normal leading-relaxed text-ink-2' : 'font-medium text-ink', variant === 'Search' ? 'animated-underline' : '']"
              >{{ row.primary }}</span>
              <span v-if="row.secondary" class="shrink-0 text-[11.5px] text-ink-3" :class="row.mono ? 'font-mono' : ''">{{ row.secondary }}</span>
              <span v-if="row.add !== undefined" class="shrink-0 font-mono text-[11px] tabular-nums">
                <span class="text-green">+{{ row.add }}</span> <span class="text-red">-{{ row.del }}</span>
              </span>
            </component>

            <span v-if="more" class="text-[12px] text-ink-3" style="animation: fade-in 300ms ease-out both">{{ more }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
