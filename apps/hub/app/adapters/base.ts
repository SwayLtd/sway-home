/**
 * Shared adapter plumbing.
 *
 * Every LAN adapter needs the same four things: a fetch with a timeout, JSON that does not
 * throw on a device answering HTML, a small poller, and a way to say "this host is mine".
 * They live here so twenty adapters do not each grow their own slightly different version.
 */

import type { AdapterContext, AdapterStatus, CapabilityId, CommandResult, NetworkHost } from '@sway-home/shared'

export const DEFAULT_TIMEOUT_MS = 4000

export async function httpJson<T = unknown>(
  url: string,
  options: { method?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string>; auth?: { user: string; password: string } } = {}
): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { accept: 'application/json', ...(options.headers ?? {}) }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.auth) headers.authorization = `Basic ${btoa(`${options.auth.user}:${options.auth.password}`)}`

    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    if (!response.ok) return null
    const text = await response.text()
    if (text.length === 0) return null as T
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function httpText(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Run a task over a list with a concurrency cap. Keeps a /24 scan from opening 254 sockets. */
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (item === undefined) break
      results.push(await task(item))
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Base class for the many adapters that poll an HTTP device on the LAN.
 *
 * Polling is not elegant, but it is what most of these devices support, and an adapter that
 * pushes (Shelly's outbound websocket, ESPHome's native API, MQTT) simply overrides
 * `subscribe` and turns the poller off.
 */
export abstract class PollingAdapter {
  protected context: AdapterContext | null = null
  protected config: Record<string, unknown> = {}
  protected devices = new Map<string, { ip: string; meta: Record<string, unknown> }>()
  protected lastError: string | null = null
  #timer: ReturnType<typeof setInterval> | null = null

  /** Milliseconds between polls. Sensors want more; relays are fine at 10 s. */
  protected pollIntervalMs = 10_000

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.context = context
    this.config = config
    const interval = Number(config.pollIntervalMs ?? this.pollIntervalMs)
    if (Number.isFinite(interval) && interval >= 1000) this.pollIntervalMs = interval
    this.#timer = setInterval(() => void this.poll(), this.pollIntervalMs)
    await this.onInit?.()
  }

  protected onInit?(): Promise<void>

  protected async poll(): Promise<void> {
    for (const [nativeId] of this.devices) {
      try {
        const state = await this.getState(nativeId)
        if (Object.keys(state).length > 0) {
          this.context?.emitState(nativeId, state)
          this.context?.emitAvailability(nativeId, true)
        }
      } catch {
        this.context?.emitAvailability(nativeId, false)
      }
    }
  }

  abstract getState(nativeId: string): Promise<Record<string, unknown>>
  abstract execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult>

  status(): AdapterStatus {
    return {
      health: this.lastError ? 'degraded' : 'ok',
      deviceCount: this.devices.size,
      message: this.lastError ?? undefined,
    }
  }

  async shutdown(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.devices.clear()
  }

  protected ok(nativeId: string, command: string, state?: Record<string, unknown>, undoCommand?: { command: string; args: Record<string, unknown> } | null): CommandResult {
    return { ok: true, deviceId: nativeId, command, state, undo: undoCommand ?? null }
  }

  protected fail(nativeId: string, command: string, error: string): CommandResult {
    this.lastError = error
    return { ok: false, deviceId: nativeId, command, error }
  }
}

/** Candidate hosts for an HTTP adapter: anything with a web port, plus anything it named. */
export function httpCandidates(hosts: NetworkHost[], extraPorts: number[] = []): NetworkHost[] {
  const ports = new Set([80, 8080, 81, 8081, ...extraPorts])
  return hosts.filter((host) => host.openPorts.some((port) => ports.has(port)))
}

export function capabilitiesFrom(...groups: CapabilityId[][]): CapabilityId[] {
  return [...new Set(groups.flat())]
}
