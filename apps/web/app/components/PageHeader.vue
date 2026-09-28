<script setup lang="ts">
/**
 * A page header is a title and its actions.
 *
 * The breadcrumb is published to the app header rather than rendered here, so there is one
 * breadcrumb on screen and a page never has to know where the chrome puts it. A subtitle is
 * a datum - a count, a status, a date - or it is nothing: restating the title in a sentence
 * costs a line on every page and says nothing.
 */

const props = defineProps<{
  title: string
  subtitle?: string | null
  breadcrumb?: Crumb[]
  loading?: boolean
}>()

const { setBreadcrumb } = useShell()

watchEffect(() => {
  setBreadcrumb(props.breadcrumb ?? [{ label: props.title }], props.title)
})
</script>

<template>
  <header class="mb-5 flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h1 class="text-2xl font-bold leading-tight tracking-tight">{{ title }}</h1>
      <p v-if="subtitle && !loading" class="mt-0.5 text-[13px] tabular text-base-content/55">{{ subtitle }}</p>
      <div v-else-if="loading" class="mt-1.5 h-3 w-40 rounded-lg skeleton-line" />
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
