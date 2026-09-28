<script setup lang="ts">
/**
 * Push to talk.
 *
 * Hold to record, release to send. Holding rather than toggling is deliberate: a toggle
 * leaves a microphone open in someone's home, and the one thing a privacy-first product
 * must never do is leave the microphone open by accident. The dot only pulses while the
 * pointer is down.
 */

const emit = defineEmits<{ transcript: [string] }>()

const settings = useVoiceSettings()
const recogniser = useRecogniser(settings)

const held = ref(false)
const downloading = computed(() => recogniser.progress.value > 0 && recogniser.progress.value < 1)

async function begin(event: PointerEvent) {
  if (settings.value.engine === 'off') return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  held.value = true
  await recogniser.start()
}

function end() {
  if (!held.value) return
  held.value = false
  recogniser.stop()
}

watch(recogniser.listening, (listening, was) => {
  if (was && !listening) {
    const text = recogniser.partial.value.trim()
    if (text.length > 0) emit('transcript', text)
  }
})
</script>

<template>
  <div class="relative">
    <button
      class="grid size-8 shrink-0 place-items-center rounded-xl transition-colors"
      :class="recogniser.listening.value ? 'bg-error/15 text-error' : 'text-base-content/50 hover:bg-base-200'"
      :aria-label="recogniser.listening.value ? 'Relâchez pour envoyer' : 'Maintenez pour parler'"
      :title="settings.engine === 'local' ? 'Maintenir pour parler (modèle local)' : 'Maintenir pour parler'"
      @pointerdown.prevent="begin"
      @pointerup="end"
      @pointercancel="end"
      @pointerleave="end"
    >
      <Icon
        :name="recogniser.listening.value ? 'ph:microphone-fill' : 'ph:microphone'"
        class="size-4"
        :class="recogniser.listening.value ? 'live-dot rounded-full' : ''"
      />
    </button>

    <!-- The model download is a real wait, so it is shown rather than hidden behind a spinner -->
    <div
      v-if="downloading"
      class="absolute bottom-full left-0 mb-2 w-44 rounded-xl border border-base-300 bg-base-100 p-2 text-[11px] shadow-lg"
    >
      <p class="font-medium">Téléchargement du modèle</p>
      <div class="mt-1 h-1 overflow-hidden rounded-full bg-base-300">
        <div class="h-full rounded-full bg-base-content transition-[width]" :style="{ width: `${Math.round(recogniser.progress.value * 100)}%` }" />
      </div>
      <p class="mt-1 text-base-content/50">Une seule fois, puis tout reste local.</p>
    </div>

    <p
      v-else-if="recogniser.partial.value && recogniser.listening.value"
      class="absolute bottom-full left-0 mb-2 max-w-64 truncate rounded-lg bg-base-content px-2 py-1 text-[11px] text-base-100"
    >{{ recogniser.partial.value }}</p>

    <p
      v-else-if="recogniser.error.value"
      class="absolute bottom-full left-0 mb-2 w-52 rounded-lg bg-error px-2 py-1 text-[11px] text-error-content"
    >{{ recogniser.error.value }}</p>
  </div>
</template>
