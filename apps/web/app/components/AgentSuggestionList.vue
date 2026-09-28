<script setup lang="ts">
/**
 * What to ask when nothing has been asked yet: a few sentences as plain rows, then a line of
 * small links - another page of suggestions, and whatever the host adds in the slot (the full
 * screen offers to connect more devices). Taken from the kit's harness, where an empty chat
 * shows three suggestions and "Shuffle suggestions" under the composer.
 */

defineProps<{
  items: { text: string; icon: string }[]
  /** The full-screen size; the dock uses the compact one. */
  large?: boolean
}>()

const emit = defineEmits<{ pick: [text: string]; shuffle: [] }>()
</script>

<template>
  <div>
    <AiGlideMenu>
      <button
        v-for="(item, index) in items"
        :key="item.text"
        type="button"
        data-menu-row
        class="relative flex w-full items-center gap-2.5 rounded-[8px] px-1.5 text-left text-ink"
        :class="large ? 'h-9 text-[14px]' : 'h-8 text-[13px]'"
        :style="{ animation: `fade-up 300ms cubic-bezier(0.23, 1, 0.32, 1) ${index * 60}ms both` }"
        @click="emit('pick', item.text)"
      >
        <Icon :name="item.icon" class="size-4 shrink-0 text-ink-3" />
        <span class="min-w-0 flex-1 truncate">{{ item.text }}</span>
      </button>
    </AiGlideMenu>

    <div class="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 px-1.5 text-[12px] text-ink-3">
      <slot />
      <button type="button" class="flex items-center gap-1.5 transition-colors hover:text-ink-2" @click="emit('shuffle')">
        <Icon name="ph:arrows-clockwise" class="size-3.5" />
        Autres suggestions
      </button>
    </div>
  </div>
</template>
