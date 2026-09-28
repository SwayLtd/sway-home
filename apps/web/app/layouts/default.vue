<script setup lang="ts">
/**
 * The shell.
 *
 * Geometry, in one place so no page ever has to know it:
 *  - Chrome (header, rail, dock) is one continuous `base-100` surface with no dividers.
 *  - The body is a fixed `base-200` frame, rounded at the top, bordered where it meets the
 *    chrome and nowhere else - a 1px line against the window edge lands on a fractional
 *    device pixel under display scaling and thickens into a visible nub.
 *  - The document scrolls, not `<main>`: that is what keeps `position: sticky` and every
 *    `getBoundingClientRect()` menu working.
 */

const { railPinned, railPeeking, railVisible, dockTool, dockOpen, dockWidth, breadcrumb, commandPaletteOpen, toggleDock, shellStyle } = useShell()
const { house, connected, refresh, failed } = useHouse()
const route = useRoute()
const items: NavItem[] = navigationItems()

/**
 * A page can ask for the whole rectangle. The assistant does: it is a conversation that
 * fills the screen, and a page gutter around it would turn it back into a panel.
 */
const fullBleed = computed(() => route.meta.fullBleed === true)

/**
 * On a full-bleed page the header is chrome too, and it hides like the rail does: a strip
 * against the top edge brings it back. Reaching for the rail brings it back as well, because
 * the pin control lives up there and a menu you cannot pin is a menu you have to re-summon
 * every single time.
 */
const headerPeeking = ref(false)
const chromeVisible = computed(() => !fullBleed.value || headerPeeking.value || railVisible.value)

let headerTimer: ReturnType<typeof setTimeout> | null = null
function peekHeader(open: boolean) {
  if (headerTimer) clearTimeout(headerTimer)
  if (open) {
    headerPeeking.value = true
    return
  }
  headerTimer = setTimeout(() => {
    headerPeeking.value = false
  }, 220)
}

useHubStream()

await useAsyncData('house-initial', () => refresh(), { server: false })

const sections = computed(() => {
  const groups: { key: NavItem['section']; label: string; items: NavItem[] }[] = []
  for (const section of ['house', 'intelligence', 'system'] as const) {
    groups.push({ key: section, label: SECTION_LABEL[section], items: items.filter((item) => item.section === section) })
  }
  return groups
})

const alertCount = computed(() => house.value?.openAlerts.length ?? 0)
const proposalCount = computed(() => house.value?.pendingProposals ?? 0)

const QUICK_TOOLS = [
  { id: 'agent' as const, icon: 'ph:chat-circle-dots', label: 'Assistant' },
  { id: 'timeline' as const, icon: 'ph:pulse', label: 'Activité' },
  { id: 'scan' as const, icon: 'ph:broadcast', label: 'Scan réseau' },
  { id: 'proposals' as const, icon: 'ph:seal-question', label: 'Propositions' },
]

// Dragging the dock edge. Kept here rather than in the dock so the pointer capture lives
// on the element that owns the width.
/**
 * The rail peeks when the pointer enters a narrow strip against the window edge, and closes
 * again shortly after it leaves. The delay is what makes it usable: without it, crossing the
 * gap between the hot zone and the panel closes the thing you were reaching for.
 */
let peekTimer: ReturnType<typeof setTimeout> | null = null
function peek(open: boolean) {
  if (peekTimer) clearTimeout(peekTimer)
  if (open) {
    railPeeking.value = true
    return
  }
  peekTimer = setTimeout(() => {
    railPeeking.value = false
  }, 220)
}

const dragging = ref(false)
function startDrag(event: PointerEvent) {
  dragging.value = true
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
}
function onDrag(event: PointerEvent) {
  if (!dragging.value) return
  const next = window.innerWidth - event.clientX
  dockWidth.value = Math.max(320, Math.min(Math.min(640, window.innerWidth * 0.45), next))
}
function endDrag() {
  dragging.value = false
}

defineShortcuts({
  k: { meta: true, handler: () => (commandPaletteOpen.value = true) },
})

function defineShortcuts(map: Record<string, { meta?: boolean; handler: () => void }>) {
  onMounted(() => {
    const listener = (event: KeyboardEvent) => {
      for (const [key, binding] of Object.entries(map)) {
        if (event.key.toLowerCase() !== key) continue
        if (binding.meta && !(event.metaKey || event.ctrlKey)) continue
        event.preventDefault()
        binding.handler()
      }
    }
    window.addEventListener('keydown', listener)
    onBeforeUnmount(() => window.removeEventListener('keydown', listener))
  })
}
</script>

<template>
  <!--
    One continuous canvas. The header, the rail and the dock float above it as rounded cards
    with a margin all round, so no edge of the window is ever a bar of a different colour:
    the page is the surface, and the chrome sits on it.
  -->
  <div
    class="bg-base-200 text-base-content"
    :class="fullBleed ? 'h-dvh overflow-hidden' : 'min-h-screen'"
    :style="shellStyle"
  >
    <!-- The strip that brings the header back on a full-bleed page -->
    <div
      v-if="fullBleed"
      class="fixed inset-x-0 top-0 z-30 h-3"
      aria-hidden="true"
      @pointerenter="peekHeader(true)"
      @pointerleave="peekHeader(false)"
    />

    <!-- App header -->
    <header
      class="fixed left-2 right-2 top-2 z-40 flex h-12 items-center gap-2 rounded-2xl border border-base-300 bg-base-100/95 pl-2 pr-3 shadow-sm backdrop-blur transition-transform duration-200"
      :class="chromeVisible ? 'translate-y-0' : '-translate-y-[calc(100%+1rem)]'"
      @pointerenter="peekHeader(true)"
      @pointerleave="peekHeader(false)"
    >
      <button
        class="btn btn-ghost btn-sm btn-square"
        :aria-label="railPinned ? 'Détacher le menu' : 'Épingler le menu'"
        :title="railPinned ? 'Détacher le menu' : 'Épingler le menu'"
        @click="railPinned = !railPinned"
      >
        <Icon :name="railPinned ? 'ph:sidebar-simple' : 'ph:sidebar'" class="size-5" />
      </button>

      <NuxtLink to="/" class="flex items-center gap-2 pr-1">
        <span class="grid size-6 place-items-center rounded-lg bg-base-content text-base-100">
          <Icon name="ph:house-line-fill" class="size-4" />
        </span>
        <span class="text-[13px] font-semibold tracking-tight">Sway Home</span>
      </NuxtLink>

      <!--
        Breadcrumb, published by the page, rendered once here. The element is always in the
        page sets its crumbs during its own setup, which on the server happens after this
        header has already been emitted: the server would render an empty breadcrumb and the
        client a full one, which is a hydration mismatch on every page. Client-side only,
        then - a breadcrumb is chrome, not content.
      -->
      <ClientOnly>
        <nav v-if="breadcrumb.length" class="hidden min-w-0 items-center gap-1 md:flex" aria-label="Fil d'Ariane">
          <span class="mx-1 text-base-content/25">/</span>
          <template v-for="(crumb, index) in breadcrumb" :key="crumb.label">
            <span v-if="index > 0" class="text-base-content/25">/</span>
            <NuxtLink
              v-if="crumb.to && index < breadcrumb.length - 1"
              :to="crumb.to"
              class="truncate rounded-lg px-1.5 py-0.5 text-[13px] text-base-content/60 transition-colors hover:bg-base-200 hover:text-base-content"
            >
              {{ crumb.label }}
            </NuxtLink>
            <span v-else class="truncate px-1.5 py-0.5 text-[13px] font-medium">{{ crumb.label }}</span>
          </template>
        </nav>
      </ClientOnly>

      <div class="flex-1" />

      <ShellModePill />

      <button class="btn btn-ghost btn-sm gap-2 text-[13px] font-normal text-base-content/60" @click="commandPaletteOpen = true">
        <Icon name="ph:magnifying-glass" class="size-4" />
        <span class="hidden lg:inline">Rechercher</span>
        <kbd class="hidden rounded border border-base-300 px-1 font-mono text-[10px] lg:inline">⌘K</kbd>
      </button>

      <span
        class="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] tabular"
        :class="connected ? 'text-base-content/50' : 'text-error'"
        :title="connected ? 'Flux temps réel connecté' : 'Flux temps réel interrompu'"
      >
        <span class="size-1.5 rounded-full" :class="connected ? 'bg-success live-dot' : 'bg-error'" />
        <span class="hidden sm:inline">{{ connected ? 'en direct' : 'reconnexion' }}</span>
      </span>

      <div class="mx-1 h-5 w-px bg-base-content/15" />

      <button
        v-for="tool in QUICK_TOOLS"
        :key="tool.id"
        class="btn btn-ghost btn-sm btn-square relative"
        :class="dockTool === tool.id ? 'bg-primary/25' : ''"
        :aria-label="tool.label"
        :title="tool.label"
        @click="toggleDock(tool.id)"
      >
        <Icon :name="tool.icon" class="size-5" />
        <span
          v-if="tool.id === 'proposals' && proposalCount > 0"
          class="absolute -right-0.5 -top-0.5 grid size-4 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-content tabular"
        >{{ proposalCount }}</span>
      </button>

      <ShellThemeToggle />
    </header>

    <!--
      The hot zone. A hidden rail needs somewhere to be reached for, and a strip against the
      window edge is the one target a pointer can hit without aiming - you throw the mouse
      left and it stops there.
    -->
    <div
      class="fixed bottom-0 left-0 top-3 z-20 hidden w-3 lg:block"
      aria-hidden="true"
      @pointerenter="peek(true)"
      @pointerleave="peek(false)"
    />

    <!-- Rail: a floating panel while peeking, a column of its own once pinned -->
    <aside
      class="fixed bottom-2 left-2 top-16 z-30 hidden flex-col overflow-y-auto overflow-x-hidden rounded-2xl border border-base-300 bg-base-100 pb-4 transition-[transform,box-shadow] duration-200 lg:flex thin-scroll"
      :class="[
        railVisible ? 'translate-x-0' : '-translate-x-[calc(100%+1rem)]',
        railPinned ? 'shadow-sm' : 'shadow-xl',
      ]"
      :style="{ width: 'var(--admin-rail-panel-w)' }"
      @pointerenter="peek(true)"
      @pointerleave="peek(false)"
    >
      <div v-for="section in sections" :key="section.key" class="px-2 pt-3">
        <p class="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-base-content/40">{{ section.label }}</p>

        <NuxtLink
          v-for="item in section.items"
          :key="item.to"
          :to="item.to"
          class="group relative flex h-9 items-center gap-2.5 rounded-lg px-2 text-[13px] transition-colors"
          :class="isRowActive(item, route.path, items) ? 'bg-primary/25 font-medium' : 'text-base-content/70 hover:bg-base-200 hover:text-base-content'"
        >
          <Icon :name="item.icon" class="size-[18px] shrink-0" />
          <span class="truncate">{{ item.label }}</span>
          <span
            v-if="item.badge?.()"
            class="ml-auto rounded-full bg-base-300 px-1.5 text-[11px] tabular text-base-content/60"
          >{{ item.badge() }}</span>
        </NuxtLink>
      </div>

      <div class="flex-1" />

      <NuxtLink
        v-if="alertCount > 0"
        to="/timeline?filter=alerts"
        class="mx-2 mt-3 flex items-center gap-2 rounded-lg border border-error/30 bg-error/10 px-2 py-2 text-[12px] text-error"
      >
        <Icon name="ph:warning" class="size-4 shrink-0" />
        <span class="truncate">{{ alertCount }} alerte{{ alertCount > 1 ? 's' : '' }}</span>
      </NuxtLink>
    </aside>

    <main
      class="relative transition-[padding] duration-200"
      :class="fullBleed ? 'h-dvh' : 'min-h-screen pt-16'"
      :style="{ paddingLeft: 'var(--admin-rail-w)', paddingRight: 'var(--admin-dock-w)' }"
    >
      <div :class="fullBleed ? 'pb-16 lg:pb-0' : 'p-4 pb-24 sm:p-6 lg:pb-8'">
        <div v-if="failed" class="mx-auto mb-4 max-w-7xl" :class="fullBleed ? 'p-4 pb-0' : ''">
          <div class="flex items-center gap-3 rounded-2xl border border-error/30 bg-error/10 p-4 text-sm">
            <Icon name="ph:plugs" class="size-5 shrink-0 text-error" />
            <div class="min-w-0 flex-1">
              <p class="font-medium">Le hub ne répond pas.</p>
              <p class="truncate text-base-content/60">{{ failed }}</p>
            </div>
            <button class="btn btn-sm admin-cta" @click="refresh()">Réessayer</button>
          </div>
        </div>

        <slot />
      </div>
    </main>

    <!-- Quick-tool dock -->
    <Transition
      enter-active-class="transition-transform duration-200 ease-out"
      leave-active-class="transition-transform duration-150 ease-in"
      enter-from-class="translate-x-full"
      leave-to-class="translate-x-full"
    >
      <aside
        v-if="dockOpen"
        class="fixed bottom-2 right-2 top-16 z-40 flex flex-col overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-xl"
        :style="{ width: 'calc(var(--admin-dock-w) - 1rem)' }"
      >
        <div
          class="absolute inset-y-0 left-0 w-1 cursor-col-resize touch-none hover:bg-primary/40"
          :class="dragging ? 'bg-primary/40' : ''"
          @pointerdown="startDrag"
          @pointermove="onDrag"
          @pointerup="endDrag"
          @pointercancel="endDrag"
        />
        <ShellDock />
      </aside>
    </Transition>

    <!-- Mobile navigation: a different layout, not a narrower one -->
    <nav class="fixed inset-x-0 bottom-0 z-40 flex h-16 items-center justify-around border-t border-base-300 bg-base-100 px-2 lg:hidden">
      <NuxtLink
        v-for="item in [items[0], items[1], items[5], items[6], items[12]].filter(Boolean)"
        :key="item!.to"
        :to="item!.to"
        class="flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[10px]"
        :class="isRowActive(item!, route.path, items) ? 'bg-primary/25 font-medium' : 'text-base-content/60'"
      >
        <Icon :name="item!.icon" class="size-5" />
        <span class="truncate">{{ item!.label }}</span>
      </NuxtLink>
    </nav>

    <ShellCommandPalette />
    <ShellToasts />
  </div>
</template>
