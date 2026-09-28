/**
 * The offline brain.
 *
 * A deterministic parser for the sentences people actually say to a house. It runs before
 * the model on every turn and, when it is confident, answers without one - which means the
 * common cases are instant and free, and the whole product still works with no API key, no
 * internet and no local model pulled.
 *
 * It is a pattern matcher, not an NLU: French and English, present tense, imperatives, and
 * the handful of question forms a house gets asked. Anything it is not sure about it hands
 * to the model with `confidence` below the threshold, so the fallback never guesses over a
 * better answer.
 */

import { places } from '#repositories/store'
import { deviceRepository } from '#repositories/device_repository'
import { describeSeries } from '#services/widget_service'
import { houseService } from '#services/house'
import { houseSentence } from '#agent/briefing'
import {
  impliedTemperature,
  measureById,
  normalise,
  parseAggregate,
  parseAutonomy,
  parseMeasure,
  parsePeriod,
  parseRanking,
  splitComparands,
  wantsAnalysis,
  wantsSeries,
  type Measure,
} from '#agent/language'
import { chip, formatQuantity, type AgentToolResult, type WidgetData } from '@sway-home/shared'

export interface ParsedIntent {
  tool: string
  args: Record<string, unknown>
  confidence: number
  /** Lets an intent phrase its own answer rather than echoing the tool summary. */
  reply?: (result: AgentToolResult) => string
}

const COLOURS: Record<string, [number, number]> = {
  rouge: [0, 100], red: [0, 100],
  orange: [30, 100],
  jaune: [55, 100], yellow: [55, 100],
  vert: [120, 100], green: [120, 100],
  turquoise: [175, 90], cyan: [180, 100],
  bleu: [220, 100], blue: [220, 100],
  violet: [275, 100], purple: [275, 100], mauve: [285, 70],
  rose: [320, 80], pink: [320, 80],
  blanc: [0, 0], white: [0, 0],
}

const MODE_WORDS: Record<string, string> = {
  'a la maison': 'home', maison: 'home', home: 'home',
  absent: 'away', parti: 'away', away: 'away', sorti: 'away',
  nuit: 'night', night: 'night', dodo: 'night',
  invite: 'guest', guest: 'guest',
  vacances: 'vacation', vacation: 'vacation',
  soiree: 'party', fete: 'party', party: 'party',
  concentration: 'focus', focus: 'focus', travail: 'focus',
  cinema: 'cinema', film: 'cinema', movie: 'cinema',
  menage: 'cleaning', cleaning: 'cleaning',
}

export function findArea(text: string): string | null {
  const normalised = normalise(text)
  for (const area of places.areas()) {
    if (normalised.includes(normalise(area.name))) return area.name
  }
  // A few synonyms people use for the same room.
  const synonyms: Record<string, string[]> = {
    Salon: ['living room', 'sejour', 'lounge', 'salle a manger'],
    Cuisine: ['kitchen'],
    Chambre: ['bedroom', 'chambre a coucher'],
    Bureau: ['office', 'study'],
    'Salle de bain': ['bathroom', 'sdb', 'salle d eau'],
    Entrée: ['hallway', 'couloir', 'entree', 'hall'],
    Garage: ['garage'],
    Jardin: ['garden', 'terrasse', 'balcon', 'outside', 'dehors'],
  }
  for (const [area, words] of Object.entries(synonyms)) {
    if (words.some((word) => normalised.includes(normalise(word)))) {
      return places.areas().find((candidate) => normalise(candidate.name) === normalise(area))?.name ?? null
    }
  }
  return null
}

/** The longest device name contained in the sentence wins: "chevet gauche" beats "chevet". */
function findDevice(text: string): { id: string; name: string } | null {
  const normalised = normalise(text)
  const candidates = deviceRepository
    .all({ limit: 500 })
    .map((device) => ({ device, names: [device.name, ...device.aliases] }))
    .flatMap(({ device, names }) => names.map((name) => ({ id: device.id, name: device.name, match: normalise(name) })))
    .filter((candidate) => candidate.match.length >= 4 && normalised.includes(candidate.match))
    .sort((a, b) => b.match.length - a.match.length)

  return candidates[0] ? { id: candidates[0].id, name: candidates[0].name } : null
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * What gets said out loud once the card is on screen.
 *
 * A card answers the eye; the sentence answers the ear, and they have to agree. Returning
 * the tool summary here is what made the assistant say "carte affichée" to someone who had
 * asked what the humidity was.
 */
function speakWidget(result: AgentToolResult, measure: Measure, period: string | null, detailed: boolean): string {
  const attachment = result.attachments?.[0]?.data as { widget?: { title: string; data: WidgetData } } | undefined
  const widget = attachment?.widget
  if (!widget) return result.summary
  const data = widget.data
  const value = (reading: number | string | null | undefined, unit: string | null | undefined) =>
    typeof reading === 'number' ? chip(measure.icon, formatQuantity(reading, unit ?? measure.unit, measure.decimals)) : `${reading ?? '?'}`

  if (data.kind === 'series') {
    if (!detailed) return `${widget.title} : ${value(data.last, data.unit)}`
    return describeSeries(data, {
      label: capitalise(measure.label),
      unit: measure.unit,
      decimals: measure.decimals,
      period: period ?? undefined,
      icon: measure.icon,
      goodDirection: measure.goodDirection,
    })
  }

  if (data.kind === 'multi-series') {
    const parts = data.series.map((entry) => `${entry.label} ${entry.avg === null ? '?' : formatQuantity(entry.avg, measure.unit, measure.decimals)}`)
    return `${capitalise(measure.label)}${period ? ` ${period}` : ''} : ${parts.join(', ')}.`
  }

  if (data.kind === 'metric') return `${widget.title} : ${value(data.value, data.unit)}`
  if (data.kind === 'empty') return data.message
  return result.summary
}

export function parseIntent(input: string): ParsedIntent | null {
  const text = normalise(input)
  if (text.length === 0) return null

  const area = findArea(input)
  const device = findDevice(input)

  // -------------------------------------------------------------------------------------
  // Questions
  // -------------------------------------------------------------------------------------

  if (/^(ca va|comment (ca )?va|comment va la maison|how is (the )?(house|home)|quoi de neuf|status|statut|etat de la maison)/.test(text)) {
    // The tool summary is written for a model; the person asking gets one sentence.
    return { tool: 'house_snapshot', args: {}, confidence: 0.95, reply: () => houseSentence(houseService.snapshot()) }
  }

  // "Que fais-tu de proactif ?" is answered from the live reflexes, not by a model guessing
  // at its own settings; "agis seul" or "demande-moi avant" changes the level.
  const autonomy = parseAutonomy(input)
  if (autonomy) {
    return autonomy.kind === 'ask'
      ? { tool: 'get_autonomy', args: {}, confidence: 0.92 }
      : { tool: 'set_autonomy', args: { level: autonomy.level }, confidence: 0.9 }
  }

  // A sentence that tells the house to do something is never a question about a reading,
  // whatever measure words it happens to contain: "mets le chauffage à 21 degrés" names a
  // temperature and is not a request to display one.
  const commands = /(allume|allumer|eteins|eteindre|coupe|arrete|active|desactive|\bmets?\b|regle|monte|baisse|diminue|augmente|verrouille|deverrouille|ouvre|ferme|lance|demarre|passe en|turn (on|off)|switch (on|off)|\bset\b|\bdim\b|lock|unlock)/.test(text)

  // -------------------------------------------------------------------------------------
  // Rankings: "quelle pièce consomme le plus", "où fait-il le plus froid"
  //
  // These used to fall through to the energy report, which answered "which room" with
  // sixteen lines about seven days. A ranking is its own question: an order, now unless a
  // period is named, and the sentence comes from the tool.
  // -------------------------------------------------------------------------------------

  const ranking = commands ? null : parseRanking(input)
  if (ranking) {
    const window = parsePeriod(input)
    const areaId = ranking.by === 'device' && area ? places.areas().find((candidate) => candidate.name === area)?.id ?? null : null
    return {
      tool: 'rank',
      args: {
        measure: ranking.measure.id,
        by: ranking.by,
        order: ranking.order,
        indoor: ranking.indoor,
        hours: window?.hours ?? 0,
        offsetHours: window?.offsetHours ?? 0,
        ...(areaId ? { areaId } : {}),
        ...(ranking.limit ? { limit: ranking.limit } : {}),
      },
      confidence: 0.88,
    }
  }

  // -------------------------------------------------------------------------------------
  // Measurements, curves, analyses and comparisons
  //
  // Every one of these is the same question with different knobs: a measure, a place, a
  // window and a shape of answer. They used to be separate patterns, and the parser missed
  // most of the phrasings people actually use - "analyse la courbe d humidité du dernier
  // mois" matched nothing at all. One branch, four knobs, and the widget does the rest.
  // -------------------------------------------------------------------------------------

  const measure = parseMeasure(input) ?? (impliedTemperature(input) ? measureById('temperature') : null)
  const period = parsePeriod(input)
  const wantedAggregate = parseAggregate(input)
  const asksSeries = wantsSeries(input)
  const asksAnalysis = wantsAnalysis(input)
  const pinsToDashboard = /(tableau de bord|dashboard)/.test(text)

  if (measure && !commands && !pinsToDashboard) {
    // "Combien j'ai consommé cette semaine" is a question about a bill, and the energy
    // branch answers it in kilowatt-hours and euros - so is a past tense with no period,
    // "combien j'ai consommé ?". "Combien je consomme" is the draw right now. Only a curve
    // or a peak asked for by name pulls a period of consumption over here.
    const asksBill = /(facture|kwh|\bcout|coute|depense|(ai|as|a|avons|avez|ont) (\w+ )?consomme\b|consomme depuis)/.test(text)
    const isBillQuestion = measure.id === 'power' && (period !== null || asksBill) && !asksSeries && wantedAggregate === null

    // A short phrase that names a measure is a question even without a question word: "le
    // co2 de la chambre" is asked far more often than "quel est le co2 de la chambre".
    const asksValue =
      /(il fait|quel(le)?s? (est|sont|a ete|ont ete)|combien|c est quoi|montre|affiche|donne moi|what.?s|how (warm|cold|humid))/.test(text) ||
      text.split(' ').length <= 8

    const comparands = splitComparands(input)
    const compared = (comparands ?? []).map((fragment) => ({ areaName: findArea(fragment), device: findDevice(fragment) }))
    const comparedAreaIds = compared
      .map((entry) => (entry.areaName ? places.areas().find((candidate) => candidate.name === entry.areaName)?.id ?? null : null))
      .filter((id): id is string => id !== null)
    const comparedDeviceIds = compared.map((entry) => entry.device?.id ?? null).filter((id): id is string => id !== null)

    if (comparands && (comparedAreaIds.length >= 2 || comparedDeviceIds.length >= 2)) {
      const window = period ?? { hours: 24 * 7, offsetHours: 0, label: 'sur une semaine' }
      const useAreas = comparedAreaIds.length >= 2
      return {
        tool: 'show_widget',
        args: {
          type: 'compare',
          title: `${capitalise(measure.label)} ${useAreas ? 'par pièce' : 'par appareil'} (${window.label})`,
          size: 'lg',
          source: {
            kind: 'compare',
            capability: measure.capability,
            attribute: measure.attribute,
            areaIds: useAreas ? comparedAreaIds : [],
            deviceIds: useAreas ? [] : comparedDeviceIds,
            hours: window.hours,
            offsetHours: window.offsetHours,
            aggregate: wantedAggregate ?? 'avg',
          },
        },
        confidence: 0.86,
        reply: (result) => speakWidget(result, measure, window.label, true),
      }
    }

    if ((asksValue || asksSeries || asksAnalysis) && !isBillQuestion) {
      const areaId = area ? places.areas().find((candidate) => candidate.name === area)?.id ?? null : null
      const window = period ?? { hours: 24, offsetHours: 0, label: '' }
      const subject = area ? area.toLowerCase() : device ? device.name : null
      const title = [capitalise([measure.label, subject].filter(Boolean).join(' ')), period ? `(${period.label})` : null].filter(Boolean).join(' ')

      // History rather than the live reading whenever the question has a past in it. A
      // window that ended yesterday, or a maximum, cannot be answered by the current value,
      // and answering it with the current value is a wrong answer that looks right.
      const readsHistory = asksSeries || period !== null || wantedAggregate === 'max' || wantedAggregate === 'min'
      const history = {
        kind: 'history',
        capability: measure.capability,
        attribute: measure.attribute,
        areaId,
        deviceId: device?.id ?? null,
        hours: window.hours,
        offsetHours: window.offsetHours,
        aggregate: wantedAggregate ?? (asksSeries ? 'avg' : measure.aggregate),
        bucket: 'auto',
      }

      return {
        tool: 'show_widget',
        args: asksSeries
          ? { type: 'chart', title, size: 'lg', source: history }
          : readsHistory
            ? { type: 'metric', title, size: 'md', source: history }
            : {
                type: 'metric',
                title,
                size: 'md',
                source: device
                  ? { kind: 'device', deviceId: device.id, attribute: measure.attribute }
                  : { kind: 'capability', capability: measure.capability, attribute: measure.attribute, areaId, aggregate: measure.aggregate },
              },
        confidence: 0.86,
        reply: (result) => speakWidget(result, measure, period?.label ?? null, asksAnalysis || asksSeries),
      }
    }
  }

  if (/(qui est (la|a la maison|rentre)|who.?s home|est ce qu il y a quelqu un)/.test(text)) {
    return { tool: 'who_is_home', args: {}, confidence: 0.95 }
  }

  if (/(alerte|alarme|probleme|anything wrong|alerts?)/.test(text) && /\?|^(y a|est ce|any)/.test(text)) {
    return { tool: 'list_alerts', args: {}, confidence: 0.85 }
  }

  if (/(consomm|conso|electricite|energie|energy|power usage|kwh|facture)/.test(text)) {
    // The same windows as every other question: "hier" is the day that ended, not the last
    // 48 hours, and a week is the default when none is named.
    const window = parsePeriod(input) ?? { hours: 24 * 7, offsetHours: 0 }
    return { tool: 'get_energy', args: { hours: window.hours, offsetHours: window.offsetHours, ...(device ? { device: device.id } : {}) }, confidence: 0.88 }
  }

  if (/(pourquoi|why did|qu est ce qui s est passe|what happened|historique|journal|timeline)/.test(text)) {
    return { tool: 'get_timeline', args: { limit: 30, ...(device ? { device: device.id } : {}) }, confidence: 0.82 }
  }

  if (/(quels? appareils|liste (les|des) appareils|list (the )?devices|qu est ce qu il y a dans)/.test(text)) {
    return { tool: 'list_devices', args: area ? { area } : {}, confidence: 0.9 }
  }

  if (/(scanne|scan|cherche (des )?(nouveaux )?appareils|find (new )?devices|detecte)/.test(text)) {
    return { tool: 'scan_network', args: { deep: /complet|profond|deep|full/.test(text) }, confidence: 0.9 }
  }

  if (/(qu est ce qu il y a sur (le|mon) reseau|reseau|network|quels? hotes)/.test(text)) {
    return { tool: 'network_view', args: { onlyUnclaimed: /inconnu|unknown|pas reconnu|unclaimed/.test(text) }, confidence: 0.85 }
  }

  if (/^(annule|undo|reviens en arriere|cancel that|retour)/.test(text)) {
    return { tool: 'undo_last', args: {}, confidence: 0.95 }
  }

  // -------------------------------------------------------------------------------------
  // House mode
  // -------------------------------------------------------------------------------------

  const modeMatch =
    /(mode|passe en|set mode|switch to|je (pars|sors|rentre|vais dormir)|je suis (rentre|de retour|la)|bonne nuit|good night|i.?m (leaving|home|going to bed))/.exec(text)
  if (modeMatch) {
    let mode: string | null = null
    if (/je pars|je sors|i.?m leaving|leaving/.test(text)) mode = 'away'
    else if (/je rentre|je suis rentre|je suis de retour|i.?m home|rentre a la maison/.test(text)) mode = 'home'
    else if (/dormir|going to bed|bonne nuit|good night/.test(text)) mode = 'night'
    else {
      for (const [word, value] of Object.entries(MODE_WORDS)) {
        if (text.includes(word)) {
          mode = value
          break
        }
      }
    }
    if (mode) return { tool: 'set_house_mode', args: { mode }, confidence: 0.9 }
  }

  // -------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------

  const wantsOn = /(allume|allumer|mets? en marche|active|turn on|switch on|ouvre la lumiere|light up)/.test(text)
  const wantsOff = /(eteins?|eteindre|coupe|arrete|desactive|turn off|switch off|shut (off|down))/.test(text)
  const everything = /(tout|toutes?|everything|all (the )?(lights?|lamps?)?)\b/.test(text)

  if (wantsOff && everything && !area && !device) {
    return {
      tool: 'control_many',
      args: { capability: 'onoff', command: 'turnOff' },
      confidence: 0.92,
      reply: (result) => (result.ok ? "C'est éteint." : result.summary),
    }
  }

  if ((wantsOn || wantsOff) && device) {
    return {
      tool: 'control_device',
      args: { device: device.id, command: wantsOn ? 'turnOn' : 'turnOff', args: { transitionMs: 500 } },
      confidence: 0.93,
      reply: (result) => (result.ok ? `${device.name} : ${wantsOn ? 'allumé' : 'éteint'}.` : result.summary),
    }
  }

  if ((wantsOn || wantsOff) && area) {
    const category = /lumiere|lampe|light|lamp|plafonnier|spot/.test(text) ? 'light' : undefined
    return {
      tool: 'control_many',
      args: { area, capability: 'onoff', ...(category ? { category } : {}), command: wantsOn ? 'turnOn' : 'turnOff' },
      confidence: 0.9,
      reply: (result) => (result.ok ? `${area} : ${wantsOn ? 'allumé' : 'éteint'}.` : result.summary),
    }
  }

  // Brightness, absolute and relative.
  const percentMatch = /(\d{1,3})\s*(%|pour ?cent|percent)/.exec(text)
  if (percentMatch?.[1] && /(luminosite|intensite|brightness|dim|baisse|monte|mets?|regle|set)/.test(text)) {
    const brightness = Math.max(0, Math.min(100, Number(percentMatch[1])))
    if (device) {
      return {
        tool: 'control_device',
        args: { device: device.id, command: 'setBrightness', args: { brightness, transitionMs: 600 } },
        confidence: 0.92,
        reply: (result) => (result.ok ? `${device.name} à ${brightness} %.` : result.summary),
      }
    }
    if (area) {
      return {
        tool: 'control_many',
        args: { area, capability: 'brightness', command: 'setBrightness', args: { brightness, transitionMs: 600 } },
        confidence: 0.88,
      }
    }
  }

  if (/(baisse|diminue|moins fort|dim down|lower)/.test(text) && (device || area)) {
    const args = { command: 'stepBrightness', args: { delta: -20, transitionMs: 400 } }
    return device
      ? { tool: 'control_device', args: { device: device.id, ...args }, confidence: 0.85 }
      : { tool: 'control_many', args: { area, capability: 'brightness', ...args }, confidence: 0.82 }
  }

  if (/(monte|augmente|plus fort|brighter|turn up)/.test(text) && (device || area) && !/volume|son|sound/.test(text)) {
    const args = { command: 'stepBrightness', args: { delta: 20, transitionMs: 400 } }
    return device
      ? { tool: 'control_device', args: { device: device.id, ...args }, confidence: 0.85 }
      : { tool: 'control_many', args: { area, capability: 'brightness', ...args }, confidence: 0.82 }
  }

  // Colour.
  for (const [word, [hue, saturation]] of Object.entries(COLOURS)) {
    if (!new RegExp(`\\b${word}\\b`).test(text)) continue
    if (!/(couleur|mets?|passe|colour|color|set)/.test(text)) continue
    const args = { command: 'setColor', args: { hue, saturation, transitionMs: 600 } }
    if (device) return { tool: 'control_device', args: { device: device.id, ...args }, confidence: 0.9, reply: () => `${device.name} en ${word}.` }
    if (area) return { tool: 'control_many', args: { area, capability: 'color', ...args }, confidence: 0.86 }
  }

  // Temperature set point.
  const degreesMatch = /(\d{1,2})([.,]\d)?\s*(degres?|degrees?|°c?)\b/.exec(text)
  if (degreesMatch?.[1] && /(chauffage|thermostat|mets?|regle|monte|baisse|set|heating|temperature)/.test(text) && !/il fait|quelle/.test(text)) {
    const celsius = Number(`${degreesMatch[1]}${degreesMatch[2]?.replace(',', '.') ?? ''}`)
    if (celsius >= 5 && celsius <= 32) {
      if (device) {
        return {
          tool: 'control_device',
          args: { device: device.id, command: 'setTargetTemperature', args: { celsius } },
          confidence: 0.92,
          reply: (result) => (result.ok ? `${device.name} réglé sur ${celsius} °C.` : result.summary),
        }
      }
      return {
        tool: 'control_many',
        args: { ...(area ? { area } : {}), capability: 'thermostat', command: 'setTargetTemperature', args: { celsius } },
        confidence: area ? 0.88 : 0.8,
      }
    }
  }

  // Covers.
  if (/(ouvre|ouvrir|monte|leve|open|raise)/.test(text) && /(volet|store|rideau|blind|shutter|curtain)/.test(text)) {
    const args = { command: 'open', args: {} }
    if (device) return { tool: 'control_device', args: { device: device.id, ...args }, confidence: 0.9 }
    return { tool: 'control_many', args: { ...(area ? { area } : {}), capability: 'position', ...args }, confidence: 0.85 }
  }
  if (/(ferme|fermer|baisse|descend|close|lower)/.test(text) && /(volet|store|rideau|blind|shutter|curtain)/.test(text)) {
    const args = { command: 'close', args: {} }
    if (device) return { tool: 'control_device', args: { device: device.id, ...args }, confidence: 0.9 }
    return { tool: 'control_many', args: { ...(area ? { area } : {}), capability: 'position', ...args }, confidence: 0.85 }
  }

  // Locks: always a command, never a fallback guess, because the risk layer has to see it.
  if (/(verrouille|ferme a cle|lock)/.test(text) && !/deverrouille|unlock/.test(text)) {
    const args = { command: 'lock', args: {} }
    if (device) return { tool: 'control_device', args: { device: device.id, ...args }, confidence: 0.9 }
    return { tool: 'control_many', args: { capability: 'lock', ...args }, confidence: 0.85 }
  }
  if (/(deverrouille|ouvre la porte|unlock)/.test(text)) {
    const args = { command: 'unlock', args: {} }
    if (device) return { tool: 'control_device', args: { device: device.id, ...args }, confidence: 0.9 }
    return { tool: 'control_many', args: { capability: 'lock', ...args }, confidence: 0.8 }
  }

  // Media.
  if (/(pause|mets? en pause|stop la musique|pause the music)/.test(text)) {
    const args = { command: 'pause', args: {} }
    if (device) return { tool: 'control_device', args: { device: device.id, ...args }, confidence: 0.9 }
    return { tool: 'control_many', args: { capability: 'mediaPlayback', ...args }, confidence: 0.85 }
  }
  if (/^(joue|lance|mets?|play|reprends)\b/.test(text) && /(musique|music|son|playlist)/.test(text)) {
    const args = { command: 'play', args: {} }
    if (device) return { tool: 'control_device', args: { device: device.id, ...args }, confidence: 0.85 }
    return { tool: 'control_many', args: { capability: 'mediaPlayback', ...args }, confidence: 0.8 }
  }

  const volumeMatch = /(volume|son|sound)\D{0,12}(\d{1,3})/.exec(text)
  if (volumeMatch?.[2]) {
    const volume = Math.max(0, Math.min(100, Number(volumeMatch[2])))
    const args = { command: 'setVolume', args: { volume } }
    if (device) return { tool: 'control_device', args: { device: device.id, ...args }, confidence: 0.9 }
    return { tool: 'control_many', args: { ...(area ? { area } : {}), capability: 'volume', ...args }, confidence: 0.82 }
  }

  // Scenes.
  const sceneMatch = /(scene|ambiance|mode)\s+([a-z0-9 ']{3,30})/.exec(text)
  if (sceneMatch?.[2] && /(lance|active|mets?|applique|activate|set)/.test(text)) {
    return { tool: 'activate_scene', args: { scene: sceneMatch[2].trim() }, confidence: 0.8 }
  }

  // -------------------------------------------------------------------------------------
  // The dashboard
  // -------------------------------------------------------------------------------------

  // "mets l'humidité de la salle de bain sur le tableau de bord", "affiche la conso du salon".
  // Worth parsing without a model because building a tile is exactly the kind of thing
  // someone asks for once and then never again - paying for a model turn to place a card is
  // the wrong trade, and this path works with no key at all.
  if (/(tableau de bord|dashboard|widget|carte)/.test(text) && /(mets?|ajoute|affiche|montre|je veux voir|add|show)/.test(text)) {
    // findArea answers with a room *name*, which is what the command tools want; a widget
    // source stores the id, so it is resolved here rather than silently pointing at nothing.
    const areaName = findArea(text)
    const areaId = areaName ? places.areas().find((area) => area.name === areaName)?.id ?? null : null
    const measure = parseMeasure(text)

    if (measure) {
      // "sur le tableau de bord" contains "sur", so a window only counts when the sentence
      // actually asks for a curve or names one in so many words.
      const overTime = wantsSeries(text)
      const window = overTime ? parsePeriod(text) : null
      const title = [measure.label, areaName ? areaName.toLowerCase() : null].filter(Boolean).join(' ')
      const hours = window?.hours ?? 24

      return {
        tool: 'create_widget',
        args: overTime
          ? {
              type: 'chart',
              title: title.charAt(0).toUpperCase() + title.slice(1),
              size: 'md',
              icon: measure.icon,
              source: { kind: 'history', capability: measure.capability, attribute: measure.attribute, areaId, hours, offsetHours: window?.offsetHours ?? 0, aggregate: 'avg', bucket: 'auto' },
              reason: 'Demandé depuis le tableau de bord.',
            }
          : {
              type: 'metric',
              title: title.charAt(0).toUpperCase() + title.slice(1),
              size: 'sm',
              icon: measure.icon,
              source: { kind: 'capability', capability: measure.capability, attribute: measure.attribute, areaId, aggregate: measure.aggregate },
              reason: 'Demandé depuis le tableau de bord.',
            },
        confidence: 0.85,
      }
    }

    // A room with no named measure: the whole room is the card.
    if (areaId) {
      return {
        tool: 'create_widget',
        args: { type: 'room', title: areaName ?? 'Pièce', size: 'lg', icon: 'ph:house-line', source: { kind: 'area', areaId }, reason: 'Demandé depuis le tableau de bord.' },
        confidence: 0.75,
      }
    }
  }

  if (/(quelles?|liste|montre).{0,20}(cartes?|widgets?)/.test(text) || /(tableau de bord|dashboard).{0,20}(contient|affiche quoi)/.test(text)) {
    return { tool: 'list_widgets', args: {}, confidence: 0.8 }
  }

  // Memory.
  if (/(retiens|souviens toi|note que|remember that|remember)/.test(text)) {
    const content = input.replace(/^.*?(retiens|souviens toi|note que|remember that|remember)\s*/i, '').trim()
    if (content.length > 3) {
      return { tool: 'remember', args: { content, kind: 'preference' }, confidence: 0.9, reply: () => 'Noté.' }
    }
  }

  // Routine suggestions.
  if (/(propose|suggere|suggest).{0,20}(routine|automatisation|automation)/.test(text)) {
    return { tool: 'suggest_routines', args: {}, confidence: 0.88 }
  }

  return null
}

/** Exported for the tests, which assert on the parse rather than on a model's mood. */
export const __testing = { normalise, findArea, findDevice, COLOURS }
