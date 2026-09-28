<script setup lang="ts">
/**
 * What the assistant remembers.
 *
 * Everything it knows about the house is one row here, in plain language, and every row
 * has a delete button. A memory the reader cannot see is a memory they cannot correct,
 * and an assistant that quietly accumulates beliefs about someone's home is the exact
 * thing this product is supposed to not be.
 */

interface Memory {
  id: string
  kind: string
  content: string
  subjectType: string
  subjectId: string | null
  confidence: number
  strength: number
  source: string
  evidenceCount: number
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

const { deviceById, areas } = useHouse()

const memories = ref<Memory[]>([])
const loading = ref(true)
const busy = ref<string | null>(null)
const draft = ref('')
const draftKind = ref('preference')
const kindFilter = ref<string | null>(null)
const query = ref('')

async function load() {
  loading.value = true
  try {
    memories.value = (await hubFetch<{ memories: Memory[] }>('/agent/memories')).memories
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function remember() {
  if (!draft.value.trim()) return
  busy.value = 'new'
  try {
    await hubFetch('/agent/memories', { method: 'POST', body: { kind: draftKind.value, content: draft.value.trim() } })
    draft.value = ''
    await load()
  } finally {
    busy.value = null
  }
}

async function forget(memory: Memory) {
  busy.value = memory.id
  try {
    await hubFetch(`/agent/memories/${memory.id}`, { method: 'DELETE' })
    memories.value = memories.value.filter((entry) => entry.id !== memory.id)
  } finally {
    busy.value = null
  }
}

const KIND_LABEL: Record<string, string> = {
  preference: 'Préférence',
  fact: 'Fait',
  habit: 'Habitude',
  person: 'Personne',
  place: 'Lieu',
  correction: 'Correction',
  schedule: 'Horaire',
}

const KIND_ICON: Record<string, string> = {
  preference: 'ph:heart',
  fact: 'ph:info',
  habit: 'ph:repeat',
  person: 'ph:user',
  place: 'ph:map-pin',
  correction: 'ph:pencil-simple-line',
  schedule: 'ph:clock',
}

const SOURCE_LABEL: Record<string, string> = {
  stated: 'vous l avez dit',
  observed: 'observé',
  inferred: 'déduit',
  imported: 'importé',
}

const visible = computed(() =>
  memories.value.filter((memory) => {
    if (kindFilter.value && memory.kind !== kindFilter.value) return false
    if (query.value && !memory.content.toLowerCase().includes(query.value.toLowerCase())) return false
    return true
  })
)

const kinds = computed(() => {
  const counts = new Map<string, number>()
  for (const memory of memories.value) counts.set(memory.kind, (counts.get(memory.kind) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
})

function subjectName(memory: Memory): string | null {
  if (!memory.subjectId) return null
  if (memory.subjectType === 'device') return deviceById.value.get(memory.subjectId)?.name ?? null
  if (memory.subjectType === 'area') return areas.value.find((area) => area.id === memory.subjectId)?.name ?? null
  return null
}

/** Strength drives the bar; it is also what decides which memories reach the prompt. */
function strengthTone(strength: number): string {
  if (strength >= 0.75) return 'bg-success'
  if (strength >= 0.4) return 'bg-[var(--state-cold)]'
  return 'bg-base-content/25'
}
</script>

<template>
  <div class="mx-auto max-w-4xl">
    <PageHeader
      title="Mémoire"
      :subtitle="`${memories.length} souvenir${memories.length > 1 ? 's' : ''}`"
      :loading="loading"
      :breadcrumb="[{ label: 'Intelligence' }, { label: 'Mémoire' }]"
    />

    <p class="mb-4 max-w-2xl text-[12.5px] leading-relaxed text-base-content/55">
      Tout ce que l'assistant retient de votre maison est écrit ici, en clair, et se supprime d'un clic.
      Rien ne part ailleurs: la base est le fichier SQLite sur cette machine.
      Les souvenirs les plus forts sont ceux qui entrent dans le prompt.
    </p>

    <!-- Add -->
    <div class="mb-5 flex flex-wrap gap-2 rounded-2xl border border-base-300 bg-base-100 p-3">
      <select v-model="draftKind" class="select select-sm border-base-300 bg-base-200">
        <option v-for="(label, kind) in KIND_LABEL" :key="kind" :value="kind">{{ label }}</option>
      </select>
      <input
        v-model="draft"
        placeholder="Par exemple: je dors toujours fenêtre entrouverte"
        class="input input-sm min-w-56 flex-1 border-base-300 bg-base-200"
        @keydown.enter="remember"
      >
      <button class="btn btn-sm admin-cta" :disabled="busy === 'new' || !draft.trim()" @click="remember">
        Retenir
      </button>
    </div>

    <!-- Filters -->
    <div class="mb-3 flex flex-wrap items-center gap-1.5">
      <button
        class="rounded-full px-2.5 py-1 text-[12px] transition-colors"
        :class="kindFilter === null ? 'bg-primary/25' : 'bg-base-200 hover:bg-base-300'"
        @click="kindFilter = null"
      >Tout</button>
      <button
        v-for="[kind, count] in kinds"
        :key="kind"
        class="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] transition-colors"
        :class="kindFilter === kind ? 'bg-primary/25' : 'bg-base-200 hover:bg-base-300'"
        @click="kindFilter = kindFilter === kind ? null : kind"
      >
        <Icon :name="KIND_ICON[kind] ?? 'ph:brain'" class="size-3.5" />
        {{ KIND_LABEL[kind] ?? kind }}
        <span class="tabular text-base-content/45">{{ count }}</span>
      </button>

      <div class="flex-1" />

      <label class="flex items-center gap-1.5 rounded-full bg-base-200 px-2.5 py-1">
        <Icon name="ph:magnifying-glass" class="size-3.5 text-base-content/40" />
        <input v-model="query" placeholder="Filtrer" class="w-28 bg-transparent text-[12px] outline-none">
      </label>
    </div>

    <div v-if="loading" class="space-y-2">
      <div v-for="index in 6" :key="index" class="h-12 rounded-xl skeleton-line" />
    </div>

    <EmptyState
      v-else-if="visible.length === 0"
      icon="ph:brain"
      title="Aucun souvenir"
      description="Dites à l'assistant comment vous vivez chez vous - une température, une heure de coucher, une pièce que vous n'utilisez pas - et il s'en servira."
    />

    <div v-else class="overflow-hidden rounded-2xl border border-base-300 bg-base-100">
      <article
        v-for="memory in visible"
        :key="memory.id"
        class="group flex items-start gap-3 border-b border-base-200 px-3 py-2.5 last:border-0"
      >
        <span class="grid size-8 shrink-0 place-items-center rounded-xl bg-base-200">
          <Icon :name="KIND_ICON[memory.kind] ?? 'ph:brain'" class="size-4" />
        </span>

        <div class="min-w-0 flex-1">
          <p class="text-[13px] leading-snug">{{ memory.content }}</p>
          <p class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-base-content/45">
            <span>{{ KIND_LABEL[memory.kind] ?? memory.kind }}</span>
            <span>·</span>
            <span>{{ SOURCE_LABEL[memory.source] ?? memory.source }}</span>
            <template v-if="subjectName(memory)">
              <span>·</span>
              <span>{{ subjectName(memory) }}</span>
            </template>
            <template v-if="memory.evidenceCount > 1">
              <span>·</span>
              <span>{{ memory.evidenceCount }} confirmations</span>
            </template>
            <span>·</span>
            <span>{{ formatRelative(memory.updatedAt) }}</span>
            <template v-if="memory.expiresAt">
              <span>·</span>
              <span class="text-warning">expire {{ formatRelative(memory.expiresAt) }}</span>
            </template>
          </p>
        </div>

        <div class="flex shrink-0 items-center gap-2 pt-1">
          <span class="hidden h-1.5 w-16 overflow-hidden rounded-full bg-base-200 sm:block" :title="`force ${Math.round(memory.strength * 100)}%`">
            <span class="block h-full rounded-full" :class="strengthTone(memory.strength)" :style="{ width: `${memory.strength * 100}%` }" />
          </span>
          <button
            class="row-action grid size-8 place-items-center rounded-full hover:bg-error/15 hover:text-error"
            aria-label="Oublier"
            :disabled="busy === memory.id"
            @click="forget(memory)"
          >
            <Icon name="ph:trash" class="size-4" />
          </button>
        </div>
      </article>
    </div>
  </div>
</template>
