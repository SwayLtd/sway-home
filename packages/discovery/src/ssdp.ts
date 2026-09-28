/**
 * SSDP / UPnP discovery.
 *
 * Hand-written for the same reason as mDNS: it is an HTTP-shaped datagram sent to
 * 239.255.255.250:1900 and a text response parsed with a regular expression. The only part
 * with any depth is following the LOCATION header to the device description XML, which is
 * where the friendly name and the model actually live - and which is what lets the hub say
 * "Freebox Player" rather than "some host answering on port 1900".
 */

import dgram from 'node:dgram'

const SSDP_ADDRESS = '239.255.255.250'
const SSDP_PORT = 1900

/** Search targets worth asking for by name, beyond `ssdp:all`. */
export const SSDP_TARGETS = [
  'ssdp:all',
  'upnp:rootdevice',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:device:MediaServer:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:ZonePlayer:1', // Sonos
  'urn:dial-multiscreen-org:service:dial:1', // Chromecast, smart TVs
  'urn:schemas-sony-com:service:ScalarWebAPI:1',
  'urn:lge-com:service:webos-second-screen:1',
  'urn:samsung.com:device:RemoteControlReceiver:1',
  'urn:schemas-upnp-org:device:Basic:1',
  'urn:Belkin:device:**', // Wemo
  'roku:ecp',
] as const

export interface SsdpResponse {
  address: string
  st: string
  usn: string
  server: string | null
  location: string | null
  /** Filled by fetching the LOCATION XML, when it answers in time. */
  friendlyName: string | null
  modelName: string | null
  manufacturer: string | null
  deviceType: string | null
  udn: string | null
}

interface SearchOptions {
  durationMs?: number
  interfaceAddress?: string
  targets?: readonly string[]
  /** Fetch and parse each LOCATION. Costs a few HTTP round trips, worth it. */
  describe?: boolean
  signal?: AbortSignal
}

/**
 * Exported for the tests: this is the only part of SSDP that is pure, and it is also the
 * part that faces whatever a device chose to send. Header names are case-insensitive on the
 * wire, so they are lower-cased once here and read lower-cased everywhere else.
 */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index === -1) continue
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }
  return headers
}

/** Exported for the tests. Deliberately not an XML parser: five known tags, one regex. */
export function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i').exec(xml)
  return match?.[1]?.trim() ?? null
}

async function describe(response: SsdpResponse, timeoutMs = 2500): Promise<SsdpResponse> {
  if (!response.location) return response
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(response.location, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return response
    const xml = await res.text()
    return {
      ...response,
      friendlyName: tag(xml, 'friendlyName'),
      modelName: tag(xml, 'modelName'),
      manufacturer: tag(xml, 'manufacturer'),
      deviceType: tag(xml, 'deviceType'),
      udn: tag(xml, 'UDN'),
    }
  } catch {
    // A device that advertises a description it will not serve is common; keep the rest.
    return response
  }
}

export async function search(options: SearchOptions = {}): Promise<SsdpResponse[]> {
  const duration = options.durationMs ?? 4000
  const targets = options.targets ?? SSDP_TARGETS
  const found = new Map<string, SsdpResponse>()

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

  const raw = await new Promise<SsdpResponse[]>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      resolve([...found.values()])
    }

    const timer = setTimeout(done, duration)
    options.signal?.addEventListener('abort', done, { once: true })
    socket.on('error', done)

    socket.on('message', (message, remote) => {
      const text = message.toString('utf8')
      if (!/^HTTP\/1\.1 200|^NOTIFY/i.test(text)) return
      const headers = parseHeaders(text)
      const usn = headers.usn ?? `${remote.address}:${headers.st ?? ''}`
      const key = `${remote.address}|${headers.st ?? headers.nt ?? ''}`
      if (found.has(key)) return
      found.set(key, {
        address: remote.address,
        st: headers.st ?? headers.nt ?? '',
        usn,
        server: headers.server ?? null,
        location: headers.location ?? null,
        friendlyName: null,
        modelName: null,
        manufacturer: null,
        deviceType: null,
        udn: null,
      })
    })

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true)
        socket.setMulticastTTL(4)
        if (options.interfaceAddress) socket.setMulticastInterface(options.interfaceAddress)
      } catch {
        /* interface does not support it */
      }

      targets.forEach((target, index) => {
        setTimeout(() => {
          if (settled) return
          const payload = Buffer.from(
            [
              'M-SEARCH * HTTP/1.1',
              `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
              'MAN: "ssdp:discover"',
              'MX: 2',
              `ST: ${target}`,
              'USER-AGENT: Sway-Home/0.1 UPnP/1.1',
              '',
              '',
            ].join('\r\n')
          )
          try {
            socket.send(payload, SSDP_PORT, SSDP_ADDRESS)
          } catch {
            /* ignore */
          }
        }, index * 90)
      })
    })
  })

  if (!options.describe) return raw

  // Describing in parallel, with a cap so a subnet full of UPnP devices does not open
  // fifty sockets at once.
  const described: SsdpResponse[] = []
  const queue = [...raw]
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift()
      if (!next) break
      described.push(await describe(next))
    }
  })
  await Promise.all(workers)
  return described
}
