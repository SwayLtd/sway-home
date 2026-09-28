/**
 * The event bus contract.
 *
 * Everything that happens in the house lands here as one typed event, and everything that
 * reacts - the automation engine, the agent's memory, the timeline, the web socket feed,
 * the energy roll-ups - reads the same stream. One log means the agent can answer "why did
 * the light come on" without a second source of truth.
 */

import { z } from 'zod'

export const EVENT_TYPES = [
  'device.discovered',
  'device.added',
  'device.updated',
  'device.removed',
  'device.state_changed',
  'device.online',
  'device.offline',
  'device.event',
  'device.command_sent',
  'device.command_failed',

  'scan.started',
  'scan.progress',
  'scan.finished',

  'adapter.status_changed',

  'automation.triggered',
  'automation.action_run',
  'automation.failed',
  'automation.suggested',

  'scene.activated',

  'agent.message',
  'agent.tool_call',
  'agent.tool_result',
  'agent.action_proposed',
  'agent.action_approved',
  'agent.action_rejected',
  'agent.autonomy_changed',
  'agent.insight',
  'agent.feedback',
  'task.updated',
  'teach.updated',

  'voice.wake',
  'voice.transcript',
  'voice.reply',

  'presence.changed',
  'house.mode_changed',
  'alert.raised',
  'alert.cleared',
  'energy.tick',
  'system.error',
  'system.notice',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export const houseEventSchema = z.object({
  id: z.string(),
  type: z.enum(EVENT_TYPES),
  at: z.iso.datetime(),
  /** Device, area, automation or agent that the event is about. */
  subjectType: z.enum(['device', 'area', 'automation', 'scene', 'agent', 'adapter', 'system', 'person']).default('system'),
  subjectId: z.string().nullable().default(null),
  /** Who or what caused it. The timeline shows this verbatim; the agent reasons on it. */
  origin: z.enum(['user', 'automation', 'agent', 'device', 'schedule', 'api', 'system']).default('system'),
  originDetail: z.string().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Groups the command, the state change and the reply that all came from one intent. */
  correlationId: z.string().nullable().default(null),
  severity: z.enum(['debug', 'info', 'notice', 'warning', 'critical']).default('info'),
})

export type HouseEvent = z.infer<typeof houseEventSchema>

/** Payloads worth typing, because half the system reads them. */
export interface StateChangedPayload {
  deviceId: string
  endpointId?: string
  changes: Record<string, unknown>
  previous: Record<string, unknown>
}

export interface ScanProgressPayload {
  phase: 'arp' | 'icmp' | 'tcp' | 'mdns' | 'ssdp' | 'fingerprint' | 'adapters'
  done: number
  total: number
  found: number
}

export interface AgentActionProposedPayload {
  proposalId: string
  summary: string
  reason: string
  commands: { deviceId: string; command: string; args: Record<string, unknown> }[]
  risk: 'low' | 'medium' | 'high'
  expiresAt: string
}

export type EventListener = (event: HouseEvent) => void | Promise<void>

/** Wildcards: `device.*` and `*` both work. */
export function eventMatches(pattern: string, type: EventType): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1))
  return pattern === type
}
