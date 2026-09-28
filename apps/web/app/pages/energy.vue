<script setup lang="ts">
/**
 * Energy.
 *
 * Money first, kilowatt-hours second: "18 EUR" is a number people act on and "71 kWh" is
 * one they nod at. Live draw sits next to the period total because the question behind
 * this page is usually "what is running right now", and the answer is a device name.
 */

interface EnergyRow {
  device_id: string
  name: string
  kwh: number
  cost: number
  peak: number
}

interface EnergyResponse {
  days: number
  tariff: { pricePerKwh: number; currency: string }
  byDevice: EnergyRow[]
  byHour: { hour: string; kwh: number; cost: number }[]
  live: { total: number; byArea: Record<string, number> }
}

const { devices } = useHouse()
const router = useRouter()
const days = ref(7)
const data = ref<EnergyResponse | null>(null)
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    data.value = await hubFetch<EnergyResponse>(`/energy?days=${days.value}`)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(days, load)

// ---------------------------------------------------------------------------------------
// Insights: three readings of the house the hub has data for, as AiInsightCards pages.
// ---------------------------------------------------------------------------------------

const insightPages = ref<InsightCardPage[]>([])

async function loadInsights() {
  insightPages.value = insightsToPages((await hubFetch<{ insights: HubInsight[] }>('/insights')).insights)
}
onMounted(loadInsights)

/** The follow-up pill: drop the question in the assistant's draft and go there. */
function onAskInsight(prompt: string) {
  useState<string | null>('agent-draft').value = prompt
  void router.push('/')
}

/** A page can name where "voir plus" goes; most do not, and this is then a no-op. */
function onNavigateInsight(_direction: -1 | 1, pageId: string) {
  const link = insightPages.value.find((page) => page.id === pageId)?.link
  if (link) void router.push(link)
}

const currency = computed(() => data.value?.tariff.currency ?? 'EUR')
const totalKwh = computed(() => (data.value?.byDevice ?? []).reduce((sum, row) => sum + row.kwh, 0))
const totalCost = computed(() => (data.value?.byDevice ?? []).reduce((sum, row) => sum + row.cost, 0))
const maxKwh = computed(() => Math.max(...(data.value?.byDevice ?? []).map((row) => row.kwh), 0.0001))

/** Projected monthly bill from the observed period. Honest only if the period is long enough. */
const monthly = computed(() => (days.value >= 3 ? (totalCost.value / days.value) * 30 : null))

/** Live draw, biggest consumer first: this is the "what is on right now" answer. */
const liveDraw = computed(() =>
  devices.value
    .filter((device) => typeof device.state.power === 'number' && (device.state.power as number) > 0.5)
    .map((device) => ({ device, power: device.state.power as number }))
    .sort((a, b) => b.power - a.power)
    .slice(0, 8)
)

/** Hourly bars, bucketed by day so a week reads as seven columns and not 168 slivers. */
const daily = computed(() => {
  const buckets = new Map<string, number>()
  for (const row of data.value?.byHour ?? []) {
    const day = row.hour.slice(0, 10)
    buckets.set(day, (buckets.get(day) ?? 0) + row.kwh)
  }
  const list = [...buckets.entries()].map(([day, kwh]) => ({ day, kwh }))
  const peak = Math.max(...list.map((entry) => entry.kwh), 0.0001)
  return list.map((entry) => ({ ...entry, ratio: entry.kwh / peak }))
})

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="mx-auto max-w-6xl">
    <PageHeader
      title="Énergie"
      :subtitle="data ? `${totalKwh.toFixed(1)} kWh · ${totalCost.toFixed(2)} ${currency} sur ${days} jours` : null"
      :loading="loading"
      :breadcrumb="[{ label: 'Maison', to: '/' }, { label: 'Énergie' }]"
    >
      <template #actions>
        <div class="join">
          <button
            v-for="option in [1, 7, 30]"
            :key="option"
            class="btn btn-sm join-item"
            :class="days === option ? 'admin-cta' : 'btn-outline'"
            @click="days = option"
          >{{ option }}j</button>
        </div>
      </template>
    </PageHeader>

    <!--
      Aperçus: energy today vs yesterday, an unusual room, the week by room - only the ones the
      hub has data for. The card keeps the kit's narrow measure, so the figures sit beside it.
    -->
    <div class="mb-4 grid gap-3" :class="insightPages.length > 0 ? 'lg:grid-cols-[minmax(0,23.5rem)_1fr]' : ''">
    <section v-if="insightPages.length > 0" class="rounded-2xl border border-base-300 bg-base-100 p-4">
      <AiInsightCards :pages="insightPages" @ask="onAskInsight" @navigate="onNavigateInsight" />
    </section>

    <div class="grid content-start gap-3 sm:grid-cols-2" :class="insightPages.length > 0 ? '' : 'lg:grid-cols-4'">
      <StatTile label="Consommation" :value="data ? totalKwh.toFixed(1) : null" unit="kWh" icon="ph:lightning" :loading="loading" />
      <StatTile label="Coût" :value="data ? totalCost.toFixed(2) : null" :unit="currency" icon="ph:currency-eur" :loading="loading" />
      <StatTile
        label="Projection mensuelle"
        :value="monthly !== null ? monthly.toFixed(0) : null"
        :unit="currency"
        icon="ph:calendar"
        :hint="monthly === null ? 'au moins 3 jours de données' : `à ${data?.tariff.pricePerKwh} ${currency}/kWh`"
        :loading="loading"
      />
      <StatTile
        label="En ce moment"
        :value="data ? data.live.total.toFixed(0) : null"
        unit="W"
        icon="ph:gauge"
        :tone="data && data.live.total > 3000 ? 'warning' : 'default'"
        :loading="loading"
      />
    </div>
    </div>

    <div class="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div class="space-y-4">
        <!-- Per day -->
        <section class="rounded-2xl border border-base-300 bg-base-100 p-4">
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">Par jour</h2>

          <div v-if="daily.length === 0 && !loading" class="py-6 text-center text-[12px] text-base-content/45">
            Pas encore de relevés. Les cumuls horaires sont écrits chaque heure à partir des appareils qui mesurent
            leur puissance.
          </div>

          <div v-else class="flex h-40 items-end gap-1.5">
            <div v-for="entry in daily" :key="entry.day" class="group flex h-full flex-1 flex-col justify-end">
              <span class="mb-1 text-center text-[10px] tabular text-base-content/0 transition-colors group-hover:text-base-content/60">
                {{ entry.kwh.toFixed(1) }}
              </span>
              <div
                class="w-full rounded-t-md bg-[var(--state-cold)]/70 transition-colors group-hover:bg-[var(--state-cold)]"
                :style="{ height: `${Math.max(2, entry.ratio * 100)}%` }"
              />
              <span class="mt-1.5 truncate text-center text-[10px] text-base-content/40">{{ dayLabel(entry.day) }}</span>
            </div>
          </div>
        </section>

        <!-- Per device -->
        <section class="overflow-hidden rounded-2xl border border-base-300 bg-base-100">
          <h2 class="border-b border-base-200 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">
            Par appareil
          </h2>

          <div v-if="loading" class="space-y-2 px-4 py-4">
            <div v-for="index in 4" :key="index" class="h-6 rounded-lg skeleton-line" />
          </div>

          <p v-else-if="(data?.byDevice.length ?? 0) === 0" class="px-4 py-8 text-center text-[12px] text-base-content/45">
            Aucun appareil ne remonte encore d'énergie.
          </p>

          <NuxtLink
            v-for="row in data?.byDevice ?? []"
            :key="row.device_id"
            :to="`/devices/${row.device_id}`"
            class="group relative flex items-center gap-3 border-b border-base-200 px-4 py-2.5 last:border-0 hover:bg-base-200/60"
          >
            <span
              class="absolute inset-y-0 left-0 bg-[var(--state-cold)]/10"
              :style="{ width: `${(row.kwh / maxKwh) * 100}%` }"
            />
            <span class="relative min-w-0 flex-1 truncate text-[13px]">{{ row.name }}</span>
            <span class="relative shrink-0 text-[12px] tabular text-base-content/55">{{ row.kwh.toFixed(2) }} kWh</span>
            <span class="relative w-16 shrink-0 text-right text-[13px] font-medium tabular">{{ row.cost.toFixed(2) }} {{ currency }}</span>
            <span class="relative hidden w-16 shrink-0 text-right text-[11px] tabular text-base-content/40 sm:block">
              pic {{ Math.round(row.peak) }} W
            </span>
          </NuxtLink>
        </section>
      </div>

      <!-- Live -->
      <aside class="space-y-4">
        <section class="rounded-2xl border border-base-300 bg-base-100 p-4">
          <h2 class="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-base-content/40">
            <span class="live-dot" />
            En direct
          </h2>
          <p class="mb-3 text-[12px] text-base-content/50">Ce qui tire du courant maintenant.</p>

          <p v-if="liveDraw.length === 0" class="py-4 text-center text-[12px] text-base-content/45">
            Rien au-dessus de 0,5 W.
          </p>

          <NuxtLink
            v-for="entry in liveDraw"
            :key="entry.device.id"
            :to="`/devices/${entry.device.id}`"
            class="flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-base-200"
          >
            <Icon :name="CATEGORY_ICON[entry.device.category] ?? 'ph:plug'" class="size-4 shrink-0 text-base-content/40" />
            <span class="min-w-0 flex-1 truncate text-[12px]">{{ entry.device.name }}</span>
            <span class="shrink-0 text-[12px] tabular font-medium">{{ Math.round(entry.power) }} W</span>
          </NuxtLink>
        </section>

        <section v-if="data && Object.keys(data.live.byArea).length" class="rounded-2xl border border-base-300 bg-base-100 p-4">
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">Par pièce</h2>
          <div
            v-for="(power, area) in data.live.byArea"
            :key="area"
            class="flex items-center justify-between py-1 text-[12px]"
          >
            <span class="truncate text-base-content/70">{{ area }}</span>
            <span class="tabular">{{ Math.round(power) }} W</span>
          </div>
        </section>

        <p class="px-1 text-[11px] leading-relaxed text-base-content/40">
          Tarif {{ data?.tariff.pricePerKwh ?? '-' }} {{ currency }}/kWh, modifiable dans
          <NuxtLink to="/settings#energy" class="underline">Réglages</NuxtLink>.
          Les cumuls viennent des appareils qui mesurent réellement leur puissance, jamais d'une estimation.
        </p>
      </aside>
    </div>
  </div>
</template>
