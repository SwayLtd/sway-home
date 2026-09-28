<script setup lang="ts">
/**
 * Every device.
 *
 * Search left, filters immediately beside it, count far right: the query and the control
 * that narrows it belong together, and a `justify-between` that flings the filters to the
 * far edge puts them a screen apart.
 */

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
const view = ref<'grid' | 'list'>('grid')

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

const busy = ref(false)
async function bulk(command: string) {
  busy.value = true
  try {
    await sendMany(
      {
        deviceIds: filtered.value.map((device) => device.id),
      },
      command,
      command === 'turnOff' ? { transitionMs: 1200 } : {}
    )
    await refresh()
  } finally {
    busy.value = false
  }
}
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
        <option v-for="[category, count] in categories" :key="category" :value="category">{{ category }} ({{ count }})</option>
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
          :class="view === 'list' ? 'bg-primary/25' : 'hover:bg-base-200'"
          aria-label="Vue liste"
          @click="view = 'list'"
        >
          <Icon name="ph:list" class="size-4" />
        </button>
      </div>

      <span class="text-[13px] tabular text-base-content/50">{{ filtered.length }}</span>
    </div>

    <div v-if="hasFilter && filtered.length > 1" class="mb-4 flex flex-wrap gap-2">
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

    <!-- List view: a table on a desktop, a stack of rows on a phone -->
    <div v-else class="overflow-hidden rounded-2xl border border-base-300 bg-base-100">
      <table class="hidden w-full text-[13px] sm:table">
        <thead class="border-b border-base-200 text-left text-[11px] uppercase tracking-wider text-base-content/40">
          <tr>
            <th class="px-3 py-2 font-semibold">Appareil</th>
            <th class="px-3 py-2 font-semibold">Pièce</th>
            <th class="px-3 py-2 font-semibold">Type</th>
            <th class="px-3 py-2 font-semibold">État</th>
            <th class="px-3 py-2 font-semibold">Via</th>
            <th class="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="device in filtered" :key="device.id" class="group border-b border-base-200 last:border-0 hover:bg-base-200/60">
            <td class="px-3 py-2">
              <NuxtLink :to="`/devices/${device.id}`" class="flex items-center gap-2 font-medium">
                <Icon :name="CATEGORY_ICON[device.category] ?? 'ph:question'" class="size-4 text-base-content/50" />
                {{ device.name }}
              </NuxtLink>
            </td>
            <td class="px-3 py-2 text-base-content/60">
              {{ device.areaId ? areas.find((area) => area.id === device.areaId)?.name ?? '-' : '-' }}
            </td>
            <td class="px-3 py-2 text-base-content/60">{{ device.category }}</td>
            <td class="px-3 py-2 tabular">{{ stateSummary(device) }}</td>
            <td class="px-3 py-2 text-base-content/50">{{ device.adapterId }}</td>
            <td class="px-3 py-2 text-right">
              <NuxtLink :to="`/devices/${device.id}`" class="row-action inline-grid size-8 place-items-center rounded-full hover:bg-base-300">
                <Icon name="ph:arrow-right" class="size-4" />
              </NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="divide-y divide-base-200 sm:hidden">
        <NuxtLink
          v-for="device in filtered"
          :key="device.id"
          :to="`/devices/${device.id}`"
          class="flex items-center gap-3 p-3"
        >
          <Icon :name="CATEGORY_ICON[device.category] ?? 'ph:question'" class="size-5 shrink-0 text-base-content/50" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-[13px] font-medium">{{ device.name }}</p>
            <p class="truncate text-[11px] text-base-content/50">{{ stateSummary(device) }}</p>
          </div>
          <Icon name="ph:caret-right" class="size-4 shrink-0 text-base-content/30" />
        </NuxtLink>
      </div>
    </div>
  </div>
</template>
