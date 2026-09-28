<script setup lang="ts">
/**
 * Text written out a few characters at a time, its last characters still resolving out of a
 * blur, with a caret that stops blinking while it writes.
 */
const props = withDefaults(
  defineProps<{ text: string; charsPerTick?: number; tickMs?: number; blurTail?: number; caret?: boolean }>(),
  { charsPerTick: 2, tickMs: 9, blurTail: 6, caret: true }
)
const emit = defineEmits<{ progress: []; done: [] }>()

const shown = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

function start() {
  if (timer) clearInterval(timer)
  shown.value = 0
  let count = 0
  timer = setInterval(() => {
    count = Math.min(count + props.charsPerTick, props.text.length)
    shown.value = count
    emit('progress')
    if (count >= props.text.length) {
      if (timer) clearInterval(timer)
      timer = null
      emit('done')
    }
  }, props.tickMs)
}

watch(() => [props.text, props.charsPerTick, props.tickMs], start, { immediate: true })
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const streaming = computed(() => shown.value < props.text.length)
const written = computed(() => props.text.slice(0, shown.value))
const settled = computed(() => (streaming.value ? Math.max(0, written.value.length - props.blurTail) : written.value.length))
</script>

<template>
  <span>
    {{ written.slice(0, settled) }}<span v-if="settled < written.length" class="stream-tail">{{ written.slice(settled) }}</span><span
      v-if="caret"
      aria-hidden="true"
      class="stream-caret"
      :class="{ 'is-streaming': streaming }"
    />
  </span>
</template>
