/**
 * "Comment va la maison ?" in one sentence, with the values set in it.
 *
 * The offline path used to answer with the `house_snapshot` tool summary verbatim: eight
 * lines of "mode: home / appareils: 39/39 en ligne / puissance: ...". That summary is written
 * for a model to read. A person gets one sentence, in the order they would want to hear it -
 * danger first, then what is left open, then that all is well - with each value set as a chip
 * (icon, rounded background) so the eye finds it, and a spoken form without the markup.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { parseRichText, stripRichText } from '@sway-home/shared'
import { houseSentence } from '#agent/briefing'
import { houseService } from '#services/house'
import { deviceRepository } from '#repositories/device_repository'
import { alerts, places } from '#repositories/store'
import { dropDatabase, freshDatabase, makeDevice, seedHouse, type TestHouse } from './helpers.ts'

let fixture: TestHouse

beforeEach(async () => {
  await freshDatabase()
  fixture = seedHouse()
})

afterAll(dropDatabase)

const sentence = () => houseSentence(houseService.snapshot())
const spoken = () => stripRichText(sentence())
const chips = () => parseRichText(sentence()).filter((segment) => segment.kind === 'chip') as { icon: string; text: string; tone: string }[]

describe('a quiet house', () => {
  test('says all is well, in one line', () => {
    expect(spoken()).toMatch(/^Tout va bien/)
    expect(sentence()).not.toContain('\n')
  })

  test('sets the values that matter as chips with icons', () => {
    const byIcon = new Map(chips().map((entry) => [entry.icon, entry.text]))
    expect(byIcon.get('ph:lightning')).toMatch(/W$/)
    expect(byIcon.get('ph:thermometer-simple')).toMatch(/°C$/)
    expect(byIcon.get('ph:wifi-high')).toMatch(/\d+\/\d+ en ligne/)
  })

  test('the temperature is indoors: the garden does not drag it down', () => {
    const garden = places.createArea({ name: 'Jardin', kind: 'garden' }).id
    makeDevice({ nativeId: 'garden-probe', name: 'Sonde jardin', category: 'sensor', capabilities: ['temperature'], state: { temperature: 5 }, areaId: garden })
    const temperature = chips().find((entry) => entry.icon === 'ph:thermometer-simple')
    expect(temperature?.text).toBe('19,5 °C')
  })

  test('counts the lights that are on, rather than listing them', () => {
    deviceRepository.mergeState(fixture.devices.lamp, { on: true }, null)
    expect(chips().some((entry) => entry.text === '1 lumière allumée')).toBe(true)
  })

  test('locked doors are good news, and look like it', () => {
    const lock = chips().find((entry) => entry.icon === 'ph:lock-simple')
    expect(lock).toMatchObject({ tone: 'ok' })
  })
})

describe('what comes first', () => {
  test('a leak opens the sentence as an alert chip, and "tout va bien" is nowhere in it', () => {
    deviceRepository.mergeState(fixture.devices.leak, { leak: true }, null)
    const first = parseRichText(sentence())[0]
    expect(first).toMatchObject({ kind: 'chip', tone: 'alert' })
    expect((first as { text: string }).text.startsWith('Fuite')).toBe(true)
    expect(spoken()).not.toMatch(/tout va bien/i)
  })

  test('an unlocked door is said out loud, as a warning', () => {
    deviceRepository.mergeState(fixture.devices.lock, { locked: false }, null)
    expect(spoken()).toContain('Serrure entrée')
    expect(chips().some((entry) => entry.tone === 'warn' && entry.text.includes('Serrure entrée'))).toBe(true)
  })

  test('one minor alert: all is well, except that one thing', () => {
    alerts.raise({ kind: 'offline', severity: 'warning', title: "TV du salon n'a pas répondu", subjectId: null })
    expect(spoken()).toMatch(/^Tout va bien/)
    expect(spoken()).toContain("Une chose : TV du salon n'a pas répondu")
  })

  test('several alerts are counted, not recited', () => {
    for (let index = 0; index < 5; index += 1) {
      alerts.raise({ kind: `test-${index}`, severity: 'warning', title: `Alerte numéro ${index}`, subjectId: null })
    }
    expect(spoken()).toMatch(/5 alertes/)
    expect(spoken()).not.toContain('Alerte numéro 3')
  })
})

describe('it stays one sentence whatever happens', () => {
  test('even with everything wrong at once', () => {
    deviceRepository.mergeState(fixture.devices.leak, { leak: true }, null)
    deviceRepository.mergeState(fixture.devices.lock, { locked: false }, null)
    deviceRepository.mergeState(fixture.devices.lamp, { on: true }, null)
    for (let index = 0; index < 20; index += 1) {
      alerts.raise({ kind: `bulk-${index}`, severity: 'warning', title: `Une alerte au titre assez long ${index}`, subjectId: null })
    }
    expect(sentence()).not.toContain('\n')
    expect(spoken().length).toBeLessThan(240)
    expect(chips().length).toBeLessThanOrEqual(8)
  })
})
