<script setup lang="ts">
/**
 * One device.
 *
 * Controls first, because that is what the page is for. Then history, then the identity of
 * the thing - how it was found, what the hub believes it is, and how sure it is. That last
 * part is unusual in a smart-home product and it is deliberate: a guess presented as a fact
 * is how a device ends up mislabelled forever.
 */

const route = useRoute()
const router = useRouter()
const { deviceById, areas, refresh } = useHouse()
const { send } = useCommands()

const deviceId = computed(() => String(route.params.id))
const device = computed(() => deviceById.value.get(deviceId.value) ?? null)

const detail = ref<{ commands: string[]; adapter: { name: string; vendor: string; cloud: boolean } | null } | null>(null)
const history = ref<{ at: string; value: number | string | null }[]>([])
const historyAttribute = ref('temperature')
const editing = ref(false)
const draft = reactive({ name: '', areaId: '', notes: '', favourite: false, critical: false })

watchEffect(async () => {
  if (!deviceId.value) return
  try {
    detail.value = await hubFetch(`/devices/${deviceId.value}`)
  } catch {
    detail.value = null
  }
})

const historyable = computed(() => {
  if (!device.value) return []
  const state = device.value.state
  return ['temperature', 'humidity', 'power', 'brightness', 'illuminance', 'co2', 'battery', 'position', 'volume'].filter(
    (attribute) => typeof state[attribute] === 'number'
  )
})

watch(
  [deviceId, historyAttribute],
  async () => {
    if (!deviceId.value) return
    const attribute = historyable.value.includes(historyAttribute.value) ? historyAttribute.value : historyable.value[0]
    if (!attribute) {
      history.value = []
      return
    }
    historyAttribute.value = attribute
    const payload = await hubFetch<{ points: typeof history.value }>(`/devices/${deviceId.value}/history`, {
      query: { attribute, hours: 24 },
    })
    history.value = payload.points
  },
  { immediate: true }
)

function startEdit() {
  if (!device.value) return
  draft.name = device.value.name
  draft.areaId = device.value.areaId ?? ''
  draft.notes = device.value.notes ?? ''
  draft.favourite = device.value.favourite
  draft.critical = device.value.critical
  editing.value = true
}

async function saveEdit() {
  await hubFetch(`/devices/${deviceId.value}`, {
    method: 'PATCH',
    body: { name: draft.name, areaId: draft.areaId || null, notes: draft.notes, favourite: draft.favourite, critical: draft.critical },
  })
  editing.value = false
  await refresh()
}

async function removeDevice() {
  await hubFetch(`/devices/${deviceId.value}`, { method: 'DELETE' })
  await refresh()
  router.push('/devices')
}

const confirmDelete = ref(false)

const COMMAND_LABEL: Record<string, string> = {
  turnOn: 'Allumer',
  turnOff: 'Éteindre',
  toggle: 'Basculer',
  open: 'Ouvrir',
  close: 'Fermer',
  stop: 'Stop',
  lock: 'Verrouiller',
  unlock: 'Déverrouiller',
  play: 'Lecture',
  pause: 'Pause',
  stopPlayback: 'Arrêter',
  next: 'Suivant',
  previous: 'Précédent',
  identify: 'Localiser',
  snapshot: 'Photo',
  startCleaning: 'Nettoyer',
  returnToDock: 'Retour à la base',
  locateVacuum: 'Localiser',
  startProgram: 'Démarrer',
  stopProgram: 'Arrêter',
  installUpdate: 'Mettre à jour',
  resetEnergy: 'Remettre à zéro',
  boost: 'Boost',
}

const simpleCommands = computed(() =>
  (detail.value?.commands ?? []).filter((command) => command in COMMAND_LABEL && !['unlock', 'installUpdate'].includes(command))
)

const sensitiveCommands = computed(() => (detail.value?.commands ?? []).filter((command) => ['unlock', 'installUpdate'].includes(command)))

const confidenceLabel: Record<string, string> = {
  confirmed: 'Confirmé par l intégration',
  high: 'Forte',
  medium: 'Moyenne',
  low: 'Faible',
  guess: 'Simple supposition',
}

// ---------------------------------------------------------------------------------------
// Réglage fin: scrub-able settings built from the device's own capabilities and live state.
// Only a field a capability actually declares is shown; the arg names below (kelvin, celsius,
// speed, mode...) come straight from packages/shared/src/capabilities.ts, not from the state
// field they adjust.
// ---------------------------------------------------------------------------------------

const HVAC_MODE_OPTIONS: FineTuneOption[] = [
  { value: 'off', label: 'Arrêt' },
  { value: 'heat', label: 'Chauffage' },
  { value: 'cool', label: 'Froid' },
  { value: 'auto', label: 'Auto' },
]

const FAN_MODE_OPTIONS: FineTuneOption[] = [
  { value: 'off', label: 'Arrêt' },
  { value: 'low', label: 'Faible' },
  { value: 'medium', label: 'Moyenne' },
  { value: 'high', label: 'Élevée' },
  { value: 'auto', label: 'Auto' },
  { value: 'quiet', label: 'Silencieuse' },
  { value: 'boost', label: 'Boost' },
]

function numericRange(value: unknown, fallback: [number, number]): [number, number] {
  return Array.isArray(value) && value.length === 2 ? [Number(value[0]), Number(value[1])] : fallback
}

const fineTuneFields = computed<FineTuneField[]>(() => {
  if (!device.value) return []
  const caps = new Set(device.value.capabilities)
  const state = device.value.state
  const fields: FineTuneField[] = []

  if (caps.has('brightness')) {
    fields.push({ key: 'brightness', kind: 'number', label: 'Luminosité', value: Number(state.brightness ?? 0), min: 0, max: 100, step: 1, unit: '%' })
  }
  if (caps.has('colorTemperature')) {
    const range = numericRange(state.colorTemperatureRange, [2000, 6500])
    fields.push({
      key: 'colorTemperature', kind: 'number', label: 'Température',
      value: Number(state.colorTemperature ?? 2700), min: range[0], max: range[1], step: 50, unit: 'K',
    })
  }
  if (caps.has('thermostat')) {
    const range = numericRange(state.targetTemperatureRange, [5, 35])
    fields.push({
      key: 'targetTemperature', kind: 'number', label: 'Consigne',
      value: Number(state.targetTemperature ?? 20), min: range[0], max: range[1], step: 0.5, unit: '°C',
    })
    fields.push({ key: 'hvacMode', kind: 'select', label: 'Mode', value: String(state.hvacMode ?? 'off'), display: 'segment', options: HVAC_MODE_OPTIONS })
  }
  if (caps.has('position')) {
    fields.push({ key: 'position', kind: 'number', label: 'Position', value: Number(state.position ?? 0), min: 0, max: 100, step: 1, unit: '%' })
  }
  if (caps.has('volume')) {
    fields.push({ key: 'volume', kind: 'number', label: 'Volume', value: Number(state.volume ?? 0), min: 0, max: 100, step: 1, unit: '%' })
  }
  if (caps.has('fan')) {
    fields.push({ key: 'fanMode', kind: 'select', label: 'Ventilation', value: String(state.fanMode ?? 'auto'), display: 'menu', options: FAN_MODE_OPTIONS })
  }
  return fields
})

const fineTuneValues = ref<FineTuneValues>({})
let fineTuneEditingUntil = 0

// Hard reset on every device change - this page component is reused across /devices/:id
// navigations, so a stale value from the previous device must not leak into the next one.
// Otherwise stay live-synced to the SSE-updated state, except for ~250ms after a local edit
// (the same window as the commit debounce below), so a drag in progress is not overwritten
// mid-gesture by the very state update its own optimistic command produced.
watch(
  deviceId,
  () => {
    fineTuneEditingUntil = 0
    fineTuneValues.value = fineTuneBaseline(fineTuneFields.value)
  },
  { immediate: true }
)
watch(
  () => device.value?.state,
  () => {
    if (!device.value || Date.now() < fineTuneEditingUntil) return
    fineTuneValues.value = fineTuneBaseline(fineTuneFields.value)
  },
  { deep: true }
)

const fineTuneTimers: Record<string, ReturnType<typeof setTimeout>> = {}

function commitFineTune(key: string, value: number | string) {
  if (!device.value) return
  const id = device.value.id
  switch (key) {
    case 'brightness': void send(id, 'setBrightness', { brightness: value, transitionMs: 400 }); break
    case 'colorTemperature': void send(id, 'setColorTemperature', { kelvin: value, transitionMs: 400 }); break
    case 'targetTemperature': void send(id, 'setTargetTemperature', { celsius: value }); break
    case 'position': void send(id, 'setPosition', { position: value }); break
    case 'volume': void send(id, 'setVolume', { volume: value }); break
    case 'hvacMode': void send(id, 'setHvacMode', { mode: value }); break
    case 'fanMode': void send(id, 'setFanMode', { mode: value }); break
  }
}

// AiFineTuneCard emits `change` continuously while dragging (and on every keystroke of the
// typed input); sending a command per frame would flood the hub, so only the value still
// current 250ms after the last frame is actually sent.
function onFineTuneChange(key: string, value: number | string) {
  fineTuneEditingUntil = Date.now() + 260
  clearTimeout(fineTuneTimers[key])
  fineTuneTimers[key] = setTimeout(() => commitFineTune(key, value), 250)
}

// ---------------------------------------------------------------------------------------
// Camera: a live snapshot loop for AiAgentScreen, and "Apprendre une tâche" through useTeach.
// ---------------------------------------------------------------------------------------

const hasCamera = computed(() => device.value?.capabilities.includes('camera') === true)

const cameraSrc = ref<string | undefined>(undefined)
const cameraLoaded = ref(false)
const cameraLive = ref(false)
const cameraError = ref<string | null>(null)
let cameraObjectUrl: string | null = null
let cameraTimer: ReturnType<typeof setInterval> | null = null

async function refreshSnapshot() {
  if (!device.value || document.hidden) return
  const url = `/api/cameras/${encodeURIComponent(device.value.adapterId)}/${encodeURIComponent(device.value.nativeId)}/snapshot?t=${Date.now()}`
  try {
    const response = await fetch(url)
    if (!response.ok) {
      let message = "La caméra n'a pas répondu."
      try {
        const body = (await response.json()) as { error?: string }
        if (body.error) message = body.error
      } catch {
        // The hub always answers JSON on error; an unparsable body just keeps the generic message.
      }
      cameraError.value = message
      cameraLive.value = false
      return
    }
    const blob = await response.blob()
    const nextUrl = URL.createObjectURL(blob)
    // Preload before swapping `src`, so a failing camera never flashes a broken image over
    // the last good picture - only a picture that actually decoded replaces the current one.
    const preload = new Image()
    preload.onload = () => {
      const previous = cameraObjectUrl
      cameraObjectUrl = nextUrl
      cameraSrc.value = nextUrl
      cameraLoaded.value = true
      cameraLive.value = true
      cameraError.value = null
      if (previous) URL.revokeObjectURL(previous)
    }
    preload.onerror = () => {
      URL.revokeObjectURL(nextUrl)
      cameraError.value = 'Image de la caméra illisible.'
      cameraLive.value = false
    }
    preload.src = nextUrl
  } catch (error) {
    cameraError.value = error instanceof Error ? error.message : "La caméra n'a pas répondu."
    cameraLive.value = false
  }
}

function stopCameraLoop() {
  if (cameraTimer) {
    clearInterval(cameraTimer)
    cameraTimer = null
  }
}
function startCameraLoop() {
  stopCameraLoop()
  void refreshSnapshot()
  cameraTimer = setInterval(() => void refreshSnapshot(), 2000)
}
function onVisibilityChange() {
  if (document.hidden) stopCameraLoop()
  else if (hasCamera.value) startCameraLoop()
}

const { status: teachStatus, error: teachError, start: startTeach, stop: stopTeach, load: loadTeach } = useTeach()
const teaching = computed(() => teachStatus.value.active)
const teachStartedAt = computed(() => (teachStatus.value.startedAt ? Date.parse(teachStatus.value.startedAt) : undefined))
const teachResult = ref<{ text: string } | null>(null)

// Reset and restart on every device change too, for the same reason as the fine-tune values -
// including the "what was learned" note, which belongs to whichever device was recording it.
watch(
  [deviceId, hasCamera],
  ([, has]) => {
    cameraLoaded.value = false
    cameraLive.value = false
    cameraError.value = null
    cameraSrc.value = undefined
    teachResult.value = null
    if (cameraObjectUrl) {
      URL.revokeObjectURL(cameraObjectUrl)
      cameraObjectUrl = null
    }
    if (has) startCameraLoop()
    else stopCameraLoop()
  },
  { immediate: true }
)

async function onCameraRecord() {
  teachResult.value = null
  await startTeach(device.value ? `Depuis ${device.value.name}` : undefined)
}
async function onCameraStop() {
  const result = await stopTeach()
  if (!result) return // useTeach already put the failure in teachError
  teachResult.value = result.routine
    ? { text: `Sway a appris ${result.steps.length} étape${result.steps.length > 1 ? 's' : ''} et propose la routine « ${result.routine.name} ».` }
    : { text: "Aucune étape n'a été enregistrée : rien à proposer." }
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange)
  void loadTeach()
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  stopCameraLoop()
  Object.values(fineTuneTimers).forEach(clearTimeout)
  if (cameraObjectUrl) URL.revokeObjectURL(cameraObjectUrl)
})
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <PageHeader
      v-if="device"
      :title="device.name"
      :subtitle="`${device.online ? 'En ligne' : 'Hors ligne'} · ${stateSummary(device)} · vu ${formatRelative(device.lastSeenAt)}`"
      :breadcrumb="[{ label: 'Maison', to: '/' }, { label: 'Appareils', to: '/devices' }, { label: device.name }]"
    >
      <template #actions>
        <button class="btn btn-sm btn-outline gap-2" @click="startEdit">
          <Icon name="ph:pencil-simple" class="size-4" />
          Modifier
        </button>
        <button
          v-if="detail?.commands.includes('identify')"
          class="btn btn-sm admin-cta gap-2"
          @click="send(device.id, 'identify', { seconds: 5 })"
        >
          <Icon name="ph:broadcast" class="size-4" />
          Localiser
        </button>
      </template>
    </PageHeader>

    <div v-if="!device" class="rounded-2xl border border-base-300 bg-base-100 p-8 text-center">
      <Icon name="ph:question" class="mx-auto size-8 text-base-content/25" />
      <p class="mt-3 text-[13px]">Cet appareil n'existe plus.</p>
      <NuxtLink to="/devices" class="btn btn-sm admin-cta mt-4">Retour aux appareils</NuxtLink>
    </div>

    <template v-else>
      <!-- Controls -->
      <section class="mb-5 rounded-2xl border border-base-300 bg-base-100 p-4">
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">Commandes</h2>

        <DeviceControls :device="device" />

        <div v-if="simpleCommands.length" class="mt-4 flex flex-wrap gap-2 border-t border-base-200 pt-4">
          <button
            v-for="command in simpleCommands"
            :key="command"
            class="btn btn-sm btn-outline"
            :disabled="!device.online"
            @click="send(device.id, command)"
          >{{ COMMAND_LABEL[command] }}</button>
        </div>

        <div v-if="sensitiveCommands.length" class="mt-3 rounded-xl border border-warning/30 bg-warning/10 p-3">
          <p class="text-[12px] font-medium">Actions sensibles</p>
          <p class="mt-0.5 text-[11px] text-base-content/60">
            Ces commandes restent manuelles quel que soit le niveau d'autonomie de l'assistant.
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button
              v-for="command in sensitiveCommands"
              :key="command"
              class="btn btn-xs btn-outline"
              @click="send(device.id, command)"
            >{{ COMMAND_LABEL[command] ?? command }}</button>
          </div>
        </div>
      </section>

      <!-- Camera -->
      <section v-if="hasCamera" class="mb-5 rounded-2xl border border-base-300 bg-base-100 p-4">
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">Caméra</h2>
        <AiAgentScreen
          :src="cameraSrc"
          :title="device.name"
          :live="cameraLive"
          :recording="teaching"
          :started-at="teachStartedAt"
          :variant="cameraLoaded ? 'default' : 'Loading'"
          @record="onCameraRecord"
          @stop="onCameraStop"
        />
        <p v-if="cameraError" class="mt-2 text-[12px] text-error">{{ cameraError }}</p>
        <p v-if="teachError" class="mt-2 text-[12px] text-error">{{ teachError }}</p>
        <p v-if="teachResult" class="mt-2 text-[12px] text-base-content/70">
          {{ teachResult.text }}
          <NuxtLink to="/routines" class="font-medium text-primary underline-offset-2 hover:underline">Voir la routine proposée</NuxtLink>
        </p>
      </section>

      <!-- Réglage fin -->
      <section v-if="fineTuneFields.length" class="mb-5 rounded-2xl border border-base-300 bg-base-100 p-4">
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">Réglage fin</h2>
        <AiFineTuneCard :fields="fineTuneFields" v-model="fineTuneValues" :labels="{ title: device.name }" @change="onFineTuneChange" />
      </section>

      <!-- History -->
      <section v-if="historyable.length > 0" class="mb-5 rounded-2xl border border-base-300 bg-base-100 p-4">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-base-content/40">24 dernières heures</h2>
          <div class="flex-1" />
          <div class="flex gap-1 rounded-full border border-base-300 p-0.5">
            <button
              v-for="attribute in historyable"
              :key="attribute"
              class="rounded-full px-2 py-0.5 text-[11px] transition-colors"
              :class="attribute === historyAttribute ? 'bg-primary/25 font-medium' : 'hover:bg-base-200'"
              @click="historyAttribute = attribute"
            >{{ attribute }}</button>
          </div>
        </div>

        <AgentChart v-if="history.length > 1" :data="{ attribute: historyAttribute, points: history }" />
        <p v-else class="py-6 text-center text-[12px] text-base-content/45">
          Pas encore assez de mesures. L'historique se remplit pendant que le hub tourne.
        </p>
      </section>

      <!-- State -->
      <section class="mb-5 rounded-2xl border border-base-300 bg-base-100 p-4">
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">État complet</h2>
        <dl class="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          <div v-for="[key, value] in Object.entries(device.state)" :key="key" class="flex items-baseline justify-between gap-3 text-[13px]">
            <dt class="truncate text-base-content/55">{{ key }}</dt>
            <dd class="shrink-0 tabular font-medium">{{ typeof value === 'object' ? JSON.stringify(value) : String(value) }}</dd>
          </div>
        </dl>
      </section>

      <!-- Identity -->
      <section class="rounded-2xl border border-base-300 bg-base-100 p-4">
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">Identité</h2>
        <dl class="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-base-content/55">Intégration</dt>
            <dd class="font-medium">{{ detail?.adapter?.name ?? device.adapterId }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-base-content/55">Transport</dt>
            <dd class="font-medium">{{ device.transport }}</dd>
          </div>
          <div v-if="device.manufacturer" class="flex items-baseline justify-between gap-3">
            <dt class="text-base-content/55">Fabricant</dt>
            <dd class="font-medium">{{ device.manufacturer }}</dd>
          </div>
          <div v-if="device.model" class="flex items-baseline justify-between gap-3">
            <dt class="text-base-content/55">Modèle</dt>
            <dd class="font-medium">{{ device.model }}</dd>
          </div>
          <div v-if="device.firmwareVersion" class="flex items-baseline justify-between gap-3">
            <dt class="text-base-content/55">Firmware</dt>
            <dd class="font-medium tabular">{{ device.firmwareVersion }}</dd>
          </div>
          <div v-if="device.network.ip" class="flex items-baseline justify-between gap-3">
            <dt class="text-base-content/55">Adresse</dt>
            <dd class="font-medium tabular">{{ device.network.ip }}</dd>
          </div>
          <div v-if="device.network.mac" class="flex items-baseline justify-between gap-3">
            <dt class="text-base-content/55">MAC</dt>
            <dd class="font-mono text-[12px]">{{ device.network.mac }}</dd>
          </div>
          <div v-if="device.network.macVendor" class="flex items-baseline justify-between gap-3">
            <dt class="text-base-content/55">Constructeur MAC</dt>
            <dd class="font-medium">{{ device.network.macVendor }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-base-content/55">Certitude</dt>
            <dd class="font-medium">{{ confidenceLabel[device.identificationConfidence] ?? device.identificationConfidence }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-base-content/55">Identifiant</dt>
            <dd class="font-mono text-[11px] text-base-content/50">{{ device.uid }}</dd>
          </div>
        </dl>

        <div v-if="device.network.mdnsServices.length" class="mt-3 border-t border-base-200 pt-3">
          <p class="text-[11px] text-base-content/45">Services annoncés</p>
          <div class="mt-1 flex flex-wrap gap-1">
            <span
              v-for="service in device.network.mdnsServices"
              :key="service"
              class="rounded-full bg-base-200 px-2 py-0.5 font-mono text-[10px] text-base-content/60"
            >{{ service }}</span>
          </div>
        </div>

        <p v-if="device.notes" class="mt-3 border-t border-base-200 pt-3 text-[13px] text-base-content/70">{{ device.notes }}</p>

        <div class="mt-4 flex justify-end border-t border-base-200 pt-3">
          <button v-if="!confirmDelete" class="btn btn-xs btn-ghost text-error" @click="confirmDelete = true">
            Retirer cet appareil
          </button>
          <div v-else class="flex items-center gap-2">
            <span class="text-[12px]">Retirer {{ device.name }} du hub ?</span>
            <button class="btn btn-xs btn-ghost" @click="confirmDelete = false">Annuler</button>
            <button class="btn btn-xs btn-error" @click="removeDevice">Retirer</button>
          </div>
        </div>
      </section>
    </template>

    <!-- Edit drawer -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-150 ease-out"
        leave-active-class="transition duration-100 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div v-if="editing" class="fixed inset-0 z-[95] bg-base-content/20" @click.self="editing = false">
          <div class="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col bg-base-100 shadow-2xl">
            <div class="flex h-12 items-center gap-2 border-b border-base-200 px-4">
              <span class="text-[13px] font-semibold">Modifier l'appareil</span>
              <div class="flex-1" />
              <button class="btn btn-ghost btn-xs btn-square" @click="editing = false">
                <Icon name="ph:x" class="size-4" />
              </button>
            </div>

            <div class="flex-1 space-y-4 overflow-y-auto p-4 thin-scroll">
              <label class="block">
                <span class="text-[13px] text-base-content/70">Nom</span>
                <input v-model="draft.name" class="input input-sm mt-1 w-full border-base-300 bg-base-200">
              </label>

              <label class="block">
                <span class="text-[13px] text-base-content/70">Pièce</span>
                <select v-model="draft.areaId" class="select select-sm mt-1 w-full border-base-300 bg-base-200">
                  <option value="">Sans pièce</option>
                  <option v-for="area in areas" :key="area.id" :value="area.id">{{ area.name }}</option>
                </select>
              </label>

              <label class="block">
                <span class="text-[13px] text-base-content/70">Notes</span>
                <textarea
                  v-model="draft.notes"
                  rows="3"
                  placeholder="Ce que l'assistant doit savoir: celle au-dessus de l'évier, la prise derrière le canapé..."
                  class="textarea textarea-sm mt-1 w-full border-base-300 bg-base-200"
                />
              </label>

              <label class="flex items-center gap-3">
                <input v-model="draft.favourite" type="checkbox" class="toggle toggle-sm">
                <span class="text-[13px]">Favori</span>
              </label>

              <label class="flex items-start gap-3">
                <input v-model="draft.critical" type="checkbox" class="toggle toggle-sm">
                <span>
                  <span class="text-[13px]">Appareil critique</span>
                  <span class="block text-[11px] text-base-content/55">
                    L'assistant demandera toujours confirmation avant d'y toucher, quel que soit son niveau d'autonomie.
                  </span>
                </span>
              </label>
            </div>

            <div class="flex gap-2 border-t border-base-200 p-3">
              <button class="btn btn-sm btn-ghost flex-1" @click="editing = false">Annuler</button>
              <button class="btn btn-sm admin-cta flex-1" @click="saveEdit">Enregistrer</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
