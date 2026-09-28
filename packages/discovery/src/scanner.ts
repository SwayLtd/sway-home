/**
 * The scan.
 *
 * Phases run in the order that gets a useful answer on screen fastest, not in the order
 * that is tidiest: the ARP table is instant, mDNS and SSDP answer in three seconds and
 * name half the house, and the TCP sweep - the slow part - runs underneath them. The UI
 * subscribes to `onProgress` and fills in as it goes rather than waiting for the end.
 */

import { fingerprintHost, fallbackName, type Fingerprint } from './fingerprint.ts'
import { browse as mdnsBrowse } from './mdns.ts'
import { search as ssdpSearch } from './ssdp.ts'
import { lookupVendor, primeOui } from './oui.ts'
import { deepScan, hostsInCidr, netbiosName, primaryInterface, readArpTable, sweep, type LocalInterface } from './net.ts'
import type { NetworkHost } from '@sway-home/shared'

export interface ScanPhaseProgress {
  phase: 'arp' | 'mdns' | 'ssdp' | 'sweep' | 'deep' | 'names' | 'http' | 'fingerprint'
  done: number
  total: number
  found: number
  message?: string
}

export interface ScanOptions {
  interfaceAddress?: string
  cidr?: string
  /** Skip the TCP sweep. mDNS + SSDP + ARP only: about 5 seconds, finds the talkative half. */
  quick?: boolean
  /** Second, wider port pass on hosts already known to be alive. */
  deep?: boolean
  /** Fetch `/` on open HTTP ports to read the page title. Local only, never leaves the LAN. */
  httpProbe?: boolean
  ouiRegistryPath?: string
  signal?: AbortSignal
  onProgress?: (progress: ScanPhaseProgress) => void
  onHost?: (host: NetworkHost, fingerprint: Fingerprint) => void
}

export interface ScanResult {
  interface: LocalInterface | null
  hosts: NetworkHost[]
  fingerprints: Map<string, Fingerprint>
  /** Service types seen on the wire that we have no rule for. Feeds the "unknown" panel. */
  unrecognisedServices: string[]
  startedAt: string
  finishedAt: string
  durationMs: number
  stats: { arp: number; mdns: number; ssdp: number; sweep: number; total: number }
}

const HTTP_PORTS = [80, 8080, 8081, 81, 8008, 5000, 3000, 8123, 8888]

async function probeHttp(ip: string, port: number, timeoutMs = 1200): Promise<{ banner: string | null; title: string | null }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(`http://${ip}:${port}/`, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'user-agent': 'Sway-Home/0.1 (local discovery)' },
    })
    clearTimeout(timer)

    const serverHeader = response.headers.get('server')
    const wwwAuth = response.headers.get('www-authenticate')
    const banner = [serverHeader, wwwAuth].filter(Boolean).join(' ') || null

    // Only read the first few KB: some devices stream a video feed from `/`.
    let title: string | null = null
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('html') || contentType === '') {
      const text = (await response.text()).slice(0, 8192)
      title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(text)?.[1]?.trim() ?? null
    }

    return { banner, title }
  } catch {
    return { banner: null, title: null }
  }
}

export async function scanNetwork(options: ScanOptions = {}): Promise<ScanResult> {
  const startedAt = new Date()
  const started = performance.now()
  const report = (progress: ScanPhaseProgress) => options.onProgress?.(progress)

  await primeOui({ registryPath: options.ouiRegistryPath })

  const iface = options.interfaceAddress
    ? (await import('./net.ts')).listInterfaces().find((i) => i.address === options.interfaceAddress) ?? primaryInterface()
    : primaryInterface()

  const cidr = options.cidr ?? iface?.cidr ?? '192.168.1.0/24'
  const hosts = new Map<string, NetworkHost>()
  const now = () => new Date().toISOString()

  const upsert = (ip: string, patch: Partial<NetworkHost>, source: NetworkHost['source'][number]): NetworkHost => {
    const existing = hosts.get(ip)
    const base: NetworkHost = existing ?? {
      ip,
      mac: null,
      macVendor: null,
      hostname: null,
      openPorts: [],
      mdnsServices: [],
      mdnsTxt: {},
      ssdp: null,
      httpBanner: null,
      httpTitle: null,
      rttMs: null,
      firstSeenAt: now(),
      lastSeenAt: now(),
      source: [],
    }

    const merged: NetworkHost = {
      ...base,
      ...patch,
      openPorts: [...new Set([...base.openPorts, ...(patch.openPorts ?? [])])].sort((a, b) => a - b),
      mdnsServices: [...new Set([...base.mdnsServices, ...(patch.mdnsServices ?? [])])],
      mdnsTxt: { ...base.mdnsTxt, ...(patch.mdnsTxt ?? {}) },
      ssdp: patch.ssdp ?? base.ssdp,
      mac: patch.mac ?? base.mac,
      hostname: patch.hostname ?? base.hostname,
      lastSeenAt: now(),
      source: [...new Set([...base.source, source])],
    }
    merged.macVendor = lookupVendor(merged.mac) ?? merged.macVendor
    hosts.set(ip, merged)
    return merged
  }

  // --- phase 1: ARP table, instant -------------------------------------------------------
  report({ phase: 'arp', done: 0, total: 1, found: 0 })
  const arp = await readArpTable()
  for (const entry of arp) {
    if (!entry.ip.startsWith(cidr.split('/')[0]?.split('.').slice(0, 3).join('.') ?? '')) continue
    upsert(entry.ip, { mac: entry.mac }, 'arp')
  }
  const arpCount = hosts.size
  report({ phase: 'arp', done: 1, total: 1, found: arpCount })

  // --- phase 2 and 3: mDNS and SSDP, in parallel ----------------------------------------
  report({ phase: 'mdns', done: 0, total: 1, found: hosts.size })
  const [mdnsResult, ssdpResult] = await Promise.all([
    mdnsBrowse({ durationMs: options.quick ? 3000 : 5000, interfaceAddress: iface?.address, signal: options.signal }),
    ssdpSearch({ durationMs: options.quick ? 3000 : 5000, interfaceAddress: iface?.address, describe: true, signal: options.signal }),
  ])

  for (const service of mdnsResult.services) {
    for (const address of service.addresses) {
      if (!address.includes('.')) continue
      upsert(
        address,
        {
          mdnsServices: [service.type],
          mdnsTxt: service.txt,
          hostname: service.host?.replace(/\.local\.?$/, '') ?? service.name,
          openPorts: service.port ? [service.port] : [],
        },
        'mdns'
      )
    }
  }
  for (const [ip, hostname] of mdnsResult.hostnames) {
    upsert(ip, { hostname }, 'mdns')
  }
  const mdnsCount = mdnsResult.services.length
  report({ phase: 'mdns', done: 1, total: 1, found: hosts.size, message: `${mdnsCount} services` })

  for (const response of ssdpResult) {
    upsert(
      response.address,
      {
        ssdp: {
          server: response.server ?? undefined,
          st: response.st,
          location: response.location ?? undefined,
          usn: response.usn,
          friendlyName: response.friendlyName ?? undefined,
          modelName: response.modelName ?? undefined,
        },
      },
      'ssdp'
    )
  }
  report({ phase: 'ssdp', done: 1, total: 1, found: hosts.size, message: `${ssdpResult.length} responses` })

  // --- phase 4: TCP sweep ---------------------------------------------------------------
  let sweepCount = 0
  if (!options.quick) {
    const candidates = hostsInCidr(cidr)
    report({ phase: 'sweep', done: 0, total: candidates.length, found: hosts.size })
    const swept = await sweep(candidates, {
      signal: options.signal,
      onProgress: (done, total, found) => report({ phase: 'sweep', done, total, found: hosts.size + found }),
    })
    sweepCount = swept.length
    for (const result of swept) {
      upsert(result.ip, { openPorts: result.openPorts, rttMs: result.rttMs }, 'tcp')
    }

    // A sweep populates the ARP cache as a side effect; re-read it to pick up the MACs of
    // hosts that answered nothing at the application layer.
    const arpAfter = await readArpTable()
    for (const entry of arpAfter) {
      if (hosts.has(entry.ip)) upsert(entry.ip, { mac: entry.mac }, 'arp')
    }
  }

  // --- phase 5: deeper ports on hosts we know exist -------------------------------------
  if (options.deep && hosts.size > 0) {
    const ips = [...hosts.keys()]
    report({ phase: 'deep', done: 0, total: ips.length, found: hosts.size })
    const deep = await deepScan(ips, { signal: options.signal })
    for (const [ip, ports] of deep) upsert(ip, { openPorts: ports }, 'tcp')
    report({ phase: 'deep', done: ips.length, total: ips.length, found: hosts.size })
  }

  // --- phase 6: names for anything still anonymous --------------------------------------
  const anonymous = [...hosts.values()].filter((host) => host.hostname === null)
  if (anonymous.length > 0) {
    report({ phase: 'names', done: 0, total: anonymous.length, found: hosts.size })
    let done = 0
    const queue = [...anonymous]
    const workers = Array.from({ length: Math.min(12, queue.length) }, async () => {
      while (queue.length > 0) {
        const host = queue.shift()
        if (!host) break
        const name = await netbiosName(host.ip)
        if (name) upsert(host.ip, { hostname: name }, 'netbios')
        done += 1
        if (done % 4 === 0) report({ phase: 'names', done, total: anonymous.length, found: hosts.size })
      }
    })
    await Promise.all(workers)
  }

  // --- phase 7: HTTP banners ------------------------------------------------------------
  if (options.httpProbe !== false) {
    const httpHosts = [...hosts.values()].filter((host) => host.openPorts.some((port) => HTTP_PORTS.includes(port)))
    report({ phase: 'http', done: 0, total: httpHosts.length, found: hosts.size })
    let done = 0
    const queue = [...httpHosts]
    const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (queue.length > 0) {
        const host = queue.shift()
        if (!host) break
        const port = host.openPorts.find((p) => HTTP_PORTS.includes(p))
        if (port !== undefined) {
          const { banner, title } = await probeHttp(host.ip, port)
          if (banner || title) upsert(host.ip, { httpBanner: banner, httpTitle: title }, 'tcp')
        }
        done += 1
        report({ phase: 'http', done, total: httpHosts.length, found: hosts.size })
      }
    })
    await Promise.all(workers)
  }

  // --- phase 8: fingerprint --------------------------------------------------------------
  report({ phase: 'fingerprint', done: 0, total: hosts.size, found: hosts.size })
  const fingerprints = new Map<string, Fingerprint>()
  for (const host of hosts.values()) {
    const fingerprint = fingerprintHost(host)
    fingerprints.set(host.ip, fingerprint)
    options.onHost?.(host, fingerprint)
  }

  const knownTypes = new Set<string>()
  for (const host of hosts.values()) for (const service of host.mdnsServices) knownTypes.add(service)
  const unrecognisedServices = [...mdnsResult.advertisedTypes].filter((type) => !knownTypes.has(type))

  const finishedAt = new Date()
  return {
    interface: iface,
    hosts: [...hosts.values()].sort((a, b) => ipOrder(a.ip) - ipOrder(b.ip)),
    fingerprints,
    unrecognisedServices,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
    stats: { arp: arpCount, mdns: mdnsCount, ssdp: ssdpResult.length, sweep: sweepCount, total: hosts.size },
  }
}

function ipOrder(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0)
}

export { fallbackName, fingerprintHost }
export type { Fingerprint }
