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
  type AutonomyLevel,
} from '@sway-home/shared'
import { buildProvider, type ChatMessage, type ModelProvider } from '#agent/providers'
import { AGENT_TOOLS, toolByName, toolSchemas, resolveDevice } from '#agent/tools'
import { parseIntent } from '#agent/intent_parser'
import { autonomyEngine } from '#services/autonomy_engine'
import { bus } from '#services/event_bus'
import { houseService } from '#services/house'
import { database, insertInto, nowIso } from '#db/database'
import { conversations, memories, messages, places, proposals, settings } from '#repositories/store'
import { deviceRepository } from '#repositories/device_repository'

export interface AgentRunOptions {
  conversationId?: string
  correlationId?: string
  unattended?: boolean
  maxActions?: number
  signal?: AbortSignal
  /** Streams each step to the caller, so the UI can show thinking rather than a spinner. */
  onStep?: (step: AgentStep) => void
}

export type AgentStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; name: string; args: Record<string, unknown> }
  | { kind: 'tool_result'; name: string; summary: string; ok: boolean }
  | { kind: 'message'; message: AgentMessage }
  | { kind: 'error'; message: string }

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
    "- Quand une demande est ambiguë sur l'appareil, choisis le plus probable d'après la pièce et l'historique, agis, et dis lequel tu as choisi. Ne pose une question que si deux choix sont vraiment équivalents.",
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

    const provider = currentProvider()

    // The fast path: an unambiguous command never needs a model.
    const intent = parseIntent(input)
    if (intent && (intent.confidence >= 0.85 || !provider)) {
      const result = await this.#runIntent(intent, { conversationId, correlationId, options, started })
      if (result) return result
    }

    if (!provider) {
      const reply = 'Je n ai pas compris, et aucun modèle n est configuré pour aller plus loin. Va dans Réglages > Assistant pour brancher un modèle local (Ollama) ou une clé API.'
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
      messages.append({ conversationId, role: 'assistant', content: reply, attachments: [], toolCalls: [], toolCallId: null, usage: null })
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

    context.options.onStep?.({ kind: 'tool_call', name: tool.name, args: intent.args })
    const result = await tool.execute(parsed.data, toolContext)
    context.options.onStep?.({ kind: 'tool_result', name: tool.name, summary: result.summary, ok: result.ok })

    const proposalIds: string[] = []
    if (result.proposal) {
      const proposal = proposals.create({ ...result.proposal, ttlMinutes: 30 })
      proposalIds.push(proposal.id)
      bus.publish('agent.action_proposed', { subjectType: 'agent', subjectId: proposal.id, correlationId: context.correlationId, payload: { ...proposal } })
    }

    const reply = intent.reply ? intent.reply(result) : result.summary
    const message = messages.append({
      conversationId: context.conversationId,
      role: 'assistant',
      content: reply,
      attachments: result.attachments ?? [],
      toolCalls: [{ id: randomUUID(), name: tool.name, args: intent.args }],
      toolCallId: null,
      usage: { latencyMs: Math.round(performance.now() - context.started) },
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

    const chat: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(config.autonomy, context.options.unattended === true) },
      ...history.slice(0, -1),
      { role: 'user', content: input },
    ]

    // Observer never gets the acting tools at all. Removing them beats instructing the
    // model not to use them: a tool that is not in the list cannot be called.
    const available = config.autonomy === 'observer' ? AGENT_TOOLS.filter((tool) => tool.readOnly) : AGENT_TOOLS
    const schemas = toolSchemas().filter((schema) => available.some((tool) => tool.name === schema.name))

    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
    const attachments: AgentMessage['attachments'] = []
    const proposalIds: string[] = []
    const undoStack: { deviceId: string; command: string; args: Record<string, unknown> }[] = []
    const maxSteps = Math.min(config.llm.maxSteps, context.options.maxActions ?? config.llm.maxSteps)

    let steps = 0
    let reply = ''
    let error: string | undefined

    try {
      for (; steps < maxSteps; steps += 1) {
        const response = await provider.chat({
          messages: chat,
          tools: schemas,
          temperature: config.llm.temperature,
          signal: context.options.signal,
        })

        usage.inputTokens += response.usage.inputTokens
        usage.outputTokens += response.usage.outputTokens
        usage.costUsd += response.usage.costUsd

        if (response.content) context.options.onStep?.({ kind: 'thinking', text: response.content })

        if (response.toolCalls.length === 0) {
          reply = response.content
          break
        }

        chat.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls })

        for (const call of response.toolCalls) {
          context.options.onStep?.({ kind: 'tool_call', name: call.name, args: call.args })
          bus.publish('agent.tool_call', { subjectType: 'agent', subjectId: context.conversationId, correlationId: context.correlationId, payload: { name: call.name, args: call.args } })

          const tool = available.find((candidate) => candidate.name === call.name)
          if (!tool) {
            chat.push({ role: 'tool', toolCallId: call.id, content: `Outil inconnu: ${call.name}` })
            continue
          }

          const parsed = tool.parameters.safeParse(call.args)
          if (!parsed.success) {
            chat.push({ role: 'tool', toolCallId: call.id, content: `Arguments invalides: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}` })
            continue
          }

          let result
          try {
            result = await tool.execute(parsed.data, toolContext)
          } catch (toolError) {
            result = { ok: false, summary: `L outil ${call.name} a échoué : ${(toolError as Error).message}` }
          }

          context.options.onStep?.({ kind: 'tool_result', name: call.name, summary: result.summary, ok: result.ok })
          bus.publish('agent.tool_result', { subjectType: 'agent', subjectId: context.conversationId, correlationId: context.correlationId, payload: { name: call.name, ok: result.ok, summary: result.summary } })

          if (result.attachments) attachments.push(...result.attachments)
          if (result.undo) undoStack.push(...result.undo)
          if (result.proposal) {
            const proposal = proposals.create({ ...result.proposal, ttlMinutes: 30 })
            proposalIds.push(proposal.id)
            attachments.push({ kind: 'proposal', data: { id: proposal.id } })
            bus.publish('agent.action_proposed', { subjectType: 'agent', subjectId: proposal.id, correlationId: context.correlationId, payload: { ...proposal } })
          }

          chat.push({ role: 'tool', toolCallId: call.id, content: result.summary })
        }
      }

      if (!reply && steps >= maxSteps) {
        reply = "J'ai atteint la limite d'étapes pour cette demande. Voilà où j'en suis : " + chat.filter((message) => message.role === 'tool').slice(-2).map((message) => message.content).join(' ')
      }
    } catch (runError) {
      error = (runError as Error).message
      reply = `Le modèle a échoué : ${error}`
      context.options.onStep?.({ kind: 'error', message: error })
    }

    const latencyMs = Math.round(performance.now() - context.started)

    const message = messages.append({
      conversationId: context.conversationId,
      role: 'assistant',
      content: reply,
      attachments,
      toolCalls: [],
      toolCallId: null,
      usage: { ...usage, latencyMs },
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
      model: provider.defaultModel,
      status: error ? 'error' : 'ok',
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

  /** Approve a proposal and run its commands. */
  async approveProposal(proposalId: string): Promise<{ ok: boolean; ran: number }> {
    const proposal = proposals.find(proposalId)
    if (!proposal || proposal.status !== 'pending') return { ok: false, ran: 0 }

    const correlationId = randomUUID()
    let ran = 0
    for (const command of proposal.commands) {
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
