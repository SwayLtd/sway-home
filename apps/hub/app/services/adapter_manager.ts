/**
 * The adapter manager.
 *
 * Owns the lifecycle of every protocol adapter: which ones exist, which are enabled, what
 * they found, and what happens when one throws. It is the only place that knows an adapter
 * is a class with a lifecycle; everything else asks for a device and gets one.
 *
 * Two rules it enforces, both learned the hard way in every hub that has ever existed:
 *  - An adapter that fails is contained. One broken integration must not take the hub down
 *    or stop a scan, so every call into an adapter is wrapped and every failure becomes a
 *    status rather than an exception.
 *  - An adapter never writes to the database. It reports; the manager persists. That keeps
 *    a third-party adapter (later) from being able to corrupt the device table.
 */

import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterStatus,
  CommandResult,
  DiscoveredDevice,
  NetworkHost,
  ProtocolAdapter,
} from '@sway-home/shared'
import { bus } from '#services/event_bus'
import { mapLimit } from '#adapters/base'
import { deviceRepository } from '#repositories/device_repository'
import { adapterConfig, adapterStore, places, settings } from '#repositories/store'
import { mergeAdapterConfig } from '#services/secrets'

export interface AdapterEntry {
  adapter: ProtocolAdapter
  descriptor: AdapterDescriptor
  enabled: boolean
  started: boolean
  lastError: string | null
  lastScanAt: string | null
}

export interface NetworkFacts {
  localIp: string
  cidr: string
  gateway: string | null
  interfaceName: string
}

class AdapterManager {
  #entries = new Map<string, AdapterEntry>()
  #controller = new AbortController()
  #network: NetworkFacts = { localIp: '127.0.0.1', cidr: '127.0.0.0/8', gateway: null, interfaceName: 'loopback' }

  setNetwork(facts: NetworkFacts): void {
    this.#network = facts
  }

  network(): NetworkFacts {
    return this.#network
  }

  /** Register an adapter. Registration is not activation. */
  register(adapter: ProtocolAdapter): void {
    const id = adapter.descriptor.id
    if (this.#entries.has(id)) return
    const stored = adapterConfig.get(id)
    this.#entries.set(id, {
      adapter,
      descriptor: adapter.descriptor,
      // An adapter that needs no configuration is on by default; one that needs a token is
      // not, because a hub that spams a vendor cloud with empty credentials gets rate
      // limited and the user never finds out why.
      enabled: stored.enabled || (adapter.descriptor.zeroConfig && adapter.descriptor.implemented && !adapter.descriptor.cloud),
      started: false,
      lastError: null,
      lastScanAt: null,
    })
  }

  list(): AdapterEntry[] {
    return [...this.#entries.values()]
  }

  get(id: string): AdapterEntry | null {
    return this.#entries.get(id) ?? null
  }

  descriptors(): AdapterDescriptor[] {
    return this.list().map((entry) => entry.descriptor)
  }

  async startAll(): Promise<void> {
    for (const entry of this.#entries.values()) {
      if (!entry.enabled) continue
      await this.start(entry.descriptor.id)
    }
  }

  async start(id: string): Promise<boolean> {
    const entry = this.#entries.get(id)
    if (!entry || entry.started) return false

    const { config } = adapterConfig.get(id)
    try {
      await entry.adapter.init(this.#contextFor(id), config)
      entry.started = true
      entry.enabled = true
      entry.lastError = null
      adapterConfig.set(id, { enabled: true })
      this.#publishStatus(id)
      return true
    } catch (error) {
      entry.lastError = (error as Error).message
      bus.publish('system.error', {
        severity: 'warning',
        subjectType: 'adapter',
        subjectId: id,
        payload: { where: 'adapter.init', message: entry.lastError },
      })
      this.#publishStatus(id)
      return false
    }
  }

  async stop(id: string): Promise<void> {
    const entry = this.#entries.get(id)
    if (!entry || !entry.started) return
    try {
      await entry.adapter.shutdown()
    } catch (error) {
      entry.lastError = (error as Error).message
    }
    entry.started = false
    entry.enabled = false
    adapterConfig.set(id, { enabled: false })
    this.#publishStatus(id)
  }

  async configure(id: string, config: Record<string, unknown>): Promise<void> {
    // The console never holds the stored secrets, so a blank one in the form means "keep".
    const schema = this.#entries.get(id)?.adapter.descriptor.configSchema
    adapterConfig.set(id, { config: mergeAdapterConfig(schema, adapterConfig.get(id).config ?? {}, config) })
    const entry = this.#entries.get(id)
    if (entry?.started) {
      await this.stop(id)
      await this.start(id)
    }
  }

  /**
   * Run discovery across every running adapter. Hosts found by the network scan are handed
   * to all of them; each claims what it recognises, and the strongest claim wins.
   */
  async discover(hosts: NetworkHost[]): Promise<{ added: number; updated: number; claims: DiscoveredDevice[] }> {
    const claims: DiscoveredDevice[] = []

    for (const entry of this.#entries.values()) {
      if (!entry.started) continue
      try {
        const found = await withTimeout(entry.adapter.discover(hosts), 30_000, `${entry.descriptor.id}.discover`)
        claims.push(...found)
        entry.lastScanAt = new Date().toISOString()
      } catch (error) {
        entry.lastError = (error as Error).message
        bus.publish('system.error', {
          severity: 'warning',
          subjectType: 'adapter',
          subjectId: entry.descriptor.id,
          payload: { where: 'adapter.discover', message: entry.lastError },
        })
      }
      this.#publishStatus(entry.descriptor.id)
    }

    // One physical device can be claimed by several adapters (a Hue bulb seen over Matter
    // and over the bridge). Keep the strongest and record the rest as links.
    const byUid = new Map<string, DiscoveredDevice>()
    for (const claim of claims) {
      const existing = byUid.get(claim.uid)
      if (!existing || claim.confidence > existing.confidence) byUid.set(claim.uid, claim)
    }

    let added = 0
    let updated = 0
    const blank: DiscoveredDevice[] = []
    for (const claim of byUid.values()) {
      const { device, created } = deviceRepository.upsertFromAdapter({
        uid: claim.uid,
        name: claim.name,
        category: claim.category,
        capabilities: claim.capabilities,
        adapterId: claim.adapterId,
        nativeId: claim.nativeId,
        transport: claim.transport,
        manufacturer: claim.manufacturer ?? null,
        model: claim.model ?? null,
        firmwareVersion: claim.firmwareVersion ?? null,
        serialNumber: claim.serialNumber ?? null,
        identificationConfidence: claim.confidence >= 0.9 ? 'confirmed' : claim.confidence >= 0.7 ? 'high' : 'medium',
        network: claim.network ?? {},
        endpoints: claim.endpoints,
        online: true,
        reachableVia: claim.transport === 'virtual' ? 'virtual' : claim.transport === 'cloud' ? 'cloud' : 'lan',
        meta: claim.meta,
      })

      if (created || Object.keys(device.state).length === 0) blank.push(claim)

      if (created) {
        added += 1
        // An adapter that knows where a device lives (the virtual house, a Hue room, a
        // zigbee2mqtt group) saves the user the single most tedious step of setup. The
        // room is only ever set on creation, so a later rescan never moves a device a
        // human has already filed somewhere else.
        const suggestedArea = claim.meta?.suggestedArea
        if (typeof suggestedArea === 'string' && suggestedArea.length > 0) {
          const area =
            places.areas().find((candidate) => candidate.name.toLowerCase() === suggestedArea.toLowerCase()) ??
            places.createArea({ name: suggestedArea })
          deviceRepository.update(device.id, { areaId: area.id })
        }

        bus.publish('device.added', {
          subjectType: 'device',
          subjectId: device.id,
          origin: 'system',
          payload: { name: device.name, adapterId: device.adapterId, category: device.category, capabilities: device.capabilities },
        })
      } else {
        updated += 1
      }
    }

    // Discovery says what a device is, not how it is. Read the state of what arrived blank,
    // so a thermostat shows its set point and a window its position before their first
    // change - which, for a window, can be hours away.
    await withTimeout(
      mapLimit(blank, 6, async (claim) => {
        const state = await this.readState(claim.adapterId, claim.nativeId)
        if (state && Object.keys(state).length > 0) this.#contextFor(claim.adapterId).emitState(claim.nativeId, state)
      }),
      20_000,
      'discover.state'
    ).catch(() => undefined)

    return { added, updated, claims: [...byUid.values()] }
  }

  /** Send a command to the adapter that owns a device. */
  async execute(adapterId: string, nativeId: string, command: string, args: Record<string, unknown>, endpointIndex?: number): Promise<CommandResult> {
    const entry = this.#entries.get(adapterId)
    if (!entry) return { ok: false, deviceId: nativeId, command, error: `No adapter ${adapterId}` }
    if (!entry.started) return { ok: false, deviceId: nativeId, command, error: `Adapter ${adapterId} is not running` }

    try {
      // Launching an app on a TV, commissioning a Matter device or waking a battery sensor
      // all legitimately take tens of seconds. The timeout is a guard against a hung
      // adapter, not a latency budget, so it is generous.
      return await withTimeout(entry.adapter.execute(nativeId, command, args, endpointIndex), 45_000, `${adapterId}.execute`)
    } catch (error) {
      entry.lastError = (error as Error).message
      this.#publishStatus(adapterId)
      return { ok: false, deviceId: nativeId, command, error: entry.lastError }
    }
  }

  /**
   * Tell the adapter a device was removed from the house. Null when the adapter keeps nothing
   * to let go of; never throws, so a device is always removable.
   */
  async forget(adapterId: string, nativeId: string): Promise<{ ok: boolean; message?: string } | null> {
    const entry = this.#entries.get(adapterId)
    if (!entry?.started || !entry.adapter.forget) return null
    try {
      return await withTimeout(entry.adapter.forget(nativeId), 30_000, `${adapterId}.forget`)
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }

  async readState(adapterId: string, nativeId: string): Promise<Record<string, unknown> | null> {
    const entry = this.#entries.get(adapterId)
    if (!entry?.started) return null
    try {
      return await withTimeout(entry.adapter.getState(nativeId), 8000, `${adapterId}.getState`)
    } catch {
      return null
    }
  }

  statusOf(id: string): AdapterStatus {
    const entry = this.#entries.get(id)
    if (!entry) return { health: 'disabled', deviceCount: 0 }
    if (!entry.enabled) return { health: 'disabled', deviceCount: deviceRepository.counts().byAdapter[id] ?? 0 }
    if (!entry.descriptor.implemented) return { health: 'needs_setup', deviceCount: 0, message: 'Declared, implementation pending' }
    if (!entry.started) return { health: entry.lastError ? 'error' : 'needs_setup', deviceCount: 0, message: entry.lastError ?? undefined }
    try {
      return { ...entry.adapter.status(), lastScanAt: entry.lastScanAt, lastErrorAt: entry.lastError ? new Date().toISOString() : null }
    } catch (error) {
      return { health: 'error', deviceCount: 0, message: (error as Error).message }
    }
  }

  /**
   * Forget every registered adapter, shutting each one down first.
   *
   * Registration is idempotent by id, which is right in production - a double boot must not
   * produce two Hue adapters - and wrong across tests, where each file registers its own
   * instance and the second registration would be silently ignored, sending its commands to
   * the previous file's object.
   */
  async reset(): Promise<void> {
    await this.shutdownAll()
    this.#entries.clear()
    this.#controller = new AbortController()
  }

  async shutdownAll(): Promise<void> {
    this.#controller.abort()
    for (const entry of this.#entries.values()) {
      if (!entry.started) continue
      try {
        await entry.adapter.shutdown()
      } catch {
        /* a failing shutdown must not block the others */
      }
      entry.started = false
    }
  }

  #contextFor(adapterId: string): AdapterContext {
    return {
      emitState: (nativeId, state, endpointIndex) => {
        const device = deviceRepository.findByNative(adapterId, nativeId)
        if (!device) return
        const endpointId = endpointIndex === undefined ? null : device.endpoints.find((e) => e.index === endpointIndex)?.id ?? null
        const { previous, changed } = deviceRepository.mergeState(device.id, state, endpointId)
        if (changed.length === 0) return
        bus.publish('device.state_changed', {
          subjectType: 'device',
          subjectId: device.id,
          origin: 'device',
          payload: { deviceId: device.id, endpointId, changes: state, previous, changed },
        })
      },

      emitEvent: (nativeId, event, payload) => {
        const device = deviceRepository.findByNative(adapterId, nativeId)
        bus.publish('device.event', {
          subjectType: 'device',
          subjectId: device?.id ?? null,
          origin: 'device',
          payload: { event, deviceId: device?.id ?? null, nativeId, ...(payload ?? {}) },
        })
      },

      emitAvailability: (nativeId, online) => {
        const device = deviceRepository.findByNative(adapterId, nativeId)
        if (!device || device.online === online) return
        deviceRepository.setOnline(device.id, online)
        bus.publish(online ? 'device.online' : 'device.offline', {
          subjectType: 'device',
          subjectId: device.id,
          origin: 'device',
          payload: { name: device.name },
          severity: online ? 'info' : 'notice',
        })
      },

      emitDiscovered: (discovered) => {
        const { device, created } = deviceRepository.upsertFromAdapter({
          uid: discovered.uid,
          name: discovered.name,
          category: discovered.category,
          capabilities: discovered.capabilities,
          adapterId: discovered.adapterId,
          nativeId: discovered.nativeId,
          transport: discovered.transport,
          manufacturer: discovered.manufacturer ?? null,
          model: discovered.model ?? null,
          identificationConfidence: 'high',
          network: discovered.network ?? {},
          endpoints: discovered.endpoints,
          online: true,
          meta: discovered.meta,
        })
        if (created) {
          bus.publish('device.added', {
            subjectType: 'device',
            subjectId: device.id,
            payload: { name: device.name, adapterId: device.adapterId, lateDiscovery: true },
          })
        }
      },

      log: (level, message, data) => {
        if (level === 'error' || level === 'warn') {
          bus.publish('system.error', {
            severity: level === 'error' ? 'warning' : 'notice',
            subjectType: 'adapter',
            subjectId: adapterId,
            payload: { message, ...(data ?? {}) },
          })
        } else if (settings.get('hub.verboseAdapters', false)) {
          console.log(`[${adapterId}] ${message}`, data ?? '')
        }
      },

      store: {
        get: async (key) => adapterStore.get(adapterId, key),
        set: async (key, value) => adapterStore.set(adapterId, key, value),
        delete: async (key) => adapterStore.delete(adapterId, key),
      },

      network: this.#network,
      signal: this.#controller.signal,
    }
  }

  #publishStatus(id: string): void {
    const status = this.statusOf(id)
    adapterConfig.setStatus(id, status as unknown as Record<string, unknown>)
    bus.publish('adapter.status_changed', {
      subjectType: 'adapter',
      subjectId: id,
      payload: { ...status },
      severity: status.health === 'error' ? 'warning' : 'info',
    })
  }
}

export const adapters = new AdapterManager()

/**
 * An adapter that hangs is worse than one that fails: it holds a scan open forever. Every
 * call into adapter code goes through here.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
