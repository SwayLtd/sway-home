<script setup lang="ts">
/** The table's own checkbox: a checked/mixed square that swaps in for the row number on hover. */
defineProps<{ checked: boolean; mixed?: boolean; label: string }>()
const emit = defineEmits<{ change: [] }>()
</script>

<template>
  <label class="records-checkbox" :title="label" @click.stop>
    <input type="checkbox" :checked="checked" :aria-label="label" @change="emit('change')" />
    <span class="records-checkbox-box" :class="{ 'is-active': checked || mixed }">
      <span v-if="mixed" class="records-checkbox-dash" />
      <Icon v-else-if="checked" name="ph:check-bold" class="size-3" />
    </span>
  </label>
</template>
