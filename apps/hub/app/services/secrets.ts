/**
 * API keys: one place that stores them, and one view of the settings that never shows them.
 *
 * Keys live under the `agent.secrets` settings entry, one per provider. Nothing else in the
 * settings table holds a key - when the console saves the agent settings with a key in
 * `llm.apiKey`, that key is moved here and stripped from the agent blob before anything is
 * written, so the blob the console reads back cannot contain it by construction.
 *
 * The hub is a LAN service with a permissive CORS header on its API. A key returned by any
 * GET is a key readable by every page any device on the network happens to load, so the
 * rule is absolute: `publicSettings()` is the only settings reader exposed over HTTP, and it
 * replaces every key with a boolean.
 */

import type { AdapterConfigField } from '@sway-home/shared'
import { settings } from '#repositories/store'

export interface ProviderSecret {
  apiKey?: string
  baseUrl?: string
}

const SECRETS_KEY = 'agent.secrets'

function all(): Record<string, ProviderSecret> {
  return settings.get<Record<string, ProviderSecret>>(SECRETS_KEY, {})
}

export const secrets = {
  get(provider: string): ProviderSecret | null {
    return all()[provider] ?? null
  },

  has(provider: string): boolean {
    const key = all()[provider]?.apiKey
    return typeof key === 'string' && key.trim().length > 0
  },

  set(provider: string, secret: ProviderSecret): void {
    const current = all()
    settings.set(SECRETS_KEY, { ...current, [provider]: { ...current[provider], ...secret } })
  },

  remove(provider: string): void {
    const current = all()
    delete current[provider]
    settings.set(SECRETS_KEY, current)
  },

  /** Which providers have a usable key. Booleans only: this is what the console may see. */
  presence(): Record<string, boolean> {
    return Object.fromEntries(Object.keys(all()).map((provider) => [provider, secrets.has(provider)]))
  },
}

/**
 * The settings as the console may see them.
 *
 * `agent.secrets` is dropped entirely, and any `apiKey` that still sits in the agent blob -
 * from a version of the console that stored it there - is removed rather than masked, so no
 * code path ever has to remember which string means "set".
 */
export function publicSettings(): Record<string, unknown> {
  const view = settings.all()
  delete view[SECRETS_KEY]

  const agent = view.agent as { llm?: Record<string, unknown> } | undefined
  if (agent) {
    const llm = agent.llm ? { ...agent.llm } : undefined
    if (llm) delete llm.apiKey
    view.agent = { ...agent, ...(llm ? { llm } : {}), keys: secrets.presence() }
  } else {
    view.agent = { keys: secrets.presence() }
  }
  return view
}

/**
 * Saves the agent settings from the console, routing any key to the store.
 *
 * Returns the saved agent blob, which is what the PATCH route echoes back: stripped, like
 * everything else that leaves the hub.
 */
export function saveAgentSettings(patch: Record<string, unknown>): Record<string, unknown> {
  const llm = patch.llm as Record<string, unknown> | undefined
  const incoming = llm ? { ...llm } : undefined

  if (incoming && typeof incoming.apiKey === 'string') {
    const provider = String(incoming.provider ?? settings.get<{ llm?: { provider?: string } }>('agent', {}).llm?.provider ?? '')
    if (provider && incoming.apiKey.trim().length > 0) {
      secrets.set(provider, { apiKey: incoming.apiKey.trim(), ...(typeof incoming.baseUrl === 'string' && incoming.baseUrl ? { baseUrl: incoming.baseUrl } : {}) })
    }
  }
  if (incoming) delete incoming.apiKey

  const saved = settings.patch('agent', { ...patch, ...(incoming ? { llm: incoming } : {}) })

  // A key left behind in the blob by an older console is cleaned up on the next save.
  const savedLlm = saved.llm as Record<string, unknown> | undefined
  if (savedLlm && 'apiKey' in savedLlm) {
    delete savedLlm.apiKey
    settings.set('agent', saved)
  }
  return saved
}

// ---------------------------------------------------------------------------------------
// Adapter credentials
//
// The same rule for the tokens and passwords adapters need: a Home Assistant token, an
// MQTT or camera password. They live in the adapter's saved configuration, and GET
// /adapters used to return that configuration as it was stored.
// ---------------------------------------------------------------------------------------

type ConfigField = Pick<AdapterConfigField, 'key' | 'type'>

function secretKeys(schema: ConfigField[] | undefined): Set<string> {
  return new Set((schema ?? []).filter((field) => field.type === 'password').map((field) => field.key))
}

/** The configuration without its secrets, plus which secrets are set. */
export function publicAdapterConfig(schema: ConfigField[] | undefined, config: Record<string, unknown>): { config: Record<string, unknown>; secretsSet: string[] } {
  const hidden = secretKeys(schema)
  const visible: Record<string, unknown> = {}
  const set: string[] = []
  for (const [key, value] of Object.entries(config)) {
    if (!hidden.has(key)) visible[key] = value
    else if (value !== undefined && value !== null && value !== '') set.push(key)
  }
  return { config: visible, secretsSet: set }
}

/**
 * A saved form, merged into what is stored. The console never has the secrets to send back,
 * so a blank or missing secret means "keep it"; `null` means "remove it".
 */
export function mergeAdapterConfig(schema: ConfigField[] | undefined, stored: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const hidden = secretKeys(schema)
  const merged: Record<string, unknown> = { ...incoming }
  for (const key of hidden) {
    const value = incoming[key]
    if (value === null) delete merged[key]
    else if (value === undefined || value === '') {
      if (stored[key] !== undefined) merged[key] = stored[key]
      else delete merged[key]
    }
  }
  return merged
}
