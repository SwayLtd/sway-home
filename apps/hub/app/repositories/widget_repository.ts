/**
 * Widgets and announcements.
 *
 * Both tables exist for the same reason: the assistant is allowed to change what the user
 * sees, and everything it changes has to be inspectable and reversible. A widget it created
 * carries the reason it created it; an announcement it made carries a dedupe key so the
 * same low battery is not read out loud four times in an evening.
 */

import { randomUUID } from 'node:crypto'
import type { Widget, WidgetSource } from '@sway-home/shared'
import { boolToInt, database, fromJson, insertInto, intToBool, nowIso, toJson, updateWhere } from '#db/database'

type Row = Record<string, unknown>

function rowToWidget(row: Row): Widget {
  return {
    id: String(row.id),
    dashboardId: String(row.dashboard_id),
    type: String(row.type) as Widget['type'],
    title: String(row.title),
    subtitle: row.subtitle === null ? null : String(row.subtitle),
    icon: row.icon === null ? null : String(row.icon),
    size: String(row.size) as Widget['size'],
    position: Number(row.position),
    source: fromJson<WidgetSource>(row.source, { kind: 'house' }),
    options: fromJson<Widget['options']>(row.options, {}),
    authoredBy: String(row.authored_by) as Widget['authoredBy'],
    reason: row.reason === null ? null : String(row.reason),
    visible: intToBool(row.visible),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export const widgets = {
  all(dashboardId = 'home'): Widget[] {
    return database()
      .all<Row>('SELECT * FROM widgets WHERE dashboard_id = ? ORDER BY position, created_at', [dashboardId])
      .map(rowToWidget)
  },

  find(id: string): Widget | null {
    const row = database().get<Row>('SELECT * FROM widgets WHERE id = ?', [id])
    return row ? rowToWidget(row) : null
  },

  create(input: Partial<Widget> & Pick<Widget, 'type' | 'title'>): Widget {
    const id = input.id ?? randomUUID()
    const at = nowIso()
    const dashboardId = input.dashboardId ?? 'home'
    const position =
      input.position ??
      Number(database().get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM widgets WHERE dashboard_id = ?', [dashboardId])?.n ?? 0)

    insertInto('widgets', {
      id,
      dashboard_id: dashboardId,
      type: input.type,
      title: input.title,
      subtitle: input.subtitle ?? null,
      icon: input.icon ?? null,
      size: input.size ?? 'sm',
      position,
      source: toJson(input.source ?? { kind: 'house' }),
      options: toJson(input.options ?? {}),
      authored_by: input.authoredBy ?? 'user',
      reason: input.reason ?? null,
      visible: boolToInt(input.visible ?? true),
      created_at: at,
      updated_at: at,
    })
    return widgets.find(id)!
  },

  update(id: string, patch: Partial<Widget>): Widget | null {
    const fields: Row = { updated_at: nowIso() }
    if (patch.title !== undefined) fields.title = patch.title
    if (patch.subtitle !== undefined) fields.subtitle = patch.subtitle
    if (patch.icon !== undefined) fields.icon = patch.icon
    if (patch.size !== undefined) fields.size = patch.size
    if (patch.position !== undefined) fields.position = patch.position
    if (patch.type !== undefined) fields.type = patch.type
    if (patch.source !== undefined) fields.source = toJson(patch.source)
    if (patch.options !== undefined) fields.options = toJson(patch.options)
    if (patch.visible !== undefined) fields.visible = boolToInt(patch.visible)
    if (patch.reason !== undefined) fields.reason = patch.reason
    updateWhere('widgets', fields, 'id = ?', [id])
    return widgets.find(id)
  },

  remove(id: string): void {
    database().run('DELETE FROM widgets WHERE id = ?', [id])
  },

  /** Reorder in one pass: the console sends the whole order after a drag. */
  reorder(ids: string[]): void {
    ids.forEach((id, index) => updateWhere('widgets', { position: index, updated_at: nowIso() }, 'id = ?', [id]))
  },

  count(dashboardId = 'home'): number {
    return Number(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM widgets WHERE dashboard_id = ?', [dashboardId])?.n ?? 0)
  },
}

// ---------------------------------------------------------------------------------------
// Announcements: what the assistant said without being asked
// ---------------------------------------------------------------------------------------

export interface Announcement {
  id: string
  at: string
  kind: string
  subjectId: string | null
  text: string
  severity: 'info' | 'notice' | 'warning' | 'critical'
  spoken: boolean
  acknowledged: boolean
  dedupeKey: string | null
  payload: Record<string, unknown>
}

function rowToAnnouncement(row: Row): Announcement {
  return {
    id: String(row.id),
    at: String(row.at),
    kind: String(row.kind),
    subjectId: row.subject_id === null ? null : String(row.subject_id),
    text: String(row.text),
    severity: String(row.severity) as Announcement['severity'],
    spoken: intToBool(row.spoken),
    acknowledged: intToBool(row.acknowledged),
    dedupeKey: row.dedupe_key === null ? null : String(row.dedupe_key),
    payload: fromJson<Record<string, unknown>>(row.payload, {}),
  }
}

export const announcements = {
  recent(limit = 30): Announcement[] {
    return database().all<Row>('SELECT * FROM agent_announcements ORDER BY at DESC LIMIT ?', [limit]).map(rowToAnnouncement)
  },

  pending(): Announcement[] {
    return database()
      .all<Row>('SELECT * FROM agent_announcements WHERE acknowledged = 0 ORDER BY at DESC LIMIT 20')
      .map(rowToAnnouncement)
  },

  /**
   * Returns null when this exact thing was already announced. The caller treats null as
   * "stay quiet", which is the behaviour that makes a proactive assistant bearable.
   */
  say(input: {
    kind: string
    text: string
    severity?: Announcement['severity']
    subjectId?: string | null
    dedupeKey?: string | null
    /** A repeat is allowed again after this many minutes. */
    repeatAfterMinutes?: number
    payload?: Record<string, unknown>
  }): Announcement | null {
    const dedupeKey = input.dedupeKey ?? null
    if (dedupeKey) {
      const existing = database().get<Row>('SELECT * FROM agent_announcements WHERE dedupe_key = ?', [dedupeKey])
      if (existing) {
        const ageMinutes = (Date.now() - new Date(String(existing.at)).getTime()) / 60_000
        if (!input.repeatAfterMinutes || ageMinutes < input.repeatAfterMinutes) return null
        database().run('DELETE FROM agent_announcements WHERE dedupe_key = ?', [dedupeKey])
      }
    }

    const id = randomUUID()
    insertInto('agent_announcements', {
      id,
      at: nowIso(),
      kind: input.kind,
      subject_id: input.subjectId ?? null,
      text: input.text,
      severity: input.severity ?? 'info',
      spoken: 0,
      acknowledged: 0,
      dedupe_key: dedupeKey,
      payload: toJson(input.payload ?? {}),
    })
    return announcements.recent(1)[0] ?? null
  },

  markSpoken(id: string): void {
    updateWhere('agent_announcements', { spoken: 1 }, 'id = ?', [id])
  },

  acknowledge(id: string): void {
    updateWhere('agent_announcements', { acknowledged: 1 }, 'id = ?', [id])
  },

  acknowledgeAll(): void {
    database().run('UPDATE agent_announcements SET acknowledged = 1 WHERE acknowledged = 0')
  },

  prune(keepDays = 14): number {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString()
    return database().run('DELETE FROM agent_announcements WHERE at < ?', [cutoff]).changes
  },
}
