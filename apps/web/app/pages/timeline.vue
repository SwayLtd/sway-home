<script setup lang="ts">
/**
 * The journal.
 *
 * Every line says who caused it. A house where things happen by themselves is a house
 * nobody trusts, so origin is a first-class column here and not a detail in a tooltip:
 * "vous", "routine", "assistant", "appareil". Live events arrive at the top through the
 * same SSE stream the dock uses; older ones page in from the database underneath.
 */

const { events, deviceById, areas } = useHouse()

const history = ref<HouseEventView[]>([])
const loading = ref(true)
const loadingMore = ref(false)
const exhausted = ref(false)
const group = ref<string | null>(null)
const originFilter = ref<string | null>(null)
const follow = ref(true)

const typeFilter = computed(() => EVENT_GROUPS.find((entry) => entry.id === group.value)?.types ?? null)

async function load(before?: string) {
  const parameters = new URLSearchParams({ limit: '120' })
  if (before) parameters.set('before', before)
  if (typeFilter.value) parameters.set('types', typeFilter.value.join(','))
  const response = await hubFetch<{ events: HouseEventView[] }>(`/events?${parameters}`)
  if (before) {
    history.value = [...history.value, ...response.events]
    exhausted.value = response.events.length === 0
  } else {
    history.value = response.events
    exhausted.value = response.events.length < 120
  }
}

onMounted(async () => {
  await load()
  loading.value = false
})

watch(group, async () => {
  loading.value = true
  exhausted.value = false
  await load()
  loading.value = false
})

async function more() {
  const oldest = history.value.at(-1)?.at
  if (!oldest || loadingMore.value) return
  loadingMore.value = true
  try {
    await load(oldest)
  } finally {
    loadingMore.value = false
  }
}

/**
 * Live events first, then history, with the overlap removed. The stream and the database
 * both hold the last few seconds, and showing a command twice is how a journal loses the
 * reader's trust faster than showing nothing.
 */
const merged = computed<HouseEventView[]>(() => {
  const seen = new Set<string>()
  const live = follow.value ? (events.value as unknown as HouseEventView[]) : []
  const rows: HouseEventView[] = []
  for (const event of [...live, ...history.value]) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    if (event.type === 'scan.progress') continue
    if (typeFilter.value && !typeFilter.value.includes(event.type)) continue
    if (originFilter.value && event.origin !== originFilter.value) continue
    rows.push(event)
  }
  return rows
})

/** Day headers, because "hier 22:14" needs the day to mean anything. */
const sections = computed(() => {
  const out: { day: string; label: string; rows: HouseEventView[] }[] = []
  for (const event of merged.value) {
    const day = event.at.slice(0, 10)
    let section = out.at(-1)
    if (!section || section.day !== day) {
      section = { day, label: dayLabel(day), rows: [] }
      out.push(section)
    }
    section.rows.push(event)
  }
  return out
})

function dayLabel(day: string): string {
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (day === today) return "Aujourd'hui"
  if (day === yesterday) return 'Hier'
  return new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
}

function subjectLink(event: HouseEventView): string | null {
  if (event.subjectType === 'device' && event.subjectId && deviceById.value.get(event.subjectId)) {
    return `/devices/${event.subjectId}`
  }
  if (event.subjectType === 'area' && event.subjectId && areas.value.some((area) => area.id === event.subjectId)) {
    return `/areas#${event.subjectId}`
  }
  return null
}

const ORIGINS = ['user', 'automation', 'agent', 'device', 'schedule'] as const

// Resolved once here rather than per row in the template: resolveComponent() inside a v-for
// is evaluated outside a component render scope and Vue then fails to find NuxtLink, once
// per row, on every update.
const NuxtLinkComponent = resolveComponent('NuxtLink')
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <PageHeader
      title="Journal"
      :subtitle="`${merged.length} évènements`"
      :loading="loading"
      :breadcrumb="[{ label: 'Intelligence' }, { label: 'Journal' }]"
    >
      <template #actions>
        <button
          class="btn btn-sm gap-2"
          :class="follow ? 'admin-cta' : 'btn-outline'"
          @click="follow = !follow"
        >
          <span v-if="follow" class="live-dot" />
          <Icon v-else name="ph:pause" class="size-4" />
          {{ follow ? 'En direct' : 'Figé' }}
        </button>
      </template>
    </PageHeader>

    <!-- Filters -->
    <div class="mb-4 flex flex-wrap items-center gap-1.5">
      <button
        class="rounded-full px-2.5 py-1 text-[12px] transition-colors"
        :class="group === null ? 'bg-primary/25' : 'bg-base-200 hover:bg-base-300'"
        @click="group = null"
      >Tout</button>
      <button
        v-for="entry in EVENT_GROUPS"
        :key="entry.id"
        class="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] transition-colors"
        :class="group === entry.id ? 'bg-primary/25' : 'bg-base-200 hover:bg-base-300'"
        @click="group = entry.id"
      >
        <Icon :name="entry.icon" class="size-3.5" />
        {{ entry.label }}
      </button>

      <span class="mx-1 h-4 w-px bg-base-300" />

      <button
        v-for="origin in ORIGINS"
        :key="origin"
        class="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] transition-colors"
        :class="originFilter === origin ? 'bg-primary/25' : 'bg-base-200 hover:bg-base-300'"
        @click="originFilter = originFilter === origin ? null : origin"
      >
        <Icon :name="ORIGIN_ICON[origin]!" class="size-3.5" />
        {{ ORIGIN_LABEL[origin] }}
      </button>
    </div>

    <div v-if="loading" class="space-y-2">
      <div v-for="index in 10" :key="index" class="h-9 rounded-xl skeleton-line" />
    </div>

    <EmptyState
      v-else-if="merged.length === 0"
      icon="ph:clock-counter-clockwise"
      title="Rien à afficher"
      :description="group || originFilter ? 'Aucun évènement ne correspond à ce filtre.' : 'Le journal se remplit dès qu un appareil change d état.'"
    />

    <div v-else class="space-y-5">
      <section v-for="section in sections" :key="section.day">
        <h2 class="sticky top-0 z-10 -mx-1 bg-base-200/85 px-1 py-1.5 text-xs font-semibold uppercase tracking-wider text-base-content/40 backdrop-blur">
          {{ section.label }}
        </h2>

        <div class="overflow-hidden rounded-2xl border border-base-300 bg-base-100">
          <component
            :is="subjectLink(event) ? NuxtLinkComponent : 'div'"
            v-for="event in section.rows"
            :key="event.id"
            :to="subjectLink(event) ?? undefined"
            class="flex items-start gap-2.5 border-b border-base-200 px-3 py-2 last:border-0"
            :class="subjectLink(event) ? 'hover:bg-base-200/60' : ''"
          >
            <span class="w-14 shrink-0 pt-px text-right text-[11px] tabular text-base-content/35">
              {{ event.at.slice(11, 19) }}
            </span>

            <Icon
              :name="EVENT_ICON[event.type] ?? 'ph:dot-outline'"
              class="mt-0.5 size-4 shrink-0"
              :class="severityClass(event.severity) || 'text-base-content/35'"
            />

            <span class="min-w-0 flex-1 break-words text-[12.5px]" :class="severityClass(event.severity)">
              {{ eventLabel(event, (id) => deviceById.get(id)?.name) }}
            </span>

            <span
              class="hidden shrink-0 items-center gap-1 rounded-full bg-base-200 px-2 py-0.5 text-[11px] text-base-content/50 sm:flex"
              :title="event.originDetail ?? undefined"
            >
              <Icon :name="ORIGIN_ICON[event.origin] ?? 'ph:gear'" class="size-3" />
              {{ ORIGIN_LABEL[event.origin] ?? event.origin }}
            </span>
          </component>
        </div>
      </section>

      <div class="pb-4 text-center">
        <button v-if="!exhausted" class="btn btn-sm btn-outline" :disabled="loadingMore" @click="more">
          {{ loadingMore ? 'Chargement...' : 'Charger plus ancien' }}
        </button>
        <p v-else class="text-[12px] text-base-content/40">Début du journal.</p>
      </div>
    </div>
  </div>
</template>
