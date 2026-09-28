<script setup lang="ts">
/**
 * One tile.
 *
 * The data shape decides the body, not the widget type: a `metric` and a `gauge` both
 * resolve to one number, so they share a renderer and differ by one arc. That is what keeps
 * a new widget type cheap - the hub returns one of seven shapes and the grid already knows
 * how to draw all seven.
 *
 * A tile the assistant created says so, and says why on hover. Nothing appears on someone's
 * dashboard without an attributable reason.
 */

import { formatQuantity } from '@sway-home/shared/format'

/** A reading as it is said in French: "21,1", not "21.1"; text passes through; nothing is a dash. */
function display(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '-'
  return typeof value === 'number' ? formatQuantity(value, null, 1) : value
}

const props = defineProps<{ widget: Widget; editing?: boolean }>()
const emit = defineEmits<{ remove: [string]; move: [string, -1 | 1]; resize: [string, WidgetSize] }>()

const { deviceById } = useHouse()
const { send } = useCommands()
const busy = ref<string | null>(null)

const data = computed(() => props.widget.data)

const devices = computed(() =>
  (data.value.deviceIds ?? []).map((id) => deviceById.value.get(id)).filter((device): device is NonNullable<typeof device> => Boolean(device))
)

const toneClass: Record<string, string> = {
  default: '',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-error',
  critical: 'text-error',
  info: '',
  offline: 'text-base-content/35',
}

/** The gauge arc. A dial beats a number when the question is "is this normal". */
const gauge = computed(() => {
  const value = Number(data.value.value)
  const min = props.widget.options.min ?? 0
  const max = props.widget.options.max ?? 100
  if (!Number.isFinite(value)) return null
  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min || 1)))
  return { ratio, dash: `${ratio * 100} 100` }
})

/** One path through a set of points, on a scale the caller fixes so several lines agree. */
function pathFor(points: { value: number }[], min: number, span: number): string {
  return points
    .map((point, index) => {
      const x = (index / Math.max(1, points.length - 1)) * 100
      const y = 30 - ((point.value - min) / span) * 26 - 2
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

const chart = computed(() => {
  const points = data.value.points ?? []
  if (points.length < 2) return null
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const line = pathFor(points, min, span)
  return { line, area: `${line} L100,32 L0,32 Z`, min, max }
})

/**
 * Several lines share one vertical scale, or the comparison lies: two rooms drawn on their
 * own scales look identical however far apart they really are.
 */
const LINE_COLOURS = ['var(--state-cold)', 'var(--state-warm)', 'var(--p)', 'var(--state-ok)', 'var(--state-alert)']

const multiChart = computed(() => {
  if (data.value.kind !== 'multi-series') return null
  const series = (data.value.series ?? []).filter((entry) => entry.points.length >= 2)
  if (series.length === 0) return null
  const values = series.flatMap((entry) => entry.points.map((point) => point.value))
  const min = Math.min(...values)
  const span = Math.max(...values) - min || 1
  return {
    min,
    max: Math.max(...values),
    lines: series.map((entry, index) => ({
      id: entry.id,
      label: entry.label,
      colour: LINE_COLOURS[index % LINE_COLOURS.length]!,
      path: pathFor(entry.points, min, span),
      avg: entry.avg,
      last: entry.last,
    })),
  }
})

/**
 * Bars for a ranking. Quantities that add up (watts, kWh) are drawn from zero, so a bar is
 * its share of the leader; readings that do not (17 and 20,5 °C) are drawn over their own
 * spread, or every room would look the same length.
 */
const ranking = computed(() => {
  if (data.value.kind !== 'ranking') return null
  const entries = data.value.entries ?? []
  if (entries.length === 0) return null
  const values = entries.map((entry) => entry.value)
  const adds = data.value.total !== null && data.value.total !== undefined
  const high = Math.max(...values)
  const low = adds ? 0 : Math.min(...values)
  const span = high - low
  const unit = data.value.unit ?? null
  return {
    rows: entries.map((entry) => ({
      ...entry,
      width: span > 0 ? 12 + ((entry.value - low) / span) * 88 : 100,
      text: formatQuantity(entry.value, unit, unit === '°C' ? 1 : 0),
    })),
    total: adds ? formatQuantity(data.value.total ?? 0, unit, 0) : null,
    more: Math.max(0, (data.value.count ?? entries.length) - entries.length),
  }
})

/** How the window is worded under a chart: a number with no trend is a table, not an answer. */
const TREND_LABEL: Record<string, string> = { up: 'en hausse', down: 'en baisse', flat: 'stable' }
const TREND_ICON: Record<string, string> = { up: 'ph:trend-up', down: 'ph:trend-down', flat: 'ph:arrow-right' }
const TREND_CLASS: Record<string, string> = { up: 'text-warning', down: 'text-info', flat: 'text-base-content/40' }

async function toggle(deviceId: string, on: boolean) {
  busy.value = deviceId
  try {
    await send(deviceId, on ? 'turnOff' : 'turnOn')
  } finally {
    busy.value = null
  }
}

const SIZES: WidgetSize[] = ['sm', 'md', 'lg', 'xl', 'full']

// Resolved once, not per row: resolveComponent() inside a v-for runs outside a render scope.
const NuxtLinkComponent = resolveComponent('NuxtLink')

async function dismissAlert(id: string) {
  busy.value = id
  try {
    await hubFetch(`/alerts/${id}`, { method: 'DELETE' })
    // The row is dropped locally rather than refetching the whole dashboard: the widget
    // already holds the list, and a reload here would flash every other tile.
    if (props.widget.data.rows) props.widget.data.rows = props.widget.data.rows.filter((row) => row.id !== id)
  } finally {
    busy.value = null
  }
}

async function activateScene(id: string) {
  busy.value = id
  try {
    await hubFetch(`/scenes/${id}/activate`, { method: 'POST' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section
    class="group/widget relative flex min-h-32 flex-col overflow-hidden rounded-2xl border border-base-300 bg-base-100"
    :class="editing ? 'ring-1 ring-base-content/10' : ''"
  >
    <!-- Header -->
    <header class="flex items-center gap-2 px-3.5 pt-3">
      <Icon v-if="widget.icon" :name="widget.icon" class="size-4 shrink-0 text-base-content/40" />
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-[12px] font-semibold uppercase tracking-wider text-base-content/50">{{ widget.title }}</h3>
        <p v-if="widget.subtitle" class="truncate text-[11px] text-base-content/40">{{ widget.subtitle }}</p>
      </div>

      <span
        v-if="widget.authoredBy === 'agent'"
        class="shrink-0 rounded-full bg-primary/25 px-1.5 py-0.5 text-[10px]"
        :title="widget.reason ?? 'Ajouté par l assistant'"
      >
        <Icon name="ph:sparkle" class="size-3" />
      </span>

      <div v-if="editing" class="flex shrink-0 items-center gap-0.5">
        <button class="row-action grid size-6 place-items-center rounded-full hover:bg-base-300" aria-label="Monter" @click="emit('move', widget.id, -1)">
          <Icon name="ph:arrow-up" class="size-3.5" />
        </button>
        <button class="row-action grid size-6 place-items-center rounded-full hover:bg-base-300" aria-label="Descendre" @click="emit('move', widget.id, 1)">
          <Icon name="ph:arrow-down" class="size-3.5" />
        </button>
        <select
          class="select select-xs w-14 border-base-300 bg-base-200"
          :value="widget.size"
          aria-label="Taille"
          @change="emit('resize', widget.id, ($event.target as HTMLSelectElement).value as WidgetSize)"
        >
          <option v-for="size in SIZES" :key="size" :value="size">{{ size }}</option>
        </select>
        <button class="row-action grid size-6 place-items-center rounded-full hover:bg-error/15 hover:text-error" aria-label="Retirer" @click="emit('remove', widget.id)">
          <Icon name="ph:x" class="size-3.5" />
        </button>
      </div>
    </header>

    <!-- Body -->
    <div class="flex min-h-0 flex-1 flex-col px-3.5 pb-3.5 pt-2">
      <!-- Nothing to show -->
      <p v-if="data.kind === 'empty'" class="flex flex-1 items-center text-[12px] leading-relaxed text-base-content/40">
        {{ data.message }}
      </p>

      <!-- One number -->
      <template v-else-if="data.kind === 'metric'">
        <div v-if="widget.type === 'gauge' && gauge" class="flex items-center gap-3">
          <svg viewBox="0 0 36 36" class="size-16 shrink-0 -rotate-90">
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="currentColor" stroke-width="3" class="text-base-300" />
            <circle
              cx="18"
              cy="18"
              r="15.9"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              stroke-linecap="round"
              :stroke-dasharray="gauge.dash"
              :class="toneClass[data.tone ?? 'default'] || 'text-[var(--state-cold)]'"
            />
          </svg>
          <div class="min-w-0">
            <p class="text-2xl font-bold tabular leading-none" :class="toneClass[data.tone ?? 'default']">
              {{ display(data.value) }}<span class="ml-0.5 text-[13px] font-medium text-base-content/40">{{ data.unit }}</span>
            </p>
            <p v-if="data.label" class="mt-1 truncate text-[11px] text-base-content/45">{{ data.label }}</p>
          </div>
        </div>

        <div v-else class="flex flex-1 flex-col justify-center">
          <p class="text-3xl font-bold tabular leading-none" :class="toneClass[data.tone ?? 'default']">
            {{ display(data.value) }}<span class="ml-1 text-[14px] font-medium text-base-content/40">{{ data.unit }}</span>
          </p>
          <p v-if="data.label" class="mt-1.5 truncate text-[11px] text-base-content/45">{{ data.label }}</p>
        </div>
      </template>

      <!-- A series -->
      <template v-else-if="data.kind === 'series'">
        <div class="flex items-baseline justify-between gap-2">
          <p class="text-2xl font-bold tabular leading-none">
            {{ display(data.last) }}<span class="ml-0.5 text-[13px] font-medium text-base-content/40">{{ data.unit }}</span>
          </p>
          <p
            v-if="data.trend"
            class="flex shrink-0 items-center gap-1 text-[11px] tabular"
            :class="TREND_CLASS[data.trend]"
          >
            <Icon :name="TREND_ICON[data.trend] ?? 'ph:arrow-right'" class="size-3.5" />
            {{ TREND_LABEL[data.trend] }}
            <span v-if="data.changePct != null && data.trend !== 'flat'">{{ data.changePct > 0 ? '+' : '' }}{{ Math.round(data.changePct) }} %</span>
          </p>
        </div>
        <svg v-if="chart" viewBox="0 0 100 32" preserveAspectRatio="none" class="mt-2 h-14 w-full">
          <path :d="chart.area" fill="var(--state-cold)" opacity="0.12" />
          <path
            :d="chart.line"
            fill="none"
            stroke="var(--state-cold)"
            stroke-width="1.4"
            vector-effect="non-scaling-stroke"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
        </svg>

        <dl v-if="data.avg !== undefined && data.avg !== null" class="mt-2 grid grid-cols-3 gap-1 text-center">
          <div v-for="stat in [{ label: 'min', value: data.min }, { label: 'moyenne', value: data.avg }, { label: 'max', value: data.max }]" :key="stat.label">
            <dt class="text-[10px] uppercase tracking-wide text-base-content/35">{{ stat.label }}</dt>
            <dd class="text-[13px] font-semibold tabular">{{ display(stat.value) }}<span class="text-[10px] font-medium text-base-content/40">{{ data.unit }}</span></dd>
          </div>
        </dl>
        <p v-if="data.count" class="mt-1 text-center text-[10px] text-base-content/30">
          {{ data.count }} {{ data.bucket === 'day' ? (data.count > 1 ? 'jours' : 'jour') : data.bucket === 'hour' ? (data.count > 1 ? 'heures' : 'heure') : 'points' }}
        </p>
      </template>

      <!-- Several series on one scale -->
      <template v-else-if="data.kind === 'multi-series'">
        <p v-if="!multiChart" class="flex flex-1 items-center text-[12px] text-base-content/40">Pas assez de relevés pour comparer.</p>

        <template v-else>
          <svg viewBox="0 0 100 32" preserveAspectRatio="none" class="h-20 w-full">
            <path
              v-for="line in multiChart.lines"
              :key="line.id"
              :d="line.path"
              fill="none"
              :stroke="line.colour"
              stroke-width="1.4"
              vector-effect="non-scaling-stroke"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          </svg>

          <ul class="mt-2 space-y-1">
            <li v-for="line in multiChart.lines" :key="line.id" class="flex items-center gap-2 text-[12px]">
              <span class="size-2 shrink-0 rounded-full" :style="{ background: line.colour }" />
              <span class="min-w-0 flex-1 truncate">{{ line.label }}</span>
              <span class="tabular font-semibold">{{ display(line.avg) }}<span class="text-[10px] font-medium text-base-content/40">{{ data.unit }}</span></span>
            </li>
          </ul>
        </template>
      </template>

      <!-- Rooms or devices, most to least -->
      <template v-else-if="data.kind === 'ranking'">
        <p v-if="!ranking" class="flex flex-1 items-center text-[12px] text-base-content/40">Rien à classer.</p>

        <template v-else>
          <ul class="space-y-1.5">
            <li v-for="(row, index) in ranking.rows" :key="row.id" class="relative flex items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-[12.5px]">
              <span
                class="absolute inset-y-0 left-0 rounded-lg"
                :class="index === 0 ? 'bg-primary/20' : 'bg-base-200'"
                :style="{ width: `${row.width}%` }"
              />
              <Icon :name="row.icon" class="relative size-4 shrink-0 text-base-content/55" />
              <span class="relative min-w-0 flex-1 truncate" :class="index === 0 ? 'font-medium' : ''">{{ row.label }}</span>
              <span class="relative shrink-0 tabular font-semibold">{{ row.text }}</span>
            </li>
          </ul>
          <p v-if="ranking.total || ranking.more" class="mt-2 text-[11px] tabular text-base-content/45">
            <span v-if="ranking.total">Total {{ ranking.total }}</span>
            <span v-if="ranking.total && ranking.more"> · </span>
            <span v-if="ranking.more">{{ ranking.more }} de plus</span>
          </p>
        </template>
      </template>

      <!-- Devices, with their controls -->
      <template v-else-if="data.kind === 'devices'">
        <p v-if="devices.length === 0" class="flex flex-1 items-center text-[12px] text-base-content/40">Rien pour le moment.</p>

        <div v-else-if="widget.type === 'toggle-row'" class="flex flex-wrap gap-1.5">
          <button
            v-for="device in devices"
            :key="device.id"
            class="flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[12px] transition-colors"
            :class="device.state.on ? 'border-transparent bg-primary/25' : 'border-base-300 hover:bg-base-200'"
            :disabled="busy === device.id"
            @click="toggle(device.id, device.state.on === true)"
          >
            <span
              class="size-2 rounded-full"
              :style="device.state.on ? { backgroundColor: lightColour(device) } : undefined"
              :class="device.state.on ? '' : 'bg-base-300'"
            />
            <span class="max-w-32 truncate">{{ device.name }}</span>
          </button>
        </div>

        <div v-else class="grid gap-2 sm:grid-cols-2">
          <DeviceCard v-for="device in devices.slice(0, 6)" :key="device.id" :device="device" />
        </div>
      </template>

      <!-- Label and value rows -->
      <template v-else-if="data.kind === 'rows'">
        <p v-if="(data.rows?.length ?? 0) === 0" class="flex flex-1 items-center gap-1.5 text-[12px] text-success">
          <Icon name="ph:check-circle" class="size-4" />
          Rien à signaler.
        </p>

        <!-- Scenes are buttons, not readings -->
        <div v-else-if="widget.type === 'scenes'" class="flex flex-wrap gap-1.5">
          <button
            v-for="row in data.rows"
            :key="row.id"
            class="flex items-center gap-1.5 rounded-xl border border-base-300 px-2.5 py-1.5 text-[12px] transition-colors hover:bg-base-200"
            :disabled="busy === row.id"
            @click="activateScene(row.id)"
          >
            <Icon :name="row.value || 'ph:sparkle'" class="size-3.5" />
            {{ row.label }}
          </button>
        </div>

        <div v-else>
          <div
            v-for="row in data.rows"
            :key="row.id"
            class="group/row flex items-baseline gap-3 border-b border-base-200 py-1.5 last:border-0"
          >
            <component
              :is="row.to ? NuxtLinkComponent : 'div'"
              :to="row.to"
              class="flex min-w-0 flex-1 items-baseline justify-between gap-3"
              :class="row.to ? 'hover:text-base-content' : ''"
            >
              <span class="min-w-0 truncate text-[12.5px]" :class="toneClass[row.tone ?? 'default']">{{ row.label }}</span>
              <span class="shrink-0 text-[12px] tabular text-base-content/55">{{ row.value }}</span>
            </component>

            <button
              v-if="widget.type === 'alerts'"
              class="grid size-5 shrink-0 place-items-center rounded-full opacity-0 transition-opacity hover:bg-base-300 group-hover/row:opacity-100"
              aria-label="Fermer l alerte"
              :disabled="busy === row.id"
              @click="dismissAlert(row.id)"
            >
              <Icon name="ph:x" class="size-3" />
            </button>
          </div>
        </div>
      </template>

      <!-- Recent activity -->
      <div v-else-if="data.kind === 'events'" class="space-y-1">
        <div v-for="event in data.events" :key="event.id" class="flex items-start gap-2 text-[12px]">
          <span class="w-11 shrink-0 tabular text-base-content/35">{{ event.at.slice(11, 16) }}</span>
          <Icon :name="EVENT_ICON[event.type] ?? 'ph:dot-outline'" class="mt-0.5 size-3.5 shrink-0 text-base-content/35" />
          <span class="min-w-0 flex-1 break-words" :class="severityClass(event.severity)">
            {{ eventLabel(event as never, (id) => deviceById.get(id)?.name) }}
          </span>
        </div>
      </div>

      <!-- A sentence the assistant wrote -->
      <p v-else-if="data.kind === 'text'" class="text-[13px] leading-relaxed">{{ data.text }}</p>
    </div>
  </section>
</template>
