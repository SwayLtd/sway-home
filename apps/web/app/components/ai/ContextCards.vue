<script setup lang="ts">
/**
 * CONTEXT CARDS - what the assistant read before it answered (Beautiful UI).
 *
 * Memories, device states and routines the run cited, each entering once (fade-up, staggered
 * by arrival order) and then staying put as the answer keeps citing more of them - a card
 * already on screen never replays its entrance or its footer chip when props change again.
 * No visual variants; `variant` is only accepted for gallery/registry parity.
 */
import type { ContextCardsItem, ContextCardsLabels } from '~/utils/aiContextCards'

const props = withDefaults(
  defineProps<{
    items?: ContextCardsItem[]
    labels?: Partial<ContextCardsLabels>
    variant?: string
  }>(),
  { items: () => [] }
)

const emit = defineEmits<{
  open: [item: ContextCardsItem]
}>()

const resolvedLabels = computed<ContextCardsLabels>(() => ({
  header: 'Contexte utilisé',
  ...props.labels,
}))

/* The footer chip pops in 700ms after its own card first appears, staggered like the source;
   an id already seen keeps its chip shown with no further delay or replay. */
const seenIds = new Set<string>()
const shownChips = ref<Set<string>>(new Set())
let timers: ReturnType<typeof setTimeout>[] = []

function clearTimers() {
  for (const timer of timers) clearTimeout(timer)
  timers = []
}

watch(
  () => props.items.map((item) => item.id),
  (ids) => {
    const fresh = ids.filter((id) => !seenIds.has(id))
    fresh.forEach((id, index) => {
      seenIds.add(id)
      timers.push(
        setTimeout(() => {
          shownChips.value = new Set(shownChips.value).add(id)
        }, 700 + index * 80)
      )
    })
  },
  { immediate: true }
)

onBeforeUnmount(clearTimers)

function isInternalHref(href: string): boolean {
  return href.startsWith('/')
}

function chipTag(item: ContextCardsItem): string {
  if (!item.href) return 'span'
  return isInternalHref(item.href) ? 'NuxtLink' : 'a'
}

function chipAttrs(item: ContextCardsItem): Record<string, unknown> {
  if (!item.href) return {}
  return isInternalHref(item.href) ? { to: item.href } : { href: item.href, target: '_blank', rel: 'noreferrer' }
}
</script>

<template>
  <div class="flex w-full max-w-95 flex-col gap-2">
    <div class="flex items-center gap-2 px-0.5" style="animation: fade-in 400ms ease-out both">
      <span class="text-[13px] font-semibold text-ink">{{ resolvedLabels.header }}</span>
      <span class="inline-flex h-5 items-center rounded-md bg-inset px-1.5 text-[11.5px] font-medium text-ink-2 shadow-hairline tabular-nums">{{ items.length }}</span>
    </div>

    <div
      v-for="(item, index) in items"
      :key="item.id"
      class="overflow-hidden rounded-card bg-surface shadow-card"
      :style="{ animation: `fade-up 400ms cubic-bezier(0.23, 1, 0.32, 1) ${index * 100}ms both` }"
    >
      <div class="primitive-card-bar flex items-center gap-2.5 border-b border-line">
        <span class="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink">
          <Icon :name="CONTEXT_CARDS_KIND[item.kind].icon" class="size-[11px] shrink-0" />
          <span class="truncate">{{ item.title }}</span>
        </span>
        <span v-if="contextCardsTrailing(item)" class="ml-auto shrink-0 text-[12px] text-ink-3 tabular-nums">{{ contextCardsTrailing(item) }}</span>
      </div>
      <p class="px-3 pt-2 pb-1 text-[12.5px] leading-relaxed text-ink-2">{{ item.excerpt }}</p>
      <div class="px-3 pb-3">
        <component
          :is="chipTag(item)"
          v-bind="chipAttrs(item)"
          class="inline-flex h-6 items-center gap-1.5 rounded-full bg-inset px-2 text-[12px] font-medium text-ink-2 shadow-btn transition-[opacity,transform,background-color] duration-300 hover:bg-hover"
          :style="{
            opacity: shownChips.has(item.id) ? 1 : 0,
            transform: shownChips.has(item.id) ? 'scale(1)' : 'scale(0.95)',
            transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
          }"
          @click="item.href && emit('open', item)"
        >
          <span class="flex size-3.5 items-center justify-center rounded-[4px] text-white" :class="CONTEXT_CARDS_KIND[item.kind].tone">
            <Icon :name="CONTEXT_CARDS_KIND[item.kind].icon" class="size-[8px]" />
          </span>
          {{ CONTEXT_CARDS_KIND[item.kind].label }}
          <Icon v-if="item.href" name="ph:arrow-up-right" class="size-[9px]" />
        </component>
      </div>
    </div>
  </div>
</template>
