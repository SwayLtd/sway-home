<script setup lang="ts">
/**
 * Demo gallery for AiApprovalCard: a multi-question clarification for the "Réveil en douceur"
 * routine (which lamp, which days, what time), and a single yes/no confirmation of a critical
 * action (unlocking the front door).
 */

const clarificationQuestions: ApprovalQuestion[] = [
  {
    id: 'lamp',
    title: 'Quelle lampe ?',
    options: [
      { id: 'salon', label: 'Lampe salon' },
      { id: 'cuisine', label: 'Plafonnier cuisine' },
      { id: 'all', label: 'Toutes les lampes' },
    ],
  },
  {
    id: 'days',
    title: 'Quels jours ?',
    multiple: true,
    options: [
      { id: 'weekdays', label: 'Semaine (lun-ven)' },
      { id: 'saturday', label: 'Samedi' },
      { id: 'sunday', label: 'Dimanche' },
    ],
  },
  {
    id: 'time',
    title: 'À quelle heure ?',
    allowOther: true,
    options: [
      { id: '0700', label: '7 h 00' },
      { id: '0730', label: '7 h 30' },
      { id: '0800', label: '8 h 00' },
    ],
  },
]

const confirmQuestions: ApprovalQuestion[] = [
  {
    id: 'unlock',
    title: "Déverrouiller la serrure d'entrée ?",
    description: 'Action sensible : le hub demande toujours confirmation.',
    options: [
      { id: 'yes', label: 'Oui' },
      { id: 'no', label: 'Non' },
    ],
  },
]

const clarificationKey = ref(0)
const confirmKey = ref(0)
const clarificationResult = ref('')
const confirmResult = ref('')

function replayClarification() {
  clarificationKey.value += 1
  clarificationResult.value = ''
}
function replayConfirm() {
  confirmKey.value += 1
  confirmResult.value = ''
}

function describeAnswers(answers: Record<string, ApprovalAnswer>): string {
  return (
    Object.entries(answers)
      .map(([id, answer]) => `${id} : ${Array.isArray(answer) ? answer.join(', ') : answer}`)
      .join(' | ') || 'aucune réponse'
  )
}
</script>

<template>
  <section class="grid gap-4 lg:grid-cols-2">
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Clarification multi-questions</span>
        <AiButton size="xs" variant="secondary" @click="replayClarification">Rejouer</AiButton>
      </div>
      <div class="flex min-h-90 items-center justify-center bg-canvas rounded-window p-6">
        <AiApprovalCard
          :key="clarificationKey"
          :questions="clarificationQuestions"
          @submit="(answers) => (clarificationResult = `Envoyé - ${describeAnswers(answers)}`)"
          @skip="(id) => (clarificationResult = `Question passée : ${id}`)"
          @close="clarificationResult = 'Fermé sans répondre'"
        />
      </div>
      <p class="min-h-4 text-[11.5px] text-ink-3">{{ clarificationResult }}</p>
    </div>

    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Confirmation d'action critique</span>
        <AiButton size="xs" variant="secondary" @click="replayConfirm">Rejouer</AiButton>
      </div>
      <div class="flex min-h-90 items-center justify-center bg-canvas rounded-window p-6">
        <AiApprovalCard
          :key="confirmKey"
          :questions="confirmQuestions"
          :resettable="false"
          @submit="(answers) => (confirmResult = `Envoyé - ${describeAnswers(answers)}`)"
          @close="confirmResult = 'Fermé sans répondre'"
        />
      </div>
      <p class="min-h-4 text-[11.5px] text-ink-3">{{ confirmResult }}</p>
    </div>
  </section>
</template>
