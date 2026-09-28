/**
 * Where an answer comes from.
 *
 * Two things are shown next to an answer so it can be checked rather than believed:
 *
 *  - **Sources**: what the run read or acted on, derived from its own trace. A device, its
 *    history, the energy report, a scene, a memory it looked up. Each one links to the page
 *    it lives on, so "il fait 19,5 °C" can be traced to the thermostat that said it.
 *  - **Context**: the memories the assistant had in mind. Every run is given the strongest
 *    memories of the house; the ones that share words with the question, plus the ones it
 *    looked up itself, are the ones that shaped the answer, and they are marked as used.
 *
 * Both are computed from facts about the run. Nothing here asks the model what it used: a
 * model asked to cite itself cites what sounds right.
 */

import type { AgentContextItem, AgentSource, AgentTraceEntry, Memory } from '@sway-home/shared'
import { CATEGORY_ICON } from '@sway-home/shared/icons'
import { memories, places, routines, scenes } from '#repositories/store'
import { measureById, normalise } from '#agent/language'
import { resolveDevice } from '#agent/tools'

const MAX_SOURCES = 6
const MAX_CONTEXT = 5

/** Memories given to every run: the pool the context is chosen from. */
const PROMPT_MEMORIES = 25

// ---------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------

type ToolEntry = Extract<AgentTraceEntry, { kind: 'tool' }>

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function deviceSource(reference: unknown): AgentSource | null {
  const name = text(reference)
  const device = name ? resolveDevice(name) : null
  if (!device) return null
  const area = device.areaId ? places.areas().find((candidate) => candidate.id === device.areaId)?.name ?? null : null
  return {
    id: device.id,
    kind: 'device',
    title: device.name,
    subtitle: area,
    href: `/devices/${device.id}`,
    icon: CATEGORY_ICON[device.category] ?? CATEGORY_ICON.unknown ?? null,
  }
}

function measureLabel(attribute: string): string {
  return measureById(attribute)?.label ?? attribute
}

function historySource(deviceRef: unknown, attribute: string, hours: unknown): AgentSource | null {
  const device = deviceSource(deviceRef)
  if (!device) return null
  const span = typeof hours === 'number' ? `, ${hours} h` : ''
  return {
    ...device,
    id: `history:${device.id}:${attribute}`,
    kind: 'history',
    subtitle: `Historique ${measureLabel(attribute)}${span}`,
    icon: 'ph:chart-line',
  }
}

function areaSource(reference: unknown, subtitle: string | null = null): AgentSource | null {
  const value = text(reference)
  if (!value) return null
  const area = places.areas().find((candidate) => candidate.id === value || normalise(candidate.name) === normalise(value))
  if (!area) return null
  return { id: area.id, kind: 'area', title: area.name, subtitle, href: '/areas', icon: 'ph:house-line' }
}

function findByIdOrName<T extends { id: string; name: string }>(all: T[], reference: unknown): T | null {
  const value = text(reference)
  if (!value) return null
  return all.find((candidate) => candidate.id === value || candidate.id.startsWith(value) || normalise(candidate.name) === normalise(value)) ?? null
}

/** The sources one tool call stands for. Most calls are one source; a comparison is several. */
function sourcesOf(entry: ToolEntry): (AgentSource | null)[] {
  const args = entry.args
  switch (entry.name) {
    case 'get_device':
    case 'control_device':
      return [deviceSource(args.device)]

    case 'get_history':
      return [historySource(args.device, String(args.attribute ?? ''), args.hours)]

    case 'analyse_history': {
      const measure = String(args.measure ?? '')
      if (text(args.deviceId)) return [historySource(args.deviceId, measure, args.hours)]
      return [areaSource(args.areaId, `Historique ${measureLabel(measure)}`)]
    }

    case 'compare_history': {
      const measure = String(args.measure ?? '')
      const devices = Array.isArray(args.deviceIds) ? args.deviceIds.map((id) => historySource(id, measure, args.hours)) : []
      const areas = Array.isArray(args.areaIds) ? args.areaIds.map((id) => areaSource(id, `Historique ${measureLabel(measure)}`)) : []
      return [...devices, ...areas]
    }

    case 'list_devices':
      return [areaSource(args.area)]

    case 'get_energy':
      return [{ id: 'energy', kind: 'energy', title: 'Consommation', subtitle: typeof args.days === 'number' ? `${args.days} j` : null, href: '/energy', icon: 'ph:lightning' }]

    case 'get_timeline':
      return [{ id: 'timeline', kind: 'timeline', title: 'Journal', subtitle: null, href: '/timeline', icon: 'ph:clock-counter-clockwise' }]

    case 'list_alerts':
      return [{ id: 'alerts', kind: 'alert', title: 'Alertes', subtitle: null, href: '/timeline?filter=alerts', icon: 'ph:warning' }]

    case 'network_view':
    case 'scan_network':
      return [{ id: 'network', kind: 'network', title: 'Réseau', subtitle: null, href: '/network', icon: 'ph:wifi-high' }]

    case 'recall': {
      const query = text(args.query)
      if (!query) return []
      return memories.search(query, 3).map((memory) => ({
        id: memory.id,
        kind: 'memory' as const,
        title: memory.content.length > 60 ? `${memory.content.slice(0, 57).trimEnd()}...` : memory.content,
        subtitle: MEMORY_KIND_LABEL[memory.kind],
        href: '/memory',
        icon: 'ph:brain',
      }))
    }

    case 'activate_scene':
    case 'list_scenes': {
      const scene = findByIdOrName(scenes.all(), args.scene)
      if (!scene) return entry.name === 'list_scenes' ? [{ id: 'scenes', kind: 'scene', title: 'Scènes', subtitle: null, href: '/scenes', icon: 'ph:sparkle' }] : []
      return [{ id: scene.id, kind: 'scene', title: scene.name, subtitle: 'Scène', href: '/scenes', icon: 'ph:sparkle' }]
    }

    case 'run_routine':
    case 'set_routine_state':
    case 'list_routines': {
      const routine = findByIdOrName(routines.all(), args.routine)
      if (!routine) return entry.name === 'list_routines' ? [{ id: 'routines', kind: 'routine', title: 'Routines', subtitle: null, href: '/routines', icon: 'ph:flow-arrow' }] : []
      return [{ id: routine.id, kind: 'routine', title: routine.name, subtitle: 'Routine', href: '/routines', icon: 'ph:flow-arrow' }]
    }

    default:
      return []
  }
}

/** What a run read or acted on, first read first, each thing once, six at most. */
export function sourcesFromTrace(trace: AgentTraceEntry[]): AgentSource[] {
  const seen = new Set<string>()
  const out: AgentSource[] = []
  for (const entry of trace) {
    if (entry.kind !== 'tool' || entry.ok !== true) continue
    for (const source of sourcesOf(entry)) {
      if (!source) continue
      // A device read twice (looked at, then switched) is one source, not two.
      const key = `${source.kind}:${source.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(source)
      if (out.length >= MAX_SOURCES) return out
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------

export const MEMORY_KIND_LABEL: Record<Memory['kind'], string> = {
  preference: 'Préférence',
  fact: 'Fait',
  habit: 'Habitude',
  person: 'Personne',
  place: 'Lieu',
  correction: 'Correction',
  schedule: 'Horaire',
}

export const MEMORY_SOURCE_LABEL: Record<Memory['source'], string> = {
  stated: 'Dit par vous',
  observed: 'Observé',
  inferred: 'Déduit',
  imported: 'Importé',
}

/**
 * The small words that say nothing about the subject. Without them "est-ce que tu peux"
 * would match every memory containing "que".
 */
const STOPWORDS = new Set(
  (
    'les des une est que qui quoi dans pour avec sur sous pas plus moins par son sont ont aux ces cet cette mon ton mes tes ses nos vos leur leurs ' +
    'elle elles ils nous vous moi toi lui eux tout tous toute toutes quel quelle quels quelles comment combien quand pourquoi ' +
    'fait faire fais font mets met peux peut veux veut voudrais pourrais dois doit sais sait avoir etre etait ete suis ' +
    'alors aussi bien tres trop encore deja juste merci bonjour bonsoir salut stp svp dis dit donne montre ' +
    'the and for with what when where how that this from are was were have has you your can could would please'
  ).split(' ')
)

function words(value: string): string[] {
  return normalise(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    .map((word) => (word.length > 4 && /[sx]$/.test(word) ? word.slice(0, -1) : word))
}

/** Same word, or two forms of one ("chauffage", "chauffer") meeting on five letters. */
function related(a: string, b: string): boolean {
  if (a === b) return true
  let shared = 0
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1
  return shared >= 5
}

/**
 * The memories that share words with the question, best first. A memory about the salon in
 * the evening is relevant to "quelle température le soir au salon"; the one about the cat
 * is not, however strong it is.
 */
export function relevantMemories(question: string, candidates: Memory[], limit = MAX_CONTEXT): Memory[] {
  const asked = [...new Set(words(question))]
  if (asked.length === 0) return []

  return candidates
    .map((memory) => {
      const known = words(memory.content)
      const score = asked.filter((word) => known.some((candidate) => related(word, candidate))).length
      return { memory, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.strength - a.memory.strength || b.memory.confidence - a.memory.confidence)
    .slice(0, limit)
    .map((entry) => entry.memory)
}

function card(memory: Memory): AgentContextItem {
  return {
    id: memory.id,
    kind: 'memory',
    title: MEMORY_KIND_LABEL[memory.kind],
    excerpt: memory.content,
    confidence: memory.confidence,
    meta: MEMORY_SOURCE_LABEL[memory.source],
    href: '/memory',
  }
}

/**
 * The memories an answer was written with: those relevant to the question among the ones
 * the run was given, then the ones it looked up. Each is marked as used, which is what lets
 * the memory page tell a living memory from a forgotten one.
 */
export function contextFor(question: string, trace: AgentTraceEntry[]): AgentContextItem[] {
  const chosen = new Map<string, Memory>()
  for (const memory of relevantMemories(question, memories.forPrompt(PROMPT_MEMORIES))) chosen.set(memory.id, memory)

  for (const entry of trace) {
    if (entry.kind !== 'tool' || entry.name !== 'recall' || entry.ok !== true) continue
    const query = text(entry.args.query)
    if (!query) continue
    for (const memory of memories.search(query, 3)) chosen.set(memory.id, memory)
  }

  const picked = [...chosen.values()].slice(0, MAX_CONTEXT)
  for (const memory of picked) memories.used(memory.id)
  return picked.map(card)
}
