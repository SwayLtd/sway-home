/**
 * Types and pure helpers for AiFineTuneCard - compact interactive fine tuning: scrub-able
 * number fields and select fields (menu or segmented), exactly as the source's controls
 * (Beautiful UI).
 */

export type FineTuneOption = { value: string; label: string; icon?: string }

export type FineTuneNumberField = {
  key: string
  kind: 'number'
  label: string
  /** The field's baseline value - also used to detect whether it has been edited. */
  value: number
  min: number
  max: number
  step?: number
  unit?: string
}

export type FineTuneSelectField = {
  key: string
  kind: 'select'
  label: string
  value: string
  options: FineTuneOption[]
  /** 'menu' - a glide-menu dropdown (default). 'segment' - an icon/label segmented control. */
  display?: 'menu' | 'segment'
  placeholder?: string
}

export type FineTuneField = FineTuneNumberField | FineTuneSelectField
export type FineTuneValues = Record<string, number | string>

export type FineTuneCardLabels = {
  title: string
  edited: string
  adjust: string
  placeholder: string
}

export const FINE_TUNE_CARD_DEFAULT_LABELS: FineTuneCardLabels = {
  title: 'Réglages',
  edited: 'Modifié',
  adjust: 'Ajuster',
  placeholder: 'Choisir',
}

/**
 * Rounds to the nearest multiple of `step`, then clamps to [min, max]. Generalizes the
 * source's `Math.round`, which only ever saw integer steps, to fractional steps too
 * (0.5 degrees, 0.5 second transitions) while staying identical when step is 1.
 */
export function fineTuneClamp(value: number, min: number, max: number, step: number): number {
  const size = step > 0 ? step : 1
  const stepped = Math.round(value / size) * size
  const bounded = Math.min(max, Math.max(min, stepped))
  const decimals = (String(size).split('.')[1] ?? '').length
  return Number(bounded.toFixed(decimals))
}

/** The fields' own values, used as the baseline an uncontrolled card starts from and edits are compared to. */
export function fineTuneBaseline(fields: FineTuneField[]): FineTuneValues {
  return Object.fromEntries(fields.map((field) => [field.key, field.value]))
}
