/**
 * Types and pure helpers for <AiPromptBar> (Beautiful UI's PromptBar, source 07).
 */

export type PromptBarVariant = 'Rounded' | 'Pill'
export const PROMPT_BAR_VARIANTS: PromptBarVariant[] = ['Rounded', 'Pill']

export type PromptBarMentionKind = 'device' | 'area' | 'scene' | 'routine'

/** an @ mention target: a device, a room, a scene or a routine */
export interface PromptBarMention {
  id: string
  label: string
  kind: PromptBarMentionKind
  icon?: string
  hint?: string
}

/** a / slash command row. `label` carries the leading slash, e.g. "/scene" */
export interface PromptBarCommand {
  id: string
  label: string
  hint?: string
  icon?: string
}

/** a model choice in the picker. `celebrate` plays the glimm rainbow sweep when picked. */
export interface PromptBarModel {
  id: string
  label: string
  hint?: string
  group?: string
  /** plays the rainbow glimm sweep across the composer when this model is picked (flagship launch) */
  celebrate?: boolean
  /** shown but not pickable: `hint` then says why (a missing key, a runner that does not answer) */
  disabled?: boolean
}

export type PromptBarDictationState = 'idle' | 'listening' | 'unavailable'

/** a file attached to the draft, shown as a removable chip */
export interface PromptBarFile {
  id: string
  name: string
  /** the underlying browser File, when the chip came from a real file picker */
  file?: File
}

export interface PromptBarSubmitPayload {
  text: string
  mentions: PromptBarMention[]
  command: PromptBarCommand | null
  files: PromptBarFile[]
  model: PromptBarModel | null
}

/** default icon per mention kind, used when a mention does not carry its own */
export const PROMPT_BAR_MENTION_ICON: Record<PromptBarMentionKind, string> = {
  device: 'ph:lightbulb',
  area: 'ph:door-open',
  scene: 'ph:sparkle',
  routine: 'ph:flow-arrow',
}

export interface PromptBarToken {
  kind: 'at' | 'slash'
  query: string
  /** index in the draft where the token (the @ or / itself) starts */
  start: number
}

/** the last @word or /word being typed at the end of the draft, if any */
export function promptBarParseToken(draft: string): PromptBarToken | null {
  const match = /(^|\s)([@/])([\w-]*)$/.exec(draft)
  if (!match) return null
  return {
    kind: match[2] === '@' ? 'at' : 'slash',
    query: (match[3] ?? '').toLowerCase(),
    start: match.index + (match[1]?.length ?? 0),
  }
}

/** accent-insensitive substring match, so "@ecl" finds "Éclairage salon" */
export function promptBarMatches(label: string, query: string): boolean {
  if (!query) return true
  const fold = (value: string) => value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
  return fold(label).includes(fold(query))
}
