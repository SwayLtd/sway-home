/**
 * Where advertisements come from.
 *
 * On Windows the hub listens itself: a small scanner compiled on the spot with the C# compiler
 * Windows ships (.NET Framework 4.8) watches advertisements through WinRT and writes one JSON
 * line per advertisement. Elsewhere, or farther away, a Theengs Gateway or OpenMQTTGateway
 * forwards them over MQTT. Both are tested for real: the scanner's process handling against a
 * stand-in process, its compilation on the Windows machine running the tests, the gateway
 * against a real MQTT broker.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewaySource, ProcessScanner, windowsScanner, type AdvertSource } from '#adapters/ble_sources'
import type { Advert, Values } from '#adapters/ble_codec'
import { eventually } from './adapter_harness.ts'
import { FakeMqttBroker } from './fake_mqtt_broker.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'fake_ble_scanner.ts')
const LINES = [
  '{"address":"d80f99319252","rssi":-68,"sections":["ff4c00021550765cb7d9ea4e2199a4fa879613a49281d9f5ebce"]}',
  'garbage that is not json',
  '{"address":"a4c1380283f4","rssi":-70,"sections":["16d2fc4002ca09"]}',
]

let source: AdvertSource | null = null
let broker: FakeMqttBroker | null = null

afterEach(async () => {
  await source?.stop()
  source = null
  await broker?.stop()
  broker = null
})

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'sway-ble-test-'))
}

function listen(target: AdvertSource) {
  const adverts: { advert: Advert; decoded: Values | null }[] = []
  const problems: (string | null)[] = []
  return { adverts, problems, start: () => target.start((advert, decoded) => adverts.push({ advert, decoded: decoded ?? null }), (problem) => problems.push(problem)) }
}

describe('the scanner process', () => {
  test('each line is an advertisement; what is not one is skipped', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'lines.jsonl'), LINES.join('\n'))
    source = new ProcessScanner({ name: 'test', resolve: async () => ({ command: [process.execPath, FIXTURE, join(dir, 'lines.jsonl'), 'wait'] }) })
    const run = listen(source)
    expect(await run.start()).toBe(true)
    await eventually(() => run.adverts.length === 2)
    expect(run.adverts.map((entry) => entry.advert.address)).toEqual(['D8:0F:99:31:92:52', 'A4:C1:38:02:83:F4'])
  })

  test('a scanner that stops is started again, and why it stopped is said', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'lines.jsonl'), LINES[0]!)
    let spawned = 0
    source = new ProcessScanner({
      name: 'test',
      restartMs: 50,
      resolve: async () => {
        spawned += 1
        return { command: [process.execPath, FIXTURE, join(dir, 'lines.jsonl'), 'radio-off'] }
      },
    })
    const run = listen(source)
    await run.start()
    await eventually(() => spawned >= 2, 5000)
    expect(run.problems.some((problem) => problem !== null && /Bluetooth/.test(problem) && /RadioNotAvailable/.test(problem))).toBe(true)
  })

  test('stopping closes its input: the scanner ends with the hub', async () => {
    const dir = scratch()
    const marker = join(dir, 'marker.txt')
    writeFileSync(join(dir, 'lines.jsonl'), LINES[0]!)
    source = new ProcessScanner({ name: 'test', resolve: async () => ({ command: [process.execPath, FIXTURE, join(dir, 'lines.jsonl'), 'wait', marker] }) })
    const run = listen(source)
    await run.start()
    await eventually(() => run.adverts.length === 1)
    await source.stop()
    source = null
    await eventually(() => existsSync(marker) && readFileSync(marker, 'utf8').includes('closed'), 5000)
  })

  test('a scanner that cannot be had says why, and does not start', async () => {
    source = new ProcessScanner({ name: 'test', resolve: async () => ({ problem: 'pas de radio' }) })
    const run = listen(source)
    expect(await run.start()).toBe(false)
    expect(run.problems).toEqual(['pas de radio'])
  })
})

describe('the Windows scanner', () => {
  test.if(process.platform === 'win32')('compiles with the compiler Windows ships, once', async () => {
    const dir = scratch()
    const first = await windowsScanner(dir)
    expect('command' in first).toBe(true)
    const command = (first as { command: string[] }).command
    expect(command[0]!.endsWith('.exe')).toBe(true)
    expect(command[1]).toBe('active')
    expect(existsSync(command[0]!)).toBe(true)
    const built = statSync(command[0]!).mtimeMs
    const second = (await windowsScanner(dir, { active: false })) as { command: string[] }
    expect(second.command).toEqual([command[0], 'passive'])
    expect(statSync(command[0]!).mtimeMs).toBe(built)
  }, 60_000)

  test.if(process.platform !== 'win32')('elsewhere, it says to use a gateway', async () => {
    expect(await windowsScanner(scratch())).toEqual({ problem: expect.stringMatching(/passerelle/) })
  })
})

describe('an MQTT gateway', () => {
  test('raw advertisements and what the gateway decoded, from any gateway under the topic', async () => {
    broker = new FakeMqttBroker()
    const port = await broker.start()
    source = new GatewaySource({ host: '127.0.0.1', port, topic: 'home/+/BTtoMQTT/#' })
    const run = listen(source)
    // Retained, so they reach the gateway source whenever its subscription lands.
    broker.publish('home/salon/BTtoMQTT/A4C1380283F4', { id: 'A4:C1:38:02:83:F4', rssi: -70, servicedata: '4002ca09', servicedatauuid: '0xfcd2' }, { retain: true })
    broker.publish('home/salon/BTtoMQTT/broken', 'not json', { retain: true })
    broker.publish('home/salon/SYStoMQTT', { uptime: 12 }, { retain: true })
    broker.publish('home/cuisine/BTtoMQTT/A4C138DDDBF8', { id: 'A4:C1:38:DD:DB:F8', rssi: -80, model_id: 'H5075', tempc: 21.6, hum: 49.8, batt: 100 }, { retain: true })
    expect(await run.start()).toBe(true)
    await eventually(() => run.adverts.length === 2)
    const byAddress = new Map(run.adverts.map((entry) => [entry.advert.address, entry]))
    expect(byAddress.get('A4:C1:38:02:83:F4')!.advert.serviceData.get('fcd2')?.toString('hex')).toBe('4002ca09')
    expect(byAddress.get('A4:C1:38:DD:DB:F8')!.decoded).toEqual({ temperature: 21.6, humidity: 49.8, battery: 100 })
  })

  test('an unreachable broker is said, and does not start', async () => {
    source = new GatewaySource({ host: '127.0.0.1', port: 1, topic: 'home/+/BTtoMQTT/#', connectTimeoutMs: 500 })
    const run = listen(source)
    expect(await run.start()).toBe(false)
    expect(run.problems.at(-1)).toMatch(/passerelle MQTT/)
  })
})
