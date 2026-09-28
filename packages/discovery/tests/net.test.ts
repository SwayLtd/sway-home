/**
 * Address arithmetic.
 *
 * These four functions decide which addresses get probed. A wrong mask means either missing
 * half the house or scanning someone else's subnet, so the boundaries are pinned exactly:
 * the network address, the broadcast address, and the refusal to enumerate a /8.
 */

import { describe, expect, test } from 'bun:test'
import { hostsInCidr, intToIp, ipToInt, isPrivate, maskToPrefix, networkAddress } from '../src/net.ts'

describe('isPrivate', () => {
  test('recognises the three RFC 1918 ranges', () => {
    expect(isPrivate('10.0.0.1')).toBe(true)
    expect(isPrivate('10.255.255.254')).toBe(true)
    expect(isPrivate('172.16.0.1')).toBe(true)
    expect(isPrivate('172.31.255.254')).toBe(true)
    expect(isPrivate('192.168.1.1')).toBe(true)
  })

  test('rejects public addresses and the near misses around 172', () => {
    expect(isPrivate('8.8.8.8')).toBe(false)
    expect(isPrivate('172.15.0.1')).toBe(false)
    expect(isPrivate('172.32.0.1')).toBe(false)
    expect(isPrivate('192.169.1.1')).toBe(false)
    expect(isPrivate('193.168.1.1')).toBe(false)
  })
})

describe('maskToPrefix', () => {
  test('converts the masks a home router actually hands out', () => {
    expect(maskToPrefix('255.255.255.0')).toBe(24)
    expect(maskToPrefix('255.255.0.0')).toBe(16)
    expect(maskToPrefix('255.255.255.128')).toBe(25)
    expect(maskToPrefix('255.255.254.0')).toBe(23)
    expect(maskToPrefix('255.255.255.255')).toBe(32)
    expect(maskToPrefix('0.0.0.0')).toBe(0)
  })
})

describe('networkAddress', () => {
  test('masks the host bits off', () => {
    expect(networkAddress('192.168.1.42', '255.255.255.0')).toBe('192.168.1.0')
    expect(networkAddress('10.3.7.9', '255.255.0.0')).toBe('10.3.0.0')
    expect(networkAddress('192.168.1.200', '255.255.255.128')).toBe('192.168.1.128')
  })
})

describe('ipToInt and intToIp', () => {
  test('known values', () => {
    expect(ipToInt('0.0.0.0')).toBe(0)
    expect(ipToInt('255.255.255.255')).toBe(4294967295)
    expect(ipToInt('192.168.1.1')).toBe(3232235777)
    expect(intToIp(3232235777)).toBe('192.168.1.1')
  })

  test('the high bit does not go negative', () => {
    // A signed shift here turns 192.x into a negative number and the sweep then probes
    // nothing at all.
    expect(ipToInt('192.168.1.1')).toBeGreaterThan(0)
    expect(ipToInt('255.0.0.0')).toBeGreaterThan(0)
  })

  test('round trips across the whole space', () => {
    for (const ip of ['0.0.0.1', '10.0.0.1', '127.0.0.1', '172.16.31.255', '192.168.1.254', '223.255.255.254']) {
      expect(intToIp(ipToInt(ip))).toBe(ip)
    }
  })
})

describe('hostsInCidr', () => {
  test('a /24 yields 254 usable hosts, without the network or broadcast address', () => {
    const hosts = hostsInCidr('192.168.1.0/24')
    expect(hosts).toHaveLength(254)
    expect(hosts[0]).toBe('192.168.1.1')
    expect(hosts.at(-1)).toBe('192.168.1.254')
    expect(hosts).not.toContain('192.168.1.0')
    expect(hosts).not.toContain('192.168.1.255')
  })

  test('a /30 yields the two usable addresses', () => {
    expect(hostsInCidr('10.0.0.0/30')).toEqual(['10.0.0.1', '10.0.0.2'])
  })

  test('the limit caps the list even on a large subnet', () => {
    expect(hostsInCidr('10.0.0.0/16', 100)).toHaveLength(100)
  })

  test('refuses anything larger than a /16, rather than scanning the internet politely', () => {
    expect(() => hostsInCidr('10.0.0.0/8')).toThrow()
    expect(() => hostsInCidr('0.0.0.0/0')).toThrow()
  })

  test('a /16 is allowed but bounded by the default limit', () => {
    expect(hostsInCidr('10.0.0.0/16').length).toBeLessThanOrEqual(4096)
  })
})
