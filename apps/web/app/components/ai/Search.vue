<script setup lang="ts">
/**
 * SEARCH - the Cmd+K palette (Beautiful UI's SearchList, source 14).
 *
 * A field, a clear action, and grouped results with the same gliding hover highlight as the
 * model picker (AiGlideMenu). Arrow keys move a keyboard-active row (an instant highlight,
 * layered under the glide) and wrap around; Enter picks it; hovering a row keeps the two in
 * sync. By default the component filters `items` itself (accent-insensitive, against
 * `v-model` query); pass `:filter="false"` when the parent already filtered them - the hub's
 * own search, for instance.
 */
import type { ComponentPublicInstance } from 'vue'

const props = withDefaults(
  defineProps<{
    items?: SearchItem[]
    /** false when `items` is already filtered by the parent */
    filter?: boolean
    placeholder?: string
    ariaLabel?: string
    emptyTitle?: string
    emptyHint?: string
  }>(),
  {
    items: () => [],
    filter: true,
    placeholder: 'Rechercher...',
    ariaLabel: 'Recherche',
    emptyTitle: 'Aucun résultat trouvé',
    emptyHint: 'Essayez une recherche différente',
  }
)

const emit = defineEmits<{ select: [item: SearchItem] }>()

const query = defineModel<string>({ default: '' })

const inputRef = ref<HTMLInputElement | null>(null)
const rowRefs = ref<(HTMLButtonElement | null)[]>([])
function setRowRef(el: Element | ComponentPublicInstance | null, index: number) {
  rowRefs.value[index] = el as HTMLButtonElement | null
}

const results = computed(() => (props.filter ? props.items.filter((item) => searchMatches(item.label, query.value)) : props.items))
const groups = computed(() => searchGroupItems(results.value))
/* each group's items paired with their index in the flat result list, for keyboard nav */
const indexed = computed(() => {
  let i = 0
  return groups.value.map((group) => ({
    key: group.key,
    items: group.items.map((item) => ({ item, index: i++ })),
  }))
})
const flatCount = computed(() => results.value.length)
// only flags "no results" past a couple of keystrokes, so a single character does not flash
// an empty state while the person is still typing toward a real match
const empty = computed(() => query.value.trim().length > 2 && results.value.length === 0)

const active = ref(0)
watch(results, () => {
  active.value = 0
})
watch(active, (index) => {
  nextTick(() => rowRefs.value[index]?.scrollIntoView({ block: 'nearest' }))
})

function pick(item: SearchItem) {
  emit('select', item)
}

function onKeydown(event: KeyboardEvent) {
  if (flatCount.value === 0) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : flatCount.value - 1
    active.value = (active.value + delta) % flatCount.value
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const item = results.value[active.value]
    if (item) pick(item)
  }
}

defineExpose({ focus: () => inputRef.value?.focus() })
</script>

<template>
  <div class="flex w-full flex-col items-stretch">
    <div class="w-full self-start overflow-hidden rounded-card bg-surface shadow-raised">
      <!-- input row -->
      <div class="flex h-10 items-center gap-2 border-b border-line px-3 transition-colors duration-100 hover:bg-hover">
        <Icon name="ph:magnifying-glass" class="size-3.5 shrink-0 text-ink-3" />
        <input
          ref="inputRef"
          :value="query"
          :placeholder="placeholder"
          :aria-label="ariaLabel"
          class="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          @input="query = ($event.target as HTMLInputElement).value"
          @keydown="onKeydown"
        />
        <button
          v-if="query"
          type="button"
          aria-label="Effacer la recherche"
          class="flex size-6 items-center justify-center rounded-full text-ink-3 transition-colors duration-100 hover:bg-line/70 hover:text-ink"
          style="animation: fade-in 150ms ease-out both"
          @click="query = ''"
        >
          <Icon name="ph:x" class="size-[11px]" />
        </button>
      </div>

      <!-- results / empty state -->
      <div v-if="empty" class="flex flex-col items-center justify-center gap-1 px-4 py-8" style="animation: fade-in 250ms ease-out both">
        <span class="mb-1.5 flex size-8 items-center justify-center rounded-control bg-inset text-ink-3 shadow-hairline">
          <Icon name="ph:magnifying-glass" class="size-[15px]" />
        </span>
        <span class="text-[13px] font-medium text-ink">{{ emptyTitle }}</span>
        <span class="text-[12px] text-ink-3">{{ emptyHint }}</span>
      </div>

      <div v-else class="p-1">
        <AiGlideMenu highlight-class="inset-x-0 rounded-[6px] bg-hover">
          <div v-for="group in indexed" :key="group.key || '__ungrouped'">
            <p v-if="group.key" class="px-2 pt-2 pb-1 text-[10.5px] font-medium uppercase tracking-wide text-ink-3 first:pt-1">
              {{ group.key }}
            </p>
            <button
              v-for="entry in group.items"
              :key="entry.item.id"
              :ref="(el) => setRowRef(el, entry.index)"
              data-menu-row
              type="button"
              class="relative z-10 flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-ink"
              :class="entry.index === active ? 'bg-hover' : ''"
              style="animation: fade-in 200ms ease-out both"
              @mouseenter="active = entry.index"
              @click="pick(entry.item)"
            >
              <Icon v-if="entry.item.icon" :name="entry.item.icon" class="size-4 shrink-0 text-ink-2" />
              <span class="min-w-0 flex-1 truncate">{{ entry.item.label }}</span>
              <span v-if="entry.item.hint" class="shrink-0 truncate text-[12px] text-ink-3">{{ entry.item.hint }}</span>
              <span v-if="entry.item.shortcut" class="shrink-0 text-[11px] text-ink-3">{{ entry.item.shortcut }}</span>
            </button>
          </div>
        </AiGlideMenu>
      </div>
    </div>
  </div>
</template>
