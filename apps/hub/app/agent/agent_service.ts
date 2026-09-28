/**
 * The agent.
 *
 * Two brains behind one interface:
 *
 *  - **The model**, when one is configured. A tool-calling loop with a system prompt built
 *    from the live state of the house, a budget guard, and a permission layer the model
 *    cannot argue its way past.
 *  - **The fallback**, when one is not. A deterministic intent parser over French and
 *    English. It handles the twenty phrasings that make up most of what anyone says to a
 *    house ("éteins tout", "mets le salon à 20 degrés", "il fait combien dans la chambre"),
 *    and it works offline, instantly, for free.
 *
 * The fallback is not a placeholder. A house assistant that stops working when an API key
 * expires is not an assistant, and the parser also gives the model a fast path: obvious
 * commands never reach it, which keeps both the bill and the latency down.
 */

import { secrets } from '#services/secrets'
import { randomUUID } from 'node:crypto'
import {
  AUTONOMY,
  DEFAULT_AUTONOMY,
  capabilityCatalogueForPrompt,
  stripRichText,
  type AgentMessage,
  type AgentSettings,
  type AgentToolContext,
  type AgentToolResult,
  type AgentTraceEntry,
  type AutonomyLevel,
} from '@sway-home/shared'
import { buildProvider, type ChatMessage, type ModelProvider } from '#agent/providers'
import { AGENT_TOOLS, toolByName, toolSchemas, resolveDevice } from '#agent/tools'
import { contextFor, sourcesFromTrace } from '#agent/sources'
import { OFFLINE, providerForChoice } from '#agent/model_choice'
import { mentionNote, type Mention } from '#agent/composer'
import { explainOffline, NEEDS_MODEL, rewriteWithModel, shortenOffline, type RewriteAction, type RewriteResult } from '#agent/rewrite'
import { parseIntent, resumeIntent } from '#agent/intent_parser'
import { autonomyEngine } from '#services/autonomy_engine'
import { bus } from '#services/event_bus'
import { houseService } from '#services/house'
import { database, insertInto, nowIso } from '#db/database'
import { conversations, memories, messages, places, proposals, settings, undo } from '#repositories/store'
import { deviceRepository } from '#repositories/device_repository'

export interface AgentRunOptions {
  conversationId?: string
  correlationId?: string
  unattended?: boolean
  maxActions?: number
  /** Aborted when the person leaves: the run stops between steps and says what it did. */
  signal?: AbortSignal
  /** Streams each step to the caller, so the UI can show thinking rather than a spinner. */
  onStep?: (step: AgentStep) => void
  /** The model for this run, instead of the one in the settings. */
  provider?: ModelProvider
  /**
   * The answers to the questions the previous answer asked, by question id. When the parser
   * asked, they run the command it was waiting for; for the model they are just the text.
   */
  answers?: Record<string, string[] | string>
  /** The model picked in the composer for this question: `offline` or `provider:model`. */
  model?: string
  /** What the person designated with `@`: the model is told exactly which things. */
  mentions?: Mention[]
}

/**
 * One step of a run, as it streams. A tool call and its result share the provider's call id,
 * so the interface can close the right spinner even when several tools run in one turn.
 */
export type AgentStep =
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: Record<string, unknown>; at: string }
  | { kind: 'tool_result'; id: string; name: string; summary: string; ok: boolean; durationMs: number }
  | { kind: 'message'; message: AgentMessage }
  | { kind: 'error'; message: string }

const INTERRUPTED_BEFORE_RUN = "Interrompu avant de s'exécuter."

const MAX_ANSWERED_QUESTIONS = 8
const MAX_ANSWER_LENGTH = 200

/**
 * Answers as a client sends them: question id to one option id, or to several. Anything that
 * is not a string is dropped, and the sizes are bounded, because this arrives from a page.
 */
export function parseAnswers(input: unknown): Record<string, string[]> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_ANSWERED_QUESTIONS) break
    const values = (Array.isArray(value) ? value : [value])
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      .slice(0, MAX_ANSWERED_QUESTIONS)
      .map((entry) => entry.slice(0, MAX_ANSWER_LENGTH))
    if (values.length > 0) out[key.slice(0, 40)] = values
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError') || (error as { name?: string } | null)?.name === 'AbortError'
}

export interface AgentRunResult {
  ok: boolean
  reply: string
  conversationId: string
  attachments: AgentMessage['attachments']
  steps: number
  usage: { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number }
  usedFallback: boolean
  proposalIds: string[]
  error?: string
}

const AGENT_DEFAULTS = {
    autonomy: DEFAULT_AUTONOMY,
    voice: { enabled: true, wakeWord: 'hey jarvis', wakeWordEnabled: false, sttProvider: 'browser-local', ttsProvider: 'browser-kokoro', ttsVoice: 'ff_siwis', language: 'fr', speakReplies: true },
    llm: { provider: 'none', model: '', temperature: 0.3, maxSteps: 12, dailyBudgetUsd: 2 },
    privacy: { localOnly: false, shareDeviceNames: true, retainTranscriptsDays: 30, retainAudio: false },
    proactivity: { suggestRoutines: true, suggestOnNewDevice: true, dailyBriefing: true, briefingTime: '08:00', maxUnpromptedActionsPerHour: 6, quietHours: ['22:30', '07:00'] },
} as AgentSettings

/**
 * Stored settings over the defaults, one level deep. A stored object written by one screen
 * (the voice settings, say) must not erase the defaults of the sections it did not touch.
 */
function agentSettings(): AgentSettings {
  const stored = settings.get<Partial<AgentSettings>>('agent', {})
  const merged: Record<string, unknown> = { ...AGENT_DEFAULTS }
  for (const [key, value] of Object.entries(stored)) {
    const base = (AGENT_DEFAULTS as unknown as Record<string, unknown>)[key]
    merged[key] = value && typeof value === 'object' && !Array.isArray(value) && base && typeof base === 'object' ? { ...base, ...value } : value
  }
  return merged as unknown as AgentSettings
}

function currentProvider(): ModelProvider | null {
  const config = agentSettings()
  if (config.llm.provider === 'none' || !config.llm.provider) return null

  const secret = secrets.get(config.llm.provider)
  const provider = buildProvider({
    provider: config.llm.provider,
    model: config.llm.model,
    apiKey: secret?.apiKey,
    baseUrl: secret?.baseUrl,
  })

  // Privacy mode is absolute: a hosted provider is simply not available.
  if (provider && config.privacy.localOnly && !provider.local) return null
  return provider
}

/** The model in the settings, for the services that ask it something outside a conversation. */
export function configuredProvider(): ModelProvider | null {
  return currentProvider()
}

/** Whether a hosted model may still be called today. A local one always may. */
export function withinBudget(provider: ModelProvider): boolean {
  return provider.local || spentToday() < agentSettings().llm.dailyBudgetUsd
}

/** Every model call counts against the budget, conversation or not. */
export function recordModelUse(input: { provider: ModelProvider; trigger: string; goal: string; usage: { inputTokens: number; outputTokens: number; costUsd: number }; latencyMs: number; error?: string | null }): void {
  insertInto('agent_runs', {
    id: randomUUID(),
    conversation_id: null,
    goal: input.goal.slice(0, 500),
    trigger: input.trigger,
    steps: 1,
    input_tokens: input.usage.inputTokens,
    output_tokens: input.usage.outputTokens,
    cost_usd: input.usage.costUsd,
    latency_ms: input.latencyMs,
    provider: input.provider.id,
    model: input.provider.defaultModel,
    status: input.error ? 'error' : 'ok',
    error: input.error ?? null,
    created_at: nowIso(),
  })
}

function spentToday(): number {
  const row = database().get<{ total: number }>(
    "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM agent_runs WHERE created_at > datetime('now', '-1 day')"
  )
  return Number(row?.total ?? 0)
}

// ---------------------------------------------------------------------------------------
// The system prompt
// ---------------------------------------------------------------------------------------

/**
 * What the reflexes do and did, so the model answers "que fais-tu de toi-même" from the
 * house rather than from a guess about its own settings.
 */
function autonomyLines(): string {
  const status = autonomyEngine.status()
  const labels = autonomyEngine
    .reflexSettings()
    .filter((reflex) => reflex.enabled)
    .map((reflex) => reflex.label.toLowerCase())
  const lines = [
    status.actsAlone
      ? `Tu agis sans attendre qu'on te le demande, et tu le dis dans le chat avec de quoi annuler. Réflexes actifs : ${labels.join(', ') || 'aucun'}.`
      : `Tu repères les situations (${labels.join(', ') || 'aucune'}) mais tu proposes au lieu d'agir.`,
  ]
  if (status.recent.length > 0) lines.push(`Fait récemment de toi-même : ${status.recent.map((entry) => stripRichText(entry.text)).join(' | ')}`)
  return lines.join('\n')
}

function buildSystemPrompt(autonomy: AutonomyLevel, unattended: boolean): string {
  const snapshot = houseService.snapshot()
  const areas = places.areas()
  const facts = memories.forPrompt(25)
  const config = agentSettings()

  const deviceLines = snapshot.devices
    .filter((device) => !device.hidden)
    .slice(0, 150)
    .map((device) => {
      const area = device.areaId ? areas.find((candidate) => candidate.id === device.areaId)?.name ?? '?' : 'sans pièce'
      return `${device.id.slice(0, 8)} ${device.name} [${area}] ${device.category} {${device.capabilities.join(',')}}`
    })

  return [
    `Tu es l'assistant domestique de cette maison. Tu parles ${config.voice.language === 'fr' ? 'français' : 'anglais'} par défaut, mais tu réponds toujours dans la langue de la question.`,
    '',
    'CE QUE TU ES',
    "Tu n'es pas un chatbot qui parle de la maison : tu la pilotes. Tu lis l'état réel, tu agis avec des outils, et tu dis ce que tu as fait. Une réponse qui décrit une action sans l'avoir faite est une erreur.",
    '',
    'BRIÈVETÉ - la règle qui prime sur les autres',
    "- Une phrase. Quinze mots quand c'est possible. Jamais de préambule, jamais de reformulation, jamais de récapitulatif.",
    "- Une valeur se donne nue : 19,5 °C dans le salon. Pas de préambule du genre j'ai vérifié, la température actuelle du salon est de.",
    '- Si tout va bien, dis-le en trois mots.',
    '- Pas de liste à puces sauf si on demande une liste. Pas de markdown : ces réponses sont lues à voix haute.',
    '- Jamais de lignes du genre "clé: valeur" recopiées d un outil. Les résumés des outils sont pour toi, pas pour la personne.',
    "- Ne décris jamais une carte que tu viens d'afficher. Elle est à l'écran. Dis le chiffre qui compte, rien de plus.",
    "- Mets en valeur chaque valeur ou appareil important avec une puce : [[ph:icone|texte]] ou [[ph:icone|texte|ton]]. Tons : ok, warn, alert. Icônes : lightning (conso), thermometer-simple, drop (humidité, fuite), lightbulb, lock-simple, lock-simple-open, door-open, wifi-high, warning, fire, sun, wind, battery-medium, house-line. Exemple : On consomme [[ph:lightning|4,4 W]], il fait [[ph:thermometer-simple|20,4 °C]] au salon. Trois puces maximum par phrase.",
    '',
    'RÈGLES',
    "- Agis, puis explique en une phrase. Pas de préambule, pas de reformulation de la demande.",
    "- Une question sur une évolution, une moyenne, un maximum, une tendance ou un mois écoulé appelle `analyse_history`. Une question qui oppose deux pièces ou deux appareils appelle `compare_history`. Ne raconte jamais des chiffres d'historique en prose : montre la courbe.",
    "- Une question de classement (quelle pièce ou quel appareil consomme le plus, où fait-il le plus chaud, la pièce la plus humide) appelle `rank` : hours 0 pour maintenant, une période sinon. Une question de facture ou de kWh sur une période appelle `get_energy`.",
    "- Quand un outil renvoie déjà une phrase avec des puces, reprends-la telle quelle : elle est faite pour être lue et dite.",
    "- Une question sur une valeur ponctuelle appelle `show_widget` : la carte répond à l'oeil, ta phrase répond à l'oreille.",
    '- Une carte affichée avec `show_widget` disparaît avec la conversation. `create_widget` ne sert que si on demande de la garder sur le tableau de bord.',
    "- Quand une demande est ambiguë sur l'appareil, choisis le plus probable d'après la pièce et l'historique, agis, et dis lequel tu as choisi. Ne pose une question que si deux choix sont vraiment équivalents, et pose-la avec `ask_user` (deux à six options courtes), jamais en texte libre.",
    '- Avant de répondre à une question sur la maison, appelle un outil de lecture. Ne devine jamais un état.',
    "- Une action refusée pour cause d'autonomie devient une proposition. Dis-le simplement, sans t'excuser.",
    "- Les serrures, les caméras, les alarmes et tout appareil marqué critique demandent toujours une confirmation humaine, quel que soit le niveau d'autonomie.",
    '- Si tu apprends une préférence ou une habitude, mémorise-la avec `remember`.',
    '- Les nombres gardent leur unité. Les heures sont locales.',
    "- Jamais de tiret long dans tes réponses : utilise un tiret simple ou un point.",
    '',
    `NIVEAU D'AUTONOMIE : ${autonomy} (${AUTONOMY[autonomy].description})`,
    '',
    'CE QUE TU FAIS DE TOI-MÊME',
    autonomyLines(),
    "- Une question sur ce que tu fais de toi-même, de proactif ou sans qu'on te le demande appelle `get_autonomy` : réponds avec sa phrase.",
    "- Tu n'appelles `set_autonomy` que si la personne demande explicitement que tu agisses plus ou moins seul.",
    unattended ? "Tu tournes sans personne devant l'écran : pas de question, agis ou abstiens-toi." : '',
    '',
    `MAISON : mode ${snapshot.mode}, ${snapshot.counts.total} appareils, ${snapshot.power.total} W instantanés.`,
    `PIÈCES : ${areas.map((area) => area.name).join(', ')}`,
    '',
    'APPAREILS (id court, nom, pièce, catégorie, capacités)',
    deviceLines.join('\n'),
    deviceLines.length >= 150 ? `... et ${snapshot.devices.length - 150} autres. Utilise list_devices pour filtrer.` : '',
    '',
    'CAPACITÉS ET COMMANDES DISPONIBLES',
    capabilityCatalogueForPrompt(deviceRepository.capabilitiesInUse()),
    '',
    facts.length > 0 ? `CE QUE TU SAIS DÉJÀ\n${facts.map((memory) => `- ${memory.content}`).join('\n')}` : '',
    '',
    snapshot.openAlerts.length > 0 ? `ALERTES OUVERTES\n${snapshot.openAlerts.map((alert) => `- ${alert.title}`).join('\n')}` : '',
    '',
    `Heure locale : ${new Date().toLocaleString('fr-FR')}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

// ---------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------

class AgentService {
  /** Ask the agent something, from the chat or from voice. */
  async ask(input: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const conversationId = conversations.ensure(options.conversationId)
    const correlationId = options.correlationId ?? randomUUID()
    const started = performance.now()
    const config = agentSettings()

    const userMessage = messages.append({
      conversationId,
      role: 'user',
      content: input,
      attachments: [],
      toolCalls: [],
      toolCallId: null,
      usage: null,
    })
    options.onStep?.({ kind: 'message', message: userMessage })
    bus.publish('agent.message', { subjectType: 'agent', subjectId: conversationId, origin: 'user', correlationId, payload: { role: 'user', content: input } })

    // Name the conversation from its first line, so the sidebar is readable.
    const history = messages.forConversation(conversationId, 40)
    if (history.filter((message) => message.role === 'user').length === 1) {
      conversations.rename(conversationId, input.slice(0, 60))
    }

    // An answer to a question the parser asked runs the command that was waiting for it.
    if (options.answers) {
      const resumed = this.#resume(conversationId, userMessage.id, options.answers)
      if (resumed) {
        const result = await this.#runIntent(resumed, { conversationId, correlationId, options, started })
        if (result) return result
      }
    }

    // A model picked for this question runs this question, or the answer says why it cannot.
    // Quietly falling back to another model would answer with something nobody chose.
    let provider: ModelProvider | null
    if (options.provider) {
      provider = options.provider
    } else if (options.model) {
      const chosen = providerForChoice(options.model)
      if (chosen.error) {
        const name = options.model.includes(':') ? options.model.slice(options.model.indexOf(':') + 1) : options.model
        const reply = `${name} n'est pas disponible : ${chosen.error}.`
        const message = messages.append({ conversationId, role: 'assistant', content: reply, attachments: [], toolCalls: [], toolCallId: null, usage: null })
        options.onStep?.({ kind: 'message', message })
        return {
          ok: false,
          reply,
          conversationId,
          attachments: [],
          steps: 0,
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: Math.round(performance.now() - started) },
          usedFallback: false,
          proposalIds: [],
          error: 'model_unavailable',
        }
      }
      provider = chosen.provider
    } else {
      provider = currentProvider()
    }

    // The fast path: an unambiguous command never needs a model.
    const intent = parseIntent(input)
    if (intent && (intent.confidence >= 0.85 || !provider)) {
      const result = await this.#runIntent(intent, { conversationId, correlationId, options, started })
      if (result) return result
    }

    if (!provider) {
      const reply =
        options.model === OFFLINE
          ? "Je n'ai pas compris. Le moteur local ne comprend que les commandes simples : choisis un modèle pour aller plus loin."
          : 'Je n ai pas compris, et aucun modèle n est configuré pour aller plus loin. Va dans Réglages > Assistant pour brancher un modèle local (Ollama) ou une clé API.'
      const message = messages.append({ conversationId, role: 'assistant', content: reply, attachments: [], toolCalls: [], toolCallId: null, usage: null })
      options.onStep?.({ kind: 'message', message })
      return {
        ok: false,
        reply,
        conversationId,
        attachments: [],
        steps: 0,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: Math.round(performance.now() - started) },
        usedFallback: true,
        proposalIds: [],
        error: 'no_provider',
      }
    }

    // Budget guard: a runaway autonomous loop must not be able to spend the month overnight.
    if (!provider.local && spentToday() >= config.llm.dailyBudgetUsd) {
      const reply = `Budget quotidien atteint (${config.llm.dailyBudgetUsd} USD). Augmente-le dans les réglages ou passe sur un modèle local.`
      const message = messages.append({ conversationId, role: 'assistant', content: reply, attachments: [], toolCalls: [], toolCallId: null, usage: null })
      options.onStep?.({ kind: 'message', message })
      return {
        ok: false,
        reply,
        conversationId,
        attachments: [],
        steps: 0,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 },
        usedFallback: false,
        proposalIds: [],
        error: 'budget_exceeded',
      }
    }

    return this.#runModel(input, provider, { conversationId, correlationId, options, started })
  }

  /** Run a goal with no human in the loop: used by `ask_agent` inside a routine. */
  async runGoal(goal: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    return this.ask(goal, { ...options, unattended: true, conversationId: options.conversationId })
  }

  /**
   * The command a pending question was waiting for, with its answer filled in. Only the
   * latest answer of the conversation can be answered, and only with one of its options:
   * a question answered once is closed, and a stale click never runs anything.
   */
  #resume(conversationId: string, userMessageId: string, answers: Record<string, string[] | string>): ReturnType<typeof resumeIntent> {
    const previous = messages
      .forConversation(conversationId, 4)
      .filter((message) => message.id !== userMessageId)
      .at(-1)
    if (previous?.role !== 'assistant' || !previous.pending || !previous.questions) return null

    const pending = previous.pending
    const question = previous.questions.find((candidate) => candidate.id === pending.questionId)
    const answer = answers[pending.questionId]
    const value = Array.isArray(answer) ? answer[0] : answer
    if (!question || !value || !question.options.some((option) => option.id === value)) return null

    return resumeIntent(pending, value)
  }

  async #runIntent(
    intent: NonNullable<ReturnType<typeof parseIntent>>,
    context: { conversationId: string; correlationId: string; options: AgentRunOptions; started: number }
  ): Promise<AgentRunResult | null> {
    const config = agentSettings()
    const toolContext: AgentToolContext = {
      conversationId: context.conversationId,
      correlationId: context.correlationId,
      autonomy: config.autonomy,
      unattended: context.options.unattended === true,
      userId: null,
      signal: context.options.signal ?? new AbortController().signal,
    }

    const tool = toolByName(intent.tool)
    if (!tool) return null

    const parsed = tool.parameters.safeParse(intent.args)
    if (!parsed.success) return null

    const callId = randomUUID()
    context.options.onStep?.({ kind: 'tool_call', id: callId, name: tool.name, args: intent.args, at: nowIso() })
    const toolStarted = performance.now()
    const result = await tool.execute(parsed.data, toolContext)
    const durationMs = Math.round(performance.now() - toolStarted)
    context.options.onStep?.({ kind: 'tool_result', id: callId, name: tool.name, summary: result.summary, ok: result.ok, durationMs })

    const proposalIds: string[] = []
    if (result.proposal) {
      const proposal = proposals.create({ ...result.proposal, ttlMinutes: 30 })
      proposalIds.push(proposal.id)
      bus.publish('agent.action_proposed', { subjectType: 'agent', subjectId: proposal.id, correlationId: context.correlationId, payload: { ...proposal } })
    }

    const reply = intent.reply ? intent.reply(result) : result.summary
    const trace: AgentTraceEntry[] = [{ kind: 'tool', id: callId, name: tool.name, args: intent.args, ok: result.ok, summary: result.summary, durationMs }]
    const message = messages.append({
      conversationId: context.conversationId,
      role: 'assistant',
      content: reply,
      attachments: result.attachments ?? [],
      toolCalls: [{ id: callId, name: tool.name, args: intent.args }],
      toolCallId: null,
      usage: { latencyMs: Math.round(performance.now() - context.started) },
      trace,
      sources: sourcesFromTrace(trace),
      actions: { undoIds: undo.forCorrelation(context.correlationId), proposalIds },
      ...(result.questions ? { questions: result.questions, ...(intent.resume ? { pending: intent.resume } : {}) } : {}),
    })
    context.options.onStep?.({ kind: 'message', message })

    bus.publish('agent.message', {
      subjectType: 'agent',
      subjectId: context.conversationId,
      origin: 'agent',
      correlationId: context.correlationId,
      payload: { role: 'assistant', content: reply, tool: tool.name, fallback: true },
    })

    return {
      ok: result.ok,
      reply,
      conversationId: context.conversationId,
      attachments: result.attachments ?? [],
      steps: 1,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: Math.round(performance.now() - context.started) },
      usedFallback: true,
      proposalIds,
    }
  }

  async #runModel(
    input: string,
    provider: ModelProvider,
    context: { conversationId: string; correlationId: string; options: AgentRunOptions; started: number }
  ): Promise<AgentRunResult> {
    const config = agentSettings()
    const toolContext: AgentToolContext = {
      conversationId: context.conversationId,
      correlationId: context.correlationId,
      autonomy: config.autonomy,
      unattended: context.options.unattended === true,
      userId: null,
      signal: context.options.signal ?? new AbortController().signal,
    }

    const history = messages
      .forConversation(context.conversationId, 30)
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-12)
      .map((message): ChatMessage => ({ role: message.role as 'user' | 'assistant', content: message.content }))

    // The transcript keeps what was typed; the model also reads which things were designated.
    const note = context.options.mentions?.length ? mentionNote(context.options.mentions) : null
    const chat: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(config.autonomy, context.options.unattended === true) },
      ...history.slice(0, -1),
      { role: 'user', content: note ? `${input}\n\n${note}` : input },
    ]

    // Observer never gets the acting tools at all. Removing them beats instructing the
    // model not to use them: a tool that is not in the list cannot be called.
    const available = config.autonomy === 'observer' ? AGENT_TOOLS.filter((tool) => tool.readOnly) : AGENT_TOOLS
    const schemas = toolSchemas().filter((schema) => available.some((tool) => tool.name === schema.name))

    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
    const attachments: AgentMessage['attachments'] = []
    const proposalIds: string[] = []
    const trace: AgentTraceEntry[] = []
    const toolCalls: AgentMessage['toolCalls'] = []
    const questions: NonNullable<AgentMessage['questions']> = []
    const maxSteps = Math.min(config.llm.maxSteps, context.options.maxActions ?? config.llm.maxSteps)
    const signal = context.options.signal

    let steps = 0
    let reply = ''
    let error: string | undefined
    let aborted = false
    let model = provider.defaultModel

    /** A tool call that closes as a failure without running: unknown tool, bad arguments. */
    const refuse = (call: { id: string; name: string; args: Record<string, unknown> }, summary: string) => {
      context.options.onStep?.({ kind: 'tool_result', id: call.id, name: call.name, summary, ok: false, durationMs: 0 })
      trace.push({ kind: 'tool', id: call.id, name: call.name, args: call.args, ok: false, summary, durationMs: 0 })
      chat.push({ role: 'tool', toolCallId: call.id, content: summary })
    }

    try {
      for (; steps < maxSteps; steps += 1) {
        if (signal?.aborted) {
          aborted = true
          break
        }

        const response = await provider.chat({
          messages: chat,
          tools: schemas,
          temperature: config.llm.temperature,
          signal,
        })

        usage.inputTokens += response.usage.inputTokens
        usage.outputTokens += response.usage.outputTokens
        usage.costUsd += response.usage.costUsd
        if (response.model) model = response.model

        if (response.toolCalls.length === 0) {
          reply = response.content
          break
        }

        // Text written next to tool calls is the model thinking aloud. The final answer is
        // not: it arrives as the message, and showing it twice made it look like reasoning.
        if (response.content) {
          const id = randomUUID()
          trace.push({ kind: 'reasoning', id, text: response.content })
          context.options.onStep?.({ kind: 'thinking', id, text: response.content })
        }

        chat.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls })

        for (const call of response.toolCalls) {
          // Someone who left does not get a tool run on their behalf. The call stays in the
          // trace, unanswered, so the transcript shows what was about to happen.
          if (signal?.aborted) {
            aborted = true
            trace.push({ kind: 'tool', id: call.id, name: call.name, args: call.args, ok: null, summary: INTERRUPTED_BEFORE_RUN, durationMs: 0 })
            continue
          }

          context.options.onStep?.({ kind: 'tool_call', id: call.id, name: call.name, args: call.args, at: nowIso() })
          bus.publish('agent.tool_call', { subjectType: 'agent', subjectId: context.conversationId, correlationId: context.correlationId, payload: { id: call.id, name: call.name, args: call.args } })

          const tool = available.find((candidate) => candidate.name === call.name)
          if (!tool) {
            refuse(call, `Outil inconnu : ${call.name}`)
            continue
          }

          const parsed = tool.parameters.safeParse(call.args)
          if (!parsed.success) {
            refuse(call, `Arguments invalides : ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
            continue
          }

          toolCalls.push({ id: call.id, name: call.name, args: call.args })
          const toolStarted = performance.now()
          let result: AgentToolResult
          try {
            result = await tool.execute(parsed.data, toolContext)
          } catch (toolError) {
            result = { ok: false, summary: `L'outil ${call.name} a échoué : ${(toolError as Error).message}` }
          }
          const durationMs = Math.round(performance.now() - toolStarted)

          context.options.onStep?.({ kind: 'tool_result', id: call.id, name: call.name, summary: result.summary, ok: result.ok, durationMs })
          bus.publish('agent.tool_result', { subjectType: 'agent', subjectId: context.conversationId, correlationId: context.correlationId, payload: { id: call.id, name: call.name, ok: result.ok, summary: result.summary, durationMs } })
          trace.push({ kind: 'tool', id: call.id, name: call.name, args: call.args, ok: result.ok, summary: result.summary, durationMs })

          if (result.attachments) attachments.push(...result.attachments)
          if (result.questions) questions.push(...result.questions)
          if (result.proposal) {
            const proposal = proposals.create({ ...result.proposal, ttlMinutes: 30 })
            proposalIds.push(proposal.id)
            attachments.push({ kind: 'proposal', data: { id: proposal.id } })
            bus.publish('agent.action_proposed', { subjectType: 'agent', subjectId: proposal.id, correlationId: context.correlationId, payload: { ...proposal } })
          }

          chat.push({ role: 'tool', toolCallId: call.id, content: result.summary })
        }

        if (aborted) break

        // A question ends the run: the answer is the person's next message, and a model that
        // kept going would answer its own question.
        if (questions.length > 0) {
          reply = response.content || questions.map((question) => question.title).join(' ')
          break
        }
      }

      if (!reply && !aborted && steps >= maxSteps) {
        reply = "J'ai atteint la limite d'étapes pour cette demande. Voilà où j'en suis : " + chat.filter((message) => message.role === 'tool').slice(-2).map((message) => message.content).join(' ')
      }
    } catch (runError) {
      if (isAbort(runError, signal)) {
        aborted = true
      } else {
        error = (runError as Error).message
        reply = `Le modèle a échoué : ${error}`
        context.options.onStep?.({ kind: 'error', message: error })
      }
    }

    if (aborted) {
      error = 'aborted'
      if (!reply) reply = trace.some((entry) => entry.kind === 'tool' && entry.ok !== null) ? "Interrompu. Ce qui est au-dessus a été fait." : 'Interrompu.'
    }

    const latencyMs = Math.round(performance.now() - context.started)

    const message = messages.append({
      conversationId: context.conversationId,
      role: 'assistant',
      content: reply,
      attachments,
      toolCalls,
      toolCallId: null,
      usage: { ...usage, latencyMs },
      trace,
      sources: sourcesFromTrace(trace),
      context: contextFor(input, trace),
      actions: { undoIds: undo.forCorrelation(context.correlationId), proposalIds },
      model: { provider: provider.id, model },
      ...(questions.length > 0 ? { questions } : {}),
      ...(aborted ? { interrupted: true } : {}),
    })
    context.options.onStep?.({ kind: 'message', message })

    insertInto('agent_runs', {
      id: randomUUID(),
      conversation_id: context.conversationId,
      goal: input.slice(0, 500),
      trigger: context.options.unattended ? 'routine' : 'chat',
      steps,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: usage.costUsd,
      latency_ms: latencyMs,
      provider: provider.id,
      model,
      status: aborted ? 'aborted' : error ? 'error' : 'ok',
      error: error ?? null,
      created_at: nowIso(),
    })

    bus.publish('agent.message', {
      subjectType: 'agent',
      subjectId: context.conversationId,
      origin: 'agent',
      correlationId: context.correlationId,
      payload: { role: 'assistant', content: reply, steps, costUsd: usage.costUsd, provider: provider.id },
    })

    return {
      ok: error === undefined,
      reply,
      conversationId: context.conversationId,
      attachments,
      steps,
      usage: { ...usage, latencyMs },
      usedFallback: false,
      proposalIds,
      error,
    }
  }

  /**
   * Approve a proposal and run its commands - all of them, or only the rows kept in the
   * review (`include`, by index). A selection that keeps nothing runs nothing and leaves the
   * proposal open. Each row left out is remembered, so it is not proposed again tomorrow.
   */
  async approveProposal(proposalId: string, options: { include?: number[] } = {}): Promise<{ ok: boolean; ran: number }> {
    const proposal = proposals.find(proposalId)
    if (!proposal || proposal.status !== 'pending') return { ok: false, ran: 0 }

    const kept = options.include
      ? proposal.commands.filter((_command, index) => options.include!.includes(index))
      : proposal.commands
    if (kept.length === 0) return { ok: false, ran: 0 }

    for (const left of proposal.commands.filter((command) => !kept.includes(command))) {
      memories.remember({ kind: 'correction', content: `Exclu d'une proposition : ${left.command} sur ${left.deviceName}`, source: 'observed', confidence: 0.6 })
    }

    const correlationId = randomUUID()
    let ran = 0
    for (const command of kept) {
      const result = await houseService.execute(command.deviceId, command.command, command.args, {
        origin: 'agent',
        originDetail: 'proposition validée',
        correlationId,
      })
      if (result.ok) ran += 1
    }

    proposals.decide(proposalId, ran > 0 ? 'executed' : 'failed')
    bus.publish('agent.action_approved', { subjectType: 'agent', subjectId: proposalId, origin: 'user', correlationId, payload: { summary: proposal.summary, ran } })
    return { ok: ran > 0, ran }
  }

  rejectProposal(proposalId: string): boolean {
    const proposal = proposals.find(proposalId)
    if (!proposal || proposal.status !== 'pending') return false
    proposals.decide(proposalId, 'rejected')
    bus.publish('agent.action_rejected', { subjectType: 'agent', subjectId: proposalId, origin: 'user', payload: { summary: proposal.summary } })

    // A rejection is information: remember it so the same thing is not proposed weekly.
    memories.remember({ kind: 'correction', content: `Proposition refusée : ${proposal.summary}`, source: 'observed', confidence: 0.8 })
    return true
  }

  /**
   * Work on a selected passage. With a model: one call, no tools, within the daily budget.
   * Without: shortening and explaining the devices named still work; the rest needs a model.
   */
  async rewrite(text: string, action: RewriteAction, options: { provider?: ModelProvider; prompt?: string } = {}): Promise<RewriteResult> {
    const provider = options.provider ?? currentProvider()
    if (!provider) {
      if (action === 'shorten') return { ok: true, text: shortenOffline(text) }
      if (action === 'explain') {
        const explained = explainOffline(text)
        return explained ? { ok: true, text: explained } : { ok: false, error: `Ce passage ne nomme aucun appareil de la maison. ${NEEDS_MODEL}` }
      }
      return { ok: false, error: NEEDS_MODEL }
    }

    const config = agentSettings()
    if (!provider.local && spentToday() >= config.llm.dailyBudgetUsd) {
      return { ok: false, error: `Budget quotidien atteint (${config.llm.dailyBudgetUsd} USD).` }
    }

    const started = performance.now()
    try {
      const result = await rewriteWithModel(provider, text, action, options.prompt)
      insertInto('agent_runs', {
        id: randomUUID(),
        conversation_id: null,
        goal: `rewrite:${action}`,
        trigger: 'rewrite',
        steps: 1,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        cost_usd: result.usage.costUsd,
        latency_ms: Math.round(performance.now() - started),
        provider: provider.id,
        model: provider.defaultModel,
        status: 'ok',
        error: null,
        created_at: nowIso(),
      })
      return result.text ? { ok: true, text: result.text } : { ok: false, error: "Le modèle n'a rien renvoyé." }
    } catch (error) {
      return { ok: false, error: `Le modèle a échoué : ${(error as Error).message}` }
    }
  }

  /** Thumbs up or down on an answer; null takes the rating back. Only answers are rated. */
  feedback(messageId: string, value: 'up' | 'down' | null): AgentMessage | null {
    const message = messages.find(messageId)
    if (!message || message.role !== 'assistant') return null
    const updated = messages.patchMeta(messageId, { feedback: value })
    bus.publish('agent.feedback', { subjectType: 'agent', subjectId: message.conversationId, origin: 'user', payload: { messageId, value } })
    return updated
  }

  setAutonomy(level: AutonomyLevel): void {
    const previous = agentSettings().autonomy
    settings.patch('agent', { autonomy: level })
    bus.publish('agent.autonomy_changed', { subjectType: 'agent', origin: 'user', payload: { level, previous } })
  }

  /** What the settings screen needs to render itself honestly. */
  status(): {
    provider: string
    model: string
    ready: boolean
    local: boolean
    autonomy: AutonomyLevel
    spentTodayUsd: number
    budgetUsd: number
    toolCount: number
    fallbackOnly: boolean
  } {
    const config = agentSettings()
    const provider = currentProvider()
    return {
      provider: config.llm.provider,
      model: config.llm.model || provider?.defaultModel || '',
      ready: provider !== null,
      local: provider?.local ?? false,
      autonomy: config.autonomy,
      spentTodayUsd: Number(spentToday().toFixed(4)),
      budgetUsd: config.llm.dailyBudgetUsd,
      toolCount: AGENT_TOOLS.length,
      fallbackOnly: provider === null,
    }
  }

  /** Round-trip a provider before saving it, so a bad key fails in the settings screen. */
  async testProvider(config: { provider: string; model?: string; apiKey?: string; baseUrl?: string }): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const provider = buildProvider(config)
    if (!provider) return { ok: false, message: 'Configuration incomplète pour ce fournisseur.', latencyMs: 0 }

    const started = performance.now()
    try {
      const response = await provider.chat({
        messages: [{ role: 'user', content: 'Réponds exactement: OK' }],
        temperature: 0,
        maxTokens: 16,
      })
      return {
        ok: response.content.length > 0,
        message: `${provider.label} a répondu : ${response.content.slice(0, 60)}`,
        latencyMs: Math.round(performance.now() - started),
      }
    } catch (error) {
      return { ok: false, message: (error as Error).message, latencyMs: Math.round(performance.now() - started) }
    }
  }
}

export const agentService = new AgentService()
export { resolveDevice }
