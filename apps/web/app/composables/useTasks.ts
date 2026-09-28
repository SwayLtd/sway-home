/**
 * What the hub is busy with: a network scan, a routine that takes its time, a pairing.
 *
 * Loaded once from `/tasks`, then kept current by the `task.updated` events of the house
 * stream, which `useHouse().applyEvent` hands to `upsertTask`. The rows are mapped to the
 * agent kit's task rows here, once, so the dock, the network page and the gallery cannot
 * word the same task two ways.
 */

import type { TaskRowsTask } from '~/utils/aiTaskRows'

export type HubTaskKind = 'scan' | 'routine' | 'pairing' | 'agent'
export type HubTaskStatus = 'running' | 'failed' | 'done' | 'cancelled'

export interface HubTask {
  id: string
  kind: HubTaskKind
  title: string
  subtitle: string | null
  status: HubTaskStatus
  progress: number | null
  steps: { id: string; label: string; status: 'pending' | 'running' | 'done' | 'failed'; detail: string | null }[]
  error: string | null
  startedAt: string
  finishedAt: string | null
  retryable: boolean
  cancellable: boolean
}

/** As many as the hub keeps: the running ones and the last few that ended. */
const MAX_TASKS = 20

/** Running tasks first, newest first; then the ended ones, most recently ended first. */
function order(tasks: HubTask[]): HubTask[] {
  const running = tasks.filter((task) => task.status === 'running').sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const ended = tasks
    .filter((task) => task.status !== 'running')
    .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt))
  return [...running, ...ended].slice(0, MAX_TASKS)
}

/** Puts one task, as the stream sent it, into the list: replaced in place or added. */
export function upsertTask(list: HubTask[], task: HubTask): HubTask[] {
  const index = list.findIndex((entry) => entry.id === task.id)
  const next = index === -1 ? [task, ...list] : list.map((entry, position) => (position === index ? task : entry))
  return order(next)
}

export function toTaskRow(task: HubTask): TaskRowsTask {
  return {
    id: task.id,
    title: task.title,
    subtitle: task.subtitle ?? undefined,
    status: task.status,
    progress: task.progress ?? undefined,
    steps: task.steps.map((step) => ({ id: step.id, label: step.label, status: step.status, detail: step.detail ?? undefined })),
    error: task.error ?? undefined,
    startedAt: Date.parse(task.startedAt),
    finishedAt: task.finishedAt ? Date.parse(task.finishedAt) : undefined,
    retryable: task.retryable,
    cancellable: task.cancellable,
  }
}

export function useTasks() {
  const tasks = useState<HubTask[]>('hub-tasks', () => [])
  const error = ref<string | null>(null)

  async function load(): Promise<void> {
    try {
      tasks.value = order((await hubFetch<{ tasks: HubTask[] }>('/tasks')).tasks)
      error.value = null
    } catch (failure) {
      error.value = (failure as Error).message
    }
  }

  /** The hub answers 400 when the task cannot be cancelled or retried any more. */
  async function cancel(id: string): Promise<boolean> {
    return hubFetch<{ ok: boolean }>(`/tasks/${id}/cancel`, { method: 'POST' })
      .then((result) => result.ok)
      .catch(() => false)
  }

  async function retry(id: string): Promise<boolean> {
    return hubFetch<{ ok: boolean }>(`/tasks/${id}/retry`, { method: 'POST' })
      .then((result) => result.ok)
      .catch(() => false)
  }

  const rows = computed(() => tasks.value.map(toTaskRow))
  const running = computed(() => tasks.value.filter((task) => task.status === 'running'))

  return { tasks, rows, running, error, load, cancel, retry }
}
