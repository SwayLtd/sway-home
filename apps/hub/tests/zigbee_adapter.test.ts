/**
 * The Zigbee adapter against zigbee2mqtt, over a real MQTT broker.
 *
 * The broker is a real TCP server speaking MQTT 3.1.1 (see fake_mqtt_broker.ts), and the
 * test plays zigbee2mqtt on it: retained `bridge/state` and `bridge/devices`, device state
 * topics, availability, and answers to `bridge/request/permit_join`. So these tests run the
 * hub's own MQTT client, the adapter's topic handling and the codec together, the way they
 * run against a Mosquitto with zigbee2mqtt behind it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ZigbeeAdapter } from '#adapters/zigbee'
import { MqttAdapter } from '#adapters/mqtt'
import type { BridgeDevice, Expose } from '#adapters/zigbee_codec'
import { FakeMqttBroker } from './fake_mqtt_broker.ts'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'

const LAMP_IEEE = '0x0017880100aabbcc'
const SWITCH_IEEE = '0xa4c1380000112233'
const REMOTE_IEEE = '0x000d6ffffe445566'

const lightExposes: Expose[] = [
  {
    type: 'light',
    features: [
      { type: 'binary', name: 'state', property: 'state', value_on: 'ON', value_off: 'OFF', value_toggle: 'TOGGLE', access: 7 },
      { type: 'numeric', name: 'brightness', property: 'brightness', value_min: 0, value_max: 254, access: 7 },
    ],
  },
  { type: 'numeric', name: 'linkquality', property: 'linkquality', access: 1 },
]
const gangExposes: Expose[] = ['l1', 'l2'].map((endpoint) => ({
  type: 'switch',
  endpoint,
  features: [{ type: 'binary', name: 'state', property: `state_${endpoint}`, endpoint, value_on: 'ON', value_off: 'OFF', value_toggle: 'TOGGLE', access: 7 }],
}))
const remoteExposes: Expose[] = [{ type: 'enum', name: 'action', property: 'action', values: ['on', 'off', 'double'], access: 1 }]

function device(ieee: string, friendly: string, exposes: Expose[], patch: Partial<BridgeDevice> = {}): BridgeDevice {
  return { ieee_address: ieee, friendly_name: friendly, type: 'Router', supported: true, disabled: false, interview_state: 'SUCCESSFUL', definition: { model: 'M', vendor: 'V', exposes }, ...patch }
}

const COORDINATOR: BridgeDevice = { ieee_address: '0x00124b0000000000', friendly_name: 'Coordinator', type: 'Coordinator' }

let broker: FakeMqttBroker
let port: number
let context: RecordingContext
let adapter: ZigbeeAdapter

function bridge(devices: BridgeDevice[]): void {
  broker.publish('zigbee2mqtt/bridge/state', { state: 'online' }, { retain: true })
  broker.publish('zigbee2mqtt/bridge/devices', [COORDINATOR, ...devices], { retain: true })
}

beforeEach(async () => {
  broker = new FakeMqttBroker()
  port = await broker.start()
  context = recordingContext()
  adapter = new ZigbeeAdapter({ reconnectMs: 30, pairTimeoutMs: 500 })
  bridge([device(LAMP_IEEE, 'Lampe salon', lightExposes), device(SWITCH_IEEE, 'Double interrupteur', gangExposes), device(REMOTE_IEEE, 'Télécommande', remoteExposes, { type: 'EndDevice' })])
  broker.publish('zigbee2mqtt/Lampe salon', { state: 'ON', brightness: 254, linkquality: 90 }, { retain: true })
})

afterEach(async () => {
  await adapter.shutdown()
  await broker.stop()
})

async function start(config: Record<string, unknown> = {}): Promise<void> {
  await adapter.init(context, { host: '127.0.0.1', port, ...config })
  await eventually(() => adapter.status().deviceCount === 3)
}

describe('the bridge', () => {
  test('imports what zigbee2mqtt knows, keyed by IEEE address, without the coordinator', async () => {
    await start()
    const found = await adapter.discover([])
    expect(found.map((entry) => entry.nativeId).sort()).toEqual([REMOTE_IEEE, LAMP_IEEE, SWITCH_IEEE].sort())
    expect(found.find((entry) => entry.nativeId === LAMP_IEEE)).toMatchObject({ uid: `zigbee:${LAMP_IEEE}`, name: 'Lampe salon', category: 'light', transport: 'zigbee' })
    expect(found.find((entry) => entry.nativeId === SWITCH_IEEE)?.endpoints).toHaveLength(2)
    expect(adapter.status().health).toBe('ok')
  })

  test('a retained state is known from the start, before the device next changes', async () => {
    await start()
    expect(await adapter.getState(LAMP_IEEE)).toMatchObject({ on: true, brightness: 100, linkQuality: 90 })
  })

  test('zigbee2mqtt going offline takes every device offline and says why', async () => {
    await start()
    broker.publish('zigbee2mqtt/bridge/state', { state: 'offline' }, { retain: true })
    await eventually(() => adapter.status().health === 'error')
    expect(adapter.status().message).toMatch(/zigbee2mqtt/i)
    expect(context.availability.filter((entry) => !entry.online).map((entry) => entry.nativeId).sort()).toEqual([REMOTE_IEEE, LAMP_IEEE, SWITCH_IEEE].sort())
  })

  test('a device joining later is announced to the hub', async () => {
    await start()
    const joined = device('0x54ef441000778899', 'Nouvelle prise', [{ type: 'switch', features: [{ type: 'binary', name: 'state', property: 'state', value_on: 'ON', value_off: 'OFF', access: 7 }] }])
    bridge([device(LAMP_IEEE, 'Lampe salon', lightExposes), device(SWITCH_IEEE, 'Double interrupteur', gangExposes), device(REMOTE_IEEE, 'Télécommande', remoteExposes), joined])
    await eventually(() => context.discovered.some((entry) => entry.nativeId === '0x54ef441000778899'))
  })
})

describe('state', () => {
  test('a state message reaches the hub on the right device', async () => {
    await start()
    broker.publish('zigbee2mqtt/Lampe salon', { state: 'OFF', brightness: 127 })
    await eventually(() => context.stateOf(LAMP_IEEE).on === false && context.stateOf(LAMP_IEEE).brightness === 50)
  })

  test('availability, in the 2.x JSON form and the legacy plain form', async () => {
    await start()
    broker.publish('zigbee2mqtt/Lampe salon/availability', { state: 'offline' })
    await eventually(() => context.availability.at(-1)?.online === false)
    broker.publish('zigbee2mqtt/Lampe salon/availability', 'online')
    await eventually(() => context.availability.at(-1)?.online === true)
  })

  test('each gang of a double switch reports on its own endpoint', async () => {
    await start()
    broker.publish('zigbee2mqtt/Double interrupteur', { state_l1: 'OFF', state_l2: 'ON' })
    await eventually(() => context.stateOf(SWITCH_IEEE, 2).on === true && context.stateOf(SWITCH_IEEE, 1).on === false)
  })

  test('a button press is an event the automations can listen to', async () => {
    await start()
    broker.publish('zigbee2mqtt/Télécommande', { action: 'double' })
    await eventually(() => context.events.find((entry) => entry.nativeId === REMOTE_IEEE && entry.event === 'button' && entry.payload?.action === 'double'))
  })
})

describe('commands', () => {
  test('a command is published to the device /set topic, in its own vocabulary', async () => {
    await start()
    const result = await adapter.execute(LAMP_IEEE, 'setBrightness', { brightness: 50 })
    expect(result.ok).toBe(true)
    await eventually(() => broker.published.find((entry) => entry.topic === 'zigbee2mqtt/Lampe salon/set'))
    expect(JSON.parse(broker.published.find((entry) => entry.topic === 'zigbee2mqtt/Lampe salon/set')!.payload)).toEqual({ state: 'ON', brightness: 127 })
  })

  test('a gang is switched through its endpoint', async () => {
    await start()
    await adapter.execute(SWITCH_IEEE, 'turnOff', {}, 2)
    await eventually(() => broker.published.find((entry) => entry.topic === 'zigbee2mqtt/Double interrupteur/set' && entry.payload === JSON.stringify({ state_l2: 'OFF' })))
  })

  test('renamed in zigbee2mqtt, the device keeps its identity and commands follow the new name', async () => {
    await start()
    bridge([device(LAMP_IEEE, 'Lampe séjour', lightExposes), device(SWITCH_IEEE, 'Double interrupteur', gangExposes), device(REMOTE_IEEE, 'Télécommande', remoteExposes)])
    await eventually(() => adapter.friendlyName(LAMP_IEEE) === 'Lampe séjour')
    await adapter.execute(LAMP_IEEE, 'turnOn', {})
    await eventually(() => broker.published.find((entry) => entry.topic === 'zigbee2mqtt/Lampe séjour/set'))
  })

  test('what the device cannot do is refused without publishing anything', async () => {
    await start()
    const result = await adapter.execute(REMOTE_IEEE, 'turnOn', {})
    expect(result.ok).toBe(false)
    expect(broker.published.filter((entry) => entry.topic.endsWith('/set'))).toHaveLength(0)
  })
})

describe('pairing', () => {
  test('opens the network for joining and reports what zigbee2mqtt answered', async () => {
    broker.onPublish = (topic, payload) => {
      if (topic !== 'zigbee2mqtt/bridge/request/permit_join') return
      const request = JSON.parse(payload)
      broker.publish('zigbee2mqtt/bridge/response/permit_join', { data: { time: request.time }, status: 'ok', transaction: request.transaction })
    }
    await start()
    const result = await adapter.pair({ seconds: 120 })
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/120/)
    expect(JSON.parse(broker.published.find((entry) => entry.topic === 'zigbee2mqtt/bridge/request/permit_join')!.payload)).toMatchObject({ time: 120 })
  })

  test('an error from zigbee2mqtt is passed on', async () => {
    broker.onPublish = (topic, payload) => {
      if (topic !== 'zigbee2mqtt/bridge/request/permit_join') return
      broker.publish('zigbee2mqtt/bridge/response/permit_join', { data: {}, status: 'error', error: 'Coordinator is not responding', transaction: JSON.parse(payload).transaction })
    }
    await start()
    expect(await adapter.pair({})).toMatchObject({ ok: false, message: expect.stringContaining('Coordinator is not responding') })
  })

  test('silence from zigbee2mqtt is a clear failure, not a hang', async () => {
    await start()
    expect(await adapter.pair({})).toMatchObject({ ok: false })
  })
})

describe('the connection', () => {
  test('the broker refusing the credentials is an error that says so', async () => {
    broker.refuseWith = 5
    await adapter.init(context, { host: '127.0.0.1', port, username: 'hub', password: 'wrong' })
    await eventually(() => adapter.status().health === 'error')
    expect(adapter.status().message).toMatch(/identifiants|refus/i)
  })

  test('reconnects after the broker restarts, and catches up from the retained messages', async () => {
    await start()
    broker.kick()
    broker.publish('zigbee2mqtt/Lampe salon', { state: 'OFF', brightness: 10 }, { retain: true })
    await eventually(() => broker.connects.length >= 2)
    await eventually(() => context.stateOf(LAMP_IEEE).on === false)
  })

  test('with no broker address it waits to be set up', async () => {
    await adapter.init(context, {})
    expect(adapter.status().health).toBe('needs_setup')
  })

  test('the generic MQTT adapter leaves this bridge to the Zigbee adapter, so nothing appears twice', async () => {
    await start()
    const mqtt = new MqttAdapter()
    const mqttContext = recordingContext()
    try {
      await mqtt.init(mqttContext, { host: '127.0.0.1', port, zigbee2mqttBase: 'zigbee2mqtt' })
      await eventually(() => broker.clients === 2)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(mqttContext.discovered).toHaveLength(0)
    } finally {
      await mqtt.shutdown()
    }
  })
})
