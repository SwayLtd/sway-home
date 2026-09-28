/**
 * GPT-Live: the voice the house speaks with.
 *
 * The hub's job here is narrow and entirely about safety: it holds the OpenAI key, it builds
 * the session the browser is allowed to open, and it exchanges an SDP offer for an answer.
 * The key never reaches a browser, the session always uses *client* delegation - which is
 * what keeps the house's own agent in charge of every tool call - and local-only mode
 * switches the whole thing off.
 *
 * Those three properties are what is tested. The WebRTC plumbing itself is the browser's.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { liveVoice } from '#services/live_voice'
import { settings } from '#repositories/store'
import { dropDatabase, freshDatabase, seedHouse } from './helpers.ts'

function withKey(key = 'sk-test-123'): void {
  settings.set('agent.secrets', { openai: { apiKey: key } })
}

function withPrivacy(localOnly: boolean): void {
  const current = settings.get<Record<string, unknown>>('agent', {})
  settings.set('agent', { ...current, privacy: { ...(current.privacy as object), localOnly } })
}

beforeEach(async () => {
  await freshDatabase()
  seedHouse()
})

afterAll(dropDatabase)

describe('availability', () => {
  test('without an OpenAI key there is no live voice, and it says why', () => {
    const status = liveVoice.status()
    expect(status.available).toBe(false)
    expect(status.reason).toContain('OpenAI')
  })

  test('with a key it is available', () => {
    withKey()
    expect(liveVoice.status().available).toBe(true)
  })

  test('local-only mode switches it off, key or not', () => {
    withKey()
    withPrivacy(true)
    const status = liveVoice.status()
    expect(status.available).toBe(false)
    expect(status.reason.toLowerCase()).toContain('local')
  })

  test('the key is never part of what the status reports', () => {
    withKey('sk-secret-value')
    expect(JSON.stringify(liveVoice.status())).not.toContain('sk-secret-value')
  })
})

describe('the session the browser is allowed to open', () => {
  test('always delegates to the client, so the house agent stays in charge of the tools', () => {
    const session = liveVoice.sessionConfig()
    expect(session.delegation).toEqual({ type: 'client' })
  })

  test('names the live model', () => {
    expect(liveVoice.sessionConfig().model).toBe('gpt-live-1')
  })

  test('the conversation prompt is short, French, and tells it to delegate', () => {
    const instructions = liveVoice.sessionConfig().instructions
    expect(instructions.length).toBeGreaterThan(80)
    // It rides on every session and is billed by the second: a page of prose here is a bill.
    expect(instructions.length).toBeLessThan(1200)
    expect(instructions.toLowerCase()).toContain('maison')
    expect(instructions.toLowerCase()).toMatch(/delegue|délègue|délégu/)
  })

  test('the brevity rule is in the voice prompt too, not only in the text one', () => {
    expect(liveVoice.sessionConfig().instructions.toLowerCase()).toMatch(/court|bref|une phrase/)
  })

  test('no secret is ever part of the session config', () => {
    withKey('sk-secret-value')
    expect(JSON.stringify(liveVoice.sessionConfig())).not.toContain('sk-secret-value')
  })
})

describe('exchanging the offer', () => {
  test('an empty offer is refused before anything leaves the house', async () => {
    withKey()
    let called = false
    const result = await liveVoice.connect('   ', async () => {
      called = true
      return new Response('{}', { status: 201 })
    })
    expect(result.ok).toBe(false)
    expect(called).toBe(false)
  })

  test('without a key nothing is sent either', async () => {
    let called = false
    const result = await liveVoice.connect('v=0\r\n', async () => {
      called = true
      return new Response('{}', { status: 201 })
    })
    expect(result.ok).toBe(false)
    expect(called).toBe(false)
  })

  test('a successful exchange returns the session id and the answer', async () => {
    withKey()
    const result = await liveVoice.connect('v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n', async (url, init) => {
      expect(String(url)).toContain('/v1/live/sessions')
      const headers = new Headers((init as RequestInit).headers)
      expect(headers.get('authorization')).toBe('Bearer sk-test-123')
      const body = JSON.parse(String((init as RequestInit).body)) as { session: { delegation: unknown }; transport: { type: string; sdp: string } }
      expect(body.transport.type).toBe('webrtc')
      expect(body.transport.sdp).toContain('v=0')
      expect(body.session.delegation).toEqual({ type: 'client' })
      return new Response(JSON.stringify({ session: { id: 'live_123' }, transport: { type: 'webrtc', sdp: 'answer-sdp' } }), { status: 201 })
    })

    expect(result).toMatchObject({ ok: true, sessionId: 'live_123', sdp: 'answer-sdp' })
  })

  test('a refusal from OpenAI comes back as a failure, not an exception', async () => {
    withKey()
    const result = await liveVoice.connect('v=0\r\n', async () => new Response(JSON.stringify({ error: { message: 'no access' } }), { status: 403 }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(403)
  })

  test('a network failure is a failure, not an unhandled rejection', async () => {
    withKey()
    const result = await liveVoice.connect('v=0\r\n', async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    expect(result.ok).toBe(false)
  })
})
