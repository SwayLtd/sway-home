<script setup lang="ts">
/**
 * DEMO: AiThinking - replays the source's staged timeline (STAGES = [800, 600, 1800, 2600,
 * 1600]) for each of the four variants, with a French smart-home story: an energy-saving tip
 * (Steps), a thermostat reasoning aside (Reasoning), a Zigbee hub search (Search) and a routine
 * edit (Coding). The demo only ever changes `rows`/`working`/`more` - the settle-and-collapse
 * beat is <AiThinking>'s own behaviour, reacting to `working` turning false.
 */
import type { ThinkingRow } from '~/utils/aiThinking'

const STEPS_ROWS: ThinkingRow[] = [
  { id: 'steps-1', primary: "Lecture de l'historique des capteurs" },
  { id: 'steps-2', primary: 'Analyse de la consommation électrique' },
  { id: 'steps-3', primary: 'Comparaison des créneaux tarifaires', secondary: '6 créneaux' },
  { id: 'steps-4', primary: 'Rédaction de la recommandation' },
]

const REASONING_ROWS: ThinkingRow[] = [
  { id: 'reasoning-1', primary: 'La consommation grimpe chaque soir vers 19 h, quand le chauffage et le four se chevauchent.' },
  { id: 'reasoning-2', primary: "Je devrais vérifier l'état de la pompe à chaleur avant de proposer un créneau plus tard." },
]

const SEARCH_ROWS: ThinkingRow[] = [
  { id: 'search-1', primary: 'Zigbee2MQTT', secondary: 'zigbee2mqtt.io', href: 'https://www.zigbee2mqtt.io/' },
  { id: 'search-2', primary: 'Aide Sway - Zigbee', secondary: 'sway.app/aide/zigbee', href: '/aide/zigbee' },
  { id: 'search-3', primary: 'Comparatif domotique', secondary: 'domotique-info.fr', href: 'https://www.domotique-info.fr/' },
]

const CODING_ROWS: ThinkingRow[] = [
  { id: 'coding-1', primary: 'Lecture', secondary: 'routine_reveil.yaml', mono: true },
  { id: 'coding-2', primary: 'Modification', secondary: 'routine_reveil.yaml', mono: true, add: 12, del: 5 },
  { id: 'coding-3', primary: 'Exécution', secondary: 'sway routines:test', mono: true },
]

/* Reproduces STAGES timing: rows stay empty through stage 0-1 (1400ms), reveal up to 2 rows at
   stage 2 (1400-3200ms), then all rows with `working` false from stage 3 (3200ms) on. The
   component itself holds the trace open for a further beat (stage 3's own 2600ms) before it
   auto-collapses, so the demo has nothing left to schedule past this point. */
function createPlayer(all: ThinkingRow[], moreText?: string) {
  const state = reactive({ working: true, rows: [] as ThinkingRow[], more: undefined as string | undefined })
  const partial = Math.min(2, all.length)
  let timers: ReturnType<typeof setTimeout>[] = []

  function clear() {
    timers.forEach(clearTimeout)
    timers = []
  }

  function replay() {
    clear()
    state.working = true
    state.rows = []
    state.more = undefined
    timers.push(setTimeout(() => { state.rows = all.slice(0, partial) }, 1400))
    timers.push(
      setTimeout(() => {
        state.rows = all
        state.working = false
        if (moreText) state.more = moreText
      }, 3200)
    )
  }

  replay()
  onBeforeUnmount(clear)
  return { state, replay }
}

const steps = createPlayer(STEPS_ROWS)
const reasoning = createPlayer(REASONING_ROWS)
const search = createPlayer(SEARCH_ROWS, '+7 autres')
const coding = createPlayer(CODING_ROWS)

const codingSelected = ref<string | null>(null)
</script>

<template>
  <section class="grid gap-4 lg:grid-cols-2">
    <div>
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Steps</p>
        <AiButton size="xs" variant="secondary" @click="steps.replay()">Rejouer</AiButton>
      </div>
      <div class="bg-canvas rounded-window p-6">
        <AiThinking variant="Steps" :working="steps.state.working" :rows="steps.state.rows" done-label="Réflexion menée pendant 4 secondes" />
      </div>
    </div>

    <div>
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Reasoning</p>
        <AiButton size="xs" variant="secondary" @click="reasoning.replay()">Rejouer</AiButton>
      </div>
      <div class="bg-canvas rounded-window p-6">
        <AiThinking variant="Reasoning" :working="reasoning.state.working" :rows="reasoning.state.rows" />
      </div>
    </div>

    <div>
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Search</p>
        <AiButton size="xs" variant="secondary" @click="search.replay()">Rejouer</AiButton>
      </div>
      <div class="bg-canvas rounded-window p-6">
        <AiThinking
          variant="Search"
          :working="search.state.working"
          :rows="search.state.rows"
          query="meilleur hub zigbee 2026"
          :more="search.state.more"
        />
      </div>
    </div>

    <div>
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Coding</p>
        <AiButton size="xs" variant="secondary" @click="coding.replay()">Rejouer</AiButton>
      </div>
      <div class="bg-canvas rounded-window p-6">
        <AiThinking
          variant="Coding"
          :working="coding.state.working"
          :rows="coding.state.rows"
          done-label="3 outils exécutés"
          @select="codingSelected = $event?.primary ?? null"
        />
        <p class="mt-2 min-h-4 text-[11px] text-ink-3">{{ codingSelected ? `Sélectionné : ${codingSelected}` : '' }}</p>
      </div>
    </div>
  </section>
</template>
