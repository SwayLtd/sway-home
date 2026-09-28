/**
 * The Freebox OS API, the parts that need no box.
 *
 * The box describes itself at /api_version (its HTTPS domain and port, its API version); an
 * app asks for a token once, validated by a human on the box's screen, then opens sessions
 * with HMAC-SHA1(app_token, challenge). Every answer is `{ success, result }` or
 * `{ success: false, error_code, msg }`. The hosts list says which devices are on the network,
 * which is how the house knows whose phone is home.
 *
 * Sources: Freebox OS SDK (dev.freebox.fr/sdk/os: login, lan, connection, system); the
 * freebox-api package and Home Assistant's freebox integration (their fixtures are the real
 * answers below, trimmed).
 */

import { describe, expect, test } from 'bun:test'
import {
  apiBase,
  authorizationStatus,
  isPersonal,
  parseApiVersion,
  parseConnection,
  parseHosts,
  parseSystem,
  presenceOf,
  sessionPassword,
  unwrap,
} from '#adapters/freebox_codec'
import { FREEBOX_CA } from '#adapters/freebox_ca'

const API_VERSION = {
  box_model_name: 'Freebox v7 (r1)',
  api_base_url: '/api/',
  https_port: 35023,
  device_name: 'Freebox Server',
  https_available: true,
  box_model: 'fbxgw7-r1/full',
  api_domain: 'r42bhm9p.fbxos.fr',
  uid: '23b86ec8091013d668829fe12791fdab',
  api_version: '10.0',
  device_type: 'FreeboxServer7,1',
}

describe('finding the box', () => {
  test('what /api_version says, and where the API lives', () => {
    const info = parseApiVersion(API_VERSION)
    expect(info).toEqual({
      uid: '23b86ec8091013d668829fe12791fdab',
      apiDomain: 'r42bhm9p.fbxos.fr',
      httpsPort: 35023,
      httpsAvailable: true,
      apiBaseUrl: '/api/',
      apiMajor: 10,
      model: 'fbxgw7-r1/full',
      name: 'Freebox v7 (r1)',
    })
    expect(apiBase(info!)).toBe('https://r42bhm9p.fbxos.fr:35023/api/v10/')
  })

  test('the same from the mDNS record, whose values are all text', () => {
    const txt = Object.fromEntries(Object.entries(API_VERSION).map(([key, value]) => [key, String(value)]))
    expect(parseApiVersion(txt)?.httpsPort).toBe(35023)
    expect(parseApiVersion(txt)?.httpsAvailable).toBe(true)
  })

  test('nothing usable is nothing', () => {
    expect(parseApiVersion(null)).toBeNull()
    expect(parseApiVersion({ ...API_VERSION, api_domain: 'evil.example/../x' })).toBeNull()
    expect(parseApiVersion({ ...API_VERSION, https_port: 70000 })).toBeNull()
    expect(parseApiVersion({ ...API_VERSION, api_version: 'x' })).toBeNull()
    expect(parseApiVersion({ ...API_VERSION, api_base_url: '//elsewhere/' })?.apiBaseUrl).toBe('/api/')
  })

  test("Free's certificate authorities are the ones the API is checked against", () => {
    expect(FREEBOX_CA.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(3)
  })
})

describe('talking to it', () => {
  test('the session password is HMAC-SHA1 of the challenge, keyed by the app token', () => {
    expect(sessionPassword('dyNYgfK0Ya6FWGqq83sBHa7TwzWo+pg4fDFUJHShcLVYUD4D9jM6PM/r5qlz5k3y', 'VzhbtpR4r8CLaJle2QgJBEkyd8JPb0zL')).toBe('3d53ce1fa8a3560d7c7366ec2b9ae0c873a86b81')
  })

  test('answers: a result, or an error code with its message and, for an expired session, a new challenge', () => {
    expect(unwrap({ success: true, result: { a: 1 } })).toEqual({ ok: true, result: { a: 1 } })
    expect(unwrap({ success: true })).toEqual({ ok: true, result: null })
    expect(unwrap({ success: false, error_code: 'auth_required', msg: 'Merci de vous connecter', result: { challenge: 'abc' } })).toEqual({
      ok: false,
      code: 'auth_required',
      message: 'Merci de vous connecter',
      challenge: 'abc',
    })
    expect(unwrap('<html>')).toEqual({ ok: false, code: 'invalid_answer', message: "réponse illisible de la Freebox", challenge: null })
  })

  test('the authorization being tracked', () => {
    expect(authorizationStatus({ success: true, result: { status: 'pending', challenge: 'x' } })).toBe('pending')
    expect(authorizationStatus({ success: true, result: { status: 'granted' } })).toBe('granted')
    expect(authorizationStatus({ success: true, result: { status: 'weird' } })).toBeNull()
    expect(authorizationStatus({ success: false, error_code: 'invalid_request' })).toBeNull()
  })
})

describe('what it knows', () => {
  test('the internet connection', () => {
    expect(
      parseConnection({ type: 'ethernet', rate_down: 198900, bytes_up: 12035728872949, rate_up: 1440000, bandwidth_up: 700000000, ipv6: '2a01:e35:ffff:ffff::1', bandwidth_down: 1000000000, media: 'ftth', state: 'up', bytes_down: 2355966141297, ipv4: '82.67.0.1' })
    ).toEqual({ internet: 'up', media: 'ftth', ipv4: '82.67.0.1', ipv6: '2a01:e35:ffff:ffff::1', rateDown: 198900, rateUp: 1440000, bandwidthDown: 1000000000, bandwidthUp: 700000000 })
    expect(parseConnection({ state: 'going_down' }).internet).toBe('going_down')
    expect(parseConnection(null).internet).toBe('unknown')
  })

  test('the box itself', () => {
    expect(
      parseSystem({ mac: '68:A3:78:00:00:00', model_info: { pretty_name: 'Freebox Server (r2)', name: 'fbxgw-r2/full' }, board_name: 'fbxgw2r', uptime_val: 13550176, serial: '762601T190510709', firmware_version: '4.2.5' })
    ).toEqual({ name: 'Freebox Server (r2)', model: 'fbxgw-r2/full', mac: '68:a3:78:00:00:00', serial: '762601T190510709', firmware: '4.2.5' })
  })

  const HOSTS = [
    {
      l2ident: { id: '8C:97:EA:00:00:00', type: 'mac_address' },
      active: true,
      vendor_name: 'Freebox SAS',
      host_type: 'smartphone',
      interface: 'pub',
      id: 'ether-8c:97:ea:00:00:00',
      last_time_reachable: 1614107652,
      l3connectivities: [{ addr: '192.168.1.180', active: true, reachable: true, last_activity: 1614107614, af: 'ipv4', last_time_reachable: 1614104242 }],
      default_name: 'Freebox Player POP',
      reachable: true,
      last_activity: 1614107652,
      primary_name: 'Freebox Player POP',
    },
    {
      l2ident: { id: 'DE:00:B0:00:00:00', type: 'mac_address' },
      active: false,
      host_type: 'workstation',
      interface: 'pub',
      id: 'ether-de:00:b0:00:00:00',
      last_time_reachable: 1607125599,
      l3connectivities: [
        { addr: '192.168.1.181', active: false, af: 'ipv4', last_time_reachable: 1607125599 },
        { addr: '192.168.1.182', active: false, af: 'ipv4', last_time_reachable: 1607125599 },
      ],
      primary_name: '',
      names: [{ name: 'bureau-pc', source: 'dhcp' }],
    },
    {
      l2ident: { id: '5E:65:55:00:00:00', type: 'mac_address' },
      active: false,
      vendor_name: '',
      host_type: 'smartphone',
      interface: 'wifiguest',
      id: 'ether-5e:65:55:00:00:00',
      last_time_reachable: 1612611982,
      l3connectivities: [
        { addr: 'fe80::1', active: false, af: 'ipv6', last_time_reachable: 1612611982 },
        { addr: '192.168.1.148', active: false, af: 'ipv4', last_time_reachable: 1612611982 },
      ],
      primary_name: 'iPhoneofQuentin',
    },
    { l2ident: { type: 'mac_address' }, active: true, host_type: 'smartphone', id: 'broken' },
  ]

  test('hosts: MAC, name, type, activity, the address in use', () => {
    const hosts = parseHosts(HOSTS)
    expect(hosts).toEqual([
      { mac: '8c:97:ea:00:00:00', name: 'Freebox Player POP', type: 'smartphone', vendor: 'Freebox SAS', active: true, lastSeen: 1614107652_000, ipv4: '192.168.1.180', guest: false },
      { mac: 'de:00:b0:00:00:00', name: 'bureau-pc', type: 'workstation', vendor: null, active: false, lastSeen: 1607125599_000, ipv4: '192.168.1.181', guest: false },
      { mac: '5e:65:55:00:00:00', name: 'iPhoneofQuentin', type: 'smartphone', vendor: null, active: false, lastSeen: 1612611982_000, ipv4: '192.168.1.148', guest: true },
    ])
    expect(parseHosts({ not: 'a list' })).toEqual([])
  })

  test('the devices that say someone is home: phones and tablets, not a Freebox player that calls itself a phone', () => {
    const [player, pc, iphone] = parseHosts(HOSTS)
    expect(isPersonal(player!)).toBe(false)
    expect(isPersonal(pc!)).toBe(false)
    expect(isPersonal(iphone!)).toBe(true)
    expect(isPersonal({ ...iphone!, type: 'tablet' })).toBe(true)
  })

  test('home while on the network, and a while after: phones sleep their Wi-Fi', () => {
    const [, , iphone] = parseHosts(HOSTS)
    const now = 1612611982_000
    expect(presenceOf({ ...iphone!, active: true }, now, 600_000)).toEqual({ home: true, confidence: 1, source: 'network', lastSeenAt: new Date(now).toISOString() })
    expect(presenceOf(iphone!, now + 60_000, 600_000)).toEqual({ home: true, confidence: 0.6, source: 'network', lastSeenAt: new Date(now).toISOString() })
    expect(presenceOf(iphone!, now + 601_000, 600_000)).toEqual({ home: false, confidence: 1, source: 'network', lastSeenAt: new Date(now).toISOString() })
  })
})
