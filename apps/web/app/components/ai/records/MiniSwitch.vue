<script setup lang="ts">
/** The tiny on/off switch used throughout the property popover (grounding, required, ...). */
defineProps<{ on: boolean; label: string }>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="on"
    :aria-label="label"
    class="relative h-4.5 w-7.5 shrink-0 rounded-full transition-colors duration-150"
    :style="{ background: on ? 'var(--accent)' : 'var(--line-strong)' }"
    @click="emit('toggle')"
  >
    <span
      class="absolute top-0.5 left-0.5 size-3.5 rounded-full bg-white shadow-btn transition-transform duration-150"
      :style="{ transform: on ? 'translateX(12px)' : 'translateX(0)', transitionTimingFunction: 'cubic-bezier(0.23,1,0.32,1)' }"
    />
  </button>
</template>
