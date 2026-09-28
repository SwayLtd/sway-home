<script setup lang="ts">
/**
 * A sentence with its values set in it.
 *
 * The assistant writes `[[ph:lightning|4,4 W]]` where a value belongs; this renders it as a
 * small rounded chip with its icon, inline, so the sentence stays a sentence and the numbers
 * still jump out. Parsing happens in `@sway-home/shared/rich_text`, which returns plain data
 * segments: every piece of text here is interpolated, never bound as HTML, so a device name
 * containing markup renders as characters.
 */

import { parseRichText, type ChipTone } from '@sway-home/shared/rich_text'

const props = defineProps<{ text: string }>()

const segments = computed(() => parseRichText(props.text))

/**
 * A plain value is a soft highlight; anything that asks for attention gets a ring as well,
 * so "TV du salon n'a pas répondu" never reads like just another number.
 */
const TONE: Record<ChipTone, string> = {
  default: 'bg-primary/15 text-base-content',
  ok: 'bg-success/15 text-base-content',
  warn: 'bg-warning/25 text-base-content ring-1 ring-inset ring-warning/50',
  alert: 'bg-error/15 text-error ring-1 ring-inset ring-error/40',
  info: 'bg-info/15 text-base-content',
}
</script>

<template>
  <span>
    <template v-for="(segment, index) in segments" :key="index">
      <template v-if="segment.kind === 'text'">{{ segment.text }}</template>
      <span
        v-else
        class="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-px align-[-0.08em] text-[0.93em] font-medium leading-snug"
        :class="TONE[segment.tone]"
      >
        <Icon :name="segment.icon" class="size-[1.05em] shrink-0 opacity-70" />
        {{ segment.text }}
      </span>
    </template>
  </span>
</template>
