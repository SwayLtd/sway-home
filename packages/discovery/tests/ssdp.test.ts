/**
 * SSDP header and description parsing.
 *
 * Real M-SEARCH replies are inconsistent: header case varies by vendor, line endings vary,
 * and half the devices serve a description XML with attributes on the tags. These are the
 * exact shapes captured from devices on a home network.
 */

import { describe, expect, test } from 'bun:test'
import { SSDP_TARGETS, parseHeaders, tag } from '../src/ssdp.ts'

describe('parseHeaders', () => {
  test('parses a real M-SEARCH reply', () => {
    const reply = [
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age=1800',
      'EXT:',
      'LOCATION: http://192.168.1.14:52323/dmr.xml',
      'SERVER: Linux/4.19 UPnP/1.0 Sony-BDP/1.0',
      'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
      'USN: uuid:00000000-0000-1010-8000-b4527e4e5a18::urn:schemas-upnp-org:device:MediaRenderer:1',
      '',
      '',
    ].join('\r\n')

    const headers = parseHeaders(reply)
    expect(headers.location).toBe('http://192.168.1.14:52323/dmr.xml')
    expect(headers.st).toBe('urn:schemas-upnp-org:device:MediaRenderer:1')
    expect(headers.server).toContain('Sony-BDP')
    expect(headers.usn).toContain('uuid:')
  })

  test('header names are case-insensitive, because vendors disagree', () => {
    const headers = parseHeaders('Location: http://a\r\nlOcAtIoN2: b\r\nSERVER: c')
    expect(headers.location).toBe('http://a')
    expect(headers.location2).toBe('b')
    expect(headers.server).toBe('c')
  })

  test('accepts bare newlines as well as CRLF', () => {
    expect(parseHeaders('ST: ssdp:all\nUSN: uuid:1').st).toBe('ssdp:all')
  })

  test('a header whose value contains a colon keeps all of it', () => {
    const headers = parseHeaders('LOCATION: http://192.168.1.14:52323/dmr.xml')
    expect(headers.location).toBe('http://192.168.1.14:52323/dmr.xml')
  })

  test('an empty value is kept as an empty string, not dropped', () => {
    expect(parseHeaders('EXT:').ext).toBe('')
  })

  test('lines without a colon are skipped rather than corrupting the map', () => {
    const headers = parseHeaders('HTTP/1.1 200 OK\r\nST: ssdp:all')
    expect(headers.st).toBe('ssdp:all')
    expect(Object.keys(headers)).toHaveLength(1)
  })

  test('garbage produces an empty object rather than throwing', () => {
    expect(parseHeaders('')).toEqual({})
    expect(parseHeaders('\u0000\u0001\u0002')).toEqual({})
  })
})

describe('tag', () => {
  const xml = `<?xml version="1.0"?>
    <root xmlns="urn:schemas-upnp-org:device-1-0">
      <device>
        <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
        <friendlyName>BRAVIA 4K GB</friendlyName>
        <manufacturer>Sony Corporation</manufacturer>
        <modelName>KD-55XG8096</modelName>
        <UDN>uuid:00000000-0000-1010-8000-b4527e4e5a18</UDN>
      </device>
    </root>`

  test('reads the fields the fingerprinter uses', () => {
    expect(tag(xml, 'friendlyName')).toBe('BRAVIA 4K GB')
    expect(tag(xml, 'manufacturer')).toBe('Sony Corporation')
    expect(tag(xml, 'modelName')).toBe('KD-55XG8096')
    expect(tag(xml, 'UDN')).toContain('uuid:')
  })

  test('is case-insensitive about the tag name', () => {
    expect(tag(xml, 'friendlyname')).toBe('BRAVIA 4K GB')
    expect(tag(xml, 'udn')).toContain('uuid:')
  })

  test('tolerates attributes on the tag', () => {
    expect(tag('<friendlyName xml:lang="fr">Salon</friendlyName>', 'friendlyName')).toBe('Salon')
  })

  test('trims surrounding whitespace, which devices leave in constantly', () => {
    expect(tag('<modelName>\n   Shelly Plus 1PM \n  </modelName>', 'modelName')).toBe('Shelly Plus 1PM')
  })

  test('returns null for a tag that is not there', () => {
    expect(tag(xml, 'serialNumber')).toBeNull()
  })

  test('returns null rather than a partial match on a truncated document', () => {
    expect(tag('<friendlyName>Salon', 'friendlyName')).toBeNull()
  })

  test('a tag name that is a regex metacharacter cannot break the matcher', () => {
    expect(() => tag(xml, 'friendly.Name')).not.toThrow()
  })
})

describe('the target list', () => {
  test('includes ssdp:all and the device types a home actually has', () => {
    expect(SSDP_TARGETS).toContain('ssdp:all')
    expect(SSDP_TARGETS.length).toBeGreaterThan(3)
    expect(new Set(SSDP_TARGETS).size).toBe(SSDP_TARGETS.length)
  })
})
