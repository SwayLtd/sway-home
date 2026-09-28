<script setup lang="ts">
/**
 * A list whose hover highlight glides from row to row instead of blinking. Rows are the
 * children carrying `data-menu-row`; keyboard focus moves the highlight too.
 */
const props = withDefaults(defineProps<{ highlightClass?: string; rowSelector?: string }>(), {
  highlightClass: 'inset-x-0 rounded-[8px] bg-hover',
  rowSelector: '[data-menu-row]',
})

const root = ref<HTMLElement | null>(null)
const box = ref<{ top: number; height: number } | null>(null)
const visible = ref(false)

function track(target: EventTarget | null) {
  const container = root.value
  if (!(target instanceof Element) || !container) return
  const row = target.closest(props.rowSelector)
  if (!(row instanceof HTMLElement) || !container.contains(row)) return
  const outer = container.getBoundingClientRect()
  const inner = row.getBoundingClientRect()
  box.value = { top: inner.top - outer.top, height: inner.height }
  visible.value = true
}

function blur(event: FocusEvent) {
  if (!root.value?.contains(event.relatedTarget as Node | null)) visible.value = false
}
</script>

<template>
  <div
    ref="root"
    class="group/glide-menu relative"
    @mouseover="track($event.target)"
    @mouseleave="visible = false"
    @focusin="track($event.target)"
    @focusout="blur"
  >
    <span
      aria-hidden="true"
      class="pointer-events-none absolute"
      :class="props.highlightClass"
      :style="{
        top: `${box?.top ?? 0}px`,
        height: `${box?.height ?? 0}px`,
        opacity: box && visible ? 1 : 0,
        transition: 'top 220ms cubic-bezier(0.23,1,0.32,1), height 220ms cubic-bezier(0.23,1,0.32,1), opacity 150ms ease',
      }"
    />
    <slot />
  </div>
</template>
