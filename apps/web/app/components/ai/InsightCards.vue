<script setup lang="ts">
/**
 * INSIGHT CARDS - the house's insights carousel (Beautiful UI).
 *
 * "Aperçus N < >": one page per insight, each pairing a short prose line with a small
 * visualisation - energy today vs yesterday (two series), a room's anomaly with a toggled
 * metric, or a consumption split (allocation segments). Autoplay advances the carousel every
 * few seconds and yields for good the moment a person touches it (a chevron, a metric
 * toggle, a segment, the follow-up pill, or the chart itself). Charts are `<AiLiveChart>`,
 * this kit's Vue stand-in for the source's React-only `liveline` package.
 *
 * Page kinds: compare (two or more series), anomaly (toggled metrics), allocation
 * (segmented split) - every card type the source has.
 */
import type { InsightCardPage } from '~/utils/aiInsightCards'
import type { LiveChartHover } from '~/utils/aiLiveChart'

const props = withDefaults(defineProps<{ pages: InsightCardPage[]; heading?: string }>(), {
  heading: 'Aperçus',
})
const emit = defineEmits<{
  /** The follow-up pill was clicked - a parent typically routes this to the assistant. */
  ask: [prompt: string, page: InsightCardPage]
  navigate: [direction: -1 | 1, pageId: string]
}>()

const pageIndex = ref(0)
const currentPage = computed(() => props.pages[pageIndex.value] ?? props.pages[0])

/* per-page UI state, keyed by page id so each page remembers its own toggle/selection */
const anomalyMetricKey = reactive<Record<string, string>>({})
const allocationSelectedName = reactive<Record<string, string>>({})
const anomalyHoverValue = reactive<Record<string, number | null>>({})

const activeMetric = computed(() => {
  const data = currentPage.value?.anomaly
  if (!data) return null
  const key = anomalyMetricKey[currentPage.value!.id] ?? data.metrics[0]!.key
  return data.metrics.find((metric) => metric.key === key) ?? data.metrics[0]!
})

const activeSegment = computed(() => {
  const data = currentPage.value?.allocation
  if (!data) return null
  const name = allocationSelectedName[currentPage.value!.id] ?? data.segments[0]!.name
  return data.segments.find((segment) => segment.name === name) ?? data.segments[0]!
})

function setAnomalyMetric(page: InsightCardPage, key: string) {
  anomalyMetricKey[page.id] = key
  stopAutoplay()
}
function setAllocationSegment(page: InsightCardPage, name: string) {
  allocationSelectedName[page.id] = name
  stopAutoplay()
}

function anomalyPoints() {
  return activeMetric.value ? insightCardsMakePoints(activeMetric.value.values, 7) : []
}
function formatAnomalyValue(value: number): string {
  const metric = activeMetric.value
  return metric ? insightCardsFormatMetric(value, metric.unit, metric.decimals ?? 1) : `${value}`
}
function anomalyToolbarText(): string {
  const metric = activeMetric.value
  if (!metric || !currentPage.value) return ''
  const hovered = anomalyHoverValue[currentPage.value.id]
  if (hovered != null) return insightCardsFormatMetric(hovered, metric.unit, metric.decimals ?? 1)
  const threshold = metric.threshold ?? metric.values.at(-1) ?? 0
  return `Seuil ${insightCardsFormatMetric(threshold, metric.unit, metric.decimals ?? 1)}`
}
function onAnomalyHover(hover: LiveChartHover | null) {
  if (!currentPage.value) return
  anomalyHoverValue[currentPage.value.id] = hover?.points[0]?.point.value ?? null
}

function comparePoints(values: number[]) {
  return insightCardsSmoothPoints(values, 42)
}

/* ── carousel: any manual interaction stops autoplay for good ── */
const AUTOPLAY_MS = 7000
let autoplayTimer: ReturnType<typeof setInterval> | null = null
let autoplayStopped = false

function stopAutoplay() {
  autoplayStopped = true
  if (autoplayTimer) {
    clearInterval(autoplayTimer)
    autoplayTimer = null
  }
}
function startAutoplay() {
  if (autoplayStopped || props.pages.length < 2) return
  if (import.meta.client && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  autoplayTimer = setInterval(() => {
    pageIndex.value = (pageIndex.value + 1) % props.pages.length
  }, AUTOPLAY_MS)
}
onMounted(startAutoplay)
onBeforeUnmount(() => {
  if (autoplayTimer) clearInterval(autoplayTimer)
})

function move(direction: -1 | 1) {
  if (props.pages.length === 0) return
  stopAutoplay()
  pageIndex.value = (pageIndex.value + direction + props.pages.length) % props.pages.length
  emit('navigate', direction, props.pages[pageIndex.value]!.id)
}

function onPillClick(page: InsightCardPage) {
  stopAutoplay()
  emit('ask', page.pill, page)
}
</script>

<template>
  <div class="min-h-[408px] w-full max-w-86">
    <!-- pager header -->
    <div class="flex items-center justify-between">
      <span class="flex items-baseline gap-1.5">
        <span class="text-[13px] font-semibold text-ink">{{ heading }}</span>
        <span class="text-[13px] text-ink-3 tabular-nums">{{ pages.length }}</span>
      </span>
      <span class="flex items-center gap-0.5">
        <button
          type="button"
          aria-label="Aperçu précédent"
          class="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-[background-color,color,transform] duration-100 hover:bg-hover hover:text-ink active:scale-[0.96]"
          @click="move(-1)"
        >
          <Icon name="ph:caret-left" class="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Aperçu suivant"
          class="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-[background-color,color,transform] duration-100 hover:bg-hover hover:text-ink active:scale-[0.96]"
          @click="move(1)"
        >
          <Icon name="ph:caret-right" class="size-3.5" />
        </button>
      </span>
    </div>

    <!-- page content - blurred crossfade -->
    <Transition name="insight-page" mode="out-in">
      <div v-if="currentPage" :key="currentPage.id">
        <p class="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">
          <template v-for="(segment, index) in currentPage.prose" :key="index">
            <span v-if="segment.kind === 'text'">{{ segment.text }}</span>
            <span v-else-if="segment.kind === 'entity'" class="inline-flex items-center gap-1 align-baseline font-medium text-ink">
              <span class="inline-block size-2.5 rounded-full" :class="segment.dotClass" />@{{ segment.name }}
            </span>
            <span v-else-if="segment.kind === 'strong'" class="font-medium text-ink">{{ segment.text }}</span>
            <code v-else class="font-mono text-[11.5px]" :class="segment.tone === 'red' ? 'text-red' : 'text-green'">{{ segment.text }}</code>
          </template>
        </p>

        <div class="mt-2">
          <!-- 1: comparison of two series -->
          <div v-if="currentPage.kind === 'compare' && currentPage.compare" class="min-h-[278px] rounded-card bg-surface p-3 shadow-hairline">
            <div class="flex items-center gap-4">
              <div v-for="series in currentPage.compare.series" :key="series.id" class="flex-1">
                <span class="flex items-center gap-1.5 text-[11.5px] text-ink-2">
                  <span class="size-2 rounded-full" :class="series.dotClass" />
                  {{ series.name }}
                </span>
                <span class="block text-[17px] font-semibold tracking-[-0.01em] tabular-nums" :class="series.tone === 'red' ? 'text-red' : 'text-green'">
                  {{ insightCardsFormatEnergy(series.values.at(-1) ?? 0) }}
                </span>
                <code class="font-mono text-[11.5px]" :class="series.tone === 'red' ? 'text-red' : 'text-green'">{{ series.sub }}</code>
              </div>
            </div>
            <div class="mt-2 overflow-hidden rounded-control bg-inset shadow-hairline">
              <div class="flex items-center justify-between border-b border-line px-2.5 py-1.5">
                <span class="text-[11px] text-ink-3 tabular-nums">{{ currentPage.compare.heading }}</span>
                <span class="rounded-full bg-field px-2 py-0.5 text-[10.5px] font-medium text-ink-2">Aperçu</span>
              </div>
              <div class="insight-chart-stage relative h-[166px]">
                <AiLiveChart
                  :series="
                    currentPage.compare.series.map((series) => ({ id: series.id, data: comparePoints(series.values), color: series.color, fill: true }))
                  "
                  :padding="{ top: 40, right: 0, bottom: 22, left: 0 }"
                  :line-width="2.25"
                  :format-value="insightCardsFormatEnergy"
                />
              </div>
            </div>
          </div>

          <!-- 2: anomaly, toggled metrics -->
          <div v-else-if="currentPage.kind === 'anomaly' && currentPage.anomaly" class="min-h-[278px] rounded-card bg-surface p-3 shadow-hairline">
            <div class="flex items-center justify-between">
              <span class="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                <Icon :name="currentPage.anomaly.icon ?? 'ph:trend-up'" class="size-3 text-red" />
                {{ currentPage.anomaly.heading }}
              </span>
              <span class="rounded-full bg-field px-2 py-0.5 text-[10.5px] font-medium text-ink-2">Aperçu</span>
            </div>
            <div class="mt-2 overflow-hidden rounded-control bg-inset shadow-hairline">
              <div class="flex items-center justify-between border-b border-line px-2.5 py-1.5">
                <span class="text-[11px] text-ink-3 tabular-nums">{{ anomalyToolbarText() }}</span>
                <span class="flex rounded-full bg-field p-0.5">
                  <button
                    v-for="metric in currentPage.anomaly.metrics"
                    :key="metric.key"
                    type="button"
                    :aria-pressed="activeMetric!.key === metric.key"
                    class="rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.96]"
                    :class="activeMetric!.key === metric.key ? 'bg-surface text-ink shadow-btn' : 'text-ink-3 hover:text-ink-2'"
                    @click="setAnomalyMetric(currentPage, metric.key)"
                  >
                    {{ metric.label }}
                  </button>
                </span>
              </div>
              <div class="insight-chart-stage relative h-[166px]">
                <AiLiveChart
                  :series="[{ id: activeMetric!.key, data: anomalyPoints(), color: 'var(--red)', fill: false }]"
                  grid
                  cursor="crosshair"
                  :padding="{ top: 34, right: 0, bottom: 22, left: 0 }"
                  :line-width="2.25"
                  :format-value="formatAnomalyValue"
                  @hover="onAnomalyHover"
                />
              </div>
            </div>
            <div class="mt-1.5 flex items-baseline gap-2">
              <span class="text-[17px] font-semibold tracking-[-0.01em] text-ink tabular-nums">
                {{
                  insightCardsFormatMetric(
                    currentPage.anomaly.metrics[0]!.values.at(-1) ?? 0,
                    currentPage.anomaly.metrics[0]!.unit,
                    currentPage.anomaly.metrics[0]!.decimals ?? 1
                  )
                }}
              </span>
              <code class="font-mono text-[11.5px] text-red">{{ currentPage.anomaly.deltaLabel }}</code>
              <span class="text-[11px] text-ink-3">{{ currentPage.anomaly.baselineLabel }}</span>
            </div>
          </div>

          <!-- 3: allocation segments -->
          <div v-else-if="currentPage.kind === 'allocation' && currentPage.allocation" class="min-h-[278px] rounded-card bg-surface p-3 shadow-hairline">
            <span class="flex items-center gap-1.5 text-[12px] font-medium text-ink">
              <span
                class="flex size-3.5 items-center justify-center rounded-full text-[8px] font-bold text-white"
                :class="currentPage.allocation.segments[0]!.colorClass"
              >
                {{ currentPage.allocation.segments[0]!.name.charAt(0) }}
              </span>
              {{ currentPage.allocation.heading }}
            </span>
            <span class="mt-1 block text-[20px] font-semibold tracking-[-0.01em] text-ink tabular-nums">{{ activeSegment!.amount }}</span>
            <div class="mt-3 flex h-9 gap-0.5 overflow-hidden rounded-full bg-field p-0.5" role="group" aria-label="Segments de répartition">
              <button
                v-for="segment in currentPage.allocation.segments"
                :key="segment.name"
                type="button"
                :aria-pressed="activeSegment!.name === segment.name"
                :aria-label="`${segment.label} : ${insightCardsFormatShare(segment.pct)}`"
                class="relative h-full overflow-hidden rounded-full transition-[opacity,transform,box-shadow] duration-300 active:scale-[0.98]"
                :class="segment.colorClass"
                :style="{
                  width: `${segment.pct}%`,
                  opacity: activeSegment!.name === segment.name ? 1 : 0.58,
                  boxShadow: activeSegment!.name === segment.name ? 'inset 0 0 0 1px rgba(255,255,255,0.22)' : undefined,
                  transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
                }"
                @click="setAllocationSegment(currentPage, segment.name)"
              >
                <span
                  class="absolute inset-y-1 left-1 rounded-full bg-white/20 transition-[width,opacity] duration-500"
                  :style="{
                    width: activeSegment!.name === segment.name ? 'calc(100% - 8px)' : '0%',
                    opacity: activeSegment!.name === segment.name ? 1 : 0,
                    transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
                  }"
                />
              </button>
            </div>
            <div class="mt-2 flex items-center gap-1.5">
              <button
                v-for="segment in currentPage.allocation.segments"
                :key="segment.name"
                type="button"
                :aria-pressed="activeSegment!.name === segment.name"
                class="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] transition-[background-color,color,transform] duration-150 active:scale-[0.96]"
                :class="activeSegment!.name === segment.name ? 'bg-field text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'"
                @click="setAllocationSegment(currentPage, segment.name)"
              >
                <span class="size-1.5 rounded-full" :class="segment.colorClass" />
                {{ segment.name }} <span class="tabular-nums">{{ insightCardsFormatShare(segment.pct) }}</span>
              </button>
            </div>
            <div class="mt-3 min-h-16 rounded-control bg-inset px-2.5 py-2 shadow-hairline">
              <span class="block text-[11.5px] font-medium" :class="activeSegment!.toneClass">{{ activeSegment!.label }}</span>
              <span class="mt-1 block text-[11px] leading-relaxed text-ink-3">{{ activeSegment!.description }}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          class="mt-2 rounded-full bg-surface px-3 py-1.5 text-left text-[12px] text-ink shadow-btn transition-colors duration-100 hover:bg-hover"
          @click="onPillClick(currentPage)"
        >
          {{ currentPage.pill }}
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.insight-page-enter-active,
.insight-page-leave-active {
  transition:
    opacity 250ms var(--ease-out-strong),
    filter 250ms var(--ease-out-strong);
}
.insight-page-enter-from,
.insight-page-leave-to {
  opacity: 0;
  filter: blur(4px);
}
@media (prefers-reduced-motion: reduce) {
  .insight-page-enter-active,
  .insight-page-leave-active {
    transition: none;
  }
  .insight-page-enter-from,
  .insight-page-leave-to {
    opacity: 1;
    filter: none;
  }
}
</style>
