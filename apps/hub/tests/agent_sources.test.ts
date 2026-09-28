/**
 * Where an answer comes from.
 *
 * An answer about the house is only as good as what was read to write it. The console cites
 * those reads next to the sentence (the device, the history, the energy report) and shows the
 * memories the assistant had in mind as context cards. Both are derived here, from the run's
 * own trace and from the question, so they are facts about the run and not decoration.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentTraceEntry, Memory } from '@sway-home/shared'
import type { ChatResponse, ModelProvider } from '#agent/providers'
import { agentService } from '#agent/agent_service'
import { contextFor, relevantMemories, sourcesFromTrace } from '#agent/sources'
import { adapters } from '#services/adapter_manager'
import { houseService } from '#services/house'
import { memories, messages, settings } from '#repositories/store'
import { dropDatabase, freshDatabase, seedHouse, type TestHouse } from './helpers.ts'
import { FakeAdapter } from './fake_adapter.ts'

const adapter = new FakeAdapter()
let fixture: TestHouse

function tool(name: string, args: Record<string, unknown>, ok = true): AgentTraceEntry {
  return { kind: 'tool', id: `${name}-${Math.random()}`, name, args, ok, summary: 'fait', durationMs: 3 }
}

function scripted(turns: Partial<ChatResponse>[]): ModelProvider {
  let index = 0
  return {
    id: 'fake',
    label: 'Fake',
    local: true,
    needsKey: false,
    defaultModel: 'fake-1',
    pricing: { input: 0, output: 0 },
    async chat() {
      const turn = turns[index++] ?? { content: 'Fin.' }
      return { content: turn.content ?? '', toolCalls: turn.toolCalls ?? [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, model: 'fake-1', finishReason: 'stop' }
    },
  }
}

function memory(content: string, extra: Partial<Memory> = {}): Memory {
  const at = new Date().toISOString()
  return {
    id: content,
    kind: 'preference',
    content,
    subjectType: 'house',
    subjectId: null,
    confidence: 0.8,
    strength: 0.5,
    source: 'stated',
    evidenceCount: 1,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: at,
    updatedAt: at,
    ...extra,
  }
}

beforeEach(async () => {
  await freshDatabase()
  adapter.reset()
  fixture = seedHouse()
  adapters.register(adapter)
  await adapters.start('test')
  settings.set('agent', { autonomy: 'copilot', llm: { provider: 'none', model: '', temperature: 0.3, maxSteps: 8, dailyBudgetUsd: 2 } })
})

afterAll(dropDatabase)

describe('the sources of an answer', () => {
  test('each read becomes one source, with the page it lives on', () => {
    const scene = houseService.snapshotScene('Cinéma', { areaName: 'Salon' })
    const remembered = memories.remember({ kind: 'preference', content: 'Préfère 20 °C le soir dans le salon', source: 'stated' })

    const sources = sourcesFromTrace([
      tool('get_device', { device: 'Plafonnier salon' }),
      tool('control_device', { device: 'Plafonnier salon', command: 'turnOn' }),
      tool('get_energy', { days: 7 }),
      tool('recall', { query: 'salon' }),
      tool('activate_scene', { scene: 'Cinéma' }),
      tool('get_timeline', { limit: 20 }),
    ])

    expect(sources.map((source) => source.kind)).toEqual(['device', 'energy', 'memory', 'scene', 'timeline'])
    const [device, energy, recalled, recalledScene, timeline] = sources
    expect(device?.id).toBe(fixture.devices.lamp)
    expect(device?.title).toBe('Plafonnier salon')
    expect(device?.subtitle).toBe('Salon')
    expect(device?.href).toBe(`/devices/${fixture.devices.lamp}`)
    expect(device?.icon).toBe('ph:lightbulb-filament')
    expect(energy?.href).toBe('/energy')
    expect(recalled?.id).toBe(remembered.id)
    expect(recalled?.href).toBe('/memory')
    expect(recalledScene?.id).toBe(scene)
    expect(recalledScene?.title).toBe('Cinéma')
    expect(timeline?.href).toBe('/timeline')
  })

  test('a failed or unanswered tool is not a source', () => {
    const sources = sourcesFromTrace([
      tool('get_device', { device: 'Plafonnier salon' }, false),
      { kind: 'tool', id: 'late', name: 'get_device', args: { device: 'Prise bureau' }, ok: null, summary: '', durationMs: 0 },
      { kind: 'reasoning', id: 'r', text: 'Je regarde.' },
    ])
    expect(sources).toEqual([])
  })

  test('a history read names the device and what was measured', () => {
    const [source] = sourcesFromTrace([tool('get_history', { device: 'Thermostat salon', attribute: 'temperature', hours: 48 })])
    expect(source?.kind).toBe('history')
    expect(source?.title).toBe('Thermostat salon')
    expect(source?.subtitle).toBe('Historique température, 48 h')
    expect(source?.href).toBe(`/devices/${fixture.devices.thermostat}`)
  })

  test('an answer cites six sources at most', () => {
    const trace = Array.from({ length: 9 }, (_, index) => tool('recall', { query: `x${index}` }))
    for (let index = 0; index < 9; index += 1) memories.remember({ kind: 'fact', content: `x${index} est un fait`, source: 'stated' })
    expect(sourcesFromTrace(trace).length).toBeLessThanOrEqual(6)
  })
})

describe('the memories in mind', () => {
  const salon = memory('Préfère 20 °C le soir dans le salon')
  const cat = memory('Le chat dort dans la chambre', { kind: 'fact' })
  const shutters = memory("Les volets du bureau restent fermés l'été", { kind: 'habit' })

  test('the memories that share words with the question come first', () => {
    const found = relevantMemories('Quelle température le soir au salon ?', [cat, shutters, salon])
    expect(found.map((entry) => entry.content)).toEqual([salon.content])
  })

  test('matching ignores accents and case', () => {
    const found = relevantMemories('Il fait chaud dans le BUREAU', [cat, shutters, salon])
    expect(found.map((entry) => entry.content)).toEqual([shutters.content])
  })

  test('word forms meet on a common stem', () => {
    const found = relevantMemories('Les chats ont mangé ?', [salon, cat])
    expect(found.map((entry) => entry.content)).toEqual([cat.content])
  })

  test('a question made only of small words recalls nothing', () => {
    expect(relevantMemories('Est-ce que tu peux ?', [cat, shutters, salon])).toEqual([])
  })

  test('the context of an answer is its memories as cards, and they count as used', () => {
    const remembered = memories.remember({ kind: 'preference', content: 'Préfère 20 °C le soir dans le salon', source: 'stated' })
    memories.remember({ kind: 'fact', content: 'Le chat dort dans la chambre', source: 'observed' })

    const context = contextFor('Que sais-tu du salon le soir ?', [])

    expect(context).toHaveLength(1)
    const [card] = context
    expect(card?.id).toBe(remembered.id)
    expect(card?.kind).toBe('memory')
    expect(card?.title).toBe('Préférence')
    expect(card?.excerpt).toBe('Préfère 20 °C le soir dans le salon')
    expect(card?.meta).toBe('Dit par vous')
    expect(card?.href).toBe('/memory')
    expect(memories.all().find((entry) => entry.id === remembered.id)?.lastUsedAt).not.toBeNull()
  })

  test('what the assistant looked up in memory is part of the context too', () => {
    const recalled = memories.remember({ kind: 'habit', content: 'Arrose le jardin le mardi', source: 'observed' })
    const context = contextFor('Bonjour', [tool('recall', { query: 'jardin' })])
    expect(context.map((card) => card.id)).toEqual([recalled.id])
  })
})

describe('a saved answer carries both', () => {
  test('the model path saves its sources and its context', async () => {
    const remembered = memories.remember({ kind: 'preference', content: 'Préfère 20 °C le soir dans le salon', source: 'stated' })
    const provider = scripted([
      { toolCalls: [{ id: 'read', name: 'get_device', args: { device: 'Thermostat salon' } }] },
      { content: 'Il fait 19,5 °C, tu préfères 20 °C le soir.' },
    ])

    const result = await agentService.ask('Que sais-tu du salon le soir ?', { provider })
    const saved = messages.forConversation(result.conversationId).at(-1)!

    expect(saved.sources?.map((source) => source.id)).toEqual([fixture.devices.thermostat])
    expect(saved.context?.map((card) => card.id)).toEqual([remembered.id])
  })

  test('the offline path saves its sources', async () => {
    const result = await agentService.ask('allume le plafonnier salon')
    const saved = messages.forConversation(result.conversationId).at(-1)!
    expect(saved.sources?.map((source) => source.id)).toEqual([fixture.devices.lamp])
  })
})
