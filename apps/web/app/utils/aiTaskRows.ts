/**
 * AiTaskRows - types and pure helpers (Beautiful UI).
 *
 * `variant` reuses the `TaskLayout` type from useAiPreferences (Capsules | List) rather than
 * redeclaring it here.
 */

export type TaskRowsTaskStatus = 'queued' | 'running' | 'failed' | 'done' | 'cancelled'
export type TaskRowsStepStatus = 'pending' | 'running' | 'done' | 'failed'

/** One line of a task's expandable detail: a scan phase, a routine action, a pairing step. */
export interface TaskRowsStep {
  id: string
  label: string
  status: TaskRowsStepStatus
  detail?: string
}

export interface TaskRowsTask {
  id: string
  title: string
  subtitle?: string
  status: TaskRowsTaskStatus
  /** 0..1. When set, the ring shows this fraction instead of an indeterminate spin. */
  progress?: number
  steps?: TaskRowsStep[]
  error?: string
  startedAt?: number
  finishedAt?: number
  /** False hides the retry button of a failed task: the work cannot be run again. */
  retryable?: boolean
  /** False hides the cancel button of a running task. */
  cancellable?: boolean
}

export interface TaskRowsLabels {
  done: string
  failed: string
  cancelled: string
}

export const TASKROWS_DEFAULT_LABELS: TaskRowsLabels = {
  done: 'Terminé',
  failed: 'Échec',
  cancelled: 'Annulé',
}

/** Ring geometry shared by every row: the source's 24px circle, 2px stroke. */
export const TASKROWS_RING_SIZE = 24
const TASKROWS_RING_STROKE = 2
export const TASKROWS_RING_RADIUS = (TASKROWS_RING_SIZE - TASKROWS_RING_STROKE) / 2
export const TASKROWS_RING_CIRCUMFERENCE = 2 * Math.PI * TASKROWS_RING_RADIUS

/** The ring's arc: the task's own progress when known, else the source's fixed 28% wedge. */
export function taskRowsRingDasharray(task: TaskRowsTask): string {
  const fraction = task.progress !== undefined ? Math.min(1, Math.max(0, task.progress)) : 0.28
  return `${TASKROWS_RING_CIRCUMFERENCE * fraction} ${TASKROWS_RING_CIRCUMFERENCE * (1 - fraction)}`
}

/** The ring spins only when progress is indeterminate - a real fraction holds still and fills. */
export function taskRowsRingSpins(task: TaskRowsTask): boolean {
  return task.status === 'running' && task.progress === undefined
}

/** A running task with steps auto-opens its detail, like the source's active row does. */
export function taskRowsAutoOpen(task: TaskRowsTask): boolean {
  return task.status === 'running' && (task.steps?.length ?? 0) > 0
}
