<script setup lang="ts">
/**
 * Demo gallery for AiDiffTable: switching off several lights (all 'remove' rows), and editing
 * the "Réveil en douceur" routine (a 'change' row for the trigger time, an 'add' row for a
 * new action). The edit plays once per card; rows toggle; apply or discard.
 */

const lightsRows: DiffTableRow[] = [
  { id: 'salon', label: 'Lampe salon', before: 'Allumée', kind: 'remove', meta: 'Salon', metaTone: 'orange' },
  { id: 'cuisine', label: 'Plafonnier cuisine', before: 'Allumée', kind: 'remove', meta: 'Cuisine', metaTone: 'accent' },
  { id: 'entree', label: 'Applique entrée', before: 'Allumée', kind: 'remove', meta: 'Entrée', metaTone: 'green' },
  { id: 'bureau', label: 'Lampe bureau', before: 'Allumée', kind: 'remove', meta: 'Bureau', metaTone: 'red' },
  { id: 'chambre', label: 'Veilleuse chambre', before: 'Allumée', kind: 'remove', meta: 'Chambre', metaTone: 'neutral' },
]

const routineRows: DiffTableRow[] = [
  { id: 'trigger', label: 'Déclencheur', before: '07:00', after: '06:45', kind: 'change', meta: 'Heure', metaTone: 'accent' },
  { id: 'add-volet', label: 'Ouvrir volet chambre', after: 'Ajoutée', kind: 'add', meta: 'Chambre', metaTone: 'green' },
]

const lightsKey = ref(0)
const routineKey = ref(0)
const lightsResult = ref('')
const routineResult = ref('')

function replayLights() {
  lightsKey.value += 1
  lightsResult.value = ''
}
function replayRoutine() {
  routineKey.value += 1
  routineResult.value = ''
}
</script>

<template>
  <section class="grid gap-4 lg:grid-cols-2">
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Éteindre 5 lumières</span>
        <AiButton size="xs" variant="secondary" @click="replayLights">Rejouer</AiButton>
      </div>
      <div class="flex items-center justify-center bg-canvas rounded-window p-6">
        <AiDiffTable
          :key="lightsKey"
          :rows="lightsRows"
          :labels="{ title: 'Éteindre 5 lumières' }"
          @apply="(ids) => (lightsResult = `Appliqué - ${ids.length} lumière(s) éteinte(s)`)"
          @discard="lightsResult = 'Proposition ignorée'"
        />
      </div>
      <p class="min-h-4 text-[11.5px] text-ink-3">{{ lightsResult }}</p>
    </div>

    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Modifier une routine</span>
        <AiButton size="xs" variant="secondary" @click="replayRoutine">Rejouer</AiButton>
      </div>
      <div class="flex items-center justify-center bg-canvas rounded-window p-6">
        <AiDiffTable
          :key="routineKey"
          :rows="routineRows"
          :labels="{ title: 'Modifier Réveil en douceur' }"
          @apply="(ids) => (routineResult = `Appliqué - ${ids.length} modification(s)`)"
          @discard="routineResult = 'Proposition ignorée'"
        />
      </div>
      <p class="min-h-4 text-[11.5px] text-ink-3">{{ routineResult }}</p>
    </div>
  </section>
</template>
