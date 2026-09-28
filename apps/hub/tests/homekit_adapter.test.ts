/**
 * The HomeKit adapter against a real HomeKit bridge.
 *
 * The bridge is HAP-NodeJS - the accessory side Homebridge is built on - run under Node by
 * fixtures/hap_accessory.mjs, with eight accessories behind it. The adapter pairs with it by
 * its setup code, opens the encrypted session, subscribes, commands it and lets go of it
 * exactly as it would a real accessory. Only mDNS is stood in for: the adapter is handed the
 * record the bridge advertises (built by HAP-NodeJS itself), pointed at 127.0.0.1.
 */

import { describe, expect, test } from 'bun:test'
import { HomekitAdapter, type HomekitOptions } from '#adapters/homekit'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'
import { hapBridge, type TestBridge } from './fixtures/hap_bridge.ts'

/** What mDNS would hear: every bridge still running. */
const network: TestBridge[] = []
let adapter: HomekitAdapter | null = null

/**
 * Each test tears its bridges down itself, in its own body: Bun 1.2 on Windows dies silently
 * (exit 127) when a child process the test reached over TCP exits during an afterEach hook, or
 * after it. Reproduced with a bare Node TCP server; see oven-sh/bun#38860 and #43888.
 */
function scenario(run: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await run()
    } finally {
      await adapter?.shutdown()
      adapter = null
      for (const bridge of network.splice(0)) await bridge.stop()
    }
  }
}

async function started(options: HomekitOptions = {}, context = recordingContext()): Promise<RecordingContext> {
  adapter = new HomekitAdapter({
    browse: async () => network.filter((bridge) => bridge.alive).map((bridge) => bridge.advert()),
    retryMs: 100,
    maxRetryMs: 400,
    rediscoverMs: 0,
    ...options,
  })
  await adapter.init(context, {})
  return context
}

async function running(options?: Parameters<typeof hapBridge>[0]): Promise<TestBridge> {
  const bridge = await hapBridge(options)
  network.push(bridge)
  return bridge
}

/** The same house after a restart: what the adapter stored is all it has. */
function restarted(context: RecordingContext): RecordingContext {
  const next = recordingContext()
  for (const [key, value] of context.memory) next.memory.set(key, structuredClone(value))
  return next
}

const named = (context: RecordingContext, name: string) => {
  const device = context.discovered.findLast((entry) => entry.name === name)
  if (!device) throw new Error(`${name} was not announced: ${context.discovered.map((entry) => entry.name).join(', ')}`)
  return device
}

const wrote = (bridge: TestBridge, accessory: string, characteristic: string, value: unknown) =>
  bridge.wrote.some((entry) => entry.accessory === accessory && entry.characteristic === characteristic && JSON.stringify(entry.value) === JSON.stringify(value))

describe('before anything is paired', () => {
  test('it says how to add an accessory, and has nothing to show', scenario(async () => {
    await started()
    expect(adapter!.status()).toMatchObject({ health: 'needs_setup', deviceCount: 0, message: expect.stringMatching(/code/) })
    expect(await adapter!.discover([])).toEqual([])
  }))

  test('a code that is not one is refused before anything is sent', scenario(async () => {
    await started()
    expect(await adapter!.pair({})).toEqual({ ok: false, message: expect.stringMatching(/code/) })
    expect(await adapter!.pair({ pin: '1234' })).toEqual({ ok: false, message: expect.stringMatching(/8 chiffres/) })
    expect(await adapter!.pair({ pin: '123-45-678' })).toEqual({ ok: false, message: expect.stringMatching(/interdit/) })
  }))

  test('nothing waiting on the network, or only accessories another controller holds', scenario(async () => {
    await started({ browse: async () => [] })
    expect(await adapter!.pair({ pin: '031-45-154' })).toEqual({ ok: false, message: expect.stringMatching(/Aucun accessoire HomeKit/) })
    await adapter!.shutdown()
    const taken = { id: 'AA:00:00:00:00:01', name: 'Prise du bureau', host: '127.0.0.1', port: 1, paired: true, category: 7, configNumber: 1, setupHash: null, model: 'Prise' }
    await started({ browse: async () => [taken] })
    expect(await adapter!.pair({ pin: '031-45-154' })).toEqual({ ok: false, message: expect.stringMatching(/Prise du bureau.*déjà appairé/) })
  }))
})

describe('a bridge', () => {
  test('paired with its setup code, each accessory behind it is a device of its own, and obeys', scenario(async () => {
    const bridge = await running()
    const context = await started()
    const result = await adapter!.pair({ pin: bridge.code })
    // Read before any asymmetric matcher: Bun's toMatchObject writes them into what it checks
    // (oven-sh/bun#3521).
    expect(result.ok).toBe(true)
    expect(result.message).toBe(`"${bridge.name}" ajouté, avec 8 appareils derrière lui.`)
    expect(result.device?.nativeId).toBe(bridge.username)
    await eventually(() => bridge.txt.sf === '0')

    expect(named(context, bridge.name)).toMatchObject({
      adapterId: 'homekit',
      nativeId: bridge.username,
      uid: `homekit:${bridge.username}`,
      category: 'gateway',
      transport: 'wifi',
      manufacturer: 'Sway Test',
      model: 'Pont de test',
      firmwareVersion: '1.2.3',
      serialNumber: `bridge-${bridge.username}`,
      network: { ip: '127.0.0.1' },
    })
    const lamp = named(context, 'Lampe du salon')
    expect(lamp).toMatchObject({ category: 'light', capabilities: ['onoff', 'brightness', 'colorTemperature', 'color', 'identify'], model: 'Modèle Lampe du salon' })
    expect(lamp.nativeId).toMatch(new RegExp(`^${bridge.username}/\\d+$`))
    expect(lamp.uid).toBe(`homekit:${lamp.nativeId}`)
    const thermometer = named(context, 'Thermomètre du salon')
    expect(thermometer).toMatchObject({ category: 'sensor', capabilities: ['temperature', 'humidity', 'battery', 'identify'] })
    const door = named(context, "Porte d'entrée")
    expect(door).toMatchObject({ category: 'sensor', capabilities: ['contact', 'identify'] })
    const lock = named(context, 'Serrure')
    expect(lock).toMatchObject({ category: 'lock', capabilities: ['lock', 'identify'] })
    const shade = named(context, 'Store')
    expect(shade).toMatchObject({ category: 'cover', capabilities: ['position', 'identify'] })

    // Where each one stands, read at once.
    await eventually(() => context.stateOf(lamp.nativeId).brightness === 40)
    expect(context.stateOf(lamp.nativeId)).toMatchObject({ on: false, colorTemperature: 4000, hue: 0, saturation: 0 })
    expect(context.stateOf(thermometer.nativeId)).toMatchObject({ temperature: 21.5, humidity: 48, battery: 87, batteryLow: false })
    expect(context.stateOf(door.nativeId)).toMatchObject({ open: false })
    expect(context.stateOf(lock.nativeId)).toMatchObject({ locked: true, jammed: false })
    expect(context.stateOf(shade.nativeId)).toMatchObject({ position: 100, moving: 'idle' })
    expect(adapter!.status()).toMatchObject({ health: 'ok', deviceCount: 9 })

    // Commands, and what the accessories answer.
    expect(await adapter!.execute(lamp.nativeId, 'turnOn', {})).toMatchObject({ ok: true })
    await eventually(() => wrote(bridge, 'light', 'On', true))
    expect(context.stateOf(lamp.nativeId).on).toBe(true)
    expect(await adapter!.execute(lamp.nativeId, 'setBrightness', { brightness: 70 })).toMatchObject({ ok: true })
    await eventually(() => wrote(bridge, 'light', 'Brightness', 70))
    expect(context.stateOf(lamp.nativeId).brightness).toBe(70)
    expect(await adapter!.execute(lamp.nativeId, 'setColorName', { name: 'bleu' })).toMatchObject({ ok: true })
    await eventually(() => wrote(bridge, 'light', 'Hue', 220) && wrote(bridge, 'light', 'Saturation', 100))
    expect(context.stateOf(lamp.nativeId)).toMatchObject({ hue: 220, saturation: 100 })
    expect(await adapter!.execute(lock.nativeId, 'unlock', {})).toMatchObject({ ok: true })
    // The lock says it is open once it is, not when it is asked.
    await eventually(() => context.stateOf(lock.nativeId).locked === false)
    expect(await adapter!.execute(shade.nativeId, 'setPosition', { position: 30 })).toMatchObject({ ok: true })
    await eventually(() => context.stateOf(shade.nativeId).position === 30)
    expect(await adapter!.execute(lamp.nativeId, 'identify', {})).toMatchObject({ ok: true })

    // Changes made at the accessories reach the house.
    bridge.set('door', 'ContactSensor', 'ContactSensorState', 1)
    await eventually(() => context.stateOf(door.nativeId).open === true)
    expect(context.stateOf(door.nativeId).lastChangedAt).toEqual(expect.any(String))
    bridge.set('sensor', 'TemperatureSensor', 'CurrentTemperature', 22.5)
    await eventually(() => context.stateOf(thermometer.nativeId).temperature === 22.5)
    bridge.set('light', 'Lightbulb', 'On', false)
    await eventually(() => context.stateOf(lamp.nativeId).on === false)
    expect(await adapter!.getState(lamp.nativeId)).toMatchObject({ on: false, brightness: 70 })

    // What cannot be done is refused before anything is sent.
    expect(await adapter!.execute(door.nativeId, 'turnOn', {})).toMatchObject({ ok: false, error: expect.stringMatching(/turnOn/) })
    expect(await adapter!.execute('AA:AA:AA:AA:AA:AA', 'turnOn', {})).toMatchObject({ ok: false })
  }), 60_000)

  test('a press is an event, a ring is a ring, and each outlet of a strip answers on its own', scenario(async () => {
    const bridge = await running()
    const context = await started()
    expect((await adapter!.pair({ pin: bridge.code })).ok).toBe(true)
    const button = named(context, 'Bouton')
    const bell = named(context, 'Sonnette')
    const strip = named(context, 'Multiprise')
    expect(button).toMatchObject({ category: 'switch', capabilities: ['button', 'identify'] })
    expect(bell.capabilities).toContain('doorbell')

    bridge.set('button', 'StatelessProgrammableSwitch', 'ProgrammableSwitchEvent', 1)
    await eventually(() => context.events.some((event) => event.nativeId === button.nativeId))
    expect(context.events.filter((event) => event.nativeId === button.nativeId)).toEqual([{ nativeId: button.nativeId, event: 'button', payload: { action: 'double', buttonIndex: 0 } }])
    expect(context.stateOf(button.nativeId)).toMatchObject({ lastEvent: 'double', lastEventAt: expect.any(String), buttonIndex: 0 })

    bridge.set('bell', 'Doorbell', 'ProgrammableSwitchEvent', 0)
    await eventually(() => context.events.some((event) => event.nativeId === bell.nativeId && event.event === 'doorbell'))
    expect(context.stateOf(bell.nativeId).lastRingAt).toEqual(expect.any(String))

    expect(strip).toMatchObject({ category: 'outlet', capabilities: ['onoff', 'identify'] })
    expect(strip.endpoints?.map((endpoint) => endpoint.name)).toEqual(['Prise gauche', 'Prise droite'])
    const [left, right] = strip.endpoints!
    await eventually(() => context.stateOf(strip.nativeId, right!.index).on === true)
    expect(context.stateOf(strip.nativeId, left!.index).on).toBe(false)
    expect(await adapter!.execute(strip.nativeId, 'turnOn', {}, left!.index)).toMatchObject({ ok: true })
    await eventually(() => bridge.wrote.some((entry) => entry.accessory === 'strip' && entry.subtype === 'left' && entry.value === true))
    expect(context.stateOf(strip.nativeId, left!.index).on).toBe(true)
    expect(bridge.wrote.some((entry) => entry.accessory === 'strip' && entry.subtype === 'right')).toBe(false)
    bridge.set('strip', 'Outlet', 'On', false, 'right')
    await eventually(() => context.stateOf(strip.nativeId, right!.index).on === false)
    expect(await adapter!.execute(strip.nativeId, 'turnOn', {}, 999)).toMatchObject({ ok: false })
  }), 60_000)

  test('what cannot notify is read, and the change still reaches the house', scenario(async () => {
    const bridge = await running()
    const context = await started({ pollMs: 150 })
    expect((await adapter!.pair({ pin: bridge.code })).ok).toBe(true)
    const thermometer = named(context, 'Thermomètre du salon')
    await eventually(() => context.stateOf(thermometer.nativeId).humidity === 48)
    bridge.set('sensor', 'HumiditySensor', 'CurrentRelativeHumidity', 61)
    await eventually(() => context.stateOf(thermometer.nativeId).humidity === 61)
  }), 60_000)

  test('an accessory added to the bridge later appears, and obeys', scenario(async () => {
    const bridge = await running()
    const context = await started({ checkMs: 100 })
    expect((await adapter!.pair({ pin: bridge.code })).ok).toBe(true)
    await bridge.add('office', 'Lampe du bureau')
    const office = await eventually(() => context.discovered.find((device) => device.name === 'Lampe du bureau'), 10_000)
    expect(office).toMatchObject({ category: 'light', capabilities: ['onoff', 'identify'] })
    await eventually(() => context.stateOf(office.nativeId).on === false)
    expect(await adapter!.execute(office.nativeId, 'turnOn', {})).toMatchObject({ ok: true })
    await eventually(() => wrote(bridge, 'office', 'On', true))
    bridge.set('office', 'Lightbulb', 'On', false)
    await eventually(() => context.stateOf(office.nativeId).on === false)
  }), 60_000)
})

describe('pairing among several accessories', () => {
  test('found on the network by mDNS, nothing stood in for', scenario(async () => {
    // The bridge's own advertisement, heard by the hub's mDNS browser: its QR code names it
    // among whatever else waits on this network.
    const bridge = await running()
    const context = await started({ browse: undefined, browseMs: 3000 })
    const result = await adapter!.pair({ pin: bridge.setupURI })
    expect(result.ok).toBe(true)
    expect(result.device?.nativeId).toBe(bridge.username)
    named(context, 'Lampe du salon')
  }), 60_000)

  test('with the text of its QR code, the one it names is paired, not its neighbour', scenario(async () => {
    const first = await running()
    const second = await running({ code: '482-19-736' })
    await started()
    const result = await adapter!.pair({ pin: second.setupURI })
    expect(result).toMatchObject({ ok: true, device: { nativeId: second.username } })
    await eventually(() => second.txt.sf === '0')
    expect(first.txt.sf).toBe('1')
  }), 60_000)

  test('with its 8 digits typed, the one that accepts them is paired', scenario(async () => {
    const first = await running()
    const second = await running({ code: '482-19-736' })
    await started()
    const result = await adapter!.pair({ pin: '48219736' })
    expect(result).toMatchObject({ ok: true, device: { nativeId: second.username } })
    expect(first.txt.sf).toBe('1')
  }), 60_000)

  test('a wrong code is refused, and the right one still works after it', scenario(async () => {
    const bridge = await running()
    const context = await started()
    expect(await adapter!.pair({ pin: '111-22-333' })).toEqual({ ok: false, message: expect.stringMatching(/refuse ce code/) })
    expect(await adapter!.discover([])).toEqual([])
    expect(bridge.txt.sf).toBe('1')
    expect((await adapter!.pair({ pin: bridge.code })).ok).toBe(true)
    named(context, bridge.name)
  }), 60_000)

  test('an accessory another controller already holds, given by its address, says so', scenario(async () => {
    const bridge = await running()
    await started()
    expect((await adapter!.pair({ pin: bridge.code })).ok).toBe(true)
    await adapter!.shutdown()
    await started({ browse: async () => [] })
    expect(await adapter!.pair({ pin: bridge.code, address: `127.0.0.1:${bridge.port}` })).toEqual({ ok: false, message: expect.stringMatching(/déjà appairé/) })
  }), 60_000)
})

describe('staying with it', () => {
  test('after a restart the hub finds it again by itself, without its code', scenario(async () => {
    const bridge = await running()
    const first = await started({ browse: async () => [] })
    expect((await adapter!.pair({ pin: bridge.code, address: `127.0.0.1:${bridge.port}` })).ok).toBe(true)
    await adapter!.shutdown()

    const context = await started({ browse: async () => [] }, restarted(first))
    const lamp = await eventually(() => context.discovered.find((device) => device.name === 'Lampe du salon'), 10_000)
    await eventually(() => context.stateOf(lamp.nativeId).brightness === 40, 10_000)
    expect(await adapter!.execute(lamp.nativeId, 'turnOn', {})).toMatchObject({ ok: true })
    await eventually(() => wrote(bridge, 'light', 'On', true))
    expect(adapter!.status()).toMatchObject({ health: 'ok', deviceCount: 9 })
  }), 60_000)

  test('a bridge that goes away is offline, and back when it returns, even at a new address', scenario(async () => {
    const bridge = await running()
    const context = await started()
    expect((await adapter!.pair({ pin: bridge.code })).ok).toBe(true)
    const lamp = named(context, 'Lampe du salon')
    const door = named(context, "Porte d'entrée")

    await bridge.stop()
    await eventually(() => context.availability.findLast((entry) => entry.nativeId === lamp.nativeId)?.online === false, 5_000)
    expect(context.availability.findLast((entry) => entry.nativeId === bridge.username)?.online).toBe(false)
    expect(adapter!.status()).toMatchObject({ health: 'degraded', message: expect.stringMatching(/Hors ligne/) })
    expect(await adapter!.execute(lamp.nativeId, 'turnOn', {})).toMatchObject({ ok: false, error: expect.stringMatching(/hors ligne/) })

    const back = await running({ username: bridge.username, dir: bridge.dir, code: bridge.code })
    expect(back.port).not.toBe(bridge.port)
    await eventually(() => context.availability.findLast((entry) => entry.nativeId === lamp.nativeId)?.online === true, 10_000)
    expect(adapter!.status()).toMatchObject({ health: 'ok' })
    back.set('door', 'ContactSensor', 'ContactSensorState', 1)
    await eventually(() => context.stateOf(door.nativeId).open === true)
    expect(await adapter!.execute(lamp.nativeId, 'turnOn', {})).toMatchObject({ ok: true })
    await eventually(() => wrote(back, 'light', 'On', true))
  }), 60_000)

  test('an accessory reset no longer knows the hub: it is said, and its code pairs it again', scenario(async () => {
    const bridge = await running()
    const context = await started()
    expect((await adapter!.pair({ pin: bridge.code })).ok).toBe(true)
    await bridge.stop()
    // Reset: the same device id, but a new identity and no pairing.
    const reset = await running({ username: bridge.username, code: bridge.code })
    await eventually(() => /ne reconnaît plus le hub/.test(adapter!.status().message ?? ''), 10_000)
    expect(adapter!.status().health).toBe('degraded')

    expect((await adapter!.pair({ pin: reset.code })).ok).toBe(true)
    await eventually(() => adapter!.status().health === 'ok', 10_000)
    const lamp = named(context, 'Lampe du salon')
    expect(await adapter!.execute(lamp.nativeId, 'turnOn', {})).toMatchObject({ ok: true })
    await eventually(() => wrote(reset, 'light', 'On', true))
  }), 60_000)
})

describe('letting go', () => {
  test('a device behind the bridge is hidden; the bridge itself is unpaired and free again', scenario(async () => {
    const bridge = await running()
    const context = await started()
    expect((await adapter!.pair({ pin: bridge.code })).ok).toBe(true)
    const door = named(context, "Porte d'entrée")
    expect(await adapter!.forget(door.nativeId)).toEqual({ ok: true, message: expect.stringMatching(/reste sur le pont/) })
    expect((await adapter!.discover([])).map((device) => device.nativeId)).not.toContain(door.nativeId)
    expect(adapter!.status().deviceCount).toBe(8)

    // Still hidden after a restart, and nothing it says reaches the house.
    await adapter!.shutdown()
    const again = await started({}, restarted(context))
    await eventually(() => again.discovered.some((device) => device.name === 'Lampe du salon'), 10_000)
    expect(again.discovered.some((device) => device.nativeId === door.nativeId)).toBe(false)
    bridge.set('door', 'ContactSensor', 'ContactSensorState', 1)
    bridge.set('light', 'Lightbulb', 'On', true)
    await eventually(() => again.stateOf(named(again, 'Lampe du salon').nativeId).on === true)
    expect(again.states.some((entry) => entry.nativeId === door.nativeId)).toBe(false)

    expect(await adapter!.forget(bridge.username)).toEqual({ ok: true, message: expect.stringMatching(/quitté le hub/) })
    await eventually(() => bridge.txt.sf === '1')
    expect(await adapter!.discover([])).toEqual([])
    expect(adapter!.status().health).toBe('needs_setup')
    // Free for a controller again: this one, for instance.
    expect((await adapter!.pair({ pin: bridge.code })).ok).toBe(true)
  }), 60_000)

  test('an accessory that cannot be reached is let go of all the same', scenario(async () => {
    const bridge = await running()
    const context = await started()
    expect((await adapter!.pair({ pin: bridge.code })).ok).toBe(true)
    await bridge.stop()
    await eventually(() => context.availability.findLast((entry) => entry.nativeId === bridge.username)?.online === false, 5_000)
    expect(await adapter!.forget(bridge.username)).toEqual({ ok: true, message: expect.stringMatching(/injoignable/) })
    expect(await adapter!.discover([])).toEqual([])
    expect(adapter!.status().health).toBe('needs_setup')
  }), 60_000)
})

describe('secrets', () => {
  test('the keys stay in the adapter store and nowhere else', scenario(async () => {
    const bridge = await running()
    const context = await started()
    expect((await adapter!.pair({ pin: bridge.code })).ok).toBe(true)
    const controller = context.memory.get('controller') as { privateKey: string }
    const pairings = context.memory.get('pairings') as { key: string }[]
    expect(controller.privateKey).toMatch(/^[0-9a-f]{64}$/)
    expect(pairings[0]!.key).toMatch(/^[0-9a-f]{64}$/)
    // Nor is the setup code kept: it is never needed again.
    expect(JSON.stringify([...context.memory.values()])).not.toContain(bridge.code)

    const visible = JSON.stringify([context.discovered, context.states, context.events, context.logs, adapter!.status(), await adapter!.discover([])])
    const privateKey = Buffer.from(controller.privateKey, 'hex')
    for (const secret of [controller.privateKey, privateKey.toString('base64'), privateKey.toString('base64url'), pairings[0]!.key]) {
      expect(visible).not.toContain(secret)
    }
  }), 60_000)
})
