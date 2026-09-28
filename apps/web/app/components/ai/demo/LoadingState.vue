<script setup lang="ts">
/**
 * DEMO: AiLoadingState - the four loaders side by side, each with its own timer. "Rejouer"
 * restarts the timers, which is all there is to replay: the grid itself loops for as long as
 * the work lasts.
 */
import { LOADER_VARIANTS } from '~/composables/useAiPreferences'

const LABELS: Record<string, string> = {
  Drive: 'Scan du réseau',
  Dots: 'Lecture des capteurs',
  Orbit: 'Réfléchit',
  Surfer: 'Mise à jour des appareils',
}

const startedAt = ref(Date.now())
</script>

<template>
  <section class="grid gap-4 lg:grid-cols-2">
    <div v-for="variant in LOADER_VARIANTS" :key="variant.value">
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="text-[11px] font-medium uppercase tracking-wider text-ink-3">{{ variant.label }}</p>
        <AiButton size="xs" variant="secondary" @click="startedAt = Date.now()">Rejouer</AiButton>
      </div>
      <div class="bg-canvas rounded-window flex min-h-24 items-center p-6">
        <AiLoadingState :key="`${variant.value}-${startedAt}`" :variant="variant.value" :label="LABELS[variant.value]" :started-at="startedAt" />
      </div>
      <p class="mt-1.5 text-[11.5px] text-ink-3">{{ variant.hint }}</p>
    </div>
  </section>
</template>
