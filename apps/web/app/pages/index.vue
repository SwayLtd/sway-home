<script setup lang="ts">
/**
 * The home screen is the assistant. Nothing else.
 *
 * Not a dashboard with a prompt on top, and not a chat with a status bar, a banner and a
 * stack of notifications around it. One conversation, the whole rectangle, and the chrome -
 * header, rail, dock - hidden until someone reaches for it.
 *
 * What the house has to say goes *through* the assistant rather than around it: an alert
 * appears as a message in the conversation, at the moment it happens, the way a person would
 * mention it. A banner above the chat saying the same thing is the assistant admitting it is
 * only a chat box.
 *
 * The pinned dashboard stays reachable behind one line of text at the bottom, because
 * someone who took the trouble to pin tiles should be able to find them again.
 */

definePageMeta({ fullBleed: true })

const { widgets, loading: widgetsLoading, load: loadWidgets } = useWidgets()

/** Folded away, and it stays folded between visits unless someone opens it. */
const dashboardOpen = useState('home-dashboard-open', () => false)

watch(dashboardOpen, (open) => {
  if (open) void loadWidgets()
})

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && dashboardOpen.value) dashboardOpen.value = false
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const { setBreadcrumb } = useShell()
setBreadcrumb([{ label: 'Assistant' }], 'Assistant')
</script>

<template>
  <div class="flex h-dvh flex-col">
    <AgentChat hero class="min-h-0 flex-1" />

    <!-- The pinned dashboard, for whoever wants it -->
    <div class="mx-auto w-full max-w-3xl shrink-0 px-4 pb-2">
      <button
        class="flex w-full items-center justify-center gap-1.5 py-1 text-[12px] text-base-content/30 transition-colors hover:text-base-content/70"
        @click="dashboardOpen = !dashboardOpen"
      >
        <Icon :name="dashboardOpen ? 'ph:caret-down' : 'ph:caret-up'" class="size-3.5" />
        {{ dashboardOpen ? 'Masquer le tableau de bord' : 'Tableau de bord' }}
      </button>
    </div>

    <!--
      A drawer over the conversation, not a panel under it: opening the dashboard must not
      push the chat up and lose the reader's place in it.
    -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-if="dashboardOpen" class="fixed inset-0 z-40 bg-base-content/10 backdrop-blur-[2px]" @click="dashboardOpen = false" />
    </Transition>

    <Transition
      enter-active-class="transition-transform duration-200 ease-out"
      leave-active-class="transition-transform duration-150 ease-in"
      enter-from-class="translate-y-[calc(100%+1rem)]"
      leave-to-class="translate-y-[calc(100%+1rem)]"
    >
      <section
        v-if="dashboardOpen"
        class="fixed inset-x-2 bottom-2 z-50 flex max-h-[75vh] flex-col overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-2xl"
        role="dialog"
        aria-label="Tableau de bord"
      >
        <header class="flex shrink-0 items-center gap-2 border-b border-base-300 px-4 py-2.5">
          <Icon name="ph:squares-four" class="size-4 text-base-content/40" />
          <h2 class="flex-1 text-[13px] font-semibold">Tableau de bord</h2>
          <button class="btn btn-ghost btn-sm btn-square" aria-label="Fermer" @click="dashboardOpen = false">
            <Icon name="ph:x" class="size-4" />
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto p-4 thin-scroll">
          <div class="mx-auto max-w-6xl">
            <SkeletonGrid v-if="widgetsLoading" :count="4" />

            <EmptyState
              v-else-if="widgets.length === 0"
              icon="ph:squares-four"
              title="Aucune carte épinglée"
              description="Demandez à l'assistant de garder une carte sur le tableau de bord et elle apparaîtra ici."
            />

            <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <WidgetCard v-for="widget in widgets" :key="widget.id" :widget="widget" />
            </div>
          </div>
        </div>
      </section>
    </Transition>
  </div>
</template>
