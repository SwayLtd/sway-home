<script setup lang="ts">
/**
 * PROMPT BAR - the main composer for the assistant (Beautiful UI, source 07).
 *
 *   Rounded   card radius, matches the rest of the console
 *   Pill      fully rounded, round send button
 *
 * Type @ to mention a device, a room, a scene or a routine; type / for a command. Arrow keys
 * move the gliding highlight, Enter or Tab picks, Escape closes. The "+" button opens the same
 * menu as @, plus a built-in "attach" row that opens the browser's file picker. The model
 * picker is a second popover measured against the composer's own edges (it lives outside the
 * clipped composer, so it cannot just pin itself to a corner). Picking a model marked
 * `celebrate` plays a one-shot rainbow sweep through glimm's framework-agnostic core, guarded
 * for reduced motion and for a missing WebGL context (glimm's own fallback: `createShader`
 * returns null, and every call on it is optional-chained). Dictation is owned by the parent:
 * this component only reflects `dictation` and asks to toggle it via the `dictate` emit.
 */
import { ACCENTS, accentChain, createShader, playSweep, type ShaderController } from 'glimm'
import type { ComponentPublicInstance } from 'vue'

const text = defineModel<string>({ default: '' })
const model = defineModel<PromptBarModel | null>('model', { default: null })

const props = withDefaults(
  defineProps<{
    variant?: PromptBarVariant
    /** hero sizing: a multi-line input with controls on their own row */
    tall?: boolean
    placeholder?: string
    mentions?: PromptBarMention[]
    commands?: PromptBarCommand[]
    models?: PromptBarModel[]
    dictation?: PromptBarDictationState
    /** send becomes a stop button; the parent still owns cancelling the run */
    busy?: boolean
    /** offer the built-in "attach files" row; off where nothing can receive a file */
    attach?: boolean
  }>(),
  {
    attach: true,
    variant: undefined,
    tall: false,
    placeholder: undefined,
    mentions: () => [],
    commands: () => [],
    models: () => [],
    dictation: 'idle',
    busy: false,
  }
)

const emit = defineEmits<{
  submit: [payload: PromptBarSubmitPayload]
  dictate: []
  stop: []
}>()

const { preferences } = useAiPreferences()
const pill = computed(() => (props.variant ?? preferences.value.prompt) === 'Pill')

/* menus and drafts are internal UI state; only the picked content leaves via `submit` */
const dismissed = ref(false)
const plusOpen = ref(false)
const modelOpen = ref(false)
const active = ref(0)
const engaged = ref(false)
const expanded = ref(false)
const wide = computed(() => expanded.value || props.tall)

const pickedMentions = ref<PromptBarMention[]>([])
const pickedCommand = ref<PromptBarCommand | null>(null)
const attachedFiles = ref<PromptBarFile[]>([])

const rowBox = ref<{ top: number; height: number } | null>(null)
const modelBox = ref<{ top: number; height: number } | null>(null)
const modelHovered = ref<number | null>(null)
const modelMenuLeft = ref(0)
const modelMenuBottom = ref(0)

const composerAnchorRef = ref<HTMLDivElement | null>(null)
const controlsRef = ref<HTMLDivElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const measureRef = ref<HTMLSpanElement | null>(null)
const modelRef = ref<HTMLButtonElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const glimmRef = ref<HTMLCanvasElement | null>(null)

const rowRefs = ref<(HTMLButtonElement | null)[]>([])
const modelRowRefs = ref<(HTMLButtonElement | null)[]>([])
function setRowRef(el: Element | ComponentPublicInstance | null, index: number) {
  rowRefs.value[index] = el as HTMLButtonElement | null
}
function setModelRowRef(el: Element | ComponentPublicInstance | null, index: number) {
  modelRowRefs.value[index] = el as HTMLButtonElement | null
}

type MenuRow =
  | { type: 'attach'; id: string; label: string; hint: string; icon: string }
  | { type: 'mention'; id: string; label: string; hint?: string; icon: string; mention: PromptBarMention }
  | { type: 'command'; id: string; label: string; hint?: string; icon: string; command: PromptBarCommand }

const ATTACH_LABEL = 'Ajouter des photos et fichiers'
/** Wide enough for a model name and the reason it cannot run ("Clé API manquante"). */
const MODEL_MENU_WIDTH = 256
const ATTACH_HINT = 'Importer depuis cet appareil'

/* the menu, its query and its rows are all derived from the draft text, exactly like the
   source derives them from `draft` - which is what lets a demo replay the whole walkthrough
   by driving nothing more than the text v-model */
const token = computed(() => (dismissed.value ? null : promptBarParseToken(text.value)))
const menu = computed<'at' | 'slash' | null>(() => (plusOpen.value ? 'at' : (token.value?.kind ?? null)))
const query = computed(() => (plusOpen.value ? '' : (token.value?.query ?? '')))

const menuRows = computed<MenuRow[]>(() => {
  if (menu.value === 'at') {
    const rows: MenuRow[] = []
    if (props.attach && promptBarMatches(ATTACH_LABEL, query.value)) {
      rows.push({ type: 'attach', id: '__attach', label: ATTACH_LABEL, hint: ATTACH_HINT, icon: 'ph:paperclip' })
    }
    for (const mention of props.mentions) {
      if (promptBarMatches(mention.label, query.value)) {
        rows.push({
          type: 'mention',
          id: mention.id,
          label: mention.label,
          hint: mention.hint,
          icon: mention.icon ?? PROMPT_BAR_MENTION_ICON[mention.kind],
          mention,
        })
      }
    }
    return rows
  }
  if (menu.value === 'slash') {
    return props.commands
      .filter((command) => promptBarMatches(command.label.replace(/^\//, ''), query.value))
      .map((command) => ({
        type: 'command' as const,
        id: command.id,
        label: command.label,
        hint: command.hint,
        icon: command.icon ?? 'ph:terminal',
        command,
      }))
  }
  return []
})

const canSend = computed(() => text.value.trim().length > 0 || attachedFiles.value.length > 0)

/* a single highlight glides to the active row instead of each row toggling its own background */
watch([menu, query], () => {
  active.value = 0
  engaged.value = false
})
watch(
  [menu, query, active, menuRows],
  () => {
    const target = rowRefs.value[active.value]
    if (target) rowBox.value = { top: target.offsetTop, height: target.offsetHeight }
  },
  { flush: 'post' }
)

/* same gliding highlight in the model menu - floats to the hovered row, falling back to the
   currently-selected model */
const modelIndex = computed(() => props.models.findIndex((m) => m.id === model.value?.id))
watch(
  [modelOpen, modelHovered, modelIndex],
  () => {
    if (!modelOpen.value) return
    const target = modelRowRefs.value[modelHovered.value ?? modelIndex.value]
    if (target) modelBox.value = { top: target.offsetTop, height: target.offsetHeight }
  },
  { flush: 'post' }
)
watch(modelOpen, (open) => {
  if (!open) modelHovered.value = null
})

/* the menu is outside the clipped composer, so align it to the model trigger by measurement
   instead of pinning it to the far-right edge */
watch(
  [modelOpen, wide, () => model.value?.label],
  () => {
    if (!modelOpen.value || !composerAnchorRef.value || !modelRef.value) return
    const anchorRect = composerAnchorRef.value.getBoundingClientRect()
    const triggerRect = modelRef.value.getBoundingClientRect()
    modelMenuLeft.value = Math.max(0, Math.min(triggerRect.left - anchorRect.left, anchorRect.width - MODEL_MENU_WIDTH))
    modelMenuBottom.value = anchorRect.bottom - triggerRect.top + 8
  },
  { flush: 'post' }
)

/* move wrapped text above the controls, then grow to a compact maximum */
watch(
  [text, expanded],
  () => {
    const input = inputRef.value
    const controls = controlsRef.value
    const measure = measureRef.value
    if (!input || !controls || !measure) return

    const fixedControlsWidth = 28 * 3 + (modelRef.value?.offsetWidth ?? 0)
    const inlineGaps = 4 * 4
    const inlineInputWidth = controls.clientWidth - fixedControlsWidth - inlineGaps
    const needsFullWidth = text.value.includes('\n') || measure.offsetWidth + 8 > inlineInputWidth
    if (needsFullWidth !== expanded.value) expanded.value = needsFullWidth

    const minHeight = 28
    const maxHeight = 100
    input.style.height = '0px'
    const contentHeight = input.scrollHeight
    input.style.height = `${Math.min(Math.max(contentHeight, minHeight), maxHeight)}px`
    input.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'
  },
  { flush: 'post', immediate: true }
)

/* picking a model marked `celebrate` sweeps, whether the pick came from a click here or from
   a parent driving v-model:model (a demo walkthrough, for instance) */
watch(model, (next, prev) => {
  if (next?.celebrate && next.id !== prev?.id) celebrate()
})

/* clicking anywhere outside the composer closes the open menus */
function onDocumentPointerDown(event: PointerEvent) {
  if (!modelOpen.value && !plusOpen.value) return
  if (!(event.target as Element).closest('[data-promptbar]')) {
    modelOpen.value = false
    plusOpen.value = false
  }
}
onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

function closeMenus() {
  plusOpen.value = false
  modelOpen.value = false
}
function togglePlus() {
  modelOpen.value = false
  plusOpen.value = !plusOpen.value
  nextTick(() => inputRef.value?.focus())
}
function toggleModelMenu() {
  plusOpen.value = false
  modelOpen.value = !modelOpen.value
}
function pickModel(next: PromptBarModel) {
  if (next.disabled) return
  model.value = next
  modelOpen.value = false
  nextTick(() => inputRef.value?.focus())
}

function pick(row: MenuRow) {
  if (row.type === 'attach') {
    plusOpen.value = false
    fileInputRef.value?.click()
    return
  }
  const tok = token.value
  const base = tok ? text.value.slice(0, tok.start) : text.value
  if (row.type === 'mention') {
    text.value = `${base}@${row.label} `
    pickedMentions.value = [...pickedMentions.value, row.mention]
  } else {
    text.value = `${base}${row.label} `
    pickedCommand.value = row.command
  }
  plusOpen.value = false
  dismissed.value = false
  nextTick(() => inputRef.value?.focus())
}

function onFilesChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const chosen = input.files
  if (chosen && chosen.length > 0) {
    const next = Array.from(chosen).map((file) => ({
      id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      file,
    }))
    attachedFiles.value = [...attachedFiles.value, ...next]
  }
  input.value = ''
  nextTick(() => inputRef.value?.focus())
}
function removeFile(id: string) {
  attachedFiles.value = attachedFiles.value.filter((f) => f.id !== id)
}

function onInput(event: Event) {
  text.value = (event.target as HTMLTextAreaElement).value
  dismissed.value = false
  plusOpen.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (menu.value && menuRows.value.length > 0) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      engaged.value = true
      const delta = event.key === 'ArrowDown' ? 1 : menuRows.value.length - 1
      active.value = (active.value + delta) % menuRows.value.length
      return
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault()
      const row = menuRows.value[active.value]
      if (row) pick(row)
      return
    }
  }
  if (event.key === 'Escape') {
    dismissed.value = true
    closeMenus()
    return
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !props.busy) {
    event.preventDefault()
    send()
  }
}

function send() {
  if (props.busy || !canSend.value) return
  emit('submit', {
    text: text.value.trim(),
    mentions: pickedMentions.value,
    command: pickedCommand.value,
    files: attachedFiles.value,
    model: model.value,
  })
  text.value = ''
  pickedMentions.value = []
  pickedCommand.value = null
  attachedFiles.value = []
  closeMenus()
}

/* The built-in "prism" palette is only cyan-indigo-magenta, so a sweep reads as blue/purple.
   Build a true full-spectrum rainbow instead, exactly like the source. */
const RAINBOW = accentChain([ACCENTS.red, ACCENTS.orange, ACCENTS.yellow, ACCENTS.green, ACCENTS.cyan, ACCENTS.blue, ACCENTS.purple])

const shaderRef = ref<ShaderController | null>(null)
const sweeping = ref(false)

/* Build the shader with a pinned hue phase. createShader seeds its internal hueShift from
   Math.random(), which made the sweep a different colour on every reload - pin it so the
   rainbow is identical each time. createShader itself returns null with no WebGL context or
   no canvas: every caller below optional-chains it, so that fallback degrades silently. */
function makeShader(): ShaderController | null {
  const canvas = glimmRef.value
  if (!canvas) return null
  const random = Math.random
  Math.random = () => 0
  try {
    return createShader({ canvas, palette: RAINBOW, direction: 'ltr', bandTight: 10, swellAmount: 0.85 })
  } finally {
    Math.random = random
  }
}

onMounted(() => {
  shaderRef.value = makeShader()
})
onBeforeUnmount(() => {
  shaderRef.value?.destroy()
  shaderRef.value = null
})

/* Glimm shader lives inside the composer, invisible at rest. Picking a `celebrate` model fires
   a one-shot rainbow sweep across the interior. */
function celebrate() {
  if (sweeping.value) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  // Recreate the shader per sweep so uTime restarts at 0 - the hue phase (which drifts with
  // time) is then identical on every trigger.
  shaderRef.value?.destroy()
  const shader = makeShader()
  shaderRef.value = shader
  if (!shader) return
  sweeping.value = true
  const sweep = playSweep(shader, {
    palette: RAINBOW,
    direction: 'ltr',
    sweepMs: 570,
    outroMs: 80,
    peakAlpha: 1.3,
    bandTight: 10,
    brightness: 1.4,
    swellAmount: 1,
    waveSpeed: 1.8,
    easing: 'easeOutExpo',
  })
  sweep.done.finally(() => {
    sweeping.value = false
  })
}
</script>

<template>
  <div ref="composerAnchorRef" data-promptbar class="relative w-full">
    <input ref="fileInputRef" type="file" multiple class="hidden" @change="onFilesChosen" />

    <!-- at / slash menu -->
    <div
      v-if="menu"
      class="absolute inset-x-0 bottom-full z-10 mb-2 rounded-[10px] bg-surface p-1 shadow-raised"
      style="animation: pop-in 180ms cubic-bezier(0.23, 1, 0.32, 1) both; transform-origin: bottom center"
      @mouseleave="engaged = false"
    >
      <!-- single gliding highlight - appears once a row is hovered or reached via arrow keys -->
      <span
        aria-hidden="true"
        class="pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover"
        :style="{
          top: `${rowBox?.top ?? 0}px`,
          height: `${rowBox?.height ?? 0}px`,
          opacity: rowBox && engaged && menuRows.length > 0 ? 1 : 0,
          transition: 'top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease',
        }"
      />
      <button
        v-for="(row, index) in menuRows"
        :key="row.id"
        :ref="(el) => setRowRef(el, index)"
        type="button"
        class="relative z-10 flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2 text-left"
        @mousedown.prevent
        @mouseenter="active = index; engaged = true"
        @click="pick(row)"
      >
        <span class="flex size-5.5 shrink-0 items-center justify-center text-ink-2">
          <Icon :name="row.icon" class="size-[15px]" />
        </span>
        <span class="shrink-0 text-[12.5px] font-medium text-ink">{{ row.label }}</span>
        <span class="min-w-0 flex-1 truncate text-[12px] text-ink-3">{{ row.hint }}</span>
      </button>
      <div v-if="menuRows.length === 0" class="flex h-9 items-center px-2 text-[12px] text-ink-3">Aucun résultat pour "{{ query }}"</div>
      <div class="mt-1 border-t border-line px-2 pt-1.5 pb-1 text-[11px] text-ink-3">
        {{ menu === 'at' ? 'Tapez pour chercher un appareil, une pièce, une scène ou une routine' : 'Tapez pour chercher une commande' }}
      </div>
    </div>

    <!-- model menu -->
    <div
      v-if="modelOpen"
      class="thin-scroll absolute z-10 max-h-80 overflow-y-auto rounded-[10px] bg-surface p-1 shadow-raised"
      :style="{
        width: `${MODEL_MENU_WIDTH}px`,
        left: `${modelMenuLeft}px`,
        bottom: `${modelMenuBottom}px`,
        animation: 'pop-in 180ms cubic-bezier(0.23, 1, 0.32, 1) both',
        transformOrigin: 'bottom left',
      }"
      @mouseleave="modelHovered = null"
    >
      <!-- single gliding highlight - floats to the hovered / selected row -->
      <span
        aria-hidden="true"
        class="pointer-events-none absolute inset-x-1 rounded-[6px] bg-hover"
        :style="{
          top: `${modelBox?.top ?? 0}px`,
          height: `${modelBox?.height ?? 0}px`,
          opacity: modelBox && modelHovered !== null ? 1 : 0,
          transition: 'top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease',
        }"
      />
      <template v-for="(item, index) in models" :key="item.id">
        <p
          v-if="item.group && item.group !== models[index - 1]?.group"
          class="relative z-10 px-2 pt-2 pb-0.5 text-[10.5px] font-medium uppercase tracking-wider text-ink-3"
        >
          {{ item.group }}
        </p>
        <button
          :ref="(el) => setModelRowRef(el, index)"
          type="button"
          :disabled="item.disabled"
          :title="item.disabled ? item.hint : undefined"
          class="relative z-10 flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left disabled:cursor-not-allowed"
          @mousedown.prevent
          @mouseenter="modelHovered = item.disabled ? null : index"
          @click="pickModel(item)"
        >
          <!-- two lines: a model name and the reason it cannot run are both worth reading whole -->
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[12.5px] font-medium" :class="item.disabled ? 'text-ink-3' : 'text-ink'">{{ item.label }}</span>
            <span v-if="item.hint" class="block truncate text-[11px] text-ink-3">{{ item.hint }}</span>
          </span>
          <span class="mt-0.5 shrink-0 text-ink" :class="item.id === model?.id ? '' : 'invisible'">
            <Icon name="ph:check" class="size-[13px]" />
          </span>
        </button>
      </template>
    </div>

    <!-- composer -->
    <div
      class="relative isolate flex flex-col overflow-hidden border border-line bg-surface shadow-card transition-[border-color,border-radius] duration-150 focus-within:border-line-strong"
      :class="[
        tall ? 'gap-2.5 p-3.5' : 'gap-1.5 p-1.5',
        pill ? (attachedFiles.length > 0 || wide ? 'rounded-[24px]' : 'rounded-full') : tall ? 'rounded-[22px]' : 'rounded-[14px]',
      ]"
    >
      <!-- rainbow glimm sweep - plays across the interior on a flagship model pick. explicit
           w/h: a canvas is a replaced element and won't stretch to inset-0 alone, which feeds
           back into the shader's ResizeObserver. -->
      <canvas ref="glimmRef" aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10 h-full w-full" style="border-radius: inherit" />
      <span ref="measureRef" aria-hidden="true" class="pointer-events-none absolute invisible whitespace-pre text-[13px] leading-[18px]">{{
        text
      }}</span>

      <div v-if="attachedFiles.length > 0" class="flex flex-wrap gap-1.5 pt-0.5" :class="pill ? 'px-1' : 'px-0.5'">
        <span
          v-for="chip in attachedFiles"
          :key="chip.id"
          class="flex h-6.5 items-center gap-1.5 bg-field py-1 pr-1 pl-1.5 text-[11.5px] text-ink-2 shadow-hairline"
          :class="pill ? 'rounded-full' : 'rounded-chip'"
          style="animation: pop-in 200ms cubic-bezier(0.23, 1, 0.32, 1) both"
        >
          <Icon name="ph:file" class="size-3" />
          <span class="max-w-36 truncate">{{ chip.name }}</span>
          <button
            type="button"
            :aria-label="`Retirer ${chip.name}`"
            class="-my-1 flex size-6 items-center justify-center text-ink-3 transition-colors duration-100 hover:bg-line/70 hover:text-ink"
            :class="pill ? 'rounded-full' : 'rounded-[5px]'"
            @click="removeFile(chip.id)"
          >
            <Icon name="ph:x" class="size-[10px]" />
          </button>
        </span>
      </div>

      <div
        ref="controlsRef"
        class="grid items-end gap-x-1 gap-y-1.5"
        :class="wide ? 'grid-cols-[28px_auto_minmax(0,1fr)_28px_28px]' : 'grid-cols-[28px_minmax(0,1fr)_auto_28px_28px]'"
      >
        <button
          type="button"
          aria-label="Ajouter des pièces jointes"
          :aria-expanded="plusOpen"
          class="flex size-7 shrink-0 items-center justify-center justify-self-start text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-ink active:scale-[0.94]"
          :class="[
            pill ? 'rounded-full' : 'rounded-[8px]',
            plusOpen ? 'bg-hover text-ink' : '',
            wide ? 'col-start-1 row-start-2' : 'col-start-1 row-start-1',
          ]"
          @click="togglePlus"
        >
          <Icon name="ph:plus" class="size-4" />
        </button>

        <textarea
          ref="inputRef"
          rows="1"
          :value="text"
          :placeholder="dictation === 'listening' ? 'Écoute...' : (placeholder ?? 'Écrire un message...')"
          aria-label="Message"
          class="min-w-0 w-full resize-none bg-transparent text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3"
          :class="[
            tall ? 'min-h-[68px] px-2 py-2 text-[14px] leading-5' : 'min-h-7 px-1 py-[5px] text-[13px] leading-[18px]',
            wide ? 'col-span-full col-start-1 row-start-1' : 'col-start-2 row-start-1',
          ]"
          @input="onInput"
          @keydown="onKeydown"
        />

        <button
          v-if="models.length > 0"
          ref="modelRef"
          type="button"
          :aria-expanded="modelOpen"
          aria-label="Choisir le modèle"
          class="flex h-7 shrink-0 items-center gap-1 px-1.5 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
          :class="[pill ? 'rounded-full' : 'rounded-[8px]', wide ? 'col-start-2 row-start-2 justify-self-start' : 'col-start-3 row-start-1']"
          @click="toggleModelMenu"
        >
          {{ model?.label ?? 'Modèle' }}
          <span class="text-ink-3">
            <Icon name="ph:caret-down" class="size-[11px]" />
          </span>
        </button>

        <!-- dictation: the parent owns the microphone, this button only asks to toggle it -->
        <button
          type="button"
          :aria-label="dictation === 'listening' ? 'Arrêter la dictée' : 'Démarrer la dictée'"
          :aria-pressed="dictation === 'listening'"
          :disabled="dictation === 'unavailable'"
          class="flex size-7 shrink-0 items-center justify-center transition-[background-color,color,transform] duration-150 active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40"
          :class="[
            pill ? 'rounded-full' : 'rounded-[8px]',
            dictation === 'listening' ? 'bg-bui-accent-tint text-bui-accent-ink' : 'text-ink-3 hover:bg-hover hover:text-ink',
            wide ? 'col-start-4 row-start-2' : 'col-start-4 row-start-1',
          ]"
          @click="emit('dictate')"
        >
          <span v-if="dictation === 'listening'" class="flex h-3.5 items-center gap-[2.5px]">
            <span
              v-for="i in 3"
              :key="i"
              class="w-[2.5px] rounded-full bg-current"
              :style="{ height: '100%', animation: `eq-bounce 900ms ease-in-out ${(i - 1) * 150}ms infinite` }"
            />
          </span>
          <Icon v-else :name="dictation === 'unavailable' ? 'ph:microphone-slash' : 'ph:microphone'" class="size-[15px]" />
        </button>

        <!-- send - tactile square (round in the pill variant); becomes a stop button while busy -->
        <button
          type="button"
          :aria-label="busy ? 'Arrêter' : 'Envoyer'"
          :disabled="!busy && !canSend"
          class="flex size-7 shrink-0 items-center justify-center transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94]"
          :class="[pill ? 'rounded-full' : 'rounded-[8px]', wide ? 'col-start-5 row-start-2' : 'col-start-5 row-start-1']"
          :style="{
            background: busy || canSend ? 'var(--ink)' : 'var(--line-strong)',
            color: busy || canSend ? 'var(--surface)' : 'var(--ink-2)',
          }"
          @click="busy ? emit('stop') : send()"
        >
          <Icon :name="busy ? 'ph:stop-fill' : 'ph:arrow-up'" class="size-4" />
        </button>
      </div>
    </div>
  </div>
</template>
