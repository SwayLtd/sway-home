/**
 * Wake-on-LAN: how a TV that is fully off gets turned on.
 *
 * A webOS or Tizen TV in standby closes its control socket; the only thing it still listens
 * to is a "magic packet" on its network card: six 0xFF bytes, then its MAC address sixteen
 * times, over UDP. The packet goes to the subnet's broadcast address because the TV has no
 * IP route to answer on while asleep.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createSocket, type Socket } from 'node:dgram'
import { broadcastAddress, magicPacket, sendWakeOnLan } from '#adapters/wake_on_lan'

describe('the magic packet', () => {
  test('six 0xFF, then the MAC sixteen times: 102 bytes', () => {
    const packet = magicPacket('a8:23:fe:01:02:03')
    expect(packet.length).toBe(102)
    expect([...packet.subarray(0, 6)]).toEqual([255, 255, 255, 255, 255, 255])
    for (let repeat = 0; repeat < 16; repeat += 1) {
      expect([...packet.subarray(6 + repeat * 6, 12 + repeat * 6)]).toEqual([0xa8, 0x23, 0xfe, 0x01, 0x02, 0x03])
    }
  })

  test('any common way of writing a MAC', () => {
    const reference = magicPacket('a8:23:fe:01:02:03')
    for (const written of ['A8-23-FE-01-02-03', 'a823.fe01.0203', 'a823fe010203']) {
      expect(magicPacket(written)).toEqual(reference)
    }
  })

  test('something that is not a MAC is refused', () => {
    expect(() => magicPacket('not a mac')).toThrow()
    expect(() => magicPacket('a8:23:fe:01:02')).toThrow()
  })
})

describe('where it goes', () => {
  test("the subnet's broadcast address", () => {
    expect(broadcastAddress('192.168.1.0/24')).toBe('192.168.1.255')
    expect(broadcastAddress('10.0.0.0/16')).toBe('10.0.255.255')
    expect(broadcastAddress('172.16.4.0/22')).toBe('172.16.7.255')
  })

  test('nothing sensible for a malformed CIDR', () => {
    expect(broadcastAddress('localhost')).toBeNull()
    expect(broadcastAddress('192.168.1.0/40')).toBeNull()
  })
})

describe('on the wire', () => {
  let listener: Socket | null = null

  afterEach(() => {
    listener?.close()
    listener = null
  })

  test('reaches a UDP listener, once per target', async () => {
    const received: Buffer[] = []
    listener = createSocket('udp4')
    listener.on('message', (message) => received.push(message))
    const port = await new Promise<number>((resolve) => listener!.bind(0, '127.0.0.1', () => resolve(listener!.address().port)))

    await sendWakeOnLan('a8:23:fe:01:02:03', ['127.0.0.1', '127.0.0.1'], port)
    for (let waited = 0; received.length < 2 && waited < 40; waited += 1) await new Promise((resolve) => setTimeout(resolve, 25))

    expect(received).toHaveLength(2)
    expect([...received[0]!]).toEqual([...magicPacket('a8:23:fe:01:02:03')])
  })
})
