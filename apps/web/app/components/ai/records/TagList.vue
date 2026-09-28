<script setup lang="ts">
/**
 * A row of `.records-tag` chips that measures its own available width and collapses whatever
 * doesn't fit into a trailing "+N", re-measuring whenever the column resizes or the tags change.
 */
const props = defineProps<{ tags: string[]; tagColors?: Record<string, string> }>()

const container = ref<HTMLDivElement | null>(null)
const measure = ref<HTMLDivElement | null>(null)
const visibleCount = ref(props.tags.length)

function update() {
  const containerEl = container.value
  const measureEl = measure.value
  if (!containerEl || !measureEl) return

  const available = containerEl.clientWidth
  const tagWidths = Array.from(measureEl.querySelectorAll<HTMLElement>('[data-tag-measure]'), (tag) => tag.offsetWidth)
  const moreWidth = measureEl.querySelector<HTMLElement>('[data-more-measure]')?.offsetWidth ?? 0
  let used = 0
  let count = 0

  for (let index = 0; index < tagWidths.length; index += 1) {
    const nextUsed = used + (count > 0 ? 4 : 0) + (tagWidths[index] ?? 0)
    const hiddenAfter = props.tags.length - (index + 1)
    const totalWithOverflow = nextUsed + (hiddenAfter > 0 ? 4 + moreWidth : 0)
    if (totalWithOverflow > available) break
    used = nextUsed
    count += 1
  }

  visibleCount.value = count
}

let observer: ResizeObserver | null = null
onMounted(() => {
  nextTick(update)
  observer = new ResizeObserver(update)
  if (container.value) observer.observe(container.value)
})
onBeforeUnmount(() => observer?.disconnect())
watch(() => props.tags, () => nextTick(update))

const hiddenCount = computed(() => props.tags.length - visibleCount.value)
const visibleTags = computed(() => props.tags.slice(0, visibleCount.value))
</script>

<template>
  <div
    ref="container"
    class="records-tags"
    :title="tags.join(', ')"
    :aria-label="`Étiquettes : ${tags.join(', ')}`"
  >
    <div ref="measure" class="records-tags-measure" aria-hidden="true">
      <span v-for="tag in tags" :key="tag" data-tag-measure>
        <span class="records-tag" :style="{ '--tag-base': recordsTagColor(tag, tagColors).base }">{{ tag }}</span>
      </span>
      <span data-more-measure class="records-more-tag">+{{ tags.length }}</span>
    </div>
    <span v-for="tag in visibleTags" :key="tag" class="records-tag" :style="{ '--tag-base': recordsTagColor(tag, tagColors).base }">{{ tag }}</span>
    <span v-if="hiddenCount > 0" class="records-more-tag">+{{ hiddenCount }}</span>
  </div>
</template>
