/**
 * What to ask next.
 *
 * Two or three short follow-ups under the last answer, above the text field. They are the
 * assistant showing what it can do *from here*: the other room after a reading, the week
 * after the month, "Annule" after a switch-off. The follow-up chip pattern's rules, which
 * are what keeps them from becoming clutter:
 *
 *  - tied to what was just said, not to the product in general;
 *  - three at most, never the question just asked;
 *  - each one a sentence the offline brain understands, so a tap answers at once - which
 *    is also why they are written out in full ("Il fait combien dans la chambre ?") rather
 *    than as elliptical follow-ups ("Et dans la chambre ?") only a model could resolve.
 *
 * Deterministic and model-free: they cost nothing, appear instantly, and cannot invent a
 * room the house does not have.
 */

import { AUTONOMY, isOutdoorArea } from '@sway-home/shared'
import { impliedTemperature, normalise, parseMeasure, parsePeriod } from '#agent/language'
import { findArea } from '#agent/intent_parser'
import { deviceRepository } from '#repositories/device_repository'
import { alerts, messages, places } from '#repositories/store'
import { autonomyEngine } from '#services/autonomy_engine'

export interface FollowUp {
  text: string
  icon: string
}

export interface FollowUpInput {
  /** The last thing the person asked, if anything. */
  question: string | null
  /** The tools that answered it, in order. */
  tools: string[]
  measure: string | null
  area: string | null
  /** The device command the answer ran, when it ran one. */
  command: string | null
  /** The last thing on screen was something the assistant did on its own. */
  after: 'reflex' | null
  /** Indoor rooms, and what they can measure. */
  areas: { name: string; measures: string[] }[]
  lightsOn: number
  openAlerts: number
  actsAlone: boolean
  hour: number
}

// ---------------------------------------------------------------------------------------
// French, for room names and measures
// ---------------------------------------------------------------------------------------

const GENDER: Record<string, 'le' | 'la'> = {
  salon: 'le',
  sejour: 'le',
  bureau: 'le',
  garage: 'le',
  jardin: 'le',
  couloir: 'le',
  grenier: 'le',
  balcon: 'le',
  cellier: 'le',
  dressing: 'le',
  chambre: 'la',
  cuisine: 'la',
  salle: 'la',
  cave: 'la',
  buanderie: 'la',
  terrasse: 'la',
  veranda: 'la',
  mezzanine: 'la',
  piece: 'la',
}

/** "Chambre" -> { article: 'la', noun: 'chambre' }; "Entrée" -> { article: "l'", noun: 'entrée' }. */
function room(name: string): { article: 'le' | 'la' | "l'" | null; noun: string } {
  const noun = name.charAt(0).toLowerCase() + name.slice(1)
  const first = normalise(name).split(' ')[0] ?? ''
  if (/^[aeiouyh]/.test(first)) return { article: "l'", noun }
  const article = GENDER[first]
  return article ? { article, noun } : { article: null, noun: name }
}

const theRoom = (name: string) => {
  const { article, noun } = room(name)
  return article === "l'" ? `l'${noun}` : article ? `${article} ${noun}` : noun
}
const inRoom = (name: string) => `dans ${theRoom(name)}`
const ofRoom = (name: string) => {
  const { article, noun } = room(name)
  if (article === 'le') return `du ${noun}`
  if (article === 'la') return `de la ${noun}`
  if (article === "l'") return `de l'${noun}`
  return `de ${noun}`
}

const MEASURE_WORDS: Record<string, { the: string; of: string; icon: string }> = {
  temperature: { the: 'la température', of: 'de température', icon: 'ph:thermometer-simple' },
  humidity: { the: "l'humidité", of: "d'humidité", icon: 'ph:drop' },
  power: { the: 'la consommation', of: 'de consommation', icon: 'ph:lightning' },
  co2: { the: 'le CO2', of: 'de CO2', icon: 'ph:wind' },
  illuminance: { the: 'la luminosité', of: 'de luminosité', icon: 'ph:sun' },
  pressure: { the: 'la pression', of: 'de pression', icon: 'ph:gauge' },
}

// ---------------------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------------------

const ASK = {
  house: { text: 'Comment va la maison ?', icon: 'ph:house-line' },
  alerts: { text: 'Y a-t-il des alertes ?', icon: 'ph:warning' },
  rankPower: { text: 'Quelle pièce consomme le plus ?', icon: 'ph:ranking' },
  rankDevice: { text: 'Quel appareil consomme le plus ?', icon: 'ph:ranking' },
  week: { text: "Combien j'ai consommé cette semaine ?", icon: 'ph:lightning' },
  yesterday: { text: "Combien j'ai consommé hier ?", icon: 'ph:lightning' },
  month: { text: 'Ma conso du mois', icon: 'ph:lightning' },
  coldest: { text: 'Où fait-il le plus froid ?', icon: 'ph:thermometer-cold' },
  warmest: { text: 'Où fait-il le plus chaud ?', icon: 'ph:thermometer-hot' },
  humidest: { text: 'Quelle est la pièce la plus humide ?', icon: 'ph:drop' },
  proactive: { text: 'Que fais-tu de proactif ?', icon: 'ph:sparkle' },
  actAlone: { text: 'Agis tout seul', icon: 'ph:steering-wheel' },
  askFirst: { text: "Demande-moi avant d'agir", icon: 'ph:hand-pointing' },
  undo: { text: 'Annule', icon: 'ph:arrow-counter-clockwise' },
  allOff: { text: 'Éteins tout', icon: 'ph:power' },
} satisfies Record<string, FollowUp>

function now(measure: string, area: string): FollowUp | null {
  const icon = MEASURE_WORDS[measure]?.icon ?? 'ph:gauge'
  switch (measure) {
    case 'temperature':
      return { text: `Il fait combien ${inRoom(area)} ?`, icon }
    case 'humidity':
      return { text: `Quelle est l'humidité ${ofRoom(area)} ?`, icon }
    case 'co2':
      return { text: `Le CO2 ${ofRoom(area)}`, icon }
    default:
      return null
  }
}

function curve(measure: string, area: string | null, period: 'week' | 'month'): FollowUp | null {
  const words = MEASURE_WORDS[measure]
  if (!words) return null
  return { text: `Analyse ${words.the}${area ? ` ${ofRoom(area)}` : ''} sur ${period === 'month' ? '30' : '7'} jours`, icon: 'ph:chart-line' }
}

function compare(measure: string, first: string, second: string): FollowUp | null {
  const words = MEASURE_WORDS[measure]
  if (!words) return null
  return { text: `Compare ${words.the} ${ofRoom(first)} et ${ofRoom(second)}`, icon: 'ph:arrows-left-right' }
}

function extreme(measure: string, question: string): FollowUp | null {
  if (measure === 'temperature') return /froid|cold|frais/.test(question) ? ASK.warmest : ASK.coldest
  if (measure === 'humidity') return ASK.humidest
  if (measure === 'power') return /appareil|device/.test(question) ? ASK.rankPower : ASK.rankDevice
  return null
}

// ---------------------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------------------

const same = (first: string, second: string) => normalise(first) === normalise(second)

function roomsWith(input: FollowUpInput, measure: string): string[] {
  return input.areas.filter((area) => area.measures.includes(measure)).map((area) => area.name)
}

function candidates(input: FollowUpInput): (FollowUp | null)[] {
  const question = normalise(input.question ?? '')
  const tool = [...input.tools].reverse().find((name) => name !== 'remember' && name !== 'recall') ?? null
  const { measure, area } = input
  const alerts = input.openAlerts > 0 ? ASK.alerts : null

  if (input.after === 'reflex') return [ASK.proactive, input.actsAlone ? ASK.askFirst : ASK.actAlone, ASK.house]

  const rooms = measure ? roomsWith(input, measure) : []
  const other = rooms.find((name) => !area || !same(name, area)) ?? null
  const base = area ?? rooms[0] ?? null
  const second = rooms.find((name) => base && !same(name, base)) ?? null

  switch (tool) {
    case 'show_widget':
      if (!measure) break
      return [
        other ? now(measure, other) : null,
        curve(measure, area, 'week'),
        base && second ? compare(measure, base, second) : extreme(measure, question),
      ]

    case 'analyse_history': {
      if (!measure) break
      const month = (parsePeriod(input.question ?? '')?.hours ?? 0) >= 24 * 28
      return [curve(measure, area, month ? 'week' : 'month'), extreme(measure, question), base && second ? compare(measure, base, second) : null]
    }

    case 'compare_history':
      if (!measure) break
      return [curve(measure, area, 'month'), extreme(measure, question), area ? now(measure, area) : null]

    case 'rank':
      if (measure === 'power') return [ASK.week, extreme('power', question), ASK.yesterday]
      if (measure) return [extreme(measure, question), measure === 'temperature' ? ASK.humidest : ASK.coldest, curve(measure, null, 'week')]
      break

    case 'get_energy':
      return [/hier|yesterday/.test(question) ? ASK.week : ASK.yesterday, ASK.rankDevice, /mois|month/.test(question) ? ASK.week : ASK.month]

    case 'control_device':
    case 'control_many':
      if (input.command === 'turnOff') return [ASK.undo, ASK.rankPower, ASK.house]
      if (input.command === 'turnOn') return [ASK.undo, area ? { text: `Éteins ${theRoom(area)}`, icon: 'ph:power' } : ASK.allOff, ASK.rankPower]
      if (input.command === 'setTargetTemperature' || input.command === 'setHvacMode') return [ASK.undo, area ? now('temperature', area) : ASK.coldest, ASK.house]
      return [ASK.undo, ASK.house, ASK.proactive]

    case 'house_snapshot':
      return [alerts, ASK.rankPower, ASK.coldest, input.lightsOn > 0 ? ASK.allOff : ASK.proactive]

    case 'get_autonomy':
      return [input.actsAlone ? ASK.askFirst : ASK.actAlone, ASK.house, ASK.rankPower]

    case 'set_autonomy':
      return [ASK.proactive, ASK.house, ASK.rankPower]

    case 'who_is_home':
    case 'list_alerts':
      return [ASK.house, input.lightsOn > 0 ? ASK.allOff : ASK.rankPower, ASK.proactive]

    default:
      break
  }

  // Nothing said yet, or nothing to follow: the hour decides.
  const inside = roomsWith(input, 'temperature')[0]
  if (input.hour >= 5 && input.hour < 11) return [alerts, ASK.house, ASK.yesterday, inside ? now('temperature', inside) : ASK.coldest]
  if (input.hour >= 20 || input.hour < 5) return [input.lightsOn > 0 ? ASK.allOff : null, alerts, ASK.house, ASK.proactive, ASK.yesterday]
  return [alerts, ASK.house, ASK.rankPower, ASK.proactive]
}

/** The follow-ups for this moment: two or three, all different, never the question itself. */
export function followUps(input: FollowUpInput): FollowUp[] {
  const out: FollowUp[] = []
  const add = (candidate: FollowUp | null) => {
    if (!candidate || out.length >= 3) return
    if (input.question && same(candidate.text, input.question)) return
    if (out.some((existing) => same(existing.text, candidate.text))) return
    out.push(candidate)
  }
  for (const candidate of candidates(input)) add(candidate)
  // A thin list is padded from the questions that are always worth asking.
  for (const candidate of [ASK.house, ASK.rankPower, ASK.proactive, ASK.coldest]) {
    if (out.length >= 2) break
    add(candidate)
  }
  return out
}

// ---------------------------------------------------------------------------------------
// From the conversation and the house
// ---------------------------------------------------------------------------------------

function measuresOf(devices: ReturnType<typeof deviceRepository.all>): string[] {
  const found = new Set<string>()
  for (const device of devices) {
    if (device.capabilities.includes('temperature') || typeof device.state.currentTemperature === 'number') found.add('temperature')
    if (device.capabilities.includes('humidity')) found.add('humidity')
    if (device.capabilities.includes('power')) found.add('power')
    if (typeof device.state.co2 === 'number') found.add('co2')
  }
  return [...found]
}

export function followUpsFor(conversationId: string | null, options: { after?: 'reflex' | null } = {}): FollowUp[] {
  const history = conversationId ? messages.forConversation(conversationId, 1000).slice(-40) : []
  const lastQuestion = history.map((message) => message.role).lastIndexOf('user')
  const question = lastQuestion >= 0 ? history[lastQuestion]!.content : null
  const calls = lastQuestion >= 0 ? history.slice(lastQuestion + 1).flatMap((message) => message.toolCalls ?? []) : []
  const command = calls.map((call) => (call.args as Record<string, unknown> | undefined)?.command).find((value): value is string => typeof value === 'string') ?? null

  const devices = deviceRepository.all({ limit: 5000 })
  const areas = places
    .areas()
    .filter((area) => !isOutdoorArea(area))
    .map((area) => ({ name: area.name, measures: measuresOf(devices.filter((device) => device.areaId === area.id)) }))

  return followUps({
    question,
    tools: calls.map((call) => call.name),
    // "Il fait combien" names no measure: it is the temperature, as the parser reads it.
    measure: question ? parseMeasure(question)?.id ?? (impliedTemperature(question) ? 'temperature' : null) : null,
    area: question ? findArea(question) : null,
    command,
    after: options.after ?? null,
    areas,
    lightsOn: devices.filter((device) => device.category === 'light' && device.state.on === true).length,
    openAlerts: alerts.open().length,
    actsAlone: AUTONOMY[autonomyEngine.level()].mayActUnprompted,
    hour: new Date().getHours(),
  })
}
