/**
 * Working on a selected passage.
 *
 * Select a sentence in an answer or a memory and a small bar offers to explain it, shorten
 * it, rephrase it, translate it, or do whatever is typed. With a model, one short call does
 * it. Without one, the two things that need no model still work - shortening, and explaining
 * the devices a passage names from what the hub knows about them - and the rest says plainly
 * that a model is needed.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ChatRequest, ChatResponse, ModelProvider } from '#agent/providers'
import { agentService } from '#agent/agent_service'
import { conversations, settings } from '#repositories/store'
import { insertInto, nowIso } from '#db/database'
import { dropDatabase, freshDatabase, seedHouse } from './helpers.ts'

beforeEach(async () => {
  await freshDatabase()
  seedHouse()
  settings.set('agent', { autonomy: 'copilot', llm: { provider: 'none', model: '', temperature: 0.3, maxSteps: 8, dailyBudgetUsd: 2 } })
})

afterAll(dropDatabase)

function model(answer: string, local = true): ModelProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    id: 'fake',
    label: 'Fake',
    local,
    needsKey: false,
    defaultModel: 'fake-1',
    pricing: { input: 1, output: 1 },
    requests,
    async chat(request): Promise<ChatResponse> {
      requests.push(request)
      return { content: answer, toolCalls: [], usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.0001 }, model: 'fake-1', finishReason: 'stop' }
    },
  }
}

describe('with a model', () => {
  test('one call with the instruction for the action and the passage as the question', async () => {
    const provider = model('  Le salon est à 19,5 °C.  ')

    const result = await agentService.rewrite('Il fait [[ph:thermometer-simple|19,5 °C]] dans le salon.', 'shorten', { provider })

    expect(result).toEqual({ ok: true, text: 'Le salon est à 19,5 °C.' })
    const [request] = provider.requests
    expect(request?.messages[0]?.role).toBe('system')
    expect(request?.messages[0]?.content).toContain('Raccourcis')
    expect(request?.messages.at(-1)?.content).toBe('Il fait 19,5 °C dans le salon.')
    expect(request?.tools).toBeUndefined()
  })

  test('a free instruction travels with the passage', async () => {
    const provider = model('Fait.')
    await agentService.rewrite('Éteins le salon à 23 h.', 'custom', { provider, prompt: 'Mets-le au futur' })
    expect(provider.requests[0]?.messages.at(-1)?.content).toBe('Consigne : Mets-le au futur\n\nPassage : Éteins le salon à 23 h.')
  })

  test('a long passage is cut before it is sent', async () => {
    const provider = model('Court.')
    await agentService.rewrite('a'.repeat(5000), 'explain', { provider })
    expect(provider.requests[0]?.messages.at(-1)?.content.length).toBe(2000)
  })

  test('a spent budget stops a hosted model', async () => {
    insertInto('agent_runs', {
      id: 'spent', conversation_id: conversations.create(), goal: 'x', trigger: 'chat', steps: 1, input_tokens: 0, output_tokens: 0,
      cost_usd: 5, latency_ms: 1, provider: 'fake', model: 'fake-1', status: 'ok', error: null, created_at: nowIso(),
    })
    const provider = model('Non.', false)

    const result = await agentService.rewrite('Bonjour.', 'rephrase', { provider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Budget quotidien atteint')
    expect(provider.requests).toHaveLength(0)
  })
})

describe('without a model', () => {
  test('shortening keeps the first sentence', async () => {
    const result = await agentService.rewrite('Le salon est chaud. La chambre est froide. Le bureau est tiède.', 'shorten')
    expect(result).toEqual({ ok: true, text: 'Le salon est chaud.' })
  })

  test('a single long sentence is cut at a word', async () => {
    const result = await agentService.rewrite(`${'mot '.repeat(60)}fin`, 'shorten')
    expect(result.ok).toBe(true)
    expect(result.text!.length).toBeLessThanOrEqual(123)
    expect(result.text!.endsWith('...')).toBe(true)
  })

  test('explaining names the devices from what the hub knows', async () => {
    const result = await agentService.rewrite('Le Plafonnier salon est resté allumé.', 'explain')
    expect(result.ok).toBe(true)
    expect(result.text).toBe('Plafonnier salon (Salon) : lumière éteinte en ce moment.')
  })

  test('what needs a model says so', async () => {
    for (const action of ['rephrase', 'translate', 'custom'] as const) {
      const result = await agentService.rewrite('Bonjour.', action)
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Il faut un modèle pour cela : branchez-en un dans Réglages > Assistant.')
    }
    const nothing = await agentService.rewrite('Il fait beau.', 'explain')
    expect(nothing.ok).toBe(false)
  })
})
