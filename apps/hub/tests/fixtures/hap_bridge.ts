/**
 * A HomeKit bridge for tests: fixtures/hap_accessory.mjs (HAP-NodeJS) run under Node, driven
 * from here.
 *
 * `advert()` is what mDNS would hear from it - the TXT record HAP-NodeJS builds, pointed at
 * 127.0.0.1 - so a test can stand in for the network without standing in for the accessory.
 * A bridge restarted with the same `dir` and `username` is the same accessory, pairings kept;
 * the same `username` with a fresh `dir` is that accessory after a reset.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseAdvert, type HapAdvert } from '#adapters/hap_codec'

const SCRIPT = join(import.meta.dir, 'hap_accessory.mjs')

export interface TestBridge {
  port: number
  code: string
  username: string
  dir: string
  /** The bridge's name as HAP-NodeJS publishes it (the given name and four characters). */
  name: string
  setupURI: string
  txt: Record<string, string>
  alive: boolean
  /** What controllers wrote, in order. */
  wrote: { accessory: string; subtype: string | null; characteristic: string; value: unknown }[]
  /** A change made at the accessory itself: a lamp switched at the wall, a door opened. */
  set(accessory: string, service: string, characteristic: string, value: unknown, subtype?: string): void
  /** A lamp added to the bridge while it runs; resolves once its configuration number moved. */
  add(key: string, name: string): Promise<void>
  advert(): HapAdvert
  stop(): Promise<void>
}

const randomUsername = () =>
  Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  ).join(':')

export async function hapBridge(options: { port?: number; code?: string; username?: string; dir?: string } = {}): Promise<TestBridge> {
  const port = options.port ?? 52000 + Math.floor(Math.random() * 4000)
  const code = options.code ?? '031-45-154'
  const username = options.username ?? randomUsername()
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'sway-hap-'))
  const child = spawn('node', [SCRIPT, String(port), code, dir, username], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const waiters: ((message: Record<string, unknown>) => boolean)[] = []

  const bridge: TestBridge = {
    port,
    code,
    username,
    dir,
    name: '',
    setupURI: '',
    txt: {},
    alive: true,
    wrote: [],
    set(accessory, service, characteristic, value, subtype) {
      child.stdin.write(`${JSON.stringify({ set: { accessory, service, characteristic, value, subtype } })}\n`)
    },
    add(key, name) {
      const done = new Promise<void>((resolve) => waiters.push((message) => (message.added === key ? (resolve(), true) : false)))
      child.stdin.write(`${JSON.stringify({ add: { key, name } })}\n`)
      return done
    },
    advert() {
      return parseAdvert({ name: bridge.name, addresses: ['127.0.0.1'], port, txt: bridge.txt })!
    },
    async stop() {
      if (!bridge.alive) return
      bridge.alive = false
      child.stdin.write(`${JSON.stringify({ stop: true })}\n`)
      const timer = setTimeout(() => child.kill(), 3000)
      await exited
      clearTimeout(timer)
    },
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the HAP bridge did not start: ${stderr}`)), 20_000)
    child.once('exit', (exitCode) => {
      bridge.alive = false
      clearTimeout(timer)
      reject(new Error(`the HAP bridge stopped (${exitCode}): ${stderr}`))
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (message.txt) bridge.txt = message.txt as Record<string, string>
      if (message.wrote) bridge.wrote.push(message.wrote as TestBridge['wrote'][number])
      for (const waiter of [...waiters]) if (waiter(message)) waiters.splice(waiters.indexOf(waiter), 1)
      if (message.ready) {
        bridge.name = String(message.name)
        bridge.setupURI = String(message.setupURI)
        clearTimeout(timer)
        resolve()
      }
    })
  })
  return bridge
}
