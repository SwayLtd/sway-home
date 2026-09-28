<script setup lang="ts">
/**
 * Beautiful UI's button, on the Sway theme. Its "accent" variant is ink here, like every
 * primary action of the console: amber means "selected", never "press me".
 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'accent' | 'success' | 'quiet'
type Size = 'xs' | 'sm' | 'md'

const props = withDefaults(defineProps<{ variant?: Variant; size?: Size; type?: 'button' | 'submit' | 'reset' }>(), {
  variant: 'secondary',
  size: 'md',
  type: 'button',
})

const HIGHLIGHT = 'shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]'
const VARIANTS: Record<Variant, string> = {
  primary: `bg-ink text-canvas hover:opacity-90 ${HIGHLIGHT}`,
  secondary: 'bg-surface text-ink shadow-btn hover:bg-inset aria-expanded:bg-hover',
  ghost: 'bg-hover-2 text-ink hover:bg-line-strong',
  accent: `bg-ink text-canvas hover:opacity-90 ${HIGHLIGHT}`,
  success: `bg-green text-white hover:brightness-95 ${HIGHLIGHT}`,
  quiet: 'text-ink hover:bg-hover',
}
const SIZES: Record<Size, string> = {
  xs: 'h-7 rounded-full px-2.5 text-[12px] font-normal leading-none gap-1',
  sm: 'h-[27px] px-3 text-[13px] leading-none rounded-full gap-1.5',
  md: 'px-4 py-[9px] text-sm leading-none rounded-full gap-2',
}
</script>

<template>
  <button
    :type="props.type"
    class="inline-flex select-none items-center justify-center font-medium transition-[transform,background-color,opacity] duration-150 ease-out active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50"
    :class="[VARIANTS[props.variant], SIZES[props.size]]"
  >
    <slot />
  </button>
</template>
