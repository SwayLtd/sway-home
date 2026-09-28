/**
 * Network scan, wired to the bus and the database.
 *
 * Discovery itself lives in `@sway-home/discovery` and knows nothing about the hub. This
 * file is the bridge: it runs a scan, streams progress to every open socket, stores what it
 * found, and then lets every adapter claim what it recognises.
 */

import { scanNetwork, primaryInterface, type Fingerprint, type ScanPhaseProgress } from '@sway-home/discovery'
import type { NetworkHost } from '@sway-home/shared'
import { bus } from '#services/event_bus'
import { adapters } from '#services/adapter_manager'
import { hosts, settings } from '#repositories/store'
import { deviceRepository } from '#repositories/device_repository'

export interface ScanSummary {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  durationMs: number
  hostCount: number
  newDevices: number
  updatedDevices: number
  phase: ScanPhaseProgress | null
  error: string | null
}

let current: ScanSummary = {
  running: false,
  startedAt: null,
  finishedAt: null,
  durationMs: 0,
  hostCount: 0,
  newDevices: 0,
  updatedDevices: 0,
  phase: null,
  error: null,
}

let controller: AbortController | null = null

export const scanService = {
  state(): ScanSummary {
    return { ...current }
  },

  isRunning(): boolean {
    return current.running
  },

  cancel(): void {
    controller?.abort()
  },

  /** Refresh the cached facts about the interface the hub is on. */
  refreshNetworkFacts(): void {
    const iface = primaryInterface()
    if (!iface) return
    adapters.setNetwork({
      localIp: iface.address,
      cidr: iface.cidr,
      gateway: guessGateway(iface.address),
      interfaceName: iface.name,
    })
  },

  async run(options: { quick?: boolean; deep?: boolean } = {}): Promise<ScanSummary> {
    if (current.running) return scanService.state()

    controller = new AbortController()
    current = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: 0,
      hostCount: 0,
      newDevices: 0,
      updatedDevices: 0,
      phase: null,
      error: null,
    }

    bus.publish('scan.started', { payload: { quick: options.quick === true } })

    try {
      const result = await scanNetwork({
        quick: options.quick,
        deep: options.deep,
        ouiRegistryPath: new URL('../../../../data/oui.csv', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
        signal: controller.signal,
        onProgress: (phase) => {
          current.phase = phase
          current.hostCount = phase.found
          bus.publish('scan.progress', { payload: { ...phase } })
        },
      })

      scanService.refreshNetworkFacts()

      // Persist the hosts before the adapters run, so a failing adapter still leaves the
      // network map on screen.
      const fingerprintByIp = result.fingerprints
      for (const host of result.hosts) {
        hosts.upsert(host, fingerprintByIp.get(host.ip) ?? null)
      }

      const { added, updated } = await adapters.discover(result.hosts)

      // Link the device rows back to the host rows so the network screen can show which
      // lines are already controlled and which are still just addresses.
      for (const device of deviceRepository.all({ includeHidden: true, limit: 1000 })) {
        const ip = device.network.ip
        if (ip) hosts.claim(ip, device.id)
      }

      current = {
        ...current,
        running: false,
        finishedAt: new Date().toISOString(),
        durationMs: result.durationMs,
        hostCount: result.hosts.length,
        newDevices: added,
        updatedDevices: updated,
        phase: null,
      }

      settings.set('scan.last', {
        at: current.finishedAt,
        durationMs: result.durationMs,
        hosts: result.hosts.length,
        stats: result.stats,
        unrecognisedServices: result.unrecognisedServices,
        interface: result.interface,
      })

      bus.publish('scan.finished', {
        payload: {
          hosts: result.hosts.length,
          added,
          updated,
          durationMs: result.durationMs,
          stats: result.stats,
          unrecognisedServices: result.unrecognisedServices,
        },
      })

      return scanService.state()
    } catch (error) {
      current = { ...current, running: false, finishedAt: new Date().toISOString(), error: (error as Error).message, phase: null }
      bus.publish('system.error', { severity: 'warning', payload: { where: 'scan', message: current.error } })
      return scanService.state()
    } finally {
      controller = null
    }
  },

  /** Hosts with their fingerprint, for the network screen. */
  hosts(): ReturnType<typeof hosts.all> {
    return hosts.all()
  },

  /**
   * Hosts that look like something we could control but that no adapter claimed. This is
   * the list that turns into "we found 4 things we do not speak yet" in the UI, and into
   * the roadmap for which adapter to write next.
   */
  unclaimed(): { host: NetworkHost; fingerprint: Fingerprint }[] {
    return hosts
      .all()
      .filter((host) => host.deviceId === null)
      .map((host) => ({ host: host as NetworkHost, fingerprint: host.fingerprint as unknown as Fingerprint }))
      .filter(({ fingerprint }) => (fingerprint?.confidence ?? 0) > 0.3 || (fingerprint?.suggestedAdapters?.length ?? 0) > 0)
  },
}

/** The gateway is almost always `.1` on a home subnet; good enough as a default. */
function guessGateway(localIp: string): string | null {
  const parts = localIp.split('.')
  if (parts.length !== 4) return null
  return `${parts[0]}.${parts[1]}.${parts[2]}.1`
}
