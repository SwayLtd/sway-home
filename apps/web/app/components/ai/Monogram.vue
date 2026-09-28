<script setup lang="ts">
/** A small round badge with an initial: who or what a chip is about. */
withDefaults(defineProps<{ color?: string }>(), { color: '#e08a3c' })
</script>

<template>
  <span
    class="flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none text-white"
    :style="{ background: color }"
  >
    <slot />
  </span>
</template>
