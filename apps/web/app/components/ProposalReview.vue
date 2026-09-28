<script setup lang="ts">
/**
 * One proposal of the assistant, reviewed row by row before it runs.
 *
 * The hub words every command as a state - "allumé -> éteint", "20 °C -> 21,5 °C" - from what
 * it knows of the device now, and each row can be left out before saying yes: only the kept
 * rows run, and the ones left out are remembered as a correction. Used in the conversation,
 * under the answer that proposed it, and in the dock's list of what waits for a yes.
 */

export interface ProposalChange {
  /** Position in the proposal's command list: what `approve` takes in `include`. */
  index: number
  deviceId: string
  deviceName: string
  area: string | null
  command: string
  label: string
  before: string | null
  after: string | null
}

export interface ReviewedProposal {
  id: string
  summary: string
  reason: string
  risk: string
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'failed'
  expiresAt: string
  changes: ProposalChange[]
}

export type ProposalOutcome = 'approved' | 'rejected' | 'failed'

const props = defineProps<{
  /** Either the proposal as the hub listed it, or only its id, fetched here. */
  proposal?: ReviewedProposal | null
  proposalId?: string | null
  /** Narrow column: the summary above the table, the reason under it. */
  compact?: boolean
}>()

const emit = defineEmits<{ decided: [outcome: ProposalOutcome, ran: number] }>()

const { refresh } = useHouse()
const loaded = ref<ReviewedProposal | null>(props.proposal ?? null)
const error = ref<string | null>(null)
const outcome = ref<{ kind: ProposalOutcome; ran: number } | null>(null)
/** Bumped to remount the table after a failed apply, so its rows can be chosen again. */
const attempt = ref(0)

watch(
  () => props.proposal,
  (next) => {
    if (next) loaded.value = next
  }
)

onMounted(async () => {
  if (loaded.value || !props.proposalId) return
  try {
    loaded.value = (await hubFetch<{ proposal: ReviewedProposal }>(`/agent/proposals/${props.proposalId}`)).proposal
  } catch {
    error.value = 'Cette proposition est introuvable.'
  }
})

const RISK: Record<string, { label: string; tone: DiffTableTone }> = {
  none: { label: 'Sans risque', tone: 'green' },
  low: { label: 'Risque faible', tone: 'green' },
  medium: { label: 'Risque moyen', tone: 'orange' },
  high: { label: 'Risque élevé', tone: 'red' },
  forbidden: { label: 'Interdit', tone: 'red' },
}

const rows = computed<DiffTableRow[]>(() =>
  (loaded.value?.changes ?? []).map((change) => ({
    id: String(change.index),
    label: `${change.deviceName} · ${change.label}`,
    before: change.before ?? undefined,
    after: change.after ?? undefined,
    kind: 'change' as const,
    meta: change.area ?? undefined,
    metaTone: 'neutral' as const,
  }))
)

/** Settled before this card was drawn: approved elsewhere, refused, or expired. */
const closedAs = computed(() => {
  const status = loaded.value?.status
  if (!status || status === 'pending') return null
  return (
    {
      approved: 'Déjà acceptée.',
      executed: 'Déjà appliquée.',
      rejected: 'Refusée.',
      expired: 'Expirée : la maison a changé depuis.',
      failed: "L'application a échoué.",
    } as Record<string, string>
  )[status] ?? null
})

async function apply(ids: string[]) {
  if (!loaded.value) return
  error.value = null
  const include = ids.map(Number).filter(Number.isInteger)
  const result = await hubFetch<{ ok: boolean; ran: number }>(`/agent/proposals/${loaded.value.id}/approve`, {
    method: 'POST',
    body: { include },
  }).catch(() => ({ ok: false, ran: 0 }))
  if (!result.ok) {
    error.value = "Rien n'a pu être appliqué. Les lignes sont de nouveau modifiables."
    attempt.value += 1
    emit('decided', 'failed', 0)
    return
  }
  outcome.value = { kind: 'approved', ran: result.ran }
  emit('decided', 'approved', result.ran)
  void refresh()
}

async function discard() {
  if (!loaded.value) return
  const result = await hubFetch<{ ok: boolean }>(`/agent/proposals/${loaded.value.id}/reject`, { method: 'POST' }).catch(() => ({ ok: false }))
  outcome.value = { kind: result.ok ? 'rejected' : 'failed', ran: 0 }
  emit('decided', result.ok ? 'rejected' : 'failed', 0)
}
</script>

<template>
  <div class="space-y-2">
    <p v-if="error && !loaded" class="text-[12px] text-error">{{ error }}</p>

    <template v-else-if="loaded">
      <div class="flex flex-wrap items-center gap-1.5" :class="compact ? '' : 'px-0.5'">
        <AiValuePill :tone="RISK[loaded.risk]?.tone ?? 'neutral'">{{ RISK[loaded.risk]?.label ?? loaded.risk }}</AiValuePill>
        <span class="min-w-0 flex-1 text-[12.5px] text-ink-2">{{ loaded.reason }}</span>
      </div>

      <p v-if="closedAs" class="text-[12px] text-ink-3">{{ closedAs }}</p>
      <AiDiffTable
        v-else-if="rows.length > 0"
        :key="`${loaded.id}-${attempt}`"
        :rows="rows"
        :labels="{ title: loaded.summary, itemHeader: 'Appareil', categoryHeader: 'Pièce', changeHeader: 'Changement', discard: 'Refuser', discarded: 'Proposition refusée' }"
        @apply="apply"
        @discard="discard"
      />

      <p v-if="error" class="text-[12px] text-error">{{ error }}</p>
      <p v-else-if="outcome?.kind === 'approved'" class="text-[12px] text-ink-3">
        {{ outcome.ran }} action{{ outcome.ran > 1 ? 's' : '' }} lancée{{ outcome.ran > 1 ? 's' : '' }}.
      </p>
      <p v-else-if="outcome?.kind === 'failed'" class="text-[12px] text-error">Le refus n'a pas été enregistré.</p>
    </template>

    <div v-else class="h-24 animate-pulse rounded-[12px] bg-field" />
  </div>
</template>
