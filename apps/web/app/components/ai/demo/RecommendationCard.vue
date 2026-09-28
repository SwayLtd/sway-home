<script setup lang="ts">
/**
 * DEMO: AiRecommendationCard - a routine suggestion with its three confidence tiers (time
 * trigger accepted outright, sunrise trigger needing a look, motion trigger with no signal at
 * all), covering the source's entity+value, plain rich-text and emphasis body styles and both
 * CTA variants it uses (accent, primary). "Rejouer" resets the pick and the Accepted state.
 */
import type { RecommendationCardOption } from '~/utils/aiRecommendationCard'

const OPTIONS: RecommendationCardOption[] = [
  {
    id: 'time',
    title: 'Allumer la Lampe salon à 7 h en semaine',
    body: [
      { kind: 'text', text: 'Observé sur ' },
      { kind: 'entity', name: 'Lampe salon', color: '#e0a53c' },
      { kind: 'text', text: ' : allumée ' },
      { kind: 'value', text: '6 fois', tone: 'green' },
      { kind: 'text', text: ' en 3 semaines, entre ' },
      { kind: 'value', text: '6 h 55' },
      { kind: 'text', text: ' et ' },
      { kind: 'value', text: '7 h 05' },
      { kind: 'text', text: '.' },
    ],
    confidence: 0.9,
    cta: 'Accepter',
    ctaVariant: 'accent',
  },
  {
    id: 'sunrise',
    title: 'Allumer la Lampe salon au lever du soleil',
    body: 'Coïncide avec le lever du soleil, à plus ou moins [[ph:sun-horizon|12 min|info]] selon la saison.',
    confidence: 0.55,
    cta: 'Configurer',
    ctaVariant: 'primary',
  },
  {
    id: 'motion',
    title: 'Allumer la Lampe salon à la détection de mouvement',
    body: [
      { kind: 'text', text: 'Utilise le ' },
      { kind: 'emphasis', text: 'Capteur de mouvement' },
      { kind: 'text', text: ' du Salon, sans horaire fixe.' },
    ],
    cta: 'Activer quand même',
    ctaVariant: 'primary',
  },
]

const replayKey = ref(0)
const selected = ref<string | undefined>(undefined)
const lastEvent = ref('')

function replay() {
  replayKey.value += 1
  selected.value = undefined
  lastEvent.value = ''
}
</script>

<template>
  <section>
    <div class="mb-2 flex items-center justify-between gap-2">
      <p class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Suggestion de routine</p>
      <AiButton size="xs" variant="secondary" @click="replay">Rejouer</AiButton>
    </div>
    <div class="bg-canvas rounded-window p-6">
      <AiRecommendationCard
        :key="replayKey"
        v-model:selected="selected"
        :options="OPTIONS"
        @select="lastEvent = `Alternative choisie : ${$event.title}`"
        @confirm="lastEvent = `Confirmé : ${$event.title}`"
        @dismiss="lastEvent = 'Suggestion ignorée'"
      />
    </div>
    <p class="mt-2 min-h-4 text-[11px] text-ink-3">{{ lastEvent }}</p>
  </section>
</template>
