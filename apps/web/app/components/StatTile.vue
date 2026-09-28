<script setup lang="ts">
/**
 * One number, its label, and a hint.
 *
 * The slot for the value is reserved before the value arrives, so the tile does not resize
 * when the first reading lands and drag everything after it across the screen.
 */

const props = defineProps<{
  label: string
  value: string | number | null
  unit?: string
  icon?: string
  hint?: string
  tone?: 'default' | 'success' | 'warning' | 'error' | 'info'
  to?: string
  loading?: boolean
}>()

const NuxtLinkComponent = resolveComponent('NuxtLink')

const toneClass = computed(
  () =>
    ({
      default: 'text-base-content',
      success: 'text-success',
      warning: 'text-warning',
      error: 'text-error',
      info: 'text-info',
    })[props.tone ?? 'default']
)
</script>

<template>
  <component
    :is="props.to ? NuxtLinkComponent : 'div'"
    :to="props.to"
    class="block rounded-2xl border border-base-300 bg-base-100 p-3.5 transition-colors"
    :class="props.to ? 'hover:border-base-content/20' : ''"
  >
    <div class="flex items-center gap-2">
      <Icon v-if="props.icon" :name="props.icon" class="size-4 text-base-content/35" />
      <p class="text-[10px] font-semibold uppercase tracking-wider text-base-content/40">{{ label }}</p>
    </div>

    <div class="mt-2 flex min-h-8 items-baseline gap-1">
      <template v-if="!props.loading && props.value !== null">
        <span class="text-2xl font-semibold tabular leading-none" :class="toneClass">{{ value }}</span>
        <span v-if="props.unit" class="text-[12px] text-base-content/45">{{ unit }}</span>
      </template>
      <div v-else class="h-6 w-16 rounded-lg skeleton-line" />
    </div>

    <p v-if="props.hint" class="mt-1 truncate text-[11px] text-base-content/45">{{ hint }}</p>
  </component>
</template>
