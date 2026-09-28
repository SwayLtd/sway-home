/**
 * The Matter adapter against real Matter devices.
 *
 * The devices are matter.js device nodes served over UDP on this machine (see
 * fixtures/matter_devices.ts): the adapter finds them by mDNS or by address, commissions them
 * with their pairing code into the hub's own fabric, subscribes to them and commands them,
 * exactly as it would a bulb on the network. Nothing is mocked below the adapter.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatterAdapter, type MatterOptions } from '#adapters/matter'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'
import { appliances, bridge, colorLight, held, press, type TestDevice } from './fixtures/matter_devices.ts'

const running: TestDevice[] = []
let adapter: MatterAdapter | null = null

afterEach(async () => {
  await adapter?.shutdown()
  adapter = null
})

afterAll(async () => {
  for (const device of running) await device.close().catch(() => undefined)
})

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'sway-matter-hub-'))
}

async function started(dir = scratch(), options: MatterOptions = {}): Promise<RecordingContext> {
  adapter = new MatterAdapter({ storagePath: join(dir, 'matter.sqlite'), dataDir: dir, controllerId: `hub-${dir.slice(-6)}`, ...options })
  const context = recordingContext()
  await adapter.init(context, {})
  return context
}

const named = (context: RecordingContext, name: string) => {
  const device = context.discovered.findLast((entry) => entry.name === name)
  if (!device) throw new Error(`${name} was not announced: ${context.discovered.map((entry) => entry.name).join(', ')}`)
  return device
}

describe('before anything is paired', () => {
  test('it says how to add a device, and has nothing to show', async () => {
    await started()
    expect(adapter!.status()).toMatchObject({ health: 'needs_setup', deviceCount: 0, message: expect.stringMatching(/code/) })
    expect(await adapter!.discover([])).toEqual([])
  })

  test('a code that is not one is refused before anything starts', async () => {
    await started()
    expect(await adapter!.pair({ code: '1234' })).toEqual({ ok: false, message: expect.stringMatching(/11 ou 21 chiffres/) })
    expect(await adapter!.pair({})).toEqual({ ok: false, message: expect.stringMatching(/code/) })
  })
})

describe('a colour light', () => {
  test('paired with its 11-digit code, found on the network, it appears and obeys', async () => {
    const lamp = await colorLight('Lampe du salon')
    running.push(lamp)
    const context = await started()
    const result = await adapter!.pair({ code: lamp.manualCode })
    expect(result).toMatchObject({ ok: true, message: expect.stringMatching(/Lampe du salon/) })

    const device = named(context, 'Lampe du salon')
    expect(device).toMatchObject({
      adapterId: 'matter',
      uid: `matter:unique-${lamp.port}`,
      category: 'light',
      capabilities: ['onoff', 'brightness', 'colorTemperature', 'color', 'identify'],
      transport: 'matter',
      manufacturer: 'Sway Test',
      model: 'Lampe du salon (modèle)',
      serialNumber: `sn-${lamp.port}`,
    })
    expect(result.device?.nativeId).toBe(device.nativeId)
    await eventually(() => context.stateOf(device.nativeId).brightness === 39)
    expect(context.stateOf(device.nativeId)).toMatchObject({ on: false, colorTemperature: 4000, colorTemperatureRange: [2000, 6536] })
    expect(adapter!.status()).toMatchObject({ health: 'ok', deviceCount: 1 })

    expect(await adapter!.execute(device.nativeId, 'turnOn', {})).toMatchObject({ ok: true })
    await eventually(() => held(lamp.light, 'onOff').onOff === true)
    await eventually(() => context.stateOf(device.nativeId).on === true)
    expect(await adapter!.execute(device.nativeId, 'setBrightness', { brightness: 50 })).toMatchObject({ ok: true })
    await eventually(() => context.stateOf(device.nativeId).brightness === 50)
    expect(await adapter!.execute(device.nativeId, 'setColorTemperature', { kelvin: 2700 })).toMatchObject({ ok: true })
    await eventually(() => context.stateOf(device.nativeId).colorTemperature === 2703)
    expect(await adapter!.execute(device.nativeId, 'setColorName', { name: 'bleu' })).toMatchObject({ ok: true })
    // Matter counts hue in 254 steps: 220 degrees comes back within a degree or two.
    await eventually(() => Math.abs(Number(context.stateOf(device.nativeId).hue) - 220) <= 2)

    // Switched off at the lamp itself: the house hears it.
    await lamp.light.set({ onOff: { onOff: false } } as never)
    await eventually(() => context.stateOf(device.nativeId).on === false)
    expect(await adapter!.getState(device.nativeId)).toMatchObject({ on: false, brightness: 50 })

    expect(await adapter!.execute(device.nativeId, 'lock', {})).toMatchObject({ ok: false, error: expect.stringMatching(/lock/) })
    expect(await adapter!.execute('404', 'turnOn', {})).toMatchObject({ ok: false })
  }, 60_000)
})

describe('a bridge', () => {
  test('each device behind it is a device of its own, named as the bridge names it', async () => {
    const zigbee = await bridge('Pont Zigbee')
    running.push(zigbee)
    const context = await started()
    const result = await adapter!.pair({ code: zigbee.qrCode, address: `127.0.0.1:${zigbee.port}` })
    expect(result.ok).toBe(true)

    const gateway = named(context, 'Pont Zigbee')
    const door = named(context, "Porte d'entrée")
    const salon = named(context, 'Salon')
    expect(gateway).toMatchObject({ category: 'gateway', uid: `matter:unique-${zigbee.port}` })
    expect(door).toMatchObject({ category: 'sensor', uid: 'matter:door-Pont Zigbee', manufacturer: 'Sway Test' })
    expect(door.capabilities).toContain('contact')
    expect(salon.capabilities).toContain('temperature')
    expect(new Set([gateway.nativeId, door.nativeId, salon.nativeId]).size).toBe(3)
    await eventually(() => context.stateOf(door.nativeId).open === false && context.stateOf(salon.nativeId).temperature === 21.5)

    await zigbee.door.set({ booleanState: { stateValue: false } } as never)
    await eventually(() => context.stateOf(door.nativeId).open === true)
    expect(typeof context.stateOf(door.nativeId).lastChangedAt).toBe('string')
    await zigbee.temperature.set({ temperatureMeasurement: { measuredValue: 1990 } } as never)
    await eventually(() => context.stateOf(salon.nativeId).temperature === 19.9)
    expect((await adapter!.discover([])).map((device) => device.name).sort()).toEqual(["Pont Zigbee", "Porte d'entrée", 'Salon'])
  }, 60_000)
})

describe('a node with several things in it', () => {
  test('one device, one endpoint per thing, each commanded where it is', async () => {
    const house = await appliances('Entrée')
    running.push(house)
    const context = await started()
    expect((await adapter!.pair({ code: house.manualCode, address: `127.0.0.1:${house.port}` })).ok).toBe(true)
    const device = named(context, 'Entrée')
    expect(device.category).toBe('climate')
    expect(device.capabilities).toEqual(expect.arrayContaining(['thermostat', 'position', 'lock', 'button']))
    expect(device.endpoints?.map((endpoint) => [endpoint.index, endpoint.category])).toEqual([
      [1, 'climate'],
      [2, 'cover'],
      [3, 'lock'],
      [4, 'switch'],
    ])
    await eventually(() => context.stateOf(device.nativeId, 1).targetTemperature === 20)
    expect(context.stateOf(device.nativeId)).toMatchObject({ currentTemperature: 21, hvacMode: 'heat' })
    expect(context.stateOf(device.nativeId, 3)).toMatchObject({ locked: true })

    // No endpoint named: the one that can do it.
    expect(await adapter!.execute(device.nativeId, 'setTargetTemperature', { celsius: 21.5 })).toMatchObject({ ok: true })
    await eventually(() => held(house.thermostat, 'thermostat').occupiedHeatingSetpoint === 2150)
    expect(await adapter!.execute(device.nativeId, 'setPosition', { position: 30 })).toMatchObject({ ok: true })
    await eventually(() => context.stateOf(device.nativeId, 2).position === 30)
    expect(await adapter!.execute(device.nativeId, 'unlock', {}, 3)).toMatchObject({ ok: true })
    await eventually(() => context.stateOf(device.nativeId, 3).locked === false)
    await eventually(() => context.stateOf(device.nativeId, 3).lastActor === 'remote')

    // A double press is one double press, not three presses.
    await press(house.button, 2)
    await eventually(() => context.events.some((event) => event.event === 'button'), 5000)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(context.events.filter((event) => event.event === 'button').map((event) => event.payload)).toEqual([{ action: 'double', buttonIndex: 0 }])
    expect(context.stateOf(device.nativeId, 4)).toMatchObject({ lastEvent: 'double', buttonIndex: 0 })
  }, 60_000)
})

describe('letting go', () => {
  test("a device the house forgets leaves the hub's fabric, and does not come back", async () => {
    const lamp = await colorLight('Lampe du grenier')
    running.push(lamp)
    const dir = scratch()
    const context = await started(dir)
    expect((await adapter!.pair({ code: lamp.manualCode, address: `127.0.0.1:${lamp.port}` })).ok).toBe(true)
    const nativeId = named(context, 'Lampe du grenier').nativeId
    const fabrics = () => (held(lamp.node as never, 'operationalCredentials').fabrics as unknown[]).length
    expect(fabrics()).toBe(1)

    expect(await adapter!.forget(nativeId)).toMatchObject({ ok: true, message: expect.stringMatching(/Lampe du grenier/) })
    await eventually(() => fabrics() === 0)
    expect(await adapter!.discover([])).toEqual([])
    expect(adapter!.status()).toMatchObject({ health: 'needs_setup' })
    await adapter!.shutdown()

    const again = await started(dir)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(again.discovered).toEqual([])
    expect(await adapter!.discover([])).toEqual([])
  }, 60_000)

  test('a device behind a bridge stays hidden once forgotten', async () => {
    const zigbee = await bridge('Pont du garage')
    running.push(zigbee)
    const dir = scratch()
    const context = await started(dir)
    expect((await adapter!.pair({ code: zigbee.qrCode, address: `127.0.0.1:${zigbee.port}` })).ok).toBe(true)
    const door = named(context, "Porte d'entrée")
    expect(await adapter!.forget(door.nativeId)).toMatchObject({ ok: true })
    expect((await adapter!.discover([])).map((device) => device.name).sort()).toEqual(['Pont du garage', 'Salon'])
    await adapter!.shutdown()

    const again = await started(dir)
    await eventually(() => again.discovered.some((device) => device.name === 'Salon'))
    expect(again.discovered.map((device) => device.name)).not.toContain("Porte d'entrée")
  }, 60_000)
})

describe('trouble', () => {
  test('a wrong code is said, and nothing is added', async () => {
    const lamp = await colorLight('Lampe du couloir')
    running.push(lamp)
    const context = await started()
    const { ManualPairingCodeCodec } = await import('@matter/main/types')
    const wrong = ManualPairingCodeCodec.encode({ discriminator: lamp.discriminator, passcode: lamp.passcode + 1 })
    const result = await adapter!.pair({ code: wrong, address: `127.0.0.1:${lamp.port}` })
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/code/) })
    expect(context.discovered).toEqual([])
  }, 60_000)

  test('after a restart, paired devices come back without their code', async () => {
    const lamp = await colorLight('Lampe de la cuisine')
    running.push(lamp)
    const dir = scratch()
    const first = await started(dir)
    expect((await adapter!.pair({ code: lamp.qrCode, address: `127.0.0.1:${lamp.port}` })).ok).toBe(true)
    const nativeId = named(first, 'Lampe de la cuisine').nativeId
    await adapter!.shutdown()

    const second = await started(dir)
    await eventually(() => second.discovered.some((device) => device.nativeId === nativeId))
    expect((await adapter!.discover([])).map((device) => device.nativeId)).toEqual([nativeId])
    expect(await adapter!.execute(nativeId, 'turnOn', {})).toMatchObject({ ok: true })
    await eventually(() => held(lamp.light, 'onOff').onOff === true)
  }, 60_000)

  test('a device that goes away is offline, and back when it returns', async () => {
    const lamp = await colorLight('Lampe de la chambre')
    // A short subscription, so the silence is noticed in seconds rather than minutes.
    const context = await started(scratch(), { subscriptionCeilingSeconds: 2, offlineAfterMs: 1000, retryMs: 1000 })
    expect((await adapter!.pair({ code: lamp.manualCode, address: `127.0.0.1:${lamp.port}` })).ok).toBe(true)
    const nativeId = named(context, 'Lampe de la chambre').nativeId
    await lamp.close()
    await eventually(() => context.availability.some((entry) => entry.nativeId === nativeId && !entry.online), 20_000)
    expect(adapter!.status()).toMatchObject({ health: 'degraded', message: expect.stringMatching(/Lampe de la chambre/) })
    expect(await adapter!.execute(nativeId, 'turnOn', {})).toMatchObject({ ok: false, error: expect.stringMatching(/hors ligne/) })

    // Plugged back in: it is still in the hub's fabric, and the hub finds it again.
    const back = await lamp.revive()
    running.push(back)
    await eventually(() => context.availability.at(-1)?.online === true, 20_000)
    expect(adapter!.status().health).toBe('ok')
    expect(await adapter!.execute(nativeId, 'turnOn', {})).toMatchObject({ ok: true })
  }, 60_000)
})
