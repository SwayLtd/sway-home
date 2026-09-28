/**
 * AiRecommendationCard - types and pure helpers (Beautiful UI).
 *
 * A routine suggestion from the hub, with alternatives (another trigger: time, sunrise,
 * motion...). Picking an alternative in the drawer promotes it to the recommendation; the
 * primary action confirms it.
 */

import type { ChipTone } from '@sway-home/shared/rich_text'

/** Matches AiButton's own variant union (not exported from Button.vue), so a CTA can ask for
 *  any of them - accent for a high-confidence pick, primary for one that needs a look first. */
export type RecommendationCardCtaVariant = 'primary' | 'secondary' | 'ghost' | 'accent' | 'success' | 'quiet'

/**
 * One piece of an option's body when it needs more than plain text: `entity` is an
 * AiEntityChip (a named device, person or place), `value` is an AiValuePill (a bare tinted
 * value), `emphasis` is bold ink text, matching the source's literal JSX mix of the two atoms
 * and a styled span.
 */
export type RecommendationCardSegment =
  | { kind: 'text'; text: string }
  | { kind: 'emphasis'; text: string }
  | { kind: 'entity'; name: string; color?: string; monogram?: string }
  | { kind: 'value'; text: string; tone?: 'neutral' | 'green' | 'orange' | 'red' | 'accent' }

/** A plain string may carry [[ph:icon|text|tone]] chips (see @sway-home/shared/rich_text);
 *  an array of segments reaches the entity/value/emphasis cases the chip syntax cannot. */
export type RecommendationCardBody = string | RecommendationCardSegment[]

/** AiValuePill has no blue "info" tone (Sway never hard-codes blue): a body string's rich
 *  chips map onto the five tones it does have, same rule as AiStreamingText's own chips. */
export const RECOMMENDATION_CARD_CHIP_TONE: Record<ChipTone, 'neutral' | 'green' | 'orange' | 'red' | 'accent'> = {
  default: 'accent',
  ok: 'green',
  warn: 'orange',
  alert: 'red',
  info: 'neutral',
}

export type RecommendationCardOption = {
  id: string
  title: string
  body: RecommendationCardBody
  /** 0..1; omitted reads as "no signal", exactly like the source's unscored fallback option. */
  confidence?: number
  cta: string
  ctaVariant?: RecommendationCardCtaVariant
}

export type RecommendationCardLabels = {
  alternatives: string
  otherOptions: string
  accepted: string
  dismiss: string
}

export const RECOMMENDATION_CARD_DEFAULT_LABELS: RecommendationCardLabels = {
  alternatives: 'Alternatives',
  otherOptions: 'Autres options',
  accepted: 'Acceptée',
  dismiss: 'Ignorer la suggestion',
}

/** The confidence meter lights 0..3 bars, the same three steps the source's fixed
 *  high/review/none options show. */
export function recommendationCardBars(confidence: number | undefined): number {
  if (typeof confidence !== 'number') return 0
  return Math.max(0, Math.min(3, Math.round(confidence * 3)))
}

export function recommendationCardTone(confidence: number | undefined): string {
  if (typeof confidence !== 'number') return 'var(--ink-3)'
  if (confidence >= 0.7) return 'var(--green)'
  if (confidence >= 0.34) return 'var(--orange)'
  return 'var(--ink-3)'
}

export function recommendationCardConfidenceLabel(confidence: number | undefined): string {
  if (typeof confidence !== 'number') return 'Sans signal'
  if (confidence >= 0.7) return 'Confiance élevée'
  if (confidence >= 0.34) return 'À vérifier'
  return 'Signal faible'
}
