/**
 * The Home Assistant adapter against a Home Assistant that speaks the real WebSocket API.
 *
 * The fake below is a real WebSocket server (Bun.serve) that follows the documented
 * conversation - auth_required, auth, auth_ok, then id-correlated commands and results,
 * state_changed events - so these tests exercise the adapter's socket, its request matching
 * and its reconnection exactly as a live Home Assistant would.
 * API: https://developers.home-assistant.io/docs/api/websocket
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Server, ServerWebSocket } from 'bun'
import type { NetworkHost } from '@sway-home/shared'
import { HomeAssistantAdapter } from '#adapters/homeassistant'
import type { HaState } from '#adapters/homeassistant_codec'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'

interface SocketData {
  authed: boolean
  subscriptions: number[]
}

class FakeHomeAssistant {
  token = 'secret'
  authAttempts = 0
  calls: Record<string, unknown>[] = []
  failNext: string | null = null
  states: HaState[] = [
    { entity_id: 'switch.prise_tv', state: 'on', attributes: { friendly_name: 'Prise TV' } },
    { entity_id: 'sensor.prise_tv_power', state: '42.5', attributes: { device_class: 'power', unit_of_measurement: 'W' } },
    { entity_id: 'sensor.prise_tv_energy', state: '3.2', attributes: { device_class: 'energy', unit_of_measurement: 'kWh' } },
    { entity_id: 'light.salon', state: 'off', attributes: { friendly_name: 'Lampe salon', supported_color_modes: ['brightness'], brightness: null } },
    { entity_id: 'sun.sun', state: 'above_horizon', attributes: {} },
  ]
  registry = {
    areas: [{ area_id: 'salon', name: 'Salon' }],
    devices: [{ id: 'dev-plug', name: 'Prise TV', name_by_user: null, manufacturer: 'Shelly', model: 'Plug S', sw_version: '1.2', area_id: 'salon' }],
    entities: [
      { entity_id: 'switch.prise_tv', device_id: 'dev-plug', area_id: null, entity_category: null, disabled_by: null, hidden_by: null },
      { entity_id: 'sensor.prise_tv_power', device_id: 'dev-plug', area_id: null, entity_category: null, disabled_by: null, hidden_by: null },
      { entity_id: 'sensor.prise_tv_energy', device_id: 'dev-plug', area_id: null, entity_category: null, disabled_by: null, hidden_by: null },
    ],
  }
  #server: Server<SocketData> | null = null
  #sockets = new Set<ServerWebSocket<SocketData>>()

  start(): string {
    this.#server = Bun.serve<SocketData>({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request, server) => {
        if (new URL(request.url).pathname === '/api/websocket' && server.upgrade(request, { data: { authed: false, subscriptions: [] } })) return undefined
        return new Response('not found', { status: 404 })
      },
      websocket: {
        open: (ws) => {
          this.#sockets.add(ws)
          ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.9.1' }))
        },
        close: (ws) => void this.#sockets.delete(ws),
        message: (ws, raw) => this.#handle(ws, JSON.parse(String(raw))),
      },
    })
    return `http://127.0.0.1:${this.#server.port}`
  }

  stop(): void {
    this.#server?.stop(true)
  }

  /** Severs every connection, the way a Home Assistant restart does. */
  drop(): void {
    for (const ws of this.#sockets) ws.close(1012, 'restart')
  }

  /** Changes an entity and tells every subscriber, as HA does. */
  push(entityId: string, state: string, attributes?: Record<string, unknown>): void {
    const index = this.states.findIndex((entry) => entry.entity_id === entityId)
    const old = this.states[index]!
    const next = { entity_id: entityId, state, attributes: attributes ?? old.attributes }
    this.states[index] = next
    for (const ws of this.#sockets) {
      for (const id of ws.data.subscriptions) {
        ws.send(JSON.stringify({ id, type: 'event', event: { event_type: 'state_changed', data: { entity_id: entityId, old_state: old, new_state: next } } }))
      }
    }
  }

  #handle(ws: ServerWebSocket<SocketData>, message: Record<string, any>): void {
    const reply = (payload: Record<string, unknown>): void => {
      ws.send(JSON.stringify(payload))
    }
    if (!ws.data.authed) {
      if (message.type !== 'auth') return ws.close(1008, 'auth first')
      this.authAttempts += 1
      if (message.access_token !== this.token) {
        reply({ type: 'auth_invalid', message: 'Invalid access token or password' })
        return ws.close(1008, 'auth_invalid')
      }
      ws.data.authed = true
      return reply({ type: 'auth_ok', ha_version: '2026.9.1' })
    }

    const result = (value: unknown) => reply({ id: message.id, type: 'result', success: true, result: value })
    switch (message.type) {
      case 'get_states':
        return result(this.states)
      case 'config/area_registry/list':
        return result(this.registry.areas)
      case 'config/device_registry/list':
        return result(this.registry.devices)
      case 'config/entity_registry/list':
        return result(this.registry.entities)
      case 'subscribe_events':
        ws.data.subscriptions.push(message.id)
        return result(null)
      case 'ping':
        return reply({ id: message.id, type: 'pong' })
      case 'call_service': {
        this.calls.push(message)
        if (this.failNext) {
          const error = this.failNext
          this.failNext = null
          return reply({ id: message.id, type: 'result', success: false, error: { code: 'home_assistant_error', message: error } })
        }
        return result({ context: { id: 'ctx' } })
      }
      default:
        return reply({ id: message.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'Unknown command.' } })
    }
  }
}

let ha: FakeHomeAssistant
let url: string
let context: RecordingContext
let adapter: HomeAssistantAdapter

beforeEach(() => {
  ha = new FakeHomeAssistant()
  url = ha.start()
  context = recordingContext()
  adapter = new HomeAssistantAdapter({ reconnectMs: 20, requestTimeoutMs: 1000 })
})

afterEach(async () => {
  await adapter.shutdown()
  ha.stop()
})

describe('connecting', () => {
  test('authenticates and finds the devices, grouped the way HA groups them', async () => {
    await adapter.init(context, { url, token: 'secret' })
    const found = await adapter.discover([])
    const byId = new Map(found.map((device) => [device.nativeId, device]))

    expect(byId.get('dev-plug')).toMatchObject({
      adapterId: 'homeassistant',
      uid: 'homeassistant:dev-plug',
      name: 'Prise TV',
      category: 'switch',
      capabilities: ['onoff', 'power', 'energy'],
      manufacturer: 'Shelly',
      model: 'Plug S',
    })
    expect(byId.get('light.salon')).toMatchObject({ name: 'Lampe salon', category: 'light', capabilities: ['onoff', 'brightness'] })
    // What Sway has no word for does not become a device.
    expect(byId.has('sun.sun')).toBe(false)
    expect(adapter.status().health).toBe('ok')
  })

  test('a wrong token is said once, and HA is not hammered with retries', async () => {
    ha.token = 'the-right-one'
    await adapter.init(context, { url, token: 'secret' })
    await eventually(() => adapter.status().health === 'error')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(ha.authAttempts).toBe(1)
    expect(adapter.status().message).toMatch(/jeton/i)
  })

  test('with no URL or token it waits to be set up, and finds nothing', async () => {
    await adapter.init(context, {})
    expect(adapter.status().health).toBe('needs_setup')
    expect(await adapter.discover([])).toEqual([])
  })

  test('a Home Assistant seen on the network is pointed out, with its address', async () => {
    await adapter.init(context, {})
    const host = { ip: '192.168.1.50', openPorts: [8123], mdnsServices: ['_home-assistant._tcp'] } as unknown as NetworkHost
    expect(await adapter.discover([host])).toEqual([])
    expect(adapter.status().message).toContain('http://192.168.1.50:8123')
  })
})

describe('state', () => {
  test('a device reads as the merge of its entities', async () => {
    await adapter.init(context, { url, token: 'secret' })
    await adapter.discover([])
    expect(await adapter.getState('dev-plug')).toEqual({ on: true, power: 42.5, energyTotal: 3.2 })
  })

  test('a change in Home Assistant arrives as a push, on the right device', async () => {
    await adapter.init(context, { url, token: 'secret' })
    await adapter.discover([])
    ha.push('sensor.prise_tv_power', '0')
    await eventually(() => context.stateOf('dev-plug').power === 0)
  })

  test('an entity going unavailable takes its device offline, and back', async () => {
    await adapter.init(context, { url, token: 'secret' })
    await adapter.discover([])
    ha.push('light.salon', 'unavailable')
    await eventually(() => context.availability.some((entry) => entry.nativeId === 'light.salon' && !entry.online))
    ha.push('light.salon', 'on', { supported_color_modes: ['brightness'], brightness: 255 })
    await eventually(() => context.availability.at(-1)?.online === true && context.stateOf('light.salon').brightness === 100)
  })
})

describe('commands', () => {
  test('a command is a service call on the entity that carries the capability', async () => {
    await adapter.init(context, { url, token: 'secret' })
    await adapter.discover([])
    const result = await adapter.execute('dev-plug', 'turnOff', {})
    expect(result.ok).toBe(true)
    expect(ha.calls).toHaveLength(1)
    expect(ha.calls[0]).toMatchObject({ type: 'call_service', domain: 'switch', service: 'turn_off', target: { entity_id: 'switch.prise_tv' } })
  })

  test('a command the device cannot take never reaches Home Assistant', async () => {
    await adapter.init(context, { url, token: 'secret' })
    await adapter.discover([])
    const result = await adapter.execute('dev-plug', 'setBrightness', { brightness: 50 })
    expect(result.ok).toBe(false)
    expect(ha.calls).toHaveLength(0)
  })

  test("a refused service call fails with Home Assistant's own reason", async () => {
    await adapter.init(context, { url, token: 'secret' })
    await adapter.discover([])
    ha.failNext = 'Entity is locked by policy'
    const result = await adapter.execute('light.salon', 'turnOn', {})
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('locked by policy') })
  })
})

describe('resilience', () => {
  test('reconnects after Home Assistant restarts, and catches up on what changed meanwhile', async () => {
    await adapter.init(context, { url, token: 'secret' })
    await adapter.discover([])
    ha.drop()
    // Changed while the adapter was not listening: no event will ever carry it.
    ha.states = ha.states.map((entry) => (entry.entity_id === 'switch.prise_tv' ? { ...entry, state: 'off' } : entry))
    await eventually(() => ha.authAttempts >= 2)
    await eventually(() => context.stateOf('dev-plug').on === false)
    expect(adapter.status().health).toBe('ok')
  })
})
