<script setup lang="ts">
/** A thing named inline in a sentence - a device, a room, a person - with its monogram. */
const props = defineProps<{ name: string; color?: string; monogram?: string }>()
</script>

<template>
  <span class="mx-0.5 inline-flex items-center gap-1 rounded-full bg-field py-px pl-[3px] pr-1.5 align-middle shadow-hairline">
    <AiMonogram :color="props.color">{{ props.monogram ?? props.name.charAt(0) }}</AiMonogram>
    <span class="text-[12px] font-medium text-ink">{{ props.name }}</span>
  </span>
</template>
