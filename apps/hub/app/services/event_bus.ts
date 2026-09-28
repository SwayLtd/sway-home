/**
 * The event bus.
 *
 * Everything that happens goes through `publish`. Three things then happen, in this order
 * and deliberately so:
 *  1. In-process listeners run (the automation engine must see a state change before the
 *     UI does, otherwise a motion light looks laggy even when it is not).
 *  2. The event is written to SQLite, unless it is chatter we would only ever throw away.
 *  3. It is fanned out to every open WebSocket.
 *
 * Writing is synchronous because SQLite is, and because an event that is not durable is an
 * event the agent cannot explain afterwards.
 */

import { randomUUID } from 'node:crypto'
import { eventMatches, type EventListener, type EventType, type HouseEvent } from '@sway-home/shared'
import { database, insertInto, nowIso, toJson } from '#db/database'

/** Event types written to the timeline. The rest are broadcast and forgotten. */
const PERSISTED: EventType[] = [
  'device.added',
  'device.removed',
  'device.online',
  'device.offline',
  'device.event',
  'device.command_sent',
  'device.command_failed',
  'scan.finished',
  'adapter.status_changed',
  'automation.triggered',
  'automation.failed',
  'automation.suggested',
  'scene.activated',
  'agent.message',
  'agent.action_proposed',
  'agent.action_approved',
  'agent.action_rejected',
  'agent.autonomy_changed',
  'agent.insight',
  'voice.transcript',
  'presence.changed',
  'house.mode_changed',
  'alert.raised',
  'alert.cleared',
  'system.error',
  'system.notice',
]

const PERSISTED_SET = new Set<string>(PERSISTED)

type Subscription = { pattern: string; listener: EventListener; once: boolean }

class EventBus {
  #subscriptions: Subscription[] = []
  #sockets = new Set<(event: HouseEvent) => void>()
  #ring: HouseEvent[] = []
  #ringSize = 500

  on(pattern: string, listener: EventListener): () => void {
    const subscription: Subscription = { pattern, listener, once: false }
    this.#subscriptions.push(subscription)
    return () => {
      this.#subscriptions = this.#subscriptions.filter((s) => s !== subscription)
    }
  }

  once(pattern: string, listener: EventListener): void {
    this.#subscriptions.push({ pattern, listener, once: true })
  }

  /** WebSocket connections register here; the return value detaches them. */
  attachSocket(send: (event: HouseEvent) => void): () => void {
    this.#sockets.add(send)
    return () => this.#sockets.delete(send)
  }

  /** The last N events, so a page that connects late still renders a timeline. */
  recent(limit = 100, pattern = '*'): HouseEvent[] {
    return this.#ring.filter((event) => eventMatches(pattern, event.type)).slice(-limit)
  }

  publish(
    type: EventType,
    options: {
      subjectType?: HouseEvent['subjectType']
      subjectId?: string | null
      origin?: HouseEvent['origin']
      originDetail?: string | null
      payload?: Record<string, unknown>
      correlationId?: string | null
      severity?: HouseEvent['severity']
      /** Force persistence for an event type that is normally ephemeral. */
      persist?: boolean
    } = {}
  ): HouseEvent {
    const event: HouseEvent = {
      id: randomUUID(),
      type,
      at: nowIso(),
      subjectType: options.subjectType ?? 'system',
      subjectId: options.subjectId ?? null,
      origin: options.origin ?? 'system',
      originDetail: options.originDetail ?? null,
      payload: options.payload ?? {},
      correlationId: options.correlationId ?? null,
      severity: options.severity ?? 'info',
    }

    this.#ring.push(event)
    if (this.#ring.length > this.#ringSize) this.#ring.splice(0, this.#ring.length - this.#ringSize)

    // 1. Listeners, synchronously where they are synchronous.
    const survivors: Subscription[] = []
    for (const subscription of this.#subscriptions) {
      if (!eventMatches(subscription.pattern, type)) {
        survivors.push(subscription)
        continue
      }
      if (!subscription.once) survivors.push(subscription)
      try {
        const result = subscription.listener(event)
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            // A listener that throws must not stop the bus; log it as its own event.
            this.publish('system.error', {
              severity: 'warning',
              payload: { where: `listener:${subscription.pattern}`, message: String(error) },
            })
          })
        }
      } catch (error) {
        console.error(`[bus] listener for ${subscription.pattern} threw`, error)
      }
    }
    this.#subscriptions = survivors

    // 2. Persistence.
    if (options.persist === true || PERSISTED_SET.has(type)) {
      try {
        insertInto('events', {
          id: event.id,
          type: event.type,
          at: event.at,
          subject_type: event.subjectType,
          subject_id: event.subjectId,
          origin: event.origin,
          origin_detail: event.originDetail,
          payload: toJson(event.payload),
          correlation_id: event.correlationId,
          severity: event.severity,
        })
      } catch (error) {
        console.error('[bus] could not persist event', type, error)
      }
    }

    // 3. Sockets.
    for (const send of this.#sockets) {
      try {
        send(event)
      } catch {
        this.#sockets.delete(send)
      }
    }

    return event
  }

  /** Wait for one event, with a timeout. Used by pairing flows and tests. */
  waitFor(pattern: string, timeoutMs = 10_000): Promise<HouseEvent | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#subscriptions = this.#subscriptions.filter((s) => s.listener !== listener)
        resolve(null)
      }, timeoutMs)

      const listener: EventListener = (event) => {
        clearTimeout(timer)
        resolve(event)
      }
      this.once(pattern, listener)
    })
  }

  socketCount(): number {
    return this.#sockets.size
  }

  listenerCount(): number {
    return this.#subscriptions.length
  }
}

export const bus = new EventBus()

/** Timeline query used by the API and by the agent's "why did that happen" tool. */
export function queryEvents(options: {
  limit?: number
  before?: string
  types?: string[]
  subjectId?: string
  correlationId?: string
  severity?: string[]
} = {}): HouseEvent[] {
  const where: string[] = []
  const params: unknown[] = []

  if (options.before) {
    where.push('at < ?')
    params.push(options.before)
  }
  if (options.types?.length) {
    where.push(`type IN (${options.types.map(() => '?').join(',')})`)
    params.push(...options.types)
  }
  if (options.subjectId) {
    where.push('subject_id = ?')
    params.push(options.subjectId)
  }
  if (options.correlationId) {
    where.push('correlation_id = ?')
    params.push(options.correlationId)
  }
  if (options.severity?.length) {
    where.push(`severity IN (${options.severity.map(() => '?').join(',')})`)
    params.push(...options.severity)
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const rows = database().all<Record<string, unknown>>(
    `SELECT * FROM events ${clause} ORDER BY at DESC LIMIT ?`,
    [...params, options.limit ?? 100]
  )

  return rows.map(rowToEvent)
}

export function rowToEvent(row: Record<string, unknown>): HouseEvent {
  return {
    id: String(row.id),
    type: String(row.type) as EventType,
    at: String(row.at),
    subjectType: String(row.subject_type) as HouseEvent['subjectType'],
    subjectId: row.subject_id === null ? null : String(row.subject_id),
    origin: String(row.origin) as HouseEvent['origin'],
    originDetail: row.origin_detail === null ? null : String(row.origin_detail),
    payload: JSON.parse(String(row.payload ?? '{}')) as Record<string, unknown>,
    correlationId: row.correlation_id === null ? null : String(row.correlation_id),
    severity: String(row.severity) as HouseEvent['severity'],
  }
}

/** Keeps the timeline from growing without bound. Called nightly by the scheduler. */
export function pruneEvents(retainDays: number): number {
  const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString()
  const result = database().run('DELETE FROM events WHERE at < ? AND severity IN (?, ?)', [cutoff, 'debug', 'info'])
  return result.changes
}
