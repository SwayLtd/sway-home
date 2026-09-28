<script setup lang="ts">
/**
 * The assistant.
 *
 * Two things make this feel different from a chat box bolted onto a dashboard:
 *
 *  - **Steps are shown as they happen.** The run streams over SSE, so the tool calls appear
 *    while the model is still working. A house agent that acts has to show its hands: the
 *    loader until the first step, the Thinking trace while it works, then the same steps
 *    folded into ToolChips above the answer, kept with it for good.
 *  - **Attachments are live controls.** When the agent says it turned the living room on,
 *    the reply carries the actual device cards, with working switches. A question comes back
 *    as choices (ApprovalCard), a proposal as rows to keep or drop (ProposalReview), a routine
 *    it wrote as a recommendation with its alternatives. The answer is the interface.
 *
 * The answer itself resolves word by word (StreamingText), cites the devices it read where it
 * names them, and shows the memories it had in mind (ContextCards). Selecting a passage of
 * the conversation offers to explain, shorten, rephrase or translate it (SelectionActions).
 * The composer is the kit's PromptBar: @ to designate a device, / for a command, the model
 * picker, dictation, and stop while a run is in flight. In the dock the same conversation
 * sits in the kit's Chat frame, with a second tab listing the steps of the last run.
 */

import { createReusableTemplate } from '@vueuse/core'
import type { AgentContextItem, AgentQuestion, AgentSource, AgentTraceEntry } from '@sway-home/shared/agent'

const props = defineProps<{
  /** Narrow column, for the right-hand dock. */
  compact?: boolean
  /**
   * Full screen, centred, empty until spoken to. This is the default view of the console:
   * you talk to the house, and the house answers with cards.
   */
  hero?: boolean
}>()

interface Attachment {
  kind: string
  data: Record<string, any>
}

type ActionState = 'pending' | 'undone' | 'approved' | 'rejected' | 'failed'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  attachments: Attachment[]
  createdAt: string
  usage?: { costUsd?: number; latencyMs?: number } | null
  trace?: AgentTraceEntry[]
  sources?: AgentSource[]
  context?: AgentContextItem[]
  questions?: AgentQuestion[]
  /** What the run did and proposed: the handles to take it back or to say yes. */
  actions?: { undoIds: string[]; proposalIds: string[] }
  feedback?: 'up' | 'down' | null
  model?: { provider: string; model: string }
  interrupted?: boolean
  /** Set on a message the house raised by itself, so an alert reads like one. */
  severity?: string
  /** Written by the console, not kept by the hub: the result of a / command. */
  local?: boolean
}

interface SlashCommand {
  id: string
  label: string
  hint: string
  icon: string
  run: { kind: 'prompt'; text: string } | { kind: 'action'; action: 'new_conversation' | 'undo' | 'scan' } | { kind: 'scene'; id: string } | { kind: 'routine'; id: string }
}

interface ModelChoice {
  id: string
  label: string
  hint: string
  group: string
  available: boolean
  reason?: string
  current: boolean
}

const { deviceById, devices, areas, areaById, refresh } = useHouse()
const { preferences } = useAiPreferences()
const { dockTool } = useShell()
const conversationId = useState<string | null>('agent-conversation', () => null)
const messages = useState<Message[]>('agent-messages', () => [])
/** A question another screen wants asked here (an insight card's "Demander"). */
const pendingDraft = useState<string>('agent-draft', () => '')

const liveSteps = ref<AgentLiveStep[]>([])
const input = ref('')
const running = ref(false)
const runStartedAt = ref(Date.now())
const status = ref<{ ready: boolean; provider: string; model: string; fallbackOnly: boolean; autonomy: string; local: boolean } | null>(null)
const anchor = ref<HTMLElement | null>(null)
let runController: AbortController | null = null

/** Answers that arrived while this page was open play their reveal; history renders settled. */
const fresh = ref(new Set<string>())
const actionStates = ref<Record<string, ActionState>>({})
/** Question cards closed by hand: the assistant still waits, but the card is out of the way. */
const closedQuestions = ref(new Set<string>())

const nameOf = (id: string) => deviceById.value.get(id)?.name

/**
 * Deliberately not "Comment va la maison ?" alone. The examples are the documentation: they
 * are what tells someone the assistant will draw a month of humidity if asked, which is not
 * a thing anyone guesses about a chat box.
 */
const SUGGESTIONS: { text: string; icon: string }[] = [
  { text: 'Comment va la maison ?', icon: 'ph:house-line' },
  { text: "Analyse la courbe d'humidité du dernier mois", icon: 'ph:chart-line' },
  { text: 'Compare la température du salon et de la chambre', icon: 'ph:arrows-left-right' },
  { text: 'Éteins tout', icon: 'ph:power' },
  { text: 'Il fait combien dans la chambre ?', icon: 'ph:thermometer-simple' },
  { text: 'Quelle pièce consomme le plus ?', icon: 'ph:ranking' },
  { text: 'Y a-t-il des alertes ?', icon: 'ph:warning' },
  { text: "Qu'as-tu fait de toi-même aujourd'hui ?", icon: 'ph:sparkle' },
  { text: 'Quels appareils sont hors ligne ?', icon: 'ph:plugs' },
  { text: 'Propose-moi des routines', icon: 'ph:lightbulb' },
  { text: 'Qui est à la maison ?', icon: 'ph:users' },
  { text: 'Où fait-il le plus froid ?', icon: 'ph:thermometer-cold' },
]

/**
 * Three at a time, like the kit's own harness: a short list reads as an invitation, twelve
 * rows read as a manual. "Autres suggestions" turns the page.
 */
const SUGGESTIONS_SHOWN = 3
const suggestionPage = ref(0)
const shownSuggestions = computed(() => {
  const start = (suggestionPage.value * SUGGESTIONS_SHOWN) % SUGGESTIONS.length
  return [...SUGGESTIONS, ...SUGGESTIONS].slice(start, start + SUGGESTIONS_SHOWN)
})

/** "Bonjour" until the evening. */
const greeting = computed(() => (new Date().getHours() >= 18 || new Date().getHours() < 5 ? 'Bonsoir' : 'Bonjour'))

async function loadStatus() {
  status.value = await hubFetch('/agent/status')
}

/**
 * What to ask next, under the last answer. The hub picks them from the question just asked
 * and the house (the other room, the week after the month, "Annule" after a switch-off),
 * and every one is a sentence the offline parser answers at once.
 */
const followUps = ref<{ text: string; icon: string }[]>([])

async function loadFollowUps() {
  const last = messages.value.at(-1)
  const params = new URLSearchParams()
  if (conversationId.value) params.set('conversationId', conversationId.value)
  if (last?.id.startsWith('announce-')) params.set('after', 'reflex')
  followUps.value = (await hubFetch<{ suggestions: { text: string; icon: string }[] }>(`/agent/suggestions?${params}`).catch(() => ({ suggestions: [] }))).suggestions
}

// --- The composer's menus: models, commands, mentions -----------------------------------

const models = ref<ModelChoice[]>([])
const selectedModel = ref<PromptBarModel | null>(null)
/** Only a model someone picked is sent: otherwise the hub uses the one in the settings. */
const modelTouched = ref(false)
const commands = ref<SlashCommand[]>([])
const scenes = ref<{ id: string; name: string }[]>([])
const routines = ref<{ id: string; name: string; status: string }[]>([])

const modelOptions = computed<PromptBarModel[]>(() =>
  models.value.map((choice) => ({
    id: choice.id,
    label: choice.label,
    hint: choice.available ? choice.hint : (choice.reason ?? 'Indisponible'),
    group: choice.group,
    disabled: !choice.available,
  }))
)

const commandOptions = computed<PromptBarCommand[]>(() => commands.value.map((command) => ({ id: command.id, label: command.label, hint: command.hint, icon: command.icon })))

const mentionOptions = computed<PromptBarMention[]>(() => [
  ...devices.value
    .filter((device) => !device.hidden)
    .map((device) => ({
      id: device.id,
      label: device.name,
      kind: 'device' as const,
      icon: CATEGORY_ICON[device.category as keyof typeof CATEGORY_ICON],
      hint: (device.areaId && areaById.value.get(device.areaId)?.name) || undefined,
    })),
  ...areas.value.map((area) => ({ id: area.id, label: area.name, kind: 'area' as const, hint: 'Pièce' })),
  ...scenes.value.map((scene) => ({ id: scene.id, label: scene.name, kind: 'scene' as const, hint: 'Scène' })),
  ...routines.value.filter((routine) => routine.status === 'active').map((routine) => ({ id: routine.id, label: routine.name, kind: 'routine' as const, hint: 'Routine' })),
])

watch(selectedModel, (next, previous) => {
  if (previous !== null && next?.id !== previous?.id) modelTouched.value = true
})

async function loadComposer() {
  const [modelList, commandList, sceneList, routineList] = await Promise.all([
    hubFetch<{ models: ModelChoice[] }>('/agent/models').catch(() => ({ models: [] })),
    hubFetch<{ commands: SlashCommand[] }>('/agent/commands').catch(() => ({ commands: [] })),
    hubFetch<{ scenes: { id: string; name: string }[] }>('/scenes').catch(() => ({ scenes: [] })),
    hubFetch<{ routines: { id: string; name: string; status: string }[] }>('/routines').catch(() => ({ routines: [] })),
  ])
  models.value = modelList.models
  commands.value = commandList.commands
  scenes.value = sceneList.scenes
  routines.value = routineList.routines
  if (!modelTouched.value) {
    const current = modelList.models.find((choice) => choice.current) ?? modelList.models.find((choice) => choice.available)
    selectedModel.value = modelOptions.value.find((option) => option.id === current?.id) ?? null
  }
}

// --- Voice ---------------------------------------------------------------------------------

/**
 * The microphone.
 *
 * When the hub has an OpenAI key and is not in local-only mode, the button opens a GPT-Live
 * call: full duplex, interruptible, and the house answers through the same agent and the
 * same tools as the text path. That is the default whenever it is available. Otherwise the
 * button dictates into the composer with the local recogniser, and closes the microphone by
 * itself after thirty seconds: a microphone left open in a home by accident is the one
 * thing a privacy-first product must never do.
 */
const live = useLiveVoice()
const voiceSettings = useVoiceSettings()
const recogniser = useRecogniser(voiceSettings)
const DICTATION_LIMIT_MS = 30_000
let dictationTimer: ReturnType<typeof setTimeout> | null = null

const dictation = computed<PromptBarDictationState>(() => {
  if (live.status.value?.available) return live.state.value === 'live' || live.state.value === 'connecting' ? 'listening' : 'idle'
  if (voiceSettings.value.engine === 'off') return 'unavailable'
  return recogniser.listening.value ? 'listening' : 'idle'
})

function onDictate() {
  if (live.status.value?.available) {
    toggleLive()
    return
  }
  if (recogniser.listening.value) {
    recogniser.stop()
    return
  }
  void recogniser.start()
  if (dictationTimer) clearTimeout(dictationTimer)
  dictationTimer = setTimeout(() => recogniser.stop(), DICTATION_LIMIT_MS)
}

watch(recogniser.listening, (listening, was) => {
  if (!was || listening) return
  if (dictationTimer) clearTimeout(dictationTimer)
  const text = recogniser.partial.value.trim()
  if (text) input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text
})

function onLiveReply(reply: { text: string; attachments: { kind: string; data: Record<string, any> }[] }) {
  // A spoken answer still belongs in the transcript: the card it carries is the whole point.
  const id = `live-${Date.now()}`
  fresh.value.add(id)
  messages.value = [...messages.value, { id, role: 'assistant', content: reply.text, attachments: reply.attachments, createdAt: new Date().toISOString() }]
  void refresh()
  void loadFollowUps()
  scrollToEnd()
}

/** A spoken sentence lands in the conversation the moment a pause ends it. */
function onLiveUtterance(text: string) {
  messages.value = [...messages.value, { id: `live-user-${Date.now()}`, role: 'user', content: text, attachments: [], createdAt: new Date().toISOString() }]
  scrollToEnd()
}

function toggleLive() {
  if (live.state.value === 'live' || live.state.value === 'connecting') live.stop()
  else void live.start({ onUtterance: onLiveUtterance, onReply: onLiveReply })
}

onBeforeUnmount(() => {
  if (live.state.value === 'live') live.stop()
  if (dictationTimer) clearTimeout(dictationTimer)
  runController?.abort()
})

async function loadConversation() {
  if (!conversationId.value) return
  messages.value = (await hubFetch<{ messages: Message[] }>(`/agent/conversations/${conversationId.value}`)).messages
}

// --- What the house says on its own ------------------------------------------------------

/**
 * A leak, smoke, a flat battery: these arrive from the narrator, not from a question, and
 * they belong *in* the conversation. A banner pinned above the chat saying the same thing
 * would be the assistant admitting it is only a chat box - the whole point is that it speaks
 * to you.
 *
 * Showing one acknowledges it: at that moment the assistant has said it, which is exactly
 * what `acknowledged` means. Leaving them pending instead would replay every past alert at
 * the top of every new session.
 */
const { items: announcements, acknowledge, load: loadAnnouncements } = useAnnouncements()

const SEVERITY_ICON: Record<string, string> = {
  critical: 'ph:warning-octagon-fill',
  warning: 'ph:warning-fill',
  notice: 'ph:info',
  info: 'ph:sparkle-fill',
}

function announce(items: Announcement[]): void {
  const fresher = items.filter((item) => !messages.value.some((message) => message.id === `announce-${item.id}`))
  if (fresher.length === 0) return

  for (const item of fresher) fresh.value.add(`announce-${item.id}`)
  messages.value = [
    ...messages.value,
    ...fresher.map((item) => ({
      id: `announce-${item.id}`,
      role: 'assistant' as const,
      content: item.text,
      attachments: [],
      createdAt: item.at,
      severity: item.severity,
      actions:
        item.payload?.undoId || item.payload?.proposalId
          ? { undoIds: item.payload.undoId ? [String(item.payload.undoId)] : [], proposalIds: item.payload.proposalId ? [String(item.payload.proposalId)] : [] }
          : undefined,
    })),
  ]
  scrollToEnd()
  for (const item of fresher) void acknowledge(item.id)
  void loadFollowUps()
}

watch(announcements, (items) => announce(items), { deep: true })

// --- Taking back what it did ---------------------------------------------------------------

const UNDO_SAID: Record<Exclude<ActionState, 'pending' | 'approved' | 'rejected'>, string> = {
  undone: 'Annulé.',
  failed: "Ça n'a pas marché.",
}

/** Everything the run did, taken back newest first so the house returns to where it was. */
async function undoAll(message: Message) {
  const ids = [...(message.actions?.undoIds ?? [])].reverse()
  if (ids.length === 0) return
  let ok = true
  for (const id of ids) {
    const result = await hubFetch<{ ok: boolean }>(`/house/undo/${id}`, { method: 'POST' }).catch(() => ({ ok: false }))
    ok = ok && result.ok
  }
  actionStates.value = { ...actionStates.value, [message.id]: ok ? 'undone' : 'failed' }
  void refresh()
}

// --- Sending ---------------------------------------------------------------------------

function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}

function scrollToEnd() {
  nextTick(() => {
    const box = scrollParent(anchor.value)
    if (box) box.scrollTop = box.scrollHeight
  })
}

async function ensureConversation(): Promise<string> {
  if (!conversationId.value) conversationId.value = (await hubFetch<{ id: string }>('/agent/conversations', { method: 'POST' })).id
  return conversationId.value
}

async function send(text: string, extra: { answers?: Record<string, string[] | string>; mentions?: { kind: string; id: string }[] } = {}) {
  const message = text.trim()
  if (!message || running.value) return

  input.value = ''
  running.value = true
  liveSteps.value = []
  runStartedAt.value = Date.now()

  messages.value = [...messages.value, { id: `local-${Date.now()}`, role: 'user', content: message, attachments: [], createdAt: new Date().toISOString() }]
  scrollToEnd()

  const controller = new AbortController()
  runController = controller
  let aborted = false

  try {
    // Created first, so a run stopped before its end can still be read back from the hub.
    const id = await ensureConversation()

    // The streaming endpoint pushes one JSON object per step; `fetch` plus a reader is
    // enough, and it avoids a second EventSource competing with the house feed.
    const response = await fetch('/api/agent/ask/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        conversationId: id,
        answers: extra.answers,
        mentions: extra.mentions?.length ? extra.mentions : undefined,
        model: modelTouched.value ? selectedModel.value?.id : undefined,
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Le hub a répondu ${response.status}.`)

    const reader = response.body?.getReader()
    if (!reader) throw new Error('Pas de flux')
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        const line = frame.split('\n').find((candidate) => candidate.startsWith('data:'))
        if (!line) continue
        const payload = JSON.parse(line.slice(5).trim()) as AgentLiveStep | { kind: 'message'; message: Message } | { kind: 'done'; result: { conversationId: string } }

        if (payload.kind === 'message') {
          if (payload.message.role === 'assistant') {
            fresh.value.add(payload.message.id)
            messages.value = [...messages.value, payload.message]
            liveSteps.value = []
          }
        } else if (payload.kind === 'done') {
          conversationId.value = payload.result.conversationId
          void refresh()
        } else {
          liveSteps.value = [...liveSteps.value, payload]
        }
        scrollToEnd()
      }
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') aborted = true
    else liveSteps.value = [...liveSteps.value, { kind: 'error', message: (error as Error).message }]
  } finally {
    running.value = false
    runController = null
    if (!aborted) void loadFollowUps()
    scrollToEnd()
  }

  if (aborted) {
    // The hub stops between two steps and keeps what was done as an interrupted answer:
    // read the conversation back once it has written it.
    liveSteps.value = []
    setTimeout(() => void loadConversation().then(scrollToEnd).catch(() => undefined), 900)
  }
}

function stopRun() {
  runController?.abort()
}

/** A note from the console itself, after a / command that did not go through the assistant. */
function note(content: string) {
  const id = `note-${Date.now()}`
  fresh.value.add(id)
  messages.value = [...messages.value, { id, role: 'assistant', content, attachments: [], createdAt: new Date().toISOString(), local: true }]
  scrollToEnd()
}

async function runCommand(id: string) {
  const command = commands.value.find((candidate) => candidate.id === id)
  if (!command) return
  const run = command.run
  if (run.kind === 'prompt') return send(run.text)

  messages.value = [...messages.value, { id: `local-${Date.now()}`, role: 'user', content: `/${command.label}`, attachments: [], createdAt: new Date().toISOString(), local: true }]
  if (run.kind === 'action' && run.action === 'new_conversation') return newConversation()
  if (run.kind === 'action' && run.action === 'undo') {
    const result = await hubFetch<{ ok: boolean; description: string | null }>('/house/undo', { method: 'POST' }).catch(() => ({ ok: false, description: null }))
    note(result.ok ? `Annulé${result.description ? ` : ${result.description}` : ''}.` : "Il n'y a rien à annuler.")
  } else if (run.kind === 'action' && run.action === 'scan') {
    const ok = await hubFetch('/scan', { method: 'POST', body: { quick: true } }).then(() => true).catch(() => false)
    note(ok ? 'Scan du réseau lancé, à suivre dans Tâches.' : "Le scan n'a pas démarré.")
  } else if (run.kind === 'scene') {
    const result = await hubFetch<{ results: { ok: boolean }[] }>(`/scenes/${run.id}/activate`, { method: 'POST' }).catch(() => ({ results: [{ ok: false }] }))
    const ok = result.results.every((entry) => entry.ok)
    note(ok ? `${command.label} appliquée.` : `${command.label} : une partie a échoué.`)
  } else if (run.kind === 'routine') {
    const result = await hubFetch<{ ok: boolean }>(`/routines/${run.id}/run`, { method: 'POST' }).catch(() => ({ ok: false }))
    note(result.ok ? `${command.label} lancée.` : `${command.label} n'a pas démarré.`)
  }
  void refresh()
}

function onSubmit(payload: PromptBarSubmitPayload) {
  if (payload.command) {
    void runCommand(payload.command.id)
    return
  }
  // Only the mentions still written in the message designate something.
  const mentions = payload.mentions.filter((mention) => payload.text.includes(`@${mention.label}`)).map((mention) => ({ kind: mention.kind, id: mention.id }))
  void send(payload.text, { mentions })
}

async function newConversation() {
  runController?.abort()
  conversationId.value = (await hubFetch<{ id: string }>('/agent/conversations', { method: 'POST' })).id
  messages.value = []
  liveSteps.value = []
  followUps.value = []
}

// --- Answers, questions, feedback -------------------------------------------------------

const lastAssistant = computed(() => [...messages.value].reverse().find((message) => message.role === 'assistant') ?? null)

/** A question card stays until it is answered: the next message of the conversation. */
function questionsOpen(message: Message): boolean {
  if (!message.questions?.length || closedQuestions.value.has(message.id) || running.value) return false
  return messages.value.at(-1)?.id === message.id
}

function answerQuestions(message: Message, answers: Record<string, ApprovalAnswer>) {
  const words = (message.questions ?? []).map((question) => {
    const answer = answers[question.id]
    if (!answer) return null
    if (typeof answer === 'string') return answer.trim() || null
    const labels = answer.map((id) => question.options.find((option) => option.id === id)?.label ?? id)
    return labels.join(', ')
  })
  const text = words.filter(Boolean).join(' ; ')
  if (!text) return
  closedQuestions.value = new Set([...closedQuestions.value, message.id])
  void send(text, { answers })
}

function closeQuestions(message: Message) {
  closedQuestions.value = new Set([...closedQuestions.value, message.id])
}

function retry(message: Message) {
  const index = messages.value.findIndex((candidate) => candidate.id === message.id)
  const question = messages.value
    .slice(0, index)
    .reverse()
    .find((candidate) => candidate.role === 'user')
  if (question) void send(question.content)
}

/** Only answers the hub keeps can be rated: not a note, not an alert, not a spoken reply. */
function rateable(message: Message): boolean {
  return !message.local && !message.severity && !message.id.startsWith('local-') && !message.id.startsWith('live-') && !message.id.startsWith('announce-')
}

async function rate(message: Message, value: StreamingTextFeedback) {
  const previous = message.feedback ?? null
  messages.value = messages.value.map((candidate) => (candidate.id === message.id ? { ...candidate, feedback: value } : candidate))
  if (!rateable(message)) return
  const saved = await hubFetch<{ feedback: 'up' | 'down' | null }>(`/agent/messages/${message.id}/feedback`, { method: 'POST', body: { value } }).catch(() => null)
  if (!saved) messages.value = messages.value.map((candidate) => (candidate.id === message.id ? { ...candidate, feedback: previous } : candidate))
}

function openContext(item: ContextCardsItem) {
  if (item.href) void navigateTo(item.href)
}

function attachmentDevices(attachment: Attachment): string[] {
  if (attachment.kind === 'device') return [String(attachment.data.id)]
  if (attachment.kind === 'devices') return (attachment.data.ids ?? []) as string[]
  return []
}

// --- Working on a passage ----------------------------------------------------------------

/** The kit's action ids, as the hub's rewrite actions. */
const REWRITE_ACTION: Record<string, string> = { explain: 'explain', improve: 'rephrase', shorten: 'shorten', translate: 'translate', custom: 'custom' }

async function rewrite(text: string, actionId: string, prompt?: string): Promise<string> {
  const action = REWRITE_ACTION[actionId]
  if (!action) throw new Error('Action inconnue.')
  type Rewritten = { ok: boolean; text?: string; error?: string }
  const result = await hubFetch<Rewritten>('/agent/rewrite', { method: 'POST', body: { text, action, prompt } }).catch(
    (error: { data?: { error?: string } }): Rewritten => ({ ok: false, error: error.data?.error ?? 'Le hub ne répond pas.' })
  )
  if (!result.ok || !result.text) throw new Error(result.error ?? 'Rien à proposer.')
  return result.text
}

/** "Demander à l'assistant" on a passage: the question starts from it, in the composer. */
function askAbout(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim()
  input.value = `À propos de "${flat.length > 160 ? `${flat.slice(0, 157)}...` : flat}" : `
}

/** "Garder" puts the rewritten passage in the composer, to send or to edit. */
function keepRewrite(payload: { result: string }) {
  input.value = payload.result
}

// --- The dock: the conversation in the kit's Chat frame, and the steps of the last run ----

const DOCK_TABS = ['Conversation', 'Étapes']
const dockTab = ref(DOCK_TABS[0]!)

const stepThread = computed<ChatEntry[]>(() => {
  const lastQuestion = [...messages.value].reverse().find((message) => message.role === 'user')
  const entries: ChatEntry[] = lastQuestion ? [{ id: `q-${lastQuestion.id}`, kind: 'user', text: lastQuestion.content }] : []

  if (running.value) {
    const results = new Map(
      liveSteps.value.filter((step): step is Extract<AgentLiveStep, { kind: 'tool_result' }> => step.kind === 'tool_result').map((step) => [step.id, step])
    )
    for (const step of liveSteps.value) {
      if (step.kind !== 'tool_call') continue
      const result = results.get(step.id)
      entries.push({
        id: step.id,
        kind: 'agent',
        label: toolMeta(step.name).label,
        sub: toolSubject(step.args, nameOf),
        time: result ? formatDuration(result.durationMs) : undefined,
        body: result ? result.summary : 'En cours...',
        resolving: !result,
      })
    }
    return entries
  }

  for (const entry of lastAssistant.value?.trace ?? []) {
    if (entry.kind !== 'tool') continue
    entries.push({
      id: entry.id,
      kind: 'agent',
      label: toolMeta(entry.name).label,
      sub: toolSubject(entry.args, nameOf),
      time: entry.ok === null ? undefined : formatDuration(entry.durationMs),
      body: entry.ok === null ? "Interrompu avant de s'exécuter." : entry.summary,
    })
  }
  return entries
})

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s` : `${ms} ms`
}

function openFull() {
  dockTool.value = null
  void navigateTo('/')
}

function openHistory() {
  void navigateTo('/agent')
}

// --- Start ----------------------------------------------------------------------------

function takeDraft(value: string) {
  if (!value) return
  input.value = value
  pendingDraft.value = ''
}

watch(pendingDraft, takeDraft)

onMounted(async () => {
  takeDraft(pendingDraft.value)
  await loadStatus().catch(() => undefined)
  await loadConversation().catch(() => undefined)
  void loadFollowUps()
  void loadComposer()
  // Asked once, so the composer knows which microphone to offer before anyone clicks it.
  await live.loadStatus().catch(() => undefined)
  // Anything said while no tab was open is still waiting on the hub.
  await loadAnnouncements().catch(() => undefined)
  scrollToEnd()
})

const liveRows = computed(() => liveThinkingRows(liveSteps.value, nameOf))
const liveError = computed(() => liveSteps.value.find((step) => step.kind === 'error'))
const answerSize = computed(() => (props.hero ? 'text-[15px]' : 'text-[13px]'))

const [DefineConversation, ReuseConversation] = createReusableTemplate()
const [DefineComposer, ReuseComposer] = createReusableTemplate()
</script>

<template>
  <div class="flex min-h-0 flex-col" :class="hero || compact ? 'h-full' : ''">
    <!-- The conversation, defined once: the full screen and the dock draw the same thing -->
    <DefineConversation>
      <AiSelectionActions
        :transform="rewrite"
        :reserve="false"
        @ask="askAbout"
        @accept="keepRewrite"
      >
        <div class="w-full space-y-4">
          <!-- Empty state is a task, not a fact. Full screen has its own, around the composer. -->
          <div v-if="!hero && messages.length === 0 && !running" class="pt-4">
            <p class="text-[13px] font-medium text-ink">{{ greeting }}. Que puis-je faire pour la maison ?</p>
            <p class="mt-0.5 text-[12px] text-ink-3">Tapez @ pour désigner un appareil, / pour une commande.</p>
            <AgentSuggestionList class="mt-3" :items="shownSuggestions" @pick="send" @shuffle="suggestionPage++" />
          </div>

          <div v-for="message in messages" :key="message.id">
            <!-- User -->
            <div v-if="message.role === 'user'" class="flex justify-end" :class="compact ? 'pl-10' : 'pl-16'">
              <div class="whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-3 py-2 text-canvas" :class="hero ? 'text-[14px]' : 'text-[13px]'">
                {{ message.content }}
              </div>
            </div>

            <!-- Assistant -->
            <div v-else class="flex gap-2.5">
              <span
                class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg"
                :class="message.severity === 'critical' ? 'bg-red-tint text-red' : message.severity === 'warning' ? 'bg-orange-tint text-orange' : 'bg-field text-ink-2'"
              >
                <Icon :name="SEVERITY_ICON[message.severity ?? ''] ?? 'ph:sparkle-fill'" class="size-3.5" />
              </span>

              <div class="min-w-0 flex-1 space-y-2.5">
                <!-- What it did to get there, folded above the answer -->
                <AiToolChips
                  v-if="message.trace?.some((entry) => entry.kind === 'tool')"
                  fill
                  collapsed
                  :steps="traceToolSteps(message.trace ?? [], nameOf)"
                />

                <!-- What it had in mind -->
                <AiContextCards v-if="message.context?.length" :items="answerContext(message.context)" :labels="{ header: 'Contexte utilisé' }" @open="openContext" />

                <AiStreamingText
                  :key="message.id"
                  :text="message.content"
                  :sources="answerSources(message.sources)"
                  :follow-ups="message.id === lastAssistant?.id && !running ? followUps : []"
                  :animate="fresh.has(message.id)"
                  auto-cite="mentions"
                  :text-class="answerSize"
                  :no-retry="!rateable(message)"
                  :no-feedback="!rateable(message)"
                  fill
                  :feedback="message.feedback ?? null"
                  @update:feedback="rate(message, $event)"
                  @retry="retry(message)"
                  @follow-up="(item: StreamingTextFollowUp) => send(item.text)"
                >
                  <template #default="{ done }">
                    <div v-if="done" class="space-y-2.5" style="animation: fade-up 300ms cubic-bezier(0.23, 1, 0.32, 1) both">
                      <p v-if="message.interrupted" class="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                        <Icon name="ph:hand-palm" class="size-3.5" />
                        Interrompu : ce qui est ci-dessus a été fait, le reste non.
                      </p>

                      <!-- It asks instead of guessing -->
                      <AiApprovalCard
                        v-if="questionsOpen(message)"
                        :questions="message.questions ?? []"
                        :resettable="false"
                        @submit="answerQuestions(message, $event)"
                        @close="closeQuestions(message)"
                      />

                      <!-- What it did alone can be taken back -->
                      <div v-if="message.actions?.undoIds.length" class="flex flex-wrap items-center gap-1.5">
                        <AiButton v-if="!actionStates[message.id]" size="xs" variant="secondary" @click="undoAll(message)">
                          <Icon name="ph:arrow-counter-clockwise" class="size-3.5" />
                          Annuler
                        </AiButton>
                        <p v-else class="text-[11.5px] text-ink-3">{{ UNDO_SAID[actionStates[message.id] as 'undone' | 'failed'] }}</p>
                      </div>

                      <!-- What it proposes waits for a yes, row by row -->
                      <ProposalReview v-for="proposalId in message.actions?.proposalIds ?? []" :key="proposalId" :proposal-id="proposalId" :compact="compact" />

                      <!-- Live device controls and cards inside the answer -->
                      <div v-for="(attachment, index) in message.attachments" :key="index">
                        <div v-if="attachmentDevices(attachment).length" class="grid gap-1.5" :class="compact ? '' : 'sm:grid-cols-2'">
                          <template v-for="id in attachmentDevices(attachment).slice(0, 6)" :key="id">
                            <DeviceCard v-if="deviceById.get(id)" :device="deviceById.get(id)!" dense />
                          </template>
                        </div>

                        <RoutineSuggestion v-else-if="attachment.kind === 'routine' && attachment.data.id" :routine-id="String(attachment.data.id)" />

                        <!--
                          A card the assistant produced to answer the question. It is the answer: the
                          sentence next to it is the spoken half, and repeating the numbers in prose
                          is what makes an assistant exhausting to read.
                        -->
                        <WidgetCard v-else-if="attachment.kind === 'widget' && attachment.data.widget" :widget="attachment.data.widget" class="max-w-lg" />

                        <AgentChart v-else-if="attachment.kind === 'chart'" :data="attachment.data" />
                      </div>

                      <p v-if="message.usage?.latencyMs || message.model" class="text-[10.5px] tabular-nums text-ink-3">
                        <span v-if="message.model">{{ message.model.model }}</span>
                        <span v-if="message.usage?.latencyMs">{{ message.model ? ' · ' : '' }}{{ message.usage.latencyMs }} ms</span>
                        <span v-if="message.usage?.costUsd"> · {{ (message.usage.costUsd * 100).toFixed(3) }} ¢</span>
                      </p>
                    </div>
                  </template>
                </AiStreamingText>
              </div>
            </div>
          </div>

          <!-- The run in flight: the loader until the first step, then the trace as it streams -->
          <div v-if="running" class="flex gap-2.5">
            <span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-field text-ink-2">
              <Icon name="ph:sparkle-fill" class="size-3.5" />
            </span>
            <div class="min-w-0 flex-1">
              <AiLoadingState v-if="liveRows.length === 0" :variant="preferences.loader" label="Réfléchit" :started-at="runStartedAt" />
              <AiThinking v-else fill working :variant="liveThinkingVariant(liveSteps)" :rows="liveRows" />
            </div>
          </div>

          <p v-if="liveError && !running" class="flex items-center gap-1.5 pl-8 text-[12px] text-red">
            <Icon name="ph:warning" class="size-3.5 shrink-0" />
            {{ liveError.kind === 'error' ? liveError.message : '' }}
          </p>

          <div ref="anchor" aria-hidden="true" />
        </div>
      </AiSelectionActions>
    </DefineConversation>

    <!-- The composer, defined once as well -->
    <DefineComposer>
      <AiPromptBar
        v-model="input"
        v-model:model="selectedModel"
        :tall="hero"
        :attach="false"
        :placeholder="compact ? 'Demandez à la maison' : 'Demandez ou ordonnez quelque chose'"
        :mentions="mentionOptions"
        :commands="commandOptions"
        :models="modelOptions"
        :dictation="dictation"
        :busy="running"
        @submit="onSubmit"
        @dictate="onDictate"
        @stop="stopRun"
      />

      <p v-if="live.error.value" class="mt-1 px-1 text-[11px] text-red">{{ live.error.value }}</p>
      <p v-else-if="live.state.value === 'live'" class="mt-1 flex items-center gap-1.5 px-1 text-[11px] text-ink-3">
        <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-red" />
        <span class="truncate">{{ live.heard.value || 'En écoute...' }}</span>
      </p>
      <p v-else-if="recogniser.error.value" class="mt-1 px-1 text-[11px] text-red">{{ recogniser.error.value }}</p>

      <div v-if="!compact" class="mt-1.5 flex items-center gap-2 px-1 text-[10.5px] text-ink-3">
        <span v-if="status">
          {{ status.fallbackOnly ? 'moteur local' : `${status.provider} · ${status.model}` }}
          <span v-if="status.local" class="text-green">· hors ligne</span>
        </span>
        <span class="flex-1" />
        <button class="transition-colors hover:text-ink-2" @click="newConversation">Nouvelle conversation</button>
      </div>
    </DefineComposer>

    <!-- The dock: the kit's Chat frame, the conversation and the steps of the last run -->
    <AiChat
      v-if="compact"
      v-model:tab="dockTab"
      fill
      :tabs="DOCK_TABS"
      :thread="stepThread"
      :busy="running"
      @new-chat="newConversation"
      @history="openHistory"
      @more="openFull"
    >
      <template v-if="dockTab === DOCK_TABS[0]" #thread>
        <ReuseConversation />
      </template>
      <template #composer>
        <ReuseComposer />
      </template>
    </AiChat>

    <!--
      Full screen, before the first question: the composer in the middle of the page with the
      greeting above and the suggestions under it, like the kit's harness. It moves to the
      bottom once there is a conversation to read above it.
    -->
    <div v-else-if="hero && messages.length === 0 && !running" class="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-16 thin-scroll">
      <div class="w-full max-w-2xl">
        <p class="text-[26px] leading-tight tracking-tight text-ink-3">{{ greeting }}</p>
        <p class="text-[26px] leading-tight tracking-tight text-ink">Que puis-je faire pour la maison ?</p>
        <div class="mt-6">
          <ReuseComposer />
        </div>
        <AgentSuggestionList class="mt-5" :items="shownSuggestions" large @pick="send" @shuffle="suggestionPage++">
          <NuxtLink to="/integrations" class="flex items-center gap-1.5 transition-colors hover:text-ink-2">
            <Icon name="ph:dots-three" class="size-3.5" />
            Connecter d'autres appareils
            <Icon name="ph:arrow-right" class="size-3" />
          </NuxtLink>
        </AgentSuggestionList>
      </div>
    </div>

    <!-- Full screen and inline: bottom-anchored, like every conversation -->
    <template v-else>
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3 thin-scroll" :class="hero ? 'mx-auto w-full max-w-3xl px-4' : 'px-3'">
        <!--
          `mt-auto` on the inner block, not `justify-end` on the scroller: a flex container
          that justifies to the end clips its own overflow at the top, so a long conversation
          would lose its first messages with no way to scroll back to them.
        -->
        <div class="mt-auto w-full pt-4">
          <ReuseConversation />
        </div>
      </div>

      <div class="shrink-0" :class="hero ? 'mx-auto w-full max-w-3xl px-4 pb-4' : 'border-t border-line p-2'">
        <ReuseComposer />
      </div>
    </template>
  </div>
</template>
