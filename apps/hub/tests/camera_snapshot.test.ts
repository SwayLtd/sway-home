/**
 * Camera pictures, through the hub.
 *
 * The console asks the hub; the hub asks the adapter, which holds the camera's login. Only
 * cameras the hub knows are asked for, so the route cannot be aimed at an arbitrary address;
 * a picture is an image or it is an error; a camera that hangs does not hang the request.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { adapters } from '#services/adapter_manager'
import { cameraSnapshot } from '#services/camera_snapshot'
import { VirtualAdapter } from '#adapters/virtual'
import { dropDatabase, freshDatabase } from './helpers.ts'
import { FakeAdapter } from './fake_adapter.ts'
import { recordingContext } from './adapter_harness.ts'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

class CameraAdapter extends FakeAdapter {
  picture: { contentType: string; body: Uint8Array } | null | 'hang' | 'throw' = { contentType: 'image/jpeg', body: JPEG }
  asked: string[] = []

  async snapshot(nativeId: string): Promise<{ contentType: string; body: Uint8Array } | null> {
    this.asked.push(nativeId)
    if (this.picture === 'hang') return new Promise(() => {})
    if (this.picture === 'throw') throw new Error('socket hang up')
    return this.picture
  }
}

const adapter = new CameraAdapter()

beforeEach(async () => {
  await freshDatabase()
  adapter.reset()
  adapter.picture = { contentType: 'image/jpeg', body: JPEG }
  adapter.asked.length = 0
  adapters.register(adapter)
  await adapters.start('test')
  adapter.offerDevices([
    { adapterId: 'test', nativeId: 'cam:entree', uid: 'test:cam:entree', name: 'Caméra entrée', category: 'camera', capabilities: ['camera', 'motion'], transport: 'virtual', confidence: 0.95 },
    { adapterId: 'test', nativeId: 'lamp', uid: 'test:lamp', name: 'Lampe', category: 'light', capabilities: ['onoff'], transport: 'virtual', confidence: 0.95 },
  ])
  await adapters.discover([])
})

afterAll(dropDatabase)

describe('a camera picture', () => {
  test('a known camera: the picture its adapter fetched', async () => {
    expect(await cameraSnapshot('test', 'cam:entree')).toEqual({ ok: true, contentType: 'image/jpeg', body: JPEG })
    expect(adapter.asked).toEqual(['cam:entree'])
  })

  test('only cameras the hub knows are asked for', async () => {
    expect(await cameraSnapshot('test', 'http://192.168.1.1/admin')).toMatchObject({ ok: false, status: 404 })
    expect(await cameraSnapshot('test', 'lamp')).toMatchObject({ ok: false, status: 404 })
    expect(await cameraSnapshot('elsewhere', 'cam:entree')).toMatchObject({ ok: false, status: 404 })
    expect(adapter.asked).toEqual([])
  })

  test('an integration that is stopped, or that gives no pictures', async () => {
    Object.defineProperty(adapter, 'snapshot', { value: undefined, configurable: true })
    expect(await cameraSnapshot('test', 'cam:entree')).toMatchObject({ ok: false, status: 404 })
    delete (adapter as { snapshot?: unknown }).snapshot
    await adapters.stop('test')
    expect(await cameraSnapshot('test', 'cam:entree')).toMatchObject({ ok: false, status: 503 })
  })

  test('no picture, a failure, or something that is not an image is a bad gateway', async () => {
    adapter.picture = null
    expect(await cameraSnapshot('test', 'cam:entree')).toMatchObject({ ok: false, status: 502 })
    adapter.picture = 'throw'
    expect(await cameraSnapshot('test', 'cam:entree')).toMatchObject({ ok: false, status: 502 })
    adapter.picture = { contentType: 'text/html', body: new TextEncoder().encode('<script>alert(1)</script>') }
    expect(await cameraSnapshot('test', 'cam:entree')).toMatchObject({ ok: false, status: 502 })
  })

  test('a camera that hangs does not hang the request', async () => {
    adapter.picture = 'hang'
    const started = Date.now()
    expect(await cameraSnapshot('test', 'cam:entree', { timeoutMs: 100 })).toMatchObject({ ok: false, status: 504 })
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('the simulated camera', () => {
  test('draws its own picture, with its name escaped', async () => {
    const virtual = new VirtualAdapter()
    await virtual.init(recordingContext(), {})
    try {
      const picture = await virtual.snapshot('vcam-entree')
      expect(picture?.contentType).toBe('image/svg+xml')
      const svg = new TextDecoder().decode(picture!.body)
      expect(svg).toStartWith('<svg')
      expect(svg).toContain('Caméra entrée')
      expect(svg).not.toContain('<script')
      expect(await virtual.snapshot('unknown')).toBeNull()
      expect(await virtual.snapshot('vs-fumee-cuisine')).toBeNull()
      expect((await virtual.getState('vcam-entree')).snapshotUrl).toBe('/api/cameras/virtual/vcam-entree/snapshot')
      const command = await virtual.execute('vcam-entree', 'snapshot', {})
      expect(String(command.state?.snapshotUrl)).toMatch(/^\/api\/cameras\/virtual\/vcam-entree\/snapshot\?t=\d+$/)
    } finally {
      await virtual.shutdown()
    }
  })
})
