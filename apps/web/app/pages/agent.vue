<script setup lang="ts">
/**
 * The assistant, full screen.
 *
 * Same component as the dock, given room: conversations on the left, the chat in the
 * middle, and the autonomy control where it belongs - next to the thing it governs, not
 * buried three levels into a settings page.
 */

const { setBreadcrumb } = useShell()
setBreadcrumb([{ label: 'Intelligence' }, { label: 'Assistant' }], 'Assistant')

interface Status {
  provider: string
  model: string
  ready: boolean
  local: boolean
  autonomy: string
  spentTodayUsd: number
  budgetUsd: number
  toolCount: number
  fallbackOnly: boolean
  conversations: { id: string; title: string; updatedAt: string; messageCount: number }[]
}

interface Reflex {
  id: string
  label: string
  description: string
  icon: string
  safety: boolean
  enabled: boolean
}

interface Reflexes {
  actsAlone: boolean
  today: number
  recent: { at: string; text: string; reflex: string }[]
  reflexes: Reflex[]
}

const status = ref<Status | null>(null)
const reflexes = ref<Reflexes | null>(null)
const autonomyLevels = ref<{ id: string; label: string; description: string }[]>([])
const conversationId = useState<string | null>('agent-conversation', () => null)
const messages = useState<unknown[]>('agent-messages', () => [])

async function load() {
  const [agent, meta] = await Promise.all([
    hubFetch<Status>('/agent/status'),
    hubFetch<{ autonomyLevels: { id: string; label: string; description: string }[] }>('/meta'),
  ])
  status.value = agent
  autonomyLevels.value = meta.autonomyLevels
  reflexes.value = await hubFetch<Reflexes>('/agent/reflexes')
}

/** One switch per reflex, like Alexa's per-category opt-in: acting alone is chosen, not imposed. */
async function toggleReflex(reflex: Reflex) {
  reflexes.value = await hubFetch<Reflexes>(`/agent/reflexes/${reflex.id}`, { method: 'POST', body: { enabled: !reflex.enabled } })
}

onMounted(load)

async function setAutonomy(level: string) {
  status.value = { ...(status.value as Status), ...(await hubFetch<Status>('/agent/autonomy', { method: 'POST', body: { level } })) }
  reflexes.value = await hubFetch<Reflexes>('/agent/reflexes')
}

async function openConversation(id: string) {
  conversationId.value = id
  messages.value = (await hubFetch<{ messages: unknown[] }>(`/agent/conversations/${id}`)).messages
}

async function newConversation() {
  conversationId.value = (await hubFetch<{ id: string }>('/agent/conversations', { method: 'POST' })).id
  messages.value = []
  await load()
}

const AUTONOMY_ICON: Record<string, string> = {
  observer: 'ph:eye',
  assistant: 'ph:hand-pointing',
  copilot: 'ph:steering-wheel',
  autopilot: 'ph:robot',
}
</script>

<template>
  <div class="mx-auto max-w-7xl">
    <PageHeader
      title="Assistant"
      :subtitle="status ? (status.fallbackOnly ? 'Moteur local, sans modèle' : `${status.provider} · ${status.model} · ${status.spentTodayUsd.toFixed(3)} / ${status.budgetUsd} USD aujourd hui`) : null"
      :loading="!status"
      :breadcrumb="[{ label: 'Intelligence' }, { label: 'Assistant' }]"
    >
      <template #actions>
        <NuxtLink to="/settings#assistant" class="btn btn-sm btn-outline gap-2">
          <Icon name="ph:sliders-horizontal" class="size-4" />
          Configurer
        </NuxtLink>
        <button class="btn btn-sm admin-cta gap-2" @click="newConversation">
          <Icon name="ph:plus" class="size-4" />
          Nouvelle
        </button>
      </template>
    </PageHeader>

    <!-- Autonomy, where it belongs -->
    <section class="mb-5 rounded-2xl border border-base-300 bg-base-100 p-4">
      <h2 class="mb-1 text-xs font-semibold uppercase tracking-wider text-base-content/40">Autonomie</h2>
      <p class="mb-3 max-w-2xl text-[12px] text-base-content/55">
        Ce que l'assistant a le droit de faire sans demander. Les serrures, les caméras, les alarmes et tout appareil
        marqué critique demandent toujours une confirmation, quel que soit le niveau.
      </p>

      <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <button
          v-for="level in autonomyLevels"
          :key="level.id"
          class="rounded-xl border p-3 text-left transition-colors"
          :class="status?.autonomy === level.id ? 'border-transparent bg-primary/25' : 'border-base-300 hover:bg-base-200'"
          @click="setAutonomy(level.id)"
        >
          <div class="flex items-center gap-2">
            <Icon :name="AUTONOMY_ICON[level.id] ?? 'ph:circle'" class="size-4" />
            <span class="text-[13px] font-semibold">{{ level.label }}</span>
            <Icon v-if="status?.autonomy === level.id" name="ph:check" class="ml-auto size-4" />
          </div>
          <p class="mt-1 text-[11px] leading-relaxed text-base-content/60">{{ level.description }}</p>
        </button>
      </div>
    </section>

    <!-- What it does without being asked -->
    <section v-if="reflexes" class="mb-5 rounded-2xl border border-base-300 bg-base-100 p-4">
      <div class="mb-1 flex items-center gap-2">
        <h2 class="text-xs font-semibold uppercase tracking-wider text-base-content/40">Ce qu'il fait de lui-même</h2>
        <span class="ml-auto text-[11px] tabular text-base-content/45">
          {{ reflexes.today }} action{{ reflexes.today > 1 ? 's' : '' }} aujourd'hui
        </span>
      </div>
      <p class="mb-3 max-w-2xl text-[12px] text-base-content/55">
        {{
          reflexes.actsAlone
            ? "L'assistant agit seul dans ces situations, le dit dans la conversation et propose d'annuler. Une reprise à la main l'arrête pour trois heures."
            : "À ce niveau d'autonomie, l'assistant repère ces situations et vous demande avant d'agir."
        }}
      </p>

      <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <button
          v-for="reflex in reflexes.reflexes"
          :key="reflex.id"
          class="flex items-start gap-2.5 rounded-xl border p-3 text-left transition-colors"
          :class="reflex.enabled ? 'border-base-300 hover:bg-base-200' : 'border-dashed border-base-300 opacity-60 hover:opacity-80'"
          :aria-pressed="reflex.enabled"
          @click="toggleReflex(reflex)"
        >
          <Icon :name="reflex.icon" class="mt-0.5 size-4 shrink-0" :class="reflex.safety ? 'text-error' : ''" />
          <span class="min-w-0 flex-1">
            <span class="block text-[13px] font-semibold">{{ reflex.label }}</span>
            <span class="mt-0.5 block text-[11px] leading-relaxed text-base-content/60">{{ reflex.description }}</span>
          </span>
          <input type="checkbox" class="toggle toggle-xs mt-0.5" :checked="reflex.enabled" tabindex="-1" aria-hidden="true">
        </button>
      </div>

      <ul v-if="reflexes.recent.length" class="mt-3 space-y-1">
        <li v-for="entry in reflexes.recent" :key="entry.at" class="flex items-baseline gap-2 text-[12px]">
          <span class="shrink-0 tabular text-base-content/40">{{ formatRelative(entry.at) }}</span>
          <RichText :text="entry.text" />
        </li>
      </ul>
    </section>

    <div class="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <!-- Conversations -->
      <aside class="hidden rounded-2xl border border-base-300 bg-base-100 p-2 lg:block">
        <p class="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-base-content/40">Conversations</p>
        <button
          v-for="conversation in status?.conversations ?? []"
          :key="conversation.id"
          class="block w-full rounded-lg px-2 py-2 text-left transition-colors"
          :class="conversationId === conversation.id ? 'bg-primary/25' : 'hover:bg-base-200'"
          @click="openConversation(conversation.id)"
        >
          <span class="block truncate text-[13px]">{{ conversation.title }}</span>
          <span class="block text-[11px] tabular text-base-content/45">
            {{ conversation.messageCount }} messages · {{ formatRelative(conversation.updatedAt) }}
          </span>
        </button>
        <p v-if="!status?.conversations.length" class="px-2 py-6 text-center text-[12px] text-base-content/45">
          Aucune conversation.
        </p>
      </aside>

      <!-- Chat -->
      <div class="flex h-[calc(100vh-22rem)] min-h-96 flex-col overflow-hidden rounded-2xl border border-base-300 bg-base-100">
        <AgentChat class="min-h-0 flex-1" />
      </div>
    </div>

    <p v-if="status" class="mt-4 text-[12px] text-base-content/45">
      {{ status.toolCount }} outils disponibles. L'assistant lit l'état réel des appareils avant de répondre,
      et chaque action qu'il prend apparaît dans le journal avec son origine.
    </p>
  </div>
</template>
