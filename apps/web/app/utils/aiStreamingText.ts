/**
 * AiStreamingText - types and pure helpers (Beautiful UI).
 *
 * The component receives one finished answer and, when `animate` is true, plays it back
 * word by word the way the source streams tokens in. Rich chips ([[ph:icon|text|tone]], see
 * @sway-home/shared/rich_text) and citation markers ([[cite:<sourceId>]]) are parsed once
 * into a flat token list here, so the component's reveal loop only ever counts array items.
 */

import { parseRichText, stripRichText, type ChipTone } from '@sway-home/shared/rich_text'

/** One source cited inline and listed under the answer. */
export type StreamingTextSource = {
  id: string
  title: string
  subtitle?: string
  /** Phosphor icon name, used when there is no image. */
  icon?: string
  image?: string
  href?: string
  kind?: 'device' | 'memory' | 'routine' | 'scene' | 'sensor' | 'doc' | 'web' | (string & {})
}

/** One follow-up prompt offered once the answer is done. */
export type StreamingTextFollowUp = {
  text: string
  icon?: string
}

export type StreamingTextFeedback = 'up' | 'down' | null

export type StreamingTextLabels = {
  /** heading above the follow-up prompts */
  followUps: string
}

/** One item the reveal loop counts through, in reading order. */
export type StreamingTextToken =
  | { kind: 'word'; text: string }
  /** A line break the answer was written with: one ends a line, two end a paragraph. */
  | { kind: 'break'; paragraph: boolean }
  | { kind: 'chip'; icon: string; text: string; tone: ChipTone }
  | { kind: 'cite'; sourceId: string }

/** Delay between two words resolving out of blur, as in the source. */
export const STREAMING_TEXT_WORD_MS = 55

/** AiValuePill has no blue "info" tone - Sway never hard-codes blue - so the five rich-text
 *  tones map onto the five it does have. `default` reads as the same amber highlight
 *  RichText.vue already gives it elsewhere in the app. */
export type StreamingTextChipTone = 'neutral' | 'green' | 'orange' | 'red' | 'accent'
export const STREAMING_TEXT_CHIP_TONE: Record<ChipTone, StreamingTextChipTone> = {
  default: 'accent',
  ok: 'green',
  warn: 'orange',
  alert: 'red',
  info: 'neutral',
}

const KIND_ICON: Record<string, string> = {
  device: 'ph:cpu',
  memory: 'ph:brain',
  routine: 'ph:flow-arrow',
  scene: 'ph:sparkle',
  sensor: 'ph:gauge',
  doc: 'ph:file-text',
  web: 'ph:globe',
}

/** Best-effort Phosphor icon for a source that carries no image. */
export function streamingTextSourceIcon(source: StreamingTextSource): string {
  return source.icon ?? KIND_ICON[source.kind ?? ''] ?? 'ph:link'
}

/** "1 source" / "3 sources", the way the collapsed toggle reads it. */
export function streamingTextSourcesLabel(count: number): string {
  return count <= 1 ? `${count} source` : `${count} sources`
}

const CITE = /\[\[cite:([a-zA-Z0-9_-]+)\]\]/g

function pushWords(tokens: StreamingTextToken[], text: string): void {
  for (const piece of text.split(/(\s+)/)) {
    if (!piece) continue
    if (!/^\s+$/.test(piece)) {
      tokens.push({ kind: 'word', text: piece })
      continue
    }
    // A list or a second paragraph keeps its shape: the reveal counts words, not lines.
    const newlines = piece.split('\n').length - 1
    if (newlines > 0 && tokens.length > 0) tokens.push({ kind: 'break', paragraph: newlines > 1 })
  }
}

/** Accent- and case-insensitive words, for matching a source's name in the answer. */
function foldWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * Where a source is named: right after the sentence that first names it. Sources the text
 * never names get no inline citation and stay in the list under the answer, which is more
 * honest than pinning them to a sentence they do not support.
 */
function citeMentions(tokens: StreamingTextToken[], sources: StreamingTextSource[]): StreamingTextToken[] {
  const words = tokens.map((token) => (token.kind === 'word' ? foldWord(token.text) : null))
  const inserts = new Map<number, string[]>()

  for (const source of sources) {
    const title = source.title.split(/\s+/).map(foldWord).filter(Boolean)
    if (title.length === 0) continue
    let found = -1
    for (let start = 0; start + title.length <= words.length && found === -1; start++) {
      if (title.every((word, offset) => words[start + offset] === word)) found = start + title.length - 1
    }
    if (found === -1) continue

    // The end of that sentence: the next word closing it, a line break, or the end.
    let end = found
    while (end < tokens.length - 1) {
      const token = tokens[end]!
      if (token.kind === 'break' || (token.kind === 'word' && /[.!?:;]$/.test(token.text))) break
      end++
    }
    if (tokens[end]?.kind === 'break') end--
    inserts.set(end, [...(inserts.get(end) ?? []), source.id])
  }

  const out: StreamingTextToken[] = []
  tokens.forEach((token, index) => {
    out.push(token)
    for (const sourceId of inserts.get(index) ?? []) out.push({ kind: 'cite', sourceId })
  })
  return out
}

/**
 * Tokenize `text` into words, rich chips and citation markers, in reading order.
 *
 * A [[cite:id]] marker whose id is not in `sources` is left as literal text (split into
 * words like any other run), the same "degrade to readable characters" rule rich_text.ts
 * itself uses for a malformed chip. When the text carries no valid marker at all, one
 * citation for the first source is inserted after the first sentence, matching the source's
 * single always-present citation (or, with `autoCite`, after the sentences naming them).
 * Line breaks come through as `break` tokens.
 */
export function streamingTextTokenize(
  text: string,
  sources: StreamingTextSource[] = [],
  options: {
    /**
     * Where citations go when the text carries no marker: `first` puts the first source after
     * the first sentence, like the kit's demo; `mentions` cites each source after the sentence
     * naming it; `none` leaves them to the list under the answer.
     */
    autoCite?: 'first' | 'mentions' | 'none'
  } = {}
): StreamingTextToken[] {
  const tokens: StreamingTextToken[] = []
  let citeSeen = false

  for (const segment of parseRichText(text)) {
    if (segment.kind === 'chip') {
      tokens.push({ kind: 'chip', icon: segment.icon, text: segment.text, tone: segment.tone })
      continue
    }

    let cursor = 0
    for (const match of segment.text.matchAll(CITE)) {
      const sourceId = match[1]
      const start = match.index ?? 0
      const valid = sourceId && sources.some((source) => source.id === sourceId)
      if (!valid) continue
      pushWords(tokens, segment.text.slice(cursor, start))
      tokens.push({ kind: 'cite', sourceId: sourceId! })
      citeSeen = true
      cursor = start + match[0].length
    }
    pushWords(tokens, segment.text.slice(cursor))
  }

  const autoCite = options.autoCite ?? 'first'
  if (!citeSeen && autoCite === 'mentions') return citeMentions(tokens, sources)
  if (!citeSeen && autoCite === 'first' && sources[0]) {
    const first = sources[0]
    let insertAt = tokens.findIndex((token) => token.kind === 'word' && /[.!?]$/.test(token.text))
    if (insertAt === -1) insertAt = tokens.length - 1
    tokens.splice(insertAt + 1, 0, { kind: 'cite', sourceId: first.id })
  }

  return tokens
}

/** The answer as plain speech: chips read as their text, citation markers disappear.
 *  Used for the copy action. */
export function streamingTextPlainText(text: string): string {
  return stripRichText(text).replace(CITE, '').replace(/\s+/g, ' ').trim()
}
