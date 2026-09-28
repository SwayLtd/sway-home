/**
 * The shell: the rail, the header, the quick-tool dock, and the breadcrumb.
 *
 * The default state is *empty*: no rail, no dock, nothing but the assistant. This is an OS
 * for talking to a house, and navigation is what you reach for when talking is not enough -
 * so the rail hides until the pointer goes looking for it on the left edge, and stays only
 * if someone pins it.
 *
 * `AdminPageHeader` publishes its breadcrumb to the app header rather than rendering one,
 * so there is exactly one breadcrumb on screen and a page never has to know where the
 * chrome puts it. That indirection is the whole reason this composable exists.
 */

export interface Crumb {
  label: string
  to?: string
  icon?: string
}

export type QuickTool = 'agent' | 'timeline' | 'scan' | 'proposals' | 'help' | null

export function useShell() {
  /** Pinned: the rail keeps a column of its own and the body shifts over. Off by default. */
  const railPinned = useState('shell-rail-pinned', () => false)
  /** Peeking: the pointer is in the left hot zone, so the rail floats over the page. */
  const railPeeking = useState('shell-rail-peeking', () => false)
  const dockTool = useState<QuickTool>('shell-dock', () => null)
  const dockWidth = useState('shell-dock-width', () => 384)
  const breadcrumb = useState<Crumb[]>('shell-breadcrumb', () => [])
  const pageTitle = useState('shell-title', () => 'Sway Home')
  const commandPaletteOpen = useState('shell-palette', () => false)

  const railVisible = computed(() => railPinned.value || railPeeking.value)
  const dockOpen = computed(() => dockTool.value !== null)

  function setBreadcrumb(crumbs: Crumb[], title?: string): void {
    breadcrumb.value = crumbs
    if (title) pageTitle.value = title
    if (import.meta.client) document.title = `${title ?? crumbs.at(-1)?.label ?? 'Sway Home'} · Sway Home`
  }

  function toggleDock(tool: Exclude<QuickTool, null>): void {
    dockTool.value = dockTool.value === tool ? null : tool
  }

  /**
   * The geometry the layout is built from. Only a *pinned* rail takes width: while peeking
   * it floats above the page, because a page that reflows every time the pointer brushes the
   * left edge is unusable.
   */
  const shellStyle = computed(() => ({
    // The rail is a 13rem card with a 0.5rem margin on each side, so a pinned rail pushes
    // the page by 14rem. Floating (peeking), it pushes nothing.
    '--admin-rail-w': railPinned.value ? '14rem' : '0rem',
    '--admin-rail-panel-w': '13rem',
    // The dock's card is 1rem narrower than the lane it reserves, for the same margins.
    '--admin-dock-w': dockOpen.value ? `${dockWidth.value + 16}px` : '0px',
  }))

  return {
    railPinned,
    railPeeking,
    railVisible,
    dockTool,
    dockOpen,
    dockWidth,
    breadcrumb,
    pageTitle,
    commandPaletteOpen,
    setBreadcrumb,
    toggleDock,
    shellStyle,
  }
}

export interface NavItem {
  label: string
  to: string
  icon: string
  /** Shown as a count pill on the rail row. */
  badge?: () => number | null
  section: 'house' | 'intelligence' | 'system'
}

/**
 * The rail, in order. Named `navigationItems` rather than `navigation` because the DOM has a
 * global `Navigation` type and the auto-import resolves to that instead under vue-tsc.
 */
export function navigationItems(): NavItem[] {
  const { house } = useHouse()

  return [
    { label: 'Assistant', to: '/', icon: 'ph:sparkle', section: 'house' },
    { label: 'Appareils', to: '/devices', icon: 'ph:lightbulb-filament', section: 'house', badge: () => house.value?.counts.total ?? null },
    { label: 'Pièces', to: '/areas', icon: 'ph:house-line', section: 'house' },
    { label: 'Scènes', to: '/scenes', icon: 'ph:sparkle', section: 'house' },
    { label: 'Énergie', to: '/energy', icon: 'ph:lightning', section: 'house' },

    { label: 'Conversations', to: '/agent', icon: 'ph:chat-circle-dots', section: 'intelligence' },
    { label: 'Routines', to: '/routines', icon: 'ph:flow-arrow', section: 'intelligence', badge: () => house.value?.suggestions || null },
    { label: 'Mémoire', to: '/memory', icon: 'ph:brain', section: 'intelligence' },
    { label: 'Journal', to: '/timeline', icon: 'ph:clock-counter-clockwise', section: 'intelligence' },

    { label: 'Réseau', to: '/network', icon: 'ph:wifi-high', section: 'system' },
    { label: 'Intégrations', to: '/integrations', icon: 'ph:puzzle-piece', section: 'system' },
    { label: 'Diagnostics', to: '/diagnostics', icon: 'ph:heartbeat', section: 'system' },
    { label: 'Réglages', to: '/settings', icon: 'ph:sliders-horizontal', section: 'system' },
  ]
}

export const SECTION_LABEL: Record<NavItem['section'], string> = {
  house: 'Maison',
  intelligence: 'Intelligence',
  system: 'Système',
}

/**
 * When one row's path prefixes another's, the deepest match wins. Otherwise `/devices`
 * stays lit while the reader is on `/devices/abc`, and two rows look selected at once.
 */
export function isRowActive(item: NavItem, path: string, all: NavItem[]): boolean {
  if (item.to === '/') return path === '/'
  if (!path.startsWith(item.to)) return false
  return !all.some((other) => other !== item && other.to.length > item.to.length && path.startsWith(other.to))
}
