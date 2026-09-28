/**
 * The model picker behind the composer.
 *
 * Three families, in the order a privacy-first hub should offer them: the offline engine
 * (the intent parser: no model, instant, free), the models of a runner on this machine, and
 * the hosted ones. Every entry says whether it can be used right now and, when it cannot,
 * why - a missing key, a runner that does not answer, the local-only mode. A choice that
 * cannot run is refused with that reason; it is never swapped for another model behind the
 * person's back.
 */

import { buildProvider, PROVIDER_CATALOGUE, type ModelProvider } from '#agent/providers'
import { secrets } from '#services/secrets'
import { settings } from '#repositories/store'

export type ModelGroup = 'Hors ligne' | 'Sur cette machine' | 'En ligne'

export interface ModelChoice {
  /** `offline`, or `provider:model`. */
  id: string
  provider: string
  model: string
  label: string
  hint: string
  group: ModelGroup
  available: boolean
  /** Why it cannot be used right now. */
  reason?: string
  /** The model in the settings: what a question uses when none is chosen. */
  current: boolean
}

export interface ModelChoiceInput {
  configured: { provider: string; model: string } | null
  localOnly: boolean
  /** Which providers have a key. Booleans only, never the key. */
  keys: Record<string, boolean>
  runners: { id: string; up: boolean; models: string[] }[]
}

export const OFFLINE = 'offline'

const RUNNER_DOWN: Record<string, string> = {
  ollama: 'Ollama ne répond pas',
  lmstudio: 'LM Studio ne répond pas',
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
}

export function modelChoices(input: ModelChoiceInput): ModelChoice[] {
  const configured = input.configured && input.configured.provider !== 'none' ? input.configured : null
  const currentId = configured ? `${configured.provider}:${configured.model}` : OFFLINE

  const out: ModelChoice[] = [
    {
      id: OFFLINE,
      provider: 'none',
      model: '',
      label: 'Moteur local',
      hint: 'Commandes simples, sans modèle, instantané',
      group: 'Hors ligne',
      available: true,
      current: currentId === OFFLINE,
    },
  ]

  const local: ModelChoice[] = []
  const hosted: ModelChoice[] = []

  for (const definition of PROVIDER_CATALOGUE) {
    const runner = input.runners.find((candidate) => candidate.id === definition.id)
    const pulled = runner?.up ? runner.models : []
    const models = unique([...(configured?.provider === definition.id ? [configured.model] : []), ...pulled, ...definition.models])

    /** Why this model cannot run now: a local one must be pulled on a runner that answers. */
    const reasonFor = (model: string): string | undefined => {
      if (definition.local) {
        if (!runner?.up) return RUNNER_DOWN[definition.id] ?? `${definition.label} ne répond pas`
        return pulled.includes(model) ? undefined : 'Pas téléchargé'
      }
      if (input.localOnly) return 'Mode local seulement'
      if (definition.needsKey && !input.keys[definition.id]) return 'Clé API manquante'
      return undefined
    }

    for (const model of models) {
      const id = `${definition.id}:${model}`
      const reason = reasonFor(model)
      const choice: ModelChoice = {
        id,
        provider: definition.id,
        model,
        label: model,
        hint: definition.label,
        group: definition.local ? 'Sur cette machine' : 'En ligne',
        available: reason === undefined,
        ...(reason ? { reason } : {}),
        current: id === currentId,
      }
      ;(definition.local ? local : hosted).push(choice)
    }
  }

  return [...out, ...local, ...hosted]
}

/** The same list, from the live settings and a probe of the runners on this machine. */
export function liveModelChoices(runners: ModelChoiceInput['runners']): ModelChoice[] {
  const agent = settings.get<{ llm?: { provider?: string; model?: string }; privacy?: { localOnly?: boolean } }>('agent', {})
  const provider = agent.llm?.provider
  const catalogue = PROVIDER_CATALOGUE.find((definition) => definition.id === provider)
  return modelChoices({
    configured: provider && provider !== 'none' ? { provider, model: agent.llm?.model || catalogue?.models[0] || '' } : null,
    localOnly: agent.privacy?.localOnly === true,
    keys: secrets.presence(),
    runners,
  })
}

/** A `provider:model` id split in two, when the hub knows the provider; null for anything else. */
export function parseChoiceId(id: string): { providerId: string; model: string } | null {
  const separator = id.indexOf(':')
  const providerId = separator > 0 ? id.slice(0, separator) : ''
  const model = separator > 0 ? id.slice(separator + 1).trim() : ''
  if (!PROVIDER_CATALOGUE.some((candidate) => candidate.id === providerId) || !model || model.length > 120) return null
  return { providerId, model }
}

/**
 * The provider for a choice made in the picker. `offline` is no provider at all: only the
 * intent parser answers. Anything that cannot run returns the reason instead.
 */
export function providerForChoice(id: string): { provider: ModelProvider | null; error?: string } {
  if (id === OFFLINE) return { provider: null }

  const parsed = parseChoiceId(id)
  const definition = parsed ? PROVIDER_CATALOGUE.find((candidate) => candidate.id === parsed.providerId) : undefined
  if (!parsed || !definition) return { provider: null, error: 'Modèle inconnu' }
  const { providerId, model } = parsed

  const localOnly = settings.get<{ privacy?: { localOnly?: boolean } }>('agent', {}).privacy?.localOnly === true
  if (!definition.local && localOnly) return { provider: null, error: 'Mode local seulement' }

  const secret = secrets.get(providerId)
  if (definition.needsKey && !secrets.has(providerId)) return { provider: null, error: 'Clé API manquante' }

  const provider = buildProvider({ provider: providerId, model, apiKey: secret?.apiKey, baseUrl: secret?.baseUrl })
  if (!provider) return { provider: null, error: 'Configuration incomplète' }
  return { provider }
}
