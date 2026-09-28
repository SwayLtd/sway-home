/**
 * Who may talk to the hub from a browser.
 *
 * The hub has no login: it trusts its network. What it must not trust is a web page. Any site
 * open in a browser on the LAN can send requests to http://localhost:3333 or to the hub's LAN
 * address; with a permissive CORS policy it could read the house and unlock the door, and a
 * DNS-rebinding page can even pass as the hub's own origin. The guard lets through what comes
 * from the house (no Origin, or an Origin on a local address) and refuses the rest.
 */

import { describe, expect, test } from 'bun:test'
import OriginGuardMiddleware from '#middleware/origin_guard_middleware'
import { isAllowedHost, isAllowedOrigin, refusal } from '#services/origin_guard'

describe('an Origin header', () => {
  test('a page served from the house is let in', () => {
    for (const origin of [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      'http://192.168.1.20:8080',
      'http://10.0.0.5',
      'http://172.16.4.2:3000',
      'http://169.254.10.1',
      'http://100.101.102.103:3000',
      'http://[fd12:3456::1]:3000',
      'http://[fe80::1]:3000',
      'http://sway-hub.local:3000',
      'http://sway-hub:3000',
      'https://hub.home.arpa',
      'http://maison.lan:3000',
    ]) {
      expect({ origin, allowed: isAllowedOrigin(origin) }).toEqual({ origin, allowed: true })
    }
  })

  test('a page from anywhere else is refused, however it dresses up', () => {
    for (const origin of [
      'https://evil.example.com',
      'http://localhost.evil.com',
      'http://127.0.0.1.nip.io:3000',
      'http://192.168.1.20.evil.com',
      'http://8.8.8.8',
      'http://172.32.0.1',
      'null',
      'file://',
      'not a url',
      '',
    ]) {
      expect({ origin, allowed: isAllowedOrigin(origin) }).toEqual({ origin, allowed: false })
    }
  })

  test('a public name the house uses is allowed once it is listed', () => {
    expect(isAllowedOrigin('https://maison.example.com')).toBe(false)
    expect(isAllowedOrigin('https://maison.example.com', ['maison.example.com'])).toBe(true)
    expect(isAllowedOrigin('https://MAISON.example.com:8443', ['maison.example.com'])).toBe(true)
  })
})

describe('a Host header', () => {
  test('the names the hub answers to on the network', () => {
    for (const host of ['localhost:3333', '127.0.0.1:3333', '[::1]:3333', '192.168.1.5:3333', '192.168.1.5', 'sway-hub.local:3333', 'sway-hub', undefined]) {
      expect({ host, allowed: isAllowedHost(host) }).toEqual({ host, allowed: true })
    }
  })

  test('a public name pointing at the hub is DNS rebinding, and refused', () => {
    for (const host of ['evil.example.com', 'evil.example.com:3333', 'localhost.evil.com', '127.0.0.1.nip.io:3333', '']) {
      expect({ host, allowed: isAllowedHost(host) }).toEqual({ host, allowed: false })
    }
    expect(isAllowedHost('maison.example.com', ['maison.example.com'])).toBe(true)
  })
})

describe('a request', () => {
  test('from the house, from a script, or through the console proxy, passes', () => {
    expect(refusal({ host: 'localhost:3333' })).toBeNull()
    expect(refusal({ host: 'localhost:3333', origin: 'http://localhost:3000' })).toBeNull()
    expect(refusal({ host: '192.168.1.5:3333', origin: 'http://192.168.1.30:3000' })).toBeNull()
  })

  test('from a foreign page, or to a rebound name, is refused with the reason', () => {
    expect(refusal({ host: 'localhost:3333', origin: 'https://evil.example.com' })).toMatch(/origine/)
    expect(refusal({ host: 'evil.example.com:3333' })).toMatch(/hôte/)
    expect(refusal({ host: 'localhost:3333', origin: 'null' })).toMatch(/origine/)
  })
})

describe('the middleware', () => {
  function context(headers: Record<string, string>) {
    const sent: { status?: number; body?: unknown } = {}
    const ctx = {
      request: { header: (name: string) => headers[name.toLowerCase()] },
      response: {
        status(code: number) {
          sent.status = code
          return this
        },
        send(body: unknown) {
          sent.body = body
        },
      },
    }
    return { ctx, sent }
  }

  test('lets a house request through to the route', async () => {
    const { ctx, sent } = context({ host: 'localhost:3333', origin: 'http://localhost:3000' })
    let reached = false
    await new OriginGuardMiddleware().handle(ctx as never, async () => {
      reached = true
    })
    expect(reached).toBe(true)
    expect(sent.status).toBeUndefined()
  })

  test('answers 403 to a foreign page, preflight included, without reaching the route', async () => {
    for (const method of ['POST', 'OPTIONS']) {
      const { ctx, sent } = context({ host: 'localhost:3333', origin: 'https://evil.example.com', 'access-control-request-method': method })
      let reached = false
      await new OriginGuardMiddleware().handle(ctx as never, async () => {
        reached = true
      })
      expect(reached).toBe(false)
      expect(sent).toEqual({ status: 403, body: { error: expect.stringMatching(/origine/) } })
    }
  })
})
