/**
 * What the hub is busy with.
 *
 * A network scan takes a minute, a routine with a delay can take ten, a pairing blocks until
 * the accessory answers. Each of them is a task here: a title, its steps, a progress between
 * 0 and 1, and an end - done, failed with the reason, or cancelled. The console draws them as
 * task rows and every change goes out on the bus as `task.updated`, live only: a task is
 * about now, and the timeline already records what finished.
 *
 * A task can be retried when the work that produced it registered a runner for its kind.
 * The retry payload stays in this process: a pairing retry holds a setup code, and nothing
 * returned over HTTP may carry one. The public view says `retryable`, nothing more.
 */

import { randomUUID } from 'node:crypto'
import type { ScanPhaseProgress } from '@sway-home/discovery'
import { bus } from '#services/event_bus'

export type TaskKind = 'scan' | 'routine' | 'pairing' | 'agent'
export type TaskStatus = 'running' | 'failed' | 'done' | 'cancelled'
export type TaskStepStatus = 'pending' | 'running' | 'done' | 'failed'

export interface TaskStep {
  id: string
  label: string
  status: TaskStepStatus
  detail: string | null
}

/** What leaves the hub. */
export interface HubTask {
  id: string
  kind: TaskKind
  title: string
  subtitle: string | null
  status: TaskStatus
  progress: number | null
  steps: TaskStep[]
  error: string | null
  startedAt: string
  finishedAt: string | null
  retryable: boolean
  cancellable: boolean
}

interface Entry {
  task: HubTask
  retry: Record<string, unknown> | null
  onCancel: (() => void) | null
  /** Order of the end, since two tasks can finish within the same millisecond. */
  endedSeq: number
}

export interface TaskHandle {
  id: string
  step(index: number, status: TaskStepStatus, detail?: string | null): void
  progress(value: number): void
  subtitle(value: string | null): void
  done(subtitle?: string | null): void
  fail(error: string): void
}

const MAX_LISTED = 20
/** A finished task stays in the list for an hour: long enough to be noticed, then gone. */
const KEEP_FINISHED_MS = 60 * 60_000

const entries = new Map<string, Entry>()
let ended = 0
const runners = new Map<TaskKind, (payload: Record<string, unknown>) => Promise<unknown>>()

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function publish(entry: Entry): void {
  bus.publish('task.updated', { subjectType: 'system', subjectId: entry.task.id, payload: { ...view(entry) } })
}

function view(entry: Entry): HubTask {
  return {
    ...entry.task,
    steps: entry.task.steps.map((step) => ({ ...step })),
    retryable: (entry.task.status === 'failed' || entry.task.status === 'cancelled') && entry.retry !== null && runners.has(entry.task.kind),
    cancellable: entry.task.status === 'running' && entry.onCancel !== null,
  }
}

function prune(): void {
  const now = Date.now()
  for (const [id, entry] of entries) {
    if (entry.task.finishedAt && now - Date.parse(entry.task.finishedAt) > KEEP_FINISHED_MS) entries.delete(id)
  }
}

export const tasks = {
  start(input: {
    kind: TaskKind
    title: string
    subtitle?: string | null
    steps?: string[]
    retry?: Record<string, unknown>
    onCancel?: () => void
  }): TaskHandle {
    prune()
    const entry: Entry = {
      task: {
        id: randomUUID(),
        kind: input.kind,
        title: input.title,
        subtitle: input.subtitle ?? null,
        status: 'running',
        progress: input.steps?.length ? 0 : null,
        steps: (input.steps ?? []).map((label, index) => ({ id: String(index), label, status: 'pending', detail: null })),
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        retryable: false,
        cancellable: false,
      },
      retry: input.retry ?? null,
      onCancel: input.onCancel ?? null,
      endedSeq: 0,
    }
    entries.set(entry.task.id, entry)
    publish(entry)

    const live = () => entry.task.status === 'running'
    const handle: TaskHandle = {
      id: entry.task.id,
      step(index, status, detail) {
        const step = entry.task.steps[index]
        if (!live() || !step) return
        step.status = status
        if (detail !== undefined) step.detail = detail
        publish(entry)
      },
      progress(value) {
        if (!live()) return
        entry.task.progress = clamp(value)
        publish(entry)
      },
      subtitle(value) {
        if (!live()) return
        entry.task.subtitle = value
        publish(entry)
      },
      done(subtitle) {
        if (!live()) return
        entry.task.status = 'done'
        entry.task.progress = 1
        for (const step of entry.task.steps) if (step.status === 'running' || step.status === 'pending') step.status = 'done'
        if (subtitle !== undefined) entry.task.subtitle = subtitle
        entry.task.finishedAt = new Date().toISOString()
        entry.endedSeq = ++ended
        publish(entry)
      },
      fail(error) {
        if (!live()) return
        entry.task.status = 'failed'
        entry.task.error = error
        for (const step of entry.task.steps) if (step.status === 'running') step.status = 'failed'
        entry.task.finishedAt = new Date().toISOString()
        entry.endedSeq = ++ended
        publish(entry)
      },
    }
    return handle
  },

  /** Running first, then the latest finished; twenty at most. */
  list(): HubTask[] {
    prune()
    const all = [...entries.values()]
    const running = all.filter((entry) => entry.task.status === 'running').reverse()
    const finished = all
      .filter((entry) => entry.task.status !== 'running')
      .sort((a, b) => b.endedSeq - a.endedSeq)
    return [...running, ...finished].slice(0, MAX_LISTED).map(view)
  },

  find(id: string): HubTask | null {
    const entry = entries.get(id)
    return entry ? view(entry) : null
  },

  /** Asks the work to stop. The task is marked cancelled at once; the work stops when it can. */
  cancel(id: string): boolean {
    const entry = entries.get(id)
    if (!entry || entry.task.status !== 'running' || !entry.onCancel) return false
    entry.task.status = 'cancelled'
    entry.task.finishedAt = new Date().toISOString()
    entry.endedSeq = ++ended
    for (const step of entry.task.steps) if (step.status === 'running') step.status = 'failed'
    const stop = entry.onCancel
    entry.onCancel = null
    publish(entry)
    stop()
    return true
  },

  /** Runs the same work again from what the hub kept. Only a failed or cancelled task. */
  async retry(id: string): Promise<boolean> {
    const entry = entries.get(id)
    if (!entry || (entry.task.status !== 'failed' && entry.task.status !== 'cancelled') || !entry.retry) return false
    const runner = runners.get(entry.task.kind)
    if (!runner) return false
    // Started, not awaited: a retried scan reports through its own new task.
    void runner(entry.retry).catch(() => undefined)
    return true
  },

  registerRunner(kind: TaskKind, runner: (payload: Record<string, unknown>) => Promise<unknown>): void {
    runners.set(kind, runner)
  },

  /** Tests only. */
  reset(): void {
    entries.clear()
  },
}

// ---------------------------------------------------------------------------------------
// Scan phases as steps
// ---------------------------------------------------------------------------------------

export const SCAN_PHASES: { id: ScanPhaseProgress['phase']; label: string }[] = [
  { id: 'arp', label: 'Table ARP' },
  { id: 'mdns', label: 'mDNS' },
  { id: 'ssdp', label: 'SSDP' },
  { id: 'sweep', label: 'Balayage TCP' },
  { id: 'deep', label: 'Ports étendus' },
  { id: 'names', label: 'Noms' },
  { id: 'http', label: 'Pages web' },
  { id: 'fingerprint', label: 'Empreintes' },
]

/** Where a scan is: the step it is on, what to say about it, and the overall progress. */
export function scanPhaseState(phase: ScanPhaseProgress): { index: number; detail: string; progress: number } {
  const index = Math.max(0, SCAN_PHASES.findIndex((candidate) => candidate.id === phase.phase))
  const within = phase.total > 0 ? clamp(phase.done / phase.total) : 0
  const found = `${phase.found} hôte${phase.found > 1 ? 's' : ''}`
  const detail = phase.total > 1 ? `${phase.done}/${phase.total}, ${found}` : found
  return { index, detail, progress: (index + within) / SCAN_PHASES.length }
}
