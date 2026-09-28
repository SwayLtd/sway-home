<script setup lang="ts">
/**
 * TOOL CHIPS - an agent run as compact rows (Beautiful UI).
 *
 * Each tool call is a row: an icon, a plain label and a chip naming what it acted on. Hovering
 * a row reveals a chevron; clicking it expands the row to show what the tool did. Once every
 * row has streamed in, change chips summarise the net effect (a before/after state, or an
 * add/remove count) - hovering or focusing one previews its detail in a Teleport-ed popover,
 * matching the source's body portal so a translated/animated reply wrapper cannot clip it.
 *
 * Props: `steps`, `changes`, `header?`, `more?`. No emits: the run header, row detail and hover
 * preview are all local UI state, like the source.
 */
import type { ToolChipsChange, ToolChipsStep } from '~/utils/aiToolChips'

const props = withDefaults(
  defineProps<{
    steps?: ToolChipsStep[]
    changes?: ToolChipsChange[]
    /** Overrides the live "N appels d'outils" default. */
    header?: string
    /** The trailing "+N autres" button, shown whenever set (once `changes` has landed). */
    more?: string
    /** Fill the parent instead of the gallery's fixed measure and reserved height. */
    fill?: boolean
    /** Start folded to the header line, for a run shown again from history. */
    collapsed?: boolean
  }>(),
  { steps: () => [], changes: () => [], fill: false, collapsed: false }
)

const headerText = computed(() => props.header ?? toolChipsHeaderLabel(props.steps.length))

const open = ref(!props.collapsed)
const openRows = ref<Set<string>>(new Set())
function isRowOpen(id: string) {
  return openRows.value.has(id)
}
function toggleRow(id: string) {
  const next = new Set(openRows.value)
  next.has(id) ? next.delete(id) : next.add(id)
  openRows.value = next
}

/* Hover/focus preview, teleported to <body> so it always lays over the page regardless of any
   transform/overflow the reply wrapper around this component applies. */
const preview = ref<{ change: ToolChipsChange; x: number; top?: number; bottom?: number } | null>(null)
function openPreview(change: ToolChipsChange, event: Event) {
  const el = event.currentTarget as HTMLElement | null
  if (!el) return
  const rect = el.getBoundingClientRect()
  const previewHeight = 38 + (change.detail?.length ?? 0) * 19
  const fitsBelow = rect.bottom + 6 + previewHeight <= window.innerHeight - 12
  preview.value = {
    change,
    x: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
    ...(fitsBelow ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
  }
}
function closePreview(id: string) {
  if (preview.value?.change.id === id) preview.value = null
}
</script>

<template>
  <div class="w-full pb-1" :class="fill ? '' : 'min-h-[220px] max-w-80'">
    <!-- collapsed run header -->
    <button
      type="button"
      :aria-expanded="open"
      class="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
      @click="open = !open"
    >
      <Icon name="ph:caret-down" class="size-3 shrink-0 transition-transform duration-200" :style="{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }" />
      <span class="tabular-nums">{{ headerText }}</span>
    </button>

    <!-- tool call rows -->
    <div class="grid transition-[grid-template-rows,opacity] duration-300" :style="{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }">
      <div class="-mx-1 overflow-hidden px-1.5 pb-1">
        <div class="mt-1.5 flex flex-col gap-1">
          <div v-for="step in steps" :key="step.id" style="animation: fade-up 300ms cubic-bezier(0.23,1,0.32,1) both">
            <button
              type="button"
              :aria-expanded="isRowOpen(step.id)"
              class="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-[3px] text-left transition-colors duration-100 hover:bg-hover-2"
              @click="toggleRow(step.id)"
            >
              <span class="relative flex size-4 shrink-0 items-center justify-center" :class="step.status === 'failed' ? 'text-red' : 'text-ink-3'">
                <span
                  v-if="step.status === 'running'"
                  aria-hidden="true"
                  class="size-3 rounded-full border-[1.5px] border-line-strong border-t-current transition-opacity duration-100 group-hover/row:opacity-0"
                  :class="isRowOpen(step.id) ? 'opacity-0' : ''"
                  style="animation: spin 700ms linear infinite"
                />
                <svg
                  v-else-if="step.icon === 'think'"
                  width="13" height="13" viewBox="0 0 24 24" fill="currentColor"
                  class="transition-opacity duration-100 group-hover/row:opacity-0"
                  :class="isRowOpen(step.id) ? 'opacity-0' : ''"
                >
                  <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
                </svg>
                <Icon
                  v-else
                  :name="`ph:${step.icon}`"
                  class="size-[13px] transition-opacity duration-100 group-hover/row:opacity-0"
                  :class="isRowOpen(step.id) ? 'opacity-0' : ''"
                />
                <Icon
                  name="ph:caret-down"
                  class="absolute size-3 shrink-0 opacity-0 transition-[opacity,transform] duration-150 group-hover/row:opacity-100"
                  :class="isRowOpen(step.id) ? 'opacity-100' : ''"
                  :style="{ transform: isRowOpen(step.id) ? 'rotate(0deg)' : 'rotate(-90deg)' }"
                />
              </span>
              <span class="shrink-0 text-[12.5px] font-medium text-ink">{{ step.label }}</span>
              <span
                v-if="step.chip"
                class="inline-flex h-5.5 min-w-0 flex-1 cursor-pointer items-center truncate rounded-chip px-1.5 text-[11.5px] shadow-hairline transition-colors duration-100"
                :class="[step.mono ? 'font-mono' : '', step.status === 'failed' ? 'bg-red-tint text-red' : 'bg-field text-ink-2 hover:bg-hover-2']"
              >{{ step.chip }}</span>
            </button>

            <!-- expanded detail -->
            <div
              class="grid transition-[grid-template-rows,opacity] duration-300"
              :style="{ gridTemplateRows: isRowOpen(step.id) ? '1fr' : '0fr', opacity: isRowOpen(step.id) ? 1 : 0, transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)' }"
            >
              <div class="min-h-0 overflow-hidden">
                <div class="mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l border-line py-0.5 pl-3.5">
                  <span
                    v-for="(line, index) in step.detail"
                    :key="index"
                    class="truncate text-[11.5px] leading-[1.6]"
                    :class="[step.mono ? 'font-mono' : '', line.tone === 'add' ? 'text-green' : line.tone === 'del' ? 'text-red' : 'text-ink-2']"
                  >{{ line.text }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- change chips -->
        <div v-if="changes.length" class="mt-2.5 flex max-w-full flex-wrap gap-1.5 border-t border-line pt-2.5">
          <button
            v-for="(change, index) in changes"
            :key="change.id"
            type="button"
            :aria-expanded="preview?.change.id === change.id"
            :aria-label="`Voir le détail de ${change.label}`"
            class="inline-flex h-7 max-w-full items-center gap-2 rounded-chip bg-surface px-2 font-mono text-[11.5px] text-ink shadow-btn transition-colors duration-100 hover:bg-hover"
            :style="{ animation: `pop-in 250ms cubic-bezier(0.23,1,0.32,1) ${index * 80}ms both` }"
            @mouseenter="openPreview(change, $event)"
            @mouseleave="closePreview(change.id)"
            @focus="openPreview(change, $event)"
            @blur="closePreview(change.id)"
          >
            <span class="min-w-0 truncate">{{ change.label }}</span>
            <template v-if="change.add !== undefined">
              <span class="shrink-0 text-green tabular-nums">+{{ change.add }}</span>
              <span v-if="change.del" class="shrink-0 text-red tabular-nums">-{{ change.del }}</span>
            </template>
            <span v-else-if="change.before && change.after" class="shrink-0 text-ink-2">{{ change.before }} -> {{ change.after }}</span>
          </button>
          <button
            v-if="more"
            type="button"
            class="inline-flex h-7 items-center rounded-chip px-1.5 font-mono text-[11.5px] text-ink-3 underline decoration-transparent underline-offset-2 transition-colors duration-100 hover:text-ink-2 hover:decoration-current"
            :style="{ animation: `fade-in 300ms ease-out ${changes.length * 80}ms both` }"
          >{{ more }}</button>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="preview"
        class="fixed z-50 w-72 overflow-hidden rounded-[10px] bg-surface shadow-overlay"
        :style="{
          left: `${preview.x}px`,
          top: preview.top !== undefined ? `${preview.top}px` : undefined,
          bottom: preview.bottom !== undefined ? `${preview.bottom}px` : undefined,
          animation: 'pop-in 160ms cubic-bezier(0.23,1,0.32,1) both',
          transformOrigin: preview.top === undefined ? 'bottom left' : 'top left',
        }"
      >
        <div class="flex items-center justify-between border-b border-line px-2.5 py-1.5 font-mono text-[11px]">
          <span class="min-w-0 truncate text-ink-2">{{ preview.change.label }}</span>
          <span class="shrink-0 tabular-nums">
            <template v-if="preview.change.add !== undefined">
              <span class="text-green">+{{ preview.change.add }}</span>
              <span v-if="preview.change.del" class="text-red"> -{{ preview.change.del }}</span>
            </template>
            <span v-else-if="preview.change.before && preview.change.after" class="text-ink-2">{{ preview.change.before }} -> {{ preview.change.after }}</span>
          </span>
        </div>
        <div class="py-1 font-mono text-[11px] leading-[1.8]">
          <div
            v-for="(line, index) in preview.change.detail ?? []"
            :key="index"
            class="flex gap-2 px-2.5 whitespace-pre"
            :class="line.tone === 'add' ? 'bg-green-tint text-green' : line.tone === 'del' ? 'bg-red-tint text-red' : 'text-ink-2'"
          >
            <span class="w-3 shrink-0 select-none">{{ line.tone === 'add' ? '+' : line.tone === 'del' ? '-' : ' ' }}</span>
            <span class="min-w-0 truncate">{{ line.text }}</span>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
