/**
 * The words, before the intent.
 *
 * Every question a house gets asked is some combination of four things: a measure, a place,
 * a period and a shape of answer. This module owns three of them - the ones that are pure
 * text, with no database behind them - so they can be tested exhaustively and reused by the
 * intent parser, the widget composer and the tool layer without any of them re-inventing a
 * regex for "le mois dernier".
 *
 * The rule here is to be generous. A phrasing this file does not recognise is a question the
 * assistant answers badly, and it fails silently: the user sees a plausible wrong answer, not
 * an error. So every entry carries the synonyms people actually use, in French and English,
 * and the tests enumerate them.
 */

/** Accents, case, apostrophes and punctuation all go, because patterns are written in plain words. */
export function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’‘`–—-]/g, ' ')
    .replace(/[?!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------------------

export interface Period {
  /** Width of the window, in hours. */
  hours: number
  /** How far back the window *ends*. 0 is "up to now", 24 is "up to this time yesterday". */
  offsetHours: number
  /** How to name it in a widget title. French, short, no leading capital. */
  label: string
}

/** A year is the ceiling everywhere: the history source refuses more, and nobody asks. */
const MAX_HOURS = 24 * 365

const UNIT_HOURS: { pattern: RegExp; hours: number; one: string; many: (n: number) => string }[] = [
  { pattern: /^(h|heures?|hours?)$/, hours: 1, one: 'sur une heure', many: (n) => `sur ${n} h` },
  { pattern: /^(jours?|days?|j)$/, hours: 24, one: 'sur un jour', many: (n) => `sur ${n} jours` },
  { pattern: /^(semaines?|weeks?)$/, hours: 24 * 7, one: 'sur une semaine', many: (n) => `sur ${n} semaines` },
  { pattern: /^(mois|months?)$/, hours: 24 * 30, one: 'sur un mois', many: (n) => `sur ${n} mois` },
  { pattern: /^(ans?|annees?|years?)$/, hours: 24 * 365, one: 'sur un an', many: (n) => `sur ${n} ans` },
]

/**
 * A number and a unit, with the filler people put between them: "les 30 derniers jours",
 * "ces 48 heures", "sur 6 mois". An explicit count always wins over a vague word next to it.
 */
const EXPLICIT = /(\d{1,4})\s*(?:derni[e]r(?:e?s)?\s+)?(h\b|heures?|hours?|jours?|days?|semaines?|weeks?|mois|months?|ans?|annees?|years?)/

export function parsePeriod(input: string): Period | null {
  const text = normalise(input)

  const explicit = EXPLICIT.exec(text)
  if (explicit?.[1] && explicit[2]) {
    const count = Number(explicit[1])
    const unit = UNIT_HOURS.find((entry) => entry.pattern.test(explicit[2]!.trim()))
    if (unit && count > 0) {
      const hours = Math.min(MAX_HOURS, count * unit.hours)
      return { hours, offsetHours: 0, label: count === 1 ? unit.one : unit.many(count) }
    }
  }

  // Windows that end in the past. "hier" is not "the last 24 hours": a chart that includes
  // this morning when someone asked about yesterday is answering a different question.
  if (/\b(hier|yesterday)\b/.test(text)) return { hours: 24, offsetHours: 24, label: 'hier' }
  if (/(avant hier|the day before yesterday)/.test(text)) return { hours: 24, offsetHours: 48, label: 'avant hier' }

  if (/(cette nuit|la nuit derniere|last night|tonight|nuit passee)/.test(text)) return { hours: 12, offsetHours: 0, label: 'cette nuit' }
  if (/(ce matin|this morning)/.test(text)) return { hours: 8, offsetHours: 0, label: 'ce matin' }
  if (/(aujourd hui|today|de la journee|cette journee)/.test(text)) return { hours: 24, offsetHours: 0, label: "aujourd'hui" }

  if (/(semaine|week)/.test(text)) return { hours: 24 * 7, offsetHours: 0, label: 'sur une semaine' }
  if (/(mois|month)/.test(text)) return { hours: 24 * 30, offsetHours: 0, label: 'sur un mois' }
  if (/\b(annee|an|year)\b/.test(text)) return { hours: MAX_HOURS, offsetHours: 0, label: 'sur un an' }

  return null
}

// ---------------------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------------------

export interface Measure {
  id: string
  /** How the assistant says it, in a title or a sentence. */
  label: string
  capability: string
  attribute: string
  /** How several devices reporting it collapse into one number. */
  aggregate: 'avg' | 'sum' | 'min' | 'max'
  unit: string | null
  decimals: number
  icon: string
  /**
   * Which way is good news, so a trend can be worded rather than just drawn. `none` for the
   * measures where neither direction means anything on its own, like temperature.
   */
  goodDirection: 'up' | 'down' | 'none'
}

/**
 * Ordered: the first pattern that matches wins, so the specific readings come before the
 * capability that contains them. Asking for the CO2 and being handed an air-quality index is
 * a wrong answer, not a rounding.
 */
export const MEASURES: Measure[] = [
  {
    id: 'pm25',
    label: 'particules fines',
    capability: 'airQuality',
    attribute: 'pm25',
    aggregate: 'avg',
    unit: 'µg/m³',
    decimals: 0,
    icon: 'ph:drop-half-bottom',
    goodDirection: 'down',
  },
  {
    id: 'voc',
    label: 'composés volatils',
    capability: 'airQuality',
    attribute: 'voc',
    aggregate: 'avg',
    unit: 'ppb',
    decimals: 0,
    icon: 'ph:wind',
    goodDirection: 'down',
  },
  {
    id: 'co2',
    label: 'CO2',
    capability: 'airQuality',
    attribute: 'co2',
    aggregate: 'avg',
    unit: 'ppm',
    decimals: 0,
    icon: 'ph:wind',
    goodDirection: 'down',
  },
  {
    id: 'humidity',
    label: 'humidité',
    capability: 'humidity',
    attribute: 'humidity',
    aggregate: 'avg',
    unit: '%',
    decimals: 0,
    icon: 'ph:drop',
    goodDirection: 'none',
  },
  {
    id: 'temperature',
    label: 'température',
    capability: 'temperature',
    attribute: 'temperature',
    aggregate: 'avg',
    unit: '°C',
    decimals: 1,
    icon: 'ph:thermometer-simple',
    goodDirection: 'none',
  },
  {
    id: 'power',
    label: 'consommation',
    capability: 'power',
    attribute: 'power',
    aggregate: 'sum',
    unit: 'W',
    decimals: 0,
    icon: 'ph:lightning',
    goodDirection: 'down',
  },
  {
    id: 'illuminance',
    label: 'luminosité',
    capability: 'illuminance',
    attribute: 'illuminance',
    aggregate: 'avg',
    unit: 'lx',
    decimals: 0,
    icon: 'ph:sun',
    goodDirection: 'none',
  },
  {
    id: 'battery',
    label: 'batterie',
    capability: 'battery',
    attribute: 'battery',
    aggregate: 'min',
    unit: '%',
    decimals: 0,
    icon: 'ph:battery-medium',
    goodDirection: 'up',
  },
  {
    id: 'pressure',
    label: 'pression',
    capability: 'pressure',
    attribute: 'pressure',
    aggregate: 'avg',
    unit: 'hPa',
    decimals: 0,
    icon: 'ph:gauge',
    goodDirection: 'none',
  },
]

const MEASURE_WORDS: Record<string, RegExp> = {
  pm25: /(particules|pm ?2 ?5|pm ?10|poussieres)/,
  voc: /(\bcov\b|\bvoc\b|composes? organiques|composes? volatils)/,
  co2: /(co ?2|gaz carbonique|qualite (de l|d) air|air quality)/,
  humidity: /(humidite|humidity|hygrometrie|taux d humidite|humide)/,
  temperature: /(temperature|chaleur|degres|\btemp\b|how (warm|cold))/,
  power: /(conso\b|consomm|puissance|watts?|\bpower\b|energie|energivore|gourmand|electricite|electric)/,
  illuminance: /(luminosite|lumiere ambiante|illuminance|\blux\b|clarte)/,
  battery: /(batterie|battery|\bpiles?\b)/,
  pressure: /(pression|pressure|barometr)/,
}

export function parseMeasure(input: string): Measure | null {
  const text = normalise(input)
  for (const measure of MEASURES) {
    const pattern = MEASURE_WORDS[measure.id]
    if (pattern && pattern.test(text)) return measure
  }
  return null
}

export function measureById(id: string): Measure | null {
  return MEASURES.find((measure) => measure.id === id) ?? null
}

/** The measure that "il fait combien" means, because in French that idiom is never ambiguous. */
export function impliedTemperature(input: string): boolean {
  return /(il fait (combien|quoi|quelle temperature|chaud|froid)|how (warm|cold) is)/.test(normalise(input))
}

// ---------------------------------------------------------------------------------------
// Aggregates and the shape of the answer
// ---------------------------------------------------------------------------------------

export type Aggregate = 'avg' | 'sum' | 'min' | 'max'

export function parseAggregate(input: string): Aggregate | null {
  const text = normalise(input)
  if (/(maximum|\bmax\b|\bpic\b|pics|le plus (haut|chaud|eleve|fort)|la plus (haute|chaude|elevee|forte)|highest|peak)/.test(text)) return 'max'
  if (/(minimum|\bmin\b|le plus (bas|froid|faible)|la plus (basse|froide|faible)|lowest)/.test(text)) return 'min'
  if (/(moyenne|en moyenne|moyen\b|average|\bavg\b)/.test(text)) return 'avg'
  // Word-bounded: "consommé" contains "somme", and is not asking for a sum.
  if (/(\btotal\b|\bcumul|\bsomme\b|\bsum\b)/.test(text)) return 'sum'
  return null
}

const SERIES_WORDS = /(courbe|graphique|graph\b|chart|evolution|evolue|historique|tendance|trend|variation|fluctuation)/
const ANALYSIS_WORDS = /(analyse|analyser|analyses|bilan|statistiques?|\bstats\b|resume moi|rapport|etudie|diagnostique)/

/** True when the answer should be a line over time rather than a single number. */
export function wantsSeries(input: string): boolean {
  const text = normalise(input)
  return SERIES_WORDS.test(text) || ANALYSIS_WORDS.test(text)
}

/** True when the line should come with a verdict: min, max, average and which way it is going. */
export function wantsAnalysis(input: string): boolean {
  return ANALYSIS_WORDS.test(normalise(input))
}

// ---------------------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------------------

export interface RankingQuestion {
  measure: Measure
  /** Rooms, or devices one by one. */
  by: 'area' | 'device'
  order: 'desc' | 'asc'
  /** "Quelle pièce" is about rooms, for a reading of the air; "où" includes the garden. */
  indoor: boolean
  /** "top 3", when asked for. */
  limit: number | null
}

const SUPERLATIVE = /\b(le|la|les) (plus|moins)\b|\b(most|least|warmest|hottest|coldest|coolest|driest|highest|lowest)\b|\b(classement|palmares)\b|\btop \d+\b/
const PLACE_NOUNS = /\b(pieces?|chambres?|endroits?|zones?|etages?|rooms?)\b/
const DEVICE_NOUNS = /\b(appareils?|lampes?|prises?|equipements?|machines?|capteurs?|sondes?|devices?|appliances?)\b/
const WHO = /(qu est ce qui|qui est ce qui|\bqui\b|\bwhat\b)/
const WHERE = /(\bou\b|\bwhere\b)/
const WARMTH = /(chaud|froid|frais|fraiche|warm|cold|cool|hot)/
const DRYNESS = /\b(sec|secs|seche|seches|dry|driest)\b/
/** Words whose "most" is the lowest reading: the coldest room is the one at the bottom. */
const LOW_END = /(froid|frais|fraiche|\bsec\b|\bsecs\b|seche|cold|cool|\bdry\b|driest|lowest|le plus bas|la plus basse)/

/**
 * "Quelle pièce consomme le plus", "où fait-il le plus froid", "quel appareil a le plus
 * consommé cette semaine". A superlative, a place or a thing to rank, and something to
 * rank it by. A superlative about a value with no place in it - "la température la plus
 * haute cette semaine" - is not a ranking, it is a maximum, and is left to the measures.
 */
export function parseRanking(input: string): RankingQuestion | null {
  const text = normalise(input)
  if (!SUPERLATIVE.test(text)) return null

  const place = PLACE_NOUNS.test(text) || WHERE.test(text)
  const device = DEVICE_NOUNS.test(text)
  if (!place && !device && !WHO.test(text)) return null

  const measure = parseMeasure(input) ?? (WARMTH.test(text) ? measureById('temperature') : DRYNESS.test(text) ? measureById('humidity') : null)
  if (!measure) return null

  // "La moins froide" is the warmest: each of the two words flips the order once.
  let ascending = /\b(le|la|les) moins\b|\bleast\b/.test(text)
  if (LOW_END.test(text)) ascending = !ascending

  const top = /\btop (\d+)\b/.exec(text)
  return {
    measure,
    by: place && !device ? 'area' : 'device',
    order: ascending ? 'asc' : 'desc',
    // Rooms rather than the garden for a reading of the air; consumption outside is still on
    // the bill, so it stays in.
    indoor: PLACE_NOUNS.test(text) && measure.id !== 'power',
    limit: top?.[1] ? Math.min(12, Math.max(1, Number(top[1]))) : null,
  }
}

// ---------------------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------------------

const COMPARE_TRIGGER = /(compare[rz]?|comparaison|versus|\bvs\b|par rapport a|contre)/
const COMPARE_LEAD = /^(peux tu |tu peux |peux |pourrais tu )?(me )?(montre[rz]? )?(la )?(compare[rz]?|comparaison (de|entre|des) |comparer)\s*/
const COMPARE_SPLIT = /\s+(?:et|vs|versus|contre|par rapport a|compare a)\s+/

/**
 * The things being compared, as raw fragments. Resolving each one to a room or a device is
 * the intent parser's job - this only decides that a comparison was asked for at all, which
 * is the part that has to not fire on "allume le salon et la cuisine".
 */
export function splitComparands(input: string): string[] | null {
  const text = normalise(input)
  if (!COMPARE_TRIGGER.test(text)) return null

  const parts = text
    .replace(COMPARE_LEAD, '')
    .split(COMPARE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part.length > 1)

  return parts.length >= 2 ? parts : null
}

// ---------------------------------------------------------------------------------------
// Autonomy: "que fais-tu de proactif ?", "agis tout seul", "demande-moi avant"
// ---------------------------------------------------------------------------------------

export type AutonomyRequest = { kind: 'ask' } | { kind: 'set'; level: 'observer' | 'assistant' | 'copilot' | 'autopilot' }

/** Words that make a sentence about the assistant's own initiative. */
const AUTONOMY_TOPIC = /(proacti|autonom|tout seul|toute seule|de toi meme|par toi meme|sans (qu on|que je|qu il faille) (te |le )?(le )?demand|initiative|on your own|by yourself)/
/** "tout seul" also describes a light that turns on by itself: only about the assistant when it is addressed. */
const ADDRESSED = /\b(tu|toi|te|vous|you|yourself)\b|proacti|autonom/
const TO_OBSERVER = /(ne touche (plus )?a rien|observe seulement|contente toi d observer|mode observateur|lecture seule)/
const TO_ASSISTANT = /(demande moi (avant|la permission|d abord)|arrete d agir|n agis (plus|pas) (tout )?seul|ne fais (plus )?rien (tout )?seul|plus d initiative|pas d initiative|mode assistant|redeviens assistant)/
const TO_AUTOPILOT = /(pilote automatique|autopilot|autopilote|gere tout( toi meme| seul| tout seul| a ma place)?$|prends tout en main|prends la maison en main)/
const TO_COPILOT = /\b(agis|agir|sois|soyez|deviens|passe|mets toi|prends|fonctionne|act|be)\b.*(autonom|tout seul|toute seule|de toi meme|par toi meme|copilot|initiative)/
/** A question about it, rather than an instruction: "tu agis tout seul ?" is not "agis tout seul". */
const QUESTION_START = /^(tu |est ce qu|qu est ce|que |qu |quoi|comment|pourquoi|es tu|as tu|fais tu|agis tu|what|do you|are you|how)/

export function parseAutonomy(input: string): AutonomyRequest | null {
  const text = normalise(input)
  if (text.length === 0) return null
  const onTopic = AUTONOMY_TOPIC.test(text) && ADDRESSED.test(text)
  const change = TO_OBSERVER.test(text) || TO_ASSISTANT.test(text) || TO_AUTOPILOT.test(text) || TO_COPILOT.test(text)
  if (!onTopic && !change) return null

  const question = /\?\s*$/.test(input.trim()) || QUESTION_START.test(text)
  if (question) return onTopic ? { kind: 'ask' } : null

  if (TO_OBSERVER.test(text)) return { kind: 'set', level: 'observer' }
  if (TO_ASSISTANT.test(text)) return { kind: 'set', level: 'assistant' }
  if (TO_AUTOPILOT.test(text)) return { kind: 'set', level: 'autopilot' }
  if (TO_COPILOT.test(text)) return { kind: 'set', level: 'copilot' }
  return onTopic ? { kind: 'ask' } : null
}
