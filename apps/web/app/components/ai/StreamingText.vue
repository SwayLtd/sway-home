<script setup lang="ts">
/**
 * STREAMING TEXT - an assistant answer that resolves word by word (Beautiful UI).
 *
 * `text` carries the finished answer, with optional [[ph:icon|text|tone]] chips (see
 * @sway-home/shared/rich_text) and [[cite:<sourceId>]] markers placed by the caller. When
 * `animate` is true (a fresh answer) the words resolve out of a blur one at a time, the way
 * the source streams tokens in; history renders settled at once (`animate` false). Actions
 * (copier, réessayer, feedback) and the follow-up prompts only become usable once the reveal
 * is done. A message keeps one instance for its whole life (`:key="message.id"`), so the
 * reveal never replays once shown.
 *
 * The default slot (slot prop `done`) sits between the text and the actions: the cards an
 * answer carries belong to it, and the follow-ups stay last.
 */
import type { ChipTone } from '@sway-home/shared/rich_text'
import type { StreamingTextFeedback, StreamingTextFollowUp, StreamingTextLabels, StreamingTextSource } from '~/utils/aiStreamingText'

const props = withDefaults(
  defineProps<{
    /** The answer text; empty renders nothing. */
    text?: string
    /** Sources available for [[cite:id]] markers and the sources list. */
    sources?: StreamingTextSource[]
    followUps?: StreamingTextFollowUp[]
    labels?: Partial<StreamingTextLabels>
    /** Play the word-by-word reveal; off for history, which renders settled at once. */
    animate?: boolean
    /** Fill the parent width instead of the fixed measure used in the gallery. */
    fill?: boolean
    /** Where citations go when the text has no [[cite:id]] marker (see streamingTextTokenize). */
    autoCite?: 'first' | 'mentions' | 'none'
    /** The answer's type size; the full-screen assistant reads larger than the dock. */
    textClass?: string
    /** Hide the retry action, for an answer that cannot be asked again (an alert). */
    noRetry?: boolean
    /** Hide the thumbs, for a message nobody keeps a rating of (a local note, an alert). */
    noFeedback?: boolean
  }>(),
  { text: '', sources: () => [], followUps: () => [], animate: true, fill: false, autoCite: 'first', textClass: 'text-[13px]', noRetry: false, noFeedback: false }
)

const emit = defineEmits<{
  followUp: [followUp: StreamingTextFollowUp]
  copy: [text: string]
  retry: []
  done: []
}>()

const feedback = defineModel<StreamingTextFeedback>('feedback', { default: null })

const resolvedLabels = computed<StreamingTextLabels>(() => ({
  followUps: 'Suggestions',
  ...props.labels,
}))

/* One token the template can render without re-resolving its citation on every access. */
type ResolvedToken =
  | { kind: 'word'; text: string }
  | { kind: 'break'; paragraph: boolean }
  | { kind: 'chip'; icon: string; text: string; tone: ChipTone }
  | { kind: 'cite'; source: StreamingTextSource }

const tokens = computed(() => streamingTextTokenize(props.text, props.sources, { autoCite: props.autoCite }))
const shown = ref(props.animate ? 0 : tokens.value.length)
const done = computed(() => shown.value >= tokens.value.length)
const visibleTokens = computed<ResolvedToken[]>(() => {
  const resolved: ResolvedToken[] = []
  for (const token of tokens.value.slice(0, shown.value)) {
    if (token.kind !== 'cite') {
      resolved.push(token)
      continue
    }
    const source = props.sources.find((candidate) => candidate.id === token.sourceId)
    if (source) resolved.push({ kind: 'cite', source })
  }
  return resolved
})

const sourcesOpen = ref(false)
const copied = ref(false)

let tick: ReturnType<typeof setTimeout> | null = null
let copiedTimer: ReturnType<typeof setTimeout> | null = null

function clearTick() {
  if (tick) {
    clearTimeout(tick)
    tick = null
  }
}

function step() {
  clearTick()
  tick = setTimeout(() => {
    shown.value = Math.min(shown.value + 1, tokens.value.length)
    if (shown.value < tokens.value.length) step()
  }, STREAMING_TEXT_WORD_MS)
}

/* A fresh instance starts its reveal from zero; history (`animate` false) renders fully
   resolved with no timer at all. The caller keys a settled message by id, so this only ever
   restarts a genuinely new answer, never one already shown. */
watch(
  () => [props.text, props.animate] as const,
  () => {
    clearTick()
    sourcesOpen.value = false
    if (!props.animate) {
      shown.value = tokens.value.length
      return
    }
    shown.value = 0
    if (tokens.value.length > 0) step()
  },
  { immediate: true }
)

watch(done, (value) => {
  if (value) emit('done')
})

onBeforeUnmount(() => {
  clearTick()
  if (copiedTimer) clearTimeout(copiedTimer)
})

function isInternalHref(href: string): boolean {
  return href.startsWith('/')
}

/** `fallback` is the tag used for a source with no href: a button for the inline citation
 *  (it opens the sources list), a plain div for a row already inside that list. */
function sourceTag(source: StreamingTextSource, fallback: 'button' | 'div' = 'div'): string {
  if (!source.href) return fallback
  return isInternalHref(source.href) ? 'NuxtLink' : 'a'
}

function sourceAttrs(source: StreamingTextSource): Record<string, unknown> {
  if (!source.href) return { type: 'button' }
  return isInternalHref(source.href) ? { to: source.href } : { href: source.href, target: '_blank', rel: 'noreferrer' }
}

function sourceTitle(source: StreamingTextSource): string {
  return source.subtitle ? `${source.title} - ${source.subtitle}` : source.title
}

function onCiteClick(source: StreamingTextSource) {
  if (!source.href) sourcesOpen.value = true
}

async function onCopy() {
  const plain = streamingTextPlainText(props.text)
  if (import.meta.client && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(plain)
    } catch {
      // Clipboard permission denied: still report the text to the parent below.
    }
  }
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = false), 1400)
  emit('copy', plain)
}

function toggleFeedback(value: 'up' | 'down') {
  feedback.value = feedback.value === value ? null : value
}
</script>

<template>
  <div :class="fill ? 'w-full' : 'w-full max-w-95 min-h-[15.5rem]'">
    <p class="leading-relaxed text-ink" :class="textClass">
      <template v-for="(token, index) in visibleTokens" :key="index">
        <!-- The space rides in the interpolation: a whitespace-only last child is dropped by
             the template compiler, which glued every word to the next. -->
        <span v-if="token.kind === 'word'" :class="animate ? 'ai-streaming-word' : undefined">{{ `${token.text} ` }}</span>

        <template v-else-if="token.kind === 'break'">
          <br />
          <span v-if="token.paragraph" aria-hidden="true" class="block h-2" />
        </template>

        <AiValuePill v-else-if="token.kind === 'chip'" :tone="STREAMING_TEXT_CHIP_TONE[token.tone]" style="animation: pop-in 200ms cubic-bezier(0.23, 1, 0.32, 1) both">
          <span class="inline-flex items-center gap-1">
            <Icon :name="token.icon" class="size-[0.9em] shrink-0 opacity-70" />{{ token.text }}
          </span>
        </AiValuePill>

        <component
          :is="sourceTag(token.source, 'button')"
          v-else
          v-bind="sourceAttrs(token.source)"
          :title="sourceTitle(token.source)"
          class="ml-0 mr-1 inline-flex h-4.5 translate-y-[-1px] items-center gap-1 rounded-[5px] bg-inset pr-[3px] pl-[3px] align-middle font-mono text-[10.5px] text-ink-2 shadow-hairline transition-colors duration-150 hover:bg-hover hover:text-ink"
          style="animation: pop-in 250ms cubic-bezier(0.23, 1, 0.32, 1) both"
          @click="onCiteClick(token.source)"
        >
          <img v-if="token.source.image" :src="token.source.image" alt="" class="source-avatar size-3 rounded-[3px]" />
          <Icon v-else :name="streamingTextSourceIcon(token.source)" class="size-3 shrink-0" />
          <span>{{ token.source.subtitle ?? token.source.title }}</span>
        </component>
      </template>
      <span v-if="!done && tokens.length > 0" aria-hidden="true" class="ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 rounded-full bg-ink" style="animation: fade-in 150ms ease-out both" />
    </p>

    <!-- What the answer carries - its cards, its questions, what it proposes - after the words
         and before the actions, so the follow-ups stay the last thing to read. -->
    <div v-if="$slots.default" class="mt-2.5 space-y-2.5">
      <slot :done="done" />
    </div>

    <!-- action icons: copy, retry, feedback, then the sources toggle -->
    <div class="mt-2 flex items-center gap-0.5 transition-opacity duration-400" :class="done ? 'opacity-100' : 'pointer-events-none opacity-0'">
      <button type="button" aria-label="Copier" class="flex size-6 items-center justify-center rounded-chip text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2" @click="onCopy">
        <Icon :name="copied ? 'ph:check' : 'ph:copy'" class="size-[15px]" />
      </button>
      <button v-if="!noRetry" type="button" aria-label="Réessayer" class="flex size-6 items-center justify-center rounded-chip text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2" @click="emit('retry')">
        <Icon name="ph:arrow-counter-clockwise" class="size-[15px]" />
      </button>
      <button
        v-if="!noFeedback"
        type="button"
        aria-label="Utile"
        :aria-pressed="feedback === 'up'"
        class="flex size-6 items-center justify-center rounded-chip transition-colors duration-100"
        :class="feedback === 'up' ? 'bg-bui-accent-tint text-bui-accent-ink' : 'text-ink-3 hover:bg-hover-2 hover:text-ink-2'"
        @click="toggleFeedback('up')"
      >
        <Icon :name="feedback === 'up' ? 'ph:thumbs-up-fill' : 'ph:thumbs-up'" class="size-[15px]" />
      </button>
      <button
        v-if="!noFeedback"
        type="button"
        aria-label="Pas utile"
        :aria-pressed="feedback === 'down'"
        class="flex size-6 items-center justify-center rounded-chip transition-colors duration-100"
        :class="feedback === 'down' ? 'bg-bui-accent-tint text-bui-accent-ink' : 'text-ink-3 hover:bg-hover-2 hover:text-ink-2'"
        @click="toggleFeedback('down')"
      >
        <Icon :name="feedback === 'down' ? 'ph:thumbs-down-fill' : 'ph:thumbs-down'" class="size-[15px]" />
      </button>

      <button
        v-if="sources.length"
        type="button"
        :aria-expanded="sourcesOpen"
        class="ml-1.5 flex items-center gap-1.5 rounded-chip px-1 py-0.5 text-left transition-colors duration-150 hover:bg-hover"
        @click="sourcesOpen = !sourcesOpen"
      >
        <span class="flex -space-x-1">
          <span v-for="source in sources" :key="source.id" class="source-avatar flex size-3.5 items-center justify-center overflow-hidden rounded-full bg-surface shadow-[0_0_0_1.5px_var(--canvas)]">
            <img v-if="source.image" :src="source.image" alt="" class="size-full object-cover" />
            <Icon v-else :name="streamingTextSourceIcon(source)" class="size-2.5 text-ink-3" />
          </span>
        </span>
        <span class="text-[12px] text-ink-2">{{ streamingTextSourcesLabel(sources.length) }}</span>
      </button>
    </div>

    <!-- expanded sources list -->
    <div
      v-if="sources.length"
      class="grid overflow-hidden transition-[grid-template-rows,opacity] duration-300 ease-out-strong"
      :style="{ gridTemplateRows: done && sourcesOpen ? '1fr' : '0fr', opacity: done && sourcesOpen ? 1 : 0 }"
    >
      <div class="overflow-hidden">
        <div class="mt-1.5 flex flex-col rounded-card bg-inset p-1 shadow-hairline">
          <component
            :is="sourceTag(source)"
            v-for="source in sources"
            :key="source.id"
            v-bind="sourceAttrs(source)"
            class="flex items-center gap-2 rounded-chip px-1.5 py-1 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
          >
            <img v-if="source.image" :src="source.image" alt="" class="source-avatar size-4 rounded-[4px]" />
            <Icon v-else :name="streamingTextSourceIcon(source)" class="size-4 shrink-0" />
            <span class="animated-underline">{{ source.title }}</span>
            <span v-if="source.subtitle" class="ml-auto font-mono text-[10.5px] text-ink-3">{{ source.subtitle }}</span>
          </component>
        </div>
      </div>
    </div>

    <!-- follow-ups -->
    <div v-if="followUps.length" class="mt-2.5 transition-opacity duration-400" :class="done ? 'opacity-100' : 'pointer-events-none opacity-0'">
      <p class="text-[12px] font-medium text-ink-2">{{ resolvedLabels.followUps }}</p>
      <div class="mt-0.5 flex flex-col">
        <button
          v-for="(item, index) in followUps"
          :key="item.text"
          type="button"
          class="-mx-1.5 flex items-center gap-2 rounded-[7px] border-b border-line px-1.5 py-1.5 text-left text-[12.5px] text-ink transition-colors duration-100 hover:bg-hover-2"
          :style="done ? { animation: `fade-up 350ms cubic-bezier(0.23, 1, 0.32, 1) ${index * 90}ms both` } : { opacity: 0 }"
          @click="emit('followUp', item)"
        >
          <Icon :name="item.icon ?? 'ph:arrow-bend-down-left'" class="size-[11px] shrink-0 text-ink-3" />
          {{ item.text }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Words resolve out of a soft blur instead of just popping in; ai.css has no keyframe for
   this shade of entrance yet, so it lives here, local to this component. */
@keyframes ai-streaming-word-in {
  from {
    opacity: 0;
    filter: blur(6px);
  }
  to {
    opacity: 1;
    filter: blur(0);
  }
}
.ai-streaming-word {
  animation: ai-streaming-word-in 260ms var(--ease-out-strong) both;
}
@media (prefers-reduced-motion: reduce) {
  .ai-streaming-word {
    animation: none;
  }
}
</style>
