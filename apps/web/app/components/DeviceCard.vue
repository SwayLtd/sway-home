<script setup lang="ts">
/**
 * One device, as a card.
 *
 * The rules this card follows, all of them from the admin design language:
 *  - The page is `base-200`, so a card is `base-100` with a `base-300` hairline and no
 *    shadow at rest.
 *  - Nothing moves under the pointer. Hover changes colour and border, never position.
 *  - The primary control is on the card, not behind a click. A light card that needs a
 *    navigation before it can be switched off is a worse remote control than the wall.
 *  - A light that is on shows the colour it is actually making. That single touch is what
 *    makes a grid of cards read as a house rather than as a list of rows.
 */

const props = defineProps<{ device: Device; dense?: boolean }>()

const { send, isPending } = useCommands()
const { areaById } = useHouse()

const device = computed(() => props.device)
const area = computed(() => (device.value.areaId ? areaById.value.get(device.value.areaId)?.name ?? null : null))
const state = computed(() => device.value.state)

const capabilities = computed(() => new Set(device.value.capabilities))
const isOn = computed(() => state.value.on === true)
const hasToggle = computed(() => capabilities.value.has('onoff'))
const hasBrightness = computed(() => capabilities.value.has('brightness'))
const hasPosition = computed(() => capabilities.value.has('position'))
const hasThermostat = computed(() => capabilities.value.has('thermostat'))
const hasLock = computed(() => capabilities.value.has('lock'))
const hasMedia = computed(() => capabilities.value.has('mediaPlayback'))

const glow = computed(() => (device.value.category === 'light' && isOn.value ? lightColour(state.value) : null))

const brightness = ref(Number(state.value.brightness ?? 0))
watch(() => state.value.brightness, (value) => {
  if (typeof value === 'number' && !draggingBrightness.value) brightness.value = value
})
const draggingBrightness = ref(false)

const target = ref(Number(state.value.targetTemperature ?? 20))
watch(() => state.value.targetTemperature, (value) => {
  if (typeof value === 'number') target.value = value
})

async function toggle() {
  await send(device.value.id, 'toggle', { transitionMs: 400 })
}

async function commitBrightness() {
  draggingBrightness.value = false
  await send(device.value.id, 'setBrightness', { brightness: brightness.value, transitionMs: 400 })
}

async function nudgeTarget(delta: number) {
  target.value = Math.round((target.value + delta) * 2) / 2
  await send(device.value.id, 'setTargetTemperature', { celsius: target.value })
}

const secondary = computed(() => stateSummary(device.value))
</script>

<template>
  <NuxtLink
    :to="`/devices/${device.id}`"
    class="group relative block overflow-hidden rounded-2xl border border-base-300 bg-base-100 transition-colors hover:border-base-content/20"
    :class="[props.dense ? 'p-2.5' : 'p-3', device.online ? '' : 'opacity-60']"
  >
    <!-- The colour a light is actually making -->
    <div
      v-if="glow"
      class="pointer-events-none absolute -right-6 -top-6 size-24 rounded-full opacity-30 blur-2xl transition-opacity"
      :style="{ backgroundColor: glow }"
      aria-hidden="true"
    />

    <div class="relative flex items-start gap-2.5">
      <span
        class="grid shrink-0 place-items-center rounded-xl transition-colors"
        :class="[props.dense ? 'size-8' : 'size-9', isOn ? 'bg-primary/25' : 'bg-base-200']"
      >
        <Icon :name="CATEGORY_ICON[device.category] ?? 'ph:question'" :class="props.dense ? 'size-4' : 'size-[18px]'" />
      </span>

      <div class="min-w-0 flex-1">
        <p class="truncate text-[13px] font-semibold leading-snug">{{ device.name }}</p>
        <p class="mt-0.5 truncate text-[11px] text-base-content/50">
          <span v-if="area">{{ area }} · </span>{{ secondary }}
        </p>
      </div>

      <!-- Primary control, on the card -->
      <button
        v-if="hasToggle"
        class="relative h-6 w-10 shrink-0 rounded-full transition-colors"
        :class="isOn ? 'bg-primary' : 'bg-base-300'"
        :aria-pressed="isOn"
        :aria-label="isOn ? `Éteindre ${device.name}` : `Allumer ${device.name}`"
        :disabled="!device.online"
        @click.prevent.stop="toggle"
      >
        <span
          class="absolute top-0.5 size-5 rounded-full bg-base-100 shadow-sm transition-[left] duration-200"
          :class="isOn ? 'left-[1.125rem]' : 'left-0.5'"
        />
      </button>

      <button
        v-else-if="hasLock"
        class="grid size-9 shrink-0 place-items-center rounded-xl transition-colors"
        :class="state.locked ? 'bg-base-200' : 'bg-error/15 text-error'"
        :aria-label="state.locked ? `Déverrouiller ${device.name}` : `Verrouiller ${device.name}`"
        @click.prevent.stop="send(device.id, state.locked ? 'unlock' : 'lock')"
      >
        <Icon :name="state.locked ? 'ph:lock-key-fill' : 'ph:lock-key-open'" class="size-[18px]" />
      </button>

      <div v-else-if="hasMedia" class="flex shrink-0 gap-0.5">
        <button
          class="grid size-8 place-items-center rounded-lg transition-colors hover:bg-base-200"
          :aria-label="state.playback === 'playing' ? 'Pause' : 'Lecture'"
          @click.prevent.stop="send(device.id, state.playback === 'playing' ? 'pause' : 'play')"
        >
          <Icon :name="state.playback === 'playing' ? 'ph:pause-fill' : 'ph:play-fill'" class="size-4" />
        </button>
      </div>

      <span v-else-if="!device.online" class="shrink-0 text-base-content/30">
        <Icon name="ph:plugs" class="size-4" />
      </span>
    </div>

    <!-- Secondary controls, only where they earn their space -->
    <div v-if="!props.dense && hasBrightness && isOn" class="relative mt-3 flex items-center gap-2" @click.prevent.stop>
      <Icon name="ph:sun-dim" class="size-3.5 shrink-0 text-base-content/40" />
      <input
        v-model.number="brightness"
        type="range"
        min="1"
        max="100"
        class="range range-xs flex-1"
        :aria-label="`Luminosité de ${device.name}`"
        @pointerdown="draggingBrightness = true"
        @change="commitBrightness"
      >
      <span class="w-8 shrink-0 text-right text-[11px] tabular text-base-content/50">{{ brightness }}%</span>
    </div>

    <div v-if="!props.dense && hasPosition" class="relative mt-3 flex items-center gap-1" @click.prevent.stop>
      <button class="btn btn-xs btn-ghost flex-1" @click="send(device.id, 'open')">
        <Icon name="ph:arrow-up" class="size-3.5" />
      </button>
      <button class="btn btn-xs btn-ghost flex-1" @click="send(device.id, 'stop')">
        <Icon name="ph:stop" class="size-3.5" />
      </button>
      <button class="btn btn-xs btn-ghost flex-1" @click="send(device.id, 'close')">
        <Icon name="ph:arrow-down" class="size-3.5" />
      </button>
      <span class="w-9 shrink-0 text-right text-[11px] tabular text-base-content/50">{{ state.position ?? 0 }}%</span>
    </div>

    <div v-if="!props.dense && hasThermostat" class="relative mt-3 flex items-center gap-2" @click.prevent.stop>
      <button class="btn btn-xs btn-circle btn-ghost" aria-label="Baisser" @click="nudgeTarget(-0.5)">
        <Icon name="ph:minus" class="size-3.5" />
      </button>
      <div class="flex-1 text-center">
        <span class="text-lg font-semibold tabular leading-none">{{ target.toFixed(1) }}</span>
        <span class="ml-0.5 text-[11px] text-base-content/50">°C</span>
        <p v-if="typeof state.currentTemperature === 'number'" class="text-[10px] tabular text-base-content/40">
          actuel {{ state.currentTemperature.toFixed(1) }} °C
        </p>
      </div>
      <button class="btn btn-xs btn-circle btn-ghost" aria-label="Monter" @click="nudgeTarget(0.5)">
        <Icon name="ph:plus" class="size-3.5" />
      </button>
    </div>

    <!-- A simulated device is never mistaken for a real one -->
    <span
      v-if="device.transport === 'virtual'"
      class="absolute bottom-2 right-2 rounded-full bg-base-200 px-1.5 text-[9px] uppercase tracking-wide text-base-content/40"
    >sim</span>
  </NuxtLink>
</template>
