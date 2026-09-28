/**
 * What may be written into a routine.
 *
 * A routine arrives from the editor, from the assistant, or from anything on the network
 * that speaks HTTP. It is checked against the shared schema before it is kept, so a trigger
 * of an unknown kind is refused when it is written rather than silently never fired, and the
 * answer names each problem in words, with where it is ("Déclencheur 2 : at, format
 * invalide"). The fields the hub owns - id, counters, authorship, the suggestion reason - are
 * never taken from the outside.
 */

import { actionSchema, conditionSchema, triggerSchema, type Action, type Condition, type Routine, type Trigger } from '@sway-home/shared'
import type { z } from 'zod'

export type RoutineInput = Pick<Routine, 'name' | 'description' | 'enabled' | 'mode' | 'status' | 'triggers' | 'conditions' | 'actions' | 'areaId'>

type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] }

const MODES = ['single', 'restart', 'queued', 'parallel'] as const
const CONDITION_KINDS = ['device_state', 'time_window', 'sun_position', 'presence', 'house_mode', 'area_occupied', 'numeric', 'and', 'or', 'not']

function kindsOf(union: unknown): string[] {
  const options = (union as { options?: { shape?: { kind?: { value?: unknown } } }[] }).options ?? []
  return options.map((option) => String(option.shape?.kind?.value ?? '')).filter(Boolean)
}

const TRIGGER_KINDS = kindsOf(triggerSchema)
const ACTION_KINDS = kindsOf(actionSchema)

function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.length > 0 ? `${issue.path.join('.')}, ` : ''
  const issueRecord = issue as unknown as { expected?: string; minimum?: number | bigint; maximum?: number | bigint }
  switch (issue.code) {
    case 'invalid_type':
      return `${where}attendu : ${issueRecord.expected ?? 'autre chose'}`
    case 'too_small':
      return `${where}trop petit (minimum ${String(issueRecord.minimum)})`
    case 'too_big':
      return `${where}trop grand (maximum ${String(issueRecord.maximum)})`
    case 'invalid_format':
      return `${where}format invalide`
    case 'invalid_value':
      return `${where}valeur non permise`
    case 'invalid_union':
      return `${where}forme invalide`
    default:
      return `${where}${issue.message}`
  }
}

/** Checks each entry of a list against its schema, naming the entry when it is wrong. */
function list<T>(value: unknown, label: string, schema: z.ZodType<T>, kinds: string[], errors: string[]): T[] {
  if (!Array.isArray(value)) {
    errors.push(`${label}s : liste attendue`)
    return []
  }
  const out: T[] = []
  value.forEach((entry, index) => {
    const kind = (entry as { kind?: unknown } | null)?.kind
    if (typeof kind !== 'string' || !kinds.includes(kind)) {
      errors.push(`${label} ${index + 1} : type inconnu (${typeof kind === 'string' ? kind : 'aucun'})`)
      return
    }
    const parsed = schema.safeParse(entry)
    if (parsed.success) out.push(parsed.data)
    else errors.push(`${label} ${index + 1} : ${parsed.error.issues.slice(0, 2).map(describeIssue).join(' ; ')}`)
  })
  return out
}

export function parseRoutineInput(body: unknown, options?: { partial?: false }): Result<RoutineInput>
export function parseRoutineInput(body: unknown, options: { partial: true }): Result<Partial<RoutineInput>>
export function parseRoutineInput(body: unknown, options: { partial?: boolean } = {}): Result<Partial<RoutineInput>> {
  const partial = options.partial === true
  const input = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const has = (key: string) => input[key] !== undefined
  const errors: string[] = []
  const value: Partial<RoutineInput> = {}

  if (!partial || has('name')) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) errors.push('Nom : obligatoire')
    else value.name = name.slice(0, 80)
  }

  if (!partial || has('description')) {
    const description = input.description
    if (description === undefined || description === null) value.description = null
    else if (typeof description === 'string') value.description = description.trim().slice(0, 400) || null
    else errors.push('Description : texte attendu')
  }

  if (!partial || has('enabled')) {
    if (input.enabled === undefined) value.enabled = true
    else if (typeof input.enabled === 'boolean') value.enabled = input.enabled
    else errors.push('Activée : oui ou non attendu')
  }

  if (!partial || has('mode')) {
    const mode = input.mode ?? 'single'
    if ((MODES as readonly unknown[]).includes(mode)) value.mode = mode as RoutineInput['mode']
    else errors.push(`Mode : inconnu (${String(mode)})`)
  }

  if (!partial || has('status')) {
    // A person creates a routine active or paused, and may archive one later. "Suggested" is
    // the hub's word for what it proposes, and is not written from the outside.
    const allowed = partial ? ['active', 'paused', 'archived'] : ['active', 'paused']
    const status = input.status ?? 'active'
    if (allowed.includes(String(status))) value.status = status as RoutineInput['status']
    else errors.push(`Statut : non permis (${String(status)})`)
  }

  if (!partial || has('triggers')) {
    const triggers = list<Trigger>(input.triggers ?? [], 'Déclencheur', triggerSchema as z.ZodType<Trigger>, TRIGGER_KINDS, errors)
    if (Array.isArray(input.triggers ?? []) && (input.triggers as unknown[] | undefined ?? []).length === 0) errors.push('Déclencheurs : au moins un')
    value.triggers = triggers
  }

  if (!partial || has('conditions')) {
    value.conditions = list<Condition>(input.conditions ?? [], 'Condition', conditionSchema, CONDITION_KINDS, errors)
  }

  if (!partial || has('actions')) {
    const actions = list<Action>(input.actions ?? [], 'Action', actionSchema as z.ZodType<Action>, ACTION_KINDS, errors)
    if (Array.isArray(input.actions ?? []) && (input.actions as unknown[] | undefined ?? []).length === 0) errors.push('Actions : au moins une')
    value.actions = actions
  }

  if (!partial || has('areaId')) {
    const areaId = input.areaId
    if (areaId === undefined || areaId === null) value.areaId = null
    else if (typeof areaId === 'string') value.areaId = areaId
    else errors.push('Pièce : identifiant attendu')
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value }
}
