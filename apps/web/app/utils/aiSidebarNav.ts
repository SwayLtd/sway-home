/**
 * Types and pure helpers for AiSidebarNav (Beautiful UI's 13_SidebarNav.tsx).
 *
 * The rail itself is generic - it does not know about Sway's routes, sections or the house.
 * The integrator (eventually apps/web/app/layouts/default.vue) is expected to feed it
 * navigationItems() and SECTION_LABEL from composables/useShell.ts, the active route id, and
 * the conversation history.
 */

export interface SidebarNavItem {
  id: string
  label: string
  /** Phosphor icon name, e.g. "ph:sparkle". */
  icon: string
  to?: string
  /** Shown as a count pill. Falsy values (0, "", null, undefined) render nothing, same as the app's current rail. */
  badge?: number | string | null
  /** Grouping key, matched against SidebarNavSection.key. Items with no match fall into one ungrouped bucket. */
  section?: string
}

/** A section header, in the order it should appear. */
export interface SidebarNavSection {
  key: string
  label: string
}

export interface SidebarNavGroup {
  key: string
  label: string
  items: SidebarNavItem[]
}

export interface SidebarNavHistoryEntry {
  id: string
  title: string
  /** Already formatted by the caller (e.g. via formatRelative) - this file does no date math. */
  at?: string
}

export interface SidebarNavWorkspace {
  id: string
  name: string
  /** The house's current mode: "Chez moi", "Absent", "Nuit"... */
  subtitle?: string
  monogram?: string
}

/** A generic labelled action row (workspace-menu extra rows, the footer banner). */
export interface SidebarNavAction {
  id: string
  label: string
  icon?: string
  to?: string
}

export type SidebarNavEmittedItem = SidebarNavItem | SidebarNavAction

/**
 * Groups flat items by their `section` key, in the order given by `sections`, dropping
 * sections left empty. Items whose `section` matches nothing in `sections` (or when
 * `sections` is omitted entirely, as in the source's own two-item nav) land in one trailing
 * ungrouped bucket rather than being silently dropped.
 */
export function sidebarNavGroupItems(items: SidebarNavItem[], sections?: SidebarNavSection[]): SidebarNavGroup[] {
  if (!sections || sections.length === 0) return [{ key: '', label: '', items }]

  const groups = sections.map((section) => ({ key: section.key, label: section.label, items: [] as SidebarNavItem[] }))
  const byKey = new Map(groups.map((group) => [group.key, group]))
  const extra: SidebarNavItem[] = []
  for (const item of items) {
    const group = item.section ? byKey.get(item.section) : undefined
    if (group) group.items.push(item)
    else extra.push(item)
  }
  const result = groups.filter((group) => group.items.length > 0)
  if (extra.length > 0) result.push({ key: '', label: '', items: extra })
  return result
}

/** Case-insensitive substring match on the title, same rule as the source's chat search. */
export function sidebarNavFilterHistory(history: SidebarNavHistoryEntry[], query: string): SidebarNavHistoryEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return history
  return history.filter((entry) => entry.title.toLowerCase().includes(needle))
}
