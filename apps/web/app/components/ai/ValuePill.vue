<script setup lang="ts">
/** A value set inline in a sentence ("7 jours", "21,5 °C"), tinted by what it means. */
type Tone = 'neutral' | 'green' | 'orange' | 'red' | 'accent'
const props = withDefaults(defineProps<{ tone?: Tone }>(), { tone: 'neutral' })

const TONES: Record<Tone, { cls: string; ring: string }> = {
  neutral: { cls: 'bg-field text-ink-2', ring: 'var(--shadow-hairline)' },
  green: { cls: 'bg-green-tint text-green', ring: '0 0 0 1px color-mix(in oklch, var(--green) 28%, transparent)' },
  orange: { cls: 'bg-orange-tint text-orange', ring: '0 0 0 1px color-mix(in oklch, var(--orange) 28%, transparent)' },
  red: { cls: 'bg-red-tint text-red', ring: '0 0 0 1px color-mix(in oklch, var(--red) 28%, transparent)' },
  accent: { cls: 'bg-bui-accent-tint text-bui-accent-ink', ring: '0 0 0 1px color-mix(in oklch, var(--accent) 28%, transparent)' },
}
</script>

<template>
  <span
    class="mx-0.5 inline-flex items-center rounded-full px-1.5 py-0 align-middle text-[12px] font-medium"
    :class="TONES[props.tone].cls"
    :style="{ boxShadow: TONES[props.tone].ring }"
  >
    <slot />
  </span>
</template>
