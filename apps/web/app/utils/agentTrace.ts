/**
 * What the assistant did, in words a person reads.
 *
 * The hub streams each step of a run (`thinking`, `tool_call`, `tool_result`, with the
 * provider's call ids) and keeps the settled trace with the answer. The same run is drawn
 * twice: live, as the Thinking trace while the answer is being written, then as ToolChips
 * folded above the answer. Both read their labels here, so a step does not change its name
 * when the answer lands.
 */

import type { AgentContextItem, AgentSource, AgentTraceEntry } from '@sway-home/shared/agent'
import type { ContextCardsItem } from '~/utils/aiContextCards'
import type { StreamingTextSource } from '~/utils/aiStreamingText'
import type { ThinkingRow } from '~/utils/aiThinking'
import type { ToolChipsStep } from '~/utils/aiToolChips'

/** One step of a live run, as `/agent/ask/stream` sends it. */
export type AgentLiveStep =
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: Record<string, unknown>; at: string }
  | { kind: 'tool_result'; id: string; name: string; summary: string; ok: boolean; durationMs: number }
  | { kind: 'error'; message: string }

/** The tools of the hub, as a person would name what they do. Icons are Phosphor names without the prefix. */
export const TOOL_META: Record<string, { label: string; icon: string }> = {
  list_devices: { label: 'Liste les appareils', icon: 'list-magnifying-glass' },
  get_device: { label: "Lit l'appareil", icon: 'cpu' },
  house_snapshot: { label: 'Fait le point sur la maison', icon: 'house-line' },
  get_history: { label: "Lit l'historique", icon: 'chart-line' },
  get_energy: { label: "Lit l'énergie", icon: 'lightning' },
  get_timeline: { label: 'Lit le journal', icon: 'clock-counter-clockwise' },
  list_routines: { label: 'Liste les routines', icon: 'flow-arrow' },
  list_scenes: { label: 'Liste les scènes', icon: 'sparkle' },
  network_view: { label: 'Regarde le réseau', icon: 'wifi-high' },
  recall: { label: 'Cherche dans la mémoire', icon: 'brain' },
  control_device: { label: 'Commande', icon: 'toggle-right' },
  control_many: { label: 'Commande plusieurs appareils', icon: 'squares-four' },
  activate_scene: { label: 'Applique la scène', icon: 'sparkle' },
  save_scene: { label: 'Enregistre la scène', icon: 'floppy-disk' },
  set_house_mode: { label: 'Change le mode', icon: 'house' },
  create_routine: { label: 'Écrit une routine', icon: 'flow-arrow' },
  run_routine: { label: 'Lance la routine', icon: 'play' },
  set_routine_state: { label: 'Change la routine', icon: 'pause' },
  remember: { label: 'Retient', icon: 'brain' },
  forget: { label: 'Oublie', icon: 'eraser' },
  notify: { label: 'Envoie une notification', icon: 'bell' },
  speak: { label: 'Parle', icon: 'speaker-high' },
  scan_network: { label: 'Scanne le réseau', icon: 'broadcast' },
  undo_last: { label: 'Annule la dernière action', icon: 'arrow-counter-clockwise' },
  suggest_routines: { label: 'Cherche des habitudes', icon: 'lightbulb' },
  list_alerts: { label: 'Lit les alertes', icon: 'warning' },
  who_is_home: { label: 'Regarde qui est là', icon: 'users' },
  assign_area: { label: 'Range dans une pièce', icon: 'door-open' },
  list_widgets: { label: 'Liste les cartes', icon: 'squares-four' },
  dashboard_vocabulary: { label: 'Lit le vocabulaire des cartes', icon: 'book-open' },
  show_widget: { label: 'Dessine une carte', icon: 'chart-bar' },
  analyse_history: { label: 'Analyse une courbe', icon: 'chart-line-up' },
  compare_history: { label: 'Compare des courbes', icon: 'arrows-left-right' },
  rank: { label: 'Classe', icon: 'ranking' },
  create_widget: { label: 'Épingle une carte', icon: 'push-pin' },
  update_widget: { label: 'Modifie une carte', icon: 'pencil-simple' },
  remove_widget: { label: 'Retire une carte', icon: 'trash' },
  announce: { label: 'Annonce', icon: 'megaphone' },
  get_autonomy: { label: "Lit l'autonomie", icon: 'steering-wheel' },
  set_autonomy: { label: "Change l'autonomie", icon: 'steering-wheel' },
  ask_user: { label: 'Pose une question', icon: 'question' },
}

export function toolMeta(name: string): { label: string; icon: string } {
  return TOOL_META[name] ?? { label: name.replaceAll('_', ' '), icon: 'wrench' }
}

/** Short enough for a chip or a trace line. */
function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat
}

/**
 * What a call acted on, in a few words: the device, the scene, the metric, the query. Ids
 * are turned into names with `nameOf`; anything unknown is left out rather than shown raw.
 */
export function toolSubject(args: Record<string, unknown>, nameOf: (id: string) => string | undefined): string | undefined {
  const names = (ids: unknown) =>
    (Array.isArray(ids) ? ids : [])
      .map((id) => (typeof id === 'string' ? nameOf(id) : undefined))
      .filter((name): name is string => Boolean(name))

  if (typeof args.deviceId === 'string') {
    const name = nameOf(args.deviceId)
    const command = typeof args.command === 'string' ? ` · ${args.command}` : ''
    if (name) return `${name}${command}`
  }
  const many = names(args.deviceIds)
  if (many.length > 0) return many.length > 2 ? `${many.slice(0, 2).join(', ')} +${many.length - 2}` : many.join(', ')
  for (const key of ['name', 'query', 'metric', 'mode', 'title', 'level', 'area', 'text', 'content']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return clip(value, 40)
  }
  return undefined
}

/** The live run, one row per step: a reasoning line, or a call and then what it returned. */
export function liveThinkingRows(steps: AgentLiveStep[], nameOf: (id: string) => string | undefined): ThinkingRow[] {
  const rows: ThinkingRow[] = []
  const byId = new Map<string, ThinkingRow>()
  for (const step of steps) {
    if (step.kind === 'thinking') {
      const row = { id: step.id, primary: clip(step.text, 140) }
      rows.push(row)
    } else if (step.kind === 'tool_call') {
      const row: ThinkingRow = { id: step.id, primary: toolMeta(step.name).label, secondary: toolSubject(step.args, nameOf) }
      byId.set(step.id, row)
      rows.push(row)
    } else if (step.kind === 'tool_result') {
      const row = byId.get(step.id)
      if (row) row.secondary = clip(step.summary, 60) || row.secondary
    }
  }
  return rows
}

/** The Thinking header of a live run: reasoning alone reads as prose, anything else as steps. */
export function liveThinkingVariant(steps: AgentLiveStep[]): 'Steps' | 'Reasoning' {
  return steps.some((step) => step.kind === 'tool_call') ? 'Steps' : 'Reasoning'
}

/** The settled trace, as ToolChips rows. A call that never answered was interrupted. */
export function traceToolSteps(trace: AgentTraceEntry[], nameOf: (id: string) => string | undefined): ToolChipsStep[] {
  return trace.map((entry) => {
    if (entry.kind === 'reasoning') {
      return { id: entry.id, icon: 'think', label: 'Réflexion', chip: clip(entry.text, 90), detail: [{ text: clip(entry.text, 400) }] }
    }
    const meta = toolMeta(entry.name)
    const subject = toolSubject(entry.args, nameOf)
    const seconds = entry.durationMs >= 1000 ? `${(entry.durationMs / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s` : `${entry.durationMs} ms`
    return {
      id: entry.id,
      icon: meta.icon,
      label: meta.label,
      chip: subject ?? (clip(entry.summary, 60) || undefined),
      status: entry.ok === true ? ('ok' as const) : ('failed' as const),
      detail: [
        { text: entry.ok === null ? "Interrompu avant de s'exécuter." : clip(entry.summary, 400), tone: entry.ok === false ? ('del' as const) : ('ctx' as const) },
        ...(entry.ok === null ? [] : [{ text: `Durée : ${seconds}`, tone: 'ctx' as const }]),
      ],
    }
  })
}

/** Sources, in the shape the answer cites them with. */
export function answerSources(sources: AgentSource[] | undefined): StreamingTextSource[] {
  return (sources ?? []).map((source) => ({
    id: source.id,
    title: source.title,
    subtitle: source.subtitle ?? undefined,
    href: source.href ?? undefined,
    icon: source.icon ?? undefined,
    kind: source.kind,
  }))
}

/** The memories and states the answer was written with, as context cards. */
export function answerContext(context: AgentContextItem[] | undefined): ContextCardsItem[] {
  return (context ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    excerpt: item.excerpt,
    meta: item.meta ?? undefined,
    score: item.confidence ?? undefined,
    href: item.href ?? undefined,
  }))
}
