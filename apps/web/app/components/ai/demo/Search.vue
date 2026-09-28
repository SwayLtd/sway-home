<script setup lang="ts">
/**
 * AiDemoSearch - gallery demo for <AiSearch> (Beautiful UI's SearchList, source 14).
 *
 * The source has no scripted timeline - SearchList is a live field with no autoplay - so this
 * demo is purely interactive. Two stages show the two filtering contracts: the left one lets
 * the component filter `items` itself (the default); the right one passes `:filter="false"`
 * with results the demo pre-filtered, standing in for a parent that asks the hub for matches.
 * "Rejouer" clears both queries and selections back to the initial state.
 */

const ITEMS: SearchItem[] = [
  { id: 'd-lampe-salon', label: 'Lampe salon', hint: 'Allumée, 80 %', icon: 'ph:lightbulb', group: 'Appareils' },
  { id: 'd-thermostat', label: 'Thermostat salon', hint: '20,5 °C', icon: 'ph:thermometer', group: 'Appareils' },
  { id: 'd-serrure', label: 'Serrure entrée', hint: 'Verrouillée', icon: 'ph:lock-key', group: 'Appareils' },
  { id: 'd-camera', label: 'Caméra entrée', hint: 'En direct', icon: 'ph:video-camera', group: 'Appareils' },
  { id: 'a-salon', label: 'Salon', icon: 'ph:door-open', group: 'Pièces' },
  { id: 'a-cuisine', label: 'Cuisine', icon: 'ph:door-open', group: 'Pièces' },
  { id: 'a-chambre', label: 'Chambre', icon: 'ph:door-open', group: 'Pièces' },
  { id: 'a-bureau', label: 'Bureau', icon: 'ph:door-open', group: 'Pièces' },
  { id: 'a-entree', label: 'Entrée', icon: 'ph:door-open', group: 'Pièces' },
  { id: 's-cinema', label: 'Cinéma', icon: 'ph:sparkle', group: 'Scènes' },
  { id: 's-nuit', label: 'Nuit', icon: 'ph:sparkle', group: 'Scènes' },
  { id: 's-diner', label: 'Dîner', icon: 'ph:sparkle', group: 'Scènes' },
  { id: 'r-reveil', label: 'Réveil en douceur', icon: 'ph:flow-arrow', group: 'Routines' },
  { id: 'r-depart', label: 'Départ de la maison', icon: 'ph:flow-arrow', group: 'Routines' },
  { id: 'r-arrosage', label: 'Arrosage du soir', icon: 'ph:flow-arrow', group: 'Routines' },
  { id: 'x-scan', label: 'Lancer un scan réseau', icon: 'ph:broadcast', group: 'Actions', shortcut: 'Ctrl S' },
  { id: 'x-propositions', label: 'Voir les propositions', icon: 'ph:seal-question', group: 'Actions' },
]

const query = ref('')
const selectedInternal = ref('')
function onSelectInternal(item: SearchItem) {
  selectedInternal.value = item.label
}

const externalQuery = ref('')
// stands in for a parent that filters server-side (the hub's own search) - the component only
// renders what it is given, it does not re-filter these
const externalResults = computed(() => ITEMS.filter((item) => searchMatches(item.label, externalQuery.value)))
const selectedExternal = ref('')
function onSelectExternal(item: SearchItem) {
  selectedExternal.value = item.label
}

function restart() {
  query.value = ''
  externalQuery.value = ''
  selectedInternal.value = ''
  selectedExternal.value = ''
}
</script>

<template>
  <section class="grid gap-4 lg:grid-cols-2">
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Filtrage interne</span>
        <AiButton size="xs" variant="secondary" @click="restart">Rejouer</AiButton>
      </div>
      <div class="flex flex-col items-center gap-2 rounded-window bg-canvas p-6">
        <AiSearch v-model="query" :items="ITEMS" placeholder="Rechercher un appareil, une pièce..." @select="onSelectInternal" />
        <p v-if="selectedInternal" class="text-[11px] text-ink-3">Sélection : {{ selectedInternal }}</p>
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Filtrage externe</span>
        <AiButton size="xs" variant="secondary" @click="restart">Rejouer</AiButton>
      </div>
      <div class="flex flex-col items-center gap-2 rounded-window bg-canvas p-6">
        <AiSearch v-model="externalQuery" :items="externalResults" :filter="false" placeholder="Déjà filtré par le parent..." @select="onSelectExternal" />
        <p v-if="selectedExternal" class="text-[11px] text-ink-3">Sélection : {{ selectedExternal }}</p>
      </div>
    </div>
  </section>
</template>
