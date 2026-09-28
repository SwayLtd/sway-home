/**
 * What the composer adds to a question.
 *
 * `@` designates a thing of the house - a device, a room, a scene, a routine - and the
 * model is told exactly which one, by id, instead of guessing from a name. `/` opens the
 * shortcuts: start over, undo, scan, a scene or a routine by name, a house mode. The list is
 * built from the house, so a scene created a minute ago is already there.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { ChatRequest, ChatResponse, ModelProvider } from '#agent/providers'
import { agentService } from '#agent/agent_service'
import { mentionNote, parseMentions, slashCommands } from '#agent/composer'
import { houseService } from '#services/house'
import { messages, routines, settings } from '#repositories/store'
import { dropDatabase, freshDatabase, seedHouse, type TestHouse } from './helpers.ts'

let fixture: TestHouse

beforeEach(async () => {
  await freshDatabase()
  fixture = seedHouse()
  settings.set('agent', { autonomy: 'copilot', llm: { provider: 'none', model: '', temperature: 0.3, maxSteps: 8, dailyBudgetUsd: 2 } })
})

afterAll(dropDatabase)

describe('mentions', () => {
  test('name what was designated, with the ids the tools take', () => {
    const note = mentionNote([
      { kind: 'device', id: fixture.devices.lamp },
      { kind: 'area', id: fixture.areas.salon },
      { kind: 'device', id: 'missing' },
    ])

    expect(note).toBe(`Désignés par la personne : Plafonnier salon (appareil ${fixture.devices.lamp.slice(0, 8)}), Salon (pièce).`)
  })

  test('nothing designated, nothing added', () => {
    expect(mentionNote([])).toBeNull()
    expect(mentionNote([{ kind: 'scene', id: 'missing' }])).toBeNull()
  })

  test('arrive from a page and are checked before use', () => {
    expect(
      parseMentions([
        { kind: 'device', id: 'a' },
        { kind: 'weapon', id: 'b' },
        { kind: 'area' },
        'device:c',
        { kind: 'routine', id: 'x'.repeat(300) },
      ])
    ).toEqual([{ kind: 'device', id: 'a' }])
    expect(parseMentions('nope')).toEqual([])
    expect(parseMentions(Array.from({ length: 20 }, (_, index) => ({ kind: 'device', id: `d${index}` })))).toHaveLength(8)
  })

  test('the model is told who is designated; the transcript keeps what was typed', async () => {
    const requests: ChatRequest[] = []
    const provider: ModelProvider = {
      id: 'fake',
      label: 'Fake',
      local: true,
      needsKey: false,
      defaultModel: 'fake-1',
      pricing: { input: 0, output: 0 },
      async chat(request): Promise<ChatResponse> {
        requests.push(request)
        return { content: 'Oui.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, model: 'fake-1', finishReason: 'stop' }
      },
    }

    const result = await agentService.ask('Occupe-toi de @Plafonnier salon', { provider, mentions: [{ kind: 'device', id: fixture.devices.lamp }] })

    const sent = requests[0]!.messages.at(-1)!.content
    expect(sent).toContain('Occupe-toi de @Plafonnier salon')
    expect(sent).toContain(`Plafonnier salon (appareil ${fixture.devices.lamp.slice(0, 8)})`)
    expect(messages.forConversation(result.conversationId)[0]?.content).toBe('Occupe-toi de @Plafonnier salon')
  })
})

describe('slash commands', () => {
  test('the fixed shortcuts come first', () => {
    const ids = slashCommands().map((command) => command.id)
    expect(ids.slice(0, 5)).toEqual(['nouvelle', 'annuler', 'resume', 'tout-eteindre', 'scan'])
  })

  test('every scene and every active routine is a command, by name', () => {
    const scene = houseService.snapshotScene('Cinéma', { areaName: 'Salon' })
    const active = routines.create({ name: 'Réveil en douceur', status: 'active', enabled: true, mode: 'single', authoredBy: 'user', triggers: [], conditions: [], actions: [] } as never)
    routines.create({ name: 'Suggestion', status: 'suggested', enabled: true, mode: 'single', authoredBy: 'agent', triggers: [], conditions: [], actions: [] } as never)

    const commands = slashCommands()

    const sceneCommand = commands.find((command) => command.run.kind === 'scene')
    expect(sceneCommand?.label).toBe('Scène Cinéma')
    expect(sceneCommand?.run).toEqual({ kind: 'scene', id: scene })
    const routineCommands = commands.filter((command) => command.run.kind === 'routine')
    expect(routineCommands.map((command) => command.label)).toEqual(['Routine Réveil en douceur'])
    expect(routineCommands[0]?.run).toEqual({ kind: 'routine', id: active.id })
  })

  test('each house mode is a command that asks for it in words', () => {
    const night = slashCommands().find((command) => command.id === 'mode-night')
    expect(night?.label).toBe('Mode Nuit')
    expect(night?.run).toEqual({ kind: 'prompt', text: 'Passe en mode nuit' })
  })

  test('a command has an icon and a hint for the menu', () => {
    for (const command of slashCommands()) {
      expect(command.icon).toMatch(/^ph:[a-z0-9-]+$/)
      expect(command.hint.length).toBeGreaterThan(0)
    }
  })
})
