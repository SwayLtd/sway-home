/**
 * Everything that is not a device: settings, places, routines, scenes, people, alerts,
 * network hosts, the agent's conversations and memories, the undo stack.
 *
 * Grouped by table, each with the two or three queries the hub actually runs. Anything that
 * needs more than that has earned its own file.
 */

import { randomUUID } from 'node:crypto'
import type { Area, Floor, HouseMode, Memory, Proposal, Routine, Scene, AgentMessage, NetworkHost } from '@sway-home/shared'
import { boolToInt, database, fromJson, insertInto, intToBool, nowIso, toJson, transaction, updateWhere } from '#db/database'

type Row = Record<string, unknown>

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

export const settings = {
  get<T>(key: string, fallback: T): T {
    const row = database().get<Row>('SELECT value FROM settings WHERE key = ?', [key])
    return fromJson<T>(row?.value, fallback)
  },

  set(key: string, value: unknown): void {
    insertInto('settings', { key, value: toJson(value), updated_at: nowIso() }, true)
  },

  all(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const row of database().all<Row>('SELECT key, value FROM settings')) {
      out[String(row.key)] = fromJson<unknown>(row.value, null)
    }
    return out
  },

  /** Deep merge for the nested settings objects (agent, voice, privacy). */
  patch(key: string, patch: Record<string, unknown>): Record<string, unknown> {
    const current = settings.get<Record<string, unknown>>(key, {})
    const merged = deepMerge(current, patch)
    settings.set(key, merged)
    return merged
  },
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------------------

export const places = {
  areas(): Area[] {
    return database()
      .all<Row>('SELECT * FROM areas ORDER BY sort_order, name COLLATE NOCASE')
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        kind: String(row.kind) as Area['kind'],
        floorId: row.floor_id === null ? null : String(row.floor_id),
        icon: row.icon === null ? null : String(row.icon),
        polygon: fromJson<Area['polygon']>(row.polygon, null),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }))
  },

  createArea(input: { name: string; kind?: Area['kind']; floorId?: string | null; icon?: string | null }): Area {
    const id = randomUUID()
    const at = nowIso()
    const order = Number(database().get<{ n: number }>('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM areas')?.n ?? 1)
    insertInto('areas', {
      id,
      name: input.name,
      kind: input.kind ?? 'other',
      floor_id: input.floorId ?? null,
      icon: input.icon ?? null,
      polygon: null,
      sort_order: order,
      created_at: at,
      updated_at: at,
    })
    return places.areas().find((area) => area.id === id)!
  },

  updateArea(id: string, patch: Partial<Pick<Area, 'name' | 'kind' | 'floorId' | 'icon'>>): void {
    const row: Row = { updated_at: nowIso() }
    if (patch.name !== undefined) row.name = patch.name
    if (patch.kind !== undefined) row.kind = patch.kind
    if (patch.floorId !== undefined) row.floor_id = patch.floorId
    if (patch.icon !== undefined) row.icon = patch.icon
    updateWhere('areas', row, 'id = ?', [id])
  },

  deleteArea(id: string): void {
    database().run('DELETE FROM areas WHERE id = ?', [id])
  },

  floors(): Floor[] {
    return database()
      .all<Row>('SELECT * FROM floors ORDER BY level')
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        level: Number(row.level),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }))
  },

  createFloor(name: string, level: number): Floor {
    const id = randomUUID()
    const at = nowIso()
    insertInto('floors', { id, name, level, created_at: at, updated_at: at })
    return { id, name, level, createdAt: at, updatedAt: at }
  },
}

// ---------------------------------------------------------------------------------------
// Network hosts
// ---------------------------------------------------------------------------------------

export const hosts = {
  upsert(host: NetworkHost, fingerprint: unknown, deviceId: string | null = null): void {
    const existing = database().get<Row>('SELECT ip, first_seen_at FROM network_hosts WHERE ip = ?', [host.ip])
    insertInto(
      'network_hosts',
      {
        ip: host.ip,
        mac: host.mac,
        mac_vendor: host.macVendor,
        hostname: host.hostname,
        open_ports: toJson(host.openPorts),
        mdns_services: toJson(host.mdnsServices),
        mdns_txt: toJson(host.mdnsTxt),
        ssdp: toJson(host.ssdp),
        http_banner: host.httpBanner,
        http_title: host.httpTitle,
        rtt_ms: host.rttMs,
        sources: toJson(host.source),
        fingerprint: toJson(fingerprint),
        device_id: deviceId ?? (existing ? (database().get<Row>('SELECT device_id FROM network_hosts WHERE ip = ?', [host.ip])?.device_id ?? null) : null),
        ignored: existing ? Number(database().get<Row>('SELECT ignored FROM network_hosts WHERE ip = ?', [host.ip])?.ignored ?? 0) : 0,
        first_seen_at: existing ? String(existing.first_seen_at) : host.firstSeenAt,
        last_seen_at: host.lastSeenAt,
      },
      true
    )
  },

  all(options: { includeIgnored?: boolean } = {}): (NetworkHost & { fingerprint: Record<string, unknown>; deviceId: string | null; ignored: boolean })[] {
    const clause = options.includeIgnored ? '' : 'WHERE ignored = 0'
    return database()
      .all<Row>(`SELECT * FROM network_hosts ${clause} ORDER BY last_seen_at DESC`)
      .map((row) => ({
        ip: String(row.ip),
        mac: row.mac === null ? null : String(row.mac),
        macVendor: row.mac_vendor === null ? null : String(row.mac_vendor),
        hostname: row.hostname === null ? null : String(row.hostname),
        openPorts: fromJson<number[]>(row.open_ports, []),
        mdnsServices: fromJson<string[]>(row.mdns_services, []),
        mdnsTxt: fromJson<Record<string, string>>(row.mdns_txt, {}),
        ssdp: fromJson<NetworkHost['ssdp']>(row.ssdp, null),
        httpBanner: row.http_banner === null ? null : String(row.http_banner),
        httpTitle: row.http_title === null ? null : String(row.http_title),
        rttMs: row.rtt_ms === null ? null : Number(row.rtt_ms),
        firstSeenAt: String(row.first_seen_at),
        lastSeenAt: String(row.last_seen_at),
        source: fromJson<NetworkHost['source']>(row.sources, []),
        fingerprint: fromJson<Record<string, unknown>>(row.fingerprint, {}),
        deviceId: row.device_id === null ? null : String(row.device_id),
        ignored: intToBool(row.ignored),
      }))
  },

  claim(ip: string, deviceId: string): void {
    updateWhere('network_hosts', { device_id: deviceId }, 'ip = ?', [ip])
  },

  ignore(ip: string, ignored: boolean): void {
    updateWhere('network_hosts', { ignored: boolToInt(ignored) }, 'ip = ?', [ip])
  },
}

// ---------------------------------------------------------------------------------------
// Routines and scenes
// ---------------------------------------------------------------------------------------

function rowToRoutine(row: Row): Routine {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description === null ? null : String(row.description),
    enabled: intToBool(row.enabled),
    mode: String(row.mode) as Routine['mode'],
    triggers: fromJson<Routine['triggers']>(row.triggers, []),
    conditions: fromJson<Routine['conditions']>(row.conditions, []),
    actions: fromJson<Routine['actions']>(row.actions, []),
    authoredBy: String(row.authored_by) as Routine['authoredBy'],
    status: String(row.status) as Routine['status'],
    suggestionReason: row.suggestion_reason === null ? null : String(row.suggestion_reason),
    areaId: row.area_id === null ? null : String(row.area_id),
    lastTriggeredAt: row.last_triggered_at === null ? null : String(row.last_triggered_at),
    runCount: Number(row.run_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export const routines = {
  all(status?: Routine['status']): Routine[] {
    const rows = status
      ? database().all<Row>('SELECT * FROM routines WHERE status = ? ORDER BY updated_at DESC', [status])
      : database().all<Row>('SELECT * FROM routines ORDER BY status, name COLLATE NOCASE')
    return rows.map(rowToRoutine)
  },

  active(): Routine[] {
    return database().all<Row>("SELECT * FROM routines WHERE status = 'active' AND enabled = 1").map(rowToRoutine)
  },

  find(id: string): Routine | null {
    const row = database().get<Row>('SELECT * FROM routines WHERE id = ?', [id])
    return row ? rowToRoutine(row) : null
  },

  create(input: Omit<Routine, 'id' | 'createdAt' | 'updatedAt' | 'runCount' | 'lastTriggeredAt'>): Routine {
    const id = randomUUID()
    const at = nowIso()
    insertInto('routines', {
      id,
      name: input.name,
      description: input.description ?? null,
      enabled: boolToInt(input.enabled),
      mode: input.mode,
      triggers: toJson(input.triggers),
      conditions: toJson(input.conditions),
      actions: toJson(input.actions),
      authored_by: input.authoredBy,
      status: input.status,
      suggestion_reason: input.suggestionReason ?? null,
      area_id: input.areaId ?? null,
      last_triggered_at: null,
      run_count: 0,
      created_at: at,
      updated_at: at,
    })
    return routines.find(id)!
  },

  update(id: string, patch: Partial<Routine>): Routine | null {
    const row: Row = { updated_at: nowIso() }
    if (patch.name !== undefined) row.name = patch.name
    if (patch.description !== undefined) row.description = patch.description
    if (patch.enabled !== undefined) row.enabled = boolToInt(patch.enabled)
    if (patch.mode !== undefined) row.mode = patch.mode
    if (patch.triggers !== undefined) row.triggers = toJson(patch.triggers)
    if (patch.conditions !== undefined) row.conditions = toJson(patch.conditions)
    if (patch.actions !== undefined) row.actions = toJson(patch.actions)
    if (patch.status !== undefined) row.status = patch.status
    if (patch.areaId !== undefined) row.area_id = patch.areaId
    updateWhere('routines', row, 'id = ?', [id])
    return routines.find(id)
  },

  remove(id: string): void {
    database().run('DELETE FROM routines WHERE id = ?', [id])
  },

  markRun(id: string): void {
    database().run('UPDATE routines SET run_count = run_count + 1, last_triggered_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), id])
  },

  recordRun(input: { routineId: string; trigger: unknown; steps: unknown[]; status: string; error?: string | null; startedAt: string }): void {
    insertInto('routine_runs', {
      id: randomUUID(),
      routine_id: input.routineId,
      started_at: input.startedAt,
      finished_at: nowIso(),
      status: input.status,
      trigger: toJson(input.trigger),
      steps: toJson(input.steps),
      error: input.error ?? null,
    })
  },

  runs(routineId: string, limit = 25): Row[] {
    return database().all<Row>('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC LIMIT ?', [routineId, limit])
  },
}

export const scenes = {
  all(): Scene[] {
    return database()
      .all<Row>('SELECT * FROM scenes ORDER BY name COLLATE NOCASE')
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        icon: row.icon === null ? null : String(row.icon),
        areaId: row.area_id === null ? null : String(row.area_id),
        entries: fromJson<Scene['entries']>(row.entries, []),
        authoredBy: String(row.authored_by) as Scene['authoredBy'],
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }))
  },

  find(id: string): Scene | null {
    return scenes.all().find((scene) => scene.id === id) ?? null
  },

  create(input: { name: string; icon?: string | null; areaId?: string | null; entries: Scene['entries']; authoredBy?: Scene['authoredBy'] }): Scene {
    const id = randomUUID()
    const at = nowIso()
    insertInto('scenes', {
      id,
      name: input.name,
      icon: input.icon ?? null,
      area_id: input.areaId ?? null,
      entries: toJson(input.entries),
      authored_by: input.authoredBy ?? 'user',
      created_at: at,
      updated_at: at,
    })
    return scenes.find(id)!
  },

  update(id: string, patch: Partial<Scene>): void {
    const row: Row = { updated_at: nowIso() }
    if (patch.name !== undefined) row.name = patch.name
    if (patch.icon !== undefined) row.icon = patch.icon
    if (patch.areaId !== undefined) row.area_id = patch.areaId
    if (patch.entries !== undefined) row.entries = toJson(patch.entries)
    updateWhere('scenes', row, 'id = ?', [id])
  },

  remove(id: string): void {
    database().run('DELETE FROM scenes WHERE id = ?', [id])
  },
}

// ---------------------------------------------------------------------------------------
// People and house mode
// ---------------------------------------------------------------------------------------

export interface Person {
  id: string
  name: string
  avatar: string | null
  home: boolean
  presenceSource: string
  trackerDeviceIds: string[]
  lastSeenAt: string | null
}

export const people = {
  all(): Person[] {
    return database()
      .all<Row>('SELECT * FROM people ORDER BY name COLLATE NOCASE')
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        avatar: row.avatar === null ? null : String(row.avatar),
        home: intToBool(row.home),
        presenceSource: String(row.presence_source),
        trackerDeviceIds: fromJson<string[]>(row.tracker_device_ids, []),
        lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at),
      }))
  },

  create(input: { name: string; avatar?: string | null; trackerDeviceIds?: string[] }): Person {
    const id = randomUUID()
    const at = nowIso()
    insertInto('people', {
      id,
      name: input.name,
      avatar: input.avatar ?? null,
      home: 0,
      presence_source: 'network',
      tracker_device_ids: toJson(input.trackerDeviceIds ?? []),
      last_seen_at: null,
      created_at: at,
      updated_at: at,
    })
    return people.all().find((person) => person.id === id)!
  },

  setHome(id: string, home: boolean): void {
    updateWhere('people', { home: boolToInt(home), last_seen_at: home ? nowIso() : null, updated_at: nowIso() }, 'id = ?', [id])
  },

  update(id: string, patch: Partial<Person>): void {
    const row: Row = { updated_at: nowIso() }
    if (patch.name !== undefined) row.name = patch.name
    if (patch.avatar !== undefined) row.avatar = patch.avatar
    if (patch.trackerDeviceIds !== undefined) row.tracker_device_ids = toJson(patch.trackerDeviceIds)
    updateWhere('people', row, 'id = ?', [id])
  },

  remove(id: string): void {
    database().run('DELETE FROM people WHERE id = ?', [id])
  },
}

export const house = {
  mode(): HouseMode {
    return settings.get<HouseMode>('house.mode', 'home')
  },
  setMode(mode: HouseMode): void {
    settings.set('house.mode', mode)
  },
}

// ---------------------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------------------

export interface Alert {
  id: string
  kind: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  detail: string | null
  subjectType: string
  subjectId: string | null
  raisedAt: string
  clearedAt: string | null
  acknowledgedAt: string | null
}

export const alerts = {
  open(): Alert[] {
    return database()
      .all<Row>('SELECT * FROM alerts WHERE cleared_at IS NULL ORDER BY raised_at DESC')
      .map(rowToAlert)
  },

  /** True when no open alert exists yet for this (kind, subject). Callers use it to decide whether to announce. */
  isNew(kind: string, subjectId: string | null): boolean {
    return !database().get<Row>('SELECT id FROM alerts WHERE kind = ? AND subject_id IS ? AND cleared_at IS NULL', [kind, subjectId])
  },

  raise(input: { kind: string; severity?: Alert['severity']; title: string; detail?: string | null; subjectType?: string; subjectId?: string | null }): Alert {
    // One open alert per (kind, subject): a flapping sensor must not produce a wall.
    const existing = database().get<Row>(
      'SELECT * FROM alerts WHERE kind = ? AND subject_id IS ? AND cleared_at IS NULL',
      [input.kind, input.subjectId ?? null]
    )
    if (existing) return rowToAlert(existing)
    // Everything below runs only for a genuinely new alert, which is what `isNew` reports.

    const id = randomUUID()
    insertInto('alerts', {
      id,
      kind: input.kind,
      severity: input.severity ?? 'warning',
      title: input.title,
      detail: input.detail ?? null,
      subject_type: input.subjectType ?? 'device',
      subject_id: input.subjectId ?? null,
      raised_at: nowIso(),
      cleared_at: null,
      acknowledged_at: null,
    })
    return alerts.open().find((alert) => alert.id === id)!
  },

  clear(kind: string, subjectId: string | null): void {
    database().run('UPDATE alerts SET cleared_at = ? WHERE kind = ? AND subject_id IS ? AND cleared_at IS NULL', [nowIso(), kind, subjectId])
  },

  acknowledge(id: string): void {
    updateWhere('alerts', { acknowledged_at: nowIso() }, 'id = ?', [id])
  },

  /**
   * Close one alert by id. A watchdog clears its own alerts when the condition goes away,
   * but an alert raised by a one-off failure - a command that did not go through - has no
   * watchdog behind it and would otherwise stay on screen forever.
   */
  dismiss(id: string): void {
    updateWhere('alerts', { cleared_at: nowIso() }, 'id = ? AND cleared_at IS NULL', [id])
  },
}

function rowToAlert(row: Row): Alert {
  return {
    id: String(row.id),
    kind: String(row.kind),
    severity: String(row.severity) as Alert['severity'],
    title: String(row.title),
    detail: row.detail === null ? null : String(row.detail),
    subjectType: String(row.subject_type),
    subjectId: row.subject_id === null ? null : String(row.subject_id),
    raisedAt: String(row.raised_at),
    clearedAt: row.cleared_at === null ? null : String(row.cleared_at),
    acknowledgedAt: row.acknowledged_at === null ? null : String(row.acknowledged_at),
  }
}

// ---------------------------------------------------------------------------------------
// Agent: conversations, messages, memories, proposals
// ---------------------------------------------------------------------------------------

export const conversations = {
  all(limit = 40): { id: string; title: string; pinned: boolean; updatedAt: string; messageCount: number }[] {
    return database()
      .all<Row>(
        `SELECT c.*, (SELECT COUNT(*) FROM agent_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c WHERE archived = 0 ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
        [limit]
      )
      .map((row) => ({
        id: String(row.id),
        title: String(row.title),
        pinned: intToBool(row.pinned),
        updatedAt: String(row.updated_at),
        messageCount: Number(row.message_count ?? 0),
      }))
  },

  create(title = 'New conversation'): string {
    const id = randomUUID()
    const at = nowIso()
    insertInto('conversations', { id, title, pinned: 0, archived: 0, created_at: at, updated_at: at })
    return id
  },

  ensure(id: string | null | undefined): string {
    if (id) {
      const row = database().get<Row>('SELECT id FROM conversations WHERE id = ?', [id])
      if (row) return id
    }
    return conversations.create()
  },

  rename(id: string, title: string): void {
    updateWhere('conversations', { title, updated_at: nowIso() }, 'id = ?', [id])
  },

  touch(id: string): void {
    updateWhere('conversations', { updated_at: nowIso() }, 'id = ?', [id])
  },

  remove(id: string): void {
    database().run('DELETE FROM conversations WHERE id = ?', [id])
  },
}

export const messages = {
  forConversation(conversationId: string, limit = 200): AgentMessage[] {
    return database()
      .all<Row>('SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at LIMIT ?', [conversationId, limit])
      .map((row) => ({
        id: String(row.id),
        conversationId: String(row.conversation_id),
        role: String(row.role) as AgentMessage['role'],
        content: String(row.content),
        attachments: fromJson<AgentMessage['attachments']>(row.attachments, []),
        toolCalls: fromJson<AgentMessage['toolCalls']>(row.tool_calls, []),
        toolCallId: row.tool_call_id === null ? null : String(row.tool_call_id),
        usage: fromJson<AgentMessage['usage']>(row.usage, null),
        createdAt: String(row.created_at),
      }))
  },

  append(message: Omit<AgentMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): AgentMessage {
    const id = message.id ?? randomUUID()
    const createdAt = message.createdAt ?? nowIso()
    insertInto('agent_messages', {
      id,
      conversation_id: message.conversationId,
      role: message.role,
      content: message.content,
      attachments: toJson(message.attachments ?? []),
      tool_calls: toJson(message.toolCalls ?? []),
      tool_call_id: message.toolCallId ?? null,
      usage: message.usage ? toJson(message.usage) : null,
      created_at: createdAt,
    })
    conversations.touch(message.conversationId)
    return { ...message, id, createdAt } as AgentMessage
  },
}

export const memories = {
  all(limit = 200): Memory[] {
    return database().all<Row>('SELECT * FROM memories ORDER BY strength DESC, updated_at DESC LIMIT ?', [limit]).map(rowToMemory)
  },

  /** Ranked for the prompt: strongest first, expired dropped. */
  forPrompt(limit = 30): Memory[] {
    return database()
      .all<Row>(
        `SELECT * FROM memories WHERE expires_at IS NULL OR expires_at > ?
         ORDER BY strength DESC, evidence_count DESC LIMIT ?`,
        [nowIso(), limit]
      )
      .map(rowToMemory)
  },

  search(query: string, limit = 10): Memory[] {
    const cleaned = query.replace(/["*]/g, ' ').trim()
    if (!cleaned) return []
    try {
      const rows = database().all<Row>('SELECT memory_id FROM memory_search WHERE memory_search MATCH ? ORDER BY rank LIMIT ?', [`${cleaned}*`, limit])
      const ids = rows.map((row) => String(row.memory_id))
      if (ids.length === 0) return []
      return database()
        .all<Row>(`SELECT * FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
        .map(rowToMemory)
    } catch {
      return []
    }
  },

  remember(input: { kind: Memory['kind']; content: string; subjectType?: Memory['subjectType']; subjectId?: string | null; confidence?: number; source?: Memory['source'] }): Memory {
    // An identical fact is reinforced rather than duplicated. Twenty copies of "John
    // likes the living room warm" would dominate the prompt and say nothing new.
    const existing = database().get<Row>('SELECT * FROM memories WHERE content = ? AND subject_id IS ?', [input.content, input.subjectId ?? null])
    if (existing) {
      const strength = Math.min(1, Number(existing.strength) + 0.15)
      updateWhere('memories', { strength, evidence_count: Number(existing.evidence_count) + 1, updated_at: nowIso() }, 'id = ?', [String(existing.id)])
      return rowToMemory({ ...existing, strength, evidence_count: Number(existing.evidence_count) + 1 })
    }

    const id = randomUUID()
    const at = nowIso()
    return transaction(() => {
      insertInto('memories', {
        id,
        kind: input.kind,
        content: input.content,
        subject_type: input.subjectType ?? 'house',
        subject_id: input.subjectId ?? null,
        confidence: input.confidence ?? 0.7,
        strength: input.source === 'stated' ? 0.9 : 0.5,
        source: input.source ?? 'observed',
        evidence_count: 1,
        last_used_at: null,
        expires_at: null,
        created_at: at,
        updated_at: at,
      })
      insertInto('memory_search', { memory_id: id, content: input.content })
      return memories.all().find((memory) => memory.id === id)!
    })
  },

  forget(id: string): void {
    transaction(() => {
      database().run('DELETE FROM memories WHERE id = ?', [id])
      database().run('DELETE FROM memory_search WHERE memory_id = ?', [id])
    })
  },

  used(id: string): void {
    updateWhere('memories', { last_used_at: nowIso() }, 'id = ?', [id])
  },
}

function rowToMemory(row: Row): Memory {
  return {
    id: String(row.id),
    kind: String(row.kind) as Memory['kind'],
    content: String(row.content),
    subjectType: String(row.subject_type) as Memory['subjectType'],
    subjectId: row.subject_id === null ? null : String(row.subject_id),
    confidence: Number(row.confidence),
    strength: Number(row.strength),
    source: String(row.source) as Memory['source'],
    evidenceCount: Number(row.evidence_count),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export const proposals = {
  pending(): Proposal[] {
    return database()
      .all<Row>("SELECT * FROM proposals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at DESC", [nowIso()])
      .map(rowToProposal)
  },

  find(id: string): Proposal | null {
    const row = database().get<Row>('SELECT * FROM proposals WHERE id = ?', [id])
    return row ? rowToProposal(row) : null
  },

  create(input: Omit<Proposal, 'id' | 'status' | 'createdAt' | 'expiresAt' | 'decidedAt'> & { ttlMinutes?: number }): Proposal {
    const id = randomUUID()
    const at = nowIso()
    const expiresAt = new Date(Date.now() + (input.ttlMinutes ?? 30) * 60_000).toISOString()
    insertInto('proposals', {
      id,
      summary: input.summary,
      reason: input.reason,
      risk: input.risk,
      commands: toJson(input.commands),
      routine: input.routine ? toJson(input.routine) : null,
      status: 'pending',
      created_at: at,
      expires_at: expiresAt,
      decided_at: null,
    })
    return proposals.find(id)!
  },

  decide(id: string, status: Proposal['status']): void {
    updateWhere('proposals', { status, decided_at: nowIso() }, 'id = ?', [id])
  },

  expireStale(): number {
    return database().run("UPDATE proposals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", [nowIso()]).changes
  },
}

function rowToProposal(row: Row): Proposal {
  return {
    id: String(row.id),
    summary: String(row.summary),
    reason: String(row.reason),
    risk: String(row.risk) as Proposal['risk'],
    commands: fromJson<Proposal['commands']>(row.commands, []),
    routine: fromJson<unknown>(row.routine, null),
    status: String(row.status) as Proposal['status'],
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    decidedAt: row.decided_at === null ? null : String(row.decided_at),
  }
}

// ---------------------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------------------

export interface UndoEntry {
  id: string
  at: string
  description: string
  origin: string
  commands: { deviceId: string; command: string; args: Record<string, unknown> }[]
  applied: boolean
  expiresAt: string
}

export const undo = {
  push(input: { description: string; origin?: string; commands: UndoEntry['commands']; ttlMinutes?: number }): UndoEntry {
    const id = randomUUID()
    const at = nowIso()
    const expiresAt = new Date(Date.now() + (input.ttlMinutes ?? 30) * 60_000).toISOString()
    insertInto('undo_entries', {
      id,
      at,
      description: input.description,
      origin: input.origin ?? 'agent',
      commands: toJson(input.commands),
      applied: 0,
      expires_at: expiresAt,
    })
    return { id, at, description: input.description, origin: input.origin ?? 'agent', commands: input.commands, applied: false, expiresAt }
  },

  stack(limit = 10): UndoEntry[] {
    return database()
      .all<Row>('SELECT * FROM undo_entries WHERE applied = 0 AND expires_at > ? ORDER BY at DESC LIMIT ?', [nowIso(), limit])
      .map((row) => ({
        id: String(row.id),
        at: String(row.at),
        description: String(row.description),
        origin: String(row.origin),
        commands: fromJson<UndoEntry['commands']>(row.commands, []),
        applied: intToBool(row.applied),
        expiresAt: String(row.expires_at),
      }))
  },

  /** One entry that can still be applied: not applied yet, not expired. */
  find(id: string): UndoEntry | null {
    return undo.stack(200).find((entry) => entry.id === id) ?? null
  },

  markApplied(id: string): void {
    updateWhere('undo_entries', { applied: 1 }, 'id = ?', [id])
  },
}

// ---------------------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------------------

export const adapterConfig = {
  all(): Record<string, { enabled: boolean; config: Record<string, unknown>; status: Record<string, unknown> }> {
    const out: Record<string, { enabled: boolean; config: Record<string, unknown>; status: Record<string, unknown> }> = {}
    for (const row of database().all<Row>('SELECT * FROM adapters')) {
      out[String(row.id)] = {
        enabled: intToBool(row.enabled),
        config: fromJson<Record<string, unknown>>(row.config, {}),
        status: fromJson<Record<string, unknown>>(row.status, {}),
      }
    }
    return out
  },

  get(id: string): { enabled: boolean; config: Record<string, unknown> } {
    const row = database().get<Row>('SELECT * FROM adapters WHERE id = ?', [id])
    if (!row) return { enabled: false, config: {} }
    return { enabled: intToBool(row.enabled), config: fromJson<Record<string, unknown>>(row.config, {}) }
  },

  set(id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): void {
    const current = adapterConfig.get(id)
    insertInto(
      'adapters',
      {
        id,
        enabled: boolToInt(patch.enabled ?? current.enabled),
        config: toJson({ ...current.config, ...(patch.config ?? {}) }),
        status: toJson({}),
        updated_at: nowIso(),
      },
      true
    )
  },

  setStatus(id: string, status: Record<string, unknown>): void {
    updateWhere('adapters', { status: toJson(status), updated_at: nowIso() }, 'id = ?', [id])
  },
}

export const adapterStore = {
  get<T>(adapterId: string, key: string): T | null {
    const row = database().get<Row>('SELECT value FROM adapter_store WHERE adapter_id = ? AND key = ?', [adapterId, key])
    return row ? fromJson<T | null>(row.value, null) : null
  },
  set(adapterId: string, key: string, value: unknown): void {
    insertInto('adapter_store', { adapter_id: adapterId, key, value: toJson(value), updated_at: nowIso() }, true)
  },
  delete(adapterId: string, key: string): void {
    database().run('DELETE FROM adapter_store WHERE adapter_id = ? AND key = ?', [adapterId, key])
  },
}
