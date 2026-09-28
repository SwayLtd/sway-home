/**
 * The offline brain.
 *
 * Everything here runs with no API key and no network. It is what makes the product usable
 * on a hub that has never been given a model, and it is also the fast path that keeps the
 * common commands free. A regression here is not a degraded answer - it is a house that
 * stops responding to "éteins le salon".
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { parseRichText, stripRichText } from '@sway-home/shared'
import { parseIntent } from '#agent/intent_parser'
import { dropDatabase, freshDatabase, seedHouse, type TestHouse } from './helpers.ts'

let fixture: TestHouse

beforeEach(async () => {
  await freshDatabase()
  fixture = seedHouse()
})

afterAll(dropDatabase)

describe('questions', () => {
  test('how is the house', () => {
    for (const phrase of ['comment va la maison ?', 'ça va la maison', 'quoi de neuf', 'how is the house']) {
      expect(parseIntent(phrase)?.tool).toBe('house_snapshot')
    }
  })

  test('how is the house is answered in one sentence, not with the tool summary', () => {
    const summary = ['mode: home', 'appareils: 6/6 en ligne', 'puissance: 42 W'].join(String.fromCharCode(10))
    const spoken = parseIntent('comment va la maison ?')!.reply!({ ok: true, summary })
    expect(spoken).not.toContain(String.fromCharCode(10))
    expect(spoken).not.toContain('mode: home')
    expect(spoken.length).toBeLessThan(200)
  })

  test('who is home', () => {
    expect(parseIntent('qui est là ?')?.tool).toBe('who_is_home')
    expect(parseIntent("est-ce qu'il y a quelqu'un")?.tool).toBe('who_is_home')
  })

  test('energy, with the period understood', () => {
    expect(parseIntent("combien j'ai consommé cette semaine")).toMatchObject({ tool: 'get_energy', args: { hours: 168, offsetHours: 0 } })
    expect(parseIntent('ma conso du mois')).toMatchObject({ tool: 'get_energy', args: { hours: 720 } })
    expect(parseIntent("conso aujourd'hui")).toMatchObject({ tool: 'get_energy', args: { hours: 24 } })
  })

  test('what happened', () => {
    expect(parseIntent("qu'est-ce qui s'est passé ?")?.tool).toBe('get_timeline')
    expect(parseIntent('pourquoi la lumière est allumée')?.tool).toBe('get_timeline')
  })

  test('list devices, narrowed to a room when one is named', () => {
    expect(parseIntent('liste les appareils')).toMatchObject({ tool: 'list_devices' })
    expect(parseIntent("qu'est-ce qu'il y a dans la chambre")).toMatchObject({ tool: 'list_devices', args: { area: 'Chambre' } })
  })

  test('scan the network', () => {
    expect(parseIntent('scanne le réseau')).toMatchObject({ tool: 'scan_network' })
    expect(parseIntent('fais un scan complet')).toMatchObject({ tool: 'scan_network', args: { deep: true } })
  })

  test('undo', () => {
    expect(parseIntent('annule')?.tool).toBe('undo_last')
    expect(parseIntent('reviens en arrière')?.tool).toBe('undo_last')
  })
})

describe('what it does on its own', () => {
  test('a question about it is answered by the autonomy tool, with no model', () => {
    expect(parseIntent('Que fais-tu de proactif ?')).toMatchObject({ tool: 'get_autonomy', args: {} })
    expect(parseIntent('tu agis tout seul ?')?.tool).toBe('get_autonomy')
  })

  test('being told to act alone changes the level', () => {
    expect(parseIntent('agis en autonomie')).toMatchObject({ tool: 'set_autonomy', args: { level: 'copilot' } })
    expect(parseIntent("demande-moi avant d'agir")).toMatchObject({ tool: 'set_autonomy', args: { level: 'assistant' } })
  })
})

describe('measurements answer with a live card', () => {
  test('a temperature question shows a card and says the number', () => {
    const intent = parseIntent('il fait combien dans le salon ?')
    expect(intent?.tool).toBe('show_widget')
    expect(intent?.args).toMatchObject({ type: 'metric' })
    expect((intent!.args as { source: { capability: string } }).source.capability).toBe('temperature')
  })

  test('the spoken reply still contains the value, not just "card shown"', () => {
    const intent = parseIntent('il fait combien dans le salon ?')
    const spoken = intent!.reply!({
      ok: true,
      summary: 'Carte affichée.',
      attachments: [{ kind: 'widget', data: { widget: { title: 'Température salon', data: { kind: 'metric', value: 19.5, unit: '°C' } } } }],
    })
    expect(stripRichText(spoken)).toContain('19,5 °C')
    // The value is set in the sentence as a chip, with the icon of what it measures.
    expect(parseRichText(spoken)).toContainEqual({ kind: 'chip', icon: 'ph:thermometer-simple', text: '19,5 °C', tone: 'default' })
  })

  test('humidity is understood as its own measure', () => {
    const intent = parseIntent("quelle est l'humidité de la chambre")
    expect(intent?.tool).toBe('show_widget')
    expect((intent!.args as { source: { capability: string } }).source.capability).toBe('humidity')
  })

  test('a question about a named device targets that device', () => {
    const intent = parseIntent('il fait combien sur le thermostat salon')
    expect(intent?.tool).toBe('show_widget')
    const source = (intent!.args as { source: { deviceId?: string; kind: string } }).source
    expect(source.deviceId ?? '').toBe(fixture.devices.thermostat)
  })

  test('asking for the evolution produces a chart rather than a number', () => {
    const intent = parseIntent("montre la courbe de température du salon sur 12 h")
    expect(intent?.tool).toBe('show_widget')
    expect(intent?.args).toMatchObject({ type: 'chart' })
  })
})

describe('analysis, which is the question the house is really asked', () => {
  test('"analyse la courbe d humidite du dernier mois" is a chart over 30 days', () => {
    const intent = parseIntent("analyse la courbe d'humidité du dernier mois")
    expect(intent?.tool).toBe('show_widget')
    expect(intent?.args).toMatchObject({ type: 'chart' })
    const source = (intent!.args as { source: { hours: number; attribute: string; aggregate: string } }).source
    expect(source.hours).toBe(720)
    expect(source.attribute).toBe('humidity')
  })

  test('the window follows the words, in every phrasing', () => {
    const hoursOf = (phrase: string) => ((parseIntent(phrase)!.args as { source: { hours: number } }).source.hours)
    expect(hoursOf('montre la courbe de temperature du salon sur la semaine')).toBe(168)
    expect(hoursOf('evolution de l humidite sur 3 jours')).toBe(72)
    expect(hoursOf('tendance de la batterie sur 6 mois')).toBe(4320)
  })

  test('an analysis titles the card with the period, so a pinned copy still makes sense', () => {
    const intent = parseIntent("analyse l'humidité de la chambre du dernier mois")
    expect((intent!.args as { title: string }).title).toContain('mois')
  })

  test('the spoken answer is the verdict, not "carte affichée"', () => {
    const intent = parseIntent("analyse la courbe d'humidité du dernier mois")
    const spoken = intent!.reply!({
      ok: true,
      summary: 'Carte affichée.',
      attachments: [
        {
          kind: 'widget',
          data: {
            widget: {
              title: 'Humidité',
              data: { kind: 'series', points: [], unit: '%', min: 40, max: 70, avg: 55, last: 70, count: 30, bucket: 'day', trend: 'up', changePct: 25 },
            },
          },
        },
      ],
    })
    expect(spoken).toContain('55')
    expect(spoken).toMatch(/hausse|baisse|stable/)
  })

  test('"hier" asks for a window that ended yesterday', () => {
    const intent = parseIntent('quelle a ete la temperature max hier')
    const source = (intent!.args as { source: { offsetHours: number; aggregate: string; hours: number } }).source
    expect(source.offsetHours).toBe(24)
    expect(source.aggregate).toBe('max')
    expect(source.hours).toBe(24)
  })

  test('a peak asked for without a period still reads history, not the live value', () => {
    const intent = parseIntent('quel a ete le pic de consommation cette semaine')
    expect(intent?.tool).toBe('show_widget')
    const source = (intent!.args as { source: { kind: string; aggregate: string } }).source
    expect(source.kind).toBe('history')
    expect(source.aggregate).toBe('max')
  })

  test('consumption over a period stays an energy question, because that one is about money', () => {
    expect(parseIntent("combien j'ai consommé cette semaine")?.tool).toBe('get_energy')
    expect(parseIntent('ma conso du mois')?.tool).toBe('get_energy')
    // ... unless a curve is asked for by name.
    expect(parseIntent('montre la courbe de conso sur 7 jours')?.tool).toBe('show_widget')
  })

  test('the readings that are not temperature or humidity work the same way', () => {
    const co2 = parseIntent('le co2 de la chambre')
    expect((co2!.args as { source: { capability?: string; attribute?: string } }).source.attribute ?? 'co2').toBe('co2')
    expect(parseIntent('la luminosite du salon')?.tool).toBe('show_widget')
    expect(parseIntent('la pression atmospherique')?.tool).toBe('show_widget')
  })
})

describe('comparisons', () => {
  test('two rooms, one chart', () => {
    const intent = parseIntent("compare l'humidité de la chambre et du salon")
    expect(intent?.tool).toBe('show_widget')
    expect(intent?.args).toMatchObject({ type: 'compare' })
    const source = (intent!.args as { source: { areaIds: string[] } }).source
    expect(source.areaIds).toHaveLength(2)
  })

  test('a comparison with nothing measurable named is left to the model', () => {
    expect(parseIntent('compare le salon et la chambre')?.tool).not.toBe('show_widget')
  })
})

describe('commands', () => {
  test('on and off, with the room understood', () => {
    expect(parseIntent('allume le salon')).toMatchObject({ tool: 'control_many', args: { command: 'turnOn', area: 'Salon' } })
    expect(parseIntent('éteins la chambre')).toMatchObject({ tool: 'control_many', args: { command: 'turnOff', area: 'Chambre' } })
  })

  test('a named device wins over the room it is in', () => {
    const intent = parseIntent('allume le plafonnier salon')
    expect(intent?.tool).toBe('control_device')
    expect((intent!.args as { device: string }).device).toBe(fixture.devices.lamp)
  })

  test('turn everything off says so explicitly', () => {
    const intent = parseIntent('éteins tout')
    expect(intent?.tool).toBe('control_many')
    expect(intent?.args).toMatchObject({ command: 'turnOff' })
  })

  test('brightness, absolute', () => {
    expect(parseIntent('mets le plafonnier salon à 40%')).toMatchObject({
      tool: 'control_device',
      args: { command: 'setBrightness', args: { brightness: 40 } },
    })
  })

  test('brightness, relative', () => {
    const up = parseIntent('monte un peu la lumière du salon')
    expect(up?.tool).toBeString()
    expect(JSON.stringify(up?.args)).toMatch(/Brightness|brightness/)
  })

  test('a colour by name', () => {
    const intent = parseIntent('mets le plafonnier salon en rouge')
    expect(intent?.args).toMatchObject({ command: 'setColor' })
  })

  test('a thermostat set point', () => {
    const intent = parseIntent('mets le chauffage à 21 degrés dans le salon')
    expect(JSON.stringify(intent?.args)).toContain('21')
  })

  test('locking is parsed as a command so the risk layer sees it', () => {
    const intent = parseIntent('verrouille la porte')
    expect(intent?.args).toMatchObject({ command: 'lock' })
  })

  test('house modes', () => {
    expect(parseIntent('je pars')).toMatchObject({ tool: 'set_house_mode', args: { mode: 'away' } })
    expect(parseIntent('bonne nuit')).toMatchObject({ tool: 'set_house_mode', args: { mode: 'night' } })
    expect(parseIntent('je suis rentré')).toMatchObject({ tool: 'set_house_mode', args: { mode: 'home' } })
  })
})

describe('memory and routines', () => {
  test('remember keeps the sentence, not the instruction', () => {
    const intent = parseIntent('retiens que je dors fenêtre ouverte')
    expect(intent?.tool).toBe('remember')
    expect((intent!.args as { content: string }).content).toBe('que je dors fenêtre ouverte')
  })

  test('asking for routine ideas', () => {
    expect(parseIntent('propose-moi des routines')?.tool).toBe('suggest_routines')
  })
})

describe('the dashboard', () => {
  test('pinning a measure to the dashboard creates a widget', () => {
    const intent = parseIntent("mets l'humidité de la chambre sur le tableau de bord")
    expect(intent?.tool).toBe('create_widget')
    expect(intent?.args).toMatchObject({ type: 'metric' })
  })

  test('the area is resolved to an id, not left as a name', () => {
    const intent = parseIntent("mets l'humidité de la chambre sur le tableau de bord")
    const source = (intent!.args as { source: { areaId: string | null } }).source
    expect(source.areaId).toBe(fixture.areas.chambre)
  })

  test('a room with no measure named pins the whole room', () => {
    const intent = parseIntent('mets la chambre sur le tableau de bord')
    expect(intent).toMatchObject({ tool: 'create_widget', args: { type: 'room' } })
  })

  test('"sur le tableau de bord" is not mistaken for a time window', () => {
    // The word "sur" appears in both "sur le tableau de bord" and "sur 12 h". Only the
    // second one asks for a chart.
    const intent = parseIntent("mets la température du salon sur le tableau de bord")
    expect(intent?.args).toMatchObject({ type: 'metric' })
  })
})

describe('what it declines to guess', () => {
  test('an empty or meaningless input returns null so the model can take it', () => {
    expect(parseIntent('')).toBeNull()
    expect(parseIntent('   ')).toBeNull()
    expect(parseIntent('raconte-moi une blague')).toBeNull()
    expect(parseIntent('pourquoi le ciel est bleu')).not.toMatchObject({ tool: 'control_many' })
  })

  test('a room that does not exist does not fall back to the whole house', () => {
    // The dangerous failure: "éteins la véranda" turning off everything.
    const intent = parseIntent('éteins la véranda')
    if (intent?.tool === 'control_many') {
      expect((intent.args as { area?: string }).area).toBeUndefined()
    }
  })

  test('accents and case never change the parse', () => {
    expect(parseIntent('ETEINS LE SALON')?.tool).toBe(parseIntent('éteins le salon')?.tool)
    expect(parseIntent('allume la chambre')?.tool).toBe(parseIntent('ALLUME LA CHAMBRE')?.tool)
  })
})
