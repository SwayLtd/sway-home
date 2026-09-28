/**
 * Teaching a task by doing it.
 *
 * "Apprendre une tâche" starts a recording. The person then does the task by hand - from the
 * console, from a phone, on the wall switch - and stops. Every change a person made to a
 * device while recording becomes a step; stopping turns the steps into a suggested routine
 * with the same devices set the same way, in the same order, with the pauses that were long
 * enough to matter. The routine is suggested, not active: it is reviewed like any other.
 *
 * What counts is what a person did: state changes that came from the console (`user`, `api`)
 * or from the device itself (`device`, someone at the wall switch), on the attributes a scene
 * can set. A sensor reporting a temperature, the assistant acting, a routine running: none of
 * that is part of the lesson.
 */

import type { HouseEvent, Routine } from '@sway-home/shared'
import { randomUUID } from 'node:crypto'
import { bus } from '#services/event_bus'
import { stateToCommands } from '#services/house'
import { deviceRepository } from '#repositories/device_repository'
import { routines } from '#repositories/store'

/** The attributes a person sets on purpose: the same set a scene snapshot keeps. */
const TAUGHT_KEYS = ['on', 'brightness', 'colorTemperature', 'hue', 'saturation', 'position', 'tilt', 'targetTemperature', 'hvacMode', 'volume', 'fanSpeed', 'effect']
const HUMAN_ORIGINS = new Set(['user', 'api', 'device'])
/** Changes to one device this close together are one gesture: switch on, then dim. */
const SAME_GESTURE_MS = 5_000
/** A pause this long between two gestures is kept as a delay. */
const MEANINGFUL_PAUSE_MS = 30_000
const MAX_DELAY_S = 3_600

export interface TaughtStep {
  deviceId: string
  deviceName: string
  state: Record<string, unknown>
  at: number
}

export interface TeachStatus {
  active: boolean
  id: string | null
  title: string | null
  startedAt: string | null
  steps: TaughtStep[]
}

interface Session {
  id: string
  title: string | null
  startedAt: number
  steps: TaughtStep[]
  clock: () => number
  off: () => void
}

let session: Session | null = null

function publish(): void {
  bus.publish('teach.updated', { subjectType: 'system', payload: { ...teach.status() } })
}

function record(event: HouseEvent): void {
  if (!session || !HUMAN_ORIGINS.has(event.origin)) return
  const payload = event.payload as { deviceId?: string; changes?: Record<string, unknown>; changed?: string[] }
  const deviceId = payload.deviceId ?? event.subjectId
  if (!deviceId || !payload.changes) return

  // `changes` carries the state a command returned, which can repeat values that did not
  // move (a light switched on reports its brightness too); `changed` lists the ones that did.
  const moved = Array.isArray(payload.changed) ? new Set(payload.changed) : null
  const taught: Record<string, unknown> = {}
  for (const key of TAUGHT_KEYS) {
    if (moved && !moved.has(key)) continue
    if (payload.changes[key] !== undefined && payload.changes[key] !== null) taught[key] = payload.changes[key]
  }
  if (Object.keys(taught).length === 0) return

  const at = session.clock()
  const last = session.steps.at(-1)
  if (last && last.deviceId === deviceId && at - last.at <= SAME_GESTURE_MS) {
    last.state = { ...last.state, ...taught }
  } else {
    const device = deviceRepository.find(deviceId)
    session.steps.push({ deviceId, deviceName: device?.name ?? deviceId, state: taught, at })
  }
  publish()
}

/** The routine a recording teaches: the steps as commands, with the pauses that mattered. */
function routineFrom(recorded: Session): Routine | null {
  if (recorded.steps.length === 0) return null

  const actions: Routine['actions'] = []
  let previous: number | null = null
  for (const step of recorded.steps) {
    if (previous !== null && step.at - previous >= MEANINGFUL_PAUSE_MS) {
      actions.push({ kind: 'delay', seconds: Math.min(MAX_DELAY_S, Math.round((step.at - previous) / 1000)) })
    }
    for (const command of stateToCommands(step.state, 400)) {
      actions.push({ kind: 'device_command', deviceId: step.deviceId, selector: null, command: command.command, args: command.args })
    }
    previous = step.at
  }

  const started = new Date(recorded.startedAt)
  const rounded = Math.round(started.getMinutes() / 5) * 5
  const hour = (started.getHours() + (rounded === 60 ? 1 : 0)) % 24
  const at = `${String(hour).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`
  const devices = [...new Set(recorded.steps.map((step) => step.deviceName))]
  const seconds = Math.round((recorded.steps.at(-1)!.at - recorded.startedAt) / 1000)

  return routines.create({
    name: `Tâche apprise : ${recorded.title?.trim() || started.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`,
    description: `${recorded.steps.length} geste${recorded.steps.length > 1 ? 's' : ''} sur ${devices.join(', ')}.`,
    enabled: true,
    mode: 'single',
    triggers: [{ kind: 'manual' }],
    conditions: [],
    actions,
    authoredBy: 'agent',
    status: 'suggested',
    suggestionReason: `Enregistré pendant que vous le faisiez, en ${seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`}.`,
    confidence: 0.9,
    alternatives: [
      { id: 'daily', title: `Chaque jour à ${at.replace(':', ' h ')}`, description: "À l'heure où vous l'avez montré.", triggers: [{ kind: 'time', at, days: [] }] },
      { id: 'weekdays', title: `En semaine à ${at.replace(':', ' h ')}`, description: 'Du lundi au vendredi.', triggers: [{ kind: 'time', at, days: ['mon', 'tue', 'wed', 'thu', 'fri'] }] },
    ],
    areaId: null,
  })
}

export const teach = {
  start(options: { title?: string | null; clock?: () => number } = {}): { id: string; startedAt: string } {
    if (session) return { id: session.id, startedAt: new Date(session.startedAt).toISOString() }
    const clock = options.clock ?? Date.now
    const off = bus.on('device.state_changed', record)
    session = { id: randomUUID(), title: options.title?.slice(0, 60) ?? null, startedAt: clock(), steps: [], clock, off }
    publish()
    return { id: session.id, startedAt: new Date(session.startedAt).toISOString() }
  },

  status(): TeachStatus {
    if (!session) return { active: false, id: null, title: null, startedAt: null, steps: [] }
    return {
      active: true,
      id: session.id,
      title: session.title,
      startedAt: new Date(session.startedAt).toISOString(),
      steps: session.steps.map((step) => ({ ...step, state: { ...step.state } })),
    }
  },

  /** Ends the recording. What was taught becomes a suggested routine, if anything was. */
  stop(): { routine: Routine | null; steps: TaughtStep[] } {
    if (!session) return { routine: null, steps: [] }
    const ended = session
    ended.off()
    session = null
    const routine = routineFrom(ended)
    publish()
    if (routine) {
      bus.publish('automation.suggested', {
        subjectType: 'automation',
        subjectId: routine.id,
        origin: 'user',
        payload: { name: routine.name, reason: routine.suggestionReason, taught: true },
      })
    }
    return { routine, steps: ended.steps }
  },

  /** Drops a recording without keeping anything. */
  cancel(): void {
    if (!session) return
    session.off()
    session = null
    publish()
  },
}
