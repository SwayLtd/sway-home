<script setup lang="ts">
/**
 * RECOMMENDATION CARD - a routine suggestion with alternatives (Beautiful UI).
 *
 * The card holds its shape while the active option's title and body cross-fade in. Pressing
 * "Alternatives" opens a drawer listing the other options; picking one promotes it to the
 * recommendation (the drawer stays open, now offering the one it just replaced). The primary
 * action confirms. `variant` is accepted for gallery/registry parity; this card has none.
 */
import { parseRichText } from '@sway-home/shared/rich_text'
import type { RecommendationCardLabels, RecommendationCardOption } from '~/utils/aiRecommendationCard'

const props = withDefaults(
  defineProps<{
    options?: RecommendationCardOption[]
    labels?: Partial<RecommendationCardLabels>
    variant?: string
  }>(),
  { options: () => [] }
)

const emit = defineEmits<{
  confirm: [option: RecommendationCardOption]
  dismiss: []
  select: [option: RecommendationCardOption]
}>()

const selected = defineModel<string | undefined>('selected', { default: undefined })

const resolvedLabels = computed<RecommendationCardLabels>(() => ({ ...RECOMMENDATION_CARD_DEFAULT_LABELS, ...props.labels }))

const active = computed(() => props.options.find((option) => option.id === selected.value) ?? props.options[0])
const others = computed(() => props.options.filter((option) => option.id !== active.value?.id))

const open = ref(false)
const accepted = ref(false)

/* Keep the v-model honest: if the option set changes under it (a fresh recommendation, a
   different id) fall back to the first option rather than point at one that no longer
   exists, and drop the previous option's "Accepted" state along with it. */
watch(
  () => props.options,
  () => {
    if (!props.options.some((option) => option.id === selected.value)) {
      selected.value = props.options[0]?.id
      accepted.value = false
    }
  },
  { immediate: true }
)

function pick(option: RecommendationCardOption) {
  selected.value = option.id
  accepted.value = false
  emit('select', option)
}

function confirmActive() {
  if (!active.value) return
  accepted.value = true
  emit('confirm', active.value)
}
</script>

<template>
  <div v-if="active" class="w-full max-w-95 overflow-hidden rounded-card bg-surface shadow-card">
    <div class="primitive-card-pad">
      <div class="flex items-start justify-between gap-2">
        <span :key="`${active.id}-title`" class="text-[14px] font-medium text-ink" style="animation: fade-in 180ms ease-out both">{{ active.title }}</span>
        <button
          type="button"
          :aria-label="resolvedLabels.dismiss"
          class="-mt-1 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-chip text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2"
          @click="emit('dismiss')"
        >
          <Icon name="ph:x" class="size-3.5" />
        </button>
      </div>
      <p :key="`${active.id}-body`" class="mt-1.5 min-h-12 text-[13px] leading-relaxed text-ink-2" style="animation: fade-in 180ms ease-out both">
        <template v-if="typeof active.body === 'string'">
          <template v-for="(segment, index) in parseRichText(active.body)" :key="index">
            <template v-if="segment.kind === 'text'">{{ segment.text }}</template>
            <AiValuePill v-else :tone="RECOMMENDATION_CARD_CHIP_TONE[segment.tone]">
              <span class="inline-flex items-center gap-1">
                <Icon :name="segment.icon" class="size-[0.9em] shrink-0 opacity-70" />{{ segment.text }}
              </span>
            </AiValuePill>
          </template>
        </template>
        <template v-else>
          <template v-for="(segment, index) in active.body" :key="index">
            <template v-if="segment.kind === 'text'">{{ segment.text }}</template>
            <span v-else-if="segment.kind === 'emphasis'" class="font-medium text-ink">{{ segment.text }}</span>
            <AiEntityChip v-else-if="segment.kind === 'entity'" :name="segment.name" :color="segment.color" :monogram="segment.monogram" />
            <AiValuePill v-else :tone="segment.tone">{{ segment.text }}</AiValuePill>
          </template>
        </template>
      </p>
    </div>

    <!-- alternatives drawer: a distinctly new section of the card -->
    <div class="grid transition-[grid-template-rows,opacity] duration-300 ease-link" :style="{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }">
      <div class="overflow-hidden">
        <div class="border-t border-line bg-surface px-2 py-2">
          <p class="px-1.5 pb-1 text-[11px] font-medium text-ink-3">{{ resolvedLabels.otherOptions }}</p>
          <button
            v-for="option in others"
            :key="option.id"
            type="button"
            class="flex w-full items-center gap-2.5 rounded-control px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-hover"
            @click="pick(option)"
          >
            <span class="flex items-end gap-0.5">
              <span
                v-for="bar in 3"
                :key="bar"
                class="w-1 rounded-full transition-colors duration-300"
                :style="{ height: '10px', background: bar <= recommendationCardBars(option.confidence) ? recommendationCardTone(option.confidence) : 'var(--line-strong)' }"
              />
            </span>
            <span class="min-w-0 flex-1 truncate text-[12.5px] text-ink">{{ option.title }}</span>
            <span class="shrink-0 text-[11px] text-ink-3">{{ recommendationCardConfidenceLabel(option.confidence) }}</span>
          </button>
        </div>
      </div>
    </div>

    <div class="primitive-card-footer flex items-center justify-between gap-3 bg-surface">
      <span class="flex items-center gap-2">
        <span class="flex items-end gap-0.5">
          <span
            v-for="bar in 3"
            :key="bar"
            class="w-1 rounded-full transition-colors duration-300"
            :style="{ height: '10px', background: bar <= recommendationCardBars(active.confidence) ? recommendationCardTone(active.confidence) : 'var(--line-strong)' }"
          />
        </span>
        <span class="text-[12.5px] font-medium text-ink-2">{{ recommendationCardConfidenceLabel(active.confidence) }}</span>
      </span>

      <span class="-mr-0.5 flex items-center gap-2">
        <AiButton variant="secondary" size="sm" :aria-expanded="open" class="px-2.5 text-[12.5px]" @click="open = !open">{{ resolvedLabels.alternatives }}</AiButton>
        <AiButton :variant="accepted ? 'success' : (active.ctaVariant ?? 'primary')" size="sm" class="text-[12.5px]" @click="confirmActive">{{ accepted ? resolvedLabels.accepted : active.cta }}</AiButton>
      </span>
    </div>
  </div>
</template>
