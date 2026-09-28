/**
 * AI columns on the device table.
 *
 * The devices page is a spreadsheet whose columns are properties. Some are facts (name,
 * room, state); the others are computed: "Batterie à changer ?", "Pièce probable", or a
 * column the person describes in a sentence. Computed columns resolve row by row while they
 * run, and their values are kept.
 *
 * The presets need no model: they are rules over what the hub knows. A column described in
 * words needs one; it is asked in batches, and the answer is checked - a device the model
 * forgot, or a reply that is not JSON, leaves the cell empty rather than breaking the run.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ChatRequest, ChatResponse, ModelProvider } from '#agent/providers'
import { deviceProperties, PROPERTY_PRESETS } from '#services/device_properties'
import { deviceRepository } from '#repositories/device_repository'
import { settings } from '#repositories/store'
import { dropDatabase, freshDatabase, makeDevice, seedHouse, type TestHouse } from './helpers.ts'

let fixture: TestHouse

beforeEach(async () => {
  await freshDatabase()
  fixture = seedHouse()
  settings.set('agent', { autonomy: 'copilot', llm: { provider: 'none', model: '', temperature: 0.3, maxSteps: 8, dailyBudgetUsd: 2 } })
})

afterAll(dropDatabase)

function model(reply: (request: ChatRequest) => string): ModelProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    id: 'fake',
    label: 'Fake',
    local: true,
    needsKey: false,
    defaultModel: 'fake-1',
    pricing: { input: 0, output: 0 },
    requests,
    async chat(request): Promise<ChatResponse> {
      requests.push(request)
      return { content: reply(request), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, model: 'fake-1', finishReason: 'stop' }
    },
  }
}

describe('the preset columns', () => {
  test('are listed first and need no model', () => {
    const ids = deviceProperties.list().map((property) => property.id)
    expect(ids.slice(0, PROPERTY_PRESETS.length)).toEqual(PROPERTY_PRESETS.map((preset) => preset.id))
    expect(PROPERTY_PRESETS.every((preset) => preset.needsModel === false)).toBe(true)
  })

  test('"Batterie à changer ?" reads the battery of each device', async () => {
    deviceRepository.mergeState(fixture.devices.motion, { battery: 12 }, null)

    const values = await deviceProperties.run('battery-change')

    expect(values.get(fixture.devices.motion)).toBe('Oui')
    expect(values.get(fixture.devices.lock)).toBe('Non')
    expect(values.get(fixture.devices.lamp)).toBeNull()
  })

  test('"Pièce probable" guesses a room from the name of a device that has none', async () => {
    const kitchenLamp = makeDevice({ nativeId: 'k', name: 'Lampe Chambre du fond', category: 'light', capabilities: ['onoff'], areaId: null })

    const values = await deviceProperties.run('room-guess')

    expect(values.get(kitchenLamp)).toBe('Chambre')
    expect(values.get(fixture.devices.lamp)).toBe('Salon')
  })

  test('values are kept, and come back with the table', async () => {
    deviceRepository.mergeState(fixture.devices.motion, { battery: 12 }, null)
    await deviceProperties.run('battery-change')

    const stored = deviceProperties.values()
    expect(stored['battery-change']?.[fixture.devices.motion]?.value).toBe('Oui')
  })
})

describe('a column described in words', () => {
  test('is saved, listed after the presets, and can be removed', () => {
    const property = deviceProperties.define({ label: 'À surveiller', prompt: "Ce qu'il faut surveiller sur cet appareil", kind: 'text' })

    expect(deviceProperties.list().at(-1)?.id).toBe(property.id)
    expect(property.needsModel).toBe(true)
    deviceProperties.remove(property.id)
    expect(deviceProperties.list().some((entry) => entry.id === property.id)).toBe(false)
  })

  test('is asked in batches, and each value arrives as its device resolves', async () => {
    const property = deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'select', options: ['Faible', 'Moyen', 'Élevé'] })
    const provider = model((request) => {
      const ids = [...request.messages.at(-1)!.content.matchAll(/^([0-9a-f]{8}) /gm)].map((match) => match[1]!)
      return JSON.stringify(Object.fromEntries(ids.map((id) => [id, 'Faible'])))
    })
    const arrived: string[] = []

    const values = await deviceProperties.run(property.id, { provider, batchSize: 4, onValue: (deviceId) => arrived.push(deviceId) })

    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[0]?.messages[0]?.content).toContain('Risque de panne')
    expect(provider.requests[0]?.messages[0]?.content).toContain('Faible, Moyen, Élevé')
    expect(values.size).toBe(6)
    expect([...values.values()].every((value) => value === 'Faible')).toBe(true)
    expect(arrived).toHaveLength(6)
  })

  test('a value outside the options, a forgotten device or a reply that is not JSON leaves the cell empty', async () => {
    const property = deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'select', options: ['Faible', 'Élevé'] })
    const lamp = fixture.devices.lamp.slice(0, 8)
    const plug = fixture.devices.plug.slice(0, 8)
    const provider = model(() => `Voici : {"${lamp}": "Énorme", "${plug}": "Élevé"}`)

    const values = await deviceProperties.run(property.id, { provider, batchSize: 3 })

    expect(values.get(fixture.devices.lamp)).toBeNull()
    expect(values.get(fixture.devices.plug)).toBe('Élevé')
    expect(values.get(fixture.devices.lock)).toBeNull()

    const garbled = await deviceProperties.run(property.id, { provider: model(() => 'pas du JSON'), batchSize: 3 })
    expect([...garbled.values()].every((value) => value === null)).toBe(true)
  })

  test('without a model, it says so instead of running', async () => {
    const property = deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'text' })
    await expect(deviceProperties.run(property.id)).rejects.toThrow('Il faut un modèle')
  })

  test('a bad definition is refused', () => {
    expect(() => deviceProperties.define({ label: '', prompt: 'x', kind: 'text' })).toThrow()
    expect(() => deviceProperties.define({ label: 'x', prompt: '', kind: 'text' })).toThrow()
    expect(() => deviceProperties.define({ label: 'x', prompt: 'y', kind: 'select', options: [] })).toThrow()
  })
})

describe('editing a column', () => {
  const everyDevice = (reply: string) =>
    model((request) => {
      const ids = [...request.messages.at(-1)!.content.matchAll(/^([0-9a-f]{8}) /gm)].map((match) => match[1]!)
      return JSON.stringify(Object.fromEntries(ids.map((id) => [id, reply])))
    })

  test('is done in place: same id, same position, the new words', () => {
    const first = deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'text' })
    const second = deviceProperties.define({ label: 'Âge', prompt: "L'âge de l'appareil", kind: 'text' })

    const edited = deviceProperties.update(first.id, { label: 'Risque de panne', prompt: 'Le risque de panne dans les six mois' })

    expect(edited?.id).toBe(first.id)
    expect(deviceProperties.find(first.id)).toMatchObject({ label: 'Risque de panne', prompt: 'Le risque de panne dans les six mois', kind: 'text' })
    const ids = deviceProperties.list().map((property) => property.id)
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id))
  })

  test('a new name keeps the values; a new question drops them, since they answer the old one', async () => {
    const property = deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'text' })
    await deviceProperties.run(property.id, { provider: everyDevice('faible') })

    deviceProperties.update(property.id, { label: 'Risque estimé' })
    expect(deviceProperties.values()[property.id]?.[fixture.devices.lamp]?.value).toBe('faible')

    deviceProperties.update(property.id, { prompt: 'Risque de panne cet hiver' })
    expect(deviceProperties.values()[property.id]).toBeUndefined()
  })

  test('a change of kind or of choices drops the values too', async () => {
    const property = deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'select', options: ['Faible', 'Élevé'] })
    await deviceProperties.run(property.id, { provider: everyDevice('Faible') })

    deviceProperties.update(property.id, { options: ['Faible', 'Moyen', 'Élevé'] })
    expect(deviceProperties.values()[property.id]).toBeUndefined()

    await deviceProperties.run(property.id, { provider: everyDevice('Moyen') })
    const edited = deviceProperties.update(property.id, { kind: 'text' })
    expect(edited?.options).toBeUndefined()
    expect(deviceProperties.values()[property.id]).toBeUndefined()
  })

  test('an edit is checked like a new column', () => {
    const property = deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'text' })

    expect(() => deviceProperties.update(property.id, { label: '  ' })).toThrow('Nom de colonne manquant')
    expect(() => deviceProperties.update(property.id, { prompt: '' })).toThrow('Consigne manquante')
    expect(() => deviceProperties.update(property.id, { kind: 'select', options: ['Seul'] })).toThrow('deux à huit')
    expect(() => deviceProperties.update(property.id, { kind: 'couleur' as never })).toThrow('Type de colonne inconnu')
    expect(deviceProperties.find(property.id)).toMatchObject({ label: 'Risque', prompt: 'Risque de panne', kind: 'text' })
  })

  test('a preset is not edited, and an unknown column is not found', () => {
    expect(() => deviceProperties.update('battery-change', { label: 'Piles' })).toThrow('prédéfinie')
    expect(deviceProperties.update('custom-nothere', { label: 'x' })).toBeNull()
  })
})

describe('the model of a column', () => {
  test('a column may name its own model, and forget it to follow the settings again', () => {
    const property = deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'text', model: 'anthropic:claude-sonnet-5' })
    expect(deviceProperties.find(property.id)?.model).toBe('anthropic:claude-sonnet-5')

    deviceProperties.update(property.id, { model: 'openai:gpt-6-sol' })
    expect(deviceProperties.find(property.id)?.model).toBe('openai:gpt-6-sol')

    deviceProperties.update(property.id, { model: null })
    expect(deviceProperties.find(property.id)?.model).toBeUndefined()
  })

  test('a new model keeps the values: the question has not changed', async () => {
    const property = deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'text' })
    await deviceProperties.run(property.id, {
      provider: model((request) => {
        const ids = [...request.messages.at(-1)!.content.matchAll(/^([0-9a-f]{8}) /gm)].map((match) => match[1]!)
        return JSON.stringify(Object.fromEntries(ids.map((id) => [id, 'faible'])))
      }),
    })

    deviceProperties.update(property.id, { model: 'anthropic:claude-sonnet-5' })
    expect(deviceProperties.values()[property.id]?.[fixture.devices.lamp]?.value).toBe('faible')
  })

  test('the offline engine and a model the hub does not know are refused', () => {
    expect(() => deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'text', model: 'offline' })).toThrow('moteur local')
    expect(() => deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'text', model: 'madeup:thing' })).toThrow('Modèle inconnu')
    const property = deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'text' })
    expect(() => deviceProperties.update(property.id, { model: 'nope' })).toThrow('Modèle inconnu')
  })

  test('a run uses the column model, and says why it cannot rather than taking another one', async () => {
    settings.set('agent', { autonomy: 'copilot', llm: { provider: 'ollama', model: 'qwen3:8b', temperature: 0.3, maxSteps: 8, dailyBudgetUsd: 2 } })
    const property = deviceProperties.define({ label: 'Risque', prompt: 'Risque de panne', kind: 'text', model: 'anthropic:claude-sonnet-5' })

    await expect(deviceProperties.run(property.id)).rejects.toThrow('Clé API manquante')
  })
})
