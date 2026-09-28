<script setup lang="ts">
/** Text with a light sweeping across it: something is being worked on. */
withDefaults(defineProps<{ duration?: string }>(), { duration: '1.8s' })
</script>

<template>
  <span
    class="inline-block bg-clip-text text-transparent"
    :style="{
      backgroundImage: 'linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)',
      backgroundSize: '200% 100%',
      animation: `shimmer-text ${duration} linear infinite`,
    }"
  >
    <slot />
  </span>
</template>
