<script setup lang="ts">
/**
 * AiDemoChat - gallery demo for <AiChat> (Beautiful UI, source 06).
 *
 * Opens on one already-resolved turn, exactly like the source's initial state. Sending a new
 * message replays the source's scripted sequence - sent -> reply1 -> reply2 resolving -> done -
 * at the source's own delays (500 ms, then 1400 ms, then 1200 ms), appending to the thread
 * instead of overwriting it so the component's real multi-turn history is on display too.
 * "Rejouer" clears any added turns and returns to the seeded conversation.
 */

const REPLIES: { label: string; sub: string; time: string; body: string }[] = [
  { label: 'Historique', sub: 'Température salon', time: '2 s', body: 'Relevé les températures du salon sur les dernières 24 heures.' },
  { label: 'Comparaison', sub: 'Détection de tendance', time: '2 s', body: 'La température est restée stable, à 20,5 °C en moyenne.' },
]
const INITIAL_PROMPT = 'Compare la température du salon à hier'

function seedThread(): ChatEntry[] {
  return [
    { id: 'seed-u', kind: 'user', text: INITIAL_PROMPT },
    { id: 'seed-a1', kind: 'agent', ...REPLIES[0]! },
    { id: 'seed-a2', kind: 'agent', ...REPLIES[1]! },
  ]
}

const tabs = ['Maison', 'Automatisations']
const tab = ref(tabs[0]!)
const thread = ref<ChatEntry[]>(seedThread())
const busy = ref(false)
const lastAction = ref('')

const timers: ReturnType<typeof setTimeout>[] = []
function clearTimers() {
  for (const timer of timers.splice(0)) clearTimeout(timer)
}

function onSend(text: string) {
  clearTimers()
  const turnId = `turn-${Date.now()}`
  thread.value.push({ id: `${turnId}-u`, kind: 'user', text })
  busy.value = true

  timers.push(
    setTimeout(() => {
      thread.value.push({ id: `${turnId}-a1`, kind: 'agent', ...REPLIES[0]! })

      timers.push(
        setTimeout(() => {
          thread.value.push({ id: `${turnId}-a2`, kind: 'agent', ...REPLIES[1]!, resolving: true })

          timers.push(
            setTimeout(() => {
              const last = thread.value[thread.value.length - 1]
              if (last && last.kind === 'agent') last.resolving = false
              busy.value = false
            }, 1200)
          )
        }, 1400)
      )
    }, 500)
  )
}

function onNewChat() {
  clearTimers()
  thread.value = []
  busy.value = false
  lastAction.value = 'Nouvelle conversation'
}
function onHistory() {
  lastAction.value = 'Historique demandé'
}
function onMore() {
  lastAction.value = "Plus d'options demandé"
}

function restart() {
  clearTimers()
  thread.value = seedThread()
  busy.value = false
  lastAction.value = ''
}

onBeforeUnmount(clearTimers)
</script>

<template>
  <section class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Assistant</span>
      <AiButton size="xs" variant="secondary" @click="restart">Rejouer</AiButton>
    </div>
    <div class="flex flex-col items-center gap-2 rounded-window bg-canvas p-6">
      <AiChat
        v-model:tab="tab"
        :tabs="tabs"
        :thread="thread"
        :busy="busy"
        placeholder="Écrire un message, ou mentionner un appareil avec @"
        @send="onSend"
        @new-chat="onNewChat"
        @history="onHistory"
        @more="onMore"
      />
      <p v-if="lastAction" class="text-[11px] text-ink-3">{{ lastAction }}</p>
    </div>
  </section>
</template>
