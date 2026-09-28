<script setup lang="ts">
/**
 * A viewport-anchored popover shell (property config, new-property menu, table options menu):
 * fixed position computed by the caller from a trigger's bounding rect, teleported to body so it
 * escapes the scrollable table, and the source's pop-in scale-fade. Carries `data-recpop` so
 * RecordsTable's single outside-click listener recognises it.
 */
const props = withDefaults(defineProps<{ x: number; y: number; width: number; align?: 'left' | 'right' }>(), {
  align: 'left',
})
</script>

<template>
  <Teleport to="body">
    <div
      data-recpop
      class="fixed z-50 rounded-[14px] bg-surface shadow-overlay"
      :style="{
        top: `${props.y}px`,
        left: `${props.x}px`,
        width: `${props.width}px`,
        animation: 'pop-in 160ms cubic-bezier(0.23,1,0.32,1) both',
        transformOrigin: props.align === 'right' ? 'top right' : 'top left',
      }"
    >
      <slot />
    </div>
  </Teleport>
</template>
