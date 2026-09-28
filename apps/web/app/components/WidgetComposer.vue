<script setup lang="ts">
/**
 * Adding a card.
 *
 * Two ways in, and the first one is the point: say what you want and the assistant builds
 * it. The form underneath exists because a person who already knows they want "average
 * humidity, bathroom, gauge" should not have to write a sentence to get it - and because
 * the form is the thing that makes the assistant's output inspectable: whatever it creates,
 * you can open it here and see the same fields.
 *
 * Everything previews against the real house before it is saved. A card that would resolve
 * to nothing says so here rather than landing dead on the dashboard.
 */

const emit = defineEmits<{ close: []; created: [] }>()

const { vocabulary, add, preview, load } = useWidgets()

const mode = ref<'ask' | 'build'>('ask')
const prompt = ref('')
const asking = ref(false)
const askError = ref<string | null>(null)

const draft = reactive({
  type: 'metric',
  title: '',
  size: 'sm' as WidgetSize,
  icon: 'ph:gauge',
  sourceKind: 'capability',
  capability: '',
  areaId: '',
  category: '',
  deviceId: '',
  attribute: '',
  aggregate: 'avg',
  hours: 24,
  days: 7,
  unit: '',
  min: 0,
  max: 100,
  text: '',
})

const previewData = ref<WidgetData | null>(null)
const previewing = ref(false)
const saving = ref(false)

const TYPES: { id: string; label: string; icon: string; needs: string }[] = [
  { id: 'metric', label: 'Un chiffre', icon: 'ph:number-circle-one', needs: 'capability' },
  { id: 'gauge', label: 'Une jauge', icon: 'ph:gauge', needs: 'capability' },
  { id: 'chart', label: 'Une courbe', icon: 'ph:chart-line', needs: 'history' },
  { id: 'list', label: 'Une liste', icon: 'ph:list-bullets', needs: 'filter' },
  { id: 'devices', label: 'Des appareils', icon: 'ph:squares-four', needs: 'filter' },
  { id: 'toggle-row', label: 'Des interrupteurs', icon: 'ph:toggle-right', needs: 'filter' },
  { id: 'room', label: 'Une pièce', icon: 'ph:house-line', needs: 'area' },
  { id: 'energy', label: 'Énergie', icon: 'ph:lightning', needs: 'house' },
  { id: 'climate', label: 'Climat', icon: 'ph:thermometer-simple', needs: 'house' },
  { id: 'alerts', label: 'Alertes', icon: 'ph:warning', needs: 'house' },
  { id: 'timeline', label: 'Activité', icon: 'ph:pulse', needs: 'house' },
  { id: 'note', label: 'Une note', icon: 'ph:note', needs: 'static' },
]

const needs = computed(() => TYPES.find((entry) => entry.id === draft.type)?.needs ?? 'house')

/** The declaration as the hub will store it. Shown raw at the bottom, because it is readable. */
const source = computed<Record<string, unknown>>(() => {
  switch (needs.value) {
    case 'capability':
      return {
        kind: 'capability',
        capability: draft.capability,
        areaId: draft.areaId || null,
        category: draft.category || null,
        deviceIds: [],
        aggregate: draft.aggregate,
      }
    case 'history':
      return {
        kind: 'history',
        capability: draft.capability || null,
        attribute: draft.attribute || draft.capability,
        areaId: draft.areaId || null,
        deviceId: draft.deviceId || null,
        hours: draft.hours,
        aggregate: draft.aggregate === 'count' ? 'avg' : draft.aggregate,
      }
    case 'filter':
      return {
        kind: 'filter',
        category: draft.category || null,
        areaId: draft.areaId || null,
        capability: draft.capability || null,
        state: {},
        online: null,
        limit: 12,
      }
    case 'area':
      return { kind: 'area', areaId: draft.areaId }
    case 'static':
      return { kind: 'static' }
    default:
      return { kind: 'house' }
  }
})

const options = computed(() => {
  const out: Record<string, unknown> = {}
  if (draft.unit) out.unit = draft.unit
  if (draft.type === 'gauge') {
    out.min = draft.min
    out.max = draft.max
  }
  if (draft.type === 'note') out.text = draft.text
  if (needs.value === 'energy') out.days = draft.days
  return out
})

/**
 * What the chosen type still needs before a preview means anything. Asking the hub to
 * resolve a half-filled source only produces a validation error, and a validation error is
 * not a useful thing to show someone who has not finished choosing yet.
 */
const missing = computed<string | null>(() => {
  if ((needs.value === 'capability' || needs.value === 'history') && !draft.capability) return 'Choisissez une mesure.'
  if (needs.value === 'area' && !draft.areaId) return 'Choisissez une pièce.'
  if (draft.type === 'note' && !draft.text.trim()) return 'Écrivez le texte de la note.'
  return null
})

let previewTimer: ReturnType<typeof setTimeout> | null = null
watch(
  [() => draft.type, source, options, missing],
  () => {
    if (previewTimer) clearTimeout(previewTimer)
    if (missing.value) {
      previewData.value = { kind: 'empty', message: missing.value }
      return
    }
    previewTimer = setTimeout(async () => {
      previewing.value = true
      try {
        previewData.value = await preview({ type: draft.type, source: source.value, options: options.value })
      } finally {
        previewing.value = false
      }
    }, 250)
  },
  { deep: true, immediate: true }
)

async function save() {
  if (!draft.title.trim()) return
  saving.value = true
  try {
    await add({
      type: draft.type,
      title: draft.title.trim(),
      size: draft.size,
      icon: draft.icon,
      source: source.value as never,
      options: options.value as never,
    })
    emit('created')
    emit('close')
  } finally {
    saving.value = false
  }
}

/**
 * The assistant route. It owns create_widget, so this is one message; whether a card was
 * actually created is read from the dashboard afterwards rather than from the reply text,
 * because a model saying "voilà" is not evidence that a row exists.
 */
async function askAgent() {
  if (!prompt.value.trim()) return
  asking.value = true
  askError.value = null
  const before = useWidgets().widgets.value.length
  try {
    const reply = await hubFetch<{ reply: string; ok: boolean }>('/agent/ask', {
      method: 'POST',
      body: { message: `Ajoute ceci à mon tableau de bord: ${prompt.value.trim()}` },
    })
    await load()
    if (useWidgets().widgets.value.length > before) {
      emit('created')
      emit('close')
    } else {
      askError.value = reply.reply || "L'assistant n'a pas créé de carte."
    }
  } catch (error) {
    askError.value = (error as Error).message
  } finally {
    asking.value = false
  }
}

const EXAMPLES = [
  "l'humidité de la salle de bain",
  'la température du salon sur 24 h',
  'tout ce qui est allumé en ce moment',
  'ce que consomme le frigo cette semaine',
]

const previewWidget = computed<Widget>(() => ({
  id: 'preview',
  dashboardId: 'home',
  type: draft.type,
  title: draft.title || 'Aperçu',
  subtitle: null,
  icon: draft.icon,
  size: draft.size,
  position: 0,
  source: source.value,
  options: options.value,
  authoredBy: 'user',
  reason: null,
  visible: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  data: previewData.value ?? { kind: 'empty', message: 'Calcul...' },
}))
</script>

<template>
  <div class="fixed inset-0 z-50 grid place-items-center bg-base-300/60 p-4 backdrop-blur-sm" @click.self="emit('close')">
    <div class="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-xl">
      <header class="flex items-center gap-2 border-b border-base-200 px-4 py-3">
        <Icon name="ph:plus-square" class="size-4 text-base-content/50" />
        <h2 class="flex-1 text-[13px] font-semibold">Ajouter une carte</h2>
        <div class="join">
          <button class="btn btn-xs join-item" :class="mode === 'ask' ? 'admin-cta' : 'btn-outline'" @click="mode = 'ask'">Demander</button>
          <button class="btn btn-xs join-item" :class="mode === 'build' ? 'admin-cta' : 'btn-outline'" @click="mode = 'build'">Construire</button>
        </div>
        <button class="btn btn-ghost btn-xs btn-square" aria-label="Fermer" @click="emit('close')">
          <Icon name="ph:x" class="size-4" />
        </button>
      </header>

      <!-- Ask -->
      <div v-if="mode === 'ask'" class="p-4">
        <p class="mb-3 text-[12.5px] text-base-content/60">
          Dites ce que vous voulez voir. L'assistant lit les capteurs disponibles et construit la carte.
        </p>
        <div class="flex gap-2">
          <input
            v-model="prompt"
            placeholder="Par exemple: l humidité de la salle de bain"
            class="input input-sm flex-1 border-base-300 bg-base-200"
            @keydown.enter="askAgent"
          >
          <button class="btn btn-sm admin-cta" :disabled="asking || !prompt.trim()" @click="askAgent">
            {{ asking ? 'Création...' : 'Créer' }}
          </button>
        </div>

        <div class="mt-2 flex flex-wrap gap-1.5">
          <button
            v-for="example in EXAMPLES"
            :key="example"
            class="rounded-full bg-base-200 px-2.5 py-1 text-[12px] transition-colors hover:bg-base-300"
            @click="prompt = example"
          >{{ example }}</button>
        </div>

        <p v-if="askError" class="mt-3 rounded-xl bg-base-200 px-3 py-2 text-[12px] text-base-content/70">{{ askError }}</p>
      </div>

      <!-- Build -->
      <div v-else class="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 md:grid-cols-[1fr_16rem] thin-scroll">
        <div class="space-y-3">
          <div>
            <p class="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-base-content/40">Type</p>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="entry in TYPES"
                :key="entry.id"
                class="flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[12px] transition-colors"
                :class="draft.type === entry.id ? 'border-transparent bg-primary/25' : 'border-base-300 hover:bg-base-200'"
                @click="draft.type = entry.id; draft.icon = entry.icon"
              >
                <Icon :name="entry.icon" class="size-3.5" />
                {{ entry.label }}
              </button>
            </div>
          </div>

          <label class="flex items-center gap-3">
            <span class="w-20 shrink-0 text-[12px] text-base-content/60">Titre</span>
            <input v-model="draft.title" class="input input-sm flex-1 border-base-300 bg-base-200" placeholder="Nom de la carte">
          </label>

          <label v-if="needs === 'capability' || needs === 'history' || needs === 'filter'" class="flex items-center gap-3">
            <span class="w-20 shrink-0 text-[12px] text-base-content/60">Mesure</span>
            <select v-model="draft.capability" class="select select-sm flex-1 border-base-300 bg-base-200">
              <option value="">{{ needs === 'filter' ? 'peu importe' : 'choisir' }}</option>
              <option v-for="capability in vocabulary.capabilities" :key="capability" :value="capability">{{ capability }}</option>
            </select>
          </label>

          <label v-if="needs !== 'static' && needs !== 'house'" class="flex items-center gap-3">
            <span class="w-20 shrink-0 text-[12px] text-base-content/60">Pièce</span>
            <select v-model="draft.areaId" class="select select-sm flex-1 border-base-300 bg-base-200">
              <option value="">toute la maison</option>
              <option v-for="area in vocabulary.areas" :key="area.id" :value="area.id">{{ area.name }}</option>
            </select>
          </label>

          <label v-if="needs === 'filter'" class="flex items-center gap-3">
            <span class="w-20 shrink-0 text-[12px] text-base-content/60">Catégorie</span>
            <select v-model="draft.category" class="select select-sm flex-1 border-base-300 bg-base-200">
              <option value="">toutes</option>
              <option v-for="category in vocabulary.categories" :key="category" :value="category">{{ category }}</option>
            </select>
          </label>

          <label v-if="needs === 'capability'" class="flex items-center gap-3">
            <span class="w-20 shrink-0 text-[12px] text-base-content/60">Calcul</span>
            <select v-model="draft.aggregate" class="select select-sm flex-1 border-base-300 bg-base-200">
              <option value="avg">moyenne</option>
              <option value="sum">somme</option>
              <option value="min">minimum</option>
              <option value="max">maximum</option>
              <option value="count">nombre</option>
            </select>
          </label>

          <label v-if="needs === 'history'" class="flex items-center gap-3">
            <span class="w-20 shrink-0 text-[12px] text-base-content/60">Sur</span>
            <input v-model.number="draft.hours" type="number" min="1" max="720" class="input input-sm w-24 border-base-300 bg-base-200">
            <span class="text-[12px] text-base-content/45">heures</span>
          </label>

          <label v-if="draft.type === 'note'" class="flex items-start gap-3">
            <span class="w-20 shrink-0 pt-2 text-[12px] text-base-content/60">Texte</span>
            <textarea v-model="draft.text" rows="3" class="textarea textarea-sm flex-1 border-base-300 bg-base-200" />
          </label>

          <div v-if="draft.type === 'gauge'" class="flex items-center gap-3">
            <span class="w-20 shrink-0 text-[12px] text-base-content/60">Échelle</span>
            <input v-model.number="draft.min" type="number" class="input input-sm w-20 border-base-300 bg-base-200">
            <span class="text-[12px] text-base-content/45">à</span>
            <input v-model.number="draft.max" type="number" class="input input-sm w-20 border-base-300 bg-base-200">
          </div>

          <div class="flex items-center gap-3">
            <span class="w-20 shrink-0 text-[12px] text-base-content/60">Largeur</span>
            <div class="join">
              <button
                v-for="size in (['sm', 'md', 'lg', 'xl', 'full'] as WidgetSize[])"
                :key="size"
                class="btn btn-xs join-item"
                :class="draft.size === size ? 'admin-cta' : 'btn-outline'"
                @click="draft.size = size"
              >{{ size }}</button>
            </div>
          </div>

          <details class="pt-1">
            <summary class="cursor-pointer text-[11px] text-base-content/45">Voir la déclaration</summary>
            <pre class="mt-1.5 overflow-auto rounded-xl bg-base-200 p-2.5 font-mono text-[11px] thin-scroll">{{ JSON.stringify({ type: draft.type, source, options }, null, 2) }}</pre>
          </details>
        </div>

        <!-- Live preview -->
        <div>
          <p class="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-base-content/40">
            Aperçu {{ previewing ? '...' : '' }}
          </p>
          <WidgetCard :widget="previewWidget" />
          <p v-if="previewData?.kind === 'empty' && !missing" class="mt-2 text-[11px] text-warning">
            Cette carte ne montrerait rien pour l'instant.
          </p>
        </div>
      </div>

      <footer v-if="mode === 'build'" class="flex items-center justify-end gap-2 border-t border-base-200 px-4 py-3">
        <button class="btn btn-sm btn-ghost" @click="emit('close')">Annuler</button>
        <button class="btn btn-sm admin-cta" :disabled="saving || !draft.title.trim() || Boolean(missing)" @click="save">Ajouter</button>
      </footer>
    </div>
  </div>
</template>
