/**
 * Working on a selected passage: explain it, shorten it, rephrase it, translate it, or do
 * what the person typed.
 *
 * With a model it is one short call with no tools - the passage is text to work on, not a
 * request to act on the house. Without one, the two things that need no model still work:
 * shortening keeps the first sentence, and explaining names the devices the passage mentions
 * from what the hub knows about them right now.
 */

import { stripRichText } from '@sway-home/shared'
import type { ModelProvider } from '#agent/providers'
import { deviceRepository } from '#repositories/device_repository'
import { places } from '#repositories/store'
import { normalise } from '#agent/language'

export const REWRITE_ACTIONS = ['explain', 'shorten', 'rephrase', 'translate', 'custom'] as const
export type RewriteAction = (typeof REWRITE_ACTIONS)[number]

export interface RewriteResult {
  ok: boolean
  text?: string
  error?: string
}

export const MAX_PASSAGE = 2000
export const MAX_INSTRUCTION = 300
const SHORT = 120

export const NEEDS_MODEL = 'Il faut un modèle pour cela : branchez-en un dans Réglages > Assistant.'

export const REWRITE_INSTRUCTIONS: Record<RewriteAction, string> = {
  explain: "Explique simplement ce passage à quelqu'un qui n'est pas technicien, en deux phrases au plus, en français. Pas de markdown.",
  shorten: 'Raccourcis ce passage en gardant le sens, en une phrase si possible, dans la même langue. Pas de markdown.',
  rephrase: 'Reformule ce passage plus clairement, sans le rallonger, dans la même langue. Pas de markdown.',
  translate: "Traduis ce passage en anglais s'il est en français, en français sinon. Réponds seulement par la traduction.",
  custom: 'Applique la consigne au passage. Réponds seulement par le résultat, sans markdown ni commentaire.',
}

/** The passage as the model reads it: chips reduced to their words, bounded. */
export function rewriteInput(text: string, action: RewriteAction, prompt?: string): string {
  const passage = stripRichText(text).slice(0, MAX_PASSAGE)
  if (action !== 'custom') return passage
  return `Consigne : ${(prompt ?? '').trim().slice(0, MAX_INSTRUCTION)}\n\nPassage : ${passage}`
}

/** The first sentence, or the passage cut at a word near 120 characters. */
export function shortenOffline(text: string): string {
  const plain = stripRichText(text).trim()
  const sentence = /^.+?[.!?](?=\s|$)/.exec(plain)?.[0]
  if (sentence && sentence.length < plain.length) return sentence
  if (plain.length <= SHORT) return plain
  const cut = plain.slice(0, SHORT)
  const space = cut.lastIndexOf(' ')
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}...`
}

const NOUN: Record<string, { word: string; feminine: boolean }> = {
  light: { word: 'lumière', feminine: true },
  outlet: { word: 'prise', feminine: true },
  switch: { word: 'interrupteur', feminine: false },
  climate: { word: 'thermostat', feminine: false },
  sensor: { word: 'capteur', feminine: false },
  lock: { word: 'serrure', feminine: true },
  cover: { word: 'volet', feminine: false },
  camera: { word: 'caméra', feminine: true },
  media: { word: 'lecteur', feminine: false },
  speaker: { word: 'enceinte', feminine: true },
}

const DECIMAL = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })

function stateWords(state: Record<string, unknown>, feminine: boolean): string | null {
  const e = feminine ? 'e' : ''
  if (typeof state.locked === 'boolean') return state.locked ? `verrouillé${e}` : `déverrouillé${e}`
  if (typeof state.on === 'boolean') return state.on ? `allumé${e}` : `éteint${e}`
  const temperature = state.currentTemperature ?? state.temperature
  if (typeof temperature === 'number') return `à ${DECIMAL.format(temperature)} °C`
  if (typeof state.position === 'number') return `ouvert${e} à ${state.position} %`
  return null
}

/** What the hub knows about each device a passage names; null when it names none. */
export function explainOffline(text: string): string | null {
  const plain = normalise(stripRichText(text))
  const areas = places.areas()
  const named = deviceRepository
    .all({ limit: 500 })
    .filter((device) => !device.hidden && normalise(device.name).length >= 4 && plain.includes(normalise(device.name)))
    .sort((a, b) => b.name.length - a.name.length)
    .slice(0, 3)
  if (named.length === 0) return null

  return named
    .map((device) => {
      const noun = NOUN[device.category] ?? { word: 'appareil', feminine: false }
      const area = device.areaId ? areas.find((candidate) => candidate.id === device.areaId)?.name : null
      const state = device.online ? stateWords(device.state, noun.feminine) : 'hors ligne'
      return `${device.name}${area ? ` (${area})` : ''} : ${noun.word}${state ? ` ${state}` : ''} en ce moment.`
    })
    .join(' ')
}

export async function rewriteWithModel(provider: ModelProvider, text: string, action: RewriteAction, prompt?: string): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number; costUsd: number } }> {
  const response = await provider.chat({
    messages: [
      { role: 'system', content: REWRITE_INSTRUCTIONS[action] },
      { role: 'user', content: rewriteInput(text, action, prompt) },
    ],
    temperature: 0.3,
    maxTokens: 400,
  })
  return { text: response.content.trim(), usage: response.usage }
}
