/**
 * Matter: every brand's devices, locally, in the hub's own fabric.
 *
 *  - **Pairing** is on the network: a device already on the Wi-Fi or Thread network with its
 *    pairing window open (shared from the app it is already in, or reset into pairing mode)
 *    is found by mDNS and commissioned with its code, the 11 digits under its QR code or the
 *    QR text itself. Bluetooth commissioning is not offered: matter.js has no working BLE on
 *    Windows, and a device new out of the box can be added to another app first and shared.
 *  - **One Matter node, one device** in the house. A node doing several things (a power strip,
 *    a fan with a light) lists them as the device's endpoints, and a command without an
 *    endpoint goes to the first one able to do it. A bridge is the exception: each device
 *    behind it is a device of its own, named as the bridge names it.
 *  - **Everything is pushed**: the controller subscribes to every attribute and event, so a
 *    lamp switched at the wall, a door opening or a button pressed reaches the house at once.
 *    A double press is reported once, as a double press.
 *  - **The fabric lives in the hub**: its keys, the certificates it issued and what it knows
 *    of each node are kept in a SQLite file of their own (see `matter_storage`), so the hub
 *    restarts into the same fabric and its devices come back without their codes.
 *  - **Nothing is loaded until it is needed**: matter.js costs most of a second and a few
 *    dozen megabytes to start, so it is only started once a device has been paired.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deviceUid } from '@sway-home/shared'
import type { AdapterContext, AdapterDescriptor, AdapterStatus, CapabilityId, CommandResult, DeviceCategory, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import type { CommissioningController } from '@project-chip/matter.js'
import type { Endpoint as MatterEndpoint, PairedNode } from '@project-chip/matter.js/device'
import { buttonAction, capabilitiesOf, categoryOf, lockActor, parsePairingCode, planCommand, stateOf, type EndpointView } from '#adapters/matter_codec'
import { databasePath } from '#db/migrate'

export interface MatterOptions {
  /** The SQLite file holding the fabric. Next to the house's database by default. */
  storagePath?: string
  /** Where matter.js may keep its lock files. */
  dataDir?: string
  /** The controller's name in that file: one fabric per name. */
  controllerId?: string
  /** How long a pairing may look for the device and commission it. */
  pairTimeoutMs?: number
  /** How long a command may take before the device is said not to answer. */
  commandTimeoutMs?: number
  /** matter.js's own logging, quiet unless something is wrong. */
  logLevel?: 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'fatal'
  /**
   * The longest a subscribed device may stay silent: past it the controller knows something is
   * wrong. A minute by default; a sleepy battery device may still ask for longer.
   */
  subscriptionCeilingSeconds?: number
  /** A device still being reconnected after this long is offline. */
  offlineAfterMs?: number
  /** First wait before asking an offline device again; doubles up to five minutes. */
  retryMs?: number
}

/** Node states, as matter.js numbers them (NodeStates). */
const CONNECTED = 0
const DISCONNECTED = 1
const RECONNECTING = 2
const WAITING_FOR_DISCOVERY = 3

const BASIC_INFORMATION_CLUSTER = 0x0028
const SWITCH_CLUSTER = 0x003b
const DOOR_LOCK_CLUSTER = 0x0101
const AGGREGATOR = 0x000e

/** Root endpoint internals: only its power source says anything about the device. */
const ROOT_CLUSTERS = new Set(['powerSource'])

const ENDPOINT_LABELS: Partial<Record<DeviceCategory, string>> = {
  light: 'Lumière',
  outlet: 'Prise',
  switch: 'Bouton',
  sensor: 'Capteur',
  cover: 'Volet',
  lock: 'Serrure',
  climate: 'Climat',
  appliance: 'Appareil',
}

interface HubDevice {
  nativeId: string
  name: string
  /** Matter endpoints making this device, the one it is first. */
  endpointIds: number[]
  /** Listed to the house as the device's endpoints, when more than one does something. */
  listed: number[]
  /** Endpoints that only describe power or energy: their state is the device's. */
  merged: number[]
  /** The endpoint carrying its BridgedDeviceBasicInformation, for a device behind a bridge. */
  bridgedAt: number | null
  discovered: DiscoveredDevice
}

interface NodeEntry {
  id: string
  node: PairedNode
  name: string
  devices: HubDevice[]
  /** Null until the node has said whether it is there. */
  online: boolean | null
  refreshing: boolean
  /** Running while the controller tries to get the node back. */
  grace: ReturnType<typeof setTimeout> | null
  /** When the node said it was shutting down: what it says just after is its last words. */
  shutdownAt: number | null
  /** While offline: the next time the hub asks the node again, and how long it waits after. */
  retry: ReturnType<typeof setTimeout> | null
  retryDelay: number
}

/** A node shutting down still talks for a moment; only what it says after this is a return. */
const SHUTDOWN_QUIET_MS = 3000

type MatterRuntime = {
  main: typeof import('@matter/main')
  controller: CommissioningController
  storage: { close(): void }
}

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })

const same = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b))

export class MatterAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'matter',
    name: 'Matter',
    vendor: 'Connectivity Standards Alliance',
    transports: ['matter', 'thread', 'wifi'],
    capabilities: [
      'onoff',
      'brightness',
      'colorTemperature',
      'color',
      'position',
      'tilt',
      'thermostat',
      'fan',
      'lock',
      'valve',
      'contact',
      'motion',
      'occupancy',
      'waterLeak',
      'smoke',
      'carbonMonoxide',
      'temperature',
      'humidity',
      'pressure',
      'illuminance',
      'airQuality',
      'power',
      'energy',
      'battery',
      'button',
      'identify',
    ],
    zeroConfig: true,
    cloud: false,
    implemented: true,
    requiresHardware: 'Aucun pour le Wi-Fi ; un routeur de bordure Thread (HomePod, Nest Hub, box...) pour les appareils Thread',
    docsUrl: 'https://github.com/matter-js/matter.js',
    configSchema: [
      {
        key: 'fabricLabel',
        label: 'Nom du réseau Matter du hub',
        type: 'string',
        default: 'Sway Home',
        help: 'Ce que les autres applications montrent quand elles listent qui contrôle un appareil (32 caractères au plus).',
      },
    ],
  }

  readonly #options: Required<MatterOptions>
  #context: AdapterContext | null = null
  #fabricLabel = 'Sway Home'
  #known: Database | null = null
  #runtime: MatterRuntime | null = null
  #starting: Promise<MatterRuntime> | null = null
  #failure: string | null = null
  #nodes = new Map<string, NodeEntry>()
  /** What was last pushed for each device (and endpoint), so only changes go up. */
  #pushed = new Map<string, Record<string, unknown>>()
  #closed = false

  constructor(options: MatterOptions = {}) {
    // Next to the house's database; a throwaway house (tests) gets a throwaway fabric.
    const house = databasePath()
    const throwaway = house === ':memory:'
    const dataDir = options.dataDir ?? (throwaway ? join(tmpdir(), 'sway-matter') : join(dirname(house), 'matter'))
    this.#options = {
      storagePath: options.storagePath ?? (throwaway ? ':memory:' : join(dataDir, 'matter.sqlite')),
      dataDir,
      controllerId: options.controllerId ?? 'sway-hub',
      pairTimeoutMs: options.pairTimeoutMs ?? 90_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 15_000,
      logLevel: options.logLevel ?? 'error',
      subscriptionCeilingSeconds: options.subscriptionCeilingSeconds ?? 60,
      offlineAfterMs: options.offlineAfterMs ?? 60_000,
      retryMs: options.retryMs ?? 5_000,
    }
  }

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#closed = false
    const label = typeof config.fabricLabel === 'string' ? config.fabricLabel.trim() : ''
    this.#fabricLabel = (label || 'Sway Home').slice(0, 32)
    mkdirSync(this.#options.dataDir, { recursive: true })
    if (this.#options.storagePath !== ':memory:') mkdirSync(dirname(this.#options.storagePath), { recursive: true })
    this.#known = new Database(this.#options.storagePath, { create: true })
    this.#known.run('PRAGMA journal_mode = WAL')
    this.#known.run('CREATE TABLE IF NOT EXISTS matter_nodes (controller TEXT NOT NULL, node_id TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (controller, node_id))')
    // Devices behind a bridge the house removed: the bridge keeps them, the house does not.
    this.#known.run('CREATE TABLE IF NOT EXISTS matter_hidden (controller TEXT NOT NULL, native_id TEXT NOT NULL, PRIMARY KEY (controller, native_id))')
    // Devices already paired: start the controller now, without holding the hub's start up.
    if (this.#knownNodes().length > 0) {
      void this.#ensureStarted().catch((error: Error) => this.#context?.log('error', `Matter ne démarre pas : ${error.message}`))
    }
  }

  #knownNodes(): string[] {
    return (
      this.#known
        ?.query<{ node_id: string }, [string]>('SELECT node_id FROM matter_nodes WHERE controller = ? ORDER BY added_at')
        .all(this.#options.controllerId)
        .map((row) => row.node_id) ?? []
    )
  }

  // -------------------------------------------------------------------------------------
  // The controller
  // -------------------------------------------------------------------------------------

  #ensureStarted(): Promise<MatterRuntime> {
    if (this.#runtime) return Promise.resolve(this.#runtime)
    this.#starting ??= this.#start().then(
      (runtime) => {
        this.#runtime = runtime
        this.#failure = null
        return runtime
      },
      (error: Error) => {
        this.#starting = null
        this.#failure = `Matter ne démarre pas : ${error.message}`
        throw error
      }
    )
    return this.#starting
  }

  async #start(): Promise<MatterRuntime> {
    const main = await import('@matter/main')
    const { CommissioningController: Controller } = await import('@project-chip/matter.js')
    const { hubStorageDriver } = await import('#adapters/matter_storage')
    main.Logger.level = this.#options.logLevel
    const environment = main.Environment.default
    // The hub owns the process: matter.js must not take over its signals or its exit code.
    environment.vars.set('runtime.signals', false)
    environment.vars.set('runtime.exitcode', false)
    environment.vars.set('storage.path', this.#options.dataDir)
    const storage = hubStorageDriver(this.#options.storagePath, `sway-hub:${this.#options.storagePath}`)
    const service = environment.get(main.StorageService)
    service.registerDriver(storage.implementation)
    service.configuredDriver = storage.implementation.id

    const controller = new Controller({
      environment: { environment, id: this.#options.controllerId },
      autoConnect: false,
      adminFabricLabel: this.#fabricLabel,
    })
    await controller.start()
    if (this.#closed) {
      await controller.close()
      storage.close()
      throw new Error('arrêté pendant le démarrage')
    }
    const runtime: MatterRuntime = { main, controller, storage }
    // The controller's own list is the truth; the hub's list only says whether to start.
    for (const nodeId of controller.getCommissionedNodes()) {
      this.#remember(String(nodeId))
      void this.#attach(controller, String(nodeId)).catch((error: Error) => this.#context?.log('warn', `Appareil Matter ${String(nodeId)} : ${error.message}`))
    }
    return runtime
  }

  #hidden(): Set<string> {
    return new Set(
      this.#known
        ?.query<{ native_id: string }, [string]>('SELECT native_id FROM matter_hidden WHERE controller = ?')
        .all(this.#options.controllerId)
        .map((row) => row.native_id) ?? []
    )
  }

  #remember(nodeId: string): void {
    this.#known?.run('INSERT OR IGNORE INTO matter_nodes (controller, node_id, added_at) VALUES (?, ?, ?)', [this.#options.controllerId, nodeId, new Date().toISOString()])
  }

  async #attach(controller: CommissioningController, nodeId: string): Promise<NodeEntry> {
    const existing = this.#nodes.get(nodeId)
    if (existing) return existing
    const id = controller.getCommissionedNodes().find((candidate) => String(candidate) === nodeId)
    if (id === undefined) throw new Error("ce nœud n'est plus dans le réseau Matter du hub")
    const node = await controller.getNode(id)
    const entry: NodeEntry = { id: nodeId, node, name: `Appareil Matter ${nodeId}`, devices: [], online: null, refreshing: false, grace: null, shutdownAt: null, retry: null, retryDelay: this.#options.retryMs }
    this.#nodes.set(nodeId, entry)
    node.events.attributeChanged.on(() => this.#schedule(entry))
    node.events.structureChanged.on(() => this.#rebuild(entry))
    node.events.eventTriggered.on((data) => this.#event(entry, data))
    node.events.stateChanged.on((state) => this.#connection(entry, state))
    node.events.connectionAlive.on(() => {
      if (entry.online === false && !this.#justShutDown(entry)) this.#available(entry, true)
    })
    // Connected here, not by the commissioning, so the subscription gets the hub's ceiling.
    if (!node.isConnected) node.connect({ subscribeMaxIntervalCeilingSeconds: this.#options.subscriptionCeilingSeconds })
    if (!node.initialized) await withTimeout(Promise.resolve(node.events.initialized), 30_000, "l'appareil ne s'est pas présenté")
    this.#rebuild(entry)
    return entry
  }

  // -------------------------------------------------------------------------------------
  // Nodes as devices
  // -------------------------------------------------------------------------------------

  #view(endpoint: MatterEndpoint, only?: Set<string>): EndpointView {
    const clusters: Record<string, Record<string, unknown>> = {}
    for (const name of Object.keys(endpoint.behaviors.supported)) {
      if (only && !only.has(name)) continue
      const state = endpoint.maybeStateOf(name)
      if (state) clusters[name] = state as Record<string, unknown>
    }
    return { id: endpoint.getNumber(), deviceTypes: endpoint.getDeviceTypes().map((type) => type.code), clusters }
  }

  /** Every endpoint of the node below the root, parents before children. */
  #endpoints(node: PairedNode): MatterEndpoint[] {
    const all: MatterEndpoint[] = []
    const visit = (endpoint: MatterEndpoint) => {
      all.push(endpoint)
      for (const child of [...endpoint.getChildEndpoints()].sort((a, b) => a.getNumber() - b.getNumber())) visit(child)
    }
    for (const endpoint of [...node.parts.values()].sort((a, b) => a.getNumber() - b.getNumber())) visit(endpoint)
    return all
  }

  #endpointOf(entry: NodeEntry, id: number): MatterEndpoint | null {
    return this.#endpoints(entry.node).find((endpoint) => endpoint.getNumber() === id) ?? null
  }

  /** The node as the house sees it: its own device, and one per device behind a bridge. */
  #structure(entry: NodeEntry): HubDevice[] {
    const node = entry.node
    const root = node.getRootEndpoint()
    const info = (root?.maybeStateOf('basicInformation') ?? {}) as Record<string, unknown>
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
    const nodeName = text(info.nodeLabel) ?? text(info.productLabel) ?? text(info.productName) ?? `Appareil Matter ${entry.id}`
    entry.name = nodeName
    const identity = text(info.uniqueId)
    const nodeUid = identity ? `matter:${identity}` : deviceUid('matter', entry.id)
    const thread = root ? 'threadNetworkDiagnostics' in root.behaviors.supported : false

    const all = this.#endpoints(node)
    const bridged = new Map<number, number>()
    const main: MatterEndpoint[] = []
    let isBridge = false
    const bridgedRoots: MatterEndpoint[] = []
    for (const endpoint of all) {
      const id = endpoint.getNumber()
      const parent = [...bridged.keys()].find((rootId) => this.#isBelow(all, endpoint, rootId))
      if (parent !== undefined) {
        bridged.set(id, parent)
        continue
      }
      if ('bridgedDeviceBasicInformation' in endpoint.behaviors.supported) {
        bridged.set(id, id)
        bridgedRoots.push(endpoint)
        continue
      }
      if (endpoint.getDeviceTypes().some((type) => type.code === AGGREGATOR)) {
        isBridge = true
        continue
      }
      main.push(endpoint)
    }

    const describe = (endpoints: MatterEndpoint[], base: Omit<DiscoveredDevice, 'capabilities' | 'category' | 'endpoints'>, rootPower: boolean, fallback: DeviceCategory) => {
      const views = endpoints.map((endpoint) => this.#view(endpoint))
      const meaningful = views.filter((view) => categoryOf(view.deviceTypes) !== 'unknown' && categoryOf(view.deviceTypes) !== 'energy')
      const merged = views.filter((view) => !meaningful.includes(view)).map((view) => view.id)
      const capabilities = new Set<CapabilityId>(views.flatMap((view) => capabilitiesOf(view)))
      if (rootPower && root) for (const capability of capabilitiesOf(this.#view(root, ROOT_CLUSTERS))) capabilities.add(capability)
      const primary = meaningful[0] ?? views[0]
      const listed = meaningful.length > 1 ? meaningful.map((view) => view.id) : []
      const discovered: DiscoveredDevice = {
        ...base,
        category: primary ? categoryOf(primary.deviceTypes) : fallback,
        capabilities: [...capabilities],
        endpoints:
          listed.length > 0
            ? meaningful.map((view, index) => ({
                index: view.id,
                name: `${ENDPOINT_LABELS[categoryOf(view.deviceTypes)] ?? 'Partie'} ${index + 1}`,
                category: categoryOf(view.deviceTypes),
                capabilities: capabilitiesOf(view),
              }))
            : undefined,
      }
      if (discovered.category === 'unknown' && isBridge && base.nativeId === entry.id) discovered.category = 'gateway'
      const ordered = primary ? [primary.id, ...views.map((view) => view.id).filter((id) => id !== primary.id)] : []
      return { discovered, endpointIds: ordered, listed, merged }
    }

    const devices: HubDevice[] = []
    const mainDevice = describe(
      main,
      {
        adapterId: 'matter',
        nativeId: entry.id,
        uid: nodeUid,
        name: nodeName,
        transport: thread ? 'thread' : 'matter',
        manufacturer: text(info.vendorName),
        model: text(info.productName),
        firmwareVersion: text(info.softwareVersionString),
        serialNumber: text(info.serialNumber),
        confidence: 1,
        meta: { nodeId: entry.id, vendorId: info.vendorId ?? null, productId: info.productId ?? null },
      },
      true,
      isBridge ? 'gateway' : 'unknown'
    )
    devices.push({ nativeId: entry.id, name: nodeName, bridgedAt: null, ...mainDevice })

    for (const bridgedRoot of bridgedRoots) {
      const rootId = bridgedRoot.getNumber()
      const members = all.filter((endpoint) => bridged.get(endpoint.getNumber()) === rootId)
      const bdbi = (bridgedRoot.maybeStateOf('bridgedDeviceBasicInformation') ?? {}) as Record<string, unknown>
      const name = text(bdbi.nodeLabel) ?? text(bdbi.productName) ?? `${nodeName} ${rootId}`
      const unique = text(bdbi.uniqueId)
      const nativeId = `${entry.id}/${rootId}`
      const device = describe(
        members,
        {
          adapterId: 'matter',
          nativeId,
          uid: unique ? `matter:${unique}` : `${nodeUid}/${rootId}`,
          name,
          transport: thread ? 'thread' : 'matter',
          manufacturer: text(bdbi.vendorName) ?? text(info.vendorName),
          model: text(bdbi.productName),
          firmwareVersion: text(bdbi.softwareVersionString),
          serialNumber: text(bdbi.serialNumber),
          confidence: 1,
          meta: { nodeId: entry.id, bridgedEndpoint: rootId },
        },
        false,
        'unknown'
      )
      devices.push({ nativeId, name, bridgedAt: rootId, ...device })
    }
    return devices
  }

  #isBelow(all: MatterEndpoint[], endpoint: MatterEndpoint, ancestorId: number): boolean {
    const ancestor = all.find((candidate) => candidate.getNumber() === ancestorId)
    if (!ancestor) return false
    const stack = [...ancestor.getChildEndpoints()]
    while (stack.length > 0) {
      const next = stack.pop()!
      if (next.getNumber() === endpoint.getNumber()) return true
      stack.push(...next.getChildEndpoints())
    }
    return false
  }

  #rebuild(entry: NodeEntry): void {
    if (this.#closed) return
    const previous = new Map(entry.devices.map((device) => [device.nativeId, JSON.stringify(device.discovered)]))
    const hidden = this.#hidden()
    entry.devices = this.#structure(entry).filter((device) => !hidden.has(device.nativeId))
    for (const device of entry.devices) {
      if (previous.get(device.nativeId) !== JSON.stringify(device.discovered)) this.#context?.emitDiscovered(device.discovered)
    }
    this.#refresh(entry)
  }

  #schedule(entry: NodeEntry): void {
    if (entry.refreshing) return
    entry.refreshing = true
    setTimeout(() => {
      entry.refreshing = false
      if (!this.#closed) this.#refresh(entry)
    }, 0)
  }

  /** Recompute every device of the node from matter.js's cache, and push what changed. */
  #refresh(entry: NodeEntry): void {
    const now = new Date().toISOString()
    const root = entry.node.getRootEndpoint()
    for (const device of entry.devices) {
      const views = new Map<number, EndpointView>()
      for (const id of device.endpointIds) {
        const endpoint = this.#endpointOf(entry, id)
        if (endpoint) views.set(id, this.#view(endpoint))
      }
      const primary = views.get(device.endpointIds[0] ?? -1)
      const state: Record<string, unknown> = {}
      if (device.bridgedAt === null && root) Object.assign(state, stateOf(this.#view(root, ROOT_CLUSTERS), now))
      for (const id of device.merged) {
        const view = views.get(id)
        if (view) Object.assign(state, stateOf(view, now))
      }
      if (primary) Object.assign(state, stateOf(primary, now))
      this.#push(device.nativeId, state)
      for (const id of device.listed) {
        const view = views.get(id)
        if (view) this.#push(device.nativeId, stateOf(view, now), id)
      }
      if (device.bridgedAt !== null) {
        const bdbi = this.#endpointOf(entry, device.bridgedAt)?.maybeStateOf('bridgedDeviceBasicInformation') as Record<string, unknown> | undefined
        if (bdbi?.reachable === false) this.#context?.emitAvailability(device.nativeId, false)
        else if (bdbi?.reachable === true && entry.online !== false) this.#context?.emitAvailability(device.nativeId, true)
      }
    }
  }

  #push(nativeId: string, state: Record<string, unknown>, endpointIndex?: number): void {
    const key = `${nativeId}|${endpointIndex ?? ''}`
    const previous = this.#pushed.get(key) ?? {}
    const patch: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(state)) if (!same(previous[name], value)) patch[name] = value
    // Dates that belong to a change, not to every report.
    if ('lastMotionAt' in patch && !('motion' in patch)) delete patch.lastMotionAt
    if ('open' in patch && previous.open !== undefined) patch.lastChangedAt = new Date().toISOString()
    if (Object.keys(patch).length === 0) return
    this.#pushed.set(key, { ...previous, ...patch })
    if (endpointIndex === undefined) this.#context?.emitState(nativeId, patch)
    else this.#context?.emitState(nativeId, patch, endpointIndex)
  }

  #event(entry: NodeEntry, data: { path: { endpointId: number; clusterId: number; eventName: string }; events: { data?: unknown }[] }): void {
    const endpointId = Number(data.path.endpointId)
    // A device shutting down cleanly says so (Core 11.1.6.2): offline now, rather than when its
    // subscription finally times out. It is back as soon as it answers again.
    if (Number(data.path.clusterId) === BASIC_INFORMATION_CLUSTER) {
      if (data.path.eventName === 'shutDown' || data.path.eventName === 'leave') {
        entry.shutdownAt = Date.now()
        this.#available(entry, false)
      }
      return
    }
    const device = entry.devices.find((candidate) => candidate.endpointIds.includes(endpointId))
    if (!device) return
    const target = device.listed.includes(endpointId) ? endpointId : undefined
    const at = new Date().toISOString()
    if (Number(data.path.clusterId) === SWITCH_CLUSTER) {
      const endpoint = this.#endpointOf(entry, endpointId)
      const cluster = (endpoint?.maybeStateOf('switch') ?? {}) as Record<string, unknown>
      const features = (cluster.featureMap ?? {}) as Record<string, boolean>
      const switches = device.endpointIds.filter((id) => this.#endpointOf(entry, id)?.behaviors.supported && 'switch' in this.#endpointOf(entry, id)!.behaviors.supported)
      for (const event of data.events) {
        const press = buttonAction(data.path.eventName, (event.data ?? {}) as Record<string, unknown>, features)
        if (!press) continue
        const buttonIndex = switches.length > 1 ? switches.indexOf(endpointId) : Math.max(0, press.position - 1)
        this.#push(device.nativeId, { lastEvent: press.action, lastEventAt: at, buttonIndex }, target)
        this.#context?.emitEvent(device.nativeId, 'button', { action: press.action, buttonIndex })
      }
      return
    }
    if (Number(data.path.clusterId) === DOOR_LOCK_CLUSTER) {
      for (const event of data.events) {
        const payload = (event.data ?? {}) as Record<string, unknown>
        if (data.path.eventName === 'lockOperation') {
          this.#push(device.nativeId, { lastActor: lockActor(Number(payload.operationSource)), jammed: false }, target)
        } else if (data.path.eventName === 'doorLockAlarm' && Number(payload.alarmCode) === 0) {
          this.#push(device.nativeId, { jammed: true }, target)
          this.#context?.emitEvent(device.nativeId, 'lock_jammed', {})
        }
      }
    }
  }

  #connection(entry: NodeEntry, state: number): void {
    if (entry.grace) clearTimeout(entry.grace)
    entry.grace = null
    // Reconnecting is often a blip (a new session, a router restart): offline only if it lasts.
    if (state === RECONNECTING) {
      entry.grace = setTimeout(() => {
        entry.grace = null
        if (!this.#closed) this.#available(entry, false)
      }, this.#options.offlineAfterMs)
      return
    }
    if (state === CONNECTED) {
      if (!this.#justShutDown(entry)) this.#available(entry, true)
    } else if (state === DISCONNECTED || state === WAITING_FOR_DISCOVERY) this.#available(entry, false)
  }

  #justShutDown(entry: NodeEntry): boolean {
    return entry.shutdownAt !== null && Date.now() - entry.shutdownAt < SHUTDOWN_QUIET_MS
  }

  #available(entry: NodeEntry, online: boolean): void {
    if (online === entry.online) return
    entry.online = online
    for (const device of entry.devices) this.#context?.emitAvailability(device.nativeId, online)
    if (online) {
      if (entry.retry) clearTimeout(entry.retry)
      entry.retry = null
      entry.retryDelay = this.#options.retryMs
      this.#refresh(entry)
    } else {
      this.#askAgain(entry)
    }
  }

  /**
   * matter.js only notices a device is back once its old subscription has timed out, which is
   * most of a minute. While a device is offline the hub asks for it again itself, less and
   * less often, so one plugged back in is back in seconds.
   */
  #askAgain(entry: NodeEntry): void {
    if (entry.retry || this.#closed) return
    entry.retry = setTimeout(() => {
      entry.retry = null
      if (this.#closed || entry.online !== false) return
      entry.retryDelay = Math.min(entry.retryDelay * 2, 300_000)
      entry.node.reconnect().catch(() => undefined)
      this.#askAgain(entry)
    }, entry.retryDelay)
  }

  // -------------------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------------------

  async pair(input: Record<string, unknown>): Promise<{ ok: boolean; message: string; device?: DiscoveredDevice }> {
    const raw = [input.code, input.pin, input.pairingCode].find((value) => typeof value === 'string' && value.trim())
    if (typeof raw !== 'string') {
      return { ok: false, message: 'Donner le code d\'appairage de l\'appareil : les 11 chiffres sous son QR code, ou le texte du QR code ("MT:...").' }
    }
    const code = parsePairingCode(raw)
    if ('error' in code) return { ok: false, message: code.error }
    const address = typeof input.address === 'string' ? /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(input.address.trim()) : null

    let runtime: MatterRuntime
    try {
      runtime = await this.#ensureStarted()
    } catch (error) {
      return { ok: false, message: `Matter ne démarre pas : ${(error as Error).message}` }
    }
    const { main, controller } = runtime
    const { GeneralCommissioning } = await import('@matter/main/clusters')
    let nodeId: string
    try {
      const id = await withTimeout(
        controller.commissionNode({
          commissioning: { regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor, regulatoryCountryCode: 'XX' },
          discovery: {
            identifierData: code.kind === 'manual' ? { shortDiscriminator: code.shortDiscriminator } : { longDiscriminator: code.longDiscriminator },
            discoveryCapabilities: { onIpNetwork: true },
            knownAddress: address ? { ip: address[1]!, port: Number(address[2]), type: 'udp' } : undefined,
            timeout: main.Millis(this.#options.pairTimeoutMs),
          },
          passcode: code.passcode,
        }, { connectNodeAfterCommissioning: false }),
        this.#options.pairTimeoutMs + 15_000,
        'timeout'
      )
      nodeId = String(id)
    } catch (error) {
      return { ok: false, message: this.#pairingError(error as Error) }
    }
    this.#remember(nodeId)
    let entry: NodeEntry
    try {
      entry = await this.#attach(controller, nodeId)
    } catch (error) {
      return { ok: false, message: `Appareil ajouté au réseau Matter du hub, mais il ne s'est pas présenté : ${(error as Error).message}. Il apparaîtra dès qu'il répondra.` }
    }
    const [first, ...others] = entry.devices
    const behind = others.length > 0 ? `, avec ${others.length} appareil${others.length > 1 ? 's' : ''} derrière lui` : ''
    return { ok: true, message: `"${first?.name ?? entry.name}" ajouté${behind}.`, device: first?.discovered }
  }

  #pairingError(error: Error): string {
    const message = error.message ?? String(error)
    if (/key confirmation|PASE|Pake|passcode|incorrect/i.test(message)) {
      return "L'appareil refuse ce code : vérifier que c'est bien le sien, recopié en entier, et que sa fenêtre d'appairage est encore ouverte."
    }
    if (/timeout|discover|not found|no device/i.test(message)) {
      return "Aucun appareil Matter en attente d'appairage n'a répondu. Ouvrir sa fenêtre d'appairage (depuis l'application où il est déjà : \"partager\" ou \"associer à une autre application\" ; ou en le remettant en mode appairage), puis réessayer."
    }
    return `L'appairage a échoué : ${message}`
  }

  // -------------------------------------------------------------------------------------
  // The rest of the contract
  // -------------------------------------------------------------------------------------

  #find(nativeId: string): { entry: NodeEntry; device: HubDevice } | null {
    for (const entry of this.#nodes.values()) {
      const device = entry.devices.find((candidate) => candidate.nativeId === nativeId)
      if (device) return { entry, device }
    }
    return null
  }

  async forget(nativeId: string): Promise<{ ok: boolean; message?: string }> {
    const found = this.#find(nativeId)
    if (!found) return { ok: true }
    const { entry, device } = found
    if (device.nativeId !== entry.id) {
      // Behind a bridge: the bridge decides what it bridges. The hub stops showing it.
      this.#known?.run('INSERT OR IGNORE INTO matter_hidden (controller, native_id) VALUES (?, ?)', [this.#options.controllerId, nativeId])
      entry.devices = entry.devices.filter((candidate) => candidate.nativeId !== nativeId)
      this.#forgetPushed(nativeId)
      return { ok: true, message: `"${device.name}" n'est plus suivi ; il reste sur le pont "${entry.name}" tant qu'il n'en est pas retiré.` }
    }
    const runtime = this.#runtime
    if (!runtime) return { ok: false, message: 'Matter ne tourne pas.' }
    const id = runtime.controller.getCommissionedNodes().find((candidate) => String(candidate) === entry.id)
    const reachable = entry.online !== false
    if (entry.grace) clearTimeout(entry.grace)
    if (entry.retry) clearTimeout(entry.retry)
    this.#nodes.delete(entry.id)
    for (const each of entry.devices) this.#forgetPushed(each.nativeId)
    this.#known?.run('DELETE FROM matter_nodes WHERE controller = ? AND node_id = ?', [this.#options.controllerId, entry.id])
    this.#known?.run("DELETE FROM matter_hidden WHERE controller = ? AND native_id LIKE ? || '/%'", [this.#options.controllerId, entry.id])
    // Decommissioning removes the hub's fabric from the device itself, freeing its place for
    // another controller. An unreachable device keeps it until it is reset.
    if (id !== undefined) await withTimeout(runtime.controller.removeNode(id, reachable), 20_000, 'timeout').catch(() => undefined)
    return {
      ok: true,
      message: reachable
        ? `"${entry.name}" a quitté le réseau Matter du hub.`
        : `"${entry.name}" est retiré du hub ; injoignable, il garde l'accès du hub jusqu'à sa remise à zéro.`,
    }
  }

  #forgetPushed(nativeId: string): void {
    for (const key of [...this.#pushed.keys()]) if (key.startsWith(`${nativeId}|`)) this.#pushed.delete(key)
  }

  async discover(_hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    return [...this.#nodes.values()].flatMap((entry) => entry.devices.map((device) => device.discovered))
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    return { ...(this.#pushed.get(`${nativeId}|`) ?? {}) }
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>, endpointIndex?: number): Promise<CommandResult> {
    const fail = (error: string): CommandResult => ({ ok: false, deviceId: nativeId, command, error })
    const found = this.#find(nativeId)
    if (!found) return fail('Appareil Matter inconnu.')
    const { entry, device } = found
    if (entry.online === false) return fail(`"${device.name}" ne répond pas : il est hors ligne.`)

    const candidates = endpointIndex !== undefined ? [endpointIndex] : device.endpointIds
    let refusal: string | null = null
    for (const id of candidates) {
      const endpoint = this.#endpointOf(entry, id)
      if (!endpoint || !device.endpointIds.includes(id)) continue
      const plan = planCommand(this.#view(endpoint), command, args ?? {})
      if ('error' in plan) {
        refusal ??= plan.error
        continue
      }
      try {
        await withTimeout(this.#run(endpoint, plan.actions), this.#options.commandTimeoutMs, 'timeout')
        return { ok: true, deviceId: nativeId, command }
      } catch (error) {
        const message = (error as Error).message
        return fail(message === 'timeout' ? `"${device.name}" ne répond pas.` : `"${device.name}" a refusé : ${message}`)
      }
    }
    return fail(refusal ?? `Cet appareil Matter ne sait pas faire "${command}".`)
  }

  async #run(endpoint: MatterEndpoint, actions: ReturnType<typeof planCommand> extends infer P ? (P extends { actions: infer A } ? A : never) : never): Promise<void> {
    for (const action of actions) {
      if ('invoke' in action) {
        const commands = endpoint.commandsOf(action.invoke.cluster) as Record<string, ((args?: unknown) => Promise<unknown>) | undefined>
        const run = commands[action.invoke.command]
        if (!run) throw new Error(`commande ${action.invoke.cluster}.${action.invoke.command} absente`)
        await (action.invoke.args === undefined ? run() : run(action.invoke.args))
      } else {
        await endpoint.setStateOf(action.write.cluster, action.write.values as never)
      }
    }
  }

  status(): AdapterStatus {
    const deviceCount = [...this.#nodes.values()].reduce((total, entry) => total + entry.devices.length, 0)
    if (this.#failure) return { health: 'error', deviceCount, message: this.#failure }
    if (this.#nodes.size === 0 && this.#knownNodes().length === 0) {
      return {
        health: 'needs_setup',
        deviceCount,
        message: "Aucun appareil Matter : en ajouter un avec son code d'appairage (les 11 chiffres sous son QR code, ou le texte \"MT:...\").",
      }
    }
    const offline = [...this.#nodes.values()].filter((entry) => entry.online === false).map((entry) => entry.name)
    if (offline.length > 0) return { health: 'degraded', deviceCount, message: `Hors ligne : ${offline.join(', ')}.` }
    return { health: 'ok', deviceCount }
  }

  async shutdown(): Promise<void> {
    this.#closed = true
    const runtime = this.#runtime ?? (this.#starting ? await this.#starting.catch(() => null) : null)
    this.#runtime = null
    this.#starting = null
    for (const entry of this.#nodes.values()) {
      if (entry.grace) clearTimeout(entry.grace)
      if (entry.retry) clearTimeout(entry.retry)
    }
    this.#nodes.clear()
    this.#pushed.clear()
    if (runtime) {
      await runtime.controller.close().catch(() => undefined)
      runtime.storage.close()
    }
    this.#known?.close()
    this.#known = null
    this.#context = null
  }
}
