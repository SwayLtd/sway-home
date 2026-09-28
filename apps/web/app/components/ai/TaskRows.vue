<script setup lang="ts">
/**
 * TASK ROWS - long-running hub jobs (Beautiful UI).
 *
 *   Capsules   each task in its own shadowed card, gap between them
 *   List       compact rows joined in one card, divided by a rule
 *
 * A task's badge is a progress ring (a real arc when `progress` is set, an indeterminate spin
 * otherwise), a green check once done, or a red cross once failed - `cancelled` gets a neutral
 * cross. A running task with steps auto-opens its detail; the person can still open or close
 * any row by hand, which then wins over the auto behaviour for that row.
 *
 * Props: `variant` (default `preferences.tasks`), `tasks`, `labels?`.
 * Emits: `retry(id)`, `cancel(id)`.
 */
import type { TaskLayout } from '~/composables/useAiPreferences'
import type { TaskRowsLabels, TaskRowsTask } from '~/utils/aiTaskRows'

const props = withDefaults(defineProps<{ variant?: TaskLayout; tasks?: TaskRowsTask[]; labels?: Partial<TaskRowsLabels> }>(), {
  tasks: () => [],
})

const emit = defineEmits<{ retry: [id: string]; cancel: [id: string] }>()

const { preferences } = useAiPreferences()
const layout = computed<TaskLayout>(() => props.variant ?? preferences.value.tasks)
const copy = computed<TaskRowsLabels>(() => ({ ...TASKROWS_DEFAULT_LABELS, ...props.labels }))

/* Open state per task: a manual click always wins; otherwise a running task with steps opens
   on its own, exactly like the source's active row. */
const manualOpen = ref<Map<string, boolean>>(new Map())
function isOpen(task: TaskRowsTask) {
  return manualOpen.value.get(task.id) ?? taskRowsAutoOpen(task)
}
function toggle(task: TaskRowsTask) {
  const next = new Map(manualOpen.value)
  next.set(task.id, !isOpen(task))
  manualOpen.value = next
}
</script>

<template>
  <div class="flex w-full max-w-110 flex-col" :class="layout === 'List' ? 'gap-0 self-start overflow-hidden rounded-card bg-surface shadow-card' : 'min-h-[196px] gap-2'">
    <div
      v-for="(task, index) in tasks"
      :key="task.id"
      class="group self-stretch overflow-hidden transition-[border-radius,background-color] duration-300 hover:bg-inset"
      :class="layout === 'List' ? 'border-b border-line last:border-0' : 'bg-surface shadow-card'"
      :style="{
        borderRadius: layout === 'List' ? '0px' : isOpen(task) ? '14px' : '22px',
        animation: `fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${index * 80}ms both`,
      }"
    >
      <div
        role="button"
        tabindex="0"
        :aria-expanded="isOpen(task)"
        class="flex h-11 w-full cursor-pointer items-center gap-2.5 px-2.5 text-left"
        @click="toggle(task)"
        @keydown.enter="toggle(task)"
        @keydown.space.prevent="toggle(task)"
      >
        <span class="flex size-6 shrink-0 items-center justify-center">
          <span v-if="task.status === 'done'" class="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-green text-white" style="animation: pop-in 300ms cubic-bezier(0.23,1,0.32,1) both">
            <Icon name="ph:check-bold" class="size-[13px]" />
          </span>
          <span
            v-else-if="task.status === 'failed'"
            class="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-red text-white"
            style="animation: pop-in 300ms cubic-bezier(0.23,1,0.32,1) both"
          >
            <Icon name="ph:x-bold" class="size-3" />
          </span>
          <span
            v-else-if="task.status === 'cancelled'"
            class="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-hover-2 text-ink-3"
            style="animation: pop-in 300ms cubic-bezier(0.23,1,0.32,1) both"
          >
            <Icon name="ph:x-bold" class="size-3" />
          </span>
          <span v-else class="relative inline-flex shrink-0 items-center justify-center" style="width: 24px; height: 24px">
            <svg width="24" height="24" class="absolute inset-0" :style="taskRowsRingSpins(task) ? { animation: 'spin 1.1s linear infinite' } : undefined">
              <circle cx="12" cy="12" :r="TASKROWS_RING_RADIUS" fill="none" stroke="var(--line)" stroke-width="2" />
              <circle
                v-if="task.status === 'running'"
                cx="12" cy="12" :r="TASKROWS_RING_RADIUS" fill="none" stroke="var(--ink-3)" stroke-width="2" stroke-linecap="round"
                :stroke-dasharray="taskRowsRingDasharray(task)"
                :style="
                  taskRowsRingSpins(task)
                    ? { transformOrigin: '12px 12px' }
                    : { transformOrigin: '12px 12px', transform: 'rotate(-90deg)', transition: 'stroke-dasharray 400ms cubic-bezier(0.23,1,0.32,1)' }
                "
              />
            </svg>
          </span>
        </span>

        <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{{ task.title }}</span>
        <span v-if="task.subtitle" class="text-[12.5px] text-ink-2 tabular-nums">{{ task.subtitle }}</span>

        <span v-if="task.status === 'done'" class="inline-flex h-5.5 items-center rounded-full bg-green-tint px-2 text-[11.5px] font-medium text-green">{{ copy.done }}</span>
        <span v-else-if="task.status === 'cancelled'" class="inline-flex h-5.5 items-center rounded-full bg-hover-2 px-2 text-[11.5px] font-medium text-ink-3">{{ copy.cancelled }}</span>
        <span
          v-else-if="task.status === 'failed'"
          class="inline-flex h-5.5 items-center gap-1 rounded-full bg-red-tint py-0 pl-2 pr-1 text-[11.5px] font-medium text-red"
          style="animation: fade-in 200ms ease-out both"
        >
          {{ copy.failed }}
          <button
            v-if="task.retryable !== false"
            type="button"
            :aria-label="`Réessayer ${task.title}`"
            class="flex size-4 shrink-0 items-center justify-center rounded-full transition-colors duration-100 hover:bg-red hover:text-white"
            @click.stop="emit('retry', task.id)"
            @keydown.stop
          >
            <Icon name="ph:arrow-counter-clockwise" class="size-2.5" />
          </button>
        </span>

        <button
          v-if="task.status === 'running' && task.cancellable !== false"
          type="button"
          aria-label="Annuler"
          class="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-3 opacity-0 transition-opacity duration-100 hover:bg-hover-2 group-hover:opacity-100"
          @click.stop="emit('cancel', task.id)"
          @keydown.stop
        >
          <Icon name="ph:x" class="size-3" />
        </button>

        <span aria-hidden="true" class="-ml-2 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3">
          <Icon name="ph:caret-down" class="size-[15px] transition-transform duration-300" :style="{ transform: isOpen(task) ? 'rotate(180deg)' : 'rotate(0)' }" />
        </span>
      </div>

      <!-- dropdown detail - same expandable grammar as Chain of Thought -->
      <div
        class="grid transition-[grid-template-rows,opacity] duration-300"
        :style="{ gridTemplateRows: isOpen(task) ? '1fr' : '0fr', opacity: isOpen(task) ? 1 : 0, transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)' }"
      >
        <div class="overflow-hidden">
          <div class="mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-2.5">
            <span aria-hidden="true" class="mx-auto h-full w-px bg-line" />
            <div class="flex flex-col gap-1.5">
              <p v-if="task.error" class="text-[12px] text-red">{{ task.error }}</p>
              <div
                v-for="(step, j) in task.steps"
                :key="step.id"
                class="flex items-center justify-between gap-2"
                :style="isOpen(task) ? { animation: `fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${120 + j * 100}ms both` } : undefined"
              >
                <span class="flex min-w-0 items-center gap-1.5">
                  <Icon v-if="step.status === 'done'" name="ph:check" class="size-3 shrink-0 text-ink-3" />
                  <span v-else-if="step.status === 'running'" aria-hidden="true" class="size-2.5 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2" style="animation: spin 700ms linear infinite" />
                  <Icon v-else-if="step.status === 'failed'" name="ph:x" class="size-3 shrink-0 text-red" />
                  <span v-else aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-line-strong" />
                  <span class="truncate text-[12px] text-ink-2">{{ step.label }}</span>
                </span>
                <span v-if="step.detail" class="shrink-0 font-mono text-[11.5px] text-ink-3 tabular-nums">{{ step.detail }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
