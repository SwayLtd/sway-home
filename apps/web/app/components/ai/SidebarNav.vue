<script setup lang="ts">
/**
 * SIDEBAR NAV - the app's left rail: workspace switcher, primary navigation, searchable
 * conversation history, and a collapse that keeps every icon aligned (Beautiful UI).
 *
 * Generic and data-driven: it renders whatever `items` (optionally grouped by `sections`),
 * `history` and `workspace(s)` are passed to it - it has no idea what a "house" or a route is.
 * It is meant to replace the rail in apps/web/app/layouts/default.vue, wired to
 * composables/useShell.ts (navigationItems, SECTION_LABEL, isRowActive); this file does not
 * touch that layout.
 *
 * v-model:collapsed toggles between the full rail and a 52px icon-only strip. Icons never
 * move; only the `.sidebar-copy` text fades and slides out (see ai.css `[data-sidebar-collapsed]`).
 */
import type { CSSProperties } from 'vue'

const ROW_CLASS =
  'sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-[8px] px-2 text-left transition-[width,background-color,color,transform] duration-150 active:scale-[0.98]'

const SIDEBAR_MOTION = {
  expandedWidth: 224,
  collapsedWidth: 52,
  duration: 280,
  copyDuration: 180,
  copyOffset: 8,
  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
}

/*
 * CHAT SEARCH STORYBOARD
 *   0ms   search is triggered, the history label begins fading
 *   0ms   field grows right to left from the search control
 * 180ms   field fills the row, the caret is focused and ready
 */
const CHAT_SEARCH_MOTION = { duration: 180, closedWidth: 28, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }

const props = withDefaults(
  defineProps<{
    /** The current house (or property) shown in the workspace switcher. */
    workspace: SidebarNavWorkspace
    /** Every house the switcher can move between. Defaults to just `workspace`. */
    workspaces?: SidebarNavWorkspace[]
    /** Extra rows under the workspace list in the switcher menu (e.g. a settings link). */
    workspaceActions?: SidebarNavAction[]
    /** Primary navigation rows, optionally tagged with a `section` key. */
    items?: SidebarNavItem[]
    /** Section headers, in display order. Omit to render `items` as one flat list. */
    sections?: SidebarNavSection[]
    /** id of the currently active item (usually resolved from the route by the integrator). */
    active?: string | null
    /** Conversation history, newest first; the component filters it against the search field. */
    history?: SidebarNavHistoryEntry[]
    /** id of the open conversation, if any. */
    activeHistoryId?: string | null
    /** Optional banner/button pinned above the bottom edge, below the history list. */
    footer?: SidebarNavAction | null
    /** Fill the parent's height instead of the demo's fixed 600px column. */
    fill?: boolean
    newChatLabel?: string
    historyLabel?: string
  }>(),
  {
    workspaces: undefined,
    workspaceActions: () => [],
    items: () => [],
    sections: undefined,
    active: null,
    history: () => [],
    activeHistoryId: null,
    footer: null,
    fill: false,
    newChatLabel: 'Nouvelle conversation',
    historyLabel: 'Historique',
  }
)

const emit = defineEmits<{
  /** A primary nav row or an action row (workspace menu, footer) was picked. */
  navigate: [item: SidebarNavEmittedItem]
  newChat: []
  openChat: [id: string]
  switchWorkspace: [id: string]
}>()

const collapsed = defineModel<boolean>('collapsed', { default: false })

const groups = computed(() => sidebarNavGroupItems(props.items ?? [], props.sections))
const workspaceList = computed(() => (props.workspaces && props.workspaces.length > 0 ? props.workspaces : [props.workspace]))

const rootStyle = computed<CSSProperties>(() => ({
  width: `${collapsed.value ? SIDEBAR_MOTION.collapsedWidth : SIDEBAR_MOTION.expandedWidth}px`,
  transitionDuration: `${SIDEBAR_MOTION.duration}ms`,
  transitionTimingFunction: SIDEBAR_MOTION.easing,
  '--sidebar-copy-duration': `${SIDEBAR_MOTION.copyDuration}ms`,
  '--sidebar-copy-offset': `${SIDEBAR_MOTION.copyOffset}px`,
  '--sidebar-easing': SIDEBAR_MOTION.easing,
}))

function isActive(item: SidebarNavItem) {
  return props.active != null && item.id === props.active
}

function handleNavClick(item: SidebarNavItem) {
  emit('navigate', item)
}

function handleHistoryClick(entry: SidebarNavHistoryEntry) {
  emit('openChat', entry.id)
}

function handleFooterClick() {
  if (props.footer) emit('navigate', props.footer)
}

/* ---- collapse / expand ------------------------------------------------- */

function collapse() {
  collapsed.value = true
  workspaceOpen.value = false
  searchOpen.value = false
  query.value = ''
}
function expand() {
  collapsed.value = false
}

/* ---- workspace switcher: a position-tracked popover, portaled to body -- */

const workspaceButtonRef = ref<HTMLButtonElement | null>(null)
const workspaceOpen = ref(false)
const workspacePosition = ref({ top: 0, left: 0 })

function toggleWorkspaceMenu() {
  if (workspaceOpen.value) {
    workspaceOpen.value = false
    return
  }
  const el = workspaceButtonRef.value
  if (el) {
    const rect = el.getBoundingClientRect()
    workspacePosition.value = { top: rect.bottom + 6, left: rect.left }
  }
  workspaceOpen.value = true
}

function pickWorkspace(id: string) {
  if (id !== props.workspace.id) emit('switchWorkspace', id)
  workspaceOpen.value = false
}
function pickWorkspaceAction(action: SidebarNavAction) {
  emit('navigate', action)
  workspaceOpen.value = false
}

function onWorkspaceOutside(event: PointerEvent) {
  const target = event.target as Element | null
  if (!target) return
  if (!target.closest('[data-workspace-trigger]') && !target.closest('[data-workspace-menu]')) workspaceOpen.value = false
}
function onWorkspaceKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') workspaceOpen.value = false
}
watch(workspaceOpen, (open) => {
  if (open) {
    document.addEventListener('pointerdown', onWorkspaceOutside)
    document.addEventListener('keydown', onWorkspaceKeydown)
  } else {
    document.removeEventListener('pointerdown', onWorkspaceOutside)
    document.removeEventListener('keydown', onWorkspaceKeydown)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onWorkspaceOutside)
  document.removeEventListener('keydown', onWorkspaceKeydown)
})

/* ---- chat search --------------------------------------------------------
 * The field is always mounted (never v-if'd away) so its width/opacity can
 * animate; only pointer-events and ARIA toggle with `searchOpen`. */

const searchOpen = ref(false)
const query = ref('')
const searchInputRef = ref<HTMLInputElement | null>(null)
const visibleHistory = computed(() => sidebarNavFilterHistory(props.history ?? [], query.value))

watch(searchOpen, async (open) => {
  if (!open) return
  await nextTick()
  searchInputRef.value?.focus()
})

function closeSearch() {
  searchOpen.value = false
  query.value = ''
}
</script>

<template>
  <aside
    :data-sidebar-collapsed="collapsed"
    aria-label="Navigation principale"
    class="relative flex shrink-0 overflow-hidden transition-[width]"
    :class="fill ? 'h-full' : 'h-[600px]'"
    :style="rootStyle"
  >
    <div class="flex min-h-0 w-[224px] shrink-0 flex-col">
      <!-- workspace switcher -->
      <div class="relative mb-2.5 h-10 shrink-0">
        <button
          ref="workspaceButtonRef"
          data-workspace-trigger
          type="button"
          :aria-expanded="workspaceOpen"
          :aria-hidden="collapsed"
          :tabindex="collapsed ? -1 : 0"
          class="sidebar-workspace-control absolute left-2 top-1 flex h-8 w-[164px] items-center rounded-[8px] px-2 text-left transition-[background-color,transform] duration-100 hover:bg-hover-2 active:scale-[0.99]"
          @click="toggleWorkspaceMenu"
        >
          <span class="sidebar-logo flex size-5 shrink-0 items-center justify-center text-ink">
            <Icon name="ph:house-line-fill" class="size-[18px]" />
          </span>
          <span class="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-ink-2">{{ workspace.name }}</span>
          <span class="sidebar-copy ml-1 flex shrink-0 text-ink-3">
            <Icon name="ph:caret-down" class="size-4" />
          </span>
        </button>

        <Teleport to="body">
          <div
            v-if="workspaceOpen"
            data-workspace-menu
            class="fixed z-50 w-64 rounded-[14px] bg-surface p-1.5 shadow-overlay"
            :style="{ top: `${workspacePosition.top}px`, left: `${workspacePosition.left}px`, animation: 'pop-in 180ms cubic-bezier(0.23,1,0.32,1) both', transformOrigin: 'top left' }"
          >
            <AiGlideMenu class="flex flex-col gap-px" highlight-class="inset-x-0 rounded-[8px] bg-hover-2">
              <button
                v-for="ws in workspaceList"
                :key="ws.id"
                data-menu-row
                type="button"
                class="relative z-10 flex w-full items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-left"
                @click="pickWorkspace(ws.id)"
              >
                <span class="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-ink text-[11px] font-semibold text-surface">
                  {{ ws.monogram ?? ws.name.charAt(0) }}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[13.5px] font-medium text-ink">{{ ws.name }}</span>
                  <span v-if="ws.subtitle" class="block truncate text-[11.5px] text-ink-3">{{ ws.subtitle }}</span>
                </span>
                <span v-if="ws.id === workspace.id" class="shrink-0 text-ink"><Icon name="ph:check" class="size-[18px]" /></span>
              </button>

              <template v-if="workspaceActions && workspaceActions.length">
                <div class="my-1 h-px bg-line" />
                <button
                  v-for="action in workspaceActions"
                  :key="action.id"
                  data-menu-row
                  type="button"
                  class="relative z-10 flex h-9 w-full items-center gap-1.5 rounded-[8px] px-2 text-left"
                  @click="pickWorkspaceAction(action)"
                >
                  <span v-if="action.icon" class="flex size-5 shrink-0 items-center justify-center text-ink-2">
                    <Icon :name="action.icon" class="size-4" />
                  </span>
                  <span class="min-w-0 flex-1 truncate text-[13.5px] text-ink">{{ action.label }}</span>
                </button>
              </template>
            </AiGlideMenu>
          </div>
        </Teleport>

        <button
          type="button"
          aria-label="Réduire le menu"
          :aria-hidden="collapsed"
          :tabindex="collapsed ? -1 : 0"
          class="sidebar-collapse-control absolute right-2 top-1 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          @click="collapse"
        >
          <Icon name="ph:sidebar-simple" class="size-[18px]" />
        </button>
        <button
          type="button"
          aria-label="Déployer le menu"
          :aria-hidden="!collapsed"
          :tabindex="collapsed ? 0 : -1"
          class="sidebar-expand-control absolute left-2 top-0.5 flex size-9 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          @click="expand"
        >
          <Icon name="ph:sidebar-simple" class="size-[18px] rotate-180" />
        </button>
      </div>

      <!-- new conversation -->
      <AiGlideMenu row-selector="[data-row]" highlight-class="sidebar-glide-highlight rounded-[7px] bg-hover-2" class="group/glide flex flex-col gap-px">
        <button :class="ROW_CLASS" data-row type="button" @click="emit('newChat')">
          <span class="flex size-5 shrink-0 items-center justify-center text-ink-2">
            <Icon name="ph:note-pencil" class="size-[18px]" />
          </span>
          <span class="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-ink-2">{{ newChatLabel }}</span>
        </button>
      </AiGlideMenu>

      <!-- primary navigation, grouped into sections when the integrator supplies them -->
      <div v-for="group in groups" :key="group.key || 'ungrouped'" class="mt-3">
        <p v-if="group.label" class="sidebar-copy px-4 pb-1 text-[11px] font-medium uppercase tracking-wider text-ink-3">{{ group.label }}</p>
        <AiGlideMenu row-selector="[data-row]" highlight-class="sidebar-glide-highlight rounded-[7px] bg-hover-2" class="group/glide flex flex-col gap-px">
          <component
            :is="item.to ? 'NuxtLink' : 'button'"
            v-for="item in group.items"
            :key="item.id"
            data-row
            :to="item.to"
            :type="item.to ? undefined : 'button'"
            :title="item.label"
            :class="[ROW_CLASS, isActive(item) ? 'bg-hover-2 group-hover/glide:bg-transparent' : '']"
            @click="handleNavClick(item)"
          >
            <span class="flex size-5 shrink-0 items-center justify-center" :class="isActive(item) ? 'text-ink' : 'text-ink-2'">
              <Icon :name="item.icon" class="size-[18px]" />
            </span>
            <span class="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium" :class="isActive(item) ? 'text-ink' : 'text-ink-2'">
              {{ item.label }}
            </span>
            <span v-if="item.badge" class="sidebar-copy mr-2 shrink-0 text-[12px] font-medium tabular-nums text-ink-3">{{ item.badge }}</span>
          </component>
        </AiGlideMenu>
      </div>

      <!-- searchable conversation history -->
      <div class="mt-3 min-h-0 flex-1 overflow-y-auto">
        <div class="sidebar-copy relative mx-2 mb-1 h-8">
          <div
            aria-hidden="true"
            class="absolute inset-0 flex items-center gap-1.5 px-2 text-[12.5px] font-medium text-ink-3 transition-[opacity,transform]"
            :class="searchOpen ? 'pointer-events-none -translate-x-1 opacity-0' : 'translate-x-0 opacity-100'"
            :style="{ transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms`, transitionTimingFunction: CHAT_SEARCH_MOTION.easing }"
          >
            <Icon name="ph:caret-down" class="size-4" />
            <span>{{ historyLabel }}</span>
          </div>

          <button
            type="button"
            aria-label="Rechercher dans les conversations"
            :aria-expanded="searchOpen"
            class="absolute right-0 top-0 z-10 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color,transform] hover:bg-hover-2 hover:text-ink active:scale-[0.96]"
            :class="searchOpen ? 'pointer-events-none opacity-0' : 'opacity-100'"
            :style="{ transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms` }"
            @click="searchOpen = true"
          >
            <Icon name="ph:magnifying-glass" class="size-4" />
          </button>

          <div
            class="absolute right-0 top-0 z-20 flex h-8 items-center overflow-hidden rounded-[8px] bg-field text-ink-3 shadow-hairline transition-[width,opacity] focus-within:text-ink-2"
            :class="searchOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'"
            :style="{
              width: searchOpen ? '100%' : `${CHAT_SEARCH_MOTION.closedWidth}px`,
              transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms`,
              transitionTimingFunction: CHAT_SEARCH_MOTION.easing,
            }"
          >
            <span class="ml-2 flex shrink-0 items-center justify-center"><Icon name="ph:magnifying-glass" class="size-[15px]" /></span>
            <input
              ref="searchInputRef"
              v-model="query"
              placeholder="Rechercher"
              aria-label="Rechercher une conversation"
              class="ml-1.5 min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-3"
              @keydown.esc="closeSearch"
            />
            <button
              type="button"
              aria-label="Fermer la recherche"
              class="flex size-8 shrink-0 items-center justify-center rounded-[8px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96]"
              @click="closeSearch"
            >
              <Icon name="ph:x" class="size-4" />
            </button>
          </div>
        </div>

        <AiGlideMenu row-selector="[data-row]" highlight-class="sidebar-glide-highlight rounded-[7px] bg-hover-2" class="group/glide flex flex-col gap-px">
          <button
            v-for="entry in visibleHistory"
            :key="entry.id"
            :class="[ROW_CLASS, entry.id === activeHistoryId ? 'bg-hover-2 group-hover/glide:bg-transparent' : '']"
            data-row
            type="button"
            :title="entry.title"
            @click="handleHistoryClick(entry)"
          >
            <span
              class="sidebar-copy min-w-0 flex-1 truncate text-[14px] font-medium"
              :class="entry.id === activeHistoryId ? 'text-ink' : 'text-ink-2'"
            >{{ entry.title }}</span>
            <span v-if="entry.at" class="sidebar-copy ml-1.5 shrink-0 text-[11px] tabular-nums text-ink-3">{{ entry.at }}</span>
          </button>
          <div v-if="query && visibleHistory.length === 0" class="sidebar-copy mx-2 px-2 py-2 text-[12.5px] text-ink-3">Aucune conversation trouvée</div>
        </AiGlideMenu>
      </div>

      <!-- optional footer banner (e.g. open alerts) -->
      <div v-if="footer" class="sidebar-copy mx-2 mt-3 w-[208px] border-t border-line pt-3">
        <button
          type="button"
          class="flex h-8 w-full items-center justify-center gap-1.5 rounded-control bg-hover-2 text-[12.5px] font-medium text-ink transition-[background-color,transform] duration-150 hover:bg-line-strong active:scale-[0.98]"
          @click="handleFooterClick"
        >
          <Icon v-if="footer.icon" :name="footer.icon" class="size-4" />
          {{ footer.label }}
        </button>
      </div>
    </div>
  </aside>
</template>
