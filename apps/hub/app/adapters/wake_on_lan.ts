/**
 * Wake-on-LAN, for the TVs that sleep with their control socket closed.
 *
 * A webOS or Tizen TV in standby stops answering on its API ports; the only thing its
 * network card still listens for is the "magic packet": six 0xFF bytes, then the card's MAC
 * address sixteen times, sent over UDP (port 9 by convention). It goes to the subnet's
 * broadcast address, and to the TV's last known IP for routers that drop broadcasts.
 *
 * On LG TVs the option is "Mobile TV On > Turn on via Wi-Fi" (2017 onwards) or
 * "Support > IP control > Wake on LAN" (2025 models); on Samsung, "Power On with Mobile".
 */

import { createSocket } from 'node:dgram'

export const WOL_PORT = 9

export function magicPacket(mac: string): Uint8Array {
  const hex = mac.replace(/[^0-9a-f]/gi, '')
  if (hex.length !== 12 || /[^0-9a-f]/i.test(mac.replace(/[:.\-\s]/g, ''))) throw new Error(`Not a MAC address: ${mac}`)
  const address = Uint8Array.from({ length: 6 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16))
  const packet = new Uint8Array(6 + 16 * 6).fill(0xff, 0, 6)
  for (let repeat = 0; repeat < 16; repeat += 1) packet.set(address, 6 + repeat * 6)
  return packet
}

/** "192.168.1.0/24" -> "192.168.1.255". */
export function broadcastAddress(cidr: string): string | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim())
  if (!match) return null
  const prefix = Number(match[5])
  const octets = match.slice(1, 5).map(Number)
  if (prefix > 32 || octets.some((octet) => octet > 255)) return null
  const address = octets.reduce((value, octet) => (value << 8) + octet, 0) >>> 0
  const host = prefix === 32 ? 0 : 0xffffffff >>> prefix
  const broadcast = (address | host) >>> 0
  return [24, 16, 8, 0].map((shift) => (broadcast >>> shift) & 255).join('.')
}

/** Send the packet to each target. Resolves once every datagram has left. */
export async function sendWakeOnLan(mac: string, targets: string[], port = WOL_PORT): Promise<void> {
  const packet = magicPacket(mac)
  const socket = createSocket('udp4')
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(0, () => {
        socket.setBroadcast(true)
        resolve()
      })
    })
    for (const target of targets) {
      await new Promise<void>((resolve, reject) => socket.send(packet, port, target, (error) => (error ? reject(error) : resolve())))
    }
  } finally {
    socket.close()
  }
}
