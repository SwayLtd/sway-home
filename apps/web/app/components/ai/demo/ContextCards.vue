<script setup lang="ts">
/**
 * DEMO: AiContextCards - an initial batch enters staggered, then two more cards arrive after
 * a delay (the run keeps reading context while it works) without replaying the first batch.
 * Covers all five kinds and every trailing-stat case (meta, score, neither, linked, not).
 */
import type { ContextCardsItem } from '~/utils/aiContextCards'

const FIRST_BATCH: ContextCardsItem[] = [
  { id: 'mem-1', kind: 'memory', title: 'Préférence thermique', excerpt: 'Préfère 20 °C le soir dans le Salon.', score: 0.92 },
  { id: 'dev-1', kind: 'device', title: 'Thermostat Salon', excerpt: 'Consigne actuelle 19,5 °C, mode Éco actif depuis 21 h.', meta: 'il y a 2 min', href: '/appareils/thermostat-salon' },
  { id: 'rou-1', kind: 'routine', title: 'Réveil en douceur', excerpt: 'Allume le Plafonnier cuisine à 6 %, puis monte à 40 % sur 10 minutes.', meta: '07 h 00', href: '/routines' },
]

const SECOND_BATCH: ContextCardsItem[] = [
  { id: 'sce-1', kind: 'scene', title: 'Scène Cinéma', excerpt: 'Tamise le Salon à 15 % et coupe le Plafonnier cuisine.', score: 0.78, href: '/scenes' },
  { id: 'doc-1', kind: 'doc', title: 'Manuel Serrure entrée', excerpt: "Le verrouillage automatique s'active 30 secondes après la fermeture.", meta: 'Notice PDF' },
]

const items = ref<ContextCardsItem[]>([])
const replayKey = ref(0)
const lastEvent = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

function play() {
  if (timer) clearTimeout(timer)
  items.value = FIRST_BATCH
  timer = setTimeout(() => {
    items.value = [...FIRST_BATCH, ...SECOND_BATCH]
  }, 1600)
}

function replay() {
  replayKey.value += 1
  lastEvent.value = ''
  play()
}

onMounted(play)
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <section>
    <div class="mb-2 flex items-center justify-between gap-2">
      <p class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Contexte lu par le run</p>
      <AiButton size="xs" variant="secondary" @click="replay">Rejouer</AiButton>
    </div>
    <div class="bg-canvas rounded-window p-6">
      <AiContextCards :key="replayKey" :items="items" @open="lastEvent = `Ouvert : ${$event.title}`" />
    </div>
    <p class="mt-2 min-h-4 text-[11px] text-ink-3">{{ lastEvent }}</p>
  </section>
</template>
