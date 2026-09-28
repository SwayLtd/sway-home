/**
 * What to ask next.
 *
 * Under every answer, above the text field, two or three short follow-ups tied to what was
 * just said: the chambre after the salon, the month after the week, "Annule" after a switch
 * off. The rules that make them worth the space, from the follow-up chip pattern: never more
 * than three, never the question just asked, and each one a concrete next step.
 *
 * The strongest guarantee is the last test: every suggestion is a sentence the offline brain
 * understands, so a tap answers instantly, with or without a model.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { followUps, followUpsFor, type FollowUpInput } from '#agent/follow_ups'
import { parseIntent } from '#agent/intent_parser'
import { conversations, messages } from '#repositories/store'
import { dropDatabase, freshDatabase, makeDevice, seedHouse, type TestHouse } from './helpers.ts'

let fixture: TestHouse

beforeEach(async () => {
  await freshDatabase()
  fixture = seedHouse()
})

afterAll(dropDatabase)

const AREAS = [
  { name: 'Salon', measures: ['temperature', 'humidity', 'power'] },
  { name: 'Chambre', measures: ['temperature', 'humidity', 'power'] },
]

function input(patch: Partial<FollowUpInput>): FollowUpInput {
  return { question: null, tools: [], measure: null, area: null, command: null, after: null, areas: AREAS, lightsOn: 0, openAlerts: 0, actsAlone: true, hour: 15, ...patch }
}

const texts = (patch: Partial<FollowUpInput>) => followUps(input(patch)).map((entry) => entry.text)

const SCENARIOS: Partial<FollowUpInput>[] = [
  { question: 'Il fait combien dans le salon ?', tools: ['show_widget'], measure: 'temperature', area: 'Salon' },
  { question: "Quelle est l'humidité de la chambre ?", tools: ['show_widget'], measure: 'humidity', area: 'Chambre' },
  { question: "Analyse la courbe d'humidité du dernier mois", tools: ['analyse_history'], measure: 'humidity' },
  { question: 'Compare la température du salon et de la chambre', tools: ['compare_history'], measure: 'temperature', area: 'Salon' },
  { question: 'Quelle pièce consomme le plus ?', tools: ['rank'], measure: 'power' },
  { question: 'Où fait-il le plus froid ?', tools: ['rank'], measure: 'temperature' },
  { question: "Combien j'ai consommé cette semaine ?", tools: ['get_energy'], measure: 'power' },
  { question: 'Éteins tout', tools: ['control_many'], command: 'turnOff', lightsOn: 0 },
  { question: 'Allume le salon', tools: ['control_many'], command: 'turnOn', area: 'Salon', lightsOn: 2 },
  { question: 'Comment va la maison ?', tools: ['house_snapshot'], openAlerts: 2, lightsOn: 3 },
  { question: 'Que fais-tu de proactif ?', tools: ['get_autonomy'] },
  { question: 'Que fais-tu de proactif ?', tools: ['get_autonomy'], actsAlone: false },
  { after: 'reflex' },
  { hour: 8 },
  { hour: 21, lightsOn: 4 },
]

describe('tied to what was just said', () => {
  test('after a reading in one room: the other room, the curve, the comparison', () => {
    expect(texts(SCENARIOS[0]!)).toEqual([
      'Il fait combien dans la chambre ?',
      'Analyse la température du salon sur 7 jours',
      'Compare la température du salon et de la chambre',
    ])
  })

  test('after a month of curve: the week, and where it is highest', () => {
    const next = texts(SCENARIOS[2]!)
    expect(next).toContain("Analyse l'humidité sur 7 jours")
    expect(next).toContain('Quelle est la pièce la plus humide ?')
  })

  test('after a ranking of consumption: the bill', () => {
    expect(texts(SCENARIOS[4]!)).toContain("Combien j'ai consommé cette semaine ?")
  })

  test('after switching everything off: undo first', () => {
    expect(texts(SCENARIOS[7]!)[0]).toBe('Annule')
  })

  test('after switching a room on: undo, or off again', () => {
    expect(texts(SCENARIOS[8]!)).toEqual(expect.arrayContaining(['Annule', 'Éteins le salon']))
  })

  test('open alerts come first after "how is the house"', () => {
    expect(texts(SCENARIOS[9]!)[0]).toBe('Y a-t-il des alertes ?')
  })

  test('autonomy: the level can be changed from the answer, both ways', () => {
    expect(texts(SCENARIOS[10]!)).toContain("Demande-moi avant d'agir")
    expect(texts(SCENARIOS[11]!)).toContain('Agis tout seul')
  })

  test('after something it did alone: what it does, and how to stop it', () => {
    expect(texts(SCENARIOS[12]!)).toEqual(expect.arrayContaining(['Que fais-tu de proactif ?', "Demande-moi avant d'agir"]))
  })

  test('with nothing said yet, the hour decides: yesterday in the morning, the lights at night', () => {
    expect(texts(SCENARIOS[13]!)).toContain("Combien j'ai consommé hier ?")
    expect(texts(SCENARIOS[14]!)[0]).toBe('Éteins tout')
  })

  test('a room with no sensor for the measure is not suggested', () => {
    const next = texts({ ...SCENARIOS[0]!, areas: [AREAS[0]!, { name: 'Chambre', measures: ['power'] }, { name: 'Bureau', measures: ['temperature'] }] })
    expect(next[0]).toBe('Il fait combien dans le bureau ?')
  })
})

describe('the rules of the pattern', () => {
  test('three at most, all different, never the question just asked, each with an icon', () => {
    for (const scenario of SCENARIOS) {
      const next = followUps(input(scenario))
      expect(next.length).toBeGreaterThanOrEqual(2)
      expect(next.length).toBeLessThanOrEqual(3)
      expect(new Set(next.map((entry) => entry.text)).size).toBe(next.length)
      expect(next.map((entry) => entry.text)).not.toContain(scenario.question)
      for (const entry of next) expect(entry.icon).toMatch(/^ph:[a-z-]+$/)
    }
  })

  test('every suggestion is understood without a model, so a tap answers at once', () => {
    for (const scenario of SCENARIOS) {
      for (const entry of followUps(input(scenario))) {
        const intent = parseIntent(entry.text)
        expect({ text: entry.text, understood: intent !== null && intent.confidence >= 0.85 }).toEqual({ text: entry.text, understood: true })
      }
    }
  })
})

describe('from a real conversation', () => {
  test('the last question and the tool that answered it decide', () => {
    makeDevice({ nativeId: 'th-chambre', name: 'Capteur chambre', category: 'sensor', capabilities: ['temperature'], state: { temperature: 18 }, areaId: fixture.areas.chambre })
    const conversationId = conversations.create('Test')
    messages.append({ conversationId, role: 'user', content: 'Il fait combien dans le salon ?', attachments: [], toolCalls: [], toolCallId: null, usage: null })
    messages.append({
      conversationId,
      role: 'assistant',
      content: 'Il fait 19,5 °C.',
      attachments: [],
      toolCalls: [{ id: 't1', name: 'show_widget', args: {} }],
      toolCallId: null,
      usage: null,
    })
    expect(followUpsFor(conversationId).map((entry) => entry.text)[0]).toBe('Il fait combien dans la chambre ?')
  })

  test('no conversation yet still gives something to start with', () => {
    expect(followUpsFor(null).length).toBeGreaterThanOrEqual(2)
  })
})
