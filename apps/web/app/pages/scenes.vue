<script setup lang="ts">
/**
 * Scenes.
 *
 * The important control here is "capture what the room is doing right now", because that is
 * how a scene actually gets made: someone gets the light right by hand and wants to keep it.
 * Building one field by field is the fallback, not the path.
 */

interface Scene {
  id: string
  name: string
  icon: string | null
  areaId: string | null
  entries: { deviceId: string; state: Record<string, unknown>; transitionMs: number }[]
  authoredBy: string
}

const { areas, deviceById, refresh } = useHouse()
const scenes = ref<Scene[]>([])
const loading = ref(true)
const busy = ref<string | null>(null)
const capturing = ref(false)
const captureName = ref('')
const captureArea = ref('')

async function load() {
  loading.value = true
  try {
    scenes.value = (await hubFetch<{ scenes: Scene[] }>('/scenes')).scenes
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function activate(scene: Scene) {
  busy.value = scene.id
  try {
    await hubFetch(`/scenes/${scene.id}/activate`, { method: 'POST' })
    await refresh()
  } finally {
    busy.value = null
  }
}

async function capture() {
  if (!captureName.value.trim()) return
  busy.value = 'capture'
  try {
    await hubFetch('/scenes/snapshot', {
      method: 'POST',
      body: { name: captureName.value.trim(), areaId: captureArea.value || undefined },
    })
    captureName.value = ''
    captureArea.value = ''
    capturing.value = false
    await load()
  } finally {
    busy.value = null
  }
}

async function remove(scene: Scene) {
  busy.value = scene.id
  try {
    await hubFetch(`/scenes/${scene.id}`, { method: 'DELETE' })
    await load()
  } finally {
    busy.value = null
  }
}

function preview(scene: Scene): string {
  const names = scene.entries
    .map((entry) => deviceById.value.get(entry.deviceId)?.name)
    .filter((name): name is string => Boolean(name))
  if (names.length === 0) return 'aucun appareil'
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ` et ${names.length - 3} autres` : '')
}

/** The colours a scene sets, shown as a strip so the card looks like what it does. */
function swatches(scene: Scene): string[] {
  return scene.entries
    .map((entry) => {
      const state = entry.state as Record<string, any>
      if (state.on === false) return null
      if (typeof state.hue === 'number' && typeof state.saturation === 'number' && state.saturation > 5) {
        return `hsl(${state.hue} ${state.saturation}% 55%)`
      }
      if (typeof state.colorTemperature === 'number') {
        const warm = Math.max(0, Math.min(1, (6500 - state.colorTemperature) / 4000))
        return `hsl(${38 + (1 - warm) * 20} ${20 + warm * 60}% 65%)`
      }
      return null
    })
    .filter((colour): colour is string => colour !== null)
    .slice(0, 6)
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <PageHeader
      title="Scènes"
      :subtitle="`${scenes.length} scène${scenes.length > 1 ? 's' : ''}`"
      :loading="loading"
      :breadcrumb="[{ label: 'Maison', to: '/' }, { label: 'Scènes' }]"
    >
      <template #actions>
        <button class="btn btn-sm admin-cta gap-2" @click="capturing = true">
          <Icon name="ph:camera" class="size-4" />
          Capturer l'état actuel
        </button>
      </template>
    </PageHeader>

    <div v-if="capturing" class="mb-4 rounded-2xl border border-base-300 bg-base-100 p-4">
      <p class="text-[13px] font-medium">Capturer une scène</p>
      <p class="mt-0.5 text-[12px] text-base-content/55">
        Enregistre ce que font les appareils en ce moment: allumage, luminosité, couleur, position, consigne.
      </p>
      <div class="mt-3 flex flex-wrap gap-2">
        <input
          v-model="captureName"
          placeholder="Nom de la scène, par exemple Soirée film"
          class="input input-sm min-w-48 flex-1 border-base-300 bg-base-200"
          @keydown.enter="capture"
        >
        <select v-model="captureArea" class="select select-sm border-base-300 bg-base-200">
          <option value="">Toute la maison</option>
          <option v-for="area in areas" :key="area.id" :value="area.id">{{ area.name }}</option>
        </select>
        <button class="btn btn-sm admin-cta" :disabled="busy === 'capture'" @click="capture">Capturer</button>
        <button class="btn btn-sm btn-ghost" @click="capturing = false">Annuler</button>
      </div>
    </div>

    <EmptyState
      v-if="!loading && scenes.length === 0"
      icon="ph:sparkle"
      title="Aucune scène"
      description="Réglez une pièce comme vous l'aimez, puis capturez l'état. C'est plus rapide que de construire la scène champ par champ."
      action-label="Capturer l'état actuel"
      @action="capturing = true"
    />

    <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <article
        v-for="scene in scenes"
        :key="scene.id"
        class="group overflow-hidden rounded-2xl border border-base-300 bg-base-100 transition-colors hover:border-base-content/20"
      >
        <div v-if="swatches(scene).length" class="flex h-1.5">
          <span v-for="(colour, index) in swatches(scene)" :key="index" class="flex-1" :style="{ backgroundColor: colour }" />
        </div>
        <div v-else class="h-1.5 bg-base-300" />

        <div class="p-4">
          <div class="flex items-start gap-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-base-200">
              <Icon :name="scene.icon ?? 'ph:sparkle'" class="size-[18px]" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] font-semibold">{{ scene.name }}</p>
              <p class="truncate text-[11px] text-base-content/50">{{ preview(scene) }}</p>
            </div>
          </div>

          <p v-if="scene.areaId" class="mt-2 text-[11px] text-base-content/45">
            {{ areas.find((area) => area.id === scene.areaId)?.name }}
          </p>

          <div class="mt-3 flex items-center gap-2 border-t border-base-200 pt-3">
            <button class="btn btn-sm admin-cta flex-1" :disabled="busy === scene.id" @click="activate(scene)">
              Activer
            </button>
            <button
              class="row-action grid size-8 place-items-center rounded-full hover:bg-error/15 hover:text-error"
              aria-label="Supprimer"
              :disabled="busy === scene.id"
              @click="remove(scene)"
            >
              <Icon name="ph:trash" class="size-4" />
            </button>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>
