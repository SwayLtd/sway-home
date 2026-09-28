<script setup lang="ts">
/**
 * Diagnostics.
 *
 * One page that answers "is anything broken", built so the answer is visible without
 * reading anything: a green line means the part is alive. Everything here is measured,
 * never inferred - a hub that claims to be healthy because nothing threw is a hub that
 * lies quietly.
 */

interface Diagnostics {
  database: { driver: string; devices: number; events: number }
  adapters: { id: string; started: boolean; health: string; deviceCount: number; message?: string; lastScanAt?: string | null }[]
  scan: {
    running: boolean
    startedAt: string | null
    finishedAt: string | null
    durationMs: number
    hostCount: number
    newDevices: number
    updatedDevices: number
    error: string | null
  }
  agent: {
    provider: string
    model: string
    ready: boolean
    local: boolean
    autonomy: string
    spentTodayUsd: number
    budgetUsd: number
    toolCount: number
    fallbackOnly: boolean
  }
  rollups: { energyRows: number; sensorRows: number; pruned: number }
  bus: { sockets: number; listeners: number }
  network: { localIp: string; cidr: string; gateway: string | null; interfaceName: string }
}

const data = ref<Diagnostics | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const latency = ref<number | null>(null)
const { connected } = useHubStream()

async function load() {
  error.value = null
  const started = performance.now()
  try {
    data.value = await hubFetch<Diagnostics>('/diagnostics')
    latency.value = Math.round(performance.now() - started)
  } catch (cause) {
    error.value = (cause as Error).message
  } finally {
    loading.value = false
  }
}

// Polled rather than streamed: the point of this page is to prove the hub answers, and a
// page that only listens to the stream cannot tell "nothing happened" from "hub is dead".
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void load()
  timer = setInterval(load, 10_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const HEALTH_TONE: Record<string, string> = {
  ok: 'bg-success',
  degraded: 'bg-warning',
  error: 'bg-error',
  needs_setup: 'bg-base-content/25',
  disabled: 'bg-base-content/15',
}

const HEALTH_LABEL: Record<string, string> = {
  ok: 'en marche',
  degraded: 'dégradé',
  error: 'en erreur',
  needs_setup: 'à configurer',
  disabled: 'désactivé',
}

const running = computed(() => (data.value?.adapters ?? []).filter((adapter) => adapter.health === 'ok'))
const broken = computed(() => (data.value?.adapters ?? []).filter((adapter) => adapter.health === 'error'))

/** The single sentence at the top. Anything red wins over anything green. */
const verdict = computed(() => {
  if (error.value) return { tone: 'error', text: `Le hub ne répond pas: ${error.value}` }
  if (!data.value) return { tone: 'default', text: 'Lecture...' }
  if (broken.value.length > 0) return { tone: 'error', text: `${broken.value.length} intégration${broken.value.length > 1 ? 's' : ''} en erreur` }
  if (data.value.scan.error) return { tone: 'warning', text: `Dernier scan en échec: ${data.value.scan.error}` }
  if (!connected.value) return { tone: 'warning', text: 'Flux temps réel déconnecté, les pages ne se mettent plus à jour toutes seules' }
  return { tone: 'success', text: `Tout tourne. ${running.value.length} intégrations actives, ${data.value.database.devices} appareils.` }
})

const VERDICT_CLASS: Record<string, string> = {
  success: 'border-success/40 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  error: 'border-error/40 bg-error/10 text-error',
  default: 'border-base-300 bg-base-100',
}

const VERDICT_ICON: Record<string, string> = {
  success: 'ph:check-circle',
  warning: 'ph:warning',
  error: 'ph:warning-octagon',
  default: 'ph:circle-dashed',
}

function seconds(ms: number): string {
  return ms > 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <PageHeader
      title="Diagnostics"
      :subtitle="latency !== null ? `hub répond en ${latency} ms` : null"
      :loading="loading"
      :breadcrumb="[{ label: 'Système' }, { label: 'Diagnostics' }]"
    >
      <template #actions>
        <button class="btn btn-sm btn-outline gap-2" @click="load">
          <Icon name="ph:arrows-clockwise" class="size-4" />
          Rafraîchir
        </button>
      </template>
    </PageHeader>

    <div class="mb-4 flex items-center gap-2.5 rounded-2xl border px-4 py-3" :class="VERDICT_CLASS[verdict.tone]">
      <Icon :name="VERDICT_ICON[verdict.tone]!" class="size-5 shrink-0" />
      <p class="text-[13px] font-medium">{{ verdict.text }}</p>
    </div>

    <div v-if="data" class="space-y-4">
      <!-- Moving parts -->
      <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Base de données" :value="data.database.driver" icon="ph:database" :hint="`${data.database.events} évènements`" />
        <StatTile label="Appareils" :value="data.database.devices" icon="ph:lightbulb-filament" />
        <StatTile
          label="Flux temps réel"
          :value="connected ? 'connecté' : 'coupé'"
          icon="ph:broadcast"
          :tone="connected ? 'success' : 'warning'"
          :hint="`${data.bus.sockets} client${data.bus.sockets > 1 ? 's' : ''}, ${data.bus.listeners} écouteurs`"
        />
        <StatTile
          label="Assistant"
          :value="data.agent.fallbackOnly ? 'moteur local' : data.agent.model"
          icon="ph:sparkle"
          :tone="data.agent.ready ? 'success' : 'default'"
          :hint="data.agent.fallbackOnly ? 'aucune clé API configurée' : `${data.agent.spentTodayUsd.toFixed(3)} / ${data.agent.budgetUsd} USD`"
        />
      </section>

      <!-- Adapters -->
      <section class="overflow-hidden rounded-2xl border border-base-300 bg-base-100">
        <h2 class="border-b border-base-200 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">
          Intégrations
        </h2>
        <NuxtLink
          v-for="adapter in data.adapters"
          :key="adapter.id"
          to="/integrations"
          class="flex items-center gap-3 border-b border-base-200 px-4 py-2.5 last:border-0 hover:bg-base-200/60"
        >
          <span class="size-2 shrink-0 rounded-full" :class="HEALTH_TONE[adapter.health] ?? 'bg-base-300'" />
          <span class="min-w-0 flex-1 truncate text-[13px]">{{ adapter.id }}</span>
          <span class="shrink-0 text-[11px] text-base-content/45">{{ HEALTH_LABEL[adapter.health] ?? adapter.health }}</span>
          <span class="w-20 shrink-0 text-right text-[12px] tabular text-base-content/55">
            {{ adapter.deviceCount }} appareil{{ adapter.deviceCount > 1 ? 's' : '' }}
          </span>
        </NuxtLink>
      </section>

      <div class="grid gap-4 sm:grid-cols-2">
        <!-- Network -->
        <section class="rounded-2xl border border-base-300 bg-base-100 p-4">
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">Réseau</h2>
          <dl class="space-y-1.5 text-[12.5px]">
            <div class="flex justify-between gap-3">
              <dt class="text-base-content/55">Interface</dt>
              <dd class="truncate tabular">{{ data.network.interfaceName }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-base-content/55">Adresse du hub</dt>
              <dd class="tabular">{{ data.network.localIp }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-base-content/55">Sous-réseau</dt>
              <dd class="tabular">{{ data.network.cidr }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-base-content/55">Passerelle</dt>
              <dd class="tabular">{{ data.network.gateway ?? 'inconnue' }}</dd>
            </div>
          </dl>
        </section>

        <!-- Scan -->
        <section class="rounded-2xl border border-base-300 bg-base-100 p-4">
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">Dernier scan</h2>
          <dl v-if="data.scan.finishedAt || data.scan.running" class="space-y-1.5 text-[12.5px]">
            <div class="flex justify-between gap-3">
              <dt class="text-base-content/55">État</dt>
              <dd>{{ data.scan.running ? 'en cours' : 'terminé' }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-base-content/55">Hôtes vus</dt>
              <dd class="tabular">{{ data.scan.hostCount }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-base-content/55">Nouveaux</dt>
              <dd class="tabular">{{ data.scan.newDevices }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-base-content/55">Durée</dt>
              <dd class="tabular">{{ seconds(data.scan.durationMs) }}</dd>
            </div>
            <div v-if="data.scan.finishedAt" class="flex justify-between gap-3">
              <dt class="text-base-content/55">Quand</dt>
              <dd>{{ formatRelative(data.scan.finishedAt) }}</dd>
            </div>
            <p v-if="data.scan.error" class="rounded-lg bg-error/10 px-2 py-1.5 text-[12px] text-error">{{ data.scan.error }}</p>
          </dl>
          <p v-else class="py-2 text-[12px] text-base-content/45">Aucun scan depuis le démarrage.</p>
        </section>
      </div>

      <!-- Roll-ups -->
      <section class="rounded-2xl border border-base-300 bg-base-100 p-4">
        <h2 class="mb-1 text-xs font-semibold uppercase tracking-wider text-base-content/40">Agrégations</h2>
        <p class="mb-3 text-[12px] text-base-content/50">
          Les mesures brutes sont compactées en cumuls horaires puis effacées, pour que la base reste petite
          et que les graphiques restent instantanés.
        </p>
        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="rounded-xl bg-base-200 p-2.5">
            <p class="text-[10px] uppercase tracking-wider text-base-content/40">Énergie</p>
            <p class="mt-0.5 text-[15px] font-semibold tabular">{{ data.rollups.energyRows }}</p>
          </div>
          <div class="rounded-xl bg-base-200 p-2.5">
            <p class="text-[10px] uppercase tracking-wider text-base-content/40">Capteurs</p>
            <p class="mt-0.5 text-[15px] font-semibold tabular">{{ data.rollups.sensorRows }}</p>
          </div>
          <div class="rounded-xl bg-base-200 p-2.5">
            <p class="text-[10px] uppercase tracking-wider text-base-content/40">Lignes purgées</p>
            <p class="mt-0.5 text-[15px] font-semibold tabular">{{ data.rollups.pruned }}</p>
          </div>
        </div>
      </section>

      <p class="pb-4 text-[11px] leading-relaxed text-base-content/40">
        Cette page interroge le hub toutes les 10 secondes. Tout ce qu'elle affiche vient de la machine locale:
        aucune télémétrie n'est envoyée nulle part.
      </p>
    </div>
  </div>
</template>
