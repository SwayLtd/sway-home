<script setup lang="ts">
/**
 * The quick-tool dock.
 *
 * Five tools that are useful *while doing something else*, which is what a dock is for:
 * the assistant, live activity, the network scan, the proposals waiting for a yes, and
 * what the hub is busy with. A tool that needs the whole screen is a page, not a dock panel.
 */
import type { ReviewedProposal } from '~/components/ProposalReview.vue'

const { dockTool } = useShell()
const { house, events, refresh, deviceById } = useHouse()
const { preferences } = useAiPreferences()
const { tasks: hubTasks, rows: taskRows, load: loadTasks, cancel: cancelTask, retry: retryTask } = useTasks()

const TITLES: Record<string, { label: string; icon: string }> = {
  agent: { label: 'Assistant', icon: 'ph:chat-circle-dots' },
  timeline: { label: 'Activité', icon: 'ph:pulse' },
  scan: { label: 'Scan réseau', icon: 'ph:broadcast' },
  proposals: { label: 'Propositions', icon: 'ph:seal-question' },
  tasks: { label: 'Tâches', icon: 'ph:list-checks' },
}

const title = computed(() => TITLES[dockTool.value ?? 'agent'] ?? TITLES.agent!)

// --- scan ---------------------------------------------------------------------------
const scanning = computed(() => house.value?.scan.running ?? false)
// The scan's own task rows: the same phases this panel used to draw as a hand-made bar,
// now with per-phase status, detail and a retry/cancel that the bar never had.
const scanTaskRows = computed(() => hubTasks.value.filter((task) => task.kind === 'scan').map(toTaskRow))

async function startScan(deep: boolean) {
  await hubFetch('/scan', { method: 'POST', body: { quick: !deep, deep } })
}

// --- proposals ----------------------------------------------------------------------
const proposals = ref<ReviewedProposal[]>([])

async function loadProposals() {
  proposals.value = (await hubFetch<{ proposals: ReviewedProposal[] }>('/agent/proposals')).proposals
}

async function onDecided() {
  await loadProposals()
  await refresh()
}

// --- tasks ----------------------------------------------------------------------------
const TASKS_EMPTY = 'Rien à faire en ce moment.'

watch(
  dockTool,
  (tool) => {
    if (tool === 'proposals') void loadProposals()
    // The scan panel shows scan tasks too, so it needs the same list loaded.
    if (tool === 'tasks' || tool === 'scan') void loadTasks()
  },
  { immediate: true }
)

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

        <p v-if="!scanning && house?.scan.finishedAt" class="mt-2 text-[11px] text-base-content/50">
          Dernier scan {{ formatRelative(house.scan.finishedAt) }} en {{ (house.scan.durationMs / 1000).toFixed(1) }} s,
          {{ house.scan.newDevices }} nouveaux appareils.
        </p>

        <div class="mt-3 flex gap-2">
          <button class="btn btn-sm admin-cta flex-1" :disabled="scanning" @click="startScan(false)">Scan rapide</button>
          <button class="btn btn-sm btn-outline flex-1" :disabled="scanning" @click="startScan(true)">Scan complet</button>
        </div>
      </div>

      <!-- The scan's own task rows carry the same phases the old progress bar drew, plus a
           retry and a cancel it never had. -->
      <AiTaskRows v-if="scanTaskRows.length" class="mt-3" :variant="preferences.tasks" :tasks="scanTaskRows" @retry="retryTask" @cancel="cancelTask" />

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

      <article v-for="proposal in proposals" :key="proposal.id" class="mb-3 rounded-xl border border-base-300 bg-base-100 p-3">
        <ProposalReview :proposal="proposal" compact @decided="onDecided" />
      </article>
    </div>

    <!-- Tasks -->
    <div v-else-if="dockTool === 'tasks'" class="min-h-0 flex-1 overflow-y-auto px-3 pb-4 thin-scroll">
      <div v-if="taskRows.length === 0" class="py-10 text-center">
        <Icon name="ph:check-circle" class="mx-auto size-8 text-base-content/25" />
        <p class="mt-2 text-[13px] text-base-content/50">{{ TASKS_EMPTY }}</p>
      </div>

      <AiTaskRows v-else :variant="preferences.tasks" :tasks="taskRows" @retry="retryTask" @cancel="cancelTask" />
    </div>
  </div>
</template>
