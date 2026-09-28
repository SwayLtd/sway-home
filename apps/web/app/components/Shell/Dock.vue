<script setup lang="ts">
/**
 * The quick-tool dock.
 *
 * Four tools that are useful *while doing something else*, which is what a dock is for:
 * the assistant, live activity, the network scan, and the proposals waiting for a yes.
 * A tool that needs the whole screen is a page, not a dock panel.
 */

const { dockTool } = useShell()
const { house, events, refresh, deviceById } = useHouse()

const TITLES: Record<string, { label: string; icon: string }> = {
  agent: { label: 'Assistant', icon: 'ph:chat-circle-dots' },
  timeline: { label: 'Activité', icon: 'ph:pulse' },
  scan: { label: 'Scan réseau', icon: 'ph:broadcast' },
  proposals: { label: 'Propositions', icon: 'ph:seal-question' },
}

const title = computed(() => TITLES[dockTool.value ?? 'agent'] ?? TITLES.agent!)

// --- scan ---------------------------------------------------------------------------
const scanning = computed(() => house.value?.scan.running ?? false)
const phase = computed(() => house.value?.scan.phase ?? null)
const PHASE_LABEL: Record<string, string> = {
  arp: 'Table ARP',
  mdns: 'mDNS / Bonjour',
  ssdp: 'SSDP / UPnP',
  sweep: 'Balayage TCP',
  deep: 'Ports étendus',
  names: 'Noms NetBIOS',
  http: 'Bannières HTTP',
  fingerprint: 'Identification',
}

async function startScan(deep: boolean) {
  await hubFetch('/scan', { method: 'POST', body: { quick: !deep, deep } })
}

// --- proposals ----------------------------------------------------------------------
interface Proposal {
  id: string
  summary: string
  reason: string
  risk: string
  commands: { deviceId: string; deviceName: string; command: string; args: Record<string, unknown> }[]
  expiresAt: string
}
const proposals = ref<Proposal[]>([])
const busy = ref<string | null>(null)

async function loadProposals() {
  proposals.value = (await hubFetch<{ proposals: Proposal[] }>('/agent/proposals')).proposals
}

async function decide(id: string, approve: boolean) {
  busy.value = id
  try {
    await hubFetch(`/agent/proposals/${id}/${approve ? 'approve' : 'reject'}`, { method: 'POST' })
    await loadProposals()
    await refresh()
  } finally {
    busy.value = null
  }
}

watch(dockTool, (tool) => {
  if (tool === 'proposals') void loadProposals()
}, { immediate: true })

// --- activity -------------------------------------------------------------------------
// Wording and icons live in useEvents so the dock and the journal page cannot drift apart.
const visibleEvents = computed(() => events.value.filter((event) => event.type !== 'scan.progress').slice(0, 80))
const label = (event: HouseEventView) => eventLabel(event, (id) => deviceById.value.get(id)?.name)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-11 shrink-0 items-center gap-2 px-3">
      <Icon :name="title.icon" class="size-4 text-base-content/60" />
      <span class="text-[13px] font-semibold">{{ title.label }}</span>
      <div class="flex-1" />
      <button class="btn btn-ghost btn-xs btn-square" aria-label="Fermer le panneau" @click="dockTool = null">
        <Icon name="ph:x" class="size-4" />
      </button>
    </div>

    <!-- Assistant -->
    <AgentChat v-if="dockTool === 'agent'" class="min-h-0 flex-1" compact />

    <!-- Activity -->
    <div v-else-if="dockTool === 'timeline'" class="min-h-0 flex-1 overflow-y-auto px-2 pb-4 thin-scroll">
      <p v-if="visibleEvents.length === 0" class="px-2 py-8 text-center text-[13px] text-base-content/50">
        Rien ne s'est passé depuis l'ouverture de cette page.
      </p>
      <div
        v-for="event in visibleEvents"
        :key="event.id"
        class="flex items-start gap-2 rounded-lg px-2 py-1.5 text-[12px] transition-colors hover:bg-base-200"
      >
        <Icon :name="EVENT_ICON[event.type] ?? 'ph:dot-outline'" class="mt-0.5 size-3.5 shrink-0 text-base-content/40" />
        <span class="min-w-0 flex-1 break-words" :class="event.severity === 'critical' || event.severity === 'warning' ? 'text-error' : ''">
          {{ label(event) }}
        </span>
        <span class="shrink-0 tabular text-base-content/35">{{ event.at.slice(11, 19) }}</span>
      </div>
    </div>

    <!-- Scan -->
    <div v-else-if="dockTool === 'scan'" class="min-h-0 flex-1 overflow-y-auto px-3 pb-4 thin-scroll">
      <div class="rounded-xl border border-base-300 bg-base-200 p-3">
        <div class="flex items-center justify-between text-[13px]">
          <span class="font-medium">{{ scanning ? 'Scan en cours' : 'Aucun scan en cours' }}</span>
          <span class="tabular text-base-content/50">{{ house?.scan.hostCount ?? 0 }} hôtes</span>
        </div>

        <div v-if="scanning && phase" class="mt-3">
          <div class="flex items-center justify-between text-[11px] text-base-content/60">
            <span>{{ PHASE_LABEL[phase.phase] ?? phase.phase }}</span>
            <span class="tabular">{{ phase.total > 1 ? `${phase.done}/${phase.total}` : '' }}</span>
          </div>
          <div class="mt-1 h-1 overflow-hidden rounded-full bg-base-300">
            <div
              class="h-full rounded-full bg-base-content transition-[width] duration-300"
              :style="{ width: `${phase.total > 0 ? Math.round((phase.done / phase.total) * 100) : 40}%` }"
            />
          </div>
        </div>

        <p v-else-if="house?.scan.finishedAt" class="mt-2 text-[11px] text-base-content/50">
          Dernier scan {{ formatRelative(house.scan.finishedAt) }} en {{ (house.scan.durationMs / 1000).toFixed(1) }} s,
          {{ house.scan.newDevices }} nouveaux appareils.
        </p>

        <div class="mt-3 flex gap-2">
          <button class="btn btn-sm admin-cta flex-1" :disabled="scanning" @click="startScan(false)">Scan rapide</button>
          <button class="btn btn-sm btn-outline flex-1" :disabled="scanning" @click="startScan(true)">Scan complet</button>
        </div>
      </div>

      <NuxtLink to="/network" class="mt-3 flex items-center gap-2 rounded-xl border border-base-300 p-3 text-[13px] transition-colors hover:bg-base-200">
        <Icon name="ph:list-magnifying-glass" class="size-4" />
        Voir la carte du réseau
        <Icon name="ph:arrow-right" class="ml-auto size-4 opacity-40" />
      </NuxtLink>
    </div>

    <!-- Proposals -->
    <div v-else-if="dockTool === 'proposals'" class="min-h-0 flex-1 overflow-y-auto px-3 pb-4 thin-scroll">
      <div v-if="proposals.length === 0" class="py-10 text-center">
        <Icon name="ph:check-circle" class="mx-auto size-8 text-base-content/25" />
        <p class="mt-2 text-[13px] text-base-content/50">Rien n'attend votre accord.</p>
      </div>

      <article
        v-for="proposal in proposals"
        :key="proposal.id"
        class="mb-3 rounded-xl border border-base-300 bg-base-100 p-3"
      >
        <div class="flex items-start gap-2">
          <span
            class="mt-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase"
            :class="proposal.risk === 'high' ? 'bg-error/15 text-error' : 'bg-warning/15 text-warning'"
          >{{ proposal.risk }}</span>
          <p class="min-w-0 flex-1 text-[13px] font-medium">{{ proposal.summary }}</p>
        </div>
        <p class="mt-1 text-[12px] text-base-content/60">{{ proposal.reason }}</p>

        <ul class="mt-2 space-y-0.5">
          <li v-for="(command, index) in proposal.commands.slice(0, 4)" :key="index" class="text-[11px] text-base-content/50">
            {{ command.deviceName }} · {{ command.command }}
          </li>
          <li v-if="proposal.commands.length > 4" class="text-[11px] text-base-content/40">
            et {{ proposal.commands.length - 4 }} autres
          </li>
        </ul>

        <div class="mt-3 flex gap-2">
          <button class="btn btn-sm admin-cta flex-1" :disabled="busy === proposal.id" @click="decide(proposal.id, true)">
            Approuver
          </button>
          <button class="btn btn-sm btn-outline flex-1" :disabled="busy === proposal.id" @click="decide(proposal.id, false)">
            Refuser
          </button>
        </div>
      </article>
    </div>
  </div>
</template>
