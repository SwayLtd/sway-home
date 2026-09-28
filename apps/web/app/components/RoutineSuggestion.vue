<script setup lang="ts">
/**
 * A routine the assistant wrote, answered where it was proposed.
 *
 * `create_routine` attaches the routine it wrote to its answer. When the house keeps it as a
 * suggestion, it is shown here as a recommendation: the routine as written, then each of its
 * alternatives (every day instead of weekdays, at sunset instead of a fixed hour...), with
 * how sure the hub is of the habit behind it. Accepting one activates that version; dismissing
 * archives it. An active routine is only a link to its page.
 */

import type { Routine } from '@sway-home/shared/automation'

const props = defineProps<{ routineId: string }>()

const routine = ref<Routine | null>(null)
const missing = ref(false)
const error = ref<string | null>(null)
const settled = ref<'approved' | 'dismissed' | null>(null)

onMounted(async () => {
  try {
    const { routines } = await hubFetch<{ routines: Routine[] }>('/routines')
    routine.value = routines.find((candidate) => candidate.id === props.routineId) ?? null
    missing.value = routine.value === null
  } catch {
    missing.value = true
  }
})

const MAIN = 'main'

const options = computed<RecommendationCardOption[]>(() => {
  const current = routine.value
  if (!current) return []
  const confidence = current.confidence ?? undefined
  return [
    {
      id: MAIN,
      title: current.name,
      body: current.suggestionReason ?? current.description ?? 'Telle que proposée.',
      confidence,
      cta: 'Activer',
      ctaVariant: 'accent' as const,
    },
    ...(current.alternatives ?? []).map((alternative) => ({
      id: alternative.id,
      title: alternative.title,
      body: alternative.description,
      cta: 'Activer cette version',
      ctaVariant: 'primary' as const,
    })),
  ]
})

async function confirm(option: RecommendationCardOption) {
  if (!routine.value) return
  error.value = null
  try {
    await hubFetch(`/routines/${routine.value.id}/approve`, { method: 'POST', body: option.id === MAIN ? {} : { alternativeId: option.id } })
    settled.value = 'approved'
  } catch (failure) {
    error.value = (failure as { data?: { error?: string } }).data?.error ?? "La routine n'a pas pu être activée."
  }
}

async function dismiss() {
  if (!routine.value) return
  error.value = null
  try {
    await hubFetch(`/routines/${routine.value.id}`, { method: 'PATCH', body: { status: 'archived' } })
    settled.value = 'dismissed'
  } catch {
    error.value = "La suggestion n'a pas pu être écartée."
  }
}
</script>

<template>
  <div>
    <NuxtLink
      v-if="missing || (routine && routine.status !== 'suggested' && !settled)"
      to="/routines"
      class="flex items-center gap-2 rounded-[10px] border border-line p-2 text-[12px] text-ink-2 transition-colors hover:bg-hover"
    >
      <Icon name="ph:flow-arrow" class="size-4" />
      {{ routine ? `Routine ${routine.name}` : 'Routine' }}
      <Icon name="ph:arrow-right" class="ml-auto size-3.5 opacity-40" />
    </NuxtLink>

    <template v-else-if="routine">
      <AiRecommendationCard
        v-if="settled !== 'dismissed'"
        :options="options"
        :labels="{ alternatives: 'Autres versions', otherOptions: 'Autres versions', accepted: 'Activée', dismiss: 'Écarter la suggestion' }"
        @confirm="confirm"
        @dismiss="dismiss"
      />
      <p v-else class="text-[12px] text-ink-3">Suggestion écartée.</p>
      <p v-if="error" class="mt-1 text-[12px] text-error">{{ error }}</p>
    </template>

    <div v-else class="h-20 animate-pulse rounded-[12px] bg-field" />
  </div>
</template>
