<script setup lang="ts">
/**
 * The assistant.
 *
 * Two things make this feel different from a chat box bolted onto a dashboard:
 *
 *  - **Steps are shown as they happen.** The run streams over SSE, so the tool calls appear
 *    while the model is still working. A house agent that acts has to show its hands.
 *  - **Attachments are live controls.** When the agent says it turned the living room on,
 *    the reply carries the actual device cards, with working switches. The answer is the
 *    interface, which is the whole point of a generative console.
 */

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

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  attachments: Attachment[]
  createdAt: string
  usage?: { costUsd?: number; latencyMs?: number } | null
  /** Set on a message the house raised by itself, so an alert reads like one. */
  severity?: string
  /** Something the assistant did or proposes on its own: the way to undo it or say yes. */
  actions?: { undoId?: string | null; proposalId?: string | null; state?: ActionState }
}

type ActionState = 'pending' | 'undone' | 'approved' | 'rejected' | 'failed'

interface Step {
  kind: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error'
  text?: string
  name?: string
  args?: Record<string, unknown>
  summary?: string
  ok?: boolean
  message?: Message
}

const { deviceById, refresh } = useHouse()
const conversationId = useState<string | null>('agent-conversation', () => null)
const messages = useState<Message[]>('agent-messages', () => [])
const liveSteps = ref<Step[]>([])
const input = ref('')
const running = ref(false)
const status = ref<{ ready: boolean; provider: string; model: string; fallbackOnly: boolean; autonomy: string; local: boolean } | null>(null)
const scroller = ref<HTMLElement | null>(null)

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
]

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

/**
 * The microphone.
 *
 * When the hub has an OpenAI key and is not in local-only mode, the button opens a GPT-Live
 * call: full duplex, interruptible, and the house answers through the same agent and the
 * same tools as the text path. That is the default whenever it is available - the local
 * press-to-talk chain stays as the fallback, not as the main way in.
 */
const live = useLiveVoice()

function onLiveReply(reply: { text: string; attachments: { kind: string; data: Record<string, any> }[] }) {
  // A spoken answer still belongs in the transcript: the card it carries is the whole point.
  messages.value = [
    ...messages.value,
    { id: `live-${Date.now()}`, role: 'assistant', content: reply.text, attachments: reply.attachments, createdAt: new Date().toISOString() },
  ]
  void refresh()
  void loadFollowUps()
  scrollToEnd()
}

/** A spoken sentence lands in the conversation the moment a pause ends it. */
function onLiveUtterance(text: string) {
  messages.value = [
    ...messages.value,
    { id: `live-user-${Date.now()}`, role: 'user', content: text, attachments: [], createdAt: new Date().toISOString() },
  ]
  scrollToEnd()
}

function toggleLive() {
  if (live.state.value === 'live' || live.state.value === 'connecting') live.stop()
  else void live.start({ onUtterance: onLiveUtterance, onReply: onLiveReply })
}

onBeforeUnmount(() => {
  if (live.state.value === 'live') live.stop()
})

async function loadConversation() {
  if (!conversationId.value) return
  messages.value = (await hubFetch<{ messages: Message[] }>(`/agent/conversations/${conversationId.value}`)).messages
}

/**
 * What the house says on its own.
 *
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
  const fresh = items.filter((item) => !messages.value.some((message) => message.id === `announce-${item.id}`))
  if (fresh.length === 0) return

  messages.value = [
    ...messages.value,
    ...fresh.map((item) => ({
      id: `announce-${item.id}`,
      role: 'assistant' as const,
      content: item.text,
      attachments: [],
      createdAt: item.at,
      severity: item.severity,
      actions:
        item.payload?.undoId || item.payload?.proposalId
          ? { undoId: item.payload.undoId ?? null, proposalId: item.payload.proposalId ?? null, state: 'pending' as const }
          : undefined,
    })),
  ]
  scrollToEnd()
  for (const item of fresh) void acknowledge(item.id)
  void loadFollowUps()
}

watch(announcements, (items) => announce(items), { deep: true })

/**
 * The answer to something the assistant did alone. "Annuler" puts the house back the way
 * it was; "Oui, vas-y" runs what it proposed. Either way the buttons give way to a word, so
 * the transcript keeps a record of what was decided.
 */
const ACTION_SAID: Record<Exclude<ActionState, 'pending'>, string> = {
  undone: 'Annulé.',
  approved: "C'est fait.",
  rejected: 'Compris, je laisse.',
  failed: "Ça n'a pas marché.",
}

function settle(id: string, state: ActionState) {
  messages.value = messages.value.map((message) => (message.id === id && message.actions ? { ...message, actions: { ...message.actions, state } } : message))
}

async function undoAction(message: Message) {
  if (!message.actions?.undoId) return
  const result = await hubFetch<{ ok: boolean }>(`/house/undo/${message.actions.undoId}`, { method: 'POST' }).catch(() => ({ ok: false }))
  settle(message.id, result.ok ? 'undone' : 'failed')
  void refresh()
}

async function decide(message: Message, yes: boolean) {
  const id = message.actions?.proposalId
  if (!id) return
  const result = await hubFetch<{ ok: boolean }>(`/agent/proposals/${id}/${yes ? 'approve' : 'reject'}`, { method: 'POST' }).catch(() => ({ ok: false }))
  settle(message.id, !result.ok ? 'failed' : yes ? 'approved' : 'rejected')
  void refresh()
}

onMounted(async () => {
  await loadStatus()
  await loadConversation()
  void loadFollowUps()
  // Asked once, so the composer knows which microphone to offer before anyone clicks it.
  await live.loadStatus().catch(() => undefined)
  // Anything said while no tab was open is still waiting on the hub.
  await loadAnnouncements().catch(() => undefined)
})

function scrollToEnd() {
  nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  })
}

async function send(text?: string) {
  const message = (text ?? input.value).trim()
  if (!message || running.value) return

  input.value = ''
  running.value = true
  liveSteps.value = []

  messages.value = [
    ...messages.value,
    { id: `local-${Date.now()}`, role: 'user', content: message, attachments: [], createdAt: new Date().toISOString() },
  ]
  scrollToEnd()

  try {
    // The streaming endpoint pushes one JSON object per step; `fetch` plus a reader is
    // enough, and it avoids a second EventSource competing with the house feed.
    const response = await fetch('/api/agent/ask/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, conversationId: conversationId.value }),
    })

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
        const payload = JSON.parse(line.slice(5).trim()) as Step & { result?: { conversationId: string } }

        if (payload.kind === 'message' && payload.message) {
          if (payload.message.role === 'assistant') {
            messages.value = [...messages.value, payload.message]
            liveSteps.value = []
          }
        } else if ('result' in payload && payload.result) {
          conversationId.value = payload.result.conversationId
          void refresh()
        } else {
          liveSteps.value = [...liveSteps.value, payload]
        }
        scrollToEnd()
      }
    }
  } catch (error) {
    liveSteps.value = [...liveSteps.value, { kind: 'error', text: (error as Error).message }]
  } finally {
    running.value = false
    void loadFollowUps()
    scrollToEnd()
  }
}

async function newConversation() {
  conversationId.value = (await hubFetch<{ id: string }>('/agent/conversations', { method: 'POST' })).id
  messages.value = []
  liveSteps.value = []
}

function attachmentDevices(attachment: Attachment): string[] {
  if (attachment.kind === 'device') return [String(attachment.data.id)]
  if (attachment.kind === 'devices') return (attachment.data.ids ?? []) as string[]
  return []
}
</script>

<template>
  <div class="flex min-h-0 flex-col" :class="hero ? 'h-full' : ''">
    <!--
      Bottom-anchored, like every conversation: `justify-end` keeps a two-message exchange
      sitting just above the composer instead of stranded at the top of an empty screen.
    -->
    <div
      ref="scroller"
      class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3 thin-scroll"
      :class="hero ? 'mx-auto w-full max-w-3xl px-4' : 'px-3'"
    >
      <!--
        `mt-auto` on the inner block, not `justify-end` on the scroller: a flex container
        that justifies to the end clips its own overflow at the top, so a long conversation
        would lose its first messages with no way to scroll back to them.
      -->
      <div class="mt-auto w-full space-y-3">
      <!-- Empty state is a task, not a fact -->
      <div v-if="messages.length === 0" :class="hero ? 'grid h-full place-content-center pb-10' : 'pt-6'">
        <div class="mx-auto grid place-items-center rounded-2xl bg-base-200" :class="hero ? 'size-16' : 'size-12'">
          <Icon name="ph:sparkle" class="text-base-content/40" :class="hero ? 'size-8' : 'size-6'" />
        </div>
        <p class="mt-3 text-center font-medium" :class="hero ? 'text-lg' : 'text-[13px]'">Demandez quelque chose à la maison.</p>
        <p class="mt-1 text-center text-base-content/50" :class="hero ? 'text-[13px]' : 'text-[12px]'">
          L'assistant lit l'état réel des appareils, agit, et affiche ce qu'il faut voir.
        </p>
        <div class="mx-auto mt-6 w-full" :class="hero ? 'max-w-xl' : ''">
          <p class="mb-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-base-content/30">Suggestions</p>
          <div class="space-y-1.5">
            <button
              v-for="suggestion in SUGGESTIONS.slice(0, hero ? 6 : 4)"
              :key="suggestion.text"
              class="flex w-full items-center gap-2.5 rounded-xl border border-base-300 bg-base-100 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-base-200"
              @click="send(suggestion.text)"
            >
              <Icon :name="suggestion.icon" class="size-4 shrink-0 text-base-content/35" />
              <span class="min-w-0 flex-1 truncate">{{ suggestion.text }}</span>
            </button>
          </div>
        </div>
      </div>

      <div v-for="message in messages" :key="message.id">
        <!-- User -->
        <div v-if="message.role === 'user'" class="flex justify-end">
          <div class="max-w-[85%] rounded-2xl rounded-br-md bg-base-content px-3 py-2 text-[13px] text-base-100">
            {{ message.content }}
          </div>
        </div>

        <!-- Assistant -->
        <div v-else class="space-y-2">
          <div class="flex gap-2">
            <span
              class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg"
              :class="message.severity === 'critical' ? 'bg-error/15 text-error' : message.severity === 'warning' ? 'bg-warning/20 text-warning' : 'bg-base-200 text-base-content/60'"
            >
              <Icon :name="SEVERITY_ICON[message.severity ?? ''] ?? 'ph:sparkle-fill'" class="size-3.5" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="whitespace-pre-wrap leading-relaxed" :class="hero ? 'text-[15px]' : 'text-[13px]'"><RichText :text="message.content" /></p>

              <!-- What it did alone can be undone; what it proposes waits for a yes -->
              <div v-if="message.actions" class="mt-1.5 flex flex-wrap items-center gap-1.5">
                <template v-if="message.actions.state === 'pending'">
                  <button v-if="message.actions.undoId" class="btn btn-xs gap-1 rounded-lg border-base-300 bg-base-100" @click="undoAction(message)">
                    <Icon name="ph:arrow-counter-clockwise" class="size-3.5" />
                    Annuler
                  </button>
                  <template v-if="message.actions.proposalId">
                    <button class="btn btn-xs admin-cta gap-1 rounded-lg" @click="decide(message, true)">
                      <Icon name="ph:check" class="size-3.5" />
                      Oui, vas-y
                    </button>
                    <button class="btn btn-xs btn-ghost rounded-lg" @click="decide(message, false)">Non</button>
                  </template>
                </template>
                <p v-else-if="message.actions.state" class="text-[11px] text-base-content/45">{{ ACTION_SAID[message.actions.state] }}</p>
              </div>

              <!-- Live device controls inside the answer -->
              <div
                v-for="(attachment, index) in message.attachments"
                :key="index"
                class="mt-2"
              >
                <div v-if="attachmentDevices(attachment).length" class="grid gap-1.5" :class="props.compact ? '' : 'sm:grid-cols-2'">
                  <DeviceCard
                    v-for="id in attachmentDevices(attachment).slice(0, 6)"
                    :key="id"
                    :device="deviceById.get(id)!"
                    dense
                  />
                </div>

                <NuxtLink
                  v-else-if="attachment.kind === 'routine'"
                  to="/routines"
                  class="flex items-center gap-2 rounded-xl border border-base-300 p-2 text-[12px] transition-colors hover:bg-base-200"
                >
                  <Icon name="ph:flow-arrow" class="size-4" />
                  Routine proposée, à valider
                  <Icon name="ph:arrow-right" class="ml-auto size-3.5 opacity-40" />
                </NuxtLink>

                <!--
                  A card the assistant produced to answer the question. It is the answer: the
                  sentence next to it is the spoken half, and repeating the numbers in prose
                  is what makes an assistant exhausting to read.
                -->
                <WidgetCard
                  v-else-if="attachment.kind === 'widget' && attachment.data.widget"
                  :widget="attachment.data.widget"
                  class="max-w-lg"
                />

                <AgentChart v-else-if="attachment.kind === 'chart'" :data="attachment.data" />
              </div>

              <p v-if="message.usage?.latencyMs" class="mt-1 text-[10px] tabular text-base-content/30">
                {{ message.usage.latencyMs }} ms
                <span v-if="message.usage.costUsd">· {{ (message.usage.costUsd * 100).toFixed(3) }} ¢</span>
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Steps, while the run is happening -->
      <div v-if="liveSteps.length" class="flex gap-2">
        <span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-base-200">
          <Icon name="ph:circle-notch" class="size-3.5 animate-spin text-base-content/60" />
        </span>
        <div class="min-w-0 flex-1 space-y-1">
          <div v-for="(step, index) in liveSteps" :key="index" class="text-[12px]">
            <p v-if="step.kind === 'thinking'" class="text-base-content/60">{{ step.text }}</p>
            <p v-else-if="step.kind === 'tool_call'" class="flex items-center gap-1.5 text-base-content/50">
              <Icon name="ph:wrench" class="size-3.5" />
              <span class="font-mono">{{ step.name }}</span>
            </p>
            <p v-else-if="step.kind === 'tool_result'" class="flex items-start gap-1.5" :class="step.ok ? 'text-base-content/45' : 'text-error'">
              <Icon :name="step.ok ? 'ph:check' : 'ph:x'" class="mt-0.5 size-3.5 shrink-0" />
              <span class="line-clamp-2">{{ step.summary }}</span>
            </p>
            <p v-else-if="step.kind === 'error'" class="text-error">{{ step.text ?? step.message }}</p>
          </div>
        </div>
      </div>
      </div>
    </div>

    <!--
      What to ask next: quiet, under the last answer, gone while an answer is being written
      so it never competes with a run in flight.
    -->
    <div
      v-if="messages.length > 0 && !running && followUps.length > 0"
      class="shrink-0"
      :class="hero ? 'mx-auto w-full max-w-3xl px-4' : 'px-3'"
    >
      <!-- One row, scrolled sideways when it overflows: the answer keeps the room. -->
      <div class="no-scrollbar flex gap-1.5 overflow-x-auto pb-1">
        <button
          v-for="item in followUps"
          :key="item.text"
          class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-base-300/70 bg-base-100/60 px-2.5 py-1.5 text-[12px] text-base-content/55 transition-colors hover:border-base-content/25 hover:text-base-content"
          @click="send(item.text)"
        >
          <Icon :name="item.icon" class="size-3.5 opacity-60" />
          {{ item.text }}
        </button>
      </div>
    </div>

    <!-- Composer -->
    <div class="shrink-0 p-2" :class="hero ? 'mx-auto w-full max-w-3xl px-4 pb-4' : 'border-t border-base-300'">
      <div
        class="flex items-end gap-1.5 rounded-2xl border border-base-300 bg-base-100 focus-within:border-base-content/30"
        :class="hero ? 'p-2 shadow-sm' : 'p-1.5'"
      >
        <!-- GPT-Live when the hub can reach it, the local chain otherwise -->
        <button
          v-if="live.status.value?.available"
          class="btn btn-sm btn-square"
          :class="live.state.value === 'live' ? 'btn-error' : live.state.value === 'connecting' ? 'btn-ghost' : 'admin-cta'"
          :title="live.state.value === 'live' ? 'Raccrocher' : `Parler en direct (${live.status.value.model})`"
          :aria-label="live.state.value === 'live' ? 'Raccrocher' : 'Parler en direct'"
          @click="toggleLive"
        >
          <Icon
            :name="live.state.value === 'live' ? 'ph:phone-x' : live.state.value === 'connecting' ? 'ph:circle-notch' : 'ph:waveform'"
            class="size-4"
            :class="live.state.value === 'connecting' ? 'animate-spin' : ''"
          />
        </button>

        <VoiceButton v-else @transcript="send($event)" />
        <textarea
          v-model="input"
          rows="1"
          placeholder="Demandez ou ordonnez quelque chose"
          class="max-h-32 min-h-8 flex-1 resize-none bg-transparent px-1 py-1 outline-none placeholder:text-base-content/35"
          :class="hero ? 'text-[15px]' : 'text-[13px]'"
          @keydown.enter.exact.prevent="send()"
        />
        <button
          class="btn btn-sm btn-square admin-cta"
          :disabled="running || input.trim().length === 0"
          aria-label="Envoyer"
          @click="send()"
        >
          <Icon :name="running ? 'ph:circle-notch' : 'ph:arrow-up'" class="size-4" :class="running ? 'animate-spin' : ''" />
        </button>
      </div>

      <p v-if="live.error.value" class="mt-1 px-1 text-[11px] text-error">{{ live.error.value }}</p>
      <p v-else-if="live.state.value === 'live'" class="mt-1 flex items-center gap-1.5 px-1 text-[11px] text-base-content/50">
        <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-error" />
        <span class="truncate">{{ live.heard.value || 'En écoute...' }}</span>
      </p>

      <div class="mt-1 flex items-center gap-2 px-1 text-[10px] text-base-content/35">
        <span v-if="status">
          {{ status.fallbackOnly ? 'moteur local' : `${status.provider} · ${status.model}` }}
          <span v-if="status.local" class="text-success">· hors ligne</span>
        </span>
        <span class="flex-1" />
        <button class="hover:text-base-content/70" @click="newConversation">Nouvelle conversation</button>
      </div>
    </div>
  </div>
</template>
