<script setup lang="ts">
/**
 * Integrations, and the compatibility matrix.
 *
 * The page shows two lists on purpose: what is implemented and running, and what the
 * capability model already covers but whose code is not written yet. Declaring the second
 * list is not padding - it is the roadmap in the one place that cannot go stale, and it
 * lets the reader see that "we do not speak Zigbee yet" is a known gap with a known answer
 * rather than a silence.
 */

interface AdapterRow {
  id: string
  name: string
  vendor: string
  transports: string[]
  capabilities: string[]
  zeroConfig: boolean
  cloud: boolean
  implemented: boolean
  declared?: boolean
  unlocks?: string
  requiresHardware?: string | null
  docsUrl?: string
  status: { health: string; deviceCount: number; message?: string }
  config: Record<string, unknown>
  /** Password fields that hold a value on the hub. The value itself never comes back. */
  secretsSet?: string[]
  enabled: boolean
  configSchema?: { key: string; label: string; type: string; required?: boolean; placeholder?: string; help?: string; default?: unknown; options?: { value: string; label: string }[] }[]
}

const adapters = ref<AdapterRow[]>([])
const loading = ref(true)
const configuring = ref<AdapterRow | null>(null)
const draft = ref<Record<string, unknown>>({})
const saving = ref(false)
const pairing = ref<{ ok: boolean; message: string } | null>(null)

async function load() {
  loading.value = true
  try {
    adapters.value = (await hubFetch<{ adapters: AdapterRow[] }>('/adapters')).adapters
  } finally {
    loading.value = false
  }
}
onMounted(load)

const live = computed(() => adapters.value.filter((adapter) => !adapter.declared))
const planned = computed(() => adapters.value.filter((adapter) => adapter.declared))

const HEALTH: Record<string, { label: string; class: string; icon: string }> = {
  ok: { label: 'Actif', class: 'text-success', icon: 'ph:check-circle-fill' },
  degraded: { label: 'Dégradé', class: 'text-warning', icon: 'ph:warning-circle-fill' },
  error: { label: 'Erreur', class: 'text-error', icon: 'ph:x-circle-fill' },
  disabled: { label: 'Désactivé', class: 'text-base-content/35', icon: 'ph:circle' },
  needs_setup: { label: 'À configurer', class: 'text-base-content/45', icon: 'ph:gear' },
}

async function toggle(adapter: AdapterRow) {
  await hubFetch(`/adapters/${adapter.id}/enable`, { method: 'POST', body: { enabled: !adapter.enabled } })
  await load()
}

function openConfig(adapter: AdapterRow) {
  configuring.value = adapter
  pairing.value = null
  draft.value = { ...adapter.config }
  for (const field of adapter.configSchema ?? []) {
    if (draft.value[field.key] === undefined && field.default !== undefined) draft.value[field.key] = field.default
  }
}

async function saveConfig() {
  if (!configuring.value) return
  saving.value = true
  try {
    await hubFetch(`/adapters/${configuring.value.id}/config`, { method: 'POST', body: draft.value })
    await load()
    configuring.value = null
  } finally {
    saving.value = false
  }
}

async function pair() {
  if (!configuring.value) return
  saving.value = true
  try {
    const body = pairingPin.value.trim() ? { ...draft.value, pin: pairingPin.value.trim() } : draft.value
    pairing.value = await hubFetch(`/adapters/${configuring.value.id}/pair`, { method: 'POST', body })
    pairingPin.value = ''
    if (pairing.value?.ok) await load()
  } finally {
    saving.value = false
  }
}

/** Adapters with a pairing flow, and what the person has to do for it. */
const PAIRING: Record<string, string> = {
  hue: "Appuyez sur le bouton rond du pont Hue, puis lancez l'appairage dans les trente secondes.",
  zigbee: "Ouvre le réseau Zigbee pendant quatre minutes : mettez ensuite l'appareil en mode appairage, il apparaîtra tout seul.",
  zwave: "Lance une inclusion Z-Wave. Pour une serrure ou tout appareil S2, saisissez d'abord les 5 chiffres soulignés sous son QR code.",
  webos: "Allumez le téléviseur LG, lancez l'appairage, puis acceptez la demande qui s'affiche à l'écran avec la télécommande.",
  samsungtv: "Allumez le téléviseur Samsung, lancez l'appairage, puis choisissez Autoriser sur l'écran avec la télécommande.",
  freebox: "Lancez l'appairage, puis validez sur l'écran de la Freebox Server avec la flèche de droite : la demande y reste quelques minutes.",
  onvif: "Renseignez l'identifiant et le mot de passe ci-dessus, puis appairez : ils sont essayés sur chaque caméra trouvée qui attend les siens, et sur les adresses listées.",
  matter: `Ouvrez la fenêtre d'appairage de l'appareil (dans l'application où il est déjà : "partager" ou "associer à une autre application" ; ou appareil remis en mode appairage, déjà sur le Wi-Fi ou le réseau Thread), puis saisissez son code : les 11 chiffres sous son QR code, ou le texte du QR ("MT:...").`,
  homekit: `Saisissez le code de configuration HomeKit de l'accessoire : les 8 chiffres imprimés dessus, sur sa notice ou son emballage (123-45-678), ou le texte de son QR code ("X-HM://..."). Il doit être allumé, sur le même réseau que le hub, et pas déjà dans l'app Maison : l'en retirer d'abord, ou le remettre à zéro.`,
}

/** Adapters whose pairing takes a code typed in, and what that code looks like. */
const PAIRING_CODE: Record<string, string> = {
  matter: 'Code : 1234-567-8901 ou MT:...',
  homekit: 'Code : 123-45-678 ou X-HM://...',
}

/** A code typed for the pairing (a Z-Wave S2 PIN, a Matter or HomeKit code), sent with the request only. */
const pairingPin = ref('')

const supportsPairing = computed(() => Boolean(configuring.value && PAIRING[configuring.value.id]))
</script>

<template>
  <div class="mx-auto max-w-7xl">
    <PageHeader
      title="Intégrations"
      :subtitle="`${live.filter((adapter) => adapter.status.health === 'ok').length} actives${planned.length > 0 ? ` · ${planned.length} au programme` : ''}`"
      :loading="loading"
      :breadcrumb="[{ label: 'Système' }, { label: 'Intégrations' }]"
    />

    <section class="mb-8">
      <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-base-content/40">Implémentées</h2>

      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <article
          v-for="adapter in live"
          :key="adapter.id"
          class="rounded-2xl border border-base-300 bg-base-100 p-4 transition-colors hover:border-base-content/20"
        >
          <div class="flex items-start gap-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-base-200">
              <Icon :name="adapter.cloud ? 'ph:cloud' : 'ph:house-line'" class="size-[18px]" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] font-semibold">{{ adapter.name }}</p>
              <p class="truncate text-[11px] text-base-content/50">{{ adapter.vendor }}</p>
            </div>
            <span class="flex shrink-0 items-center gap-1 text-[11px]" :class="HEALTH[adapter.status.health]?.class">
              <Icon :name="HEALTH[adapter.status.health]?.icon ?? 'ph:circle'" class="size-3.5" />
              {{ HEALTH[adapter.status.health]?.label ?? adapter.status.health }}
            </span>
          </div>

          <p v-if="adapter.status.message" class="mt-2 line-clamp-2 text-[12px] text-base-content/60">{{ adapter.status.message }}</p>

          <div class="mt-3 flex flex-wrap gap-1">
            <span v-for="transport in adapter.transports" :key="transport" class="rounded-full bg-base-200 px-2 py-0.5 text-[10px] text-base-content/60">
              {{ transport }}
            </span>
            <span v-if="!adapter.cloud" class="rounded-full bg-success/15 px-2 py-0.5 text-[10px] text-success">local</span>
            <span v-if="adapter.zeroConfig" class="rounded-full bg-base-200 px-2 py-0.5 text-[10px] text-base-content/60">sans configuration</span>
          </div>

          <p class="mt-2 text-[11px] text-base-content/45">
            {{ adapter.capabilities.length }} capacités · {{ adapter.status.deviceCount }} appareil{{ adapter.status.deviceCount > 1 ? 's' : '' }}
          </p>

          <div class="mt-3 flex items-center gap-2 border-t border-base-200 pt-3">
            <button
              class="relative h-6 w-10 shrink-0 rounded-full transition-colors"
              :class="adapter.enabled ? 'bg-primary' : 'bg-base-300'"
              :aria-label="adapter.enabled ? 'Désactiver' : 'Activer'"
              @click="toggle(adapter)"
            >
              <span class="absolute top-0.5 size-5 rounded-full bg-base-100 shadow-sm transition-[left] duration-200" :class="adapter.enabled ? 'left-[1.125rem]' : 'left-0.5'" />
            </button>
            <button v-if="adapter.configSchema?.length" class="btn btn-xs btn-ghost" @click="openConfig(adapter)">Configurer</button>
            <div class="flex-1" />
            <a v-if="adapter.docsUrl" :href="adapter.docsUrl" target="_blank" rel="noopener noreferrer" class="row-action grid size-7 place-items-center rounded-full hover:bg-base-200">
              <Icon name="ph:arrow-square-out" class="size-3.5" />
              <span class="sr-only">Documentation (nouvel onglet)</span>
            </a>
          </div>
        </article>
      </div>
    </section>

    <section v-if="planned.length > 0">
      <h2 class="mb-1 text-xs font-semibold uppercase tracking-wider text-base-content/40">Au programme</h2>
      <p class="mb-3 max-w-2xl text-[12px] text-base-content/50">
        Le modèle de capacités couvre déjà ces protocoles: c'est le code de l'adaptateur qui manque, pas le vocabulaire.
        Chaque ligne dit ce qu'elle débloque et ce qu'elle demande.
      </p>

      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <article
          v-for="adapter in planned"
          :key="adapter.id"
          class="rounded-2xl border border-dashed border-base-300 p-4"
        >
          <div class="flex items-start gap-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-base-200 text-base-content/40">
              <Icon name="ph:puzzle-piece" class="size-[18px]" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-[13px] font-semibold">{{ adapter.name }}</p>
              <p class="truncate text-[11px] text-base-content/50">{{ adapter.vendor }}</p>
            </div>
          </div>

          <p class="mt-2 text-[12px] text-base-content/65">{{ adapter.unlocks }}</p>

          <p v-if="adapter.requiresHardware" class="mt-2 flex items-start gap-1.5 text-[11px] text-warning">
            <Icon name="ph:cpu" class="mt-0.5 size-3.5 shrink-0" />
            {{ adapter.requiresHardware }}
          </p>

          <div class="mt-3 flex flex-wrap gap-1">
            <span v-for="transport in adapter.transports" :key="transport" class="rounded-full bg-base-200 px-2 py-0.5 text-[10px] text-base-content/50">
              {{ transport }}
            </span>
          </div>

          <p class="mt-2 text-[11px] text-base-content/40">{{ adapter.capabilities.length }} capacités prévues</p>
        </article>
      </div>
    </section>

    <!-- Configuration drawer -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-150 ease-out"
        leave-active-class="transition duration-100 ease-in"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div v-if="configuring" class="fixed inset-0 z-[95] bg-base-content/20" @click.self="configuring = null">
          <div class="absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-base-100 shadow-2xl">
            <div class="flex h-12 items-center gap-2 border-b border-base-200 px-4">
              <span class="text-[13px] font-semibold">{{ configuring.name }}</span>
              <div class="flex-1" />
              <button class="btn btn-ghost btn-xs btn-square" @click="configuring = null">
                <Icon name="ph:x" class="size-4" />
              </button>
            </div>

            <div class="flex-1 space-y-4 overflow-y-auto p-4 thin-scroll">
              <div v-for="field in configuring.configSchema ?? []" :key="field.key">
                <label class="block">
                  <span class="text-[13px] text-base-content/70">
                    {{ field.label }}
                    <span v-if="field.required" class="text-error">*</span>
                  </span>

                  <select
                    v-if="field.type === 'select'"
                    v-model="draft[field.key]"
                    class="select select-sm mt-1 w-full border-base-300 bg-base-200"
                  >
                    <option v-for="option in field.options ?? []" :key="option.value" :value="option.value">{{ option.label }}</option>
                  </select>

                  <label v-else-if="field.type === 'boolean'" class="mt-1 flex items-center gap-3">
                    <input v-model="draft[field.key]" type="checkbox" class="toggle toggle-sm">
                  </label>

                  <textarea
                    v-else-if="field.type === 'text'"
                    :value="typeof draft[field.key] === 'string' ? draft[field.key] as string : ''"
                    rows="8"
                    spellcheck="false"
                    :placeholder="field.placeholder"
                    class="textarea textarea-sm mt-1 w-full border-base-300 bg-base-200 font-mono text-[12px] leading-relaxed"
                    @input="draft[field.key] = ($event.target as HTMLTextAreaElement).value"
                  />

                  <input
                    v-else
                    v-model="draft[field.key]"
                    :type="field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'"
                    :placeholder="field.type === 'password' && configuring?.secretsSet?.includes(field.key) ? 'Enregistré, laisser vide pour le garder' : field.placeholder"
                    class="input input-sm mt-1 w-full border-base-300 bg-base-200"
                  >
                </label>
                <p v-if="field.help" class="mt-1 text-[11px] text-base-content/50">{{ field.help }}</p>
              </div>

              <div v-if="supportsPairing" class="rounded-xl border border-base-300 bg-base-200 p-3">
                <p class="text-[13px] font-medium">Appairage</p>
                <p class="mt-0.5 text-[12px] text-base-content/60">{{ PAIRING[configuring!.id] }}</p>
                <input
                  v-if="configuring!.id === 'zwave'"
                  v-model="pairingPin"
                  inputmode="numeric"
                  maxlength="5"
                  placeholder="PIN S2 (5 chiffres, facultatif)"
                  class="input input-sm mt-2 w-full border-base-300 bg-base-100"
                >
                <input
                  v-if="PAIRING_CODE[configuring!.id]"
                  v-model="pairingPin"
                  maxlength="120"
                  autocomplete="off"
                  :placeholder="PAIRING_CODE[configuring!.id]"
                  class="input input-sm mt-2 w-full border-base-300 bg-base-100"
                >
                <button class="btn btn-sm admin-cta mt-2 w-full" :disabled="saving" @click="pair">
                  Appairer maintenant
                </button>
                <p v-if="pairing" class="mt-2 text-[12px]" :class="pairing.ok ? 'text-success' : 'text-error'">
                  {{ pairing.message }}
                </p>
              </div>

              <p class="text-[11px] text-base-content/45">
                Les identifiants sont stockés dans la base locale du hub et ne quittent jamais cette machine.
              </p>
            </div>

            <div class="flex gap-2 border-t border-base-200 p-3">
              <button class="btn btn-sm btn-ghost flex-1" @click="configuring = null">Annuler</button>
              <button class="btn btn-sm admin-cta flex-1" :disabled="saving" @click="saveConfig">Enregistrer</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
