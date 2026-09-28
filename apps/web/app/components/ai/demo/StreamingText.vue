<script setup lang="ts">
/**
 * DEMO: AiStreamingText - replays the source's story (words resolving out of blur, an inline
 * citation, then actions and follow-ups becoming usable) with Sway Home content, next to the
 * settled "history" case the component also has to render.
 */
import type { StreamingTextFollowUp, StreamingTextSource } from '~/utils/aiStreamingText'

const SOURCES: StreamingTextSource[] = [
  { id: 'hub', title: 'Historique du Salon', subtitle: 'maison.local', kind: 'device', href: '/appareils/lampe-salon' },
  { id: 'routine', title: 'Réveil en douceur', subtitle: 'routine', kind: 'routine', href: '/routines' },
  { id: 'tarif', title: 'Grille tarifaire', subtitle: 'edf.fr', kind: 'web', href: 'https://www.edf.fr/' },
]

const ANSWER =
  "Le Salon reste la pièce la plus gourmande cette semaine [[cite:hub]] : [[ph:lightning|4,2 kWh|warn]] contre 3,6 kWh la semaine dernière, soit une hausse de 17 %. Le chauffage explique l'essentiel de l'écart ; la Chambre et la Cuisine restent stables."

const HISTORY_ANSWER =
  "La Chambre est descendue à [[ph:thermometer|18,5 °C|info]] cette nuit, sous la consigne de 19 °C. Le radiateur s'est relancé à 6 h 40, avant le réveil programmé."

const FOLLOW_UPS: StreamingTextFollowUp[] = [
  { text: 'Quelle pièce consomme le plus ce mois-ci ?', icon: 'ph:ranking' },
  { text: 'Compare avec la même semaine du mois dernier', icon: 'ph:calendar-check' },
]

const replayKey = ref(0)
const lastEvent = ref('')
const feedback = ref<'up' | 'down' | null>(null)

function replay() {
  replayKey.value += 1
  lastEvent.value = ''
  feedback.value = null
}
</script>

<template>
  <section class="grid gap-4 lg:grid-cols-2">
    <div>
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Réponse en direct</p>
        <AiButton size="xs" variant="secondary" @click="replay">Rejouer</AiButton>
      </div>
      <div class="bg-canvas rounded-window p-6">
        <AiStreamingText
          :key="replayKey"
          v-model:feedback="feedback"
          :text="ANSWER"
          :sources="SOURCES"
          :follow-ups="FOLLOW_UPS"
          animate
          @follow-up="lastEvent = `Suggestion choisie : ${$event.text}`"
          @copy="lastEvent = 'Réponse copiée'"
          @retry="lastEvent = 'Nouvelle génération demandée'"
          @done="lastEvent = 'Réponse affichée'"
        />
      </div>
      <p class="mt-2 min-h-4 text-[11px] text-ink-3">{{ lastEvent }}</p>
    </div>

    <div>
      <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-3">Historique (réglée d'emblée)</p>
      <div class="bg-canvas rounded-window p-6">
        <AiStreamingText :text="HISTORY_ANSWER" :sources="SOURCES.slice(0, 1)" :animate="false" />
      </div>
    </div>
  </section>
</template>
