/**
 * mDNS / DNS-SD browser.
 *
 * Two passes, because one is never enough on a real network:
 *  1. A meta-query for `_services._dns-sd._udp.local`, which makes every responder list the
 *     service types it offers. That finds the brands we have never heard of.
 *  2. A direct PTR query for a list of service types we know map to something we can
 *     control, which is faster and catches responders that ignore the meta-query.
 *
 * Responses are collected passively for the whole window, so devices that answer someone
 * else's query are picked up too.
 */

import dgram from 'node:dgram'
import { decodeMessage, encodeQuery, RECORD_TYPE, type SrvData } from './dns-wire.ts'

const MDNS_ADDRESS = '224.0.0.251'
const MDNS_PORT = 5353

/**
 * Service types worth asking about by name. Each one is a real integration target, and the
 * comment is what it actually turns out to be on a home network.
 */
export const KNOWN_SERVICE_TYPES = [
  '_services._dns-sd._udp.local', // the meta-query
  '_matter._tcp.local', // commissioned Matter device
  '_matterc._udp.local', // Matter device waiting to be commissioned
  '_matterd._udp.local', // Matter commissioner
  '_meshcop._udp.local', // Thread border router
  '_hap._tcp.local', // HomeKit accessory
  '_hue._tcp.local', // Philips Hue bridge
  '_googlecast._tcp.local', // Chromecast, Google TV, Nest speakers
  '_airplay._tcp.local', // Apple TV, AirPlay 2 speakers
  '_raop._tcp.local', // AirPlay audio
  '_spotify-connect._tcp.local',
  '_sonos._tcp.local',
  '_esphomelib._tcp.local', // ESPHome native API
  '_shelly._tcp.local',
  '_tasmota._tcp.local',
  '_wled._tcp.local',
  '_nanoleafapi._tcp.local',
  '_elg._tcp.local', // Elgato Key Light
  '_axis-video._tcp.local',
  '_dahua._tcp.local',
  '_rtsp._tcp.local', // cameras and NVRs
  '_ipp._tcp.local', // printers
  '_ipps._tcp.local',
  '_pdl-datastream._tcp.local',
  '_printer._tcp.local',
  '_scanner._tcp.local',
  '_http._tcp.local',
  '_https._tcp.local',
  '_workstation._tcp.local',
  '_smb._tcp.local',
  '_afpovertcp._tcp.local',
  '_device-info._tcp.local',
  '_companion-link._tcp.local', // Apple continuity
  '_homekit._tcp.local',
  '_home-assistant._tcp.local',
  '_miio._udp.local', // Xiaomi
  '_dyson_mqtt._tcp.local',
  '_amzn-wplay._tcp.local', // Fire TV
  '_androidtvremote2._tcp.local',
  '_viziocast._tcp.local',
  '_roku._tcp.local',
  '_touch-able._tcp.local', // iTunes/Apple TV remote
  '_daap._tcp.local',
  '_teamviewer._tcp.local',
  '_ssh._tcp.local',
  '_sftp-ssh._tcp.local',
  '_nvstream._tcp.local', // NVIDIA GameStream / Sunshine
  '_plexmediasvr._tcp.local',
  '_jellyfin._tcp.local',
  '_octoprint._tcp.local',
  '_prusa-link._tcp.local',
  '_bambulab._tcp.local',
  '_zigbee._tcp.local',
  '_zwave._tcp.local',
  '_openthread._udp.local',
  '_coap._udp.local',
  '_tplink._tcp.local',
  '_kasa._tcp.local',
  '_lifx._tcp.local',
  '_govee._tcp.local',
  '_aqara._tcp.local',
  '_ewelink._tcp.local',
  '_tuya._tcp.local',
  '_freebox._tcp.local', // French ISP boxes, very common here
  '_livebox._tcp.local',
  '_bbox._tcp.local',
] as const

export interface MdnsService {
  /** e.g. `_googlecast._tcp.local` */
  type: string
  /** e.g. `Salon-TV._googlecast._tcp.local` */
  instance: string
  name: string
  host: string | null
  port: number | null
  addresses: string[]
  txt: Record<string, string>
  lastSeenAt: string
}

export interface MdnsResult {
  services: MdnsService[]
  /** ip -> hostnames seen in A records, useful even when no service matched. */
  hostnames: Map<string, string>
  /** Every service type any responder advertised, including ones we did not ask about. */
  advertisedTypes: Set<string>
}

interface BrowseOptions {
  durationMs?: number
  interfaceAddress?: string
  serviceTypes?: readonly string[]
  signal?: AbortSignal
  onService?: (service: MdnsService) => void
}

export async function browse(options: BrowseOptions = {}): Promise<MdnsResult> {
  const duration = options.durationMs ?? 4000
  const types = options.serviceTypes ?? KNOWN_SERVICE_TYPES

  const services = new Map<string, MdnsService>()
  const hostnames = new Map<string, string>()
  const advertisedTypes = new Set<string>()
  /** hostname -> addresses, filled from A/AAAA records that arrive in any packet. */
  const addressBook = new Map<string, Set<string>>()

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

  const finish = () => {
    // Late A records often resolve a service whose SRV arrived first.
    for (const service of services.values()) {
      if (service.host && service.addresses.length === 0) {
        const found = addressBook.get(service.host)
        if (found) service.addresses = [...found]
      }
    }
  }

  return new Promise<MdnsResult>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // already closed
      }
      finish()
      resolve({ services: [...services.values()], hostnames, advertisedTypes })
    }

    const timer = setTimeout(done, duration)
    options.signal?.addEventListener('abort', done, { once: true })

    socket.on('error', done)

    socket.on('message', (message, remote) => {
      const decoded = decodeMessage(new Uint8Array(message))
      if (!decoded) return

      const records = [...decoded.answers, ...decoded.additionals, ...decoded.authorities]

      for (const record of records) {
        if (record.type === RECORD_TYPE.A || record.type === RECORD_TYPE.AAAA) {
          const address = record.data as string
          const set = addressBook.get(record.name) ?? new Set<string>()
          set.add(address)
          addressBook.set(record.name, set)
          if (record.type === RECORD_TYPE.A) {
            hostnames.set(address, record.name.replace(/\.local$/, ''))
          }
        }
      }

      for (const record of records) {
        if (record.type !== RECORD_TYPE.PTR) continue
        const target = record.data as string

        if (record.name === '_services._dns-sd._udp.local') {
          advertisedTypes.add(target)
          continue
        }

        advertisedTypes.add(record.name)
        const instance = target
        const key = instance
        const existing = services.get(key)
        const service: MdnsService = existing ?? {
          type: record.name,
          instance,
          name: instance.replace(`.${record.name}`, '').replace(/\\032/g, ' '),
          host: null,
          port: null,
          addresses: [],
          txt: {},
          lastSeenAt: new Date().toISOString(),
        }

        // SRV and TXT for this instance usually ride in the same packet.
        for (const extra of records) {
          if (extra.name !== instance) continue
          if (extra.type === RECORD_TYPE.SRV) {
            const srv = extra.data as SrvData
            service.host = srv.target
            service.port = srv.port
          }
          if (extra.type === RECORD_TYPE.TXT) {
            service.txt = { ...service.txt, ...(extra.data as Record<string, string>) }
          }
        }

        if (service.addresses.length === 0) {
          const direct = addressBook.get(service.host ?? '')
          if (direct) service.addresses = [...direct]
          else if (remote.address) service.addresses = [remote.address]
        }

        service.lastSeenAt = new Date().toISOString()
        if (!existing) {
          services.set(key, service)
          options.onService?.(service)
        } else {
          services.set(key, service)
        }
      }
    })

    socket.bind(MDNS_PORT, () => {
      try {
        socket.setMulticastTTL(255)
        socket.setMulticastLoopback(true)
        if (options.interfaceAddress) socket.setMulticastInterface(options.interfaceAddress)
        socket.addMembership(MDNS_ADDRESS, options.interfaceAddress)
      } catch {
        // Some Windows adapters refuse addMembership on a specific interface; the socket
        // still receives multicast on the default one, so carry on rather than fail.
        try {
          socket.addMembership(MDNS_ADDRESS)
        } catch {
          /* no multicast available */
        }
      }

      // Ask in small batches: a single packet with 60 questions is dropped by some stacks.
      const batches: { name: string; type: number }[][] = []
      for (let i = 0; i < types.length; i += 8) {
        batches.push(types.slice(i, i + 8).map((name) => ({ name, type: RECORD_TYPE.PTR })))
      }

      batches.forEach((batch, index) => {
        setTimeout(() => {
          if (settled) return
          try {
            socket.send(encodeQuery(batch), MDNS_PORT, MDNS_ADDRESS)
          } catch {
            /* interface went away mid-scan */
          }
        }, index * 120)
      })

      // A second round halfway through catches devices that were asleep for the first.
      setTimeout(() => {
        if (settled) return
        batches.forEach((batch, index) => {
          setTimeout(() => {
            if (settled) return
            try {
              socket.send(encodeQuery(batch), MDNS_PORT, MDNS_ADDRESS)
            } catch {
              /* ignore */
            }
          }, index * 120)
        })
      }, Math.floor(duration / 2))
    })
  })
}

/** Resolve one instance to an address and port, for a device we already know about. */
export async function resolveInstance(instance: string, timeoutMs = 2500): Promise<MdnsService | null> {
  const result = await browse({ durationMs: timeoutMs, serviceTypes: [instance.split('.').slice(1).join('.')] })
  return result.services.find((s) => s.instance === instance) ?? null
}
