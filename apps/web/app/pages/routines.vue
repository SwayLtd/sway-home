<script setup lang="ts">
/**
 * Routines.
 *
 * A master-detail page built on the agent component kit: the left column is the routine list
 * (AiFilterTable, one status pill per routine status), the right column is whichever routine is
 * selected, drawn as a canvas (AiFlowchart) with its stored JSON underneath (AiCodeBlock) - a
 * diff with Enregistrer/Annuler as soon as an edit on the canvas makes the draft differ from
 * what the hub has. A suggested routine additionally gets a recommendation card above the
 * canvas: the routine as proposed, plus one option per alternative the hub attached to it.
 * Nothing the agent proposes runs before someone confirms it there.
 *
 * "Apprendre une tâche" is the other way to write a routine: record what a person does by hand
 * (apps/hub/app/services/teach_service.ts) and let the hub turn it into a suggestion.
 */

import type { Routine } from '@sway-home/shared/automation'
import type { FilterTableColumnLabels, FilterTableRow, FilterTableStatus } from '~/utils/aiFilterTable'
import type { FlowchartNode } from '~/utils/aiFlowchart'
import type { RecommendationCardOption } from '~/utils/aiRecommendationCard'
import type { ThinkingRow } from '~/utils/aiThinking'
import type { RoutineFlowContext } from '~/utils/routineFlow'

const { devices, deviceById, areaById, refresh } = useHouse()
const { status: teachStatus, busy: teachBusy, error: teachError, load: teachLoad, start: teachStart, stop: teachStop, cancel: teachCancel } = useTeach()

// ---------------------------------------------------------------------------------------
// Routines and scenes
// ---------------------------------------------------------------------------------------

const routines = ref<Routine[]>([])
const scenes = ref<{ id: string; name: string }[]>([])
const loading = ref(true)
const busy = ref<string | null>(null)
const selectedId = ref<string | null>(null)

async function load() {
  loading.value = true
  try {
    routines.value = (await hubFetch<{ routines: Routine[] }>('/routines')).routines
  } finally {
    loading.value = false
  }
}
async function loadScenes() {
  scenes.value = (await hubFetch<{ scenes: { id: string; name: string }[] }>('/scenes')).scenes
}
onMounted(() => {
  load()
  loadScenes()
  teachLoad()
})

const selected = computed(() => routines.value.find((routine) => routine.id === selectedId.value))
const activeCount = computed(() => routines.value.filter((routine) => routine.status === 'active').length)
const suggestedCount = computed(() => routines.value.filter((routine) => routine.status === 'suggested').length)

function selectRoutine(id: string | null) {
  selectedId.value = id
}

// ---------------------------------------------------------------------------------------
// The list (AiFilterTable)
// ---------------------------------------------------------------------------------------

const FILTER_TABLE_LABELS: FilterTableColumnLabels = { label: 'Routine', date: 'Dernière exécution', status: 'Statut', owner: 'Auteur' }
const filter = ref(FILTER_TABLE_ALL)

const statuses = computed<FilterTableStatus[]>(() => {
  const defs: FilterTableStatus[] = [
    { key: 'active', label: 'Actives', tone: 'success' },
    { key: 'paused', label: 'En pause', tone: 'warning' },
    { key: 'suggested', label: 'Suggérées', tone: 'info' },
  ]
  if (routines.value.some((routine) => routine.status === 'archived')) defs.push({ key: 'archived', label: 'Archivées', tone: 'warning' })
  return defs
})

/** teach_service.ts and insight_engine.ts both write `authoredBy: 'agent'` (a taught routine, a
 *  habit noticed on its own, and one the chat assistant wrote are all "the agent" to the
 *  schema) - the recorded-by-demonstration case is the one told apart here, by the fixed
 *  sentence teach_service.ts always opens its reason with; everything else agent-authored
 *  reads as "Assistant". */
function routineOwner(routine: Routine): string {
  if (routine.authoredBy === 'user') return 'Vous'
  if (routine.authoredBy === 'template') return 'Modèle'
  if (routine.authoredBy === 'import') return 'Import'
  return routine.suggestionReason?.startsWith('Enregistré pendant que vous le faisiez') ? 'Appris' : 'Assistant'
}

const rows = computed<FilterTableRow[]>(() =>
  routines.value.map((routine) => ({
    id: routine.id,
    label: routine.name,
    date: routine.lastTriggeredAt ? formatRelative(routine.lastTriggeredAt) : 'Jamais',
    status: routine.status,
    owner: routineOwner(routine),
  }))
)

const STATUS_LABEL: Record<string, string> = { active: 'Active', paused: 'En pause', suggested: 'Suggérée', archived: 'Archivée' }

// ---------------------------------------------------------------------------------------
// The canvas (AiFlowchart) + the draft it edits
// ---------------------------------------------------------------------------------------

const scenesById = computed(() => new Map(scenes.value.map((scene) => [scene.id, scene.name])))
const routinesById = computed(() => new Map(routines.value.map((routine) => [routine.id, routine.name])))

const flowContext: RoutineFlowContext = {
  deviceName: (id) => deviceById.value.get(id)?.name ?? id,
  areaName: (id) => (id ? (areaById.value.get(id)?.name ?? null) : null),
  sceneName: (id) => scenesById.value.get(id) ?? id,
  routineName: (id) => routinesById.value.get(id) ?? id,
}

const draft = ref<Routine | null>(null)
watch(
  selected,
  (routine) => {
    draft.value = routine ? (JSON.parse(JSON.stringify(routine)) as Routine) : null
  },
  { immediate: true }
)

const flowNodes = ref<FlowchartNode[]>([])
watch(
  draft,
  (routine) => {
    flowNodes.value = routine ? routineToFlowchartNodes(routine, flowContext) : []
  },
  { immediate: true }
)

function onFlowchartChange(nodeId: string, rowIndex: number, change: { segmentId: string; value: string }) {
  if (!draft.value) return
  draft.value = applyFlowchartChange(draft.value, nodeId, rowIndex, change.segmentId, change.value)
}

// ---------------------------------------------------------------------------------------
// The JSON / diff (AiCodeBlock) + save
// ---------------------------------------------------------------------------------------

function routineCodeView(routine: Routine) {
  return { name: routine.name, triggers: routine.triggers, conditions: routine.conditions, actions: routine.actions }
}
/** A filename for the code block header: lowercase, dashes, no accent - kept plain ASCII on
 *  purpose so the source never has to carry a raw combining-mark character to strip one. */
function slugify(name: string): string {
  const ACCENTS: Record<string, string> = { a: 'aàâä', e: 'eéèêë', i: 'iîï', o: 'oôö', u: 'uùûü', c: 'cç' }
  const plain: Record<string, string> = {}
  for (const [base, accented] of Object.entries(ACCENTS)) for (const letter of accented) plain[letter] = base

  const cleaned = name
    .toLowerCase()
    .split('')
    .map((letter) => plain[letter] ?? letter)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
  return cleaned || 'routine'
}

const codeBefore = computed(() => (selected.value ? JSON.stringify(routineCodeView(selected.value), null, 2) : ''))
const codeAfter = computed(() => (draft.value ? JSON.stringify(routineCodeView(draft.value), null, 2) : ''))
const isDirty = computed(() => selected.value !== undefined && codeBefore.value !== codeAfter.value)

const saveBusy = ref(false)
const saveErrors = ref<string[] | null>(null)

async function saveDraft() {
  if (!selected.value || !draft.value) return
  const before = selected.value
  const after = draft.value
  const patch: Record<string, unknown> = {}
  if (JSON.stringify(after.triggers) !== JSON.stringify(before.triggers)) patch.triggers = after.triggers
  if (JSON.stringify(after.conditions) !== JSON.stringify(before.conditions)) patch.conditions = after.conditions
  if (JSON.stringify(after.actions) !== JSON.stringify(before.actions)) patch.actions = after.actions
  if (Object.keys(patch).length === 0) return

  saveBusy.value = true
  saveErrors.value = null
  try {
    await hubFetch(`/routines/${before.id}`, { method: 'PATCH', body: patch })
    const id = before.id
    await load()
    selectRoutine(id)
  } catch (failure) {
    const data = (failure as { data?: { errors?: string[]; error?: string } }).data
    saveErrors.value = data?.errors ?? [data?.error ?? "La routine n'a pas pu être enregistrée."]
  } finally {
    saveBusy.value = false
  }
}

function cancelDraft() {
  draft.value = selected.value ? (JSON.parse(JSON.stringify(selected.value)) as Routine) : null
  saveErrors.value = null
}

// ---------------------------------------------------------------------------------------
// Suggestions (AiRecommendationCard)
// ---------------------------------------------------------------------------------------

const MAIN_OPTION = 'main'

const recommendationOptions = computed<RecommendationCardOption[]>(() => {
  const routine = selected.value
  if (!routine || routine.status !== 'suggested') return []
  return [
    {
      id: MAIN_OPTION,
      title: routine.name,
      body: routine.suggestionReason ?? routine.description ?? 'Telle que proposée.',
      confidence: routine.confidence ?? undefined,
      cta: 'Activer',
      ctaVariant: 'accent',
    },
    ...(routine.alternatives ?? []).map((alternative) => ({
      id: alternative.id,
      title: alternative.title,
      body: alternative.description,
      cta: 'Activer cette version',
      ctaVariant: 'primary' as const,
    })),
  ]
})

async function confirmSuggestion(option: RecommendationCardOption) {
  const routine = selected.value
  if (!routine) return
  busy.value = routine.id
  try {
    await hubFetch(`/routines/${routine.id}/approve`, { method: 'POST', body: option.id === MAIN_OPTION ? {} : { alternativeId: option.id } })
    await load()
    selectRoutine(routine.id)
    await refresh()
  } finally {
    busy.value = null
  }
}

async function dismissSuggestion() {
  const routine = selected.value
  if (!routine) return
  busy.value = routine.id
  try {
    await hubFetch(`/routines/${routine.id}`, { method: 'PATCH', body: { status: 'archived' } })
    await load()
    selectRoutine(routine.id)
    await refresh()
  } finally {
    busy.value = null
  }
}

// ---------------------------------------------------------------------------------------
// Run / pause / delete / suggest-from-habits - the page's pre-existing features
// ---------------------------------------------------------------------------------------

async function run(routine: Routine) {
  busy.value = routine.id
  try {
    await hubFetch(`/routines/${routine.id}/run`, { method: 'POST' })
  } finally {
    busy.value = null
  }
}

async function setStatus(routine: Routine, status: 'active' | 'paused') {
  busy.value = routine.id
  try {
    await hubFetch(`/routines/${routine.id}`, { method: 'PATCH', body: { status, enabled: status === 'active' } })
    await load()
  } finally {
    busy.value = null
  }
}

async function removeSelected(routine: Routine) {
  busy.value = routine.id
  try {
    await hubFetch(`/routines/${routine.id}`, { method: 'DELETE' })
    if (selectedId.value === routine.id) selectRoutine(null)
    await load()
    await refresh()
  } finally {
    busy.value = null
  }
}

const toggleLabel = computed(() => (selected.value?.status === 'active' ? 'Mettre en pause' : 'Réactiver'))
const toggleTarget = computed<'active' | 'paused'>(() => (selected.value?.status === 'active' ? 'paused' : 'active'))

async function askForSuggestions() {
  busy.value = 'suggest'
  try {
    await hubFetch('/routines/suggest', { method: 'POST' })
    await load()
  } finally {
    busy.value = null
  }
}

// ---------------------------------------------------------------------------------------
// Apprendre une tâche (AiAgentScreen + AiThinking)
// ---------------------------------------------------------------------------------------

const cameraDevice = computed(() => devices.value.find((device) => device.capabilities.includes('camera')))

const screenOpen = ref(false)
const snapshotTick = ref(Date.now())
let snapshotTimer: ReturnType<typeof setInterval> | null = null
watch(screenOpen, (open) => {
  if (snapshotTimer) {
    clearInterval(snapshotTimer)
    snapshotTimer = null
  }
  if (open) {
    snapshotTick.value = Date.now()
    snapshotTimer = setInterval(() => {
      snapshotTick.value = Date.now()
    }, 2000)
  }
})
onBeforeUnmount(() => {
  if (snapshotTimer) clearInterval(snapshotTimer)
})

const cameraSnapshotUrl = computed(() => {
  const device = cameraDevice.value
  if (!device) return undefined
  return `/api/cameras/${encodeURIComponent(device.adapterId)}/${encodeURIComponent(device.nativeId)}/snapshot?t=${snapshotTick.value}`
})

const teachStartedAt = computed(() => (teachStatus.value.startedAt ? Date.parse(teachStatus.value.startedAt) : undefined))
const teachOutcome = ref<'empty' | null>(null)
watch(
  () => teachStatus.value.active,
  (active) => {
    if (active) teachOutcome.value = null
  }
)

/** Only the attributes teach_service.ts's TAUGHT_KEYS ever records, in words. */
function describeTaughtState(state: Record<string, unknown>): string {
  const bits: string[] = []
  if (typeof state.on === 'boolean') bits.push(state.on ? 'allumé' : 'éteint')
  if (typeof state.brightness === 'number') bits.push(`${Math.round(state.brightness)} %`)
  if (typeof state.colorTemperature === 'number') bits.push(`${Math.round(state.colorTemperature)} K`)
  if (typeof state.hue === 'number' || typeof state.saturation === 'number') bits.push('couleur modifiée')
  if (typeof state.position === 'number') bits.push(`position ${Math.round(state.position)} %`)
  if (typeof state.tilt === 'number') bits.push(`orientation ${Math.round(state.tilt)} %`)
  if (typeof state.targetTemperature === 'number') bits.push(`consigne ${state.targetTemperature} °C`)
  if (typeof state.hvacMode === 'string') bits.push(String(state.hvacMode))
  if (typeof state.volume === 'number') bits.push(`volume ${Math.round(state.volume)} %`)
  if (typeof state.fanSpeed === 'number') bits.push(`ventilation ${Math.round(state.fanSpeed)} %`)
  if (typeof state.effect === 'string') bits.push(String(state.effect))
  return bits.length > 0 ? bits.join(', ') : 'modifié'
}

const teachRows = computed<ThinkingRow[]>(() =>
  teachStatus.value.steps.map((step, index) => ({
    id: `${step.deviceId}-${index}-${step.at}`,
    primary: step.deviceName,
    secondary: describeTaughtState(step.state),
  }))
)

async function onTeachRecord() {
  await teachStart()
}

async function onTeachStop() {
  const result = await teachStop()
  if (result?.routine) {
    teachOutcome.value = null
    await load()
    selectRoutine(result.routine.id)
  } else {
    teachOutcome.value = 'empty'
  }
}

async function onTeachCancel() {
  await teachCancel()
  teachOutcome.value = null
}
</script>

<template>
  <div class="mx-auto max-w-6xl">
    <PageHeader
      title="Routines"
      :subtitle="`${activeCount} actives · ${suggestedCount} proposées`"
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

    <EmptyState
      v-if="!loading && routines.length === 0"
      icon="ph:flow-arrow"
      title="Aucune routine"
      description="Ajoutez un capteur de mouvement ou un contact de porte : l'assistant proposera la routine qui va avec, ou enregistrez une tâche plus bas."
      action-label="Chercher des habitudes"
      @action="askForSuggestions"
    />

    <div v-else class="grid grid-cols-1 gap-6 lg:grid-cols-[480px_1fr]">
      <!-- the list -->
      <section class="min-w-0">
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">Toutes les routines</h2>
        <div class="bg-canvas rounded-window p-4">
          <AiFilterTable
            v-model:filter="filter"
            :rows="rows"
            :statuses="statuses"
            :labels="FILTER_TABLE_LABELS"
            :selected-id="selectedId"
            @select="(row) => selectRoutine(row.id)"
          />
        </div>
      </section>

      <!-- the detail -->
      <section class="min-w-0">
        <template v-if="selected && draft">
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <h2 class="text-[15px] font-semibold">{{ selected.name }}</h2>
            <span class="shrink-0 rounded-full bg-base-200 px-2 py-0.5 text-[11px]">{{ STATUS_LABEL[selected.status] ?? selected.status }}</span>
            <div class="min-w-2 flex-1" />
            <button class="btn btn-xs btn-outline gap-1" :disabled="busy === selected.id" @click="run(selected)">
              <Icon name="ph:play" class="size-3.5" />
              Lancer
            </button>
            <button v-if="selected.status !== 'suggested'" class="btn btn-xs btn-outline gap-1" :disabled="busy === selected.id" @click="setStatus(selected, toggleTarget)">
              <Icon :name="selected.status === 'active' ? 'ph:pause' : 'ph:play'" class="size-3.5" />
              {{ toggleLabel }}
            </button>
            <button class="btn btn-xs btn-ghost gap-1 text-error" :disabled="busy === selected.id" @click="removeSelected(selected)">
              <Icon name="ph:trash" class="size-3.5" />
              Supprimer
            </button>
          </div>

          <AiRecommendationCard
            v-if="selected.status === 'suggested'"
            class="mb-4"
            :options="recommendationOptions"
            @confirm="confirmSuggestion"
            @dismiss="dismissSuggestion"
          />

          <div class="bg-canvas rounded-window mb-4 overflow-x-auto p-4">
            <AiFlowchart :nodes="flowNodes" @update:nodes="flowNodes = $event" @change="onFlowchartChange" />
          </div>

          <div class="flex flex-col items-start gap-2">
            <AiCodeBlock
              :variant="isDirty ? 'Diff' : 'Code'"
              :code="codeAfter"
              :before="codeBefore"
              :after="codeAfter"
              language="json"
              :filename="`${slugify(selected.name)}.json`"
            />
            <div v-if="isDirty" class="flex flex-wrap items-center gap-2">
              <button class="btn btn-sm admin-cta" :disabled="saveBusy" @click="saveDraft">Enregistrer</button>
              <button class="btn btn-sm btn-outline" :disabled="saveBusy" @click="cancelDraft">Annuler</button>
            </div>
            <ul v-if="saveErrors && saveErrors.length > 0" class="w-full max-w-105 rounded-xl border border-error/30 bg-error/5 p-3 text-[12px] text-error">
              <li v-for="message in saveErrors" :key="message">{{ message }}</li>
            </ul>
          </div>
        </template>

        <EmptyState
          v-else
          icon="ph:cursor-click"
          title="Aucune routine sélectionnée"
          description="Choisissez une routine dans la liste pour voir son schéma et son JSON."
        />
      </section>
    </div>

    <!-- Apprendre une tâche -->
    <section class="mt-10">
      <h2 class="mb-1 text-xs font-semibold uppercase tracking-wider text-base-content/40">Apprendre une tâche</h2>
      <p class="mb-3 text-[12px] text-base-content/50">Faites le geste à la main, une fois : la maison regarde et en propose une routine.</p>

      <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
        <AiAgentScreen
          v-model:open="screenOpen"
          :src="cameraSnapshotUrl"
          :title="cameraDevice ? cameraDevice.name : 'Aucune caméra'"
          :recording="teachStatus.active"
          :started-at="teachStartedAt"
          @record="onTeachRecord"
          @stop="onTeachStop"
        />

        <div class="min-w-0 flex-1">
          <button v-if="teachStatus.active" class="btn btn-sm btn-ghost gap-2 text-base-content/60" :disabled="teachBusy" @click="onTeachCancel">
            <Icon name="ph:x" class="size-4" />
            Annuler l'enregistrement
          </button>

          <AiThinking
            v-if="teachStatus.active"
            class="mt-2"
            variant="Steps"
            :working="true"
            :rows="teachRows"
            active-label="Enregistrement en cours"
            :more="teachRows.length === 0 ? 'Agissez sur un appareil pour commencer.' : undefined"
          />
          <p v-else-if="teachOutcome === 'empty'" class="mt-2 text-[12px] text-base-content/55">Rien n'a été enregistré : aucun geste détecté pendant l'enregistrement.</p>
          <p v-else class="text-[12px] text-base-content/55">
            Ouvrez l'écran puis « Apprendre une tâche ». Chaque geste sur un appareil s'affiche ici, et « Terminer » propose la routine.
          </p>

          <p v-if="teachError" class="mt-2 text-[12px] text-error">{{ teachError }}</p>
        </div>
      </div>
    </section>
  </div>
</template>
