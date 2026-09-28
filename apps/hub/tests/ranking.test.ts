/**
 * "Quelle pièce consomme le plus en ce moment ?"
 *
 * The question that exposed the gap: it was routed to the seven-day energy report and came
 * back as sixteen raw lines. A ranking question wants an order - who is first, by how much,
 * who comes next - and the order can be of anything the house measures: the draw right now,
 * the energy over a week, the warmest room, the driest bedroom. One widget source, `ranking`,
 * resolves all of them, and one sentence says the answer with its values set as chips.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { parseRichText, stripRichText, type Widget, type WidgetData, type WidgetSource } from '@sway-home/shared'
import { widgetService } from '#services/widget_service'
import { describeEnergy, describeRanking } from '#agent/briefing'
import { parseIntent } from '#agent/intent_parser'
import { deviceRepository } from '#repositories/device_repository'
import { places } from '#repositories/store'
import { database } from '#db/database'
import { dropDatabase, freshDatabase, makeDevice, recordHistory, seedHouse, type TestHouse } from './helpers.ts'

let fixture: TestHouse

beforeEach(async () => {
  await freshDatabase()
  fixture = seedHouse()
})

afterAll(dropDatabase)

type RankingSource = Extract<WidgetSource, { kind: 'ranking' }>
type Ranking = Extract<WidgetData, { kind: 'ranking' }>

function rank(source: Partial<RankingSource> & { attribute: string }): WidgetData {
  const at = new Date().toISOString()
  return widgetService.data({
    id: 'w',
    dashboardId: 'home',
    type: 'ranking',
    title: 'Classement',
    subtitle: null,
    icon: null,
    size: 'md',
    position: 0,
    source: { kind: 'ranking', capability: source.attribute, ...source },
    options: {},
    authoredBy: 'agent',
    reason: null,
    visible: true,
    createdAt: at,
    updatedAt: at,
  } as Widget)
}

function ranked(source: Partial<RankingSource> & { attribute: string }): Ranking {
  const data = rank(source)
  if (data.kind !== 'ranking') throw new Error(`expected a ranking, got ${data.kind}: ${JSON.stringify(data)}`)
  return data
}

/** A kitchen that draws far more than the rest, which is what makes an order readable. */
function kitchen(): { kettle: string; fridge: string; area: string } {
  const area = places.createArea({ name: 'Cuisine', kind: 'kitchen' }).id
  const kettle = makeDevice({ nativeId: 'kettle', name: 'Bouilloire', category: 'appliance', capabilities: ['onoff', 'power'], state: { on: true, power: 1800 }, areaId: area })
  const fridge = makeDevice({ nativeId: 'fridge', name: 'Frigo', category: 'appliance', capabilities: ['power'], state: { power: 120 }, areaId: area })
  return { kettle, fridge, area }
}

/** One hourly energy roll-up, `hoursAgo` hours back. */
function energy(deviceId: string, hoursAgo: number, kwh: number): void {
  const hour = new Date(Date.now() - hoursAgo * 3_600_000).toISOString().slice(0, 13)
  database().run(
    `INSERT INTO energy_hourly (device_id, hour, kwh, avg_power, max_power, cost) VALUES (?, ?, ?, 0, 0, ?)
     ON CONFLICT(device_id, hour) DO UPDATE SET kwh = excluded.kwh, cost = excluded.cost`,
    [deviceId, hour, kwh, kwh * 0.2516]
  )
}

const chips = (text: string) =>
  parseRichText(text).flatMap((segment) => (segment.kind === 'chip' ? [{ icon: segment.icon, text: segment.text, tone: segment.tone }] : []))

// ---------------------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------------------

describe('who draws the most right now', () => {
  test('rooms are ranked by what their devices draw together', () => {
    kitchen()
    const data = ranked({ attribute: 'power', aggregate: 'sum' })
    expect(data.entries.map((entry) => entry.label)).toEqual(['Cuisine', 'Chambre', 'Salon'])
    expect(data.entries.map((entry) => entry.value)).toEqual([1920, 42, 0])
    expect(data.unit).toBe('W')
    expect(data.total).toBe(1962)
    expect(data.entries[0]!.share).toBeCloseTo(1920 / 1962, 5)
  })

  test('each room carries the icon of its kind, so the chip and the card show the same thing', () => {
    kitchen()
    const data = ranked({ attribute: 'power', aggregate: 'sum' })
    expect(data.entries[0]!.icon).toBe('ph:cooking-pot')
    expect(data.entries.find((entry) => entry.label === 'Chambre')?.icon).toBe('ph:bed')
  })

  test('devices are ranked one by one, with the icon of their category', () => {
    kitchen()
    const data = ranked({ attribute: 'power', aggregate: 'sum', by: 'device' })
    expect(data.entries.map((entry) => entry.label)).toEqual(['Bouilloire', 'Frigo', 'Prise bureau', 'Plafonnier salon'])
    expect(data.entries.find((entry) => entry.label === 'Prise bureau')?.icon).toBe('ph:plug')
  })

  test('an offline device is left out: its last reading is not what it draws now', () => {
    const { kettle } = kitchen()
    deviceRepository.setOnline(kettle, false)
    const data = ranked({ attribute: 'power', aggregate: 'sum' })
    expect(data.entries[0]).toMatchObject({ label: 'Cuisine', value: 120 })
  })

  test('the limit keeps the card short, and the total still counts everything', () => {
    kitchen()
    const data = ranked({ attribute: 'power', aggregate: 'sum', by: 'device', limit: 2 })
    expect(data.entries).toHaveLength(2)
    expect(data.count).toBe(4)
    expect(data.total).toBe(1962)
  })

  test('one room only, when the question names it: "quel appareil de la cuisine"', () => {
    const { area } = kitchen()
    const data = ranked({ attribute: 'power', aggregate: 'sum', by: 'device', areaId: area })
    expect(data.entries.map((entry) => entry.label)).toEqual(['Bouilloire', 'Frigo'])
  })

  test('a measure nothing reports is an empty state, not a crash', () => {
    expect(rank({ attribute: 'co2' }).kind).toBe('empty')
  })
})

describe('warmest, coldest, most humid', () => {
  test('temperatures average within a room, and averages are never added up', () => {
    makeDevice({ nativeId: 't-salon', name: 'Sonde salon', category: 'sensor', capabilities: ['temperature'], state: { temperature: 21.5 }, areaId: fixture.areas.salon })
    makeDevice({ nativeId: 't-chambre', name: 'Sonde chambre', category: 'sensor', capabilities: ['temperature'], state: { temperature: 17 }, areaId: fixture.areas.chambre })
    const data = ranked({ attribute: 'temperature', order: 'desc' })
    expect(data.entries.map((entry) => [entry.label, entry.value])).toEqual([
      ['Salon', 20.5],
      ['Chambre', 17],
    ])
    expect(data.total).toBeNull()
    expect(data.entries[0]!.share).toBeNull()
  })

  test('ascending puts the coldest first', () => {
    makeDevice({ nativeId: 't-chambre', name: 'Sonde chambre', category: 'sensor', capabilities: ['temperature'], state: { temperature: 17 }, areaId: fixture.areas.chambre })
    const data = ranked({ attribute: 'temperature', order: 'asc' })
    expect(data.entries[0]).toMatchObject({ label: 'Chambre', value: 17 })
    expect(data.order).toBe('asc')
  })

  test('the garden is not a room: "quelle pièce" leaves it out, "où" does not', () => {
    const garden = places.createArea({ name: 'Jardin', kind: 'garden' }).id
    makeDevice({ nativeId: 't-jardin', name: 'Sonde jardin', category: 'sensor', capabilities: ['temperature'], state: { temperature: 5 }, areaId: garden })
    expect(ranked({ attribute: 'temperature', order: 'asc', indoor: true }).entries.map((entry) => entry.label)).not.toContain('Jardin')
    expect(ranked({ attribute: 'temperature', order: 'asc', indoor: false }).entries[0]!.label).toBe('Jardin')
  })
})

describe('over a period', () => {
  beforeEach(() => {
    // The fixture's first poll writes a live reading into history. These tests assert exact
    // energy figures over windows they control, so that reading goes.
    database().run('DELETE FROM state_history')
  })

  test('power over a window ranks energy, in kWh, from the hourly roll-ups', () => {
    energy(fixture.devices.plug, 5, 1)
    energy(fixture.devices.plug, 50, 1)
    energy(fixture.devices.lamp, 3, 0.5)
    energy(fixture.devices.plug, 240, 10) // ten days ago: outside a week
    const data = ranked({ attribute: 'power', aggregate: 'sum', by: 'device', hours: 168 })
    expect(data.unit).toBe('kWh')
    expect(data.entries.map((entry) => [entry.label, entry.value])).toEqual([
      ['Prise bureau', 2],
      ['Plafonnier salon', 0.5],
    ])
    expect(data.total).toBe(2.5)
  })

  test('a window that ended yesterday leaves today out', () => {
    energy(fixture.devices.plug, 2, 5)
    energy(fixture.devices.plug, 30, 1)
    const data = ranked({ attribute: 'power', aggregate: 'sum', by: 'device', hours: 24, offsetHours: 24 })
    expect(data.entries).toEqual([expect.objectContaining({ label: 'Prise bureau', value: 1 })])
  })

  test('an hour not rolled up yet still counts, from the raw readings', () => {
    recordHistory(fixture.devices.plug, 'power', 1000, new Date(Date.now() - 2 * 3_600_000))
    const data = ranked({ attribute: 'power', aggregate: 'sum', by: 'device', hours: 24 })
    expect(data.entries[0]).toMatchObject({ label: 'Prise bureau', value: 1 })
  })

  test('an hour already rolled up is not counted a second time from its raw readings', () => {
    recordHistory(fixture.devices.plug, 'power', 1000, new Date(Date.now() - 2 * 3_600_000))
    energy(fixture.devices.plug, 2, 1)
    const data = ranked({ attribute: 'power', aggregate: 'sum', by: 'device', hours: 24 })
    expect(data.entries[0]).toMatchObject({ label: 'Prise bureau', value: 1 })
  })

  test('the total is the whole bill, a device removed since included, so the card and the sentence agree', () => {
    energy(fixture.devices.plug, 5, 2)
    energy('a-device-that-was-removed', 5, 1)
    const data = ranked({ attribute: 'power', aggregate: 'sum', by: 'device', hours: 168 })
    expect(data.entries.map((entry) => entry.label)).toEqual(['Prise bureau'])
    expect(data.total).toBe(3)
    expect(data.entries[0]!.share).toBeCloseTo(2 / 3, 5)
  })

  test('narrowed to one room, the total is that room', () => {
    energy(fixture.devices.plug, 5, 2)
    energy(fixture.devices.lamp, 5, 0.5)
    energy('a-device-that-was-removed', 5, 1)
    const data = ranked({ attribute: 'power', aggregate: 'sum', by: 'device', hours: 168, areaId: fixture.areas.chambre })
    expect(data.total).toBe(2)
  })

  test('rooms add up the energy of their devices', () => {
    energy(fixture.devices.plug, 5, 2)
    energy(fixture.devices.lamp, 5, 0.5)
    const data = ranked({ attribute: 'power', aggregate: 'sum', hours: 168 })
    expect(data.entries.map((entry) => [entry.label, entry.value])).toEqual([
      ['Chambre', 2],
      ['Salon', 0.5],
    ])
  })

  test('any other measure ranks its average over the window, from history', () => {
    const probe = makeDevice({ nativeId: 't-chambre', name: 'Sonde chambre', category: 'sensor', capabilities: ['temperature'], state: { temperature: 30 }, areaId: fixture.areas.chambre })
    database().run('DELETE FROM state_history')
    recordHistory(fixture.devices.thermostat, 'temperature', 20, new Date(Date.now() - 3 * 3_600_000))
    recordHistory(fixture.devices.thermostat, 'temperature', 20, new Date(Date.now() - 2 * 3_600_000))
    recordHistory(probe, 'temperature', 16, new Date(Date.now() - 2 * 3_600_000))
    // The live 30 °C is not what the day looked like.
    const data = ranked({ attribute: 'temperature', order: 'asc', hours: 24 })
    expect(data.entries.map((entry) => [entry.label, entry.value])).toEqual([
      ['Chambre', 16],
      ['Salon', 20],
    ])
  })
})

// ---------------------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------------------

const POWER = { label: 'consommation', icon: 'ph:lightning', decimals: 0 }
const TEMPERATURE = { label: 'température', icon: 'ph:thermometer-simple', decimals: 1 }

function entry(label: string, value: number, share: number | null = null, icon = 'ph:house-line') {
  return { id: label, label, icon, value, share }
}

describe('the ranking, said in one sentence', () => {
  test('the leader and its value are chips; the runner-up is said plainly', () => {
    kitchen()
    const sentence = describeRanking(ranked({ attribute: 'power', aggregate: 'sum' }), { ...POWER, period: null })
    expect(chips(sentence).slice(0, 2)).toEqual([
      { icon: 'ph:cooking-pot', text: 'Cuisine', tone: 'default' },
      { icon: 'ph:lightning', text: '1,9 kW', tone: 'default' },
    ])
    expect(stripRichText(sentence)).toBe('Cuisine en tête avec 1,9 kW sur 2 kW, puis Chambre (42 W).')
  })

  test('the lowest is said as the lowest, not as a winner', () => {
    const data: Ranking = { kind: 'ranking', unit: '°C', by: 'area', order: 'asc', total: null, count: 2, entries: [entry('Chambre', 17), entry('Salon', 20.5)] }
    expect(stripRichText(describeRanking(data, { ...TEMPERATURE, period: null }))).toBe('Chambre au plus bas avec 17 °C, puis Salon (20,5 °C).')
  })

  test('a leader with the whole total is not "sur" itself', () => {
    const data: Ranking = { kind: 'ranking', unit: 'W', by: 'area', order: 'desc', total: 42, count: 2, entries: [entry('Chambre', 42, 1), entry('Salon', 0, 0)] }
    expect(stripRichText(describeRanking(data, { ...POWER, period: null }))).toBe('Chambre en tête avec 42 W, puis Salon (0 W).')
  })

  test('one room is not a ranking, and says so', () => {
    const data: Ranking = { kind: 'ranking', unit: 'W', by: 'area', order: 'desc', total: 42, count: 1, entries: [entry('Chambre', 42, 1)] }
    expect(stripRichText(describeRanking(data, { ...POWER, period: null }))).toBe('Chambre : 42 W, seule pièce mesurée.')
    const device: Ranking = { ...data, by: 'device', entries: [entry('Prise bureau', 42, 1)] }
    expect(stripRichText(describeRanking(device, { ...POWER, period: null }))).toBe('Prise bureau : 42 W, seul appareil mesuré.')
  })

  test('nothing drawing anything is said plainly', () => {
    const data: Ranking = { kind: 'ranking', unit: 'W', by: 'area', order: 'desc', total: 0, count: 2, entries: [entry('Chambre', 0, 0), entry('Salon', 0, 0)] }
    expect(describeRanking(data, { ...POWER, period: null })).toBe('Rien ne consomme en ce moment.')
  })

  test('a period opens the sentence', () => {
    const data: Ranking = { kind: 'ranking', unit: 'kWh', by: 'device', order: 'desc', total: 2.5, count: 2, entries: [entry('Prise bureau', 2, 0.8), entry('Plafonnier salon', 0.5, 0.2)] }
    expect(stripRichText(describeRanking(data, { ...POWER, period: 'sur une semaine' }))).toBe('Sur une semaine, Prise bureau en tête avec 2 kWh sur 2,5 kWh, puis Plafonnier salon (500 Wh).')
  })

  test('no energy over a period is not "rien ne consomme en ce moment"', () => {
    const data: Ranking = { kind: 'ranking', unit: 'kWh', by: 'device', order: 'desc', total: 0, count: 1, entries: [entry('Prise bureau', 0, 0)] }
    expect(describeRanking(data, { ...POWER, period: 'hier' })).toBe('Aucune consommation hier.')
  })

  test('an empty result says what is missing', () => {
    expect(describeRanking({ kind: 'empty', message: 'x' }, { label: 'humidité', icon: 'ph:drop', decimals: 0, period: null })).toBe("Aucune mesure d'humidité pour l'instant.")
    expect(describeRanking({ kind: 'empty', message: 'x' }, { ...POWER, period: 'sur une semaine' })).toBe('Aucune mesure de consommation sur une semaine.')
  })

  test('stays one short line, however big the house', () => {
    const area = places.createArea({ name: 'Atelier', kind: 'other' }).id
    for (let index = 0; index < 30; index += 1) {
      makeDevice({ nativeId: `plug-${index}`, name: `Prise numéro ${index} avec un nom long`, category: 'outlet', capabilities: ['power'], state: { power: 10 + index }, areaId: area })
    }
    const sentence = describeRanking(ranked({ attribute: 'power', aggregate: 'sum', by: 'device' }), { ...POWER, period: null })
    expect(sentence).not.toContain('\n')
    expect(stripRichText(sentence).length).toBeLessThan(140)
    expect(chips(sentence).length).toBeLessThanOrEqual(3)
  })
})

describe('energy over a period, said in one sentence', () => {
  test('kilowatt-hours and money are chips, and the device that weighs most is named', () => {
    const sentence = describeEnergy({ period: 'sur une semaine', kwh: 2.5, cost: 0.629, currency: 'EUR', top: { label: 'Prise bureau', icon: 'ph:plug', share: 0.8 } })
    expect(chips(sentence)).toEqual([
      { icon: 'ph:lightning', text: '2,5 kWh', tone: 'default' },
      { icon: 'ph:currency-eur', text: '0,63 €', tone: 'default' },
      { icon: 'ph:plug', text: 'Prise bureau', tone: 'default' },
    ])
    expect(stripRichText(sentence)).toBe('Sur une semaine : 2,5 kWh pour 0,63 €, surtout Prise bureau (80 %).')
  })

  test('a tiny consumption is said in watt-hours, and under a cent is not "0,00 €"', () => {
    expect(stripRichText(describeEnergy({ period: "aujourd'hui", kwh: 0.006, cost: 0.0015, currency: 'EUR', top: null }))).toBe("Aujourd'hui : 6 Wh pour moins de 0,01 €.")
  })

  test('nothing recorded is said as such', () => {
    expect(describeEnergy({ period: 'hier', kwh: 0, cost: 0, currency: 'EUR', top: null })).toBe('Aucune consommation mesurée hier.')
  })

  test('one device asked by name', () => {
    const sentence = describeEnergy({ period: 'sur une semaine', kwh: 2, cost: 0.5, currency: 'EUR', top: null, device: { label: 'Prise bureau', icon: 'ph:plug' } })
    expect(stripRichText(sentence)).toBe('Prise bureau : 2 kWh sur une semaine, soit 0,50 €.')
    expect(chips(sentence)[0]).toMatchObject({ icon: 'ph:plug', text: 'Prise bureau' })
  })
})

// ---------------------------------------------------------------------------------------
// The questions that ask for it
// ---------------------------------------------------------------------------------------

describe('asking', () => {
  test('"quelle pièce consomme le plus en ce moment ?" is a live ranking of rooms', () => {
    expect(parseIntent('Quelle pièce consomme le plus en ce moment ?')).toMatchObject({
      tool: 'rank',
      args: { measure: 'power', by: 'area', order: 'desc', hours: 0 },
    })
  })

  test('the garden is left out of "quelle pièce" for a climate reading, never for consumption: it is on the bill', () => {
    expect(parseIntent('quelle pièce consomme le plus')).toMatchObject({ args: { indoor: false } })
    expect(parseIntent('quelle pièce est la plus humide')).toMatchObject({ args: { indoor: true } })
  })

  test('"qu\'est-ce qui consomme le plus ?" ranks devices', () => {
    expect(parseIntent("Qu'est-ce qui consomme le plus ?")).toMatchObject({ tool: 'rank', args: { measure: 'power', by: 'device' } })
    expect(parseIntent('quel appareil consomme le plus')).toMatchObject({ tool: 'rank', args: { by: 'device' } })
  })

  test('with a period, it ranks the energy over that period', () => {
    expect(parseIntent('quel appareil a le plus consommé cette semaine ?')).toMatchObject({ tool: 'rank', args: { measure: 'power', by: 'device', hours: 168, offsetHours: 0 } })
    expect(parseIntent('quelle pièce a le plus consommé hier')).toMatchObject({ tool: 'rank', args: { by: 'area', hours: 24, offsetHours: 24 } })
  })

  test('warmest and coldest rooms', () => {
    expect(parseIntent('où fait-il le plus chaud ?')).toMatchObject({ tool: 'rank', args: { measure: 'temperature', by: 'area', order: 'desc' } })
    expect(parseIntent('quelle est la pièce la plus froide ?')).toMatchObject({ tool: 'rank', args: { measure: 'temperature', order: 'asc', indoor: true } })
    expect(parseIntent('dans quelle chambre il fait le plus frais')).toMatchObject({ tool: 'rank', args: { measure: 'temperature', order: 'asc' } })
    // "Least cold" is the warmest.
    expect(parseIntent('quelle pièce est la moins froide')).toMatchObject({ tool: 'rank', args: { measure: 'temperature', order: 'desc' } })
  })

  test('"où" includes the garden; "quelle pièce" does not', () => {
    expect(parseIntent('où fait-il le plus froid ?')).toMatchObject({ args: { indoor: false } })
    expect(parseIntent('quelle pièce est la plus froide')).toMatchObject({ args: { indoor: true } })
  })

  test('most humid and driest', () => {
    expect(parseIntent('quelle pièce est la plus humide ?')).toMatchObject({ tool: 'rank', args: { measure: 'humidity', order: 'desc' } })
    expect(parseIntent('quelle est la pièce la plus sèche')).toMatchObject({ tool: 'rank', args: { measure: 'humidity', order: 'asc' } })
  })

  test('devices of one room, when the room is named', () => {
    expect(parseIntent('quel appareil du salon consomme le plus ?')).toMatchObject({ tool: 'rank', args: { by: 'device', areaId: fixture.areas.salon } })
    // A room word that is the subject of the question is not a filter.
    expect((parseIntent('dans quelle chambre il fait le plus frais')!.args as { areaId?: unknown }).areaId).toBeUndefined()
  })

  test('"top 3" sets how many', () => {
    expect(parseIntent('top 3 des appareils qui consomment le plus')).toMatchObject({ tool: 'rank', args: { by: 'device', limit: 3 } })
  })

  test('English works the same way', () => {
    expect(parseIntent('which room is the warmest?')).toMatchObject({ tool: 'rank', args: { measure: 'temperature', by: 'area', order: 'desc' } })
    expect(parseIntent('what uses the most power right now')).toMatchObject({ tool: 'rank', args: { measure: 'power', by: 'device', hours: 0 } })
  })

  test('a command that happens to contain a ranking is still a command', () => {
    expect(parseIntent("éteins l'appareil qui consomme le plus")?.tool).not.toBe('rank')
  })

  test('a superlative about a value, not about a place, stays a reading', () => {
    expect(parseIntent('quelle a été la température la plus haute cette semaine')?.tool).toBe('show_widget')
    expect(parseIntent('quel est le max de co2 aujourd hui')?.tool).toBe('show_widget')
  })

  test('the ranking answers with its own sentence, not a tool dump', () => {
    const intent = parseIntent('Quelle pièce consomme le plus en ce moment ?')!
    expect(intent.reply).toBeUndefined()
  })
})

describe('energy questions keep their period', () => {
  test('a past tense with no period is a bill question', () => {
    expect(parseIntent("combien j'ai consommé ?")).toMatchObject({ tool: 'get_energy' })
  })

  test('"hier" is the day that ended, not the last 24 hours', () => {
    expect(parseIntent("combien j'ai consommé hier ?")).toMatchObject({ tool: 'get_energy', args: { hours: 24, offsetHours: 24 } })
  })

  test('a present tense is the live draw', () => {
    const intent = parseIntent('combien je consomme en ce moment ?')
    expect(intent?.tool).toBe('show_widget')
    expect((intent!.args as { source: { kind: string; capability: string } }).source).toMatchObject({ kind: 'capability', capability: 'power' })
  })
})
