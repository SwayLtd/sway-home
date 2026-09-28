/**
 * An adapter context that remembers what the adapter told the hub.
 *
 * Adapter tests assert on what reaches the hub - a state push, a device going offline, an
 * event - so the context records every call instead of dropping it. The store is a plain map:
 * tokens an adapter persists between restarts live there, and a test can pre-fill it.
 */

import type { AdapterContext, DiscoveredDevice } from '@sway-home/shared'

export interface RecordingContext extends AdapterContext {
  states: { nativeId: string; state: Record<string, unknown>; endpointIndex?: number }[]
  events: { nativeId: string; event: string; payload?: Record<string, unknown> }[]
  availability: { nativeId: string; online: boolean }[]
  discovered: DiscoveredDevice[]
  logs: { level: string; message: string }[]
  memory: Map<string, unknown>
  /** Everything pushed for one device (or one of its endpoints), merged in order: what the hub would now hold. */
  stateOf(nativeId: string, endpointIndex?: number): Record<string, unknown>
}

export function recordingContext(): RecordingContext {
  const memory = new Map<string, unknown>()
  const context: RecordingContext = {
    states: [],
    events: [],
    availability: [],
    discovered: [],
    logs: [],
    memory,
    emitState: (nativeId, state, endpointIndex) => void context.states.push({ nativeId, state, ...(endpointIndex === undefined ? {} : { endpointIndex }) }),
    emitEvent: (nativeId, event, payload) => void context.events.push({ nativeId, event, payload }),
    emitAvailability: (nativeId, online) => void context.availability.push({ nativeId, online }),
    emitDiscovered: (device) => void context.discovered.push(device),
    log: (level, message) => void context.logs.push({ level, message }),
    store: {
      get: async <T,>(key: string) => (memory.has(key) ? (memory.get(key) as T) : null),
      set: async (key: string, value: unknown) => void memory.set(key, value),
      delete: async (key: string) => void memory.delete(key),
    },
    network: { localIp: '192.168.1.10', cidr: '192.168.1.0/24', gateway: '192.168.1.1', interfaceName: 'test' },
    signal: new AbortController().signal,
    stateOf: (nativeId, endpointIndex) =>
      Object.assign({}, ...context.states.filter((entry) => entry.nativeId === nativeId && entry.endpointIndex === endpointIndex).map((entry) => entry.state)),
  }
  return context
}

/** Resolves once `check` passes, or fails the test with what was last seen. */
export async function eventually<T>(check: () => T | undefined | null | false, timeoutMs = 2000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`condition not met within ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
