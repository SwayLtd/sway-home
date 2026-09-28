/**
 * What the composer adds to a question: `@` mentions and `/` commands.
 *
 * A mention designates one thing of the house. The person reads a name; the model gets the
 * name and the short id its tools take, so "@Plafonnier salon" can never be confused with the
 * other ceiling light. A command is a shortcut the menu offers under `/`: the fixed ones
 * (start over, undo, a briefing, everything off, a scan), then one per scene, per active
 * routine and per house mode, built from the house as it is now.
 */

import { HOUSE_MODES } from '@sway-home/shared'
import { deviceRepository } from '#repositories/device_repository'
import { places, routines, scenes } from '#repositories/store'

export const MENTION_KINDS = ['device', 'area', 'scene', 'routine'] as const
export type MentionKind = (typeof MENTION_KINDS)[number]
export interface Mention {
  kind: MentionKind
  id: string
}

const MAX_MENTIONS = 8

/** Mentions as a page sends them: known kinds, string ids of a sane length, eight at most. */
export function parseMentions(input: unknown): Mention[] {
  if (!Array.isArray(input)) return []
  const out: Mention[] = []
  for (const entry of input) {
    if (out.length >= MAX_MENTIONS) break
    if (!entry || typeof entry !== 'object') continue
    const { kind, id } = entry as { kind?: unknown; id?: unknown }
    if (typeof kind !== 'string' || !(MENTION_KINDS as readonly string[]).includes(kind)) continue
    if (typeof id !== 'string' || id.length === 0 || id.length > 100) continue
    out.push({ kind: kind as MentionKind, id })
  }
  return out
}

const KIND_WORD: Record<MentionKind, string> = { device: 'appareil', area: 'pièce', scene: 'scène', routine: 'routine' }

function describe(mention: Mention): string | null {
  switch (mention.kind) {
    case 'device': {
      const device = deviceRepository.find(mention.id)
      return device ? `${device.name} (${KIND_WORD.device} ${device.id.slice(0, 8)})` : null
    }
    case 'area': {
      const area = places.areas().find((candidate) => candidate.id === mention.id)
      return area ? `${area.name} (${KIND_WORD.area})` : null
    }
    case 'scene': {
      const scene = scenes.all().find((candidate) => candidate.id === mention.id)
      return scene ? `${scene.name} (${KIND_WORD.scene} ${scene.id.slice(0, 8)})` : null
    }
    case 'routine': {
      const routine = routines.find(mention.id)
      return routine ? `${routine.name} (${KIND_WORD.routine} ${routine.id.slice(0, 8)})` : null
    }
  }
}

/** The line the model reads after the question; null when nothing designated still exists. */
export function mentionNote(mentions: Mention[]): string | null {
  const named = mentions.map(describe).filter((entry): entry is string => entry !== null)
  return named.length > 0 ? `Désignés par la personne : ${named.join(', ')}.` : null
}

// ---------------------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------------------

export type SlashRun =
  | { kind: 'prompt'; text: string }
  | { kind: 'action'; action: 'new_conversation' | 'undo' | 'scan' }
  | { kind: 'scene'; id: string }
  | { kind: 'routine'; id: string }

export interface SlashCommand {
  id: string
  label: string
  hint: string
  icon: string
  run: SlashRun
}

const MODE_LABEL: Record<(typeof HOUSE_MODES)[number], { label: string; icon: string }> = {
  home: { label: 'Maison', icon: 'ph:house' },
  away: { label: 'Absent', icon: 'ph:door' },
  night: { label: 'Nuit', icon: 'ph:moon' },
  guest: { label: 'Invités', icon: 'ph:users-three' },
  vacation: { label: 'Vacances', icon: 'ph:airplane-tilt' },
  party: { label: 'Soirée', icon: 'ph:confetti' },
  focus: { label: 'Focus', icon: 'ph:target' },
  cinema: { label: 'Cinéma', icon: 'ph:film-slate' },
  cleaning: { label: 'Ménage', icon: 'ph:broom' },
}

export function slashCommands(): SlashCommand[] {
  const fixed: SlashCommand[] = [
    { id: 'nouvelle', label: 'Nouvelle conversation', hint: 'Repartir de zéro', icon: 'ph:plus', run: { kind: 'action', action: 'new_conversation' } },
    { id: 'annuler', label: 'Annuler la dernière action', hint: 'Remet la maison comme avant', icon: 'ph:arrow-counter-clockwise', run: { kind: 'action', action: 'undo' } },
    { id: 'resume', label: 'Résumé de la maison', hint: "Ce qu'il faut savoir maintenant", icon: 'ph:house-line', run: { kind: 'prompt', text: 'Comment va la maison ?' } },
    { id: 'tout-eteindre', label: 'Tout éteindre', hint: 'Lumières et prises', icon: 'ph:power', run: { kind: 'prompt', text: 'Éteins tout' } },
    { id: 'scan', label: 'Scanner le réseau', hint: 'Chercher les nouveaux appareils', icon: 'ph:broadcast', run: { kind: 'action', action: 'scan' } },
  ]

  const sceneCommands: SlashCommand[] = scenes.all().map((scene) => ({
    id: `scene-${scene.id}`,
    label: `Scène ${scene.name}`,
    hint: 'Appliquer la scène',
    icon: 'ph:sparkle',
    run: { kind: 'scene', id: scene.id },
  }))

  const routineCommands: SlashCommand[] = routines
    .all('active')
    .filter((routine) => routine.enabled)
    .map((routine) => ({
      id: `routine-${routine.id}`,
      label: `Routine ${routine.name}`,
      hint: 'Lancer maintenant',
      icon: 'ph:flow-arrow',
      run: { kind: 'routine', id: routine.id },
    }))

  const modeCommands: SlashCommand[] = HOUSE_MODES.map((mode) => ({
    id: `mode-${mode}`,
    label: `Mode ${MODE_LABEL[mode].label}`,
    hint: 'Changer le mode de la maison',
    icon: MODE_LABEL[mode].icon,
    run: { kind: 'prompt', text: `Passe en mode ${MODE_LABEL[mode].label.toLowerCase()}` },
  }))

  return [...fixed, ...sceneCommands, ...routineCommands, ...modeCommands]
}
