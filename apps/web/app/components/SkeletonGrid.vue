<script setup lang="ts">
/**
 * Skeletons rather than a spinner, and the skeleton mirrors the real card. A control sized
 * by data that has not loaded resizes under the pointer and moves everything after it.
 * There is no subtitle line here because the real card's subtitle is a datum, not decoration.
 */

defineProps<{ count?: number }>()
</script>

<template>
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
    <div v-for="index in (count ?? 8)" :key="index" class="rounded-2xl border border-base-300 bg-base-100 p-3">
      <div class="flex items-start gap-2.5">
        <div class="size-9 shrink-0 rounded-xl skeleton-line" />
        <div class="min-w-0 flex-1 space-y-1.5 pt-0.5">
          <div class="h-3 w-2/3 rounded-lg skeleton-line" />
          <div class="h-2.5 w-1/2 rounded-lg skeleton-line" />
        </div>
        <div class="h-6 w-10 shrink-0 rounded-full skeleton-line" />
      </div>
    </div>
  </div>
</template>
