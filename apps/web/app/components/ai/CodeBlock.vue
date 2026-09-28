<script setup lang="ts">
/**
 * CODE BLOCK - a light editor panel with two views (Beautiful UI).
 *
 *   Code   a line-numbered listing, with syntax colouring for json / yaml / ts / js
 *   Diff   a unified diff: old/new gutters, a green/red accent bar and row tint, plus
 *          word-level add/del highlights
 *
 * Both share syntax colouring, insets and wrapping. The tokenizer and the diff engine are
 * pure helpers in `utils/aiCodeBlock.ts`; this component only turns their output into spans.
 *
 * Props: `variant` (Code | Diff, default Code), `code` (Code), `before` + `after` (Diff -
 * diffed here) or pre-computed `rows` (Diff), `language`, `filename?`, `labels?`.
 * Emits: `copy(text)`.
 */

const props = withDefaults(
  defineProps<{
    variant?: CodeBlockVariant
    code?: string
    language?: CodeBlockLanguage
    filename?: string
    before?: string
    after?: string
    rows?: CodeBlockDiffRow[]
    labels?: Partial<CodeBlockLabels>
  }>(),
  { variant: 'Code', language: 'text' }
)

const emit = defineEmits<{ copy: [text: string] }>()

const t = computed(() => ({ ...CODE_BLOCK_DEFAULT_LABELS, ...props.labels }))
const isDiff = computed(() => props.variant === 'Diff')

const HATCH = 'repeating-linear-gradient(45deg, var(--red) 0, var(--red) 1.5px, transparent 1.5px, transparent 3px)'

const codeLines = computed(() => (props.code ?? '').split('\n'))
const renderLines = computed(() => codeLines.value.map((line) => codeBlockHighlight(line, props.language)))

const diffRows = computed<CodeBlockDiffRow[]>(() => {
  if (props.rows) return props.rows
  if (props.before !== undefined && props.after !== undefined) return codeBlockDiffLines(props.before, props.after)
  return []
})

type RenderPiece = CodeBlockPiece & { tokens: CodeBlockToken[] }
const renderRows = computed(() =>
  diffRows.value.map((row) => ({
    ...row,
    pieces: row.pieces.map((piece): RenderPiece => ({ ...piece, tokens: codeBlockHighlight(piece.text, props.language) })),
  }))
)

const added = computed(() => diffRows.value.filter((row) => row.type === 'add').length)
const removed = computed(() => diffRows.value.filter((row) => row.type === 'del').length)

function tokenStyle(tone?: CodeBlockTokenTone): Record<string, string> | undefined {
  switch (tone) {
    case 'keyword':
      return { color: 'var(--accent-ink)' }
    case 'string':
    case 'number':
      return { color: 'var(--orange)' }
    case 'function':
    case 'key':
      return { color: 'var(--ink)', fontWeight: '500' }
    case 'comment':
      return { color: 'var(--ink-3)' }
    default:
      return undefined
  }
}

const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

async function copy() {
  const raw = props.code ?? ''
  if (import.meta.client && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(raw)
    } catch {
      // clipboard can be unavailable (insecure context, permission denied) - still confirm visually
    }
  }
  copied.value = true
  emit('copy', raw)
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copied.value = false
  }, 1500)
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
})
</script>

<template>
  <div class="w-full max-w-105 overflow-hidden rounded-card bg-surface shadow-card">
    <!-- header - file . (diff stat | copy) -->
    <div class="flex h-11 items-center gap-2 border-b border-line px-4 text-[12.5px]">
      <span class="inline-flex min-w-0 items-center gap-[7px]">
        <Icon name="ph:file-code" class="size-[15px] shrink-0 text-ink-3" />
        <span v-if="props.filename" class="truncate font-mono leading-none text-ink">{{ props.filename }}</span>
      </span>

      <span v-if="isDiff" class="ml-auto inline-flex items-center gap-2 font-mono text-[12px] leading-none tabular-nums">
        <span class="text-green">+{{ added }}</span>
        <span class="text-red">-{{ removed }}</span>
      </span>
      <button
        v-else
        type="button"
        aria-label="Copier le code"
        class="-mr-1 ml-auto flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[12px] font-medium transition-colors duration-100 hover:bg-hover"
        :class="copied ? 'text-green' : 'text-ink-3 hover:text-ink'"
        @click="copy"
      >
        <Icon :name="copied ? 'ph:check-bold' : 'ph:copy'" class="size-2.5" />
        {{ copied ? t.copied : t.copy }}
      </button>
    </div>

    <!-- body - equal 12px inset on top / left / right; lines wrap -->
    <div class="py-3 font-mono text-[12.5px] leading-[1.65] text-ink-2">
      <div v-if="isDiff" class="relative">
        <span class="pointer-events-none absolute inset-y-0 left-5 w-px bg-line" />
        <div
          v-for="(row, i) in renderRows"
          :key="i"
          class="relative grid grid-cols-[20px_minmax(0,1fr)] items-start"
          :class="row.type === 'add' ? 'bg-green-tint' : row.type === 'del' ? 'bg-red-tint' : ''"
        >
          <span v-if="row.type === 'add' || row.type === 'del'" class="absolute inset-y-0 left-0 w-[3px]" :style="{ background: row.type === 'add' ? 'var(--green)' : HATCH }" />
          <span class="select-none text-center text-[11px]" :class="row.type === 'add' ? 'text-green' : row.type === 'del' ? 'text-red' : 'text-ink-3'">
            {{ (row.type === 'del' ? row.old : row.cur) ?? '' }}
          </span>
          <code class="break-words whitespace-pre-wrap pl-1 pr-3">
            <template v-for="(piece, pi) in row.pieces" :key="pi">
              <span
                v-if="piece.change"
                class="rounded-[3px]"
                :style="{
                  background: `color-mix(in srgb, var(--${piece.change === 'add' ? 'green' : 'red'}) 18%, transparent)`,
                  padding: '0 2px',
                  margin: '0 -1px',
                  boxDecorationBreak: 'clone',
                  WebkitBoxDecorationBreak: 'clone',
                }"
              >
                <span v-for="(tok, ti) in piece.tokens" :key="ti" :style="tokenStyle(tok.tone)">{{ tok.text }}</span>
              </span>
              <template v-else>
                <span v-for="(tok, ti) in piece.tokens" :key="ti" :style="tokenStyle(tok.tone)">{{ tok.text }}</span>
              </template>
            </template>
          </code>
        </div>
      </div>

      <div v-else class="relative">
        <span class="pointer-events-none absolute inset-y-0 left-5 w-px bg-line" />
        <div v-for="(tokens, i) in renderLines" :key="i" class="grid grid-cols-[20px_minmax(0,1fr)] items-start">
          <span class="select-none text-center text-[11px] text-ink-3">{{ i + 1 }}</span>
          <code class="break-words whitespace-pre-wrap pl-1 pr-3">
            <span v-for="(tok, ti) in tokens" :key="ti" :style="tokenStyle(tok.tone)">{{ tok.text }}</span>
          </code>
        </div>
      </div>
    </div>
  </div>
</template>
