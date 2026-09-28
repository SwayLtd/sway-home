/**
 * Routines: triggers, conditions, actions.
 *
 * The shape is JSON on purpose. The agent writes routines by emitting this object, a human
 * edits the same object in a visual builder, and both end up in the same table - so a
 * routine the agent proposed is reviewable, diffable and editable by hand, and a routine a
 * human wrote is readable by the agent. A DSL with its own syntax would have broken that.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------------------

export const triggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('device_state'),
    deviceId: z.string(),
    attribute: z.string(),
    operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'changed', 'changed_to', 'changed_from']),
    value: z.unknown().optional(),
    /** Must hold for this long before the routine fires. Kills flapping sensors. */
    forSeconds: z.number().int().min(0).max(86_400).default(0),
  }),
  z.object({
    kind: z.literal('device_event'),
    deviceId: z.string(),
    event: z.string(),
  }),
  z.object({
    kind: z.literal('capability_state'),
    /** Fires for any device with this capability, optionally narrowed to an area. */
    capability: z.string(),
    areaId: z.string().nullable().default(null),
    attribute: z.string(),
    operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'changed']),
    value: z.unknown().optional(),
    forSeconds: z.number().int().min(0).max(86_400).default(0),
  }),
  z.object({
    kind: z.literal('time'),
    /** 24h local time, `HH:MM`. */
    at: z.string().regex(/^\d{2}:\d{2}$/),
    days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).default([]),
  }),
  z.object({
    kind: z.literal('cron'),
    expression: z.string(),
  }),
  z.object({
    kind: z.literal('sun'),
    event: z.enum(['sunrise', 'sunset', 'dawn', 'dusk', 'solar_noon']),
    offsetMinutes: z.number().int().min(-720).max(720).default(0),
  }),
  z.object({
    kind: z.literal('presence'),
    personId: z.string().nullable().default(null),
    transition: z.enum(['arrives', 'leaves', 'first_arrives', 'last_leaves']),
  }),
  z.object({
    kind: z.literal('house_mode'),
    mode: z.string(),
  }),
  z.object({
    kind: z.literal('interval'),
    everySeconds: z.number().int().min(10).max(86_400),
  }),
  z.object({
    kind: z.literal('webhook'),
    token: z.string(),
  }),
  z.object({
    kind: z.literal('voice_intent'),
    phrase: z.string(),
  }),
  z.object({
    kind: z.literal('manual'),
  }),
])
export type Trigger = z.infer<typeof triggerSchema>

// ---------------------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------------------

const baseConditions = [
  z.object({
    kind: z.literal('device_state'),
    deviceId: z.string(),
    attribute: z.string(),
    operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'between']),
    value: z.unknown(),
  }),
  z.object({
    kind: z.literal('time_window'),
    after: z.string().regex(/^\d{2}:\d{2}$/),
    before: z.string().regex(/^\d{2}:\d{2}$/),
    days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).default([]),
  }),
  z.object({ kind: z.literal('sun_position'), state: z.enum(['above_horizon', 'below_horizon']) }),
  z.object({ kind: z.literal('presence'), personId: z.string().nullable().default(null), home: z.boolean() }),
  z.object({ kind: z.literal('house_mode'), modeIn: z.array(z.string()) }),
  z.object({ kind: z.literal('area_occupied'), areaId: z.string(), occupied: z.boolean() }),
  z.object({
    kind: z.literal('numeric'),
    /** A template such as `{{ device('salon-thermo').temperature }}`. */
    expression: z.string(),
    operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
    value: z.number(),
  }),
] as const

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    ...baseConditions,
    z.object({ kind: z.literal('and'), conditions: z.array(conditionSchema) }),
    z.object({ kind: z.literal('or'), conditions: z.array(conditionSchema) }),
    z.object({ kind: z.literal('not'), condition: conditionSchema }),
  ] as never)
)

export type Condition =
  | { kind: 'device_state'; deviceId: string; attribute: string; operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'between'; value: unknown }
  | { kind: 'time_window'; after: string; before: string; days: ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[] }
  | { kind: 'sun_position'; state: 'above_horizon' | 'below_horizon' }
  | { kind: 'presence'; personId: string | null; home: boolean }
  | { kind: 'house_mode'; modeIn: string[] }
  | { kind: 'area_occupied'; areaId: string; occupied: boolean }
  | { kind: 'numeric'; expression: string; operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'; value: number }
  | { kind: 'and'; conditions: Condition[] }
  | { kind: 'or'; conditions: Condition[] }
  | { kind: 'not'; condition: Condition }

// ---------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------

export const actionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('device_command'),
    /** One device, or a selector so a routine keeps working when a bulb is added. */
    deviceId: z.string().nullable().default(null),
    selector: z
      .object({
        areaId: z.string().nullable().default(null),
        capability: z.string().nullable().default(null),
        category: z.string().nullable().default(null),
        tag: z.string().nullable().default(null),
      })
      .nullable()
      .default(null),
    command: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({ kind: z.literal('scene'), sceneId: z.string() }),
  z.object({ kind: z.literal('delay'), seconds: z.number().min(0).max(86_400) }),
  z.object({
    kind: z.literal('notify'),
    message: z.string(),
    title: z.string().optional(),
    channel: z.enum(['push', 'web', 'speaker', 'email', 'all']).default('web'),
    priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  }),
  z.object({ kind: z.literal('speak'), text: z.string(), deviceId: z.string().nullable().default(null) }),
  z.object({ kind: z.literal('set_house_mode'), mode: z.string() }),
  z.object({ kind: z.literal('run_routine'), routineId: z.string() }),
  z.object({ kind: z.literal('webhook'), url: z.url(), method: z.enum(['GET', 'POST']).default('POST'), body: z.record(z.string(), z.unknown()).default({}) }),
  z.object({
    kind: z.literal('ask_agent'),
    /** Hands control to the LLM with a goal, inside the routine's permission envelope. */
    goal: z.string(),
    maxActions: z.number().int().min(1).max(20).default(5),
  }),
  z.object({ kind: z.literal('wait_until'), condition: z.custom<Condition>(), timeoutSeconds: z.number().int().min(1).max(3600).default(300) }),
  z.object({ kind: z.literal('stop'), reason: z.string().optional() }),
])
export type Action = z.infer<typeof actionSchema>

// ---------------------------------------------------------------------------------------
// Routine
// ---------------------------------------------------------------------------------------

/**
 * Another way to do what a suggested routine does: a different trigger, sometimes a
 * different condition. The actions stay; approving with an alternative replaces the parts it
 * carries.
 */
export const routineAlternativeSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  triggers: z.array(triggerSchema).optional(),
  conditions: z.array(z.custom<Condition>()).optional(),
  actions: z.array(actionSchema).optional(),
})
export type RoutineAlternative = z.infer<typeof routineAlternativeSchema>

export const routineSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  /** `restart` is what a motion light wants; `single` is what a coffee machine wants. */
  mode: z.enum(['single', 'restart', 'queued', 'parallel']).default('single'),
  triggers: z.array(triggerSchema).min(1),
  conditions: z.array(z.custom<Condition>()).default([]),
  actions: z.array(actionSchema).min(1),
  /** Set when the agent wrote it, so the UI can mark it and the human can review it. */
  authoredBy: z.enum(['user', 'agent', 'template', 'import']).default('user'),
  /** A routine the agent proposed but nobody approved yet does not run. */
  status: z.enum(['active', 'suggested', 'paused', 'archived']).default('active'),
  suggestionReason: z.string().nullable().default(null),
  /** How sure the hub is about a suggestion, between 0 and 1. */
  confidence: z.number().min(0).max(1).nullable().optional(),
  /** Other ways to do the same thing, offered next to a suggestion. */
  alternatives: z.array(routineAlternativeSchema).optional(),
  areaId: z.string().nullable().default(null),
  lastTriggeredAt: z.iso.datetime().nullable().default(null),
  runCount: z.number().int().min(0).default(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type Routine = z.infer<typeof routineSchema>

export const sceneSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable().default(null),
  areaId: z.string().nullable().default(null),
  /** Flat list of target states. Recalling a scene is a batch of device commands. */
  entries: z
    .array(
      z.object({
        deviceId: z.string(),
        endpointId: z.string().nullable().default(null),
        state: z.record(z.string(), z.unknown()),
        transitionMs: z.number().int().min(0).default(400),
      })
    )
    .default([]),
  authoredBy: z.enum(['user', 'agent', 'template', 'snapshot']).default('user'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type Scene = z.infer<typeof sceneSchema>

export const HOUSE_MODES = ['home', 'away', 'night', 'guest', 'vacation', 'party', 'focus', 'cinema', 'cleaning'] as const
export type HouseMode = (typeof HOUSE_MODES)[number]
