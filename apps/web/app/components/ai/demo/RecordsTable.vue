<script setup lang="ts">
/**
 * Demo gallery for AiRecordsTable: the house's devices as an AI spreadsheet.
 *
 * Reproduces the source's story - pick a property type from the "+" header, then "Lancer le
 * calcul" resolves it row by row - entirely by changing props over time (the component owns no
 * timers itself): a "Conseil" column is appended, then `calculating` shrinks one row at a time
 * every 110 ms, the source's own pace, until every device has its advice. "Rejouer" resets and
 * replays it. The table stays fully interactive throughout: headers, resize, sort, the filter
 * menu and the real "+" menu all work independently of the scripted replay.
 */

const STATE_OPTIONS: RecordsTableStatusOption[] = [
  { value: 'Allumé', label: 'Allumé', color: 'var(--green)' },
  { value: 'Éteint', label: 'Éteint', color: 'var(--ink-3)' },
  { value: 'Repos', label: 'Repos', color: 'var(--ink-3)' },
  { value: 'Verrouillée', label: 'Verrouillée', color: 'var(--green)' },
  { value: 'En ligne', label: 'En ligne', color: 'var(--green)' },
  { value: 'Fermé', label: 'Fermé', color: 'var(--ink-3)' },
]

const SIGNAL_OPTIONS: RecordsTableStatusOption[] = [
  { value: 'excellent', label: 'Excellent', color: 'var(--green)', rank: 3 },
  { value: 'correct', label: 'Correct', color: 'var(--orange)', rank: 2 },
  { value: 'faible', label: 'Faible', color: 'var(--red)', rank: 1 },
  { value: 'hors-ligne', label: 'Hors ligne', color: 'var(--ink-3)', rank: 0 },
]

const TYPE_COLORS: Record<string, string> = {
  Éclairage: 'yellow',
  Chauffage: 'orange',
  Capteur: 'cyan',
  Prise: 'amber',
  Serrure: 'purple',
  Caméra: 'magenta',
  Volet: 'green',
}

const INTEGRATION_COLORS: Record<string, string> = {
  Hue: 'orange',
  Zigbee: 'lime',
  Matter: 'purple',
  HomeKit: 'cyan',
  'Wi-Fi': 'amber',
}

type Device = {
  id: string
  name: string
  room: string
  type: string
  state: string
  battery: number | null
  signal: string
  last: string
  lastMinutes: number
  lastMuted?: boolean
  integration: string
  tags: string[]
  advice: string
}

const DEVICES: Device[] = [
  { id: 'lampe-salon', name: 'Lampe salon', room: 'Salon', type: 'Éclairage', state: 'Allumé', battery: null, signal: 'excellent', last: 'il y a 2 min', lastMinutes: 2, integration: 'Hue', tags: ['Confort'], advice: 'Aucune action nécessaire.' },
  { id: 'plafonnier-cuisine', name: 'Plafonnier cuisine', room: 'Cuisine', type: 'Éclairage', state: 'Éteint', battery: null, signal: 'correct', last: 'il y a 1 h', lastMinutes: 60, integration: 'Zigbee', tags: ["Économie d'énergie"], advice: 'Éteinte depuis 1 h, tout est normal.' },
  { id: 'thermostat-salon', name: 'Thermostat', room: 'Salon', type: 'Chauffage', state: 'Allumé', battery: 76, signal: 'excellent', last: 'il y a 5 min', lastMinutes: 5, integration: 'Matter', tags: ['Chauffage', 'Confort'], advice: 'Fonctionne normalement.' },
  { id: 'capteur-entree', name: 'Capteur de mouvement', room: 'Entrée', type: 'Capteur', state: 'Repos', battery: 42, signal: 'faible', last: 'il y a 12 min', lastMinutes: 12, integration: 'Zigbee', tags: ['Sécurité'], advice: 'Signal faible : rapprocher du répéteur Zigbee.' },
  { id: 'prise-bureau', name: 'Prise bureau', room: 'Bureau', type: 'Prise', state: 'Allumé', battery: null, signal: 'correct', last: 'il y a 3 h', lastMinutes: 180, integration: 'Wi-Fi', tags: ["Économie d'énergie"], advice: 'Aucune action nécessaire.' },
  { id: 'serrure-entree', name: 'Serrure entrée', room: 'Entrée', type: 'Serrure', state: 'Verrouillée', battery: 88, signal: 'excellent', last: 'il y a 20 min', lastMinutes: 20, integration: 'HomeKit', tags: ['Sécurité'], advice: 'Verrouillée, batterie correcte.' },
  { id: 'camera-entree', name: 'Caméra entrée', room: 'Entrée', type: 'Caméra', state: 'En ligne', battery: null, signal: 'correct', last: "à l'instant", lastMinutes: 0, integration: 'HomeKit', tags: ['Sécurité', 'Extérieur'], advice: 'En ligne, aucune action nécessaire.' },
  { id: 'volet-chambre', name: 'Volet chambre', room: 'Chambre', type: 'Volet', state: 'Fermé', battery: 15, signal: 'hors-ligne', last: 'hier', lastMinutes: 1440, lastMuted: true, integration: 'Zigbee', tags: ['Confort'], advice: 'Batterie à 15 % : à changer bientôt.' },
]

function toRow(device: Device): RecordsTableRow {
  return {
    id: device.id,
    values: {
      name: device.name,
      room: device.room,
      type: [device.type],
      state: device.state,
      battery: device.battery,
      signal: device.signal,
      last: { display: device.last, sortValue: device.lastMinutes, muted: device.lastMuted },
      integration: [device.integration],
      tags: device.tags,
    },
  }
}

const BASE_COLUMNS: RecordsTableColumn[] = [
  { key: 'name', label: 'Nom', kind: 'text', render: 'text', primary: true, sortable: true, tool: 'Saisie manuelle', toolKind: 'user' },
  { key: 'room', label: 'Pièce', kind: 'text', render: 'text', width: 130, tool: 'Saisie manuelle', toolKind: 'user', footer: { kind: 'ghost' } },
  { key: 'type', label: 'Type', kind: 'single-select', render: 'tags', width: 150, tool: 'Saisie manuelle', toolKind: 'user', tagColors: TYPE_COLORS },
  { key: 'state', label: 'État', kind: 'single-select', render: 'status', width: 150, tool: 'Capteur', toolKind: 'device', options: STATE_OPTIONS, footer: { kind: 'match', value: 'Éteint', suffix: 'éteints' } },
  {
    key: 'battery',
    label: 'Batterie',
    kind: 'number',
    render: 'percent',
    width: 130,
    sortable: true,
    tool: 'Capteur',
    toolKind: 'device',
    thresholds: [
      { max: 20, tone: 'red' },
      { max: 40, tone: 'orange' },
    ],
    footer: { kind: 'average' },
  },
  { key: 'signal', label: 'Signal', kind: 'single-select', render: 'status', width: 150, sortable: true, tool: 'Capteur', toolKind: 'device', options: SIGNAL_OPTIONS, footer: { kind: 'average' } },
  { key: 'last', label: 'Dernière activité', kind: 'date', render: 'date', width: 170, sortable: true, tool: 'Capteur', toolKind: 'device' },
  { key: 'integration', label: 'Intégration', kind: 'single-select', render: 'tags', width: 150, tool: 'Saisie manuelle', toolKind: 'user', tagColors: INTEGRATION_COLORS, footer: { kind: 'filled', suffix: 'associés' } },
  { key: 'tags', label: 'Étiquettes', kind: 'multi-select', render: 'tags', width: 190, tool: 'Saisie manuelle', toolKind: 'user' },
]

const CONSEIL_COLUMN: RecordsTableColumn = {
  key: 'conseil',
  label: 'Conseil',
  kind: 'text',
  render: 'text',
  width: 260,
  removable: true,
  tool: 'Sway IA',
  toolKind: 'model',
  inputs: ['state', 'battery'],
  prompt: { before: 'Propose un conseil court pour ', chip: 'Nom', after: ' à partir de son état et de sa batterie.' },
  footer: { kind: 'filled', suffix: 'renseignés' },
}

const columns = ref<RecordsTableColumn[]>([...BASE_COLUMNS])
const rows = ref<RecordsTableRow[]>(DEVICES.map(toRow))
const selected = ref<string[]>([])
const pinned = ref<string[]>([])
const calculating = ref<RecordsTableCalculating | null>(null)
const lastOpened = ref<string | null>(null)

let timers: ReturnType<typeof setTimeout>[] = []
function schedule(fn: () => void, delay: number) {
  timers.push(setTimeout(fn, delay))
}
function clearTimers() {
  timers.forEach(clearTimeout)
  timers = []
}

/** Row-by-row resolution, 110 ms a row like the source's own stagger. One calculation at a time. */
function runColumn(columnKey: string, valueFor: (rowId: string) => RecordsTableCellValue) {
  if (calculating.value) return
  calculating.value = { columnKey, pendingIds: rows.value.map((row) => row.id) }
  scheduleResolve(columnKey, valueFor)
}
function scheduleResolve(columnKey: string, valueFor: (rowId: string) => RecordsTableCellValue) {
  schedule(() => {
    const current = calculating.value
    if (!current) return
    const [nextId, ...rest] = current.pendingIds
    rows.value = rows.value.map((row) => (row.id === nextId ? { ...row, values: { ...row.values, [columnKey]: valueFor(nextId) } } : row))
    calculating.value = rest.length ? { columnKey, pendingIds: rest } : null
    if (rest.length) scheduleResolve(columnKey, valueFor)
  }, 110)
}

function play() {
  clearTimers()
  columns.value = [...BASE_COLUMNS]
  rows.value = DEVICES.map(toRow)
  calculating.value = null
  lastOpened.value = null
  schedule(() => {
    columns.value = [...columns.value, { ...CONSEIL_COLUMN }]
    schedule(() => runColumn('conseil', (id) => DEVICES.find((device) => device.id === id)?.advice ?? ''), 500)
  }, 900)
}

// -- the table stays fully interactive: wire its emits for real, not just for the replay --------
function kindToRender(kind: RecordsTablePropertyKind): RecordsTableRenderKind {
  if (kind === 'multi-select') return 'tags'
  if (kind === 'single-select') return 'status'
  if (kind === 'url' || kind === 'reference') return 'link'
  if (kind === 'date') return 'date'
  if (kind === 'number') return 'percent'
  return 'text'
}
function handleAddColumn(kind: RecordsTablePropertyKind) {
  const key = `custom-${columns.value.length}-${Date.now()}`
  columns.value = [
    ...columns.value,
    { key, label: 'Nouvelle propriété', kind, render: kindToRender(kind), width: 200, removable: true, tool: 'Sway IA', toolKind: 'model', footer: { kind: 'filled' } },
  ]
}
function handleUpdateColumn(key: string, patch: RecordsTableColumnPatch) {
  columns.value = columns.value.map((column) => (column.key === key ? { ...column, ...patch } : column))
}
function handleRunColumn(key: string) {
  if (key === 'conseil') runColumn('conseil', (id) => DEVICES.find((device) => device.id === id)?.advice ?? '')
  else runColumn(key, () => 'Résultat simulé')
}
function handleRemoveColumn(key: string) {
  columns.value = columns.value.filter((column) => column.key !== key)
  if (calculating.value?.columnKey === key) calculating.value = null
}
function handleOpen(row: RecordsTableRow) {
  lastOpened.value = recordsDisplayText(row.values.name)
}

onMounted(play)
onBeforeUnmount(clearTimers)
</script>

<template>
  <section>
    <div class="mb-2 flex items-center justify-between">
      <span class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Appareils de la maison</span>
      <AiButton size="xs" variant="secondary" @click="play">Rejouer</AiButton>
    </div>
    <div class="bg-canvas rounded-window p-6">
      <AiRecordsTable
        :columns="columns"
        :rows="rows"
        v-model:selected="selected"
        v-model:pinned="pinned"
        :calculating="calculating"
        caption="Tableau des appareils. Faites défiler horizontalement et verticalement pour voir toutes les colonnes et tous les enregistrements."
        @add-column="handleAddColumn"
        @update-column="handleUpdateColumn"
        @run-column="handleRunColumn"
        @remove-column="handleRemoveColumn"
        @open="handleOpen"
      />
      <p v-if="lastOpened" class="mt-2 text-[12px] text-ink-3">Dernier appareil ouvert : {{ lastOpened }}</p>
    </div>
  </section>
</template>
