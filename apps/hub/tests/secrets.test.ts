/**
 * Where the API keys live, and where they must never appear.
 *
 * Two defects motivated this file. The console saved a key under `agent.llm.apiKey` while
 * the provider read `agent.secrets[provider].apiKey`, so a key typed in the settings screen
 * was silently never used. And `GET /settings` returned the raw settings table, which would
 * have handed `agent.secrets` to any browser on the network the moment a key was stored.
 *
 * The rules tested here: one place stores keys, the public view never contains one, and a
 * key saved from the console is the key the provider and the live voice actually use.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mergeAdapterConfig, publicAdapterConfig, secrets, publicSettings, saveAgentSettings } from '#services/secrets'
import { adapterConfig, settings } from '#repositories/store'
import { adapters } from '#services/adapter_manager'
import { HomeAssistantAdapter } from '#adapters/homeassistant'
import { liveVoice } from '#services/live_voice'
import { dropDatabase, freshDatabase } from './helpers.ts'

const KEY = 'sk-proj-THIS-IS-A-TEST-KEY-0000'

beforeEach(async () => {
  await freshDatabase()
})

afterAll(dropDatabase)

describe('the store', () => {
  test('keeps one key per provider', () => {
    secrets.set('openai', { apiKey: KEY })
    secrets.set('anthropic', { apiKey: 'sk-ant-other' })
    expect(secrets.get('openai')?.apiKey).toBe(KEY)
    expect(secrets.get('anthropic')?.apiKey).toBe('sk-ant-other')
  })

  test('knows whether a provider has a key without handing it over', () => {
    expect(secrets.has('openai')).toBe(false)
    secrets.set('openai', { apiKey: KEY })
    expect(secrets.has('openai')).toBe(true)
  })

  test('a blank key is no key', () => {
    secrets.set('openai', { apiKey: '   ' })
    expect(secrets.has('openai')).toBe(false)
  })

  test('removing a key removes it', () => {
    secrets.set('openai', { apiKey: KEY })
    secrets.remove('openai')
    expect(secrets.has('openai')).toBe(false)
  })
})

describe('the public view of the settings', () => {
  test('never contains a stored key, anywhere', () => {
    secrets.set('openai', { apiKey: KEY, baseUrl: 'https://api.openai.com/v1' })
    settings.set('agent', { llm: { provider: 'openai', model: 'gpt-5-mini', apiKey: KEY } })
    expect(JSON.stringify(publicSettings())).not.toContain(KEY)
  })

  test('says which providers have a key, so the console can show it as set', () => {
    secrets.set('openai', { apiKey: KEY })
    const view = publicSettings() as { agent?: { keys?: Record<string, boolean> } }
    expect(view.agent?.keys?.openai).toBe(true)
  })

  test('the raw secrets entry is not part of the view at all', () => {
    secrets.set('openai', { apiKey: KEY })
    expect(Object.keys(publicSettings())).not.toContain('agent.secrets')
  })

  test('the rest of the settings survive the redaction', () => {
    settings.set('energy', { pricePerKwh: 0.25, currency: 'EUR' })
    expect(publicSettings().energy).toEqual({ pricePerKwh: 0.25, currency: 'EUR' })
  })
})

describe('saving from the console', () => {
  test('a key typed in the settings screen moves to the store and out of the agent settings', () => {
    saveAgentSettings({ llm: { provider: 'openai', model: 'gpt-5-mini', apiKey: KEY } })

    expect(secrets.get('openai')?.apiKey).toBe(KEY)
    const stored = settings.get<{ llm?: Record<string, unknown> }>('agent', {})
    expect(stored.llm?.apiKey).toBeUndefined()
    expect(stored.llm?.model).toBe('gpt-5-mini')
  })

  test('saving without a key keeps the key already stored', () => {
    saveAgentSettings({ llm: { provider: 'openai', model: 'gpt-5-mini', apiKey: KEY } })
    saveAgentSettings({ llm: { provider: 'openai', model: 'gpt-5' } })
    expect(secrets.get('openai')?.apiKey).toBe(KEY)
  })

  test('the key lands under the provider it was typed for', () => {
    saveAgentSettings({ llm: { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-ant-xyz' } })
    expect(secrets.get('anthropic')?.apiKey).toBe('sk-ant-xyz')
    expect(secrets.has('openai')).toBe(false)
  })

  test('the live voice sees a key saved from the console', () => {
    saveAgentSettings({ llm: { provider: 'openai', model: 'gpt-5-mini', apiKey: KEY } })
    expect(liveVoice.status().available).toBe(true)
  })

  test('the saved settings echo never contains the key either', () => {
    const echoed = saveAgentSettings({ llm: { provider: 'openai', model: 'gpt-5-mini', apiKey: KEY } })
    expect(JSON.stringify(echoed)).not.toContain(KEY)
  })
})

describe('adapter credentials', () => {
  const schema = [
    { key: 'url', label: 'URL', type: 'host' as const },
    { key: 'token', label: 'Token', type: 'password' as const },
  ]

  test('the public view drops every password field and only says which ones are set', () => {
    const view = publicAdapterConfig(schema, { url: 'http://ha.local:8123', token: 'eyJ-secret' })
    expect(view.config).toEqual({ url: 'http://ha.local:8123' })
    expect(view.secretsSet).toEqual(['token'])
    expect(JSON.stringify(view)).not.toContain('eyJ-secret')
  })

  test('saving the form without retyping a secret keeps the stored one', () => {
    expect(mergeAdapterConfig(schema, { url: 'a', token: 'kept' }, { url: 'b', token: '' })).toEqual({ url: 'b', token: 'kept' })
    expect(mergeAdapterConfig(schema, { url: 'a', token: 'kept' }, { url: 'b' })).toEqual({ url: 'b', token: 'kept' })
  })

  test('a new secret replaces the old one, and null clears it', () => {
    expect(mergeAdapterConfig(schema, { token: 'old' }, { token: 'new' })).toEqual({ token: 'new' })
    expect(mergeAdapterConfig(schema, { token: 'old' }, { token: null })).toEqual({})
  })

  test('through the manager: a re-saved form keeps the Home Assistant token', async () => {
    adapters.register(new HomeAssistantAdapter())
    await adapters.configure('homeassistant', { url: 'http://ha.local:8123', token: 'eyJ-secret' })
    await adapters.configure('homeassistant', { url: 'http://ha2.local:8123', token: '' })
    expect(adapterConfig.get('homeassistant').config).toEqual({ url: 'http://ha2.local:8123', token: 'eyJ-secret' })
  })
})
