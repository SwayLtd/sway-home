/**
 * The Z-Wave adapter against a zwave-js-server that speaks the real WebSocket protocol.
 *
 * The fake follows the documented conversation (https://github.com/zwave-js/zwave-js-server):
 * a `version` message on connect, `set_api_schema`, `start_listening` answered with the full
 * state, `node.set_value` answered with a SetValueResult, and events shaped
 * `{type: 'event', event: {source, event, nodeId?, args?}}`. S2 inclusion sends
 * `grant security classes` and `validate dsk and enter pin` events that need a reply.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Server, ServerWebSocket } from 'bun'
import { ZwaveAdapter } from '#adapters/zwave'
import type { ZwaveNode } from '#adapters/zwave_codec'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'

const HOME_ID = 3967882672

function nodes(): ZwaveNode[] {
  return [
    { nodeId: 1, isControllerNode: true, status: 4, ready: true, values: [] },
    {
      nodeId: 5,
      name: 'Prise four',
      status: 4,
      ready: true,
      deviceClass: { generic: { label: 'Binary Switch' }, specific: { label: '' } },
      deviceConfig: { manufacturer: 'AEON Labs', label: 'ZW139', description: 'Nano Switch' },
      values: [
        { commandClass: 37, endpoint: 0, property: 'currentValue', value: true, metadata: { readable: true, writeable: false } },
        { commandClass: 37, endpoint: 0, property: 'targetValue', metadata: { readable: false, writeable: true } },
      ],
    },
    {
      nodeId: 9,
      name: 'Détecteur couloir',
      status: 1,
      ready: true,
      deviceClass: { generic: { label: 'Notification Sensor' }, specific: { label: '' } },
      values: [
        { commandClass: 113, endpoint: 0, property: 'Home Security', propertyKey: 'Motion sensor status', value: 0 },
        { commandClass: 91, endpoint: 0, property: 'scene', propertyKey: '001', metadata: { readable: true, writeable: false } },
      ],
    },
  ]
}

interface Data {
  schema: number | null
}

class FakeZwaveServer {
  received: Record<string, any>[] = []
  setValueStatus = 255
  nodes = nodes()
  #server: Server<Data> | null = null
  #sockets = new Set<ServerWebSocket<Data>>()
  /** Called for every command, so a test can play the controller's side of a conversation. */
  onCommand: (message: Record<string, any>) => void = () => undefined

  start(): string {
    this.#server = Bun.serve<Data>({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request, server) => (server.upgrade(request, { data: { schema: null } }) ? undefined : new Response('no', { status: 400 })),
      websocket: {
        open: (ws) => {
          this.#sockets.add(ws)
          ws.send(JSON.stringify({ type: 'version', driverVersion: '15.3.0', serverVersion: '3.1.0', homeId: HOME_ID, minSchemaVersion: 0, maxSchemaVersion: 40 }))
        },
        close: (ws) => void this.#sockets.delete(ws),
        message: (ws, raw) => this.#handle(ws, JSON.parse(String(raw))),
      },
    })
    return `ws://127.0.0.1:${this.#server.port}`
  }

  stop(): void {
    this.#server?.stop(true)
  }

  drop(): void {
    for (const ws of this.#sockets) ws.close(1012, 'restart')
  }

  event(event: Record<string, unknown>): void {
    for (const ws of this.#sockets) ws.send(JSON.stringify({ type: 'event', event }))
  }

  #handle(ws: ServerWebSocket<Data>, message: Record<string, any>): void {
    this.received.push(message)
    const result = (value: unknown = {}) => ws.send(JSON.stringify({ type: 'result', messageId: message.messageId, success: true, result: value }))
    switch (message.command) {
      case 'set_api_schema':
        ws.data.schema = message.schemaVersion
        result()
        break
      case 'start_listening':
        result({ state: { driver: {}, controller: { homeId: HOME_ID }, nodes: this.nodes } })
        break
      case 'node.set_value':
        result({ result: { status: this.setValueStatus } })
        break
      default:
        result({ success: true })
    }
    this.onCommand(message)
  }
}

let server: FakeZwaveServer
let url: string
let context: RecordingContext
let adapter: ZwaveAdapter

beforeEach(() => {
  server = new FakeZwaveServer()
  url = server.start()
  context = recordingContext()
  adapter = new ZwaveAdapter({ reconnectMs: 20, requestTimeoutMs: 1000 })
})

afterEach(async () => {
  await adapter.shutdown()
  server.stop()
})

async function start(): Promise<void> {
  await adapter.init(context, { url })
  await adapter.discover([])
}

describe('connecting', () => {
  test('negotiates the schema, then lists the nodes but not the controller', async () => {
    await start()
    const found = await adapter.discover([])
    expect(found.map((device) => device.nativeId).sort()).toEqual(['5', '9'])
    expect(found.find((device) => device.nativeId === '5')).toMatchObject({ uid: `zwave:${HOME_ID}:5`, name: 'Prise four', category: 'switch', capabilities: ['onoff'] })
    const schema = server.received.find((message) => message.command === 'set_api_schema')
    expect(schema?.schemaVersion).toBeGreaterThan(0)
    expect(schema?.schemaVersion).toBeLessThanOrEqual(40)
    expect(adapter.status().health).toBe('ok')
  })

  test('the initial state is known at once', async () => {
    await start()
    expect(await adapter.getState('5')).toEqual({ on: true })
  })

  test('with no address it waits to be set up', async () => {
    await adapter.init(context, {})
    expect(adapter.status().health).toBe('needs_setup')
    expect(await adapter.discover([])).toEqual([])
  })

  test('reconnects after the server restarts, and resynchronises', async () => {
    await start()
    server.drop()
    server.nodes[1]!.values[0]!.value = false
    await eventually(() => server.received.filter((message) => message.command === 'start_listening').length >= 2)
    await eventually(() => context.stateOf('5').on === false)
  })
})

describe('events', () => {
  test('a value update reaches the hub', async () => {
    await start()
    server.event({ source: 'node', event: 'value updated', nodeId: 9, args: { commandClass: 113, endpoint: 0, property: 'Home Security', propertyKey: 'Motion sensor status', newValue: 8, prevValue: 0 } })
    await eventually(() => context.stateOf('9').motion === true)
  })

  test('dead is offline and alive is back; asleep is not offline', async () => {
    await start()
    server.event({ source: 'node', event: 'sleep', nodeId: 9 })
    server.event({ source: 'node', event: 'dead', nodeId: 5 })
    await eventually(() => context.availability.some((entry) => entry.nativeId === '5' && !entry.online))
    expect(context.availability.some((entry) => entry.nativeId === '9' && !entry.online)).toBe(false)
    server.event({ source: 'node', event: 'alive', nodeId: 5 })
    await eventually(() => context.availability.at(-1)?.online === true)
  })

  test('a scene button press is an event', async () => {
    await start()
    server.event({ source: 'node', event: 'value notification', nodeId: 9, args: { commandClass: 91, endpoint: 0, property: 'scene', propertyKey: '001', value: 3 } })
    await eventually(() => context.events.find((entry) => entry.nativeId === '9' && entry.event === 'button' && entry.payload?.action === 'double'))
  })

  test('a node added is discovered; a node removed goes offline', async () => {
    await start()
    server.event({
      source: 'controller',
      event: 'node added',
      node: { nodeId: 12, status: 4, ready: true, deviceClass: { generic: { label: 'Binary Switch' } }, values: [{ commandClass: 37, endpoint: 0, property: 'currentValue', value: false }] },
    })
    await eventually(() => context.discovered.some((device) => device.nativeId === '12'))
    server.event({ source: 'controller', event: 'node removed', node: { nodeId: 12 }, reason: 0 })
    await eventually(() => context.availability.some((entry) => entry.nativeId === '12' && !entry.online))
  })
})

describe('commands', () => {
  test('a command is one node.set_value on the right value id', async () => {
    await start()
    const result = await adapter.execute('5', 'turnOff', {})
    expect(result.ok).toBe(true)
    expect(server.received.find((message) => message.command === 'node.set_value')).toMatchObject({
      nodeId: 5,
      valueId: { commandClass: 37, endpoint: 0, property: 'targetValue' },
      value: false,
    })
  })

  test('a failed set is a failed command', async () => {
    await start()
    server.setValueStatus = 2
    expect((await adapter.execute('5', 'turnOn', {})).ok).toBe(false)
  })

  test('what the node cannot do is refused without a message', async () => {
    await start()
    expect((await adapter.execute('9', 'turnOn', {})).ok).toBe(false)
    expect(server.received.some((message) => message.command === 'node.set_value')).toBe(false)
  })
})

describe('inclusion', () => {
  test('a secure device: the requested classes are granted and the PIN from its label is entered', async () => {
    server.onCommand = (message) => {
      if (message.command === 'controller.begin_inclusion') server.event({ source: 'controller', event: 'grant security classes', requested: { securityClasses: [1, 2], clientSideAuth: false } })
      if (message.command === 'controller.grant_security_classes') server.event({ source: 'controller', event: 'validate dsk and enter pin', dsk: '-23456-34567-45678-56789-67890-78901-89012' })
    }
    await start()
    const result = await adapter.pair({ pin: '12345' })
    expect(result.ok).toBe(true)
    await eventually(() => server.received.find((message) => message.command === 'controller.validate_dsk_and_enter_pin'))
    expect(server.received.find((message) => message.command === 'controller.begin_inclusion')).toMatchObject({ options: { strategy: 0 } })
    expect(server.received.find((message) => message.command === 'controller.grant_security_classes')).toMatchObject({ inclusionGrant: { securityClasses: [1, 2], clientSideAuth: false } })
    expect(server.received.find((message) => message.command === 'controller.validate_dsk_and_enter_pin')).toMatchObject({ pin: '12345' })
  })

  test('a device that asks for a PIN nobody gave stops the inclusion and says what is missing', async () => {
    server.onCommand = (message) => {
      if (message.command === 'controller.begin_inclusion') server.event({ source: 'controller', event: 'validate dsk and enter pin', dsk: '-23456-34567' })
    }
    await start()
    await adapter.pair({})
    await eventually(() => server.received.find((message) => message.command === 'controller.stop_inclusion'))
    await eventually(() => /PIN/.test(adapter.status().message ?? ''))
  })
})
