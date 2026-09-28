<script setup lang="ts">
/**
 * A chart inside a chat answer.
 *
 * Hand-drawn SVG rather than a charting library: the shapes needed are a line and a bar,
 * the data is already in the message, and a library here would be a hundred kilobytes to
 * render forty points. The stroke uses a data colour, never the accent, because a chart
 * series is data-borne colour and the accent means "selected" in this system.
 */

const props = defineProps<{ data: Record<string, any> }>()

const points = computed<{ at: string; value: number }[]>(() =>
  (props.data.points ?? []).filter((point: { value: unknown }) => typeof point.value === 'number')
)

const path = computed(() => {
  const list = points.value
  if (list.length < 2) return ''
  const values = list.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return list
    .map((point, index) => {
      const x = (index / (list.length - 1)) * 100
      const y = 32 - ((point.value - min) / span) * 28 - 2
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
})

const last = computed(() => points.value.at(-1)?.value ?? null)
const min = computed(() => (points.value.length ? Math.min(...points.value.map((point) => point.value)) : null))
const max = computed(() => (points.value.length ? Math.max(...points.value.map((point) => point.value)) : null))
</script>

<template>
  <div v-if="path" class="rounded-xl border border-base-300 bg-base-200 p-2.5">
    <div class="flex items-baseline justify-between text-[11px] text-base-content/50">
      <span class="font-medium text-base-content/70">{{ props.data.attribute ?? 'valeur' }}</span>
      <span class="tabular">{{ min?.toFixed(1) }} - {{ max?.toFixed(1) }}</span>
    </div>
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" class="mt-1.5 h-12 w-full overflow-visible">
      <path
        :d="path"
        fill="none"
        stroke="var(--state-cold)"
        stroke-width="1.2"
        vector-effect="non-scaling-stroke"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>
    <p class="mt-1 text-right text-[11px] tabular text-base-content/60">dernier {{ last?.toFixed(1) }}</p>
  </div>
</template>
