/**
 * The router tries routes in the order they are registered, so a route with a parameter
 * catches every later route of the same shape: `GET /devices/:id`, registered first, answered
 * "Device not found" to `GET /devices/properties`, and the device table never got its
 * columns. This reads the route table in order and fails on any route an earlier one would
 * catch, so the next route added below a parametric one is caught here rather than in the
 * browser.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../start/routes.ts', import.meta.url), 'utf8')
const ROUTE = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g

interface Declared {
  method: string
  path: string
  order: number
}

function declared(): Declared[] {
  return [...source.matchAll(ROUTE)].map((match, order) => ({ method: match[1]!, path: match[2]!, order }))
}

/** The matcher's rule: as many segments, each one the same or a parameter in the earlier route. */
function catches(earlier: string, later: string): boolean {
  if (earlier === later) return false
  const first = earlier.split('/').filter(Boolean)
  const second = later.split('/').filter(Boolean)
  if (first.length !== second.length) return false
  return first.every((segment, index) => segment.startsWith(':') || segment === second[index])
}

describe('the route table', () => {
  test('is read from the routes file', () => {
    const routes = declared()
    expect(routes.length).toBeGreaterThan(100)
    expect(routes).toContainEqual(expect.objectContaining({ method: 'get', path: '/devices/properties' }))
  })

  test('the matching rule: a parameter catches any segment, a fixed segment only itself', () => {
    expect(catches('/devices/:id', '/devices/properties')).toBe(true)
    expect(catches('/devices/search', '/devices/:id')).toBe(false)
    expect(catches('/devices/:id', '/devices/:id/history')).toBe(false)
    expect(catches('/devices/:id', '/devices/:id')).toBe(false)
  })

  test('no route is caught by a route with a parameter registered before it', () => {
    const routes = declared()
    const shadowed = routes.flatMap((route) =>
      routes
        .filter((earlier) => earlier.order < route.order && earlier.method === route.method && catches(earlier.path, route.path))
        .map((earlier) => `${route.method.toUpperCase()} ${route.path} is answered by ${earlier.path}`)
    )
    expect(shadowed).toEqual([])
  })
})
