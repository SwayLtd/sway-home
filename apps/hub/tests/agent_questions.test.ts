/**
 * Asking back instead of guessing.
 *
 * "Allume la lampe" in a house with three lamps has no right answer, and guessing one is how
 * an assistant switches on the bedroom at midnight. The run ends on a question with the
 * possible answers as options; the answer comes back as the next message of the same
 * conversation, which is the checkpoint - LangGraph's interrupt-and-resume, without a graph.
 *
 * Two paths ask: the model, through the `ask_user` tool, and the offline parser, when a
 * command names a kind of device the house has several of. The parser's question carries the
 * command it was about to run, so the answer runs it with no model at all.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentToolContext } from '@sway-home/shared'
import type { ChatRequest, ChatResponse, ModelProvider } from '#agent/providers'
import { agentService, parseAnswers, type AgentStep } from '#agent/agent_service'
import { toolByName } from '#agent/tools'
import { parseIntent } from '#agent/intent_parser'
import { adapters } from '#services/adapter_manager'
import { messages, settings } from '#repositories/store'
import { dropDatabase, freshDatabase, makeDevice, seedHouse, type TestHouse } from './helpers.ts'
import { FakeAdapter } from './fake_adapter.ts'

const adapter = new FakeAdapter()
let fixture: TestHouse

function scripted(turns: Partial<ChatResponse>[]): ModelProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  let index = 0
  return {
    id: 'fake',
    label: 'Fake',
    local: true,
    needsKey: false,
    defaultModel: 'fake-1',
    pricing: { input: 0, output: 0 },
    requests,
    async chat(request) {
      requests.push(request)
      const turn = turns[index++] ?? { content: 'Fin.' }
      return { content: turn.content ?? '', toolCalls: turn.toolCalls ?? [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, model: 'fake-1', finishReason: 'stop' }
    },
  }
}

function context(unattended = false): AgentToolContext {
  return { conversationId: 'c', correlationId: 'r', autonomy: 'copilot', unattended, userId: null, signal: new AbortController().signal }
}

function lastMessage(conversationId: string) {
  return messages.forConversation(conversationId).at(-1)!
}

beforeEach(async () => {
  await freshDatabase()
  adapter.reset()
  fixture = seedHouse()
  adapters.register(adapter)
  await adapters.start('test')
  adapter.setState('lamp', { on: false })
  settings.set('agent', { autonomy: 'copilot', llm: { provider: 'none', model: '', temperature: 0.3, maxSteps: 8, dailyBudgetUsd: 2 } })
})

afterAll(dropDatabase)

function secondLamp(): string {
  const id = makeDevice({
    nativeId: 'lamp2',
    name: 'Lampe chambre',
    category: 'light',
    capabilities: ['onoff', 'brightness'],
    state: { on: false, brightness: 40 },
    areaId: fixture.areas.chambre,
  })
  adapter.setState('lamp2', { on: false })
  return id
}

describe('the ask_user tool', () => {
  test('turns a question into ids the interface can answer with', async () => {
    const tool = toolByName('ask_user')!
    const args = tool.parameters.parse({
      questions: [{ title: 'Quelle lampe ?', options: [{ label: 'Plafonnier salon' }, { label: 'Lampe chambre', hint: 'Chambre' }] }],
    })

    const result = await tool.execute(args, context())

    expect(result.ok).toBe(true)
    expect(result.questions).toHaveLength(1)
    const [question] = result.questions!
    expect(question?.id).toBe('quelle-lampe')
    expect(question?.multiple).toBe(false)
    expect(question?.options.map((option) => option.id)).toEqual(['plafonnier-salon', 'lampe-chambre'])
    expect(question?.options[1]?.hint).toBe('Chambre')
  })

  test('needs at least two options, and nobody to ask means no question', async () => {
    const tool = toolByName('ask_user')!
    expect(tool.parameters.safeParse({ questions: [{ title: 'Sûr ?', options: [{ label: 'Oui' }] }] }).success).toBe(false)

    const args = tool.parameters.parse({ questions: [{ title: 'Quelle lampe ?', options: [{ label: 'A' }, { label: 'B' }] }] })
    const result = await tool.execute(args, context(true))
    expect(result.ok).toBe(false)
    expect(result.questions).toBeUndefined()
  })

  test('a model that asks ends its run on the question', async () => {
    const provider = scripted([
      {
        content: 'Laquelle ?',
        toolCalls: [{ id: 'q', name: 'ask_user', args: { questions: [{ title: 'Quelle lampe ?', options: [{ label: 'Plafonnier salon' }, { label: 'Lampe chambre' }] }] } }],
      },
      { content: 'Ne devrait pas être appelé.' },
    ])
    const steps: AgentStep[] = []

    const result = await agentService.ask('Occupe-toi de la lampe du fond', { provider, onStep: (step) => steps.push(step) })
    const saved = lastMessage(result.conversationId)

    expect(provider.requests).toHaveLength(1)
    expect(saved.content).toBe('Laquelle ?')
    expect(saved.questions?.map((question) => question.title)).toEqual(['Quelle lampe ?'])
    const answered = steps.find((step) => step.kind === 'tool_result')
    expect(answered?.kind === 'tool_result' && answered.ok).toBe(true)
  })

  test('the answer to a model question goes back to the model as text', async () => {
    const provider = scripted([
      { toolCalls: [{ id: 'q', name: 'ask_user', args: { questions: [{ title: 'Quelle lampe ?', options: [{ label: 'Plafonnier salon' }, { label: 'Lampe chambre' }] }] } }] },
      { content: 'Allumée.' },
    ])

    const first = await agentService.ask('Occupe-toi de la lampe du fond', { provider })
    await agentService.ask('Lampe chambre', { provider, conversationId: first.conversationId, answers: { 'quelle-lampe': ['lampe-chambre'] } })

    const sent = provider.requests[1]!.messages.map((message) => message.content)
    expect(sent.at(-1)).toBe('Lampe chambre')
    expect(sent).toContain('Quelle lampe ?')
  })
})

describe('the offline parser asks when a command is ambiguous', () => {
  test('a kind of device the house has several of becomes a question, and nothing moves', async () => {
    const other = secondLamp()

    const result = await agentService.ask('allume la lampe')
    const saved = lastMessage(result.conversationId)

    expect(adapter.commandsFor('lamp')).toHaveLength(0)
    expect(adapter.commandsFor('lamp2')).toHaveLength(0)
    expect(saved.content).toBe('Quelle lampe ?')
    const [question] = saved.questions ?? []
    expect(question?.title).toBe('Quelle lampe ?')
    expect(question?.multiple).toBe(false)
    expect(question?.options.map((option) => option.id)).toEqual([other, fixture.devices.lamp, '*'])
    expect(question?.options.map((option) => option.label)).toEqual(['Lampe chambre', 'Plafonnier salon', 'Toutes les lampes'])
    expect(question?.options.map((option) => option.hint ?? null)).toEqual(['Chambre', 'Salon', null])
  })

  test('with a single candidate there is nothing to ask', async () => {
    await agentService.ask('allume la lampe')
    expect(adapter.stateOf('lamp').on).toBe(true)
  })

  test('the answer runs the command that was waiting, on the device chosen', async () => {
    const other = secondLamp()
    const asked = await agentService.ask('allume la lampe')

    const answered = await agentService.ask('Lampe chambre', { conversationId: asked.conversationId, answers: { [lastMessage(asked.conversationId).questions![0]!.id]: [other] } })
    const saved = lastMessage(answered.conversationId)

    expect(adapter.stateOf('lamp2').on).toBe(true)
    expect(adapter.stateOf('lamp').on).toBe(false)
    expect(saved.content).toBe('Lampe chambre : allumé.')
    expect(saved.trace?.map((entry) => entry.kind === 'tool' && entry.name)).toEqual(['control_device'])
    expect(saved.actions?.undoIds).toHaveLength(1)
  })

  test('"all of them" runs the command on every candidate', async () => {
    secondLamp()
    const asked = await agentService.ask('allume la lampe')

    await agentService.ask('Toutes les lampes', { conversationId: asked.conversationId, answers: { [lastMessage(asked.conversationId).questions![0]!.id]: ['*'] } })

    expect(adapter.stateOf('lamp').on).toBe(true)
    expect(adapter.stateOf('lamp2').on).toBe(true)
  })

  test('an answer that is not one of the options runs nothing', async () => {
    secondLamp()
    const asked = await agentService.ask('allume la lampe')

    await agentService.ask('La cuisine', { conversationId: asked.conversationId, answers: { [lastMessage(asked.conversationId).questions![0]!.id]: ['not-a-device'] } })

    expect(adapter.commandsFor('lamp')).toHaveLength(0)
    expect(adapter.commandsFor('lamp2')).toHaveLength(0)
  })

  test('a question is answered once: asking again later is a new request', async () => {
    const other = secondLamp()
    const asked = await agentService.ask('allume la lampe')
    const questionId = lastMessage(asked.conversationId).questions![0]!.id

    await agentService.ask('Lampe chambre', { conversationId: asked.conversationId, answers: { [questionId]: [other] } })
    adapter.setState('lamp2', { on: false })
    const before = adapter.commandsFor('lamp2').length
    await agentService.ask('Lampe chambre', { conversationId: asked.conversationId, answers: { [questionId]: [other] } })

    expect(adapter.commandsFor('lamp2').length).toBe(before)
  })
})

describe('a question about a state is not a command', () => {
  const ACTING = ['control_device', 'control_many', 'ask_user']

  test('"le plafonnier est allumé ?" switches nothing on', () => {
    expect(ACTING).not.toContain(parseIntent('Le plafonnier est allumé ?')?.tool)
    expect(ACTING).not.toContain(parseIntent('Est-ce que le salon est encore allumé ?')?.tool)
    expect(ACTING).not.toContain(parseIntent('Les prises sont éteintes ?')?.tool)
  })

  test('a polite request with a question mark is still a command', () => {
    const intent = parseIntent('Peux-tu allumer la lampe ?')
    expect(intent?.tool).toBe('control_device')
    expect(intent?.args.device).toBe(fixture.devices.lamp)
  })
})

describe('answers as they arrive over HTTP', () => {
  test('keep string answers per question, as lists', () => {
    expect(parseAnswers({ device: 'abc', days: ['lun', 'mar'] })).toEqual({ device: ['abc'], days: ['lun', 'mar'] })
  })

  test('drop anything that is not a string answer', () => {
    expect(parseAnswers({ device: 42, other: [1, 'ok', null], nested: { a: 1 } })).toEqual({ other: ['ok'] })
    expect(parseAnswers('device=abc')).toBeUndefined()
    expect(parseAnswers(null)).toBeUndefined()
    expect(parseAnswers({})).toBeUndefined()
  })

  test('bound what a client can send', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`q${index}`, 'x'.repeat(500)]))
    const parsed = parseAnswers(many)!
    expect(Object.keys(parsed)).toHaveLength(8)
    expect(parsed.q0?.[0]?.length).toBe(200)
  })
})
