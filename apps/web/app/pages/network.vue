<script setup lang="ts">
/**
 * The network, as the hub sees it.
 *
 * Every host the scan found, what was learned about it and from where, and whether an
 * integration has claimed it. The last column is the honest one: a host nobody controls is
 * listed as exactly that, with the adapters worth trying against it, rather than quietly
 * hidden because it did not fit.
 */

const { toggleDock } = useShell()
const { house, refresh } = useHouse()

interface HostRow {
  ip: string
  mac: string | null
  macVendor: string | null
  hostname: string | null
  openPorts: number[]
  mdnsServices: string[]
  mdnsTxt: Record<string, string>
  ssdp: { server?: string; friendlyName?: string; modelName?: string } | null
  httpTitle: string | null
  httpBanner: string | null
  rttMs: number | null
  source: string[]
  fingerprint: { category?: string; vendor?: string; confidence?: number; suggestedAdapters?: string[]; evidence?: string[]; productGuess?: string | null }
  deviceId: string | null
  ignored: boolean
  firstSeenAt: string
  lastSeenAt: string
}

const hosts = ref<HostRow[]>([])
const loading = ref(true)
const expanded = ref<string | null>(null)
const filter = ref<'all' | 'unclaimed' | 'controlled'>('all')

async function load() {
  loading.value = true
  try {
    hosts.value = (await hubFetch<{ hosts: HostRow[] }>('/network/hosts')).hosts
  } finally {
    loading.value = false
  }
}

onMounted(load)

// The scan pushes progress on the event stream; reload when it finishes.
watch(() => house.value?.scan.finishedAt, () => void load())

const rows = computed(() =>
  hosts.value.filter((host) => {
    if (filter.value === 'unclaimed') return host.deviceId === null
    if (filter.value === 'controlled') return host.deviceId !== null
    return true
  })
)

const counts = computed(() => ({
  all: hosts.value.length,
  controlled: hosts.value.filter((host) => host.deviceId !== null).length,
  unclaimed: hosts.value.filter((host) => host.deviceId === null).length,
}))

const scanning = computed(() => house.value?.scan.running ?? false)

async function scan(deep: boolean) {
  await hubFetch('/scan', { method: 'POST', body: { quick: !deep, deep } })
}

async function ignore(ip: string, ignored: boolean) {
  await hubFetch(`/network/hosts/${ip}/ignore`, { method: 'POST', body: { ignored } })
  await load()
}

const SOURCE_LABEL: Record<string, string> = {
  arp: 'ARP',
  icmp: 'ICMP',
  tcp: 'TCP',
  mdns: 'mDNS',
  ssdp: 'SSDP',
  dhcp: 'DHCP',
  netbios: 'NetBIOS',
  wsd: 'WS-Discovery',
  manual: 'manuel',
}

function bestName(host: HostRow): string {
  return host.hostname ?? host.ssdp?.friendlyName ?? host.mdnsTxt.fn ?? host.httpTitle ?? host.fingerprint.productGuess ?? `Hôte ${host.ip.split('.').pop()}`
}
</script>

<template>
  <div class="mx-auto max-w-7xl">
    <PageHeader
      title="Réseau"
      :subtitle="`${counts.all} hôtes · ${counts.controlled} pilotés · ${counts.unclaimed} non reconnus`"
      :loading="loading && hosts.length === 0"
      :breadcrumb="[{ label: 'Système' }, { label: 'Réseau' }]"
    >
      <template #actions>
        <button class="btn btn-sm btn-outline gap-2" :disabled="scanning" @click="scan(false)">
          <Icon name="ph:broadcast" class="size-4" :class="scanning ? 'animate-spin' : ''" />
          Scan rapide
        </button>
        <button class="btn btn-sm admin-cta gap-2" :disabled="scanning" @click="scan(true)">
          <Icon name="ph:magnifying-glass-plus" class="size-4" />
          Scan complet
        </button>
      </template>
    </PageHeader>

    <div v-if="scanning" class="mb-4 rounded-2xl border border-base-300 bg-base-100 p-4">
      <div class="flex items-center gap-3">
        <Icon name="ph:broadcast" class="size-5 animate-spin text-base-content/50" />
        <div class="min-w-0 flex-1">
          <p class="text-[13px] font-medium">Scan en cours</p>
          <p class="text-[12px] text-base-content/55">
            {{ house?.scan.phase?.phase ?? 'démarrage' }}
            <span v-if="house?.scan.phase && house.scan.phase.total > 1" class="tabular">
              · {{ house.scan.phase.done }}/{{ house.scan.phase.total }}
            </span>
          </p>
        </div>
        <span class="tabular text-[13px] text-base-content/50">{{ house?.scan.hostCount ?? 0 }} hôtes</span>
      </div>
      <div class="mt-3 h-1 overflow-hidden rounded-full bg-base-300">
        <div
          class="h-full rounded-full bg-base-content transition-[width] duration-300"
          :style="{ width: `${house?.scan.phase && house.scan.phase.total > 0 ? Math.round((house.scan.phase.done / house.scan.phase.total) * 100) : 30}%` }"
        />
      </div>
    </div>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      <button
        v-for="option in (['all', 'controlled', 'unclaimed'] as const)"
        :key="option"
        class="h-9 rounded-full border px-3 text-[13px] transition-colors"
        :class="filter === option ? 'border-transparent bg-primary/25 font-medium' : 'border-base-300 hover:bg-base-200'"
        @click="filter = option"
      >
        {{ option === 'all' ? 'Tous' : option === 'controlled' ? 'Pilotés' : 'Non reconnus' }}
        <span class="ml-1 tabular text-base-content/45">{{ counts[option] }}</span>
      </button>
      <div class="flex-1" />
      <span class="text-[12px] text-base-content/45">
        mDNS, SSDP, ARP, NetBIOS et balayage TCP. Rien ne sort du réseau local.
      </span>
    </div>

    <EmptyState
      v-if="!loading && hosts.length === 0"
      icon="ph:broadcast"
      title="Aucun hôte connu"
      description="Le premier scan remplit cette carte. Il prend une dizaine de secondes en rapide, une minute en complet."
      action-label="Lancer un scan"
      @action="scan(false)"
    />

    <div v-else class="overflow-hidden rounded-2xl border border-base-300 bg-base-100">
      <!-- Desktop -->
      <table class="hidden w-full text-[13px] lg:table">
        <thead class="border-b border-base-200 text-left text-[11px] uppercase tracking-wider text-base-content/40">
          <tr>
            <th class="px-3 py-2 font-semibold">Adresse</th>
            <th class="px-3 py-2 font-semibold">Nom</th>
            <th class="px-3 py-2 font-semibold">Constructeur</th>
            <th class="px-3 py-2 font-semibold">Deviné</th>
            <th class="px-3 py-2 font-semibold">Ports</th>
            <th class="px-3 py-2 font-semibold">Vu par</th>
            <th class="px-3 py-2 font-semibold">Statut</th>
            <th class="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          <template v-for="host in rows" :key="host.ip">
            <tr class="group border-b border-base-200 last:border-0 hover:bg-base-200/60" :class="host.ignored ? 'opacity-40' : ''">
              <td class="px-3 py-2 font-mono tabular">{{ host.ip }}</td>
              <td class="px-3 py-2">
                <span class="font-medium">{{ bestName(host) }}</span>
                <span v-if="host.mac" class="ml-2 font-mono text-[10px] text-base-content/35">{{ host.mac }}</span>
              </td>
              <td class="px-3 py-2 text-base-content/60">{{ host.macVendor ?? '-' }}</td>
              <td class="px-3 py-2">
                <span class="rounded-full bg-base-200 px-2 py-0.5 text-[11px]">{{ host.fingerprint.category ?? 'inconnu' }}</span>
                <span v-if="host.fingerprint.confidence" class="ml-1.5 tabular text-[11px] text-base-content/40">
                  {{ Math.round((host.fingerprint.confidence ?? 0) * 100) }} %
                </span>
              </td>
              <td class="px-3 py-2 font-mono text-[11px] text-base-content/55">
                {{ host.openPorts.slice(0, 5).join(' ') || '-' }}
                <span v-if="host.openPorts.length > 5" class="text-base-content/35">+{{ host.openPorts.length - 5 }}</span>
              </td>
              <td class="px-3 py-2">
                <span
                  v-for="source in host.source"
                  :key="source"
                  class="mr-1 rounded bg-base-200 px-1 text-[10px] text-base-content/55"
                >{{ SOURCE_LABEL[source] ?? source }}</span>
              </td>
              <td class="px-3 py-2">
                <NuxtLink
                  v-if="host.deviceId"
                  :to="`/devices/${host.deviceId}`"
                  class="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success"
                >
                  <Icon name="ph:check-circle" class="size-3" />
                  piloté
                </NuxtLink>
                <span
                  v-else-if="host.fingerprint.suggestedAdapters?.length"
                  class="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] text-warning"
                >essayer {{ host.fingerprint.suggestedAdapters[0] }}</span>
                <span v-else class="text-[11px] text-base-content/35">non reconnu</span>
              </td>
              <td class="px-3 py-2 text-right">
                <button
                  class="row-action inline-grid size-8 place-items-center rounded-full hover:bg-base-300"
                  :aria-label="expanded === host.ip ? 'Replier' : 'Détails'"
                  @click="expanded = expanded === host.ip ? null : host.ip"
                >
                  <Icon :name="expanded === host.ip ? 'ph:caret-up' : 'ph:caret-down'" class="size-4" />
                </button>
              </td>
            </tr>

            <tr v-if="expanded === host.ip" class="border-b border-base-200 bg-base-200/40">
              <td colspan="8" class="px-3 py-3">
                <div class="grid gap-4 sm:grid-cols-2">
                  <div>
                    <p class="text-[11px] font-semibold uppercase tracking-wider text-base-content/40">Pourquoi cette hypothèse</p>
                    <ul class="mt-1 space-y-0.5">
                      <li v-for="reason in host.fingerprint.evidence ?? []" :key="reason" class="text-[12px] text-base-content/65">
                        {{ reason }}
                      </li>
                      <li v-if="!host.fingerprint.evidence?.length" class="text-[12px] text-base-content/45">
                        Aucun signal exploitable. L'hôte répond mais ne dit rien de lui.
                      </li>
                    </ul>
                  </div>
                  <div>
                    <p class="text-[11px] font-semibold uppercase tracking-wider text-base-content/40">Détails</p>
                    <dl class="mt-1 space-y-0.5 text-[12px]">
                      <div v-if="host.ssdp?.server" class="flex gap-2">
                        <dt class="text-base-content/45">SSDP</dt>
                        <dd class="min-w-0 truncate">{{ host.ssdp.server }}</dd>
                      </div>
                      <div v-if="host.httpTitle" class="flex gap-2">
                        <dt class="text-base-content/45">HTTP</dt>
                        <dd class="min-w-0 truncate">{{ host.httpTitle }}</dd>
                      </div>
                      <div v-if="host.mdnsServices.length" class="flex gap-2">
                        <dt class="shrink-0 text-base-content/45">mDNS</dt>
                        <dd class="min-w-0 font-mono text-[11px]">{{ host.mdnsServices.join(' ') }}</dd>
                      </div>
                      <div v-if="host.rttMs !== null" class="flex gap-2">
                        <dt class="text-base-content/45">Latence</dt>
                        <dd class="tabular">{{ host.rttMs }} ms</dd>
                      </div>
                      <div class="flex gap-2">
                        <dt class="text-base-content/45">Vu</dt>
                        <dd>{{ formatRelative(host.lastSeenAt) }}</dd>
                      </div>
                    </dl>
                  </div>
                </div>

                <div class="mt-3 flex gap-2 border-t border-base-300 pt-3">
                  <NuxtLink v-if="host.deviceId" :to="`/devices/${host.deviceId}`" class="btn btn-xs admin-cta">
                    Ouvrir l'appareil
                  </NuxtLink>
                  <NuxtLink v-else to="/integrations" class="btn btn-xs btn-outline">
                    Voir les intégrations
                  </NuxtLink>
                  <button class="btn btn-xs btn-ghost" @click="ignore(host.ip, !host.ignored)">
                    {{ host.ignored ? 'Ne plus ignorer' : 'Ignorer cet hôte' }}
                  </button>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <!-- Phone: a stacked list carrying the two or three fields the table is read for -->
      <div class="divide-y divide-base-200 lg:hidden">
        <div v-for="host in rows" :key="host.ip" class="p-3">
          <div class="flex items-start gap-2">
            <Icon :name="CATEGORY_ICON[host.fingerprint.category ?? 'unknown'] ?? 'ph:question'" class="mt-0.5 size-4 shrink-0 text-base-content/45" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] font-medium">{{ bestName(host) }}</p>
              <p class="truncate font-mono text-[11px] text-base-content/50">{{ host.ip }} · {{ host.macVendor ?? 'constructeur inconnu' }}</p>
            </div>
            <NuxtLink v-if="host.deviceId" :to="`/devices/${host.deviceId}`" class="shrink-0 text-success">
              <Icon name="ph:check-circle-fill" class="size-4" />
            </NuxtLink>
          </div>
        </div>
      </div>
    </div>

    <p class="mt-4 text-[12px] text-base-content/45">
      Le scan est volontairement poli: des connexions TCP sur des ports connus plutôt qu'un balayage ICMP,
      pour ne demander aucun privilège administrateur et ne rien casser sur le réseau.
    </p>
  </div>
</template>
