<script setup lang="ts">
/**
 * LIVE CHART - a Vue reproduction of the `liveline` package the source insight cards use
 * (Beautiful UI, React-only, so it cannot run here). SVG rather than canvas: it takes CSS
 * tokens (`var(--red)`...) directly as `stroke`/`fill` with no manual colour resolution,
 * and it is crisp on HiDPI with no devicePixelRatio bookkeeping.
 *
 * Draws a smooth Catmull-Rom line through sparse or dense points, an optional area fill,
 * any number of series sharing one y-scale, a grid, and a pointer-driven cursor with a
 * tooltip (default content, or a `#tooltip` slot for a card that wants its own layout).
 * Resizes with its container via ResizeObserver. `d` transitions on prop changes, so new
 * data morphs in rather than snapping - off under reduced motion.
 */
import type { LiveChartHover, LiveChartPadding, LiveChartSeries } from '~/utils/aiLiveChart'

const props = withDefaults(
  defineProps<{
    series: LiveChartSeries[]
    grid?: boolean
    lineWidth?: number
    padding?: LiveChartPadding
    hoverable?: boolean
    formatValue?: (value: number) => string
    ariaLabel?: string
    /** CSS cursor over the stage - the source's cards use "default" or "crosshair". */
    cursor?: 'default' | 'crosshair'
  }>(),
  {
    grid: false,
    lineWidth: 2,
    hoverable: true,
    padding: () => ({}),
    formatValue: () => (value: number) => `${value}`,
    cursor: 'default',
  }
)
const emit = defineEmits<{ hover: [hover: LiveChartHover | null] }>()
defineSlots<{ tooltip?(props: { hover: LiveChartHover }): unknown }>()

const stageRef = ref<HTMLElement | null>(null)
const width = ref(0)
const height = ref(0)
const hoverIndex = ref<number | null>(null)
let observer: ResizeObserver | null = null

function measure() {
  const el = stageRef.value
  if (!el) return
  width.value = el.clientWidth
  height.value = el.clientHeight
}

onMounted(() => {
  measure()
  observer = new ResizeObserver(measure)
  if (stageRef.value) observer.observe(stageRef.value)
})
onBeforeUnmount(() => observer?.disconnect())

const resolvedPadding = computed(() => ({
  top: props.padding?.top ?? 24,
  right: props.padding?.right ?? 0,
  bottom: props.padding?.bottom ?? 16,
  left: props.padding?.left ?? 0,
}))

/* every series is assumed to share the same point count, like the source's cards */
const pointCount = computed(() => props.series[0]?.data.length ?? 0)

const renderSeries = computed(() => {
  const count = pointCount.value
  const pad = resolvedPadding.value
  const plotW = Math.max(0, width.value - pad.left - pad.right)
  const plotH = Math.max(0, height.value - pad.top - pad.bottom)
  const allValues = props.series.flatMap((s) => s.data.map((p) => p.value))
  const yScale = liveChartScale(liveChartExtent(allValues), [pad.top + plotH, pad.top])
  const xAt = (i: number) => (count > 1 ? pad.left + (i / (count - 1)) * plotW : pad.left + plotW / 2)

  return props.series.map((s) => {
    const points = s.data.map((p, i) => ({ x: xAt(i), y: yScale(p.value) }))
    return {
      id: s.id,
      color: s.color,
      fill: s.fill ?? true,
      linePath: liveChartCatmullRomPath(points),
      areaPath: liveChartAreaPath(points, pad.top + plotH),
    }
  })
})

const cursorFraction = computed(() =>
  pointCount.value > 1 && hoverIndex.value !== null ? hoverIndex.value / (pointCount.value - 1) : 0
)

const currentHover = computed<LiveChartHover | null>(() => {
  if (hoverIndex.value === null) return null
  const index = hoverIndex.value
  const points = props.series
    .filter((s) => s.data[index])
    .map((s) => ({ seriesId: s.id, color: s.color, point: s.data[index]! }))
  return { index, xFraction: cursorFraction.value, points }
})

function handlePointer(event: PointerEvent) {
  if (!props.hoverable) return
  const stage = stageRef.value
  const count = pointCount.value
  if (!stage || count === 0) return
  const rect = stage.getBoundingClientRect()
  const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0
  hoverIndex.value = liveChartIndexFromFraction(fraction, count)
  emit('hover', currentHover.value)
}

function handleLeave() {
  if (hoverIndex.value === null) return
  hoverIndex.value = null
  emit('hover', null)
}
</script>

<template>
  <div
    ref="stageRef"
    class="relative h-full w-full"
    :style="{ cursor }"
    :role="ariaLabel ? 'img' : undefined"
    :aria-label="ariaLabel"
    @pointerdown="handlePointer"
    @pointermove="handlePointer"
    @pointerleave="handleLeave"
    @pointerup="handleLeave"
    @pointercancel="handleLeave"
  >
    <svg :viewBox="`0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}`" class="block h-full w-full" preserveAspectRatio="none" aria-hidden="true">
      <template v-if="grid">
        <line
          v-for="fraction in [0.25, 0.5, 0.75]"
          :key="fraction"
          :x1="resolvedPadding.left"
          :x2="Math.max(width - resolvedPadding.right, resolvedPadding.left)"
          :y1="resolvedPadding.top + (height - resolvedPadding.top - resolvedPadding.bottom) * fraction"
          :y2="resolvedPadding.top + (height - resolvedPadding.top - resolvedPadding.bottom) * fraction"
          stroke="var(--grid-line)"
          stroke-width="1"
        />
      </template>
      <template v-for="s in renderSeries" :key="s.id">
        <path v-if="s.fill" class="live-chart-area" :d="s.areaPath" :fill="s.color" fill-opacity="0.14" stroke="none" />
        <path class="live-chart-line" :d="s.linePath" fill="none" :stroke="s.color" :stroke-width="lineWidth" stroke-linecap="round" stroke-linejoin="round" />
      </template>
    </svg>

    <template v-if="hoverable && currentHover">
      <span class="insight-chart-cursor" :style="{ left: `${cursorFraction * 100}%` }" />
      <span class="insight-chart-tooltip-anchor" :style="{ left: `${Math.min(Math.max(cursorFraction * 100, 28), 72)}%` }">
        <slot name="tooltip" :hover="currentHover">
          <span class="insight-chart-tooltip">
            <span v-for="row in currentHover.points" :key="row.seriesId" class="insight-chart-tooltip-item">
              <span class="insight-chart-tooltip-dot" :style="{ background: row.color }" />
              {{ formatValue(row.point.value) }}
            </span>
          </span>
        </slot>
      </span>
    </template>
  </div>
</template>

<style scoped>
.live-chart-line {
  transition:
    d 400ms var(--ease-out-strong),
    stroke 200ms ease;
}
.live-chart-area {
  transition:
    d 400ms var(--ease-out-strong),
    opacity 200ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .live-chart-line,
  .live-chart-area {
    transition: none;
  }
}
</style>
