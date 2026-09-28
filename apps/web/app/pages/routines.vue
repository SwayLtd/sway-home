<script setup lang="ts">
/**
 * Routines.
 *
 * Suggested ones sit at the top and are the point of the page: a routine the agent wrote
 * is a card with a reason and two buttons, not a silent change. Nothing the agent proposes
 * runs before someone says yes, and the card says exactly what would happen.
 */

interface Routine {
  id: string
  name: string
  description: string | null
  enabled: boolean
  mode: string
  triggers: Record<string, any>[]
  conditions: Record<string, any>[]
  actions: Record<string, any>[]
  authoredBy: string
  status: string
  suggestionReason: string | null
  areaId: string | null
  lastTriggeredAt: string | null
  runCount: number
}

const { areas, refresh } = useHouse()
const routines = ref<Routine[]>([])
const loading = ref(true)
const busy = ref<string | null>(null)
const expanded = ref<string | null>(null)

async function load() {
  loading.value = true
  try {
    routines.value = (await hubFetch<{ routines: Routine[] }>('/routines')).routines
  } finally {
    loading.value = false
  }
}
onMounted(load)

const suggested = computed(() => routines.value.filter((routine) => routine.status === 'suggested'))
const active = computed(() => routines.value.filter((routine) => routine.status === 'active'))
const paused = computed(() => routines.value.filter((routine) => routine.status === 'paused'))

async function approve(routine: Routine) {
  busy.value = routine.id
  try {
    await hubFetch(`/routines/${routine.id}/approve`, { method: 'POST' })
    await load()
    await refresh()
  } finally {
    busy.value = null
  }
}

async function remove(routine: Routine) {
  busy.value = routine.id
  try {
    await hubFetch(`/routines/${routine.id}`, { method: 'DELETE' })
    await load()
    await refresh()
  } finally {
    busy.value = null
  }
}

async function run(routine: Routine) {
  busy.value = routine.id
  try {
    await hubFetch(`/routines/${routine.id}/run`, { method: 'POST' })
  } finally {
    busy.value = null
  }
}

async function setStatus(routine: Routine, status: string) {
  busy.value = routine.id
  try {
    await hubFetch(`/routines/${routine.id}`, { method: 'PATCH', body: { status, enabled: status === 'active' } })
    await load()
  } finally {
    busy.value = null
  }
}

async function askForSuggestions() {
  busy.value = 'suggest'
  try {
    await hubFetch('/routines/suggest', { method: 'POST' })
    await load()
  } finally {
    busy.value = null
  }
}

const TRIGGER_LABEL: Record<string, string> = {
  device_state: 'un appareil change',
  capability_state: 'une capacité change',
  device_event: 'un évènement appareil',
  time: 'à une heure',
  cron: 'planification',
  sun: 'soleil',
  presence: 'présence',
  house_mode: 'mode de la maison',
  interval: 'intervalle',
  webhook: 'webhook',
  voice_intent: 'phrase vocale',
  manual: 'manuel',
}

const ACTION_LABEL: Record<string, string> = {
  device_command: 'commander un appareil',
  scene: 'activer une scène',
  delay: 'attendre',
  notify: 'notifier',
  speak: 'parler',
  set_house_mode: 'changer le mode',
  run_routine: 'lancer une routine',
  webhook: 'appeler un webhook',
  ask_agent: "demander à l'assistant",
  wait_until: "attendre jusqu'à",
  stop: 'arrêter',
}

function describeTriggers(routine: Routine): string {
  return routine.triggers.map((trigger) => TRIGGER_LABEL[trigger.kind] ?? trigger.kind).join(', ')
}

function describeActions(routine: Routine): string {
  return routine.actions.map((action) => ACTION_LABEL[action.kind] ?? action.kind).join(', ')
}

function areaName(id: string | null): string | null {
  return id ? areas.value.find((area) => area.id === id)?.name ?? null : null
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <PageHeader
      title="Routines"
      :subtitle="`${active.length} actives · ${suggested.length} proposées`"
      :loading="loading"
      :breadcrumb="[{ label: 'Intelligence' }, { label: 'Routines' }]"
    >
      <template #actions>
        <button class="btn btn-sm btn-outline gap-2" :disabled="busy === 'suggest'" @click="askForSuggestions">
          <Icon name="ph:lightbulb" class="size-4" />
          Chercher des habitudes
        </button>
      </template>
    </PageHeader>

    <!-- Suggested: the reason is the product -->
    <section v-if="suggested.length > 0" class="mb-8">
      <h2 class="mb-1 text-xs font-semibold uppercase tracking-wider text-base-content/40">Proposées par l'assistant</h2>
      <p class="mb-3 text-[12px] text-base-content/50">
        Rien ne s'exécute tant que vous n'avez pas validé. Chaque carte dit pourquoi elle existe.
      </p>

      <article
        v-for="routine in suggested"
        :key="routine.id"
        class="mb-3 rounded-2xl border border-primary/40 bg-base-100 p-4"
      >
        <div class="flex items-start gap-3">
          <span class="grid size-8 shrink-0 place-items-center rounded-xl bg-primary/25">
            <Icon name="ph:sparkle" class="size-4" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-[13px] font-semibold">{{ routine.name }}</p>
            <p v-if="routine.description" class="mt-0.5 text-[12px] text-base-content/65">{{ routine.description }}</p>
            <p v-if="routine.suggestionReason" class="mt-1.5 flex items-start gap-1.5 text-[12px] text-base-content/50">
              <Icon name="ph:info" class="mt-0.5 size-3.5 shrink-0" />
              {{ routine.suggestionReason }}
            </p>
          </div>
          <span v-if="areaName(routine.areaId)" class="shrink-0 rounded-full bg-base-200 px-2 py-0.5 text-[11px]">
            {{ areaName(routine.areaId) }}
          </span>
        </div>

        <p class="mt-3 text-[11px] text-base-content/45">
          Quand {{ describeTriggers(routine) }} → {{ describeActions(routine) }}
        </p>

        <div class="mt-3 flex gap-2 border-t border-base-200 pt-3">
          <button class="btn btn-sm admin-cta" :disabled="busy === routine.id" @click="approve(routine)">
            Activer
          </button>
          <button class="btn btn-sm btn-outline" :disabled="busy === routine.id" @click="expanded = expanded === routine.id ? null : routine.id">
            Voir le détail
          </button>
          <div class="flex-1" />
          <button class="btn btn-sm btn-ghost text-base-content/55" :disabled="busy === routine.id" @click="remove(routine)">
            Refuser
          </button>
        </div>

        <pre
          v-if="expanded === routine.id"
          class="mt-3 max-h-64 overflow-auto rounded-xl bg-base-200 p-3 font-mono text-[11px] thin-scroll"
        >{{ JSON.stringify({ triggers: routine.triggers, conditions: routine.conditions, actions: routine.actions }, null, 2) }}</pre>
      </article>
    </section>

    <!-- Active -->
    <section class="mb-8">
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">Actives</h2>

      <EmptyState
        v-if="active.length === 0 && !loading"
        icon="ph:flow-arrow"
        title="Aucune routine active"
        description="Ajoutez un capteur de mouvement ou un contact de porte: l'assistant proposera immédiatement la routine qui va avec."
      />

      <div v-else class="overflow-hidden rounded-2xl border border-base-300 bg-base-100">
        <div
          v-for="routine in active"
          :key="routine.id"
          class="group flex items-center gap-3 border-b border-base-200 p-3 last:border-0"
        >
          <span class="grid size-8 shrink-0 place-items-center rounded-xl bg-base-200">
            <Icon :name="routine.authoredBy === 'agent' ? 'ph:sparkle' : 'ph:flow-arrow'" class="size-4" />
          </span>

          <div class="min-w-0 flex-1">
            <p class="truncate text-[13px] font-medium">{{ routine.name }}</p>
            <p class="truncate text-[11px] text-base-content/50">
              {{ describeTriggers(routine) }} → {{ describeActions(routine) }}
            </p>
          </div>

          <span class="hidden shrink-0 text-[11px] tabular text-base-content/40 sm:block">
            {{ routine.runCount }} fois<span v-if="routine.lastTriggeredAt"> · {{ formatRelative(routine.lastTriggeredAt) }}</span>
          </span>

          <button class="row-action grid size-8 place-items-center rounded-full hover:bg-base-300" :disabled="busy === routine.id" aria-label="Lancer" @click="run(routine)">
            <Icon name="ph:play" class="size-4" />
          </button>
          <button class="row-action grid size-8 place-items-center rounded-full hover:bg-base-300" :disabled="busy === routine.id" aria-label="Mettre en pause" @click="setStatus(routine, 'paused')">
            <Icon name="ph:pause" class="size-4" />
          </button>
          <button class="row-action grid size-8 place-items-center rounded-full hover:bg-error/15 hover:text-error" :disabled="busy === routine.id" aria-label="Supprimer" @click="remove(routine)">
            <Icon name="ph:trash" class="size-4" />
          </button>
        </div>
      </div>
    </section>

    <section v-if="paused.length > 0">
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">En pause</h2>
      <div class="overflow-hidden rounded-2xl border border-base-300 bg-base-100">
        <div v-for="routine in paused" :key="routine.id" class="group flex items-center gap-3 border-b border-base-200 p-3 last:border-0 opacity-70">
          <span class="grid size-8 shrink-0 place-items-center rounded-xl bg-base-200">
            <Icon name="ph:pause" class="size-4" />
          </span>
          <p class="min-w-0 flex-1 truncate text-[13px]">{{ routine.name }}</p>
          <button class="btn btn-xs btn-outline" :disabled="busy === routine.id" @click="setStatus(routine, 'active')">Réactiver</button>
        </div>
      </div>
    </section>
  </div>
</template>
