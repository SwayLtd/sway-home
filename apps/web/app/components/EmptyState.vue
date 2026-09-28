<script setup lang="ts">
/**
 * An empty relation is a task, not a fact.
 *
 * So an empty state always names the action that fills it. The dashed variant is the whole
 * block as a target, which is what an empty slot in a relation should be.
 */

defineProps<{
  icon?: string
  title: string
  description?: string
  actionLabel?: string
  dashed?: boolean
}>()

const emit = defineEmits<{ action: [] }>()
</script>

<template>
  <div
    class="grid place-items-center rounded-2xl px-6 py-10 text-center"
    :class="dashed
      ? 'cursor-pointer border-2 border-dashed border-base-300 transition-colors hover:border-base-content/25'
      : 'border border-base-300 bg-base-100'"
    @click="dashed && emit('action')"
  >
    <Icon :name="icon ?? 'ph:tray'" class="size-8 text-base-content/25" />
    <p class="mt-3 text-[13px] font-medium">{{ title }}</p>
    <p v-if="description" class="mt-1 max-w-sm text-[12px] text-base-content/50">{{ description }}</p>
    <button v-if="actionLabel && !dashed" class="btn btn-sm admin-cta mt-4" @click="emit('action')">
      {{ actionLabel }}
    </button>
  </div>
</template>
