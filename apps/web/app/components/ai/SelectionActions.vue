<script setup lang="ts">
/**
 * SELECTION ACTIONS - a contextual AI bar attached beneath selected text (Beautiful UI).
 *
 * The source demo fakes its "selection" with a permanently-styled span; this port wraps a
 * slot of real content and tracks the browser's live Selection API instead, so selecting any
 * text inside it shows the bar for real. Picking an action (or typing a free prompt) calls
 * `transform`, which the parent wires to the hub; the result streams into a small preview
 * above the bar (AiStreamText) while the bar itself shows the busy label (AiShimmer) and then
 * Garder / Ignorer / Réessayer. Buttons take mousedown before click, so pressing one does not
 * collapse the very selection it acts on.
 *
 * `variant` is accepted for gallery/registry parity; this bar has no visual variants.
 */
import type { SelectionActionsLabels, SelectionActionsSet } from '~/utils/aiSelectionActions'

const props = withDefaults(
  defineProps<{
    variant?: string
    actions?: SelectionActionsSet
    labels?: Partial<SelectionActionsLabels>
    /** Runs one action on the selected text; the parent calls the hub. A rejection with a
     *  message is shown in place of the result, with retry and discard only. */
    transform?: (text: string, actionId: string, prompt?: string) => Promise<string>
    /** Keep room under the content for the bar. Off when the host already has room around it. */
    reserve?: boolean
  }>(),
  { actions: () => SELECTION_ACTIONS_DEFAULT, reserve: true }
)

const emit = defineEmits<{
  /** Hand the selection to the main assistant instead of editing it in place. */
  ask: [text: string]
  accept: [payload: { original: string; result: string; actionId: string }]
}>()

const resolvedLabels = computed<SelectionActionsLabels>(() => ({ ...SELECTION_ACTIONS_DEFAULT_LABELS, ...props.labels }))
const allActions = computed(() => selectionActionsAll(props.actions))

type Mode = 'idle' | 'thinking' | 'streaming' | 'result'

const hostRef = ref<HTMLElement | null>(null)
const barRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)

const mode = ref<Mode>('idle')
const visible = ref(false)
const positioned = ref(false)
const anchor = ref({ x: 0, y: 0 })

const selectedText = ref('')
const actionId = ref('')
const lastPrompt = ref<string | undefined>(undefined)
const resultText = ref('')
/** Why the last action gave nothing: the hub's own words ("Il faut un modèle pour cela..."). */
const failure = ref<string | null>(null)

const expanded = ref(false)
const prompt = ref('')
const typingWidth = ref<number | null>(null)

const busy = computed(() => mode.value === 'thinking' || mode.value === 'streaming')
const hasPrompt = computed(() => prompt.value.trim().length > 0)
const busyLabel = computed(() => selectionActionsBusyLabel(props.actions, actionId.value))

/* ---- Live selection tracking: place() reads the real Range each time it is called, and
   both it and onSelectionChange stop touching the bar once an action is running, so a click
   that happens to nudge the browser's selection cannot reposition or hide a result mid-flow. */

let frame: number | null = null
function place() {
  if (mode.value !== 'idle') return
  if (frame !== null) cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    const host = hostRef.value
    const selection = document.getSelection()
    if (!host || !selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    const bounds = range.getBoundingClientRect()
    const lastLine = Array.from(range.getClientRects()).at(-1)
    if (!lastLine) return
    const hostBounds = host.getBoundingClientRect()
    const next = {
      x: Math.round(bounds.left - hostBounds.left + bounds.width / 2),
      y: Math.round(lastLine.bottom - hostBounds.top + 8),
    }
    if (anchor.value.x !== next.x || anchor.value.y !== next.y) anchor.value = next
    positioned.value = true
  })
}

function onSelectionChange() {
  if (mode.value !== 'idle') return
  const host = hostRef.value
  const selection = document.getSelection()
  if (!host || !selection || selection.isCollapsed || selection.rangeCount === 0) {
    visible.value = false
    positioned.value = false
    return
  }
  const text = selection.toString().trim()
  const anchorNode = selection.anchorNode
  const focusNode = selection.focusNode
  if (!text || !anchorNode || !focusNode || !host.contains(anchorNode) || !host.contains(focusNode)) {
    visible.value = false
    positioned.value = false
    return
  }
  selectedText.value = text
  visible.value = true
  place()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && visible.value) dismiss()
}

/* ---- Width morph: the pill's intrinsic width changes between idle, busy and result; animate
   from the last rendered width to the new one instead of snapping, exactly as the source
   does with the Web Animations API. */

let widthAnimation: Animation | null = null
let lastWidth = 0
let previousMode: Mode = 'idle'
let contentObserver: ResizeObserver | null = null
let hostObserver: ResizeObserver | null = null

function morphWidth() {
  const bar = barRef.value
  const content = contentRef.value
  if (!bar || !content) return
  const nextWidth = Math.ceil(content.getBoundingClientRect().width) + 8
  const previousWidth = lastWidth || Math.ceil(bar.getBoundingClientRect().width)

  if (previousMode !== mode.value && Math.abs(nextWidth - previousWidth) > 1) {
    widthAnimation?.cancel()
    widthAnimation = bar.animate([{ width: `${previousWidth}px` }, { width: `${nextWidth}px` }], { duration: 320, easing: 'cubic-bezier(0.23,1,0.32,1)' })
    widthAnimation.onfinish = () => {
      lastWidth = nextWidth
      widthAnimation = null
    }
  } else {
    lastWidth = nextWidth
  }
  previousMode = mode.value
}

watch(mode, () => nextTick(morphWidth))

onMounted(() => {
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', place)

  const host = hostRef.value
  if (host) {
    hostObserver = new ResizeObserver(place)
    hostObserver.observe(host)
  }
  const content = contentRef.value
  if (content) {
    contentObserver = new ResizeObserver(() => {
      if (widthAnimation?.playState === 'running') return
      lastWidth = Math.ceil(content.getBoundingClientRect().width) + 8
    })
    contentObserver.observe(content)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', onSelectionChange)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', place)
  hostObserver?.disconnect()
  contentObserver?.disconnect()
  if (frame !== null) cancelAnimationFrame(frame)
  widthAnimation?.cancel()
})

/* ---- Flow: idle -> thinking (awaiting transform) -> streaming (AiStreamText plays the
   result) -> result (Garder / Ignorer / Réessayer). */

function run(id: string, actionPrompt?: string) {
  const found = allActions.value.find((item) => item.id === id)
  if (found?.handoff) {
    emit('ask', selectedText.value)
    dismiss()
    return
  }
  if (!props.transform) return
  actionId.value = id
  lastPrompt.value = actionPrompt
  expanded.value = false
  mode.value = 'thinking'
  props.transform(selectedText.value, id, actionPrompt)
    .then((value) => {
      resultText.value = value
      mode.value = 'streaming'
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : ''
      if (!message) return reset()
      failure.value = message
      resultText.value = message
      mode.value = 'result'
    })
}

function onStreamDone() {
  mode.value = 'result'
}

/* Keep and Discard both return to idle, not to hidden: the native selection is still
   intact (buttons take mousedown before click, see above), so re-checking it here brings
   the idle bar straight back if it is - letting someone try a different action on the same
   text without selecting it again - and hides the bar only if it genuinely is not. */
function reset() {
  mode.value = 'idle'
  expanded.value = false
  prompt.value = ''
  typingWidth.value = null
  actionId.value = ''
  lastPrompt.value = undefined
  resultText.value = ''
  failure.value = null
  onSelectionChange()
}

/* A hard close: Escape and handing off to the assistant both drop the live selection too,
   so the bar cannot simply reappear underneath it a moment later. */
function dismiss() {
  reset()
  window.getSelection()?.removeAllRanges()
  visible.value = false
  positioned.value = false
}

function accept() {
  emit('accept', { original: selectedText.value, result: resultText.value, actionId: actionId.value })
  reset()
}

function retryAction() {
  failure.value = null
  run(actionId.value, lastPrompt.value)
}

function submitPrompt() {
  const value = prompt.value.trim()
  if (!value) return
  run('custom', value)
}

function onPromptInput(event: Event) {
  const next = (event.target as HTMLInputElement).value
  if (!prompt.value.trim() && next.trim()) typingWidth.value = Math.ceil(barRef.value?.getBoundingClientRect().width ?? 0)
  else if (!next.trim()) typingWidth.value = null
  prompt.value = next
}
</script>

<template>
  <div ref="hostRef" class="relative" :class="reserve ? 'pb-12' : ''">
    <slot />

    <!-- `inert` while hidden: an invisible bar must not take keyboard focus or reach a screen reader -->
    <div
      class="absolute top-0 left-0 z-10 flex flex-col items-center"
      :inert="!(visible && positioned)"
      :style="{
        transform: `translate3d(${anchor.x}px, ${anchor.y}px, 0) translateX(-50%)`,
        transition: 'transform 320ms cubic-bezier(0.77,0,0.175,1), opacity 180ms ease-out',
        opacity: visible && positioned ? 1 : 0,
        pointerEvents: visible && positioned ? 'auto' : 'none',
        willChange: 'transform',
      }"
    >
      <!-- the transformed text streams in here; the bar below keeps offering keep/discard/retry -->
      <div
        v-if="mode === 'streaming' || mode === 'result'"
        class="mb-1.5 max-w-[360px] rounded-card bg-surface p-2.5 text-[12.5px] leading-relaxed text-ink shadow-overlay"
        style="animation: fade-up 220ms cubic-bezier(0.23, 1, 0.32, 1) both"
      >
        <AiStreamText v-if="mode === 'streaming'" :text="resultText" @done="onStreamDone" />
        <span v-else :class="failure ? 'text-red' : ''">{{ resultText }}</span>
      </div>

      <!-- A 36px pill wraps 28px controls at a 4px inset. -->
      <div
        ref="barRef"
        class="flex h-9 w-fit max-w-[calc(100vw-48px)] items-center justify-center gap-0.5 overflow-hidden rounded-full bg-surface p-1 font-sans font-normal text-ink shadow-overlay"
        :style="{
          width: mode === 'idle' && hasPrompt && typingWidth ? `${typingWidth}px` : undefined,
          animation: visible && positioned ? 'pop-in 220ms cubic-bezier(0.23,1,0.32,1) both' : undefined,
        }"
      >
        <div
          ref="contentRef"
          class="flex w-fit shrink-0 items-center justify-center gap-0.5"
          :style="{ width: mode === 'idle' && hasPrompt && typingWidth ? `${typingWidth - 8}px` : undefined }"
        >
          <span v-if="busy" class="inline-flex h-7 items-center gap-1.5 whitespace-nowrap px-2.5 text-[12.5px] font-normal text-ink-2">
            <span class="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2" style="animation: spin 700ms linear infinite" />
            <AiShimmer v-if="mode === 'thinking'" class="text-[12.5px] font-normal">{{ busyLabel }}...</AiShimmer>
            <span v-else>{{ busyLabel }}...</span>
          </span>

          <template v-else-if="mode === 'result'">
            <button v-if="!failure" type="button" class="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-ink px-2.5 text-[12.5px] font-normal text-canvas shadow-hairline transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.96]" @mousedown.prevent @click="accept">
              <Icon name="ph:check" class="size-3.5" />
              {{ resolvedLabels.keep }}
            </button>
            <AiButton type="button" variant="quiet" size="xs" class="shrink-0" @mousedown.prevent @click="reset">
              <Icon name="ph:x" class="size-3.5" />
              {{ resolvedLabels.discard }}
            </AiButton>
            <span class="mx-0.5 h-4 w-px shrink-0 bg-line" />
            <button type="button" :aria-label="resolvedLabels.retry" class="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink-2 active:scale-[0.96]" @mousedown.prevent @click="retryAction">
              <Icon name="ph:arrow-counter-clockwise" class="size-3.5" />
            </button>
          </template>

          <template v-else>
            <!-- free prompt input, replacing the buttons once it holds text -->
            <div
              class="flex min-w-0 items-center overflow-hidden transition-[max-width,opacity,transform] duration-400 ease-out-strong"
              :style="{ maxWidth: expanded ? '0px' : hasPrompt && typingWidth ? `${typingWidth - 40}px` : '145px', opacity: expanded ? 0 : 1, transform: expanded ? 'translateX(-8px)' : 'translateX(0)' }"
            >
              <form class="flex h-7 shrink-0 items-center transition-[width] duration-400 ease-out-strong" :style="{ width: hasPrompt && typingWidth ? `${typingWidth - 40}px` : '145px' }" @submit.prevent="submitPrompt">
                <input :value="prompt" :aria-label="resolvedLabels.placeholder" :placeholder="resolvedLabels.placeholder" class="h-7 w-full bg-transparent pr-2.5 pl-3 text-[12.5px] text-ink placeholder:text-ink-3" @input="onPromptInput" />
              </form>
            </div>

            <div
              class="flex min-w-0 items-center gap-0.5 overflow-hidden transition-[max-width,opacity,transform] duration-400 ease-out-strong"
              :style="{ maxWidth: hasPrompt ? '0px' : expanded ? '462px' : '224px', opacity: hasPrompt ? 0 : 1, transform: hasPrompt ? 'translateX(-8px)' : 'translateX(0)' }"
            >
              <span v-if="!expanded" class="mx-1 h-4 w-px shrink-0 bg-line-strong" />
              <AiButton v-for="item in actions.primary" :key="item.id" type="button" variant="quiet" size="xs" class="shrink-0" @mousedown.prevent @click="run(item.id)">
                <Icon :name="item.icon" class="size-3.5" />
                {{ item.label }}
              </AiButton>

              <div class="flex min-w-0 items-center gap-0.5 overflow-hidden transition-[max-width,opacity,margin] duration-400 ease-out-strong" :style="{ maxWidth: expanded ? '262px' : '0px', opacity: expanded ? 1 : 0, marginLeft: expanded ? '2px' : '0px' }">
                <AiButton v-for="item in actions.more" :key="item.id" type="button" variant="quiet" size="xs" class="shrink-0" @mousedown.prevent @click="run(item.id)">
                  <Icon :name="item.icon" class="size-3.5" />
                  {{ item.label }}
                </AiButton>
              </div>

              <span class="mx-0.5 h-4 w-px shrink-0 bg-line" />
              <button type="button" :aria-label="expanded ? 'Afficher moins d\'actions' : 'Afficher plus d\'actions'" :aria-expanded="expanded" class="flex size-7 shrink-0 items-center justify-center rounded-full text-ink transition-[background-color,transform] duration-200 hover:bg-hover active:scale-[0.96]" @mousedown.prevent @click="expanded = !expanded">
                <span class="flex transition-transform duration-400 ease-out-strong" :style="{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }">
                  <Icon name="ph:caret-right" class="size-3.5" />
                </span>
              </button>
            </div>

            <div class="flex min-w-0 items-center overflow-hidden transition-[max-width,opacity,transform] duration-400 ease-out-strong" :style="{ maxWidth: hasPrompt ? '30px' : '0px', opacity: hasPrompt ? 1 : 0, transform: hasPrompt ? 'scale(1)' : 'scale(0.88)' }">
              <button type="button" aria-label="Envoyer la demande" class="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-surface transition-[opacity,transform] duration-200 active:scale-[0.94]" @mousedown.prevent @click="submitPrompt">
                <Icon name="ph:arrow-up" class="size-4" />
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
