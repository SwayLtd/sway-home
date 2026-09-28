/**
 * Camera pictures, through the hub.
 *
 * A camera's snapshot address wants its login, and some cameras even write that login into
 * the address. The console never gets either: it asks the hub for
 * `/api/cameras/:adapter/:nativeId/snapshot`, and the hub asks the adapter holding the login.
 * Only cameras the hub knows are asked for, so the route cannot be aimed at an arbitrary
 * address; what comes back is an image or an error, never a page from the camera.
 */

import { adapters } from '#services/adapter_manager'
import { deviceRepository } from '#repositories/device_repository'

export type SnapshotAnswer = { ok: true; contentType: string; body: Uint8Array } | { ok: false; status: 404 | 502 | 503 | 504; error: string }

const IMAGE = /^image\/[a-z0-9.+-]+$/i

export async function cameraSnapshot(adapterId: string, nativeId: string, options: { timeoutMs?: number } = {}): Promise<SnapshotAnswer> {
  const device = deviceRepository.findByNative(adapterId, nativeId)
  if (!device || !device.capabilities.includes('camera')) return { ok: false, status: 404, error: 'Unknown camera' }
  const entry = adapters.get(adapterId)
  if (!entry?.started) return { ok: false, status: 503, error: 'The camera integration is not running' }
  if (!entry.adapter.snapshot) return { ok: false, status: 404, error: 'This integration gives no pictures' }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? 12_000)
  })
  try {
    const picture = await Promise.race([entry.adapter.snapshot(nativeId).catch(() => null), timeout])
    if (picture === 'timeout') return { ok: false, status: 504, error: 'The camera took too long' }
    if (!picture) return { ok: false, status: 502, error: 'The camera gave no picture' }
    if (!IMAGE.test(picture.contentType)) return { ok: false, status: 502, error: 'The camera answered something that is not a picture' }
    return { ok: true, contentType: picture.contentType.toLowerCase(), body: picture.body }
  } finally {
    clearTimeout(timer)
  }
}
