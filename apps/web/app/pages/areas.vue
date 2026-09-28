<script setup lang="ts">
/**
 * Rooms.
 *
 * Each room is a card with its own numbers and its own controls, because "turn off the
 * kitchen" is the command people actually give. Drag a device here later; for now the
 * assignment lives on the device page and in the assistant.
 */

const { devices, areas, house, refresh } = useHouse()
const { sendMany } = useCommands()

const busy = ref<string | null>(null)
const creating = ref(false)
const newName = ref('')

const rooms = computed(() =>
  areas.value
    .map((area) => {
      const list = devices.value.filter((device) => device.areaId === area.id)
      const climate = house.value?.climate.find((entry) => entry.area === area.name)
      return {
        area,
        devices: list,
        lightsOn: list.filter((device) => device.category === 'light' && device.state.on === true).length,
        lights: list.filter((device) => device.category === 'light').length,
        power: Math.round(list.reduce((sum, device) => sum + (typeof device.state.power === 'number' ? device.state.power : 0), 0)),
        temperature: climate?.temperature ?? null,
        humidity: climate?.humidity ?? null,
        motion: list.some((device) => device.state.motion === true),
        open: list.filter((device) => device.state.open === true).map((device) => device.name),
        offline: list.filter((device) => !device.online).length,
      }
    })
    .filter((room) => room.devices.length > 0 || !room.area.icon)
)

const unassigned = computed(() => devices.value.filter((device) => !device.areaId))

async function roomCommand(areaId: string, command: string) {
  busy.value = `${areaId}:${command}`
  try {
    await sendMany({ areaId }, command, command === 'turnOff' ? { transitionMs: 1200 } : {})
    await refresh()
  } finally {
    busy.value = null
  }
}

async function createArea() {
  if (!newName.value.trim()) return
  await hubFetch('/areas', { method: 'POST', body: { name: newName.value.trim() } })
  newName.value = ''
  creating.value = false
  await refresh()
}
</script>

<template>
  <div class="mx-auto max-w-7xl">
    <PageHeader
      title="Pièces"
      :subtitle="`${areas.length} pièces · ${unassigned.length} appareils sans pièce`"
      :breadcrumb="[{ label: 'Maison', to: '/' }, { label: 'Pièces' }]"
    >
      <template #actions>
        <button class="btn btn-sm admin-cta gap-2" @click="creating = true">
          <Icon name="ph:plus" class="size-4" />
          Ajouter une pièce
        </button>
      </template>
    </PageHeader>

    <div v-if="creating" class="mb-4 flex items-center gap-2 rounded-2xl border border-base-300 bg-base-100 p-3">
      <input
        v-model="newName"
        placeholder="Nom de la pièce"
        class="input input-sm flex-1 border-base-300 bg-base-200"
        @keydown.enter="createArea"
      >
      <button class="btn btn-sm admin-cta" @click="createArea">Créer</button>
      <button class="btn btn-sm btn-ghost" @click="creating = false">Annuler</button>
    </div>

    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <article
        v-for="room in rooms"
        :id="room.area.id"
        :key="room.area.id"
        class="rounded-2xl border border-base-300 bg-base-100 p-4 transition-colors hover:border-base-content/20"
      >
        <div class="flex items-start gap-3">
          <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-base-200">
            <Icon :name="room.area.icon ?? AREA_ICON[room.area.kind] ?? 'ph:square'" class="size-[18px]" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-[13px] font-semibold">{{ room.area.name }}</p>
            <p class="truncate text-[11px] text-base-content/50">
              {{ room.devices.length }} appareil{{ room.devices.length > 1 ? 's' : '' }}
              <span v-if="room.offline > 0" class="text-warning"> · {{ room.offline }} hors ligne</span>
            </p>
          </div>
          <span v-if="room.motion" class="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[10px] text-success">
            mouvement
          </span>
        </div>

        <div class="mt-3 grid grid-cols-3 gap-2 text-center">
          <div class="rounded-xl bg-base-200 p-2">
            <p class="text-[10px] uppercase tracking-wider text-base-content/40">Lumières</p>
            <p class="mt-0.5 text-[15px] font-semibold tabular">{{ room.lightsOn }}<span class="text-[11px] text-base-content/40">/{{ room.lights }}</span></p>
          </div>
          <div class="rounded-xl bg-base-200 p-2">
            <p class="text-[10px] uppercase tracking-wider text-base-content/40">Temp.</p>
            <p class="mt-0.5 text-[15px] font-semibold tabular">
              {{ room.temperature !== null ? room.temperature.toFixed(1) : '-' }}<span class="text-[11px] text-base-content/40">°C</span>
            </p>
          </div>
          <div class="rounded-xl bg-base-200 p-2">
            <p class="text-[10px] uppercase tracking-wider text-base-content/40">Puissance</p>
            <p class="mt-0.5 text-[15px] font-semibold tabular">{{ room.power }}<span class="text-[11px] text-base-content/40">W</span></p>
          </div>
        </div>

        <p v-if="room.open.length > 0" class="mt-2 flex items-center gap-1.5 text-[11px] text-warning">
          <Icon name="ph:door-open" class="size-3.5" />
          {{ room.open.join(', ') }}
        </p>

        <div class="mt-3 flex gap-2 border-t border-base-200 pt-3">
          <button
            class="btn btn-xs btn-outline flex-1"
            :disabled="busy === `${room.area.id}:turnOn`"
            @click="roomCommand(room.area.id, 'turnOn')"
          >Tout allumer</button>
          <button
            class="btn btn-xs btn-outline flex-1"
            :disabled="busy === `${room.area.id}:turnOff`"
            @click="roomCommand(room.area.id, 'turnOff')"
          >Tout éteindre</button>
          <NuxtLink :to="`/devices?area=${room.area.id}`" class="btn btn-xs btn-ghost">
            <Icon name="ph:arrow-right" class="size-3.5" />
          </NuxtLink>
        </div>
      </article>
    </div>

    <!-- Devices with no room: a task, not a fact -->
    <section v-if="unassigned.length > 0" class="mt-8">
      <h2 class="mb-1 text-xs font-semibold uppercase tracking-wider text-base-content/40">Sans pièce</h2>
      <p class="mb-3 text-[12px] text-base-content/50">
        Rangez-les et tout le reste suit: les commandes par pièce, les routines de présence, et ce que l'assistant
        comprend quand vous dites "dans le salon".
      </p>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        <DeviceCard v-for="device in unassigned" :key="device.id" :device="device" />
      </div>
    </section>
  </div>
</template>
