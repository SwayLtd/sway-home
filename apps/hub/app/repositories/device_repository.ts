/**
 * Devices: read, write, state, history, search.
 *
 * One file rather than an ORM. Every query the hub runs against devices is here, which
 * means the answer to "why is this slow" or "where does that column get written" is one
 * grep, and the schema and the code cannot drift apart behind a model class.
 */

import { randomUUID } from 'node:crypto'
import {
  allCapabilities,
  type CapabilityId,
  type Device,
  type DeviceCategory,
  type DeviceEndpoint,
  type Transport,
} from '@sway-home/shared'
import { boolToInt, database, fromJson, insertInto, intToBool, nowIso, toJson, transaction, updateWhere } from '#db/database'

type Row = Record<string, unknown>

function rowToDevice(row: Row, endpoints: DeviceEndpoint[] = []): Device {
  return {
    id: String(row.id),
    uid: String(row.uid),
    name: String(row.name),
    aliases: fromJson<string[]>(row.aliases, []),
    category: String(row.category) as DeviceCategory,
    capabilities: fromJson<CapabilityId[]>(row.capabilities, []),
    endpoints,
    manufacturer: row.manufacturer === null ? null : String(row.manufacturer),
    model: row.model === null ? null : String(row.model),
    firmwareVersion: row.firmware_version === null ? null : String(row.firmware_version),
    serialNumber: row.serial_number === null ? null : String(row.serial_number),
    adapterId: String(row.adapter_id),
    nativeId: String(row.native_id),
    transport: String(row.transport) as Transport,
    areaId: row.area_id === null ? null : String(row.area_id),
    linkedDeviceIds: fromJson<string[]>(row.linked_device_ids, []),
    online: intToBool(row.online),
    reachableVia: String(row.reachable_via) as Device['reachableVia'],
    lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at),
    state: fromJson<Record<string, unknown>>(row.state, {}),
    identificationConfidence: String(row.identification_confidence) as Device['identificationConfidence'],
    notes: row.notes === null ? null : String(row.notes),
    favourite: intToBool(row.favourite),
    hidden: intToBool(row.hidden),
    critical: intToBool(row.critical),
    network: fromJson<Device['network']>(row.network, {
      ip: null,
      mac: null,
      hostname: null,
      macVendor: null,
      openPorts: [],
      mdnsServices: [],
      randomisedMac: false,
    }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function rowToEndpoint(row: Row): DeviceEndpoint {
  return {
    id: String(row.id),
    index: Number(row.idx),
    name: String(row.name),
    category: String(row.category) as DeviceCategory,
    capabilities: fromJson<CapabilityId[]>(row.capabilities, []),
    state: fromJson<Record<string, unknown>>(row.state, {}),
  }
}

function endpointsFor(deviceIds: string[]): Map<string, DeviceEndpoint[]> {
  const map = new Map<string, DeviceEndpoint[]>()
  if (deviceIds.length === 0) return map
  const placeholders = deviceIds.map(() => '?').join(',')
  const rows = database().all<Row>(
    `SELECT * FROM device_endpoints WHERE device_id IN (${placeholders}) ORDER BY idx`,
    deviceIds
  )
  for (const row of rows) {
    const deviceId = String(row.device_id)
    const list = map.get(deviceId) ?? []
    list.push(rowToEndpoint(row))
    map.set(deviceId, list)
  }
  return map
}

export interface DeviceFilter {
  areaId?: string | null
  category?: DeviceCategory
  capability?: CapabilityId
  adapterId?: string
  online?: boolean
  favourite?: boolean
  includeHidden?: boolean
  search?: string
  limit?: number
}

export const deviceRepository = {
  all(filter: DeviceFilter = {}): Device[] {
    const where: string[] = []
    const params: unknown[] = []

    if (filter.includeHidden !== true) where.push('hidden = 0')
    if (filter.areaId !== undefined) {
      if (filter.areaId === null) where.push('area_id IS NULL')
      else {
        where.push('area_id = ?')
        params.push(filter.areaId)
      }
    }
    if (filter.category) {
      where.push('category = ?')
      params.push(filter.category)
    }
    if (filter.adapterId) {
      where.push('adapter_id = ?')
      params.push(filter.adapterId)
    }
    if (filter.online !== undefined) {
      where.push('online = ?')
      params.push(boolToInt(filter.online))
    }
    if (filter.favourite !== undefined) {
      where.push('favourite = ?')
      params.push(boolToInt(filter.favourite))
    }
    // Capabilities are a JSON array; a LIKE on the quoted id is exact enough because the
    // ids are a closed vocabulary with no substring collisions.
    if (filter.capability) {
      where.push('capabilities LIKE ?')
      params.push(`%"${filter.capability}"%`)
    }
    if (filter.search) {
      where.push('(name LIKE ? OR aliases LIKE ? OR model LIKE ? OR manufacturer LIKE ?)')
      const like = `%${filter.search}%`
      params.push(like, like, like, like)
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = database().all<Row>(
      `SELECT * FROM devices ${clause} ORDER BY favourite DESC, name COLLATE NOCASE LIMIT ?`,
      [...params, filter.limit ?? 500]
    )
    const endpoints = endpointsFor(rows.map((row) => String(row.id)))
    return rows.map((row) => rowToDevice(row, endpoints.get(String(row.id)) ?? []))
  },

  find(id: string): Device | null {
    const row = database().get<Row>('SELECT * FROM devices WHERE id = ?', [id])
    if (!row) return null
    return rowToDevice(row, endpointsFor([id]).get(id) ?? [])
  },

  findByUid(uid: string): Device | null {
    const row = database().get<Row>('SELECT * FROM devices WHERE uid = ?', [uid])
    if (!row) return null
    return rowToDevice(row, endpointsFor([String(row.id)]).get(String(row.id)) ?? [])
  },

  findByNative(adapterId: string, nativeId: string): Device | null {
    const row = database().get<Row>('SELECT * FROM devices WHERE adapter_id = ? AND native_id = ?', [adapterId, nativeId])
    if (!row) return null
    return rowToDevice(row, endpointsFor([String(row.id)]).get(String(row.id)) ?? [])
  },

  /**
   * Create or update from what an adapter reported. Fields a human can own - the name, the
   * area, aliases, notes - are never overwritten once set, because a rescan must not undo
   * someone's renaming.
   */
  upsertFromAdapter(input: {
    uid: string
    name: string
    category: DeviceCategory
    capabilities: CapabilityId[]
    adapterId: string
    nativeId: string
    transport: Transport
    manufacturer?: string | null
    model?: string | null
    firmwareVersion?: string | null
    serialNumber?: string | null
    identificationConfidence?: Device['identificationConfidence']
    network?: Partial<Device['network']>
    endpoints?: { index: number; name: string; category: DeviceCategory; capabilities: CapabilityId[] }[]
    online?: boolean
    reachableVia?: Device['reachableVia']
    meta?: Record<string, unknown>
  }): { device: Device; created: boolean } {
    return transaction(() => {
      const existing = database().get<Row>('SELECT * FROM devices WHERE uid = ?', [input.uid])
      const at = nowIso()

      if (existing) {
        const id = String(existing.id)
        const network = {
          ...fromJson<Device['network']>(existing.network, {
            ip: null, mac: null, hostname: null, macVendor: null, openPorts: [], mdnsServices: [], randomisedMac: false,
          }),
          ...(input.network ?? {}),
        }
        updateWhere(
          'devices',
          {
            category: input.category,
            capabilities: toJson(input.capabilities),
            manufacturer: input.manufacturer ?? existing.manufacturer ?? null,
            model: input.model ?? existing.model ?? null,
            firmware_version: input.firmwareVersion ?? existing.firmware_version ?? null,
            serial_number: input.serialNumber ?? existing.serial_number ?? null,
            native_id: input.nativeId,
            transport: input.transport,
            online: boolToInt(input.online ?? true),
            reachable_via: input.reachableVia ?? String(existing.reachable_via),
            last_seen_at: at,
            identification_confidence: input.identificationConfidence ?? String(existing.identification_confidence),
            network: toJson(network),
            meta: toJson({ ...fromJson<Record<string, unknown>>(existing.meta, {}), ...(input.meta ?? {}) }),
            updated_at: at,
          },
          'id = ?',
          [id]
        )
        if (input.endpoints) writeEndpoints(id, input.endpoints, at)
        const device = deviceRepository.find(id)!
        reindex(device)
        return { device, created: false }
      }

      const id = randomUUID()
      insertInto('devices', {
        id,
        uid: input.uid,
        name: input.name,
        aliases: toJson([]),
        category: input.category,
        capabilities: toJson(input.capabilities),
        manufacturer: input.manufacturer ?? null,
        model: input.model ?? null,
        firmware_version: input.firmwareVersion ?? null,
        serial_number: input.serialNumber ?? null,
        adapter_id: input.adapterId,
        native_id: input.nativeId,
        transport: input.transport,
        area_id: null,
        linked_device_ids: toJson([]),
        online: boolToInt(input.online ?? true),
        reachable_via: input.reachableVia ?? 'lan',
        last_seen_at: at,
        state: toJson({}),
        identification_confidence: input.identificationConfidence ?? 'medium',
        notes: null,
        favourite: 0,
        hidden: 0,
        critical: 0,
        network: toJson({
          ip: null, mac: null, hostname: null, macVendor: null, openPorts: [], mdnsServices: [], randomisedMac: false,
          ...(input.network ?? {}),
        }),
        meta: toJson(input.meta ?? {}),
        created_at: at,
        updated_at: at,
      })
      if (input.endpoints) writeEndpoints(id, input.endpoints, at)
      const device = deviceRepository.find(id)!
      reindex(device)
      return { device, created: true }
    })
  },

  update(id: string, patch: Partial<Pick<Device, 'name' | 'aliases' | 'areaId' | 'notes' | 'favourite' | 'hidden' | 'critical' | 'category'>>): Device | null {
    const row: Record<string, unknown> = { updated_at: nowIso() }
    if (patch.name !== undefined) row.name = patch.name
    if (patch.aliases !== undefined) row.aliases = toJson(patch.aliases)
    if (patch.areaId !== undefined) row.area_id = patch.areaId
    if (patch.notes !== undefined) row.notes = patch.notes
    if (patch.favourite !== undefined) row.favourite = boolToInt(patch.favourite)
    if (patch.hidden !== undefined) row.hidden = boolToInt(patch.hidden)
    if (patch.critical !== undefined) row.critical = boolToInt(patch.critical)
    if (patch.category !== undefined) row.category = patch.category
    updateWhere('devices', row, 'id = ?', [id])
    const device = deviceRepository.find(id)
    if (device) reindex(device)
    return device
  },

  setOnline(id: string, online: boolean): void {
    updateWhere('devices', { online: boolToInt(online), last_seen_at: nowIso(), updated_at: nowIso() }, 'id = ?', [id])
  },

  remove(id: string): void {
    transaction(() => {
      database().run('DELETE FROM devices WHERE id = ?', [id])
      database().run('DELETE FROM device_search WHERE device_id = ?', [id])
      database().run('UPDATE network_hosts SET device_id = NULL WHERE device_id = ?', [id])
    })
  },

  /**
   * Merge state and record history. Only numeric and short text attributes are kept in
   * `state_history`: a base64 camera snapshot in a time series would be a very expensive
   * way to make the charts slow.
   */
  mergeState(id: string, changes: Record<string, unknown>, endpointId?: string | null): { previous: Record<string, unknown>; next: Record<string, unknown>; changed: string[] } {
    const table = endpointId ? 'device_endpoints' : 'devices'
    const key = endpointId ?? id
    const row = database().get<Row>(`SELECT state FROM ${table} WHERE id = ?`, [key])
    const previous = fromJson<Record<string, unknown>>(row?.state, {})

    const changed: string[] = []
    const next = { ...previous }
    for (const [attribute, value] of Object.entries(changes)) {
      if (JSON.stringify(previous[attribute]) === JSON.stringify(value)) continue
      next[attribute] = value
      changed.push(attribute)
    }
    if (changed.length === 0) return { previous, next: previous, changed }

    const at = nowIso()
    updateWhere(table, { state: toJson(next), updated_at: at }, 'id = ?', [key])
    if (endpointId) updateWhere('devices', { updated_at: at }, 'id = ?', [id])

    for (const attribute of changed) {
      const value = next[attribute]
      if (typeof value === 'number') {
        insertInto('state_history', { device_id: id, endpoint_id: endpointId ?? null, attribute, value_num: value, value_text: null, at })
      } else if (typeof value === 'boolean') {
        insertInto('state_history', { device_id: id, endpoint_id: endpointId ?? null, attribute, value_num: value ? 1 : 0, value_text: null, at })
      } else if (typeof value === 'string' && value.length <= 120) {
        insertInto('state_history', { device_id: id, endpoint_id: endpointId ?? null, attribute, value_num: null, value_text: value, at })
      }
    }

    return { previous, next, changed }
  },

  history(deviceId: string, attribute: string, options: { since?: string; limit?: number } = {}): { at: string; value: number | string | null }[] {
    const rows = database().all<Row>(
      `SELECT at, value_num, value_text FROM state_history
       WHERE device_id = ? AND attribute = ? ${options.since ? 'AND at >= ?' : ''}
       ORDER BY at DESC LIMIT ?`,
      options.since ? [deviceId, attribute, options.since, options.limit ?? 500] : [deviceId, attribute, options.limit ?? 500]
    )
    return rows
      .map((row) => ({ at: String(row.at), value: row.value_num !== null ? Number(row.value_num) : row.value_text === null ? null : String(row.value_text) }))
      .reverse()
  },

  /** Full-text search over names, aliases, model and area. Powers the command palette. */
  search(query: string, limit = 20): Device[] {
    const cleaned = query.replace(/["*]/g, ' ').trim()
    if (cleaned.length === 0) return []
    try {
      const rows = database().all<Row>(
        `SELECT device_id FROM device_search WHERE device_search MATCH ? ORDER BY rank LIMIT ?`,
        [`${cleaned}*`, limit]
      )
      const ids = rows.map((row) => String(row.device_id))
      return ids.map((id) => deviceRepository.find(id)).filter((d): d is Device => d !== null)
    } catch {
      // FTS rejects some inputs (a lone operator, for instance); fall back to LIKE.
      return deviceRepository.all({ search: cleaned, limit })
    }
  },

  counts(): { total: number; online: number; byCategory: Record<string, number>; byAdapter: Record<string, number> } {
    const total = Number(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM devices WHERE hidden = 0')?.n ?? 0)
    const online = Number(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM devices WHERE hidden = 0 AND online = 1')?.n ?? 0)
    const byCategory: Record<string, number> = {}
    for (const row of database().all<{ category: string; n: number }>('SELECT category, COUNT(*) AS n FROM devices WHERE hidden = 0 GROUP BY category')) {
      byCategory[row.category] = Number(row.n)
    }
    const byAdapter: Record<string, number> = {}
    for (const row of database().all<{ adapter_id: string; n: number }>('SELECT adapter_id, COUNT(*) AS n FROM devices GROUP BY adapter_id')) {
      byAdapter[row.adapter_id] = Number(row.n)
    }
    return { total, online, byCategory, byAdapter }
  },

  capabilitiesInUse(): CapabilityId[] {
    const set = new Set<CapabilityId>()
    for (const device of deviceRepository.all({ limit: 1000 })) {
      for (const capability of allCapabilities(device)) set.add(capability)
    }
    return [...set]
  },
}

function writeEndpoints(deviceId: string, endpoints: { index: number; name: string; category: DeviceCategory; capabilities: CapabilityId[] }[], at: string): void {
  for (const endpoint of endpoints) {
    const existing = database().get<Row>('SELECT id FROM device_endpoints WHERE device_id = ? AND idx = ?', [deviceId, endpoint.index])
    if (existing) {
      updateWhere(
        'device_endpoints',
        { name: endpoint.name, category: endpoint.category, capabilities: toJson(endpoint.capabilities), updated_at: at },
        'id = ?',
        [String(existing.id)]
      )
    } else {
      insertInto('device_endpoints', {
        id: randomUUID(),
        device_id: deviceId,
        idx: endpoint.index,
        name: endpoint.name,
        category: endpoint.category,
        capabilities: toJson(endpoint.capabilities),
        state: toJson({}),
        area_id: null,
        created_at: at,
        updated_at: at,
      })
    }
  }
}

function reindex(device: Device): void {
  const areaName = device.areaId
    ? String(database().get<{ name: string }>('SELECT name FROM areas WHERE id = ?', [device.areaId])?.name ?? '')
    : ''
  database().run('DELETE FROM device_search WHERE device_id = ?', [device.id])
  insertInto('device_search', {
    device_id: device.id,
    name: device.name,
    aliases: device.aliases.join(' '),
    manufacturer: device.manufacturer ?? '',
    model: device.model ?? '',
    area: areaName,
    notes: device.notes ?? '',
  })
}

export { reindex as reindexDevice }
