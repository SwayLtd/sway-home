/**
 * "Apprendre une tâche": the house records what a person does by hand, and stopping turns
 * it into a suggested routine.
 *
 * The recording lives in the hub, so it survives a closed tab; this keeps its status, loaded
 * from `/teach` and then updated by the `teach.updated` events of the house stream (applied
 * in `useHouse().applyEvent`).
 */

export interface TaughtStep {
  deviceId: string
  deviceName: string
  state: Record<string, unknown>
  /** Epoch milliseconds. */
  at: number
}

export interface TeachStatus {
  active: boolean
  id: string | null
  title: string | null
  startedAt: string | null
  steps: TaughtStep[]
}

export const TEACH_IDLE: TeachStatus = { active: false, id: null, title: null, startedAt: null, steps: [] }

/** What stopping gives back: the routine the recording became, when anything was taught. */
export interface TeachResult {
  routine: { id: string; name: string } | null
  steps: TaughtStep[]
}

export function useTeach() {
  const status = useState<TeachStatus>('hub-teach', () => ({ ...TEACH_IDLE }))
  const busy = ref(false)
  const error = ref<string | null>(null)

  async function load(): Promise<void> {
    status.value = await hubFetch<TeachStatus>('/teach')
  }

  async function run<T>(work: () => Promise<T>): Promise<T | null> {
    busy.value = true
    error.value = null
    try {
      return await work()
    } catch (failure) {
      error.value = (failure as Error).message
      return null
    } finally {
      busy.value = false
      await load().catch(() => undefined)
    }
  }

  const start = (title?: string) => run(() => hubFetch<{ id: string; startedAt: string }>('/teach/start', { method: 'POST', body: { title: title ?? null } }))
  const stop = () => run(() => hubFetch<TeachResult>('/teach/stop', { method: 'POST' }))
  const cancel = () => run(() => hubFetch<{ ok: boolean }>('/teach/cancel', { method: 'POST' }))

  return { status, busy, error, load, start, stop, cancel }
}
