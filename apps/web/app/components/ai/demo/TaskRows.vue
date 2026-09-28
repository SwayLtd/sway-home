<script setup lang="ts">
/**
 * DEMO: AiTaskRows - replays the source's staged timeline (rows enter staggered, a ring sweeps,
 * a row expands, a task fails then is retried, another resolves to completed) with three French
 * smart-home jobs: a Zigbee pairing, a network scan and a routine run. Both variants render the
 * same shared timeline side by side, since they are two layouts of the same data.
 */
import type { TaskRowsTask } from '~/utils/aiTaskRows'

const ROUTINE_STEPS = [
  { id: 'volet', label: 'Lever le volet chambre', status: 'pending' as const, detail: 'brouillon' },
  { id: 'notif', label: 'Envoyer la notification', status: 'pending' as const, detail: 'brouillon' },
]

const INITIAL_TASKS: TaskRowsTask[] = [
  { id: 'pairing', title: 'Appairage des capteurs Zigbee', subtitle: '8 appareils', status: 'done' },
  {
    id: 'scan',
    title: 'Scan du réseau',
    subtitle: '7 appareils trouvés',
    status: 'running',
    progress: 0,
    steps: [
      { id: 'arp', label: 'Balayage ARP', status: 'done', detail: '24/24' },
      { id: 'mdns', label: 'Découverte mDNS', status: 'done', detail: '9/9' },
      { id: 'ssdp', label: 'Découverte SSDP', status: 'done', detail: '3/3' },
      { id: 'sweep', label: 'Balayage des ports', status: 'running', detail: '128/254' },
      { id: 'fingerprint', label: 'Identification des appareils', status: 'pending' },
    ],
  },
  {
    id: 'routine',
    title: 'Réveil en douceur',
    subtitle: '2 actions',
    status: 'queued',
    steps: ROUTINE_STEPS,
  },
]

const tasks = ref<TaskRowsTask[]>(INITIAL_TASKS.map((task) => ({ ...task })))
let timers: ReturnType<typeof setTimeout>[] = []

function clearTimers() {
  timers.forEach(clearTimeout)
  timers = []
}

function patchTask(id: string, patch: Partial<TaskRowsTask>) {
  tasks.value = tasks.value.map((task) => (task.id === id ? { ...task, ...patch } : task))
}

/* Absolute timeline, derived from the source's TICKS = [600, 900, 2400, 1400, 2400, 600]:
     600ms   the scan ring sweeps 0 -> 66%
    3900ms   the routine flips to failed
    5300ms   the routine resolves to completed (unless the person already clicked "Reessayer") */
function replay() {
  clearTimers()
  tasks.value = INITIAL_TASKS.map((task) => ({ ...task, steps: task.steps?.map((step) => ({ ...step })) }))
  timers.push(setTimeout(() => patchTask('scan', { progress: 0.66 }), 600))
  timers.push(setTimeout(() => patchTask('routine', { status: 'failed', error: 'La cafetière ne répond pas.' }), 3900))
  timers.push(
    setTimeout(() => {
      patchTask('routine', {
        status: 'done',
        error: undefined,
        steps: ROUTINE_STEPS.map((step) => ({ ...step, status: 'done', detail: 'fait' })),
      })
    }, 5300)
  )
}

function handleRetry(id: string) {
  clearTimers()
  patchTask(id, { status: 'running', error: undefined })
  timers.push(
    setTimeout(() => {
      patchTask(id, {
        status: 'done',
        steps: ROUTINE_STEPS.map((step) => ({ ...step, status: 'done', detail: 'fait' })),
      })
    }, 900)
  )
}

function handleCancel(id: string) {
  patchTask(id, { status: 'cancelled', progress: undefined })
}

replay()
onBeforeUnmount(clearTimers)
</script>

<template>
  <section class="grid gap-4 lg:grid-cols-2">
    <div>
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Capsules</p>
        <AiButton size="xs" variant="secondary" @click="replay">Rejouer</AiButton>
      </div>
      <div class="bg-canvas rounded-window p-6">
        <AiTaskRows variant="Capsules" :tasks="tasks" @retry="handleRetry" @cancel="handleCancel" />
      </div>
    </div>

    <div>
      <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-3">List</p>
      <div class="bg-canvas rounded-window p-6">
        <AiTaskRows variant="List" :tasks="tasks" @retry="handleRetry" @cancel="handleCancel" />
      </div>
    </div>
  </section>
</template>
