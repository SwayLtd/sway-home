<script setup lang="ts">
/**
 * DEMO: AiToolChips - replays the source's staggered reveal (a step every 700ms, running then
 * settling to its final status, then the change chips once every step has landed) with a French
 * "Depart de la maison" run. ToolChips has no visual variants, so this is a single instance.
 */
import type { ToolChipsChange, ToolChipsStep } from '~/utils/aiToolChips'

const STEP_MS = 700

const STEPS: ToolChipsStep[] = [
  {
    id: 'think',
    icon: 'think',
    label: 'Réflexion',
    chip: "Vérifie les pièces occupées avant de couper les lumières...",
    status: 'ok',
    detail: [
      { text: 'Le salon et la cuisine sont vides depuis 12 min.' },
      { text: 'Le capteur de mouvement de la chambre est encore actif.' },
    ],
  },
  {
    id: 'lights',
    icon: 'lightbulb',
    label: 'Éteindre 3 lumières',
    chip: 'Salon, Cuisine, Entrée',
    status: 'ok',
    detail: [
      { text: 'Lampe salon : allumée -> éteinte', tone: 'add' },
      { text: 'Plafonnier cuisine : allumé -> éteint', tone: 'add' },
      { text: 'Lumière entrée : allumée -> éteinte', tone: 'add' },
    ],
  },
  {
    id: 'thermostat',
    icon: 'thermometer',
    label: 'Régler le thermostat',
    chip: '19,5 °C (mode absence)',
    status: 'ok',
    detail: [{ text: 'Consigne salon : 21 °C -> 19,5 °C' }],
  },
  {
    id: 'lock',
    icon: 'door-open',
    label: 'Verrouiller la serrure',
    chip: 'Serrure entrée',
    status: 'failed',
    detail: [{ text: 'Délai dépassé après 3 tentatives' }],
  },
]

const CHANGES: ToolChipsChange[] = [
  {
    id: 'change-lampe',
    label: 'Lampe salon',
    before: 'allumée',
    after: 'éteinte',
    detail: [
      { text: 'allumée', tone: 'del' },
      { text: 'éteinte', tone: 'add' },
    ],
  },
  {
    id: 'change-thermostat',
    label: 'Thermostat salon',
    before: '21 °C',
    after: '19,5 °C',
    detail: [
      { text: '21 °C', tone: 'del' },
      { text: '19,5 °C', tone: 'add' },
    ],
  },
  {
    id: 'change-appareils',
    label: 'Appareils éteints',
    add: 3,
    del: 0,
    detail: [
      { text: 'Lampe salon', tone: 'add' },
      { text: 'Plafonnier cuisine', tone: 'add' },
      { text: 'Lumière entrée', tone: 'add' },
    ],
  },
]

const state = reactive({ steps: [] as ToolChipsStep[], changes: [] as ToolChipsChange[] })
let timers: ReturnType<typeof setTimeout>[] = []

function clearTimers() {
  timers.forEach(clearTimeout)
  timers = []
}

function replay() {
  clearTimers()
  state.steps = []
  state.changes = []
  STEPS.forEach((step, index) => {
    const revealAt = STEP_MS * (index + 1)
    /* Each row lands as "running", then settles to its real status shortly before the next
       one arrives - so the demo actually shows all three states the type allows. */
    timers.push(
      setTimeout(() => {
        state.steps = [...state.steps, { ...step, status: 'running' }]
      }, revealAt)
    )
    timers.push(
      setTimeout(() => {
        state.steps = state.steps.map((row) => (row.id === step.id ? { ...row, status: step.status } : row))
      }, revealAt + 450)
    )
  })
  timers.push(
    setTimeout(() => {
      state.changes = CHANGES
    }, STEP_MS * (STEPS.length + 1))
  )
}

replay()
onBeforeUnmount(clearTimers)
</script>

<template>
  <section class="flex flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <p class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Départ de la maison</p>
      <AiButton size="xs" variant="secondary" @click="replay">Rejouer</AiButton>
    </div>
    <div class="bg-canvas rounded-window p-6">
      <AiToolChips :steps="state.steps" :changes="state.changes" more="+1 autre" />
    </div>
  </section>
</template>
