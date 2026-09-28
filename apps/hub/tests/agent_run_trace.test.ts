/**
 * What a run leaves behind.
 *
 * The console shows an answer with the trace of how it was reached: the tools called, what
 * each returned, how long it took, what can be undone. That trace used to exist only while
 * the stream was open - a reload kept the sentence and lost everything that made it
 * trustworthy. These tests pin the contract the interface is built on: every tool step is
 * paired by the provider's call id, closes with a result even when the tool does not exist,
 * and the saved answer carries its trace, its undo handles and its proposals.
 *
 * The model is a scripted fake injected through `AgentRunOptions.provider`, so the real loop
 * runs - permission checks, tools, persistence - with no network.
 *
 * Plain values are asserted before any asymmetric matcher: Bun's `toMatchObject` rewrites
 * the received object when the expected side holds matchers (oven-sh/bun#3521).
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { AutonomyLevel } from '@sway-home/shared'
import type { ChatRequest, ChatResponse, ModelProvider } from '#agent/providers'
import { agentService, type AgentStep } from '#agent/agent_service'
import { adapters } from '#services/adapter_manager'
import { houseService } from '#services/house'
import { conversations, messages, settings } from '#repositories/store'
import { database, insertInto, nowIso } from '#db/database'
import { dropDatabase, freshDatabase, seedHouse, type TestHouse } from './helpers.ts'
import { FakeAdapter } from './fake_adapter.ts'

const adapter = new FakeAdapter()
let fixture: TestHouse

type Turn = Partial<ChatResponse> | ((request: ChatRequest) => Promise<Partial<ChatResponse>> | Partial<ChatResponse>)

/** A model that answers from a script, one entry per turn, and remembers what it was sent. */
function scripted(turns: Turn[], overrides: Partial<ModelProvider> = {}): ModelProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  let index = 0
  return {
    id: 'fake',
    label: 'Fake',
    local: false,
    needsKey: false,
    defaultModel: 'fake-1',
    pricing: { input: 1, output: 1 },
    requests,
    async chat(request) {
      requests.push(request)
      const turn = turns[index++] ?? { content: 'Fin.' }
      const partial = typeof turn === 'function' ? await turn(request) : turn
      return {
        content: partial.content ?? '',
        toolCalls: partial.toolCalls ?? [],
        usage: partial.usage ?? { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 },
        model: partial.model ?? 'fake-1',
        finishReason: partial.finishReason ?? 'stop',
      }
    },
    ...overrides,
  }
}

function useAutonomy(level: AutonomyLevel): void {
  settings.set('agent', { autonomy: level, llm: { provider: 'none', model: '', temperature: 0.3, maxSteps: 8, dailyBudgetUsd: 2 } })
}

async function run(input: string, provider: ModelProvider | undefined, extra: { signal?: AbortSignal } = {}) {
  const steps: AgentStep[] = []
  const result = await agentService.ask(input, { provider, onStep: (step) => steps.push(step), ...extra })
  const saved = messages.forConversation(result.conversationId).at(-1)!
  return { steps, result, saved }
}

beforeEach(async () => {
  await freshDatabase()
  adapter.reset()
  fixture = seedHouse()
  adapters.register(adapter)
  await adapters.start('test')
  adapter.setState('lamp', { on: false })
  adapter.setState('lock', { locked: true })
  useAutonomy('copilot')
})

afterAll(dropDatabase)

describe('a model run keeps its trace', () => {
  test('a tool step carries the provider call id and a duration, and the answer is not echoed as thinking', async () => {
    const provider = scripted([
      { toolCalls: [{ id: 'call_1', name: 'get_device', args: { device: 'Plafonnier salon' } }] },
      { content: 'Le plafonnier est éteint.' },
    ])

    const { steps, saved } = await run('Le plafonnier est allumé ?', provider)

    const call = steps.find((step) => step.kind === 'tool_call')
    const result = steps.find((step) => step.kind === 'tool_result')
    expect(call?.kind === 'tool_call' && call.id).toBe('call_1')
    expect(result?.kind === 'tool_result' && result.id).toBe('call_1')
    expect(result?.kind === 'tool_result' && result.ok).toBe(true)
    expect(result?.kind === 'tool_result' && typeof result.durationMs).toBe('number')
    expect(steps.filter((step) => step.kind === 'thinking')).toHaveLength(0)

    expect(saved.role).toBe('assistant')
    expect(saved.content).toBe('Le plafonnier est éteint.')
    expect(saved.trace).toHaveLength(1)
    const entry = saved.trace![0]!
    expect(entry.kind).toBe('tool')
    if (entry.kind !== 'tool') return
    expect(entry.id).toBe('call_1')
    expect(entry.name).toBe('get_device')
    expect(entry.args).toEqual({ device: 'Plafonnier salon' })
    expect(entry.ok).toBe(true)
    expect(entry.summary).toContain('Plafonnier salon')
    expect(entry.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('the saved answer lists its tool calls, so follow-ups know what was asked', async () => {
    const provider = scripted([
      { toolCalls: [{ id: 'call_1', name: 'get_device', args: { device: 'Plafonnier salon' } }] },
      { content: 'Éteint.' },
    ])

    const { saved } = await run('Et le plafonnier ?', provider)

    expect(saved.toolCalls).toEqual([{ id: 'call_1', name: 'get_device', args: { device: 'Plafonnier salon' } }])
    expect(saved.model).toEqual({ provider: 'fake', model: 'fake-1' })
  })

  test('text written alongside tool calls is the reasoning, and it is kept in order', async () => {
    const provider = scripted([
      { content: 'Je regarde le salon.', toolCalls: [{ id: 'call_1', name: 'get_device', args: { device: 'Thermostat salon' } }] },
      { content: 'Il fait 19,5 °C.' },
    ])

    const { steps, saved } = await run("Dis-moi quelque chose d'utile sur le salon", provider)

    const thinking = steps.filter((step) => step.kind === 'thinking')
    expect(thinking).toHaveLength(1)
    expect(thinking[0]?.kind === 'thinking' && thinking[0].text).toBe('Je regarde le salon.')
    expect(saved.trace?.map((entry) => entry.kind)).toEqual(['reasoning', 'tool'])
    const reasoning = saved.trace![0]!
    expect(reasoning.kind === 'reasoning' && reasoning.text).toBe('Je regarde le salon.')
  })

  test('an unknown tool and invalid arguments still close their step, as failures', async () => {
    const provider = scripted([
      {
        toolCalls: [
          { id: 'a', name: 'teleport', args: {} },
          { id: 'b', name: 'get_device', args: {} },
        ],
      },
      { content: 'Je ne peux pas.' },
    ])

    const { steps, saved } = await run('Téléporte-moi', provider)

    const results = steps.filter((step) => step.kind === 'tool_result')
    expect(results.map((step) => step.kind === 'tool_result' && step.id)).toEqual(['a', 'b'])
    expect(results.map((step) => step.kind === 'tool_result' && step.ok)).toEqual([false, false])
    const [unknown, invalid] = results
    expect(unknown?.kind === 'tool_result' && unknown.summary).toContain('Outil inconnu')
    expect(invalid?.kind === 'tool_result' && invalid.summary).toContain('Arguments invalides')
    expect(saved.trace?.filter((entry) => entry.kind === 'tool').map((entry) => entry.kind === 'tool' && entry.ok)).toEqual([false, false])
  })

  test('what the assistant did can be undone from its answer', async () => {
    const provider = scripted([
      { toolCalls: [{ id: 'on', name: 'control_device', args: { device: 'Plafonnier salon', command: 'turnOn' } }] },
      { content: 'Allumé.' },
    ])

    const { saved } = await run('Occupe-toi du plafonnier', provider)

    expect(adapter.stateOf('lamp').on).toBe(true)
    expect(saved.actions?.undoIds).toHaveLength(1)
    const undone = await houseService.undo(saved.actions!.undoIds[0]!)
    expect(undone.ok).toBe(true)
    expect(adapter.stateOf('lamp').on).toBe(false)
  })

  test('a proposal made during the run is attached to the answer', async () => {
    useAutonomy('assistant')
    const provider = scripted([
      { toolCalls: [{ id: 'open', name: 'control_device', args: { device: 'Serrure entrée', command: 'unlock' } }] },
      { content: 'Je te propose de déverrouiller.' },
    ])

    const { result, saved } = await run('Ouvre la porte', provider)

    expect(result.proposalIds).toHaveLength(1)
    expect(saved.actions?.proposalIds).toEqual(result.proposalIds)
    expect(adapter.stateOf('lock').locked).toBe(true)
  })

  test('a spent budget still answers in the conversation', async () => {
    insertInto('agent_runs', {
      id: 'spent',
      conversation_id: conversations.create(),
      goal: 'x',
      trigger: 'chat',
      steps: 1,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 5,
      latency_ms: 1,
      provider: 'fake',
      model: 'fake-1',
      status: 'ok',
      error: null,
      created_at: nowIso(),
    })

    const { steps, result } = await run('Bonjour', scripted([]))

    expect(result.error).toBe('budget_exceeded')
    const said = steps.filter((step) => step.kind === 'message' && step.message.role === 'assistant')
    expect(said).toHaveLength(1)
    expect(said[0]?.kind === 'message' && said[0].message.content).toContain('Budget quotidien atteint')
  })

  test('the provider chosen for the run is the one that answers', async () => {
    const provider = scripted([{ content: 'Bonjour.' }])
    const { result } = await run('Salut', provider)
    expect(result.reply).toBe('Bonjour.')
    expect(provider.requests).toHaveLength(1)
  })
})

describe('an interrupted run', () => {
  test('stops, keeps what it did, says so, and passes the signal to the model', async () => {
    const controller = new AbortController()
    const provider = scripted([
      { toolCalls: [{ id: 'read', name: 'get_device', args: { device: 'Plafonnier salon' } }] },
      () => {
        controller.abort()
        throw new DOMException('The operation was aborted.', 'AbortError')
      },
    ])

    const { steps, result, saved } = await run('Regarde le salon', provider, { signal: controller.signal })

    expect(provider.requests[0]?.signal).toBe(controller.signal)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('aborted')
    expect(steps.filter((step) => step.kind === 'error')).toHaveLength(0)
    expect(saved.interrupted).toBe(true)
    expect(saved.trace?.map((entry) => entry.kind === 'tool' && entry.ok)).toEqual([true])
  })

  test('does not run a tool the model asked for after the person left', async () => {
    const controller = new AbortController()
    const provider = scripted([
      () => {
        controller.abort()
        return { toolCalls: [{ id: 'late', name: 'control_device', args: { device: 'Plafonnier salon', command: 'turnOn' } }] }
      },
    ])

    const { result, saved } = await run('Occupe-toi du plafonnier', provider, { signal: controller.signal })

    expect(result.error).toBe('aborted')
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
    const entry = saved.trace?.[0]
    expect(entry?.kind === 'tool' && entry.id).toBe('late')
    expect(entry?.kind === 'tool' && entry.ok).toBe(null)
  })
})

describe('the conversation history', () => {
  function seedConversation(count: number): string {
    const id = conversations.create()
    const start = Date.parse('2026-09-01T08:00:00.000Z')
    for (let index = 0; index < count; index += 1) {
      messages.append({
        conversationId: id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `m${index}`,
        attachments: [],
        toolCalls: [],
        toolCallId: null,
        usage: null,
        createdAt: new Date(start + index * 60_000).toISOString(),
      })
    }
    return id
  }

  test('a limited read returns the newest messages, oldest first', () => {
    const id = seedConversation(5)
    expect(messages.forConversation(id, 3).map((message) => message.content)).toEqual(['m2', 'm3', 'm4'])
  })

  test('the model is sent the latest exchanges, not the first ones', async () => {
    const id = seedConversation(40)
    const provider = scripted([{ content: 'Oui.' }])

    await agentService.ask('Et maintenant ?', { provider, conversationId: id })

    const sent = provider.requests[0]!.messages.map((message) => message.content)
    expect(sent).toContain('m39')
    expect(sent).not.toContain('m0')
    expect(sent.at(-1)).toBe('Et maintenant ?')
  })
})

describe('the offline path keeps its trace too', () => {
  test('an intent run records its tool with an id and a duration, and can be undone', async () => {
    const { steps, saved } = await run('allume le plafonnier salon', undefined)

    const call = steps.find((step) => step.kind === 'tool_call')
    const result = steps.find((step) => step.kind === 'tool_result')
    expect(call?.kind === 'tool_call' && call.name).toBe('control_device')
    expect(call?.kind === 'tool_call' && typeof call.id).toBe('string')
    expect(result?.kind === 'tool_result' && result.id).toBe(call?.kind === 'tool_call' ? call.id : 'missing')
    expect(result?.kind === 'tool_result' && typeof result.durationMs).toBe('number')

    expect(saved.trace?.map((entry) => entry.kind === 'tool' && entry.name)).toEqual(['control_device'])
    expect(saved.actions?.undoIds).toHaveLength(1)
    expect(adapter.stateOf('lamp').on).toBe(true)
  })

  test('the undo handles of a run are the entries its commands pushed, nothing older', async () => {
    await houseService.execute(fixture.devices.plug, 'turnOff', {}, { origin: 'user' })

    const { saved } = await run('allume le plafonnier salon', undefined)

    const entries = database().all<{ id: string }>('SELECT id FROM undo_entries')
    expect(entries).toHaveLength(2)
    expect(saved.actions?.undoIds).toHaveLength(1)
  })
})
