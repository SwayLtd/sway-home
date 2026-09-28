/**
 * Types and pure helpers for <AiSearch> (Beautiful UI's SearchList, source 14).
 */

export interface SearchItem {
  id: string
  label: string
  hint?: string
  /** Phosphor icon name, e.g. "ph:lightbulb" */
  icon?: string
  group?: string
  shortcut?: string
}

export interface SearchGroup {
  /** the group label, empty string for ungrouped items */
  key: string
  items: SearchItem[]
}

/** accent-insensitive substring match, so "ecl" finds "Éclairage salon" */
export function searchMatches(label: string, query: string): boolean {
  if (!query.trim()) return true
  const fold = (value: string) => value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
  return fold(label).includes(fold(query))
}

/** groups items in first-seen order, preserving each group's item order; ungrouped items share the '' key */
export function searchGroupItems(items: SearchItem[]): SearchGroup[] {
  const order: string[] = []
  const byKey = new Map<string, SearchItem[]>()
  for (const item of items) {
    const key = item.group ?? ''
    let bucket = byKey.get(key)
    if (!bucket) {
      bucket = []
      byKey.set(key, bucket)
      order.push(key)
    }
    bucket.push(item)
  }
  return order.map((key) => ({ key, items: byKey.get(key)! }))
}
