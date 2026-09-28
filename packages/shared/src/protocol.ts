/**
 * The adapter contract.
 *
 * Everything that can talk to a device - a hand-written LAN protocol, a vendor cloud, a
 * Matter controller, the virtual house used for tests - implements this one interface.
 * Adding a brand is writing one file; nothing above the adapter layer changes.
 *
 * The interface is deliberately small. An adapter that only knows how to find devices and
 * turn them on is a valid adapter, and the UI degrades to what it declares rather than
 * pretending a capability exists and failing at runtime.
 */

import type { CapabilityId } from './capabilities.ts'
import type { CommandResult, DeviceCategory, Transport } from './device.ts'

/** What discovery found before any adapter claimed it. */
export interface NetworkHost {
  ip: string
  mac: string | null
  macVendor: string | null
  hostname: string | null
  openPorts: number[]
  /** Raw mDNS service records, e.g. `_googlecast._tcp.local`. */
  mdnsServices: string[]
  mdnsTxt: Record<string, string>
  /** SSDP/UPnP device description fields, when the host answered an M-SEARCH. */
  ssdp: { server?: string; st?: string; location?: string; usn?: string; friendlyName?: string; modelName?: string } | null
  /** First bytes of an HTTP response on a well-known port; used for fingerprinting only. */
  httpBanner: string | null
  httpTitle: string | null
  rttMs: number | null
  firstSeenAt: string
  lastSeenAt: string
  source: ('arp' | 'icmp' | 'tcp' | 'mdns' | 'ssdp' | 'dhcp' | 'netbios' | 'wsd' | 'manual')[]
}

/** An adapter's claim on a host, or on something it found over its own radio. */
export interface DiscoveredDevice {
  adapterId: string
  /** Address the adapter will use later. Must be stable for the adapter. */
  nativeId: string
  uid: string
  name: string
  category: DeviceCategory
  capabilities: CapabilityId[]
  transport: Transport
  manufacturer?: string | null
  model?: string | null
  firmwareVersion?: string | null
  serialNumber?: string | null
  /** 0 to 1. Two adapters claiming the same host: the higher score wins. */
  confidence: number
  endpoints?: { index: number; name: string; category: DeviceCategory; capabilities: CapabilityId[] }[]
  network?: { ip?: string | null; mac?: string | null; hostname?: string | null }
  /** Anything the adapter needs to remember. Persisted as JSON with the device. */
  meta?: Record<string, unknown>
  /** Set when the device cannot be controlled until a human does something. */
  requiresPairing?: { kind: 'button' | 'code' | 'oauth' | 'token' | 'qr'; instructions: string } | null
}

export interface AdapterContext {
  /** Push a state change up. Partial: only the keys that changed. */
  emitState(nativeId: string, state: Record<string, unknown>, endpointIndex?: number): void
  /** Push a discrete event up (button press, doorbell, motion start). */
  emitEvent(nativeId: string, event: string, payload?: Record<string, unknown>): void
  /** Report that a device appeared or disappeared outside a scan. */
  emitAvailability(nativeId: string, online: boolean): void
  /** Adapters discovered later than the first scan (a bulb plugged in at 9pm). */
  emitDiscovered(device: DiscoveredDevice): void
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void
  /** Per-adapter key/value store, persisted in SQLite. Tokens go here, not in code. */
  store: {
    get<T = unknown>(key: string): Promise<T | null>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  /** Local network facts, so an adapter never has to work them out again. */
  network: { localIp: string; cidr: string; gateway: string | null; interfaceName: string }
  signal: AbortSignal
}

export type AdapterHealth = 'ok' | 'degraded' | 'error' | 'disabled' | 'needs_setup'

export interface AdapterStatus {
  health: AdapterHealth
  message?: string
  deviceCount: number
  lastScanAt?: string | null
  lastErrorAt?: string | null
}

export interface AdapterDescriptor {
  id: string
  name: string
  /** Vendor or ecosystem, used to group the integrations screen. */
  vendor: string
  transports: Transport[]
  /** Everything the adapter can ever expose. The UI uses it before any device is found. */
  capabilities: CapabilityId[]
  /** True when the adapter needs no credentials and can simply be switched on. */
  zeroConfig: boolean
  /** Whether the adapter reaches a vendor cloud. Privacy mode disables all of these. */
  cloud: boolean
  /** True when the implementation is in the repo and tested; false when it is declared only. */
  implemented: boolean
  /** Hardware the adapter needs to work, e.g. a Zigbee coordinator. */
  requiresHardware?: string | null
  docsUrl?: string
  /** Configuration fields the setup drawer renders. */
  configSchema?: AdapterConfigField[]
}

export interface AdapterConfigField {
  key: string
  label: string
  /** `text` is several lines (a JSON map, a list); `string` is one. */
  type: 'string' | 'text' | 'password' | 'number' | 'boolean' | 'select' | 'host'
  required?: boolean
  placeholder?: string
  help?: string
  options?: { value: string; label: string }[]
  default?: unknown
}

export interface ProtocolAdapter {
  readonly descriptor: AdapterDescriptor

  /** Called once at boot, with whatever configuration the user saved. */
  init(context: AdapterContext, config: Record<string, unknown>): Promise<void>

  /**
   * Look for devices. `hosts` is what the network scan found, so a LAN adapter does not
   * re-scan the subnet twenty times; a radio adapter ignores it.
   */
  discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]>

  /** Read the current state of one device. */
  getState(nativeId: string): Promise<Record<string, unknown>>

  /** Execute a command from the shared vocabulary. */
  execute(
    nativeId: string,
    command: string,
    args: Record<string, unknown>,
    endpointIndex?: number
  ): Promise<CommandResult>

  /** Optional: subscribe to pushes so the hub does not have to poll. */
  subscribe?(nativeIds: string[]): Promise<void>

  /** Optional: pairing flow for adapters that need one. */
  pair?(input: Record<string, unknown>): Promise<{ ok: boolean; message: string; device?: DiscoveredDevice }>

  /**
   * Optional: the house no longer wants this device. The adapter lets go of it for good -
   * leaves the device's fabric or pairing, drops what it kept for it - so the next scan does
   * not bring it back.
   */
  forget?(nativeId: string): Promise<{ ok: boolean; message?: string }>

  /**
   * Optional: a still image from a camera, fetched by the hub so the camera's login never
   * leaves it. Null when the camera has none to give or did not answer.
   */
  snapshot?(nativeId: string): Promise<{ contentType: string; body: Uint8Array } | null>

  status(): AdapterStatus

  shutdown(): Promise<void>
}

/** A concise capability report an adapter can fill in without a device present. */
export interface AdapterSelfTest {
  adapterId: string
  ok: boolean
  checks: { name: string; ok: boolean; detail?: string; durationMs?: number }[]
}

export type DeviceMatcher = (host: NetworkHost) => boolean

/** Small helpers adapters share, kept here so twenty files do not re-derive them. */
export const fingerprint = {
  hasPort: (host: NetworkHost, ...ports: number[]) => ports.some((p) => host.openPorts.includes(p)),
  hasService: (host: NetworkHost, ...services: string[]) =>
    services.some((s) => host.mdnsServices.some((m) => m.includes(s))),
  bannerMatches: (host: NetworkHost, pattern: RegExp) =>
    (host.httpBanner !== null && pattern.test(host.httpBanner)) ||
    (host.httpTitle !== null && pattern.test(host.httpTitle)),
  vendorMatches: (host: NetworkHost, pattern: RegExp) => host.macVendor !== null && pattern.test(host.macVendor),
  ssdpMatches: (host: NetworkHost, pattern: RegExp) =>
    host.ssdp !== null &&
    [host.ssdp.server, host.ssdp.st, host.ssdp.modelName, host.ssdp.friendlyName]
      .filter((v): v is string => typeof v === 'string')
      .some((v) => pattern.test(v)),
}

export function deviceUid(adapterId: string, nativeId: string): string {
  return `${adapterId}:${nativeId}`
}
