/**
 * The Bluetooth LE adapter, with the radio played by the test.
 *
 * Passive sensors are not paired: a thermometer appears the first time it is heard, with the
 * capabilities its readings show. Encrypted ones wait for their key. Beacons named in the
 * settings stand for people. The advertisements used are real ones (the codec's vectors, and
 * captures from the Windows scanner).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { BleAdapter, type BleOptions } from '#adapters/ble'
import { parseScannerLine, type Advert, type Values } from '#adapters/ble_codec'
import type { AdvertSource } from '#adapters/ble_sources'
import { eventually, recordingContext, type RecordingContext } from './adapter_harness.ts'

class FakeRadio implements AdvertSource {
  readonly name = 'radio de test'
  started = 0
  stopped = 0
  available = true
  /** A radio slow to come up (the Windows scanner compiles itself the first time). */
  startDelayMs = 0
  #onAdvert: ((advert: Advert, decoded?: Values | null) => void) | null = null
  #onProblem: ((problem: string | null) => void) | null = null

  async start(
    onAdvert: (advert: Advert, decoded?: Values | null) => void,
    onProblem: (problem: string | null) => void
  ): Promise<boolean> {
    this.started += 1
    this.#onAdvert = onAdvert
    this.#onProblem = onProblem
    if (this.startDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.startDelayMs))
    if (!this.available) onProblem('le Bluetooth de cette machine est éteint ou absent')
    return this.available
  }

  async stop(): Promise<void> {
    this.stopped += 1
    this.#onAdvert = null
  }

  hear(line: string): void {
    this.#onAdvert?.(parseScannerLine(line)!)
  }

  relay(advert: Advert, decoded: Values): void {
    this.#onAdvert?.(advert, decoded)
  }

  problem(text: string | null): void {
    this.#onProblem?.(text)
  }
}

const bthome = (address: string, hex: string) =>
  `{"address":"${address.replace(/:/g, '').toLowerCase()}","rssi":-70,"sections":["0106","16d2fc${hex}","0953424d542d313030"]}`
/** The same sensor when its name travels apart, in the scan response. */
const unnamed = (address: string, hex: string) =>
  `{"address":"${address.replace(/:/g, '').toLowerCase()}","rssi":-70,"sections":["0106","16d2fc${hex}"]}`
const scanResponse = (address: string) =>
  `{"address":"${address.replace(/:/g, '').toLowerCase()}","rssi":-70,"sections":["0953424d542d313030"]}`

let adapter: BleAdapter | null = null
let radio: FakeRadio | null = null

afterEach(async () => {
  await adapter?.shutdown()
  adapter = null
  radio = null
})

async function listening(
  config: Record<string, unknown> = {},
  extra: BleOptions = {}
): Promise<RecordingContext> {
  radio = new FakeRadio()
  adapter = new BleAdapter({ sources: [radio], checkMs: 20, ...extra })
  const context = recordingContext()
  await adapter.init(context, config)
  return context
}

describe('sensors that pair with nobody', () => {
  test('a thermometer appears the first time it is heard, with what it measures', async () => {
    const context = await listening()
    radio!.hear(bthome('A4:C1:38:00:00:01', '4002ca0903bf13'))
    expect(context.discovered).toHaveLength(1)
    expect(context.discovered[0]).toMatchObject({
      adapterId: 'ble',
      nativeId: 'A4:C1:38:00:00:01',
      uid: 'ble:A4:C1:38:00:00:01',
      name: 'SBMT-100 0001',
      category: 'sensor',
      capabilities: ['temperature', 'humidity'],
      transport: 'ble',
      manufacturer: 'BTHome',
      network: { mac: 'A4:C1:38:00:00:01' },
    })
    expect(context.stateOf('A4:C1:38:00:00:01')).toMatchObject({
      temperature: 25.06,
      humidity: 50.55,
    })
    radio!.hear(bthome('A4:C1:38:00:00:01', '4002d20903c813'))
    expect(context.stateOf('A4:C1:38:00:00:01')).toMatchObject({
      temperature: 25.14,
      humidity: 50.64,
    })
    expect(context.discovered).toHaveLength(1)
    radio!.hear(bthome('A4:C1:38:00:00:01', '40015a02d20903c813'))
    expect(context.discovered).toHaveLength(2)
    expect(context.discovered[1]!.capabilities).toEqual(['temperature', 'humidity', 'battery'])
    expect(await adapter!.getState('A4:C1:38:00:00:01')).toMatchObject({
      battery: 90,
      temperature: 25.14,
    })
    expect((await adapter!.discover([])).map((device) => device.nativeId)).toEqual([
      'A4:C1:38:00:00:01',
    ])
  })

  test('a button press counts once, however often the advertisement is repeated', async () => {
    const context = await listening()
    for (let copy = 0; copy < 3; copy++) radio!.hear(bthome('A4:C1:38:00:00:02', '44000c3a01'))
    expect(context.events.filter((event) => event.event === 'button')).toEqual([
      {
        nativeId: 'A4:C1:38:00:00:02',
        event: 'button',
        payload: { action: 'single', buttonIndex: 0 },
      },
    ])
    radio!.hear(bthome('A4:C1:38:00:00:02', '44000d3a02'))
    expect(context.events.filter((event) => event.event === 'button')).toHaveLength(2)
    expect(context.stateOf('A4:C1:38:00:00:02')).toMatchObject({
      lastEvent: 'double',
      buttonIndex: 0,
    })
  })

  test('a door opening is dated', async () => {
    const context = await listening()
    radio!.hear(bthome('A4:C1:38:00:00:03', '44000e2d00'))
    radio!.hear(bthome('A4:C1:38:00:00:03', '44000f2d01'))
    expect(context.stateOf('A4:C1:38:00:00:03')).toMatchObject({ open: true })
    expect(typeof context.stateOf('A4:C1:38:00:00:03').lastChangedAt).toBe('string')
  })

  test('an encrypted sensor a gateway decoded with its own key is read', async () => {
    const context = await listening()
    const advert = parseScannerLine(
      '{"address":"5448e68f80a5","rssi":-70,"sections":["16d2fc41e445f3c9962b332211006c7c4519"]}'
    )!
    advert.name = 'SBMT-100'
    radio!.relay(advert, { temperature: 25.06, humidity: 50.55 })
    expect(context.discovered[0]!.requiresPairing ?? null).toBeNull()
    expect(context.stateOf('54:48:E6:8F:80:A5')).toMatchObject({ temperature: 25.06 })
  })

  test('readings a gateway decoded itself are readings', async () => {
    const context = await listening()
    const advert: Advert = {
      address: 'A4:C1:38:DD:DB:F8',
      rssi: -80,
      name: 'GVH5075_DBF8',
      manufacturer: new Map(),
      serviceData: new Map(),
      serviceUuids: [],
    }
    radio!.relay(advert, { temperature: 21.6, humidity: 49.8, battery: 100 })
    expect(context.discovered[0]).toMatchObject({
      nativeId: 'A4:C1:38:DD:DB:F8',
      name: 'GVH5075_DBF8',
      capabilities: ['temperature', 'humidity', 'battery'],
    })
    expect(context.stateOf('A4:C1:38:DD:DB:F8')).toMatchObject({ temperature: 21.6 })
  })

  test('a name sent apart, in the scan response, still names the sensor', async () => {
    const context = await listening({}, { nameWaitMs: 5000 })
    radio!.hear(unnamed('A4:C1:38:00:00:07', '4002ca09'))
    expect(context.discovered).toEqual([])
    radio!.hear(scanResponse('A4:C1:38:00:00:07'))
    expect(context.discovered).toHaveLength(1)
    expect(context.discovered[0]).toMatchObject({
      name: 'SBMT-100 0007',
      capabilities: ['temperature'],
    })
    expect(context.stateOf('A4:C1:38:00:00:07')).toMatchObject({ temperature: 25.06 })
  })

  test('a name heard first is kept for the sensor', async () => {
    const context = await listening({}, { nameWaitMs: 5000 })
    radio!.hear(scanResponse('A4:C1:38:00:00:0A'))
    radio!.hear(unnamed('A4:C1:38:00:00:0A', '4002ca09'))
    expect(context.discovered[0]).toMatchObject({ name: 'SBMT-100 000A' })
  })

  test('a sensor that never says its name is named after what it is, a moment later', async () => {
    const context = await listening({}, { nameWaitMs: 60 })
    radio!.hear(unnamed('A4:C1:38:00:00:08', '4002ca09'))
    expect(context.discovered).toEqual([])
    await eventually(() => context.discovered.length === 1)
    expect(context.discovered[0]!.name).toBe('Capteur BTHome 0008')
    expect(context.stateOf('A4:C1:38:00:00:08')).toMatchObject({ temperature: 25.06 })
  })

  test('the rest of the air creates nothing', async () => {
    const context = await listening()
    radio!.hear('{"address":"ffac1ada9dad","rssi":-86,"sections":["ff4c0012020000"]}')
    radio!.hear(
      '{"address":"d80f99319252","rssi":-68,"sections":["ff4c00021550765cb7d9ea4e2199a4fa879613a49281d9f5ebce"]}'
    )
    expect(context.discovered).toEqual([])
    expect(await adapter!.discover([])).toEqual([])
  })

  test('a thermometer silent for too long is offline, and back when heard; a button never is', async () => {
    const context = await listening({}, { staleMs: 120 })
    radio!.hear(bthome('A4:C1:38:00:00:04', '4002ca09'))
    radio!.hear(bthome('A4:C1:38:00:00:05', '44000c3a01'))
    await eventually(() =>
      context.availability.some((entry) => entry.nativeId === 'A4:C1:38:00:00:04' && !entry.online)
    )
    radio!.hear(bthome('A4:C1:38:00:00:04', '4002cb09'))
    expect(context.availability.at(-1)).toEqual({ nativeId: 'A4:C1:38:00:00:04', online: true })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(
      context.availability.some((entry) => entry.nativeId === 'A4:C1:38:00:00:05' && !entry.online)
    ).toBe(false)
  })
})

describe('encrypted sensors', () => {
  const ENCRYPTED = bthome('54:48:E6:8F:80:A5', '41e445f3c9962b332211006c7c4519')

  test('without its key it is listed, waiting for it; the key is never repeated', async () => {
    const context = await listening()
    radio!.hear(ENCRYPTED)
    expect(context.discovered[0]).toMatchObject({
      nativeId: '54:48:E6:8F:80:A5',
      requiresPairing: { kind: 'code' },
    })
    expect(context.discovered[0]!.requiresPairing!.instructions).toMatch(/54:48:E6:8F:80:A5 = /)
    expect(context.stateOf('54:48:E6:8F:80:A5')).toEqual({})
    radio!.hear(ENCRYPTED)
    expect(context.discovered).toHaveLength(1)
  })

  test('with its key, it reads; with a wrong one, it says so', async () => {
    const context = await listening({
      bindkeys: '54:48:E6:8F:80:A5 = 231d39c1d7cc1ab1aee224cd096db932',
    })
    radio!.hear(ENCRYPTED)
    expect(context.stateOf('54:48:E6:8F:80:A5')).toMatchObject({
      temperature: 25.06,
      humidity: 50.55,
    })
    expect(context.discovered[0]!.requiresPairing ?? null).toBeNull()
    await adapter!.shutdown()
    const wrong = await listening({
      bindkeys: '54:48:E6:8F:80:A5 = 00000000000000000000000000000000',
    })
    radio!.hear(ENCRYPTED)
    expect(adapter!.status().health).toBe('degraded')
    expect(adapter!.status().message).toMatch(/54:48:E6:8F:80:A5/)
    expect(JSON.stringify([wrong.logs, adapter!.status()])).not.toContain(
      '00000000000000000000000000000000'
    )
  })

  test('mistakes in the keys are said by line, without the keys', async () => {
    await listening({ bindkeys: 'A4:C1:38:02:83:F4 = 0123abcd' })
    expect(adapter!.status().health).toBe('degraded')
    expect(adapter!.status().message).toMatch(/ligne 1/)
    expect(adapter!.status().message).not.toContain('0123abcd')
  })
})

describe('beacons that stand for people', () => {
  const PHONE =
    '{"address":"d80f99319252","rssi":-68,"sections":["ff4c00021550765cb7d9ea4e2199a4fa879613a49281d9f5ebce"]}'
  const KEYS =
    '{"address":"ec9a34897f2d","rssi":-81,"sections":["0106","07144170a0b86dedab0c538e66a42433c2"]}'

  test('listed from the settings, home while heard, away after a while', async () => {
    const context = await listening(
      {
        beacons:
          'Téléphone de Camille = 50765cb7-d9ea-4e21-99a4-fa879613a492:33241\nClés de Sam = EC:9A:34:89:7F:2D',
      },
      { awayMs: 150 }
    )
    const devices = await adapter!.discover([])
    expect(
      devices.map((device) => [device.nativeId, device.name, device.category, device.capabilities])
    ).toEqual([
      ['beacon:telephone-de-camille', 'Téléphone de Camille', 'phone', ['presence']],
      ['beacon:cles-de-sam', 'Clés de Sam', 'phone', ['presence']],
    ])
    radio!.hear(PHONE)
    expect(context.stateOf('beacon:telephone-de-camille')).toMatchObject({
      home: true,
      source: 'bluetooth',
      rssi: -68,
    })
    radio!.hear(KEYS)
    expect(context.stateOf('beacon:cles-de-sam')).toMatchObject({ home: true })
    await eventually(() => context.stateOf('beacon:telephone-de-camille').home === false)
  })
})

describe('the radio', () => {
  test('a radio slow to come up does not hold the hub back', async () => {
    radio = new FakeRadio()
    radio.startDelayMs = 400
    adapter = new BleAdapter({ sources: [radio], startWaitMs: 50 })
    const began = Date.now()
    await adapter.init(recordingContext(), {})
    expect(Date.now() - began).toBeLessThan(300)
    expect(adapter.status().health).toBe('needs_setup')
    await eventually(() => adapter!.status().health === 'ok')
  })

  test('no way to listen is said plainly', async () => {
    radio = new FakeRadio()
    radio.available = false
    adapter = new BleAdapter({ sources: [radio] })
    await adapter.init(recordingContext(), {})
    expect(adapter.status()).toMatchObject({
      health: 'needs_setup',
      message: expect.stringMatching(/éteint ou absent/),
    })
  })

  test('a radio that comes back clears its problem', async () => {
    await listening()
    radio!.problem('le Bluetooth de cette machine est éteint ou absent')
    expect(adapter!.status().health).toBe('degraded')
    radio!.problem(null)
    expect(adapter!.status().health).toBe('ok')
  })

  test('the time before a beacon is away follows the settings', async () => {
    radio = new FakeRadio()
    adapter = new BleAdapter({ sources: [radio], checkMs: 20 })
    const context = recordingContext()
    await adapter.init(context, { beacons: 'Clés de Sam = EC:9A:34:89:7F:2D', awayMinutes: 0.002 })
    await eventually(() => context.stateOf('beacon:cles-de-sam').home === false)
  })

  test('shutdown stops the radio and the clock', async () => {
    const context = await listening({}, { staleMs: 50 })
    radio!.hear(bthome('A4:C1:38:00:00:06', '4002ca09'))
    const current = radio!
    await adapter!.shutdown()
    adapter = null
    expect(current.stopped).toBe(1)
    const seen = context.availability.length
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(context.availability.length).toBe(seen)
  })
})
