<script setup lang="ts">
/**
 * CHAT - the compact assistant panel for the side dock (Beautiful UI, source 06).
 *
 * Tabs switch context, the header carries new-conversation / history / more actions, and the
 * thread mixes user bubbles with agent tool-step sections. A section's `resolving` flag drives
 * a real CSS transition (dimmed, blurred, slightly scaled down while finalizing, settling to
 * full opacity once it flips false); the entrance itself (a new bubble or section arriving)
 * plays the shared `fade-up` keyframe once, the first time Vue mounts that entry's node - it
 * never replays for entries already on screen, since they keep the same DOM node across
 * re-renders (keyed by id). The scripted "sent -> reply1 -> reply2 resolving -> done" sequence
 * from the source lives in the demo, which pushes and updates `thread` entries over time; this
 * component only reacts to whatever `thread` it is given.
 *
 * Slots, for a host with richer content than tool-step sections: `#thread` replaces the
 * thread (the scroll region stays), `#composer` replaces the input row.
 */
const props = withDefaults(
  defineProps<{
    /** header chips for switching context */
    tabs?: string[]
    thread?: ChatEntry[]
    /** disables sending a further message while the agent is still working */
    busy?: boolean
    placeholder?: string
    /** fill the parent (the side dock) instead of the gallery's fixed card */
    fill?: boolean
  }>(),
  {
    tabs: () => [],
    thread: () => [],
    busy: false,
    placeholder: undefined,
    fill: false,
  }
)

const emit = defineEmits<{
  newChat: []
  history: []
  more: []
  send: [text: string]
}>()

const tab = defineModel<string>('tab', { default: '' })
onMounted(() => {
  if (!tab.value && props.tabs.length > 0) tab.value = props.tabs[0]!
})

const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const threadRef = ref<HTMLElement | null>(null)

const canSend = computed(() => draft.value.trim().length > 0 && !props.busy)

function send() {
  if (!canSend.value) return
  emit('send', draft.value.trim())
  draft.value = ''
}

/* scrolls to the newest entry whenever one arrives */
watch(
  () => props.thread.length,
  async () => {
    await nextTick()
    const el = threadRef.value
    if (el) el.scrollTop = el.scrollHeight
  },
  { immediate: true }
)
</script>

<template>
  <div
    class="flex w-full flex-col overflow-hidden bg-surface"
    :class="fill ? 'h-full min-h-0' : 'h-[288px] max-w-95 self-start rounded-[14px] shadow-card'"
  >
    <!-- header - tabs + actions -->
    <div class="flex shrink-0 items-center justify-between border-b border-line p-1.5">
      <div class="flex items-center">
        <button
          v-for="item in tabs"
          :key="item"
          type="button"
          :aria-pressed="tab === item"
          class="rounded-[6px] px-2 py-[3px] text-[13px] text-ink transition-[background-color,opacity] duration-100"
          :class="tab === item ? 'bg-field' : 'opacity-50 hover:opacity-75'"
          @click="tab = item"
        >
          {{ item }}
        </button>
      </div>
      <div class="flex items-center gap-1">
        <button
          type="button"
          aria-label="Nouvelle conversation"
          class="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink-2"
          @click="emit('newChat')"
        >
          <Icon name="ph:plus" class="size-[15px]" />
        </button>
        <button
          type="button"
          aria-label="Historique"
          class="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink-2"
          @click="emit('history')"
        >
          <Icon name="ph:clock-counter-clockwise" class="size-[15px]" />
        </button>
        <button
          type="button"
          aria-label="Plus d'options"
          class="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink-2"
          @click="emit('more')"
        >
          <Icon name="ph:dots-three" class="size-[15px]" />
        </button>
      </div>
    </div>

    <!-- conversation - fixed region so the card never changes shape -->
    <div ref="threadRef" class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 pt-2.5 pb-1">
      <slot name="thread">
      <p v-if="thread.length === 0" class="py-6 text-center text-[12px] text-ink-3">Aucun message pour le moment.</p>
      <template v-for="entry in thread" :key="entry.id">
        <!-- user bubble - right aligned, soft block -->
        <div v-if="entry.kind === 'user'" class="flex justify-end pl-14">
          <div
            class="rounded-xl bg-field px-3 py-1.5 text-[13px] leading-[1.4] text-ink"
            style="animation: fade-up 300ms cubic-bezier(0.23, 1, 0.32, 1) both"
          >
            {{ entry.text }}
          </div>
        </div>

        <!-- agent tool-step section -->
        <div
          v-else
          class="flex w-full flex-col gap-1.5 transition-[opacity,filter,transform] duration-400"
          :style="{
            opacity: entry.resolving ? 0.55 : 1,
            filter: entry.resolving ? 'blur(0.5px)' : 'blur(0)',
            transform: entry.resolving ? 'scale(0.985)' : 'scale(1)',
            transformOrigin: 'top left',
            transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
            animation: 'fade-up 400ms cubic-bezier(0.23,1,0.32,1) both',
          }"
        >
          <div class="flex items-center gap-1 text-[12px] leading-[1.3]">
            <span class="font-medium text-ink">{{ entry.label }}</span>
            <span v-if="entry.sub" class="text-ink-2">· {{ entry.sub }}</span>
            <span v-if="entry.time" class="text-ink">pendant {{ entry.time }}</span>
          </div>
          <p class="text-[13px] leading-normal text-ink">{{ entry.body }}</p>
        </div>
      </template>
      </slot>
    </div>

    <!-- composer -->
    <div class="mt-auto shrink-0 p-1.5">
      <slot name="composer">
      <div
        role="presentation"
        class="flex cursor-text flex-col gap-2 rounded-control border border-line bg-field p-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.035)] transition-[border-color,box-shadow] duration-150 focus-within:border-line-strong focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.025)]"
        @click="inputRef?.focus()"
      >
        <input
          ref="inputRef"
          :value="draft"
          :placeholder="placeholder ?? CHAT_DEFAULT_PLACEHOLDER"
          aria-label="Message"
          class="min-h-4.5 bg-transparent text-[13px] leading-[1.4] text-ink outline-none placeholder:text-ink-3"
          @input="draft = ($event.target as HTMLInputElement).value"
          @keydown.enter="send"
        />
        <div class="flex items-center justify-end">
          <button
            type="button"
            aria-label="Envoyer"
            :disabled="!canSend"
            class="flex size-7 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.96]"
            :style="{ background: canSend ? 'var(--ink)' : 'var(--line-strong)', color: canSend ? 'var(--surface)' : 'var(--ink-2)' }"
            @click="send"
          >
            <Icon name="ph:arrow-up" class="size-4" />
          </button>
        </div>
      </div>
      </slot>
    </div>
  </div>
</template>
