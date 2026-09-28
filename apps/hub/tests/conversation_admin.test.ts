/**
 * The conversation list, as the sidebar uses it.
 *
 * The sidebar shows the history of conversations with a search field, and each one can be
 * renamed, pinned or archived. An answer can also be rated, thumbs up or down, and the rating
 * stays with it. The columns existed from the start; nothing could change them.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { agentService } from '#agent/agent_service'
import { conversations, messages } from '#repositories/store'
import { dropDatabase, freshDatabase } from './helpers.ts'

beforeEach(freshDatabase)
afterAll(dropDatabase)

function say(conversationId: string, role: 'user' | 'assistant', content: string) {
  return messages.append({ conversationId, role, content, attachments: [], toolCalls: [], toolCallId: null, usage: null })
}

describe('a conversation can be renamed, pinned and archived', () => {
  test('a pinned conversation comes first, under its new name', () => {
    const first = conversations.create('Lumières')
    const second = conversations.create('Chauffage')
    conversations.update(first, { title: 'Éclairage du salon', pinned: true })

    const list = conversations.all(10)

    expect(list[0]?.id).toBe(first)
    expect(list[0]?.title).toBe('Éclairage du salon')
    expect(list[0]?.pinned).toBe(true)
    expect(list.map((entry) => entry.id)).toContain(second)
  })

  test('an archived conversation leaves the list, and can be listed on its own', () => {
    const kept = conversations.create('Garder')
    const archived = conversations.create('Archiver')
    conversations.update(archived, { archived: true })

    expect(conversations.all(10).map((entry) => entry.id)).toEqual([kept])
    expect(conversations.all(10, { archived: true }).map((entry) => entry.id)).toEqual([archived])
  })

  test('a title is trimmed, bounded, and never emptied', () => {
    const id = conversations.create('Avant')
    conversations.update(id, { title: `   ${'x'.repeat(200)}   ` })
    expect(conversations.all(1)[0]?.title).toHaveLength(80)

    conversations.update(id, { title: '   ' })
    expect(conversations.all(1)[0]?.title).toHaveLength(80)
  })

  test('updating a conversation that does not exist says so', () => {
    expect(conversations.update('missing', { pinned: true })).toBe(false)
  })
})

describe('the history can be searched', () => {
  test('by title or by what was said, whatever the accents and the case', () => {
    const heating = conversations.create('Chauffage')
    const lights = conversations.create('Lumières du soir')
    const other = conversations.create('Divers')
    say(other, 'user', 'Quelle température fait-il au salon ?')

    expect(conversations.all(10, { q: 'chauffage' }).map((entry) => entry.id)).toEqual([heating])
    expect(conversations.all(10, { q: 'LUMIERES' }).map((entry) => entry.id)).toEqual([lights])
    expect(conversations.all(10, { q: 'temperature' }).map((entry) => entry.id)).toEqual([other])
    expect(conversations.all(10, { q: 'garage' })).toEqual([])
  })
})

describe('an answer can be rated', () => {
  test('the rating stays with the answer, and can be taken back', () => {
    const id = conversations.create()
    const answer = say(id, 'assistant', 'Il fait 19,5 °C.')

    expect(agentService.feedback(answer.id, 'up')?.feedback).toBe('up')
    expect(messages.find(answer.id)?.feedback).toBe('up')

    agentService.feedback(answer.id, null)
    expect(messages.find(answer.id)?.feedback).toBeNull()
  })

  test('only an answer can be rated', () => {
    const id = conversations.create()
    const question = say(id, 'user', 'Il fait combien ?')
    expect(agentService.feedback(question.id, 'down')).toBeNull()
    expect(agentService.feedback('missing', 'down')).toBeNull()
  })
})
