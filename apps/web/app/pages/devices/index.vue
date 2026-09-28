<script setup lang="ts">
/**
 * Every device.
 *
 * Search left, filters immediately beside it, count far right: the query and the control
 * that narrows it belong together, and a `justify-between` that flings the filters to the
 * far edge puts them a screen apart.
 *
 * Two views share the same search/filters: Grille (DeviceCard, grouped by room) and Tableau
 * (AiRecordsTable, one row per filtered device) - the toggle remembers its choice in
 * localStorage. The table's own columns are the house's facts (room, category, state, online,
 * battery, last seen) plus one column per AI property from the hub (`/devices/properties`);
 * its "+" menu and property popover create, edit and run those columns against the hub, and
 * "Lancer le calcul" streams each device's value over SSE as it resolves.
 */

import { CATEGORY_LABEL, type DeviceCategory } from '@sway-home/shared/device'

// ---------------------------------------------------------------------------------------
// Hub shapes for the properties feature (mirrored by hand: the web app does not import the hub).
// ---------------------------------------------------------------------------------------

type HubPropertyKind = 'text' | 'select' | 'number' | 'boolean'
type HubPropertyValue = string | number | boolean | null

interface HubDeviceProperty {
  id: string
  label: string
  prompt: string
  kind: HubPropertyKind
  options?: string[]
  needsModel: boolean
  preset: boolean
  /** The column's own model (`provider:model`); absent, it follows the settings. */
  model?: string
}

interface HubModelChoice {
  id: string
  provider: string
  model: string
  label: string
  hint: string
  group: string
  available: boolean
  reason?: string
  current: boolean
}

const { devices, areas, loading, refresh } = useHouse()
const { sendMany } = useCommands()
const { toggleDock } = useShell()
const route = useRoute()
const router = useRouter()

const search = ref(String(route.query.q ?? ''))
const areaFilter = ref(String(route.query.area ?? ''))
const categoryFilter = ref(String(route.query.category ?? ''))
const onlyOn = ref(route.query.on === '1')
const onlyOffline = ref(route.query.offline === '1')

// -- view toggle: Grille | Tableau, remembered across visits ------------------------------
const VIEW_STORAGE_KEY = 'sway-devices-view'
function readStoredView(): 'grid' | 'table' {
  if (!import.meta.client) return 'grid'
  return localStorage.getItem(VIEW_STORAGE_KEY) === 'table' ? 'table' : 'grid'
}
const view = ref<'grid' | 'table'>(readStoredView())
watch(view, (value) => {
  if (import.meta.client) localStorage.setItem(VIEW_STORAGE_KEY, value)
})

watchDebounced(
  [search, areaFilter, categoryFilter, onlyOn, onlyOffline],
  () => {
    router.replace({
      query: {
        ...(search.value ? { q: search.value } : {}),
        ...(areaFilter.value ? { area: areaFilter.value } : {}),
        ...(categoryFilter.value ? { category: categoryFilter.value } : {}),
        ...(onlyOn.value ? { on: '1' } : {}),
        ...(onlyOffline.value ? { offline: '1' } : {}),
      },
    })
  },
  { debounce: 250 }
)

function normalise(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

const categories = computed(() => {
  const counts = new Map<string, number>()
  for (const device of devices.value) counts.set(device.category, (counts.get(device.category) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
})

const filtered = computed(() => {
  const text = normalise(search.value.trim())
  return devices.value.filter((device) => {
    if (areaFilter.value && device.areaId !== areaFilter.value) return false
    if (categoryFilter.value && device.category !== categoryFilter.value) return false
    if (onlyOn.value && device.state.on !== true && device.state.playback !== 'playing') return false
    if (onlyOffline.value && device.online) return false
    if (!text) return true
    const area = device.areaId ? areas.value.find((candidate) => candidate.id === device.areaId)?.name ?? '' : ''
    return normalise(`${device.name} ${area} ${device.manufacturer ?? ''} ${device.model ?? ''} ${device.network.ip ?? ''}`).includes(text)
  })
})

const grouped = computed(() => {
  const groups = new Map<string, Device[]>()
  for (const device of filtered.value) {
    const key = device.areaId ?? 'none'
    groups.set(key, [...(groups.get(key) ?? []), device])
  }
  return [...groups.entries()]
    .map(([id, list]) => ({
      id,
      name: id === 'none' ? 'Sans pièce' : areas.value.find((area) => area.id === id)?.name ?? 'Pièce inconnue',
      devices: list,
    }))
    .sort((a, b) => (a.id === 'none' ? 1 : b.id === 'none' ? -1 : a.name.localeCompare(b.name)))
})

const hasFilter = computed(() => Boolean(search.value || areaFilter.value || categoryFilter.value || onlyOn.value || onlyOffline.value))

function clearFilters() {
  search.value = ''
  areaFilter.value = ''
  categoryFilter.value = ''
  onlyOn.value = false
  onlyOffline.value = false
}

// -- bulk actions: the table's checked rows when there are any, else the whole filtered set ----
const selected = ref<string[]>([])
const bulkTargetIds = computed(() => (selected.value.length > 0 ? selected.value : filtered.value.map((device) => device.id)))
const showBulkBar = computed(() => (hasFilter.value || selected.value.length > 0) && bulkTargetIds.value.length > 1)

const busy = ref(false)
async function bulk(command: string) {
  busy.value = true
  try {
    await sendMany({ deviceIds: bulkTargetIds.value }, command, command === 'turnOff' ? { transitionMs: 1200 } : {})
    await refresh()
    selected.value = []
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------------------------------
// Table view: columns are house facts plus one per AI property; rows are the filtered devices.
// ---------------------------------------------------------------------------------------

const STATUS_OPTIONS: RecordsTableStatusOption[] = [
  { value: 'online', label: 'En ligne', color: 'var(--green)', rank: 1 },
  { value: 'offline', label: 'Hors ligne', color: 'var(--ink-3)', rank: 0 },
]

const BASE_COLUMNS: RecordsTableColumn[] = [
  { key: 'name', label: 'Nom', kind: 'text', render: 'text', primary: true, sortable: true, tool: 'Saisie manuelle', toolKind: 'user' },
  { key: 'room', label: 'Pièce', kind: 'text', render: 'text', width: 140, sortable: true, tool: 'Saisie manuelle', toolKind: 'user' },
  { key: 'category', label: 'Type', kind: 'text', render: 'text', width: 120, tool: 'Saisie manuelle', toolKind: 'user' },
  { key: 'state', label: 'État', kind: 'text', render: 'text', width: 190, sortable: true, tool: 'Capteur', toolKind: 'device' },
  { key: 'status', label: 'En ligne', kind: 'single-select', render: 'status', width: 120, sortable: true, tool: 'Capteur', toolKind: 'device', options: STATUS_OPTIONS, footer: { kind: 'match', value: 'offline', suffix: 'hors ligne' } },
  {
    key: 'battery',
    label: 'Batterie',
    kind: 'number',
    render: 'percent',
    width: 120,
    sortable: true,
    tool: 'Capteur',
    toolKind: 'device',
    thresholds: [
      { max: 20, tone: 'red' },
      { max: 40, tone: 'orange' },
    ],
    footer: { kind: 'average' },
  },
  { key: 'lastSeen', label: 'Vu', kind: 'date', render: 'date', width: 150, sortable: true, tool: 'Capteur', toolKind: 'device' },
]

const properties = ref<HubDeviceProperty[]>([])
const propertyValues = ref<Record<string, Record<string, RecordsTableCellValue>>>({})
const allModels = ref<HubModelChoice[]>([])
const tableError = ref<string | null>(null)
const columns = ref<RecordsTableColumn[]>([...BASE_COLUMNS])
const pinnedColumns = ref<string[]>([])
const calculating = ref<RecordsTableCalculating | null>(null)

// The Tool menu names models by label. The offline engine cannot fill a column, so it is not
// offered; a label two runners share gets its runner's name, so each label is one model id.
const columnModels = computed(() => {
  const models = allModels.value.filter((model) => model.id !== 'offline')
  return models.map((model) => ({
    ...model,
    menuLabel: models.filter((other) => other.label === model.label).length > 1 ? `${model.label} · ${model.hint}` : model.label,
  }))
})
const modelOptions = computed<RecordsTableModelOption[]>(() => columnModels.value.map((model) => ({ label: model.menuLabel, available: model.available, reason: model.reason })))
/** What a column without a model of its own runs on: the model in the settings. */
const settingsModelLabel = computed(() => columnModels.value.find((model) => model.current)?.menuLabel ?? 'Sway IA')

function modelLabel(id: string | undefined): string {
  if (!id) return settingsModelLabel.value
  return columnModels.value.find((model) => model.id === id)?.menuLabel ?? id.slice(id.indexOf(':') + 1)
}

/** The model id a Tool label stands for; null when it is the settings' model, or unknown. */
function modelIdFor(label: string | undefined): string | null {
  if (!label || label === settingsModelLabel.value) return null
  return columnModels.value.find((model) => model.menuLabel === label)?.id ?? null
}

function hubErrorMessage(error: unknown): string {
  const data = (error as { data?: { error?: string } } | undefined)?.data
  return data?.error ?? (error instanceof Error ? error.message : 'Erreur inattendue')
}

function toCellValue(kind: HubPropertyKind, raw: HubPropertyValue): RecordsTableCellValue {
  if (raw === null || raw === undefined) return null
  if (kind === 'boolean' || typeof raw === 'boolean') return raw ? 'Oui' : 'Non'
  return raw
}

function columnForProperty(property: HubDeviceProperty): RecordsTableColumn {
  const kind: RecordsTablePropertyKind = property.kind === 'number' ? 'number' : property.kind === 'select' || property.kind === 'boolean' ? 'single-select' : 'text'
  const options =
    property.kind === 'boolean' ? recordsOptionsFromLabels(['Oui', 'Non']) : property.kind === 'select' ? recordsOptionsFromLabels(property.options ?? []) : undefined
  return {
    key: `prop_${property.id}`,
    label: property.label,
    kind,
    render: kind === 'single-select' ? 'status' : 'text',
    width: 200,
    removable: !property.preset,
    tool: property.preset ? 'Règle automatique' : modelLabel(property.model),
    toolKind: property.preset ? 'device' : 'model',
    prompt: { before: property.prompt },
    options,
    footer: { kind: 'filled', suffix: 'renseignés' },
  }
}

const tableRows = computed<RecordsTableRow[]>(() =>
  filtered.value.map((device) => {
    const values: Record<string, RecordsTableCellValue> = {
      name: device.name,
      room: device.areaId ? areas.value.find((area) => area.id === device.areaId)?.name ?? '-' : '-',
      category: CATEGORY_LABEL[device.category as DeviceCategory] ?? device.category,
      state: stateSummary(device),
      status: device.online ? 'online' : 'offline',
      battery: typeof device.state.battery === 'number' ? device.state.battery : null,
      lastSeen: { display: formatRelative(device.lastSeenAt), sortValue: device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0, muted: !device.online },
    }
    for (const property of properties.value) values[`prop_${property.id}`] = propertyValues.value[property.id]?.[device.id] ?? null
    return { id: device.id, values, icon: CATEGORY_ICON[device.category] ?? 'ph:question' }
  })
)

async function loadProperties() {
  try {
    const data = await hubFetch<{ properties: HubDeviceProperty[]; values: Record<string, Record<string, { value: HubPropertyValue; computedAt: string }>> }>(
      '/devices/properties'
    )
    properties.value = data.properties
    const nextValues: Record<string, Record<string, RecordsTableCellValue>> = {}
    for (const property of data.properties) {
      nextValues[property.id] = {}
      for (const [deviceId, entry] of Object.entries(data.values[property.id] ?? {})) nextValues[property.id]![deviceId] = toCellValue(property.kind, entry.value)
    }
    propertyValues.value = nextValues
    columns.value = [...BASE_COLUMNS, ...properties.value.map(columnForProperty)]
  } catch (error) {
    tableError.value = hubErrorMessage(error)
  }
}

async function loadModels() {
  try {
    allModels.value = (await hubFetch<{ models: HubModelChoice[] }>('/agent/models')).models
  } catch {
    // The picker just falls back to a generic label; not fatal for the table itself.
  }
}

/** A hub column's Tool names its model; the list of models may arrive after the columns. */
function relabelTools() {
  columns.value = columns.value.map((column) => {
    const property = properties.value.find((candidate) => `prop_${candidate.id}` === column.key)
    return property && !property.preset ? { ...column, tool: modelLabel(property.model) } : column
  })
}

onMounted(async () => {
  await Promise.all([loadProperties(), loadModels()])
  relabelTools()
})

// -- "+" add a property: only Texte and Choix unique have a hub equivalent (text / select) -----
let draftSeq = 0
function handleAddColumn(kind: RecordsTablePropertyKind) {
  if (kind !== 'text' && kind !== 'single-select') {
    tableError.value = "Ce type de colonne n'a pas d'équivalent côté hub : choisissez Texte ou Choix unique."
    return
  }
  draftSeq += 1
  columns.value = [
    ...columns.value,
    {
      key: `draft_${draftSeq}_${Date.now()}`,
      label: 'Nouvelle propriété',
      kind,
      render: kind === 'single-select' ? 'status' : 'text',
      width: 220,
      removable: true,
      tool: settingsModelLabel.value,
      toolKind: 'model',
      options: kind === 'single-select' ? [] : undefined,
      footer: { kind: 'filled', suffix: 'renseignés' },
    },
  ]
}

/** A hub column's shape as the table shows it, in the hub's words. */
function hubShape(column: RecordsTableColumn) {
  const kind: HubPropertyKind | null = column.kind === 'single-select' ? 'select' : column.kind === 'number' ? 'number' : column.kind === 'text' ? 'text' : null
  return {
    label: column.label.trim(),
    prompt: (column.prompt?.before ?? '').trim(),
    kind,
    options: (column.options ?? []).map((option) => option.value),
    model: modelIdFor(column.tool),
  }
}

function replaceProperty(property: HubDeviceProperty) {
  properties.value = properties.value.map((candidate) => (candidate.id === property.id ? property : candidate))
}

// A new name or another model is saved at once: the kept values still answer the column. A
// new question - instruction, kind, choices - waits for "Lancer le calcul" (handleRunColumn),
// because the hub drops the values then, and a kind may need its choices before it is valid.
async function handleUpdateColumn(key: string, patch: RecordsTableColumnPatch) {
  const property = properties.value.find((candidate) => `prop_${candidate.id}` === key)
  const current = columns.value.find((candidate) => candidate.key === key)
  // The popover sends the prompt on every blur, changed or not: only a real change is refused.
  if (property?.preset && current && JSON.stringify(hubShape(current)) !== JSON.stringify(hubShape({ ...current, ...patch }))) {
    tableError.value = 'Une colonne prédéfinie ne se modifie pas : elle suit une règle du hub.'
    return
  }
  columns.value = columns.value.map((column) => (column.key === key ? { ...column, ...patch } : column))
  if (!property || !('label' in patch || 'tool' in patch)) return

  const column = columns.value.find((candidate) => candidate.key === key)
  if (!column) return
  const shape = hubShape(column)
  const body: { label?: string; model?: string | null } = {}
  if ('label' in patch && shape.label && shape.label !== property.label) body.label = shape.label
  if ('tool' in patch && shape.model !== (property.model ?? null)) body.model = shape.model
  if (Object.keys(body).length === 0) return
  try {
    replaceProperty((await hubFetch<{ property: HubDeviceProperty }>(`/devices/properties/${property.id}`, { method: 'PATCH', body })).property)
  } catch (error) {
    tableError.value = hubErrorMessage(error)
    columns.value = columns.value.map((candidate) => (candidate.key === key ? { ...candidate, label: property.label, tool: modelLabel(property.model) } : candidate))
  }
}

async function handleRemoveColumn(key: string) {
  columns.value = columns.value.filter((column) => column.key !== key)
  if (calculating.value?.columnKey === key) calculating.value = null
  if (!key.startsWith('prop_')) return // a draft never reached the hub
  const hubId = key.slice(5)
  try {
    await hubFetch(`/devices/properties/${hubId}`, { method: 'DELETE' })
    properties.value = properties.value.filter((property) => property.id !== hubId)
  } catch (error) {
    tableError.value = hubErrorMessage(error)
  }
}

let runController: AbortController | null = null

/** Streams one column's values over SSE: `data: {"kind":"value",...}` frames per device, then
 *  `done` or `error` - same fetch-plus-reader parsing as AgentChat's `/agent/ask/stream`. */
async function runProperty(hubId: string, columnKey: string) {
  runController?.abort()
  const controller = new AbortController()
  runController = controller
  calculating.value = { columnKey, pendingIds: filtered.value.map((device) => device.id) }

  try {
    const response = await fetch(`/api/devices/properties/${hubId}/run`, { method: 'POST', signal: controller.signal })
    if (!response.ok || !response.body) throw new Error(`Le hub a répondu ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        const line = frame.split('\n').find((candidate) => candidate.startsWith('data:'))
        if (!line) continue
        const payload = JSON.parse(line.slice(5).trim()) as { kind: string; deviceId?: string; value?: HubPropertyValue; message?: string }

        if (payload.kind === 'value' && payload.deviceId) {
          const property = properties.value.find((candidate) => candidate.id === hubId)
          propertyValues.value = {
            ...propertyValues.value,
            [hubId]: { ...(propertyValues.value[hubId] ?? {}), [payload.deviceId]: toCellValue(property?.kind ?? 'text', payload.value ?? null) },
          }
          if (calculating.value) calculating.value = { columnKey, pendingIds: calculating.value.pendingIds.filter((id) => id !== payload.deviceId) }
        } else if (payload.kind === 'error') {
          tableError.value = payload.message ?? 'Erreur pendant le calcul.'
        }
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'AbortError') tableError.value = hubErrorMessage(error)
  } finally {
    if (runController === controller) {
      calculating.value = null
      runController = null
    }
  }
}

async function handleRunColumn(key: string) {
  if (calculating.value) return // one calculation at a time
  const column = columns.value.find((candidate) => candidate.key === key)
  if (!column) return
  if (!key.startsWith('prop_') && !key.startsWith('draft_')) return // a house fact: nothing to compute

  calculating.value = { columnKey: key, pendingIds: [] } // busy immediately, even while syncing to the hub below
  const fail = (message: string) => {
    tableError.value = message
    calculating.value = null
  }

  const hubId = key.startsWith('prop_') ? key.slice(5) : null
  const property = hubId ? properties.value.find((candidate) => candidate.id === hubId) : null

  const shape = hubShape(column)
  const sameQuestion = (hub: HubDeviceProperty) =>
    hub.prompt === shape.prompt && hub.kind === shape.kind && (shape.kind !== 'select' || JSON.stringify(hub.options ?? []) === JSON.stringify(shape.options))

  const dirty = !property || property.label !== shape.label || !sameQuestion(property) || (property.model ?? null) !== shape.model

  let currentKey = key
  let runId = hubId

  if (dirty) {
    if (property?.preset) return fail('Une colonne prédéfinie ne se modifie pas : elle suit une règle du hub.')
    if (shape.kind !== 'text' && shape.kind !== 'select') return fail("Ce type de colonne n'a pas d'équivalent côté hub : choisissez Texte ou Choix unique.")
    if (!shape.label || !shape.prompt) return fail('Le nom et la consigne sont obligatoires avant de lancer le calcul.')
    if (shape.kind === 'select' && (shape.options.length < 2 || shape.options.length > 8)) return fail('Une colonne à choix a besoin de deux à huit options.')

    const body = { label: shape.label, prompt: shape.prompt, kind: shape.kind, ...(shape.kind === 'select' ? { options: shape.options } : {}) }
    try {
      if (property) {
        // Edited in place: same id, and the hub drops the kept values only if the question changed.
        const saved = (await hubFetch<{ property: HubDeviceProperty }>(`/devices/properties/${property.id}`, { method: 'PATCH', body: { ...body, model: shape.model } })).property
        if (!sameQuestion(property)) propertyValues.value = { ...propertyValues.value, [property.id]: {} }
        replaceProperty(saved)
      } else {
        const created = (await hubFetch<{ property: HubDeviceProperty }>('/devices/properties', { method: 'POST', body: { ...body, ...(shape.model ? { model: shape.model } : {}) } })).property
        properties.value = [...properties.value, created]
        currentKey = `prop_${created.id}`
        columns.value = columns.value.map((candidate) => (candidate.key === key ? { ...candidate, key: currentKey, removable: true } : candidate))
        runId = created.id
      }
    } catch (error) {
      return fail(hubErrorMessage(error))
    }
  }

  if (!runId) {
    calculating.value = null
    return
  }
  await runProperty(runId, currentKey)
}

function handleOpenRow(row: RecordsTableRow) {
  router.push(`/devices/${row.id}`)
}

onBeforeUnmount(() => runController?.abort())
</script>

<template>
  <div class="mx-auto max-w-7xl">
    <PageHeader
      title="Appareils"
      :subtitle="`${filtered.length} sur ${devices.length}`"
      :loading="loading && devices.length === 0"
      :breadcrumb="[{ label: 'Maison', to: '/' }, { label: 'Appareils' }]"
    >
      <template #actions>
        <button class="btn btn-sm btn-outline gap-2" @click="toggleDock('scan')">
          <Icon name="ph:broadcast" class="size-4" />
          <span class="hidden sm:inline">Scanner</span>
        </button>
        <NuxtLink to="/network" class="btn btn-sm admin-cta gap-2">
          <Icon name="ph:wifi-high" class="size-4" />
          <span class="hidden sm:inline">Réseau</span>
        </NuxtLink>
      </template>
    </PageHeader>

    <!-- Toolbar: search left, filters beside it, count far right -->
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <label class="flex h-9 min-w-56 flex-1 items-center gap-2 rounded-full border border-base-300 bg-base-100 px-3 sm:max-w-80">
        <Icon name="ph:magnifying-glass" class="size-4 shrink-0 text-base-content/40" />
        <input
          v-model="search"
          type="search"
          placeholder="Nom, pièce, modèle, adresse IP"
          class="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-base-content/35"
        >
        <button v-if="search" class="shrink-0 text-base-content/40 hover:text-base-content" @click="search = ''">
          <Icon name="ph:x" class="size-3.5" />
        </button>
      </label>

      <select v-model="areaFilter" class="select select-sm h-9 rounded-full border-base-300 bg-base-100 text-[13px]">
        <option value="">Toutes les pièces</option>
        <option v-for="area in areas" :key="area.id" :value="area.id">{{ area.name }}</option>
      </select>

      <select v-model="categoryFilter" class="select select-sm h-9 rounded-full border-base-300 bg-base-100 text-[13px]">
        <option value="">Tous les types</option>
        <option v-for="[category, count] in categories" :key="category" :value="category">{{ CATEGORY_LABEL[category as DeviceCategory] ?? category }} ({{ count }})</option>
      </select>

      <button
        class="h-9 rounded-full border px-3 text-[13px] transition-colors"
        :class="onlyOn ? 'border-transparent bg-primary/25 font-medium' : 'border-base-300 hover:bg-base-200'"
        @click="onlyOn = !onlyOn"
      >En marche</button>

      <button
        class="h-9 rounded-full border px-3 text-[13px] transition-colors"
        :class="onlyOffline ? 'border-transparent bg-primary/25 font-medium' : 'border-base-300 hover:bg-base-200'"
        @click="onlyOffline = !onlyOffline"
      >Hors ligne</button>

      <button v-if="hasFilter" class="btn btn-ghost btn-sm text-[13px]" @click="clearFilters">Réinitialiser</button>

      <div class="flex-1" />

      <div class="flex items-center gap-1 rounded-full border border-base-300 p-0.5">
        <button
          class="grid size-7 place-items-center rounded-full transition-colors"
          :class="view === 'grid' ? 'bg-primary/25' : 'hover:bg-base-200'"
          aria-label="Vue grille"
          @click="view = 'grid'"
        >
          <Icon name="ph:squares-four" class="size-4" />
        </button>
        <button
          class="grid size-7 place-items-center rounded-full transition-colors"
          :class="view === 'table' ? 'bg-primary/25' : 'hover:bg-base-200'"
          aria-label="Vue tableau"
          @click="view = 'table'"
        >
          <Icon name="ph:table" class="size-4" />
        </button>
      </div>

      <span class="text-[13px] tabular text-base-content/50">{{ filtered.length }}</span>
    </div>

    <div v-if="showBulkBar" class="mb-4 flex flex-wrap items-center gap-2">
      <span class="text-[12px] text-base-content/50">{{ bulkTargetIds.length }} appareil{{ bulkTargetIds.length > 1 ? 's' : '' }}</span>
      <button class="btn btn-xs btn-outline" :disabled="busy" @click="bulk('turnOn')">Allumer la sélection</button>
      <button class="btn btn-xs btn-outline" :disabled="busy" @click="bulk('turnOff')">Éteindre la sélection</button>
    </div>

    <SkeletonGrid v-if="loading && devices.length === 0" />

    <EmptyState
      v-else-if="filtered.length === 0 && hasFilter"
      icon="ph:funnel"
      title="Aucun appareil ne correspond"
      description="Essayez un autre terme, ou retirez un filtre."
      action-label="Réinitialiser les filtres"
      @action="clearFilters"
    />

    <EmptyState
      v-else-if="devices.length === 0"
      icon="ph:broadcast"
      title="La maison est vide pour le hub"
      description="Lancez un scan: mDNS, SSDP, ARP et un balayage TCP, puis chaque intégration essaie de reconnaître ce qui répond."
      action-label="Scanner le réseau"
      @action="toggleDock('scan')"
    />

    <template v-else-if="view === 'grid'">
      <section v-for="group in grouped" :key="group.id" class="mb-7">
        <div class="mb-2 flex items-center gap-2">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-base-content/40">{{ group.name }}</h2>
          <span class="text-[11px] tabular text-base-content/30">{{ group.devices.length }}</span>
          <div class="h-px flex-1 bg-base-300" />
        </div>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          <DeviceCard v-for="device in group.devices" :key="device.id" :device="device" />
        </div>
      </section>
    </template>

    <!-- Table view: the house's facts plus one column per AI property, built on AiRecordsTable -->
    <template v-else>
      <div v-if="tableError" class="mb-3 flex items-center justify-between gap-3 rounded-xl border border-error/30 bg-error/10 px-3 py-2 text-[12.5px] text-error">
        <span>{{ tableError }}</span>
        <button class="shrink-0 text-error/70 hover:text-error" aria-label="Fermer" @click="tableError = null">
          <Icon name="ph:x" class="size-3.5" />
        </button>
      </div>
      <AiRecordsTable
        :columns="columns"
        :rows="tableRows"
        v-model:selected="selected"
        v-model:pinned="pinnedColumns"
        :calculating="calculating"
        :models="modelOptions"
        caption="Tableau des appareils. Faites défiler horizontalement et verticalement pour voir toutes les colonnes et tous les enregistrements."
        @add-column="handleAddColumn"
        @update-column="handleUpdateColumn"
        @run-column="handleRunColumn"
        @remove-column="handleRemoveColumn"
        @open="handleOpenRow"
      />
    </template>
  </div>
</template>
