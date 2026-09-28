/**
 * Model providers.
 *
 * One interface, several back ends, no SDKs. Every provider here speaks HTTP and JSON, and
 * the two shapes that matter - OpenAI's chat completions and Anthropic's messages - are
 * about eighty lines each. Writing them out means the hub has no vendor SDK in its
 * dependency tree, can add a provider in one file, and works against anything
 * OpenAI-compatible (Ollama, LM Studio, vLLM, llama.cpp, OpenRouter, Together, Groq,
 * DeepSeek, Mistral) without any new code at all.
 *
 * Privacy is a first-class property of a provider, not a footnote: `local` is true only for
 * back ends that keep the text on this machine, and `localOnly` mode refuses every other.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[]
  toolCallId?: string
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface ChatResponse {
  content: string
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[]
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  model: string
  finishReason: string
}

export interface ModelProvider {
  id: string
  label: string
  /** True when the text never leaves this machine. */
  local: boolean
  /** Needs an API key to work at all. */
  needsKey: boolean
  defaultModel: string
  /** USD per million tokens, for the budget guard. Zero for local. */
  pricing: { input: number; output: number }
  chat(request: ChatRequest): Promise<ChatResponse>
  listModels?(): Promise<string[]>
}

// ---------------------------------------------------------------------------------------
// OpenAI-compatible (covers most of the world, including every local runner)
// ---------------------------------------------------------------------------------------

interface OpenAiCompatibleOptions {
  id: string
  label: string
  baseUrl: string
  apiKey?: string
  defaultModel: string
  local?: boolean
  pricing?: { input: number; output: number }
  extraHeaders?: Record<string, string>
}

/**
 * The OpenAI families that reason. They share three constraints the older dialect does not
 * know about, all verified against the live API on 2026-09-26:
 *
 *  - `max_tokens` is refused; `max_completion_tokens` is the only accepted name;
 *  - a temperature other than the default is refused (gpt-6 at least);
 *  - on Chat Completions, function tools are refused unless `reasoning_effort` is `none`
 *    (https://developers.openai.com/api/docs/models/gpt-6-luna).
 */
const OPENAI_REASONING = /^(gpt-5|gpt-6|o\d)/

/**
 * The Chat Completions body, per provider dialect. Exported because it is the part that
 * breaks when a vendor changes its API, and it is pure, so it can be pinned by tests.
 */
export function buildChatBody(options: Pick<OpenAiCompatibleOptions, 'id' | 'defaultModel'>, request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.defaultModel,
    messages: request.messages.map(toOpenAiMessage),
  }
  const hasTools = Boolean(request.tools?.length)
  const isOpenAi = options.id === 'openai'
  const reasons = isOpenAi && OPENAI_REASONING.test(options.defaultModel)

  if (reasons) {
    // A house agent always sends tools, and gpt-6 refuses tools with reasoning on. Without
    // tools a little reasoning is cheap and helps the one-shot summaries.
    body.reasoning_effort = hasTools ? 'none' : 'low'
  } else {
    body.temperature = request.temperature ?? 0.3
  }

  if (request.maxTokens) {
    if (isOpenAi) body.max_completion_tokens = request.maxTokens
    else body.max_tokens = request.maxTokens
  }

  if (hasTools) {
    body.tools = request.tools!.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    body.tool_choice = 'auto'
  }
  return body
}

export function openAiCompatible(options: OpenAiCompatibleOptions): ModelProvider {
  return {
    id: options.id,
    label: options.label,
    local: options.local ?? false,
    needsKey: !options.local,
    defaultModel: options.defaultModel,
    pricing: options.pricing ?? { input: 0, output: 0 },

    async chat(request) {
      const body = buildChatBody(options, request)

      const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...(options.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
        signal: request.signal,
      })

      if (!response.ok) {
        throw new Error(`${options.label} answered ${response.status}: ${(await response.text()).slice(0, 400)}`)
      }

      const data = (await response.json()) as Record<string, any>
      const choice = data.choices?.[0]
      const message = choice?.message ?? {}

      const toolCalls = (message.tool_calls ?? []).map((call: Record<string, any>) => ({
        id: String(call.id ?? crypto.randomUUID()),
        name: String(call.function?.name ?? ''),
        args: safeParse(call.function?.arguments),
      }))

      const inputTokens = Number(data.usage?.prompt_tokens ?? 0)
      const outputTokens = Number(data.usage?.completion_tokens ?? 0)
      const pricing = options.pricing ?? { input: 0, output: 0 }

      return {
        content: String(message.content ?? ''),
        toolCalls,
        usage: {
          inputTokens,
          outputTokens,
          costUsd: Number(((inputTokens / 1e6) * pricing.input + (outputTokens / 1e6) * pricing.output).toFixed(6)),
        },
        model: String(data.model ?? options.defaultModel),
        finishReason: String(choice?.finish_reason ?? 'stop'),
      }
    },

    async listModels() {
      const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/models`, {
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
      }).catch(() => null)
      if (!response?.ok) return []
      const data = (await response.json()) as { data?: { id: string }[] }
      return (data.data ?? []).map((model) => model.id)
    },
  }
}

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
  if (message.toolCalls?.length) {
    return {
      role: message.role,
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    }
  }
  return { role: message.role, content: message.content }
}

// ---------------------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------------------

export function anthropicProvider(apiKey: string, model = 'claude-sonnet-5'): ModelProvider {
  return {
    id: 'anthropic',
    label: 'Anthropic',
    local: false,
    needsKey: true,
    defaultModel: model,
    pricing: { input: 3, output: 15 },

    async chat(request) {
      const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n')
      const messages = request.messages.filter((message) => message.role !== 'system').map(toAnthropicMessage)

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          system: system || undefined,
          messages,
          max_tokens: request.maxTokens ?? 2048,
          temperature: request.temperature ?? 0.3,
          tools: request.tools?.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
        }),
        signal: request.signal,
      })

      if (!response.ok) {
        throw new Error(`Anthropic answered ${response.status}: ${(await response.text()).slice(0, 400)}`)
      }

      const data = (await response.json()) as Record<string, any>
      const blocks = (data.content ?? []) as Record<string, any>[]

      return {
        content: blocks.filter((block) => block.type === 'text').map((block) => block.text).join(''),
        toolCalls: blocks
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({ id: String(block.id), name: String(block.name), args: (block.input ?? {}) as Record<string, unknown> })),
        usage: {
          inputTokens: Number(data.usage?.input_tokens ?? 0),
          outputTokens: Number(data.usage?.output_tokens ?? 0),
          costUsd: Number((((data.usage?.input_tokens ?? 0) / 1e6) * 3 + ((data.usage?.output_tokens ?? 0) / 1e6) * 15).toFixed(6)),
        },
        model: String(data.model ?? model),
        finishReason: String(data.stop_reason ?? 'end_turn'),
      }
    },
  }
}

function toAnthropicMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }] }
  }
  if (message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...message.toolCalls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })),
      ],
    }
  }
  return { role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }
}

// ---------------------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------------------

export function geminiProvider(apiKey: string, model = 'gemini-2.5-flash'): ModelProvider {
  return {
    id: 'google',
    label: 'Google Gemini',
    local: false,
    needsKey: true,
    defaultModel: model,
    pricing: { input: 0.3, output: 2.5 },

    async chat(request) {
      const system = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n')
      const contents = request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => {
          if (message.role === 'tool') {
            return { role: 'user', parts: [{ functionResponse: { name: message.toolCallId ?? 'tool', response: { result: message.content } } }] }
          }
          if (message.toolCalls?.length) {
            return {
              role: 'model',
              parts: [
                ...(message.content ? [{ text: message.content }] : []),
                ...message.toolCalls.map((call) => ({ functionCall: { name: call.name, args: call.args } })),
              ],
            }
          }
          return { role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }
        })

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          generationConfig: { temperature: request.temperature ?? 0.3, maxOutputTokens: request.maxTokens ?? 2048 },
          tools: request.tools?.length
            ? [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: stripJsonSchemaExtras(tool.parameters) })) }]
            : undefined,
        }),
        signal: request.signal,
      })

      if (!response.ok) {
        throw new Error(`Gemini answered ${response.status}: ${(await response.text()).slice(0, 400)}`)
      }

      const data = (await response.json()) as Record<string, any>
      const parts = (data.candidates?.[0]?.content?.parts ?? []) as Record<string, any>[]

      return {
        content: parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join(''),
        toolCalls: parts
          .filter((part) => part.functionCall)
          .map((part) => ({ id: crypto.randomUUID(), name: String(part.functionCall.name), args: (part.functionCall.args ?? {}) as Record<string, unknown> })),
        usage: {
          inputTokens: Number(data.usageMetadata?.promptTokenCount ?? 0),
          outputTokens: Number(data.usageMetadata?.candidatesTokenCount ?? 0),
          costUsd: Number((((data.usageMetadata?.promptTokenCount ?? 0) / 1e6) * 0.3 + ((data.usageMetadata?.candidatesTokenCount ?? 0) / 1e6) * 2.5).toFixed(6)),
        },
        model,
        finishReason: String(data.candidates?.[0]?.finishReason ?? 'STOP'),
      }
    },
  }
}

/** Gemini rejects a few JSON Schema keywords the other providers accept. */
function stripJsonSchemaExtras(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(schema) as Record<string, any>
  const walk = (node: Record<string, any>) => {
    delete node.$schema
    delete node.additionalProperties
    delete node.default
    delete node.exclusiveMinimum
    delete node.exclusiveMaximum
    if (node.properties) for (const child of Object.values(node.properties)) walk(child as Record<string, any>)
    if (node.items) walk(node.items as Record<string, any>)
  }
  walk(clone)
  return clone
}

// ---------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------

export interface ProviderDefinition {
  id: string
  label: string
  local: boolean
  needsKey: boolean
  models: string[]
  /** What it costs per million tokens, shown in the settings screen. */
  pricing: { input: number; output: number }
  baseUrlHint?: string
  note: string
}

export const PROVIDER_CATALOGUE: ProviderDefinition[] = [
  {
    id: 'ollama',
    label: 'Ollama (local)',
    local: true,
    needsKey: false,
    models: ['qwen3:8b', 'llama3.2:3b', 'mistral-small', 'gemma3:12b', 'qwen2.5:14b'],
    pricing: { input: 0, output: 0 },
    baseUrlHint: 'http://127.0.0.1:11434/v1',
    note: 'Nothing leaves the machine. The right default for a privacy-first hub once a model is pulled.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    local: true,
    needsKey: false,
    models: [],
    pricing: { input: 0, output: 0 },
    baseUrlHint: 'http://127.0.0.1:1234/v1',
    note: 'Same idea as Ollama with a desktop app in front of it.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    local: false,
    needsKey: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
    pricing: { input: 0.28, output: 0.42 },
    baseUrlHint: 'https://api.deepseek.com/v1',
    note: 'The cheapest capable hosted model for tool calling by a wide margin.',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    local: false,
    needsKey: true,
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
    pricing: { input: 0.3, output: 2.5 },
    note: 'Flash is fast and cheap; Flash-Lite is cheaper still and enough for routing a voice command.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    local: false,
    needsKey: true,
    models: ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.4-mini', 'gpt-5.4-nano'],
    // gpt-6-luna, per https://developers.openai.com/api/docs/models/gpt-6-luna (2026-09-26).
    pricing: { input: 0.1, output: 0.5 },
    baseUrlHint: 'https://api.openai.com/v1',
    note: 'gpt-6-luna: rapide, 0,10 / 0,50 USD par million de tokens, appels d outils fiables. Sol pour les demandes complexes.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    local: false,
    needsKey: true,
    models: ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5'],
    pricing: { input: 3, output: 15 },
    note: 'Best reasoning for the autonomous planner; Haiku for the fast path.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    local: false,
    needsKey: true,
    models: ['mistral-small-latest', 'mistral-medium-latest'],
    pricing: { input: 0.2, output: 0.6 },
    baseUrlHint: 'https://api.mistral.ai/v1',
    note: 'European hosting, which matters for a product that sells privacy.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    local: false,
    needsKey: true,
    models: ['auto'],
    pricing: { input: 0, output: 0 },
    baseUrlHint: 'https://openrouter.ai/api/v1',
    note: 'One key, every model. Useful while deciding which one this product should ship with.',
  },
  {
    id: 'custom',
    label: 'Any OpenAI-compatible endpoint',
    local: false,
    needsKey: false,
    models: [],
    pricing: { input: 0, output: 0 },
    note: 'vLLM, llama.cpp, Groq, Together, a company gateway. Point it at a base URL and it works.',
  },
]

export function buildProvider(config: { provider: string; model?: string; apiKey?: string; baseUrl?: string }): ModelProvider | null {
  const model = config.model?.trim() || ''

  switch (config.provider) {
    case 'ollama':
      return openAiCompatible({
        id: 'ollama',
        label: 'Ollama',
        baseUrl: config.baseUrl || 'http://127.0.0.1:11434/v1',
        defaultModel: model || 'qwen3:8b',
        local: true,
        apiKey: 'ollama',
      })
    case 'lmstudio':
      return openAiCompatible({
        id: 'lmstudio',
        label: 'LM Studio',
        baseUrl: config.baseUrl || 'http://127.0.0.1:1234/v1',
        defaultModel: model || 'local-model',
        local: true,
        apiKey: 'lm-studio',
      })
    case 'deepseek':
      if (!config.apiKey) return null
      return openAiCompatible({
        id: 'deepseek',
        label: 'DeepSeek',
        baseUrl: config.baseUrl || 'https://api.deepseek.com/v1',
        apiKey: config.apiKey,
        defaultModel: model || 'deepseek-chat',
        pricing: { input: 0.28, output: 0.42 },
      })
    case 'openai':
      if (!config.apiKey) return null
      return openAiCompatible({
        id: 'openai',
        label: 'OpenAI',
        baseUrl: config.baseUrl || 'https://api.openai.com/v1',
        apiKey: config.apiKey,
        defaultModel: model || 'gpt-6-luna',
        pricing: { input: 0.1, output: 0.5 },
      })
    case 'mistral':
      if (!config.apiKey) return null
      return openAiCompatible({
        id: 'mistral',
        label: 'Mistral',
        baseUrl: config.baseUrl || 'https://api.mistral.ai/v1',
        apiKey: config.apiKey,
        defaultModel: model || 'mistral-small-latest',
        pricing: { input: 0.2, output: 0.6 },
      })
    case 'openrouter':
      if (!config.apiKey) return null
      return openAiCompatible({
        id: 'openrouter',
        label: 'OpenRouter',
        baseUrl: config.baseUrl || 'https://openrouter.ai/api/v1',
        apiKey: config.apiKey,
        defaultModel: model || 'anthropic/claude-sonnet-5',
        extraHeaders: { 'http-referer': 'https://sway.events', 'x-title': 'Sway Home' },
      })
    case 'anthropic':
      if (!config.apiKey) return null
      return anthropicProvider(config.apiKey, model || 'claude-sonnet-5')
    case 'google':
      if (!config.apiKey) return null
      return geminiProvider(config.apiKey, model || 'gemini-2.5-flash')
    case 'custom':
      if (!config.baseUrl) return null
      return openAiCompatible({
        id: 'custom',
        label: 'Custom endpoint',
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        defaultModel: model || 'default',
      })
    default:
      return null
  }
}

function safeParse(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  if (typeof value === 'object') return value as Record<string, unknown>
  try {
    return JSON.parse(String(value)) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Is a local runner answering right now? Used by the settings screen. */
export async function probeLocalRunners(): Promise<{ id: string; url: string; up: boolean; models: string[] }[]> {
  const candidates = [
    { id: 'ollama', url: 'http://127.0.0.1:11434/v1' },
    { id: 'lmstudio', url: 'http://127.0.0.1:1234/v1' },
    { id: 'llamacpp', url: 'http://127.0.0.1:8080/v1' },
  ]

  return Promise.all(
    candidates.map(async (candidate) => {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 1200)
        const response = await fetch(`${candidate.url}/models`, { signal: controller.signal })
        clearTimeout(timer)
        if (!response.ok) return { ...candidate, up: false, models: [] }
        const data = (await response.json()) as { data?: { id: string }[] }
        return { ...candidate, up: true, models: (data.data ?? []).map((model) => model.id) }
      } catch {
        return { ...candidate, up: false, models: [] }
      }
    })
  )
}
