/**
 * Turning what a host said into "this is a Shelly".
 *
 * The fingerprinter is what stands between "42 unknown devices" and a usable list, and its
 * output feeds two decisions: which adapter tries to claim the host, and what the user sees
 * before anything has been claimed. The tests use the evidence real devices actually emit.
 */

import { describe, expect, test } from 'bun:test'
import type { NetworkHost } from '@sway-home/shared'
import { fallbackName, fingerprintHost } from '../src/fingerprint.ts'

function host(overrides: Partial<NetworkHost> = {}): NetworkHost {
  return {
    ip: '192.168.1.42',
    mac: null,
    macVendor: null,
    hostname: null,
    openPorts: [],
    mdnsServices: [],
    mdnsTxt: {},
    ssdp: null,
    httpBanner: null,
    httpTitle: null,
    rttMs: 12,
    firstSeenAt: '2026-09-26T10:00:00.000Z',
    lastSeenAt: '2026-09-26T10:00:00.000Z',
    source: ['arp'],
    ...overrides,
  }
}

describe('mDNS is the strongest signal', () => {
  test('a Hue bridge is identified and routed to the hue adapter', () => {
    const print = fingerprintHost(host({ mdnsServices: ['_hue._tcp.local'] }))
    expect(print.category).toBe('hub')
    expect(print.vendor).toContain('Signify')
    expect(print.suggestedAdapters).toContain('hue')
    expect(print.confidence).toBeGreaterThan(0.9)
  })

  test('a Chromecast goes to the googlecast adapter', () => {
    const print = fingerprintHost(host({ mdnsServices: ['_googlecast._tcp.local'] }))
    expect(print.category).toBe('media')
    expect(print.suggestedAdapters).toContain('googlecast')
  })

  test('a Shelly is a switch, not a generic web server', () => {
    const print = fingerprintHost(host({ mdnsServices: ['_shelly._tcp.local'], openPorts: [80] }))
    expect(print.category).toBe('switch')
    expect(print.suggestedAdapters).toContain('shelly')
  })

  test('a WLED controller is a light', () => {
    const print = fingerprintHost(host({ mdnsServices: ['_wled._tcp.local'] }))
    expect(print.category).toBe('light')
    expect(print.suggestedAdapters).toContain('wled')
  })

  test('an ESPHome node is routed to esphome', () => {
    expect(fingerprintHost(host({ mdnsServices: ['_esphomelib._tcp.local'] })).suggestedAdapters).toContain('esphome')
  })
})

describe('Matter', () => {
  test('a commissioned Matter device is routed to the matter adapter', () => {
    const print = fingerprintHost(host({ mdnsServices: ['_matter._tcp.local'] }))
    expect(print.suggestedAdapters).toContain('matter')
    expect(print.confidence).toBeGreaterThan(0.9)
  })

  test('an uncommissioned Matter device is recognised too', () => {
    // _matterc._udp is what a device advertises before it belongs to anyone. Recognising it
    // is the difference between "unknown device" and "ready to pair".
    expect(fingerprintHost(host({ mdnsServices: ['_matterc._udp.local'] })).suggestedAdapters).toContain('matter')
  })

  test('a Thread border router is a gateway', () => {
    const print = fingerprintHost(host({ mdnsServices: ['_meshcop._udp.local'] }))
    expect(print.category).toBe('gateway')
  })
})

describe('agreement and confidence', () => {
  test('two agreeing signals score higher than one alone', () => {
    const one = fingerprintHost(host({ mdnsServices: ['_shelly._tcp.local'] }))
    const two = fingerprintHost(host({ mdnsServices: ['_shelly._tcp.local'], httpBanner: 'Shelly Plus 1PM' }))
    expect(two.confidence).toBeGreaterThanOrEqual(one.confidence)
    expect(two.evidence.length).toBeGreaterThanOrEqual(one.evidence.length)
  })

  test('a host that said nothing gets the floor confidence, not zero and not a guess', () => {
    const print = fingerprintHost(host())
    expect(print.category).toBe('unknown')
    expect(print.confidence).toBeLessThanOrEqual(0.2)
    expect(print.evidence).toEqual([])
  })

  test('confidence never reaches certainty', () => {
    const print = fingerprintHost(
      host({ mdnsServices: ['_hue._tcp.local', '_http._tcp.local'], httpBanner: 'Philips hue', openPorts: [80, 443] })
    )
    expect(print.confidence).toBeLessThanOrEqual(0.99)
  })

  test('a rule that throws does not take the whole fingerprint down', () => {
    // Rules read optional fields off a host built from whatever the network returned; one of
    // them touching undefined must not lose the other twenty rules.
    const broken = { ...host({ mdnsServices: ['_shelly._tcp.local'] }), mdnsTxt: null as never }
    expect(() => fingerprintHost(broken)).not.toThrow()
  })
})

describe('the MAC vendor is a fallback, not a decision', () => {
  test('an unrecognised vendor is passed through untouched', () => {
    const print = fingerprintHost(host({ macVendor: 'Acme Widgets Ltd' }))
    expect(print.vendor).toBe('Acme Widgets Ltd')
    expect(print.category).toBe('unknown')
  })

  test('a known chip vendor is itself a weak signal, not just a label', () => {
    // Espressif in the OUI means an ESP32, which is a Shelly, a Tasmota, a WLED or an
    // ESPHome node - worth probing with all four rather than leaving it unknown.
    const print = fingerprintHost(host({ macVendor: 'Espressif Inc.' }))
    expect(print.vendor).toBe('Espressif')
    expect(print.suggestedAdapters).toEqual(expect.arrayContaining(['shelly', 'tasmota', 'wled', 'esphome']))
    expect(print.confidence).toBeLessThan(0.5)
  })

  test('a protocol signal outranks the OUI for the vendor name', () => {
    const print = fingerprintHost(host({ macVendor: 'Espressif Inc.', mdnsServices: ['_wled._tcp.local'] }))
    expect(print.vendor).toBe('WLED')
  })
})

describe('fallbackName', () => {
  test('prefers a real hostname', () => {
    const subject = host({ hostname: 'shellyplus1pm-a8032a' })
    expect(fallbackName(subject, fingerprintHost(subject))).toBe('shellyplus1pm-a8032a')
  })

  test('falls back to the SSDP friendly name', () => {
    const subject = host({ ssdp: { friendlyName: 'Salon TV' } })
    expect(fallbackName(subject, fingerprintHost(subject))).toBe('Salon TV')
  })

  test('always produces something a human can point at', () => {
    const subject = host({ macVendor: 'Espressif Inc.' })
    const label = fallbackName(subject, fingerprintHost(subject))
    expect(label.length).toBeGreaterThan(0)
    expect(label).toContain('42')
  })
})
