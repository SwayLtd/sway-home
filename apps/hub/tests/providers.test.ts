/**
 * The request body each provider sends.
 *
 * Every rule below was established against the live OpenAI API on 2026-09-26, not assumed:
 *
 *  - every current OpenAI model answers `max_tokens` with a 400 and wants
 *    `max_completion_tokens` instead;
 *  - gpt-6-luna refuses any temperature other than the default;
 *  - gpt-6-luna refuses function tools on Chat Completions unless `reasoning_effort` is
 *    `none` ("To use function tools, use /v1/responses or set reasoning_effort to 'none'").
 *
 * The house agent always sends tools, so the last rule decides whether the assistant works
 * at all. The other OpenAI-compatible vendors (DeepSeek, Mistral, Groq, local runners) still
 * speak the older dialect and must keep receiving it.
 */

import { describe, expect, test } from 'bun:test'
import { buildChatBody } from '#agent/providers'

const TOOLS = [{ name: 'turn_on', description: 'Turn a light on', parameters: { type: 'object', properties: {} } }]

function body(provider: string, model: string, extra: { tools?: boolean; maxTokens?: number; temperature?: number } = {}) {
  return buildChatBody(
    { id: provider, defaultModel: model },
    {
      messages: [{ role: 'user', content: 'Allume le salon' }],
      tools: extra.tools === false ? undefined : TOOLS,
      maxTokens: extra.maxTokens,
      temperature: extra.temperature,
    } as never
  )
}

describe('OpenAI', () => {
  test('asks for max_completion_tokens, never max_tokens', () => {
    const request = body('openai', 'gpt-6-luna', { maxTokens: 800 })
    expect(request.max_completion_tokens).toBe(800)
    expect(request.max_tokens).toBeUndefined()
  })

  test('sends no temperature to a reasoning model', () => {
    for (const model of ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.4-mini', 'gpt-5-mini', 'o4-mini']) {
      expect(body('openai', model, { temperature: 0.3 }).temperature).toBeUndefined()
    }
  })

  test('turns reasoning off whenever tools are sent, or gpt-6 refuses them', () => {
    expect(body('openai', 'gpt-6-luna').reasoning_effort).toBe('none')
    expect(body('openai', 'gpt-5.4-mini').reasoning_effort).toBe('none')
  })

  test('without tools, keeps a little reasoning rather than none', () => {
    expect(body('openai', 'gpt-6-luna', { tools: false }).reasoning_effort).toBe('low')
  })

  test('an older non-reasoning model keeps its temperature', () => {
    expect(body('openai', 'gpt-4.1-mini', { temperature: 0.3 }).temperature).toBe(0.3)
    expect(body('openai', 'gpt-4.1-mini').reasoning_effort).toBeUndefined()
  })

  test('tools are declared as functions with automatic choice', () => {
    const request = body('openai', 'gpt-6-luna')
    expect(request.tool_choice).toBe('auto')
    expect((request.tools as { type: string }[])[0]?.type).toBe('function')
  })
})

describe('the other OpenAI-compatible vendors keep the classic dialect', () => {
  test('max_tokens and temperature, as before', () => {
    for (const provider of ['deepseek', 'mistral', 'groq', 'ollama', 'lmstudio', 'openrouter']) {
      const request = body(provider, 'some-model', { maxTokens: 500, temperature: 0.3 })
      expect(request.max_tokens).toBe(500)
      expect(request.temperature).toBe(0.3)
      expect(request.max_completion_tokens).toBeUndefined()
      expect(request.reasoning_effort).toBeUndefined()
    }
  })

  test('the default temperature is still applied when none is given', () => {
    expect(body('mistral', 'mistral-small-latest').temperature).toBe(0.3)
  })
})
