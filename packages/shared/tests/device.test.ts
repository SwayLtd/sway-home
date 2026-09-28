/**
 * Device identity.
 *
 * The MAC helpers decide whether two sightings of a host are the same device. Getting
 * `isRandomisedMac` wrong means either a phone appearing as a new device every hour, or a
 * real sensor being merged into the wrong row - both of which are visible to the user as
 * "my device list is nonsense".
 */

import { describe, expect, test } from 'bun:test'
import {
  DEVICE_CATEGORIES,
  IDENTIFICATION_CONFIDENCE,
  TRANSPORTS,
  deviceSchema,
  isRandomisedMac,
  normaliseMac,
} from '../src/device.ts'

describe('normaliseMac', () => {
  test('lower-cases and colon-separates whatever format arrived', () => {
    expect(normaliseMac('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff')
    expect(normaliseMac('aabbccddeeff')).toBe('aa:bb:cc:dd:ee:ff')
    expect(normaliseMac('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff')
    expect(normaliseMac('aa.bb.cc.dd.ee.ff')).toBe('aa:bb:cc:dd:ee:ff')
  })

  test('leaves something that is not a MAC alone rather than mangling it', () => {
    // ARP tables on Windows sometimes print "(incomplete)" or a partial entry; turning that
    // into a plausible-looking MAC would merge unrelated hosts.
    expect(normaliseMac('incomplete')).toBe('incomplete')
    expect(normaliseMac('aa:bb:cc')).toBe('aa:bb:cc')
  })

  test('is idempotent', () => {
    const once = normaliseMac('AA-BB-CC-DD-EE-FF')
    expect(normaliseMac(once)).toBe(once)
  })
})

describe('isRandomisedMac', () => {
  test('detects the locally administered bit that phones set', () => {
    // The second-least-significant bit of the first octet. 0x02, 0x06, 0x0a, 0x0e ... are
    // randomised; 0x00, 0x04, 0x08 are not.
    expect(isRandomisedMac('02:11:22:33:44:55')).toBe(true)
    expect(isRandomisedMac('06:11:22:33:44:55')).toBe(true)
    expect(isRandomisedMac('0a:11:22:33:44:55')).toBe(true)
    expect(isRandomisedMac('de:ad:be:ef:00:01')).toBe(true)
  })

  test('a real vendor OUI is not flagged', () => {
    expect(isRandomisedMac('00:17:88:11:22:33')).toBe(false) // Philips Hue
    expect(isRandomisedMac('b4:e6:2d:aa:bb:cc')).toBe(false) // Espressif
    expect(isRandomisedMac('ac:84:c6:00:11:22')).toBe(false) // TP-Link
  })

  test('works whatever the separator', () => {
    expect(isRandomisedMac('02-11-22-33-44-55')).toBe(true)
    expect(isRandomisedMac('021122334455')).toBe(true)
  })

  test('garbage is not reported as randomised', () => {
    expect(isRandomisedMac('')).toBe(false)
    expect(isRandomisedMac('zz:zz:zz:zz:zz:zz')).toBe(false)
  })
})

describe('the vocabularies', () => {
  test('categories cover what a home actually contains', () => {
    for (const category of ['light', 'switch', 'sensor', 'climate', 'lock', 'camera', 'media', 'speaker', 'cover', 'gateway']) {
      expect(DEVICE_CATEGORIES).toContain(category as never)
    }
  })

  test('transports cover every adapter we ship or declare', () => {
    for (const transport of ['wifi', 'ethernet', 'matter', 'thread', 'zigbee', 'zwave', 'ble', 'mqtt', 'virtual']) {
      expect(TRANSPORTS).toContain(transport as never)
    }
  })

  test('identification confidence is an ordered scale', () => {
    expect(IDENTIFICATION_CONFIDENCE.length).toBeGreaterThanOrEqual(3)
    expect(new Set(IDENTIFICATION_CONFIDENCE).size).toBe(IDENTIFICATION_CONFIDENCE.length)
  })
})

describe('deviceSchema', () => {
  const base = {
    id: 'd1',
    uid: 'virtual:lamp',
    name: 'Plafonnier',
    category: 'light' as const,
    adapterId: 'virtual',
    nativeId: 'lamp',
    transport: 'virtual' as const,
    capabilities: ['onoff' as const],
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
  }

  test('transport is required, because an adapter always knows how it reached the device', () => {
    const { transport, ...withoutTransport } = base
    void transport
    expect(() => deviceSchema.parse(withoutTransport)).toThrow()
  })

  test('capabilities are required: a device with none is a row nothing can render', () => {
    const { capabilities, ...withoutCapabilities } = base
    void capabilities
    expect(() => deviceSchema.parse(withoutCapabilities)).toThrow()
  })

  test('a minimal device fills in sane defaults', () => {
    const device = deviceSchema.parse(base)
    expect(device.state).toEqual({})
    // Offline until an adapter says otherwise: a row created from a discovery hint has not
    // answered anything yet, and showing it as online would be a lie the UI cannot detect.
    expect(device.online).toBe(false)
    expect(device.areaId).toBeNull()
    expect(device.favourite).toBe(false)
  })

  test('an unknown capability is rejected, so a typo cannot create a dead control', () => {
    expect(() => deviceSchema.parse({ ...base, capabilities: ['onoff', 'levitation'] })).toThrow()
  })

  test('an unknown category is rejected', () => {
    expect(() => deviceSchema.parse({ ...base, category: 'toaster-oven-thing' })).toThrow()
  })

  test('state is free-form, because adapters report what their hardware reports', () => {
    const device = deviceSchema.parse({ ...base, state: { on: true, vendorSpecificThing: 42 } })
    expect(device.state.vendorSpecificThing).toBe(42)
  })
})
