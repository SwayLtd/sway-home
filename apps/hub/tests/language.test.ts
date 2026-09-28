/**
 * The words a house gets asked about.
 *
 * `language.ts` is the layer under the intent parser: no database, no tools, just the job of
 * turning "la courbe d'humidité du dernier mois" into a measure, a period and an aggregate.
 * It is tested on its own because it is the part that has to be *generous* - every phrasing
 * it misses is a question the assistant answers with a shrug, and the failure is silent.
 */

import { describe, expect, test } from 'bun:test'
import { MEASURES, normalise, parseAggregate, parseAutonomy, parseMeasure, parsePeriod, splitComparands, wantsAnalysis, wantsSeries } from '#agent/language'

describe('periods', () => {
  test('the month, however it is said', () => {
    for (const phrase of ['du dernier mois', 'le mois dernier', 'ce mois ci', 'sur un mois', 'des 30 derniers jours', 'last month']) {
      expect(parsePeriod(phrase)?.hours).toBe(720)
    }
  })

  test('the week', () => {
    for (const phrase of ['cette semaine', 'la semaine derniere', 'des 7 derniers jours', 'sur une semaine', 'this week']) {
      expect(parsePeriod(phrase)?.hours).toBe(168)
    }
  })

  test('an explicit number of hours or days wins over the vague word next to it', () => {
    expect(parsePeriod('sur 12 h')?.hours).toBe(12)
    expect(parsePeriod('sur les 3 derniers jours')?.hours).toBe(72)
    expect(parsePeriod('sur 6 mois')?.hours).toBe(6 * 720)
    expect(parsePeriod('ces 48 heures')?.hours).toBe(48)
  })

  test('yesterday is a window that ends yesterday, not one that starts today', () => {
    const period = parsePeriod('hier')
    expect(period).toMatchObject({ hours: 24, offsetHours: 24 })
  })

  test('today and tonight', () => {
    expect(parsePeriod('aujourd hui')?.offsetHours).toBe(0)
    expect(parsePeriod('cette nuit')?.hours).toBeLessThanOrEqual(12)
  })

  test('the year', () => {
    expect(parsePeriod('cette annee')?.hours).toBe(8760)
  })

  test('a sentence with no period at all says so, rather than inventing one', () => {
    expect(parsePeriod('allume le salon')).toBeNull()
    expect(parsePeriod('quelle est l humidite')).toBeNull()
  })

  test('every period stays inside what the history source accepts', () => {
    for (const phrase of ['cette annee', 'sur 24 mois', 'sur 5000 jours']) {
      const period = parsePeriod(phrase)
      expect(period!.hours).toBeLessThanOrEqual(24 * 365)
      expect(period!.hours).toBeGreaterThan(0)
    }
  })

  test('the label is French and short enough for a widget title', () => {
    expect(parsePeriod('du dernier mois')!.label.length).toBeLessThan(24)
    expect(parsePeriod('du dernier mois')!.label).toContain('mois')
  })
})

describe('measures', () => {
  test('the common ones, by every word people use', () => {
    expect(parseMeasure('l humidite de la chambre')?.capability).toBe('humidity')
    expect(parseMeasure('la temperature du salon')?.capability).toBe('temperature')
    expect(parseMeasure('combien de degres')?.capability).toBe('temperature')
    expect(parseMeasure('le taux de co2')?.attribute).toBe('co2')
    expect(parseMeasure('les particules fines')?.attribute).toBe('pm25')
    expect(parseMeasure('la pression atmospherique')?.capability).toBe('pressure')
    expect(parseMeasure('la luminosite')?.capability).toBe('illuminance')
    expect(parseMeasure('le niveau des piles')?.capability).toBe('battery')
    expect(parseMeasure('la consommation')?.capability).toBe('power')
  })

  test('English asks the same questions', () => {
    expect(parseMeasure('the humidity in the bedroom')?.capability).toBe('humidity')
    expect(parseMeasure('power draw')?.capability).toBe('power')
  })

  test('a more specific word wins over the general one it sits inside', () => {
    // "qualité de l air" is the whole capability; "co2" is one reading inside it. Asking for
    // the CO2 and getting the air-quality index back is a wrong answer, not a rounding.
    expect(parseMeasure('la qualite de l air')?.attribute).toBe('co2')
    expect(parseMeasure('le co2 du salon')?.attribute).toBe('co2')
    expect(parseMeasure('les particules du salon')?.attribute).toBe('pm25')
  })

  test('nothing measurable named returns null', () => {
    expect(parseMeasure('allume la lumiere')).toBeNull()
    expect(parseMeasure('qui est la')).toBeNull()
  })

  test('every measure declares a capability that really exists and a unit', () => {
    for (const measure of MEASURES) {
      expect(measure.capability).toMatch(/^[a-zA-Z]+$/)
      expect(measure.attribute.length).toBeGreaterThan(1)
      expect(['avg', 'sum', 'min', 'max']).toContain(measure.aggregate)
      expect(measure.label.length).toBeGreaterThan(2)
    }
  })

  test('measure ids are unique', () => {
    const ids = MEASURES.map((measure) => measure.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('aggregates', () => {
  test('the words that name one', () => {
    expect(parseAggregate('la moyenne de la temperature')).toBe('avg')
    expect(parseAggregate('le maximum')).toBe('max')
    expect(parseAggregate('le pic de consommation')).toBe('max')
    // "consommé" contains "somme": a word inside another word is not a request for a sum.
    expect(parseAggregate("combien j'ai consommé")).toBeNull()
    expect(parseAggregate('le minimum')).toBe('min')
    expect(parseAggregate('la temperature la plus basse')).toBe('min')
    expect(parseAggregate('le total')).toBe('sum')
  })

  test('no word means no opinion, so the measure keeps its own default', () => {
    expect(parseAggregate('quelle est l humidite')).toBeNull()
  })
})

describe('what shape of answer is being asked for', () => {
  test('a curve', () => {
    for (const phrase of ['montre la courbe', 'l evolution de l humidite', 'un graphique', 'historique de la temperature', 'la tendance']) {
      expect(wantsSeries(phrase)).toBe(true)
    }
  })

  test('an analysis is a curve plus a verdict', () => {
    for (const phrase of ['analyse la courbe d humidite du dernier mois', 'fais moi un bilan', 'analyse moi ca', 'statistiques du salon']) {
      expect(wantsAnalysis(phrase)).toBe(true)
      expect(wantsSeries(phrase)).toBe(true)
    }
  })

  test('a plain reading is neither', () => {
    expect(wantsSeries('il fait combien dans le salon')).toBe(false)
    expect(wantsAnalysis('il fait combien dans le salon')).toBe(false)
  })
})

describe('comparisons', () => {
  test('two rooms', () => {
    expect(splitComparands('compare l humidite de la chambre et du salon')).toEqual(['l humidite de la chambre', 'du salon'])
  })

  test('the other ways of saying versus', () => {
    expect(splitComparands('compare salon vs chambre')).toHaveLength(2)
    expect(splitComparands('compare la chambre contre le bureau')).toHaveLength(2)
  })

  test('a sentence that compares nothing returns null', () => {
    expect(splitComparands('quelle est l humidite de la chambre')).toBeNull()
    expect(splitComparands('allume le salon et la cuisine')).toBeNull()
  })
})

describe('normalise', () => {
  test('accents, case, apostrophes and punctuation all disappear', () => {
    expect(normalise("Qu'est-ce qu'il y a ?")).toBe('qu est ce qu il y a')
    expect(normalise('  ÉTEINS   LE   SALON  ')).toBe('eteins le salon')
  })
})

describe('how much the assistant does on its own', () => {
  test('questions about it, however they are put', () => {
    for (const phrase of ['Que fais-tu de proactif ?', 'Tu agis tout seul ?', "Qu'est-ce que tu fais sans que je te le demande ?", 'Es-tu autonome ?', 'what do you do on your own?']) {
      expect(parseAutonomy(phrase)).toEqual({ kind: 'ask' })
    }
  })

  test('asking it to act alone', () => {
    for (const phrase of ['Agis en autonomie', 'Sois plus autonome', 'agis tout seul', 'passe en copilote', 'Prends des initiatives']) {
      expect(parseAutonomy(phrase)).toEqual({ kind: 'set', level: 'copilot' })
    }
  })

  test('handing it the whole house, or taking the initiative back', () => {
    expect(parseAutonomy('passe en pilote automatique')).toEqual({ kind: 'set', level: 'autopilot' })
    expect(parseAutonomy('gère tout toi-même')).toEqual({ kind: 'set', level: 'autopilot' })
    expect(parseAutonomy("Demande-moi avant d'agir")).toEqual({ kind: 'set', level: 'assistant' })
    expect(parseAutonomy("arrête d'agir tout seul")).toEqual({ kind: 'set', level: 'assistant' })
    expect(parseAutonomy('ne touche plus à rien')).toEqual({ kind: 'set', level: 'observer' })
  })

  test('everything else is not about autonomy', () => {
    for (const phrase of ['allume la lampe du salon', 'quelle pièce consomme le plus ?', 'éteins tout', 'mets le chauffage à 20', 'gère toutes les lumières du salon', "la lumière s'allume toute seule ?"]) {
      expect(parseAutonomy(phrase)).toBeNull()
    }
  })
})
