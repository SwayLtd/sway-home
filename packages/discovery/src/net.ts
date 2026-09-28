/**
 * Local network primitives: which interface are we on, what is in the ARP table, and a
 * sweep that makes silent devices answer.
 *
 * The sweep is TCP connect rather than ICMP on purpose. Raw ICMP sockets need administrator
 * rights on Windows, and a hub that demands elevation to find a light bulb is a hub nobody
 * runs. A TCP SYN to a closed port still forces the OS to ARP for the host, so the ARP
 * table fills up even for devices that answer nothing - which is how the silent ones get
 * found.
 */

import os from 'node:os'
import net from 'node:net'
import dgram from 'node:dgram'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface LocalInterface {
  name: string
  address: string
  netmask: string
  mac: string
  cidr: string
  /** Every host address in the subnet, gateway and broadcast excluded. */
  hostCount: number
}

export function listInterfaces(): LocalInterface[] {
  const out: LocalInterface[] = []
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      const prefix = maskToPrefix(address.netmask)
      out.push({
        name,
        address: address.address,
        netmask: address.netmask,
        mac: address.mac,
        cidr: `${networkAddress(address.address, address.netmask)}/${prefix}`,
        hostCount: prefix >= 31 ? 0 : 2 ** (32 - prefix) - 2,
      })
    }
  }
  return out
}

/** The interface carrying the default route, which is the one the house is on. */
export function primaryInterface(): LocalInterface | null {
  const interfaces = listInterfaces()
  if (interfaces.length === 0) return null
  // Prefer a /24-ish private subnet with a real MAC over VPN and virtual adapters.
  const scored = interfaces
    .map((iface) => {
      let score = 0
      if (isPrivate(iface.address)) score += 10
      if (iface.hostCount > 0 && iface.hostCount <= 1024) score += 5
      if (/^(wi-?fi|wlan|en|eth|ethernet)/i.test(iface.name)) score += 4
      if (/(vethernet|virtualbox|vmware|hyper-v|loopback|tailscale|zerotier|wsl|docker)/i.test(iface.name)) score -= 20
      if (iface.mac === '00:00:00:00:00:00') score -= 10
      return { iface, score }
    })
    .sort((a, b) => b.score - a.score)
  return scored[0]?.iface ?? null
}

export function isPrivate(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function maskToPrefix(netmask: string): number {
  return netmask
    .split('.')
    .map((octet) => (Number(octet) >>> 0).toString(2).replace(/0/g, '').length)
    .reduce((sum, bits) => sum + bits, 0)
}

export function networkAddress(ip: string, netmask: string): string {
  const ipParts = ip.split('.').map(Number)
  const maskParts = netmask.split('.').map(Number)
  return ipParts.map((part, index) => part & (maskParts[index] ?? 0)).join('.')
}

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0
}

export function intToIp(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

/** Every usable host address in a CIDR. Refuses anything bigger than a /16 by design. */
export function hostsInCidr(cidr: string, limit = 4096): string[] {
  const [base = '0.0.0.0', prefixText = '24'] = cidr.split('/')
  const prefix = Number(prefixText)
  if (prefix < 16) throw new Error(`Refusing to enumerate ${cidr}: too large to scan politely`)
  const size = 2 ** (32 - prefix)
  const start = ipToInt(base)
  const hosts: string[] = []
  for (let i = 1; i < size - 1 && hosts.length < limit; i += 1) hosts.push(intToIp(start + i))
  return hosts
}

// ---------------------------------------------------------------------------------------
// ARP
// ---------------------------------------------------------------------------------------

export interface ArpEntry {
  ip: string
  mac: string
  kind: 'dynamic' | 'static'
  interfaceAddress: string | null
}

/**
 * Read the OS ARP cache. Windows `arp -a`, Linux `ip neigh`, macOS `arp -an`. Parsing the
 * command output is ugly but it is the only way to get the table without raw sockets, and
 * the three formats are stable enough to be worth the twenty lines.
 */
export async function readArpTable(): Promise<ArpEntry[]> {
  const entries: ArpEntry[] = []
  try {
    if (process.platform === 'win32') {
      const { stdout } = await exec('arp', ['-a'], { windowsHide: true })
      let currentInterface: string | null = null
      for (const line of stdout.split(/\r?\n/)) {
        const header = /^Interface:\s+(\d+\.\d+\.\d+\.\d+)/i.exec(line)
        if (header?.[1]) {
          currentInterface = header[1]
          continue
        }
        const row = /^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s+(\w+)/i.exec(line)
        if (row?.[1] && row[2]) {
          entries.push({
            ip: row[1],
            mac: row[2].replace(/-/g, ':').toLowerCase(),
            kind: (row[3] ?? 'dynamic').toLowerCase() === 'static' ? 'static' : 'dynamic',
            interfaceAddress: currentInterface,
          })
        }
      }
    } else if (process.platform === 'linux') {
      const { stdout } = await exec('ip', ['neigh', 'show'])
      for (const line of stdout.split('\n')) {
        const row = /^(\d+\.\d+\.\d+\.\d+)\s+dev\s+\S+\s+lladdr\s+([0-9a-f:]{17})\s+(\w+)/i.exec(line)
        if (row?.[1] && row[2]) {
          entries.push({ ip: row[1], mac: row[2].toLowerCase(), kind: 'dynamic', interfaceAddress: null })
        }
      }
    } else {
      const { stdout } = await exec('arp', ['-an'])
      for (const line of stdout.split('\n')) {
        const row = /\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]{11,17})/i.exec(line)
        if (row?.[1] && row[2]) {
          entries.push({ ip: row[1], mac: padMac(row[2]), kind: 'dynamic', interfaceAddress: null })
        }
      }
    }
  } catch {
    // No arp binary, or it is not on PATH. The sweep still works; we just lose MACs.
  }

  return entries.filter((entry) => !isMulticastOrBroadcast(entry.ip, entry.mac))
}

function padMac(mac: string): string {
  return mac
    .split(':')
    .map((part) => part.padStart(2, '0'))
    .join(':')
    .toLowerCase()
}

function isMulticastOrBroadcast(ip: string, mac: string): boolean {
  const first = Number(ip.split('.')[0] ?? 0)
  return first >= 224 || ip.endsWith('.255') || mac === 'ff:ff:ff:ff:ff:ff' || mac.startsWith('01:00:5e')
}

// ---------------------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------------------

/**
 * Ports chosen for what they say about a device, not for coverage. Each one below is a
 * real fingerprint signal on a home network.
 */
export const PROBE_PORTS = [
  80, // almost every LAN device
  443,
  8080,
  8081,
  8443,
  81,
  22, // servers, NAS, Pi
  23, // telnet: old cameras and routers
  53, // router / Pi-hole
  445, // Windows share
  139,
  548, // AFP, Time Capsule
  631, // IPP printer
  9100, // raw print
  554, // RTSP camera
  2020, // ONVIF on Tapo cameras
  8000, // ONVIF on Reolink and Hikvision
  8899, // ONVIF on generic cameras
  502, // Modbus TCP: solar inverters, meters, heat pumps
  1883, // MQTT broker
  8883,
  5683, // CoAP
  5540, // Matter operational
  8123, // Home Assistant
  1400, // Sonos
  8008, // Chromecast
  8009,
  8060, // Roku ECP
  7000, // AirPlay
  32400, // Plex
  9999, // TP-Link Kasa
  6668, // Tuya
  56700, // LIFX
  4000, // Nanoleaf / misc
  49152, // UPnP ephemeral, Hue and many cameras
  5000,
  5001,
  3000, // LG webOS (clear)
  3001, // LG webOS (TLS)
  8001, // Samsung Tizen remote
  8002, // Samsung Tizen remote (TLS)
  1900,
  2000,
  8888,
] as const

export interface SweepResult {
  ip: string
  openPorts: number[]
  rttMs: number | null
}

interface SweepOptions {
  concurrency?: number
  connectTimeoutMs?: number
  ports?: readonly number[]
  signal?: AbortSignal
  onProgress?: (done: number, total: number, found: number) => void
}

function probePort(ip: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const started = performance.now()
    const socket = new net.Socket()
    let finished = false
    const finish = (open: boolean) => {
      if (finished) return
      finished = true
      socket.destroy()
      resolve(open ? Math.round(performance.now() - started) : null)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    try {
      socket.connect(port, ip)
    } catch {
      finish(false)
    }
  })
}

/**
 * Sweep a list of addresses. Ports are probed in a first fast pass with a short timeout
 * (most devices answer in under 50 ms on a LAN), and hosts that answered get a second,
 * wider pass - so the scan spends its time on hosts that exist.
 */
export async function sweep(ips: string[], options: SweepOptions = {}): Promise<SweepResult[]> {
  const concurrency = options.concurrency ?? 128
  const timeout = options.connectTimeoutMs ?? 400
  const fastPorts = options.ports ?? [80, 443, 22, 8080, 554, 1400, 8009, 8060, 9999, 445]
  const results = new Map<string, SweepResult>()

  let done = 0
  const queue = [...ips]

  const worker = async () => {
    while (queue.length > 0) {
      if (options.signal?.aborted) return
      const ip = queue.shift()
      if (!ip) return
      const open: number[] = []
      let rtt: number | null = null
      const probes = await Promise.all(fastPorts.map((port) => probePort(ip, port, timeout)))
      probes.forEach((ms, index) => {
        if (ms !== null) {
          const port = fastPorts[index]
          if (port !== undefined) open.push(port)
          rtt = rtt === null ? ms : Math.min(rtt, ms)
        }
      })
      if (open.length > 0) results.set(ip, { ip, openPorts: open, rttMs: rtt })
      done += 1
      if (done % 16 === 0) options.onProgress?.(done, ips.length, results.size)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, ips.length)) }, worker))
  options.onProgress?.(ips.length, ips.length, results.size)
  return [...results.values()]
}

/** Widen the port list for hosts we already know are alive. */
export async function deepScan(ips: string[], options: SweepOptions = {}): Promise<Map<string, number[]>> {
  const timeout = options.connectTimeoutMs ?? 600
  const out = new Map<string, number[]>()
  const queue = [...ips]

  const worker = async () => {
    while (queue.length > 0) {
      if (options.signal?.aborted) return
      const ip = queue.shift()
      if (!ip) return
      const open: number[] = []
      const probes = await Promise.all(PROBE_PORTS.map((port) => probePort(ip, port, timeout)))
      probes.forEach((ms, index) => {
        const port = PROBE_PORTS[index]
        if (ms !== null && port !== undefined) open.push(port)
      })
      out.set(ip, open)
    }
  }

  await Promise.all(Array.from({ length: Math.min(16, Math.max(1, ips.length)) }, worker))
  return out
}

// ---------------------------------------------------------------------------------------
// NetBIOS name query (UDP 137)
// ---------------------------------------------------------------------------------------

/**
 * Windows machines, NAS boxes and a surprising number of cameras answer a NetBIOS node
 * status request with their name. It is one 50-byte datagram and it names hosts that mDNS
 * knows nothing about.
 */
export async function netbiosName(ip: string, timeoutMs = 700): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)

    // Transaction id, flags, 1 question, encoded name "*" padded to 16 bytes, NBSTAT/IN.
    const query = Buffer.from([
      0x82, 0x28, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x43, 0x4b, 0x41, 0x41, 0x41, 0x41,
      0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41,
      0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0x00, 0x00, 0x21, 0x00, 0x01,
    ])

    socket.on('error', () => finish(null))
    socket.on('message', (message) => {
      try {
        // Answer starts at 56; first byte is the number of names, then 18 bytes per name.
        const count = message.readUInt8(56)
        if (count === 0) return finish(null)
        const name = message.subarray(57, 57 + 15).toString('ascii').trim()
        finish(name.replace(/[^\x20-\x7e]/g, '') || null)
      } catch {
        finish(null)
      }
    })

    try {
      socket.send(query, 137, ip)
    } catch {
      finish(null)
    }
  })
}
