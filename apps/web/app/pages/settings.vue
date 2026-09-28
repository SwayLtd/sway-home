<script setup lang="ts">
/**
 * Settings.
 *
 * Grouped by the question being answered, not by the shape of the database: the model, the
 * voice, what the assistant may do on its own, what it keeps, the tariff. The API key field
 * says where the key is stored and what leaves the machine, because that is the one thing a
 * privacy-first product has to be explicit about in the exact place the reader types it.
 */

interface AgentSettings {
  autonomy: string
  voice: { enabled: boolean; wakeWord: string; wakeWordEnabled: boolean; sttProvider: string; ttsProvider: string; ttsVoice: string; language: string; speakReplies: boolean }
  llm: { provider: string; model: string; baseUrl?: string; temperature: number; maxSteps: number; dailyBudgetUsd: number }
  /** Which providers have a key on the hub. The keys themselves never leave it. */
  keys?: Record<string, boolean>
  privacy: { localOnly: boolean; shareDeviceNames: boolean; retainTranscriptsDays: number; retainAudio: boolean }
  proactivity: { suggestRoutines: boolean; suggestOnNewDevice: boolean; dailyBriefing: boolean; briefingTime: string; maxUnpromptedActionsPerHour: number; quietHours: [string, string] }
}

interface Provider {
  id: string
  label: string
  local: boolean
  needsKey: boolean
  models: string[]
  pricing: { input: number; output: number }
  baseUrlHint?: string
  note?: string
}

const voice = useVoiceSettings()

const agent = ref<AgentSettings | null>(null)
const energy = ref({ pricePerKwh: 0.2516, currency: 'EUR', contractKva: 9 })
const providers = ref<Provider[]>([])
const autonomyLevels = ref<{ id: string; label: string; description: string }[]>([])
const localRunners = ref<{ id: string; label: string; url: string; models: string[] }[]>([])
const loading = ref(true)
const saving = ref<string | null>(null)
const saved = ref<string | null>(null)

const apiKey = ref('')
const baseUrl = ref('')
const testResult = ref<{ ok: boolean; message: string; latencyMs?: number } | null>(null)
const testing = ref(false)

async function load() {
  const [settings, status, meta] = await Promise.all([
    hubFetch<Record<string, any>>('/settings'),
    hubFetch<{ providers: Provider[] }>('/agent/status'),
    hubFetch<{ autonomyLevels: { id: string; label: string; description: string }[] }>('/meta'),
  ])
  agent.value = settings.agent as AgentSettings
  if (settings.energy) energy.value = { ...energy.value, ...settings.energy }
  providers.value = status.providers
  autonomyLevels.value = meta.autonomyLevels
  baseUrl.value = agent.value?.llm.baseUrl ?? ''
  loading.value = false
}
onMounted(load)

/** Flash "enregistré" on the section that changed. Silent saves leave the reader guessing. */
async function save(key: string, body: Record<string, unknown>, section: string) {
  saving.value = section
  try {
    await hubFetch(`/settings/${key}`, { method: 'PATCH', body })
    saved.value = section
    setTimeout(() => {
      if (saved.value === section) saved.value = null
    }, 2000)
  } finally {
    saving.value = null
  }
}

const selectedProvider = computed(() => providers.value.find((provider) => provider.id === agent.value?.llm.provider) ?? null)

async function pickProvider(id: string) {
  if (!agent.value) return
  const provider = providers.value.find((entry) => entry.id === id)
  agent.value.llm.provider = id
  agent.value.llm.model = provider?.models[0] ?? ''
  baseUrl.value = provider?.baseUrlHint ?? ''
  testResult.value = null
  await save('agent', { llm: { provider: id, model: agent.value.llm.model, baseUrl: baseUrl.value } }, 'llm')
}

async function saveLlm() {
  if (!agent.value) return
  const body: Record<string, unknown> = {
    llm: {
      provider: agent.value.llm.provider,
      model: agent.value.llm.model,
      temperature: agent.value.llm.temperature,
      maxSteps: agent.value.llm.maxSteps,
      dailyBudgetUsd: agent.value.llm.dailyBudgetUsd,
      baseUrl: baseUrl.value || undefined,
    },
  }
  // The key is only sent when it was typed here, so saving the other fields never wipes it.
  if (apiKey.value) (body.llm as Record<string, unknown>).apiKey = apiKey.value
  await save('agent', body, 'llm')
  apiKey.value = ''
}

async function testProvider() {
  if (!agent.value) return
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await hubFetch('/agent/provider/test', {
      method: 'POST',
      body: {
        provider: agent.value.llm.provider,
        model: agent.value.llm.model,
        apiKey: apiKey.value || undefined,
        baseUrl: baseUrl.value || undefined,
      },
    })
  } catch (error) {
    testResult.value = { ok: false, message: (error as Error).message }
  } finally {
    testing.value = false
  }
}

async function findLocalRunners() {
  testing.value = true
  try {
    localRunners.value = (await hubFetch<{ runners: typeof localRunners.value }>('/agent/local-runners')).runners
  } finally {
    testing.value = false
  }
}

const monthlyEstimate = computed(() => {
  const provider = selectedProvider.value
  if (!provider || provider.local) return 0
  // Rough but honest: a house conversation is about 4k tokens in and 400 out, and the
  // deterministic parser handles most commands without ever reaching the model.
  const perAsk = (4000 / 1_000_000) * provider.pricing.input + (400 / 1_000_000) * provider.pricing.output
  return perAsk * 20 * 30
})
</script>

<template>
  <div class="mx-auto max-w-3xl pb-10">
    <PageHeader
      title="Réglages"
      :loading="loading"
      :breadcrumb="[{ label: 'Système' }, { label: 'Réglages' }]"
    />

    <div v-if="agent" class="space-y-4">
      <!-- Model -->
      <section id="assistant" class="rounded-2xl border border-base-300 bg-base-100 p-4">
        <div class="mb-1 flex items-center gap-2">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-base-content/40">Modèle de langage</h2>
          <span v-if="saved === 'llm'" class="text-[11px] text-success">enregistré</span>
        </div>
        <p class="mb-3 text-[12px] text-base-content/55">
          Sans modèle, l'assistant fonctionne quand même: un analyseur de phrases local comprend les commandes
          courantes en français. Un modèle ajoute le raisonnement, les routines écrites toutes seules et les
          réponses en langage libre.
        </p>

        <div class="grid gap-2 sm:grid-cols-2">
          <button
            v-for="provider in providers"
            :key="provider.id"
            class="rounded-xl border p-3 text-left transition-colors"
            :class="agent.llm.provider === provider.id ? 'border-transparent bg-primary/25' : 'border-base-300 hover:bg-base-200'"
            @click="pickProvider(provider.id)"
          >
            <div class="flex items-center gap-2">
              <Icon :name="provider.local ? 'ph:hard-drives' : 'ph:cloud'" class="size-4 shrink-0" />
              <span class="text-[13px] font-medium">{{ provider.label }}</span>
              <Icon v-if="agent.llm.provider === provider.id" name="ph:check" class="ml-auto size-4" />
            </div>
            <p class="mt-1 text-[11px] leading-relaxed text-base-content/55">{{ provider.note }}</p>
            <p class="mt-1 text-[11px] tabular text-base-content/40">
              {{ provider.local ? 'gratuit, hors ligne' : `${provider.pricing.input} / ${provider.pricing.output} USD par million de tokens` }}
            </p>
          </button>
        </div>

        <div v-if="selectedProvider" class="mt-3 space-y-2 border-t border-base-200 pt-3">
          <label class="flex items-center gap-3">
            <span class="w-28 shrink-0 text-[12px] text-base-content/60">Modèle</span>
            <input
              v-model="agent.llm.model"
              list="model-list"
              class="input input-sm flex-1 border-base-300 bg-base-200"
              placeholder="nom du modèle"
            >
            <datalist id="model-list">
              <option v-for="model in selectedProvider.models" :key="model" :value="model" />
            </datalist>
          </label>

          <label v-if="selectedProvider.needsKey" class="flex items-center gap-3">
            <span class="w-28 shrink-0 text-[12px] text-base-content/60">Clé API</span>
            <input
              v-model="apiKey"
              type="password"
              class="input input-sm flex-1 border-base-300 bg-base-200"
              :placeholder="agent.keys?.[agent.llm.provider] ? 'clé enregistrée, saisissez pour remplacer' : 'coller la clé'"
            >
          </label>

          <label v-if="selectedProvider.baseUrlHint || selectedProvider.local" class="flex items-center gap-3">
            <span class="w-28 shrink-0 text-[12px] text-base-content/60">URL</span>
            <input v-model="baseUrl" class="input input-sm flex-1 border-base-300 bg-base-200" :placeholder="selectedProvider.baseUrlHint">
          </label>

          <div class="flex items-center gap-3">
            <span class="w-28 shrink-0 text-[12px] text-base-content/60">Budget / jour</span>
            <input v-model.number="agent.llm.dailyBudgetUsd" type="number" step="0.5" min="0" class="input input-sm w-24 border-base-300 bg-base-200">
            <span class="text-[12px] text-base-content/45">
              USD · l'assistant s'arrête au plafond
              <template v-if="monthlyEstimate > 0"> · usage courant estimé {{ monthlyEstimate.toFixed(2) }} USD/mois</template>
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-2 pt-1">
            <button class="btn btn-sm admin-cta" :disabled="saving === 'llm'" @click="saveLlm">Enregistrer</button>
            <button class="btn btn-sm btn-outline" :disabled="testing" @click="testProvider">
              {{ testing ? 'Test...' : 'Tester la connexion' }}
            </button>
            <button v-if="selectedProvider.local" class="btn btn-sm btn-ghost" :disabled="testing" @click="findLocalRunners">
              Détecter les moteurs locaux
            </button>
            <span
              v-if="testResult"
              class="text-[12px]"
              :class="testResult.ok ? 'text-success' : 'text-error'"
            >
              {{ testResult.ok ? `OK en ${testResult.latencyMs} ms` : testResult.message }}
            </span>
          </div>

          <div v-if="localRunners.length" class="rounded-xl bg-base-200 p-2.5 text-[12px]">
            <p v-for="runner in localRunners" :key="runner.id" class="tabular">
              {{ runner.label }} sur {{ runner.url }} · {{ runner.models.length }} modèles
            </p>
          </div>

          <p class="pt-1 text-[11px] leading-relaxed text-base-content/40">
            La clé est écrite dans le SQLite local, jamais dans le navigateur. Avec un moteur local, aucune donnée
            de la maison ne quitte cette machine; avec un fournisseur hébergé, seules les phrases de la conversation
            et l'état des appareils cités partent vers son API.
          </p>
        </div>
      </section>

      <!-- Autonomy and proactivity -->
      <section id="autonomy" class="rounded-2xl border border-base-300 bg-base-100 p-4">
        <div class="mb-1 flex items-center gap-2">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-base-content/40">Initiative</h2>
          <span v-if="saved === 'proactivity'" class="text-[11px] text-success">enregistré</span>
        </div>
        <p class="mb-3 text-[12px] text-base-content/55">
          Le niveau d'autonomie se règle sur la page
          <NuxtLink to="/agent" class="underline">Assistant</NuxtLink>, à côté de ce qu'il gouverne.
          Ici: quand l'assistant a le droit de parler le premier.
        </p>

        <div class="space-y-2">
          <label class="flex items-start gap-3">
            <input
              v-model="agent.proactivity.suggestOnNewDevice"
              type="checkbox"
              class="toggle toggle-sm mt-0.5"
              @change="save('agent', { proactivity: { suggestOnNewDevice: agent.proactivity.suggestOnNewDevice } }, 'proactivity')"
            >
            <span class="text-[13px]">
              Proposer une routine quand un appareil apparaît
              <span class="block text-[11px] text-base-content/50">Le seul moment où vous pensez à cet appareil, donc le bon moment.</span>
            </span>
          </label>

          <label class="flex items-start gap-3">
            <input
              v-model="agent.proactivity.suggestRoutines"
              type="checkbox"
              class="toggle toggle-sm mt-0.5"
              @change="save('agent', { proactivity: { suggestRoutines: agent.proactivity.suggestRoutines } }, 'proactivity')"
            >
            <span class="text-[13px]">
              Chercher des habitudes dans l'historique
              <span class="block text-[11px] text-base-content/50">Trois soirs de suite à la même heure, et il vous le propose.</span>
            </span>
          </label>

          <label class="flex items-start gap-3">
            <input
              v-model="agent.proactivity.dailyBriefing"
              type="checkbox"
              class="toggle toggle-sm mt-0.5"
              @change="save('agent', { proactivity: { dailyBriefing: agent.proactivity.dailyBriefing } }, 'proactivity')"
            >
            <span class="flex-1 text-[13px]">
              Briefing du matin
              <span class="block text-[11px] text-base-content/50">Météo intérieure, batteries faibles, ce qui est resté allumé.</span>
            </span>
            <input
              v-model="agent.proactivity.briefingTime"
              type="time"
              class="input input-xs w-24 border-base-300 bg-base-200"
              @change="save('agent', { proactivity: { briefingTime: agent.proactivity.briefingTime } }, 'proactivity')"
            >
          </label>

          <div class="flex items-center gap-3 pt-1">
            <span class="w-28 shrink-0 text-[12px] text-base-content/60">Heures calmes</span>
            <input
              v-model="agent.proactivity.quietHours[0]"
              type="time"
              class="input input-xs w-24 border-base-300 bg-base-200"
              @change="save('agent', { proactivity: { quietHours: agent.proactivity.quietHours } }, 'proactivity')"
            >
            <span class="text-[12px] text-base-content/45">à</span>
            <input
              v-model="agent.proactivity.quietHours[1]"
              type="time"
              class="input input-xs w-24 border-base-300 bg-base-200"
              @change="save('agent', { proactivity: { quietHours: agent.proactivity.quietHours } }, 'proactivity')"
            >
            <span class="text-[12px] text-base-content/45">rien d'audible, rien de non sollicité</span>
          </div>

          <div class="flex items-center gap-3">
            <span class="w-28 shrink-0 text-[12px] text-base-content/60">Actions / heure</span>
            <input
              v-model.number="agent.proactivity.maxUnpromptedActionsPerHour"
              type="number"
              min="0"
              max="60"
              class="input input-xs w-20 border-base-300 bg-base-200"
              @change="save('agent', { proactivity: { maxUnpromptedActionsPerHour: agent.proactivity.maxUnpromptedActionsPerHour } }, 'proactivity')"
            >
            <span class="text-[12px] text-base-content/45">plafond d'actions spontanées, même en mode autonome</span>
          </div>
        </div>
      </section>

      <!-- Voice -->
      <section id="voice" class="rounded-2xl border border-base-300 bg-base-100 p-4">
        <h2 class="mb-1 text-xs font-semibold uppercase tracking-wider text-base-content/40">Voix</h2>
        <p class="mb-3 text-[12px] text-base-content/55">
          Réglage du navigateur: la reconnaissance et la synthèse tournent dans cet onglet, pas sur le hub.
        </p>

        <div class="space-y-2">
          <div class="flex items-center gap-3">
            <span class="w-28 shrink-0 text-[12px] text-base-content/60">Moteur</span>
            <div class="join">
              <button
                v-for="option in (['local', 'browser', 'off'] as const)"
                :key="option"
                class="btn btn-xs join-item"
                :class="voice.engine === option ? 'admin-cta' : 'btn-outline'"
                @click="voice.engine = option"
              >
                {{ option === 'local' ? 'Local (Whisper)' : option === 'browser' ? 'Navigateur' : 'Désactivé' }}
              </button>
            </div>
          </div>

          <label v-if="voice.engine === 'local'" class="flex items-center gap-3">
            <span class="w-28 shrink-0 text-[12px] text-base-content/60">Modèle STT</span>
            <select v-model="voice.sttModel" class="select select-sm flex-1 border-base-300 bg-base-200">
              <option v-for="model in STT_MODELS" :key="model.id" :value="model.id">
                {{ model.label }} · {{ model.size }}
              </option>
            </select>
          </label>
          <p v-if="voice.engine === 'local'" class="pl-31 text-[11px] text-base-content/45">
            {{ STT_MODELS.find((model) => model.id === voice.sttModel)?.note }}
            Le modèle se télécharge une fois puis reste en cache; l'audio ne sort jamais de la page.
          </p>

          <label class="flex items-center gap-3">
            <span class="w-28 shrink-0 text-[12px] text-base-content/60">Voix</span>
            <select v-model="voice.ttsVoice" class="select select-sm flex-1 border-base-300 bg-base-200">
              <option v-for="entry in TTS_VOICES" :key="entry.id" :value="entry.id">{{ entry.label }}</option>
            </select>
          </label>

          <label class="flex items-start gap-3">
            <input v-model="voice.speakReplies" type="checkbox" class="toggle toggle-sm mt-0.5">
            <span class="text-[13px]">
              Lire les réponses à voix haute
              <span class="block text-[11px] text-base-content/50">Respecte les heures calmes ci-dessus.</span>
            </span>
          </label>
        </div>

        <details class="mt-3">
          <summary class="cursor-pointer text-[12px] text-base-content/55">Comparatif des coûts vocaux</summary>
          <p class="mt-1 text-[11px] text-base-content/40">Tarifs relevés chez les éditeurs le {{ VOICE_PRICING_CHECKED_ON }}.</p>
          <table class="mt-2 w-full text-[11.5px]">
            <thead class="text-base-content/40">
              <tr class="border-b border-base-200">
                <th class="py-1 text-left font-medium">Option</th>
                <th class="py-1 text-right font-medium">STT / heure</th>
                <th class="py-1 text-right font-medium">TTS / min</th>
                <th class="py-1 text-right font-medium">Données</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in VOICE_PRICING" :key="row.id" class="border-b border-base-200 last:border-0">
                <td class="py-1 pr-2">
                  {{ row.label }}
                  <span class="block text-[10.5px] text-base-content/45">{{ row.note }}</span>
                </td>
                <td class="py-1 text-right tabular">{{ row.sttPerHour === null ? '-' : row.sttPerHour === 0 ? 'gratuit' : `${row.sttPerHour} USD` }}</td>
                <td class="py-1 text-right tabular">{{ row.ttsPerMinute === null ? '-' : row.ttsPerMinute === 0 ? 'gratuit' : `${row.ttsPerMinute} USD` }}</td>
                <td class="py-1 text-right" :class="row.privacy === 'local' ? 'text-success' : 'text-warning'">{{ row.privacy === 'local' ? 'locales' : 'envoyées' }}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </section>

      <!-- Privacy -->
      <section id="privacy" class="rounded-2xl border border-base-300 bg-base-100 p-4">
        <div class="mb-1 flex items-center gap-2">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-base-content/40">Confidentialité</h2>
          <span v-if="saved === 'privacy'" class="text-[11px] text-success">enregistré</span>
        </div>

        <div class="space-y-2">
          <label class="flex items-start gap-3">
            <input
              v-model="agent.privacy.localOnly"
              type="checkbox"
              class="toggle toggle-sm mt-0.5"
              @change="save('agent', { privacy: { localOnly: agent.privacy.localOnly } }, 'privacy')"
            >
            <span class="text-[13px]">
              Tout garder en local
              <span class="block text-[11px] text-base-content/50">Interdit tout fournisseur hébergé, même si une clé est enregistrée.</span>
            </span>
          </label>

          <label class="flex items-start gap-3">
            <input
              v-model="agent.privacy.shareDeviceNames"
              type="checkbox"
              class="toggle toggle-sm mt-0.5"
              @change="save('agent', { privacy: { shareDeviceNames: agent.privacy.shareDeviceNames } }, 'privacy')"
            >
            <span class="text-[13px]">
              Envoyer les noms d'appareils au modèle
              <span class="block text-[11px] text-base-content/50">Désactivé, le modèle voit des identifiants anonymes et perd en précision.</span>
            </span>
          </label>

          <div class="flex items-center gap-3">
            <span class="w-28 shrink-0 text-[12px] text-base-content/60">Conserver</span>
            <input
              v-model.number="agent.privacy.retainTranscriptsDays"
              type="number"
              min="0"
              max="365"
              class="input input-xs w-20 border-base-300 bg-base-200"
              @change="save('agent', { privacy: { retainTranscriptsDays: agent.privacy.retainTranscriptsDays } }, 'privacy')"
            >
            <span class="text-[12px] text-base-content/45">jours de conversations · 0 pour ne rien garder</span>
          </div>
        </div>

        <p class="mt-3 text-[11px] leading-relaxed text-base-content/40">
          Les adresses MAC ne sont jamais envoyées à un service en ligne: la table des constructeurs est embarquée.
          <NuxtLink to="/memory" class="underline">La mémoire</NuxtLink> est lisible et effaçable ligne par ligne.
        </p>
      </section>

      <!-- Energy -->
      <section id="energy" class="rounded-2xl border border-base-300 bg-base-100 p-4">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-base-content/40">Tarif électrique</h2>
          <span v-if="saved === 'energy'" class="text-[11px] text-success">enregistré</span>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-2">
            <span class="text-[12px] text-base-content/60">Prix du kWh</span>
            <input
              v-model.number="energy.pricePerKwh"
              type="number"
              step="0.0001"
              class="input input-sm w-28 border-base-300 bg-base-200"
              @change="save('energy', { pricePerKwh: energy.pricePerKwh }, 'energy')"
            >
          </label>
          <label class="flex items-center gap-2">
            <span class="text-[12px] text-base-content/60">Devise</span>
            <input
              v-model="energy.currency"
              class="input input-sm w-20 border-base-300 bg-base-200"
              @change="save('energy', { currency: energy.currency }, 'energy')"
            >
          </label>
          <label class="flex items-center gap-2">
            <span class="text-[12px] text-base-content/60">Puissance souscrite</span>
            <input
              v-model.number="energy.contractKva"
              type="number"
              class="input input-sm w-20 border-base-300 bg-base-200"
              @change="save('energy', { contractKva: energy.contractKva }, 'energy')"
            >
            <span class="text-[12px] text-base-content/45">kVA</span>
          </label>
        </div>
        <p class="mt-2 text-[11px] text-base-content/40">
          Tarif réglementé français au 1er février 2025: 0,2516 EUR/kWh en base.
        </p>
      </section>
    </div>

    <div v-else-if="loading" class="space-y-3">
      <div v-for="index in 4" :key="index" class="h-28 rounded-2xl skeleton-line" />
    </div>
  </div>
</template>
