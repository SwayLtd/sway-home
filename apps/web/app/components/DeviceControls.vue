<script setup lang="ts">
/**
 * The full control surface for one device, built from its capabilities.
 *
 * The page never asks "is this a Hue bulb"; it asks "does this have `color`". That is what
 * makes a new integration free at the UI layer: an adapter that declares `brightness` gets
 * the slider, and nothing here changes.
 */

const props = defineProps<{ device: Device }>()
const { send } = useCommands()

const capabilities = computed(() => new Set(props.device.capabilities))
const state = computed(() => props.device.state)
const has = (capability: string) => capabilities.value.has(capability)

const brightness = ref(Number(state.value.brightness ?? 0))
const kelvin = ref(Number(state.value.colorTemperature ?? 2700))
const hue = ref(Number(state.value.hue ?? 0))
const saturation = ref(Number(state.value.saturation ?? 0))
const position = ref(Number(state.value.position ?? 0))
const volume = ref(Number(state.value.volume ?? 0))
const target = ref(Number(state.value.targetTemperature ?? 20))
const fanSpeed = ref(Number(state.value.fanSpeed ?? 0))

watch(state, (value) => {
  if (typeof value.brightness === 'number') brightness.value = value.brightness
  if (typeof value.colorTemperature === 'number') kelvin.value = value.colorTemperature
  if (typeof value.hue === 'number') hue.value = value.hue
  if (typeof value.saturation === 'number') saturation.value = value.saturation
  if (typeof value.position === 'number') position.value = value.position
  if (typeof value.volume === 'number') volume.value = value.volume
  if (typeof value.targetTemperature === 'number') target.value = value.targetTemperature
  if (typeof value.fanSpeed === 'number') fanSpeed.value = value.fanSpeed
}, { deep: true })

const kelvinRange = computed<[number, number]>(() => {
  const range = state.value.colorTemperatureRange
  return Array.isArray(range) && range.length === 2 ? [Number(range[0]), Number(range[1])] : [2000, 6500]
})

const SWATCHES = [
  { label: 'Rouge', hue: 0, saturation: 100 },
  { label: 'Orange', hue: 30, saturation: 100 },
  { label: 'Ambre', hue: 45, saturation: 90 },
  { label: 'Vert', hue: 120, saturation: 90 },
  { label: 'Turquoise', hue: 175, saturation: 90 },
  { label: 'Bleu', hue: 220, saturation: 100 },
  { label: 'Violet', hue: 275, saturation: 90 },
  { label: 'Rose', hue: 320, saturation: 80 },
]

const HVAC_MODES = [
  { id: 'off', label: 'Arrêt', icon: 'ph:power' },
  { id: 'heat', label: 'Chauffage', icon: 'ph:fire' },
  { id: 'cool', label: 'Froid', icon: 'ph:snowflake' },
  { id: 'auto', label: 'Auto', icon: 'ph:arrows-clockwise' },
]

const id = computed(() => props.device.id)
const offline = computed(() => !props.device.online)
</script>

<template>
  <div class="space-y-4">
    <!-- Power -->
    <div v-if="has('onoff')" class="flex items-center gap-3">
      <button
        class="btn btn-sm flex-1 gap-2"
        :class="state.on ? 'admin-cta' : 'btn-outline'"
        :disabled="offline"
        @click="send(id, 'turnOn', { transitionMs: 400 })"
      >
        <Icon name="ph:power" class="size-4" />
        Allumer
      </button>
      <button
        class="btn btn-sm flex-1 gap-2"
        :class="!state.on ? 'admin-cta' : 'btn-outline'"
        :disabled="offline"
        @click="send(id, 'turnOff', { transitionMs: 800 })"
      >
        <Icon name="ph:power" class="size-4" />
        Éteindre
      </button>
    </div>

    <!-- Brightness -->
    <div v-if="has('brightness')">
      <div class="mb-1 flex items-baseline justify-between text-[12px]">
        <span class="text-base-content/60">Luminosité</span>
        <span class="tabular font-medium">{{ brightness }} %</span>
      </div>
      <input
        v-model.number="brightness"
        type="range"
        min="1"
        max="100"
        class="range range-sm w-full"
        :disabled="offline"
        @change="send(id, 'setBrightness', { brightness, transitionMs: 400 })"
      >
    </div>

    <!-- Colour temperature -->
    <div v-if="has('colorTemperature')">
      <div class="mb-1 flex items-baseline justify-between text-[12px]">
        <span class="text-base-content/60">Température de couleur</span>
        <span class="tabular font-medium">{{ kelvin }} K</span>
      </div>
      <input
        v-model.number="kelvin"
        type="range"
        :min="kelvinRange[0]"
        :max="kelvinRange[1]"
        step="50"
        class="range range-sm w-full"
        :disabled="offline"
        @change="send(id, 'setColorTemperature', { kelvin, transitionMs: 400 })"
      >
      <div
        class="mt-1 h-1.5 rounded-full"
        :style="{ background: 'linear-gradient(90deg, hsl(30 80% 60%), hsl(40 25% 85%), hsl(210 25% 92%))' }"
      />
    </div>

    <!-- Colour -->
    <div v-if="has('color')">
      <p class="mb-1.5 text-[12px] text-base-content/60">Couleur</p>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="swatch in SWATCHES"
          :key="swatch.label"
          class="size-7 rounded-full border transition-transform"
          :class="Math.abs(hue - swatch.hue) < 8 && saturation > 40 ? 'border-base-content' : 'border-base-300'"
          :style="{ backgroundColor: `hsl(${swatch.hue} ${swatch.saturation}% 55%)` }"
          :title="swatch.label"
          :aria-label="swatch.label"
          :disabled="offline"
          @click="send(id, 'setColor', { hue: swatch.hue, saturation: swatch.saturation, transitionMs: 400 })"
        />
        <button
          class="size-7 rounded-full border border-base-300 bg-base-100"
          title="Blanc"
          aria-label="Blanc"
          :disabled="offline"
          @click="send(id, 'setColorTemperature', { kelvin: 2700, transitionMs: 400 })"
        />
      </div>

      <div class="mt-3">
        <input
          v-model.number="hue"
          type="range"
          min="0"
          max="360"
          class="range range-sm w-full"
          :disabled="offline"
          @change="send(id, 'setColor', { hue, saturation: Math.max(saturation, 60), transitionMs: 300 })"
        >
        <div
          class="mt-1 h-1.5 rounded-full"
          :style="{ background: 'linear-gradient(90deg, hsl(0 90% 55%), hsl(60 90% 55%), hsl(120 90% 55%), hsl(180 90% 55%), hsl(240 90% 55%), hsl(300 90% 55%), hsl(360 90% 55%))' }"
        />
      </div>
    </div>

    <!-- Effects -->
    <div v-if="has('effect') && Array.isArray(state.availableEffects) && state.availableEffects.length">
      <p class="mb-1.5 text-[12px] text-base-content/60">Effet</p>
      <div class="flex flex-wrap gap-1.5">
        <button
          class="rounded-full border px-2.5 py-1 text-[12px] transition-colors"
          :class="!state.effect ? 'border-transparent bg-primary/25 font-medium' : 'border-base-300 hover:bg-base-200'"
          @click="send(id, 'clearEffect')"
        >Aucun</button>
        <button
          v-for="effect in state.availableEffects.slice(0, 24)"
          :key="effect"
          class="rounded-full border px-2.5 py-1 text-[12px] transition-colors"
          :class="state.effect === effect ? 'border-transparent bg-primary/25 font-medium' : 'border-base-300 hover:bg-base-200'"
          @click="send(id, 'setEffect', { effect })"
        >{{ effect }}</button>
      </div>
    </div>

    <!-- Cover -->
    <div v-if="has('position')">
      <div class="mb-1 flex items-baseline justify-between text-[12px]">
        <span class="text-base-content/60">Position</span>
        <span class="tabular font-medium">{{ position }} %</span>
      </div>
      <input
        v-model.number="position"
        type="range"
        min="0"
        max="100"
        class="range range-sm w-full"
        :disabled="offline"
        @change="send(id, 'setPosition', { position })"
      >
      <div class="mt-2 flex gap-2">
        <button class="btn btn-sm btn-outline flex-1" :disabled="offline" @click="send(id, 'open')">
          <Icon name="ph:arrow-up" class="size-4" /> Ouvrir
        </button>
        <button class="btn btn-sm btn-outline flex-1" :disabled="offline" @click="send(id, 'stop')">
          <Icon name="ph:stop" class="size-4" /> Stop
        </button>
        <button class="btn btn-sm btn-outline flex-1" :disabled="offline" @click="send(id, 'close')">
          <Icon name="ph:arrow-down" class="size-4" /> Fermer
        </button>
      </div>
    </div>

    <!-- Thermostat -->
    <div v-if="has('thermostat')" class="rounded-xl bg-base-200 p-3">
      <div class="flex items-center justify-center gap-6">
        <button class="btn btn-circle btn-sm btn-ghost" :disabled="offline" @click="target = Math.round((target - 0.5) * 2) / 2; send(id, 'setTargetTemperature', { celsius: target })">
          <Icon name="ph:minus" class="size-4" />
        </button>
        <div class="text-center">
          <p class="text-3xl font-semibold tabular leading-none">{{ target.toFixed(1) }}<span class="text-base text-base-content/45"> °C</span></p>
          <p v-if="typeof state.currentTemperature === 'number'" class="mt-1 text-[11px] tabular text-base-content/50">
            actuel {{ state.currentTemperature.toFixed(1) }} °C
            <span v-if="state.hvacAction && state.hvacAction !== 'idle'"> · {{ state.hvacAction }}</span>
          </p>
        </div>
        <button class="btn btn-circle btn-sm btn-ghost" :disabled="offline" @click="target = Math.round((target + 0.5) * 2) / 2; send(id, 'setTargetTemperature', { celsius: target })">
          <Icon name="ph:plus" class="size-4" />
        </button>
      </div>

      <div class="mt-3 flex gap-1">
        <button
          v-for="mode in HVAC_MODES"
          :key="mode.id"
          class="flex-1 rounded-lg px-2 py-1.5 text-[12px] transition-colors"
          :class="state.hvacMode === mode.id ? 'bg-primary/25 font-medium' : 'hover:bg-base-300'"
          :disabled="offline"
          @click="send(id, 'setHvacMode', { mode: mode.id })"
        >
          <Icon :name="mode.icon" class="mx-auto size-4" />
          <span class="mt-0.5 block">{{ mode.label }}</span>
        </button>
      </div>
    </div>

    <!-- Media -->
    <div v-if="has('mediaPlayback')" class="rounded-xl bg-base-200 p-3">
      <div v-if="state.title" class="mb-3 flex items-center gap-3">
        <img v-if="state.artworkUrl" :src="state.artworkUrl" alt="" class="size-12 rounded-lg object-cover">
        <span v-else class="grid size-12 place-items-center rounded-lg bg-base-300">
          <Icon name="ph:music-notes" class="size-5 text-base-content/40" />
        </span>
        <div class="min-w-0">
          <p class="truncate text-[13px] font-medium">{{ state.title }}</p>
          <p class="truncate text-[11px] text-base-content/55">{{ state.artist ?? state.app ?? '' }}</p>
        </div>
      </div>

      <div class="flex items-center justify-center gap-2">
        <button class="btn btn-circle btn-sm btn-ghost" :disabled="offline" @click="send(id, 'previous')">
          <Icon name="ph:skip-back-fill" class="size-4" />
        </button>
        <button class="btn btn-circle admin-cta" :disabled="offline" @click="send(id, state.playback === 'playing' ? 'pause' : 'play')">
          <Icon :name="state.playback === 'playing' ? 'ph:pause-fill' : 'ph:play-fill'" class="size-5" />
        </button>
        <button class="btn btn-circle btn-sm btn-ghost" :disabled="offline" @click="send(id, 'next')">
          <Icon name="ph:skip-forward-fill" class="size-4" />
        </button>
      </div>

      <div v-if="typeof state.durationSeconds === 'number' && state.durationSeconds > 0" class="mt-2">
        <div class="h-1 overflow-hidden rounded-full bg-base-300">
          <div
            class="h-full rounded-full bg-base-content"
            :style="{ width: `${Math.min(100, ((Number(state.positionSeconds ?? 0)) / Number(state.durationSeconds)) * 100)}%` }"
          />
        </div>
      </div>
    </div>

    <!-- Volume -->
    <div v-if="has('volume')">
      <div class="mb-1 flex items-baseline justify-between text-[12px]">
        <span class="text-base-content/60">Volume</span>
        <span class="tabular font-medium">{{ volume }}</span>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn btn-xs btn-ghost btn-square" :disabled="offline" @click="send(id, 'setMuted', { muted: !state.muted })">
          <Icon :name="state.muted ? 'ph:speaker-slash' : 'ph:speaker-high'" class="size-4" />
        </button>
        <input
          v-model.number="volume"
          type="range"
          min="0"
          max="100"
          class="range range-sm flex-1"
          :disabled="offline"
          @change="send(id, 'setVolume', { volume })"
        >
      </div>
    </div>

    <!-- Source -->
    <div v-if="has('mediaSource') && Array.isArray(state.availableSources) && state.availableSources.length">
      <p class="mb-1.5 text-[12px] text-base-content/60">Source</p>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="source in state.availableSources.slice(0, 16)"
          :key="source"
          class="rounded-full border px-2.5 py-1 text-[12px] transition-colors"
          :class="state.source === source ? 'border-transparent bg-primary/25 font-medium' : 'border-base-300 hover:bg-base-200'"
          :disabled="offline"
          @click="send(id, 'setSource', { source })"
        >{{ source }}</button>
      </div>
    </div>

    <!-- Fan -->
    <div v-if="has('fan')">
      <div class="mb-1 flex items-baseline justify-between text-[12px]">
        <span class="text-base-content/60">Ventilation</span>
        <span class="tabular font-medium">{{ fanSpeed }} %</span>
      </div>
      <input
        v-model.number="fanSpeed"
        type="range"
        min="0"
        max="100"
        class="range range-sm w-full"
        :disabled="offline"
        @change="send(id, 'setFanSpeed', { speed: fanSpeed })"
      >
    </div>

    <!-- Vacuum -->
    <div v-if="has('vacuum')" class="flex flex-wrap gap-2">
      <button class="btn btn-sm admin-cta gap-2" :disabled="offline" @click="send(id, 'startCleaning')">
        <Icon name="ph:play" class="size-4" /> Nettoyer
      </button>
      <button class="btn btn-sm btn-outline gap-2" :disabled="offline" @click="send(id, 'pauseCleaning')">
        <Icon name="ph:pause" class="size-4" /> Pause
      </button>
      <button class="btn btn-sm btn-outline gap-2" :disabled="offline" @click="send(id, 'returnToDock')">
        <Icon name="ph:house" class="size-4" /> Base
      </button>
    </div>

    <p v-if="offline" class="rounded-xl border border-base-300 bg-base-200 p-3 text-[12px] text-base-content/60">
      Cet appareil ne répond plus. Les commandes sont désactivées jusqu'à ce qu'il revienne.
    </p>
  </div>
</template>
