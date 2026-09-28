/**
 * MAC vendor lookup.
 *
 * The table is embedded rather than queried online, which is a privacy decision: sending
 * the MAC addresses of everything in a home to an API is the exact thing this product
 * exists to avoid. These tests check the table is actually usable offline and that a
 * randomised address is never attributed to a vendor.
 */

import { describe, expect, test } from 'bun:test'
import { isLocallyAdministered, lookupVendor, ouiStats, primeOui } from '../src/oui.ts'

describe('lookupVendor', () => {
  test('resolves vendors of devices a smart home actually has', () => {
    expect(lookupVendor('00:17:88:11:22:33')).toContain('Signify')
    expect(lookupVendor('b4:e6:2d:00:11:22')).toContain('Espressif')
  })

  test('accepts any separator and any case', () => {
    const expected = lookupVendor('00:17:88:11:22:33')
    expect(lookupVendor('00-17-88-11-22-33')).toBe(expected)
    expect(lookupVendor('001788112233')).toBe(expected)
    expect(lookupVendor('00:17:88:AA:BB:CC')).toBe(expected)
  })

  test('only needs the first three octets', () => {
    expect(lookupVendor('001788')).toBe(lookupVendor('00:17:88:11:22:33'))
  })

  test('a randomised address is never attributed to a vendor', () => {
    // Phones rotate these constantly. Guessing a vendor from one produces a device list full
    // of phantom Apple devices that disappear an hour later.
    expect(lookupVendor('02:17:88:11:22:33')).toBeNull()
    expect(lookupVendor('de:ad:be:ef:00:01')).toBeNull()
  })

  test('an unknown OUI returns null rather than a guess', () => {
    expect(lookupVendor('01:23:45:67:89:ab')).toBeNull()
  })

  test('null, empty and truncated input are handled', () => {
    expect(lookupVendor(null)).toBeNull()
    expect(lookupVendor(undefined)).toBeNull()
    expect(lookupVendor('')).toBeNull()
    expect(lookupVendor('00:17')).toBeNull()
  })
})

describe('isLocallyAdministered', () => {
  test('reads the second-least-significant bit of the first octet', () => {
    expect(isLocallyAdministered('02:00:00:00:00:00')).toBe(true)
    expect(isLocallyAdministered('06:00:00:00:00:00')).toBe(true)
    expect(isLocallyAdministered('00:00:00:00:00:00')).toBe(false)
    expect(isLocallyAdministered('04:00:00:00:00:00')).toBe(false)
  })
})

describe('the table', () => {
  test('ships enough curated entries to be useful with no registry file', () => {
    const stats = ouiStats()
    expect(stats.curated).toBeGreaterThan(100)
  })

  test('priming without a registry path does not fail and does not fetch anything', async () => {
    // No network in this test, by design: if primeOui ever tried to download the IEEE list
    // this would hang or throw rather than quietly making the hub phone home.
    const result = await primeOui()
    expect(result.curated).toBeGreaterThan(100)
    expect(result.registry).toBe(0)
  })

  test('a missing registry file is tolerated', async () => {
    const result = await primeOui({ registryPath: 'data/definitely-not-here.csv' })
    expect(result.curated).toBeGreaterThan(100)
  })
})
