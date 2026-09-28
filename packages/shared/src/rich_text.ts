/**
 * Sentences with values set in them: `[[ph:icon|text]]` and `[[ph:icon|text|tone]]`.
 *
 * The assistant's answer stays one sentence, but the values in it - a wattage, a
 * temperature, the name of the device that is misbehaving - are set as small rounded chips
 * with an icon, so the eye finds them without the sentence turning into a table.
 *
 * The rules that make it safe to let a model write this:
 *
 *  - It parses to *segments*, plain data. Nothing is ever interpreted as HTML: a chip's text
 *    is text, and a renderer that interpolates it cannot be tricked into markup.
 *  - The icon must look like a Phosphor icon name (`ph:` plus lowercase words). Anything else
 *    leaves the token as literal text, so a malformed chip degrades to readable characters
 *    rather than to a blank.
 *  - `stripRichText` gives the spoken form. Voice output never reads the markup.
 */

export type ChipTone = 'default' | 'ok' | 'warn' | 'alert' | 'info'

export type RichSegment = { kind: 'text'; text: string } | { kind: 'chip'; icon: string; text: string; tone: ChipTone }

const TONES: ReadonlySet<string> = new Set<ChipTone>(['default', 'ok', 'warn', 'alert', 'info'])
const ICON = /^ph:[a-z0-9]+(?:-[a-z0-9]+)*$/
const TOKEN = /\[\[(ph:[a-z0-9-]+)\|([^|\]\n]{1,60})(?:\|([a-z]{1,12}))?\]\]/g
const MAX_CHIP_TEXT = 60

export function parseRichText(input: string): RichSegment[] {
  const segments: RichSegment[] = []
  let cursor = 0

  for (const match of input.matchAll(TOKEN)) {
    const [whole, icon, text, tone] = match
    if (!icon || !text || !ICON.test(icon)) continue
    const start = match.index ?? 0
    if (start > cursor) segments.push({ kind: 'text', text: input.slice(cursor, start) })
    segments.push({ kind: 'chip', icon, text, tone: tone && TONES.has(tone) ? (tone as ChipTone) : 'default' })
    cursor = start + whole.length
  }

  if (cursor < input.length) segments.push({ kind: 'text', text: input.slice(cursor) })
  return mergeText(segments)
}

/** The sentence as it is spoken: every chip replaced by its text. */
export function stripRichText(input: string): string {
  return parseRichText(input)
    .map((segment) => segment.text)
    .join('')
}

/**
 * One chip token, built safely. The text is cleaned of the characters that delimit a token,
 * so a device called "Lampe | ]] bizarre" cannot close the chip early and spill markup into
 * the sentence. An invalid icon returns the bare text: better no chip than a broken one.
 */
export function chip(icon: string, text: string, tone: ChipTone = 'default'): string {
  const clean = text.replace(/[|\]\[\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  const short = clean.length > MAX_CHIP_TEXT ? `${clean.slice(0, MAX_CHIP_TEXT - 3).trimEnd()}...` : clean
  if (!ICON.test(icon) || short.length === 0) return short
  return tone === 'default' ? `[[${icon}|${short}]]` : `[[${icon}|${short}|${tone}]]`
}

/** Adjacent text segments are merged, so a skipped malformed token does not split a phrase. */
function mergeText(segments: RichSegment[]): RichSegment[] {
  const out: RichSegment[] = []
  for (const segment of segments) {
    const last = out.at(-1)
    if (segment.kind === 'text' && last?.kind === 'text') last.text += segment.text
    else out.push({ ...segment })
  }
  return out
}
