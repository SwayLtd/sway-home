/**
 * Choosing the model for one question.
 *
 * The composer has a model picker: the offline engine, the models of a runner on this
 * machine, the hosted ones with a key. The list says which can be used and why the others
 * cannot, and a question asked with a model runs on that model - or says plainly that it is
 * not available, rather than quietly answering with another one.
 *
 * Never a network call here: `fetch` is replaced by a trap for the whole file.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { agentService } from '#agent/agent_service'
import { modelChoices, providerForChoice } from '#agent/model_choice'
import { secrets } from '#services/secrets'
import { messages, settings } from '#repositories/store'
import { dropDatabase, freshDatabase, seedHouse } from './helpers.ts'

const realFetch = globalThis.fetch
let fetched: string[] = []

beforeEach(async () => {
  await freshDatabase()
  seedHouse()
  fetched = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetched.push(String(url))
    throw new Error('no network in tests')
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(dropDatabase)

const RUNNERS_DOWN = [{ id: 'ollama', up: false, models: [] }]

describe('the list of models', () => {
  test('the offline engine is always there, first', () => {
    const [first] = modelChoices({ configured: null, localOnly: false, keys: {}, runners: RUNNERS_DOWN })
    expect(first?.id).toBe('offline')
    expect(first?.label).toBe('Moteur local')
    expect(first?.available).toBe(true)
  })

  test('a hosted model needs its key, and says so', () => {
    const choices = modelChoices({ configured: null, localOnly: false, keys: { openai: true }, runners: RUNNERS_DOWN })

    const luna = choices.find((choice) => choice.id === 'openai:gpt-6-luna')
    const sonnet = choices.find((choice) => choice.id === 'anthropic:claude-sonnet-5')
    expect(luna?.available).toBe(true)
    expect(luna?.group).toBe('En ligne')
    expect(sonnet?.available).toBe(false)
    expect(sonnet?.reason).toBe('Clé API manquante')
  })

  test('a local runner offers what it has pulled, when it answers', () => {
    const up = modelChoices({ configured: null, localOnly: false, keys: {}, runners: [{ id: 'ollama', up: true, models: ['qwen3:8b', 'phi4'] }] })
    const down = modelChoices({ configured: null, localOnly: false, keys: {}, runners: RUNNERS_DOWN })

    expect(up.filter((choice) => choice.provider === 'ollama' && choice.available).map((choice) => choice.model)).toEqual(['qwen3:8b', 'phi4'])
    expect(up.find((choice) => choice.id === 'ollama:phi4')?.group).toBe('Sur cette machine')
    expect(down.find((choice) => choice.id === 'ollama:qwen3:8b')?.reason).toBe('Ollama ne répond pas')
  })

  test('privacy mode closes every hosted model', () => {
    const choices = modelChoices({ configured: null, localOnly: true, keys: { openai: true }, runners: RUNNERS_DOWN })
    expect(choices.find((choice) => choice.id === 'openai:gpt-6-luna')?.reason).toBe('Mode local seulement')
  })

  test('the configured model is listed even when the catalogue does not know it', () => {
    const choices = modelChoices({ configured: { provider: 'openai', model: 'gpt-7-preview' }, localOnly: false, keys: { openai: true }, runners: RUNNERS_DOWN })
    const configured = choices.find((choice) => choice.id === 'openai:gpt-7-preview')
    expect(configured?.available).toBe(true)
    expect(configured?.current).toBe(true)
    expect(choices.filter((choice) => choice.current)).toHaveLength(1)
  })

  test('with no model configured, the offline engine is the current one', () => {
    const choices = modelChoices({ configured: null, localOnly: false, keys: {}, runners: RUNNERS_DOWN })
    expect(choices.find((choice) => choice.current)?.id).toBe('offline')
  })
})

describe('a model chosen for one question', () => {
  test('resolves to that provider and model', () => {
    secrets.set('openai', { apiKey: 'sk-test' })
    const chosen = providerForChoice('openai:gpt-6-sol')
    expect(chosen.error).toBeUndefined()
    expect(chosen.provider?.id).toBe('openai')
    expect(chosen.provider?.defaultModel).toBe('gpt-6-sol')
  })

  test('the offline engine is no provider at all', () => {
    expect(providerForChoice('offline')).toEqual({ provider: null })
  })

  test('an unusable choice is an error, never a different model', () => {
    expect(providerForChoice('anthropic:claude-sonnet-5').error).toBe('Clé API manquante')
    expect(providerForChoice('nope').error).toBe('Modèle inconnu')
    expect(providerForChoice('madeup:model').error).toBe('Modèle inconnu')
    settings.set('agent', { privacy: { localOnly: true } })
    secrets.set('openai', { apiKey: 'sk-test' })
    expect(providerForChoice('openai:gpt-6-luna').error).toBe('Mode local seulement')
  })

  test('asked offline, the configured model is never called', async () => {
    secrets.set('openai', { apiKey: 'sk-test' })
    settings.set('agent', { llm: { provider: 'openai', model: 'gpt-6-luna', temperature: 0.3, maxSteps: 8, dailyBudgetUsd: 2 } })

    const result = await agentService.ask('Raconte-moi une histoire', { model: 'offline' })

    expect(fetched).toEqual([])
    expect(result.reply).toContain('moteur local')
  })

  test('asked with a model that cannot run, the answer says so and nothing is called', async () => {
    const result = await agentService.ask('Bonjour', { model: 'anthropic:claude-sonnet-5' })
    const saved = messages.forConversation(result.conversationId).at(-1)!

    expect(fetched).toEqual([])
    expect(result.ok).toBe(false)
    expect(result.error).toBe('model_unavailable')
    expect(saved.content).toContain("claude-sonnet-5 n'est pas disponible")
    expect(saved.content).toContain('Clé API manquante')
  })
})
