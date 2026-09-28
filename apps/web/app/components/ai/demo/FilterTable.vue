<script setup lang="ts">
/**
 * Demo gallery for AiFilterTable: the house's routines, filterable by status. The source has no
 * timers to replay - it is purely click-driven - so this demo is just the component wired to
 * French routine data; every chip and its count come from `filterTableCounts`, never hard-coded.
 */

const STATUSES: FilterTableStatus[] = [
  { key: 'a-valider', label: 'À valider', tone: 'warning' },
  { key: 'active', label: 'Active', tone: 'success' },
  { key: 'en-pause', label: 'En pause', tone: 'info' },
]

const ROWS: FilterTableRow[] = [
  { id: 'reveil', label: 'Réveil en douceur', date: 'Tous les jours à 7 h 00', status: 'active', owner: 'Il y a 8 h' },
  { id: 'depart', label: 'Départ de la maison', date: 'Détection de départ', status: 'active', owner: 'Hier à 8 h 12' },
  { id: 'arrosage', label: 'Arrosage du soir', date: 'Coucher du soleil - 30 min', status: 'a-valider', owner: 'Jamais exécutée' },
  { id: 'cinema', label: 'Cinéma', date: 'Manuel', status: 'en-pause', owner: 'Il y a 5 jours' },
  { id: 'fermeture', label: 'Fermeture nocturne', date: 'Tous les jours à 23 h 00', status: 'active', owner: 'Il y a 14 h' },
  { id: 'chauffage-vacances', label: 'Chauffage vacances', date: 'Tous les jours à 6 h 00', status: 'en-pause', owner: 'Il y a 3 semaines' },
]

const LABELS: FilterTableColumnLabels = { label: 'Routine', date: 'Déclencheur', status: 'Statut', owner: 'Dernière exécution' }

const filter = ref(FILTER_TABLE_ALL)
</script>

<template>
  <section>
    <span class="mb-2 block text-[11px] font-medium uppercase tracking-wider text-ink-3">Routines de la maison</span>
    <div class="bg-canvas rounded-window p-6">
      <AiFilterTable :rows="ROWS" :statuses="STATUSES" :labels="LABELS" v-model:filter="filter" />
    </div>
  </section>
</template>
