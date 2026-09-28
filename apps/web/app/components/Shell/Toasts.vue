<script setup lang="ts">
/**
 * Notifications and undo.
 *
 * Two rules from the design language show up here. First, undo goes *beside the thing that
 * moved* wherever possible, and the toast is only the fallback for an action with no
 * on-screen anchor. Second, a critical alert is not a toast: it stays until it is dealt
 * with, because a leak that scrolls away is a leak nobody fixed.
 */

const { events, refresh } = useHouse()

interface Toast {
  id: string
  message: string
  title?: string
  severity: 'info' | 'notice' | 'warning' | 'critical'
  undoable: boolean
  at: number
}

const toasts = ref<Toast[]>([])

watch(
  () => events.value[0],
  (event) => {
    if (!event) return

    if (event.type === 'system.notice' || event.type === 'system.error') {
      push({
        id: event.id,
        title: String(event.payload.title ?? ''),
        message: String(event.payload.message ?? ''),
        severity: event.severity as Toast['severity'],
        undoable: false,
        at: Date.now(),
      })
    }

    // An alert is *not* toasted. The narrator turns it into a sentence and the assistant says
    // it in the conversation, which is where someone is already looking. A toast on top of
    // that is the same warning twice, and the one that can be swiped away is the one that
    // teaches people to swipe warnings away.

    // An action taken by the agent on its own is the one place a toast must carry an undo:
    // the reader did not do it, so the anchor they would otherwise reach for is not there.
    if (event.type === 'device.command_sent' && event.origin === 'agent') {
      push({
        id: event.id,
        message: `${event.payload.deviceName} · ${event.payload.command}`,
        title: "L'assistant a agi",
        severity: 'info',
        undoable: true,
        at: Date.now(),
      })
    }
  }
)

function push(toast: Toast) {
  if (toasts.value.some((existing) => existing.id === toast.id)) return
  toasts.value = [toast, ...toasts.value].slice(0, 4)
  if (toast.severity !== 'critical') {
    setTimeout(() => dismiss(toast.id), toast.undoable ? 9000 : 5000)
  }
}

function dismiss(id: string) {
  toasts.value = toasts.value.filter((toast) => toast.id !== id)
}

async function undo(id: string) {
  await hubFetch('/house/undo', { method: 'POST' })
  dismiss(id)
  await refresh()
}
</script>

<template>
  <Teleport to="body">
    <div class="pointer-events-none fixed bottom-20 right-4 z-[90] flex w-80 flex-col gap-2 lg:bottom-4">
      <TransitionGroup
        enter-active-class="transition duration-150 ease-out"
        leave-active-class="transition duration-100 ease-in"
        enter-from-class="opacity-0 translate-y-2"
        leave-to-class="opacity-0 translate-y-1"
      >
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="pointer-events-auto rounded-2xl border bg-base-100 p-3 shadow-lg"
          :class="toast.severity === 'critical' ? 'border-error/40' : toast.severity === 'warning' ? 'border-warning/40' : 'border-base-300'"
          role="status"
        >
          <div class="flex items-start gap-2">
            <Icon
              :name="toast.severity === 'critical' ? 'ph:warning-octagon-fill' : toast.severity === 'warning' ? 'ph:warning-fill' : 'ph:info-fill'"
              class="mt-0.5 size-4 shrink-0"
              :class="toast.severity === 'critical' ? 'text-error' : toast.severity === 'warning' ? 'text-warning' : 'text-base-content/40'"
            />
            <div class="min-w-0 flex-1">
              <p v-if="toast.title" class="text-[12px] font-semibold">{{ toast.title }}</p>
              <p class="text-[12px] text-base-content/70">{{ toast.message }}</p>
            </div>
            <button class="row-action grid size-6 place-items-center rounded-lg hover:bg-base-200" aria-label="Fermer" @click="dismiss(toast.id)">
              <Icon name="ph:x" class="size-3.5" />
            </button>
          </div>

          <button v-if="toast.undoable" class="btn btn-xs btn-outline mt-2 w-full" @click="undo(toast.id)">
            <Icon name="ph:arrow-counter-clockwise" class="size-3.5" />
            Annuler
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
