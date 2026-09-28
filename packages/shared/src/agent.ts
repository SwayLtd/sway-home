/**
 * The agent contract: autonomy levels, tool shapes, proposals, memory.
 *
 * The design question behind this file is not "can the model call a tool" - it can - but
 * "what is it allowed to do without asking". A house agent that asks about everything is
 * a worse remote control; one that asks about nothing unlocks the front door at 3am. So
 * permission is a first-class object: every tool carries a risk level, every autonomy
 * level carries a ceiling, and anything above the ceiling becomes a proposal a human sees.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------------------
// Autonomy
// ---------------------------------------------------------------------------------------

export const AUTONOMY_LEVELS = ['observer', 'assistant', 'copilot', 'autopilot'] as const
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number]

export const AUTONOMY: Record<
  AutonomyLevel,
  { label: string; description: string; maxRiskWithoutApproval: 'none' | 'low' | 'medium' | 'high'; mayActUnprompted: boolean }
> = {
  observer: {
    label: 'Observateur',
    description: 'Lit la maison et répond. Ne change rien.',
    maxRiskWithoutApproval: 'none',
    mayActUnprompted: false,
  },
  assistant: {
    label: 'Assistant',
    description: "Fait ce qu'on lui demande, une consigne à la fois. Repère les situations mais demande avant d'agir.",
    maxRiskWithoutApproval: 'low',
    mayActUnprompted: false,
  },
  copilot: {
    label: 'Copilote',
    description: 'Agit seul pour le quotidien (chauffage, lumières, eau), propose le reste et attend.',
    maxRiskWithoutApproval: 'medium',
    mayActUnprompted: true,
  },
  autopilot: {
    label: 'Pilote automatique',
    description: 'Gère la maison. Seules les serrures, caméras, alarmes et appareils critiques demandent encore.',
    maxRiskWithoutApproval: 'high',
    mayActUnprompted: true,
  },
}

/**
 * Out of the box the assistant acts on its own for everyday things and asks for the rest.
 * An assistant that waits to be told is a remote control; locks, cameras, alarms and
 * anything marked critical still ask at every level.
 */
export const DEFAULT_AUTONOMY: AutonomyLevel = 'copilot'

export const RISK_ORDER = ['none', 'low', 'medium', 'high', 'forbidden'] as const
export type RiskLevel = (typeof RISK_ORDER)[number]

export function riskAllowed(level: AutonomyLevel, risk: RiskLevel): boolean {
  if (risk === 'forbidden') return false
  const ceiling = AUTONOMY[level].maxRiskWithoutApproval
  return RISK_ORDER.indexOf(risk) <= RISK_ORDER.indexOf(ceiling)
}

/**
 * Risk is a property of the *effect*, not of the device. Turning a light on is low
 * wherever it is; unlocking a door is high wherever it is.
 */
export const COMMAND_RISK: Record<string, RiskLevel> = {
  turnOn: 'low',
  turnOff: 'low',
  toggle: 'low',
  setBrightness: 'low',
  stepBrightness: 'low',
  setColor: 'low',
  setColorRgb: 'low',
  setColorName: 'low',
  setColorTemperature: 'low',
  setEffect: 'low',
  clearEffect: 'low',
  identify: 'low',
  setVolume: 'low',
  stepVolume: 'low',
  setMuted: 'low',
  play: 'low',
  pause: 'low',
  stopPlayback: 'low',
  next: 'low',
  previous: 'low',
  seek: 'low',
  playMedia: 'low',
  speak: 'low',
  notify: 'low',
  activateScene: 'low',
  setFanSpeed: 'low',
  setFanMode: 'low',
  setOscillating: 'low',
  setSource: 'low',

  setPosition: 'medium',
  open: 'medium',
  close: 'medium',
  stop: 'medium',
  setTilt: 'medium',
  setTargetTemperature: 'medium',
  setHvacMode: 'medium',
  setPreset: 'medium',
  boost: 'medium',
  startCleaning: 'medium',
  pauseCleaning: 'medium',
  returnToDock: 'medium',
  locateVacuum: 'medium',
  startProgram: 'medium',
  pauseProgram: 'medium',
  stopProgram: 'medium',
  storeScene: 'medium',
  resetEnergy: 'medium',
  openValve: 'medium',
  closeValve: 'medium',
  snapshot: 'medium',

  lock: 'medium',
  unlock: 'high',
  openDoor: 'high',
  closeDoor: 'medium',
  stopDoor: 'medium',
  triggerSiren: 'high',
  silenceSiren: 'high',
  startRecording: 'high',
  stopRecording: 'high',
  ptz: 'medium',
  installUpdate: 'high',
}

export function commandRisk(command: string, deviceIsCritical = false): RiskLevel {
  const base = COMMAND_RISK[command] ?? 'medium'
  if (!deviceIsCritical) return base
  return RISK_ORDER.indexOf(base) < RISK_ORDER.indexOf('high') ? 'high' : base
}

// ---------------------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------------------

/**
 * One thing the assistant did while answering, kept with the answer so the trace survives a
 * reload: the reasoning it wrote between tool calls, and every tool call with what it
 * returned. A tool entry whose `ok` is null never answered - the run was interrupted first.
 */
export const agentTraceEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reasoning'), id: z.string(), text: z.string() }),
  z.object({
    kind: z.literal('tool'),
    /** The provider's call id, so a live step and its saved entry are the same thing. */
    id: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
    ok: z.boolean().nullable(),
    summary: z.string(),
    durationMs: z.number().int().min(0),
  }),
])
export type AgentTraceEntry = z.infer<typeof agentTraceEntrySchema>

export const AGENT_SOURCE_KINDS = ['device', 'area', 'memory', 'routine', 'scene', 'history', 'energy', 'timeline', 'network', 'alert'] as const

/** What an answer was read from: cited next to the sentence it supports. */
export const agentSourceSchema = z.object({
  id: z.string(),
  kind: z.enum(AGENT_SOURCE_KINDS),
  title: z.string(),
  subtitle: z.string().nullable().default(null),
  /** A console path, never an external URL. */
  href: z.string().nullable().default(null),
  icon: z.string().nullable().default(null),
})
export type AgentSource = z.infer<typeof agentSourceSchema>

/** A memory the assistant had in mind when it answered, shown as a context card. */
export const agentContextItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['memory', 'device', 'routine']),
  title: z.string(),
  excerpt: z.string(),
  confidence: z.number().min(0).max(1).nullable().default(null),
  meta: z.string().nullable().default(null),
  href: z.string().nullable().default(null),
})
export type AgentContextItem = z.infer<typeof agentContextItemSchema>

/**
 * A question the assistant asks back instead of guessing ("Quelle lampe ?"). The run ends
 * on it, and the answer comes back as the next message of the same conversation, so the
 * conversation itself is the checkpoint.
 */
export const agentQuestionSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().min(1).max(160),
  description: z.string().max(400).optional(),
  options: z
    .array(z.object({ id: z.string().min(1).max(60), label: z.string().min(1).max(80), hint: z.string().max(160).optional() }))
    .min(2)
    .max(8),
  multiple: z.boolean().default(false),
  allowOther: z.boolean().default(false),
})
export type AgentQuestion = z.infer<typeof agentQuestionSchema>

/**
 * A command waiting for the answer to a question: "allume la lampe" asked "Quelle lampe ?"
 * and keeps the command here, so the answer runs it without going through a model.
 */
export const agentPendingCommandSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  /** The argument the answer fills in. */
  field: z.string(),
  /** The question whose answer fills it. */
  questionId: z.string(),
  /** What the "all of them" option runs instead. */
  all: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }).optional(),
})
export type AgentPendingCommand = z.infer<typeof agentPendingCommandSchema>

export const agentMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  /** Rendered as cards in the chat: a device control, a chart, a proposal, a routine. */
  attachments: z
    .array(
      z.object({
        kind: z.enum(['device', 'devices', 'chart', 'proposal', 'routine', 'scene', 'image', 'table', 'map', 'timeline', 'widget']),
        data: z.record(z.string(), z.unknown()),
      })
    )
    .default([]),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()) }))
    .default([]),
  toolCallId: z.string().nullable().default(null),
  /** Wall-clock and token cost, shown in the drawer so autonomy is never a black box. */
  usage: z
    .object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), costUsd: z.number().optional(), latencyMs: z.number().optional() })
    .nullable()
    .default(null),
  createdAt: z.iso.datetime(),

  // What the interface shows around an answer. Optional: a user message has none of it,
  // and messages saved before the trace existed have none either.
  trace: z.array(agentTraceEntrySchema).optional(),
  sources: z.array(agentSourceSchema).optional(),
  context: z.array(agentContextItemSchema).optional(),
  questions: z.array(agentQuestionSchema).optional(),
  pending: agentPendingCommandSchema.optional(),
  /** The handles to take back what the run did, and to approve what it only proposed. */
  actions: z.object({ undoIds: z.array(z.string()), proposalIds: z.array(z.string()) }).optional(),
  feedback: z.enum(['up', 'down']).nullable().optional(),
  model: z.object({ provider: z.string(), model: z.string() }).optional(),
  /** The person left before the run finished: what is here is what was done. */
  interrupted: z.boolean().optional(),
})
export type AgentMessage = z.infer<typeof agentMessageSchema>

/** The part of a message kept in its `meta` column. */
export const AGENT_MESSAGE_META_KEYS = ['trace', 'sources', 'context', 'questions', 'pending', 'actions', 'feedback', 'model', 'interrupted'] as const
export type AgentMessageMeta = Pick<AgentMessage, (typeof AGENT_MESSAGE_META_KEYS)[number]>

export const proposalSchema = z.object({
  id: z.string(),
  summary: z.string(),
  reason: z.string(),
  risk: z.enum(RISK_ORDER),
  commands: z.array(
    z.object({
      deviceId: z.string(),
      deviceName: z.string(),
      command: z.string(),
      args: z.record(z.string(), z.unknown()).default({}),
    })
  ),
  routine: z.unknown().nullable().default(null),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'executed', 'failed']).default('pending'),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable().default(null),
})
export type Proposal = z.infer<typeof proposalSchema>

// ---------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------

export const MEMORY_KINDS = ['preference', 'fact', 'habit', 'person', 'place', 'correction', 'schedule'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export const memorySchema = z.object({
  id: z.string(),
  kind: z.enum(MEMORY_KINDS),
  /** One fact per row, in plain language, because that is what goes into the prompt. */
  content: z.string(),
  subjectType: z.enum(['device', 'area', 'person', 'house', 'routine']).default('house'),
  subjectId: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.7),
  /** Rises each time the memory proves useful, decays when contradicted. */
  strength: z.number().min(0).max(1).default(0.5),
  source: z.enum(['stated', 'observed', 'inferred', 'imported']).default('observed'),
  evidenceCount: z.number().int().min(0).default(1),
  lastUsedAt: z.iso.datetime().nullable().default(null),
  expiresAt: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type Memory = z.infer<typeof memorySchema>

// ---------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------

export interface AgentTool<TArgs extends z.ZodType = z.ZodType> {
  name: string
  description: string
  parameters: TArgs
  risk: RiskLevel
  /** A read-only tool never needs approval and never enters the undo stack. */
  readOnly: boolean
  execute(args: z.infer<TArgs>, context: AgentToolContext): Promise<AgentToolResult>
}

export interface AgentToolContext {
  conversationId: string
  correlationId: string
  autonomy: AutonomyLevel
  /** Set when the tool runs inside a routine rather than a chat. */
  unattended: boolean
  userId: string | null
  signal: AbortSignal
}

export interface AgentToolResult {
  ok: boolean
  /** Compact text the model reads back. Keep it small: it is re-sent every turn. */
  summary: string
  data?: unknown
  /** Cards to render in the chat next to the reply. */
  attachments?: AgentMessage['attachments']
  /** Filled when the tool changed something, so ⌘Z and the timeline both work. */
  undo?: { deviceId: string; command: string; args: Record<string, unknown> }[]
  /** Returned instead of acting when the tool's risk exceeds the autonomy ceiling. */
  proposal?: Omit<Proposal, 'id' | 'status' | 'createdAt' | 'expiresAt' | 'decidedAt'>
  /** Questions for the person: the run ends on them and waits for the answer. */
  questions?: AgentQuestion[]
}

export const agentSettingsSchema = z.object({
  autonomy: z.enum(AUTONOMY_LEVELS).default(DEFAULT_AUTONOMY),
  /** Wake word, voice, language, and whether audio ever leaves the machine. */
  voice: z
    .object({
      enabled: z.boolean().default(true),
      wakeWord: z.string().default('hey jarvis'),
      wakeWordEnabled: z.boolean().default(false),
      sttProvider: z.string().default('local-whisper'),
      ttsProvider: z.string().default('local-kokoro'),
      ttsVoice: z.string().default('af_heart'),
      language: z.string().default('fr'),
      speakReplies: z.boolean().default(true),
    })
    .prefault({}),
  llm: z
    .object({
      provider: z.string().default('none'),
      model: z.string().default(''),
      temperature: z.number().min(0).max(2).default(0.3),
      maxSteps: z.number().int().min(1).max(30).default(12),
      /** Hard cap so an autonomous loop cannot run up a bill overnight. */
      dailyBudgetUsd: z.number().min(0).default(2),
    })
    .prefault({}),
  privacy: z
    .object({
      /** When on, no adapter and no model may reach the internet. Everything local. */
      localOnly: z.boolean().default(false),
      shareDeviceNames: z.boolean().default(true),
      retainTranscriptsDays: z.number().int().min(0).max(3650).default(30),
      retainAudio: z.boolean().default(false),
    })
    .prefault({}),
  proactivity: z
    .object({
      suggestRoutines: z.boolean().default(true),
      suggestOnNewDevice: z.boolean().default(true),
      dailyBriefing: z.boolean().default(true),
      briefingTime: z.string().default('08:00'),
      maxUnpromptedActionsPerHour: z.number().int().min(0).max(60).default(6),
      quietHours: z.tuple([z.string(), z.string()]).default(['22:30', '07:00']),
    })
    .prefault({}),
})
export type AgentSettings = z.infer<typeof agentSettingsSchema>
