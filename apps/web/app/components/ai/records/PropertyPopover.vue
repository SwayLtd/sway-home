<script setup lang="ts">
/**
 * PROPERTY POPOVER - a RecordsTable column's configuration (Beautiful UI).
 *
 * Anchored under the clicked header by the parent (RecordsTable owns the fixed positioning via
 * `AiRecordsPopover`). Type, Tool and Inputs each open their own small radio/checkbox menu;
 * picking a value commits immediately (`update`), like the source.
 *
 * Beyond the source: the source never captures edits to the name or the contentEditable prompt,
 * only displays them - but a real AI property needs both to reach the hub (its label and its
 * instruction), so here the name is a real input and the prompt commits its plain text on blur
 * (a chip-carrying prompt, like the gallery demo's "Conseil" column, still displays its chip
 * until edited; editing always collapses it to plain text). A Choix row appears for a
 * single-select property, a comma list mapped to `column.options` on blur. The Tool menu accepts
 * `RecordsTableModelOption` entries too, disabling the ones the hub says cannot run right now.
 */
const props = defineProps<{
  column: RecordsTableColumn
  availableInputs: { key: string; label: string }[]
  models: (string | RecordsTableModelOption)[]
  pinned: boolean
  busy: boolean
  removable: boolean
}>()

const emit = defineEmits<{
  update: [patch: RecordsTableColumnPatch]
  run: []
  togglePin: []
  remove: []
}>()

const configMenu = ref<'type' | 'tool' | 'inputs' | null>(null)
const groundingHelpOpen = ref(false)
const moreSettingsOpen = ref(false)

function toggleMenu(menu: 'type' | 'tool' | 'inputs') {
  configMenu.value = configMenu.value === menu ? null : menu
}

const selectedInputs = computed(() => props.column.inputs ?? [])

function toggleInput(key: string) {
  const current = selectedInputs.value
  const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
  emit('update', { inputs: next })
}

/* Name and prompt: uncontrolled inputs, read on blur so an edit reaches the hub once per edit
 * rather than once per keystroke. */
function onLabelBlur(event: FocusEvent) {
  const value = (event.target as HTMLInputElement).value.trim()
  if (value && value !== props.column.label) emit('update', { label: value })
}
function onPromptBlur(event: FocusEvent) {
  const text = (event.target as HTMLElement).innerText.trim()
  emit('update', { prompt: text ? { before: text } : undefined })
}

/* Choix: a comma list for a single-select property's options. */
function onOptionsBlur(event: FocusEvent) {
  const labels = [...new Set((event.target as HTMLInputElement).value.split(',').map((entry) => entry.trim()).filter(Boolean))]
  emit('update', { options: recordsOptionsFromLabels(labels) })
}

function selectModel(model: string | RecordsTableModelOption) {
  if (!recordsModelAvailable(model)) return
  emit('update', { tool: recordsModelLabel(model), toolKind: 'model' })
  configMenu.value = null
}
</script>

<template>
  <div class="w-[320px] px-3 pt-3 pb-1.5">
    <input
      :value="column.label"
      type="text"
      placeholder="Nom de la colonne"
      aria-label="Nom de la colonne"
      class="mb-1 w-full rounded-[6px] bg-transparent px-0.5 pb-1.5 text-[13.5px] font-medium text-ink outline-none transition-colors duration-100 hover:bg-hover focus:bg-hover"
      @blur="onLabelBlur"
      @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
    >

    <!-- Type -->
    <div class="relative flex h-8 items-center justify-between">
      <span class="text-[13px] text-ink-3">Type</span>
      <button
        type="button"
        aria-haspopup="menu"
        :aria-expanded="configMenu === 'type'"
        class="flex items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-[13px] font-medium text-ink transition-colors duration-100 hover:bg-hover"
        @click="toggleMenu('type')"
      >
        <span class="text-ink-2"><Icon :name="recordsColumnIcon(column)" class="size-3.5" /></span>
        {{ RECORDS_PROPERTY_KIND_LABELS[column.kind] }}
        <span class="text-ink-3"><Icon name="ph:caret-right" class="size-3" /></span>
      </button>
      <div
        v-if="configMenu === 'type'"
        role="menu"
        aria-label="Type de propriété"
        class="absolute left-full top-0 z-30 ml-5 w-[210px] rounded-[12px] bg-surface p-1.5 shadow-overlay"
        style="animation: pop-in 140ms cubic-bezier(0.23, 1, 0.32, 1) both; transform-origin: top left"
      >
        <div class="px-2 pb-1 pt-0.5 text-[11.5px] font-medium text-ink-3">Type de propriété</div>
        <AiGlideMenu class="flex flex-col gap-px">
          <button
            v-for="kind in RECORDS_NEW_PROPERTY_KINDS"
            :key="kind"
            data-menu-row
            type="button"
            role="menuitemradio"
            :aria-checked="column.kind === kind"
            class="relative z-10 flex h-8 w-full items-center gap-1.5 rounded-[8px] px-1.5 text-left text-[13px] font-medium text-ink"
            @click="emit('update', { kind }); configMenu = null"
          >
            <span class="flex size-4 shrink-0 items-center justify-center text-ink-2"><Icon :name="RECORDS_PROPERTY_KIND_ICONS[kind]" class="size-3.5" /></span>
            <span class="min-w-0 flex-1 truncate">{{ RECORDS_PROPERTY_KIND_LABELS[kind] }}</span>
            <span :class="column.kind === kind ? 'text-ink' : 'invisible'"><Icon name="ph:check-bold" class="size-3.5" /></span>
          </button>
        </AiGlideMenu>
      </div>
    </div>

    <!-- Choix: only a single-select property needs them -->
    <div v-if="column.kind === 'single-select'" class="flex h-8 items-center justify-between gap-2">
      <span class="shrink-0 text-[13px] text-ink-3">Choix</span>
      <input
        :value="(column.options ?? []).map((option) => option.label).join(', ')"
        type="text"
        placeholder="Oui, Non"
        aria-label="Choix possibles, séparés par une virgule"
        class="min-w-0 flex-1 rounded-[6px] bg-transparent px-1.5 py-1 text-right text-[13px] text-ink outline-none transition-colors duration-100 hover:bg-hover focus:bg-hover"
        @blur="onOptionsBlur"
      >
    </div>

    <!-- Tool -->
    <div class="relative flex h-8 items-center justify-between">
      <span class="text-[13px] text-ink-3">Outil</span>
      <button
        type="button"
        aria-haspopup="menu"
        :aria-expanded="configMenu === 'tool'"
        class="flex items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-[13px] font-medium text-ink transition-colors duration-100 hover:bg-hover"
        @click="toggleMenu('tool')"
      >
        <span :class="column.toolKind === 'model' ? 'text-bui-accent' : 'text-ink-2'">
          <svg v-if="column.toolKind === 'model'" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 3l1.7 5.1a2 2 0 0 0 1.2 1.2L20 11l-5.1 1.7a2 2 0 0 0-1.2 1.2L12 19l-1.7-5.1a2 2 0 0 0-1.2-1.2L4 11l5.1-1.7a2 2 0 0 0 1.2-1.2z" />
          </svg>
          <Icon v-else :name="RECORDS_TOOL_KIND_ICONS[column.toolKind === 'user' || column.toolKind === 'device' ? column.toolKind : 'web']" class="size-3.5" />
        </span>
        {{ column.tool }}
        <span class="text-ink-3"><Icon name="ph:caret-right" class="size-3" /></span>
      </button>
      <div
        v-if="configMenu === 'tool'"
        role="menu"
        aria-label="Modèle"
        class="absolute left-full top-0 z-30 ml-5 w-[210px] rounded-[12px] bg-surface p-1.5 shadow-overlay"
        style="animation: pop-in 140ms cubic-bezier(0.23, 1, 0.32, 1) both; transform-origin: top left"
      >
        <div class="px-2 pb-1 pt-0.5 text-[11.5px] font-medium text-ink-3">Modèle</div>
        <AiGlideMenu class="flex flex-col gap-px">
          <button
            v-for="model in models"
            :key="recordsModelLabel(model)"
            data-menu-row
            type="button"
            role="menuitemradio"
            :aria-checked="column.tool === recordsModelLabel(model)"
            :aria-disabled="!recordsModelAvailable(model)"
            :disabled="!recordsModelAvailable(model)"
            :title="recordsModelReason(model)"
            class="relative z-10 flex min-h-8 w-full items-center gap-1.5 rounded-[8px] px-1.5 py-1 text-left text-[13px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-45"
            @click="selectModel(model)"
          >
            <span class="flex size-4 shrink-0 items-center justify-center text-ink-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 3l1.7 5.1a2 2 0 0 0 1.2 1.2L20 11l-5.1 1.7a2 2 0 0 0-1.2 1.2L12 19l-1.7-5.1a2 2 0 0 0-1.2-1.2L4 11l5.1-1.7a2 2 0 0 0 1.2-1.2z" />
              </svg>
            </span>
            <span class="min-w-0 flex-1 truncate">
              {{ recordsModelLabel(model) }}
              <span v-if="recordsModelReason(model)" class="block truncate text-[11px] font-normal text-ink-3">{{ recordsModelReason(model) }}</span>
            </span>
            <span :class="column.tool === recordsModelLabel(model) ? 'text-ink' : 'invisible'"><Icon name="ph:check-bold" class="size-3.5" /></span>
          </button>
        </AiGlideMenu>
      </div>
    </div>

    <!-- Grounding -->
    <div class="relative flex h-8 items-center justify-between">
      <span class="text-[13px] text-ink-3">Ancrage</span>
      <span class="flex items-center gap-2">
        <AiRecordsMiniSwitch :on="!!column.grounding" label="Ancrage" @toggle="emit('update', { grounding: !column.grounding })" />
        <button
          type="button"
          aria-label="À propos de l'ancrage"
          :aria-expanded="groundingHelpOpen"
          class="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
          @click="groundingHelpOpen = !groundingHelpOpen"
        >
          <Icon name="ph:info" class="size-3.5" />
        </button>
      </span>
      <div
        v-if="groundingHelpOpen"
        role="status"
        class="absolute right-0 top-[30px] z-30 w-[230px] rounded-[10px] px-3 py-2.5 text-[12px] leading-relaxed shadow-overlay"
        :style="{ color: 'var(--tooltip-fg)', background: 'var(--tooltip-bg)' }"
      >
        L'ancrage permet au modèle de vérifier les valeurs générées par rapport aux sources connectées.
      </div>
    </div>

    <!-- Inputs -->
    <div class="relative flex h-8 items-center justify-between">
      <span class="text-[13px] text-ink-3">Entrées</span>
      <button
        type="button"
        aria-haspopup="menu"
        :aria-expanded="configMenu === 'inputs'"
        class="flex max-w-[220px] items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-[13px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink"
        @click="toggleMenu('inputs')"
      >
        <span v-if="selectedInputs.length" class="flex min-w-0 items-center gap-1">
          <span v-for="key in selectedInputs.slice(0, 2)" :key="key" class="max-w-[92px] truncate rounded-[5px] bg-bui-accent-tint px-1.5 py-0.5 text-[12px] font-medium text-bui-accent-ink">
            {{ availableInputs.find((input) => input.key === key)?.label ?? key }}
          </span>
          <span v-if="selectedInputs.length > 2" class="text-[11px] font-medium text-ink-3">+{{ selectedInputs.length - 2 }}</span>
        </span>
        <span v-else>Sélectionner des entrées</span>
        <span class="shrink-0 text-ink-3"><Icon name="ph:caret-right" class="size-3" /></span>
      </button>
      <div
        v-if="configMenu === 'inputs'"
        role="menu"
        aria-label="Entrées du calcul"
        class="absolute left-full top-0 z-30 ml-5 w-[220px] rounded-[12px] bg-surface p-1.5 shadow-overlay"
        style="animation: pop-in 140ms cubic-bezier(0.23, 1, 0.32, 1) both; transform-origin: top left"
      >
        <div class="px-2 pb-1 pt-0.5 text-[11.5px] font-medium text-ink-3">Utiliser les valeurs de</div>
        <AiGlideMenu class="flex flex-col gap-px">
          <button
            v-for="input in availableInputs"
            :key="input.key"
            data-menu-row
            type="button"
            role="menuitemcheckbox"
            :aria-checked="selectedInputs.includes(input.key)"
            class="relative z-10 flex h-8 w-full items-center gap-1.5 rounded-[8px] px-1.5 text-left text-[13px] font-medium text-ink"
            @click="toggleInput(input.key)"
          >
            <span
              class="flex size-4 shrink-0 items-center justify-center rounded-[5px] border"
              :class="selectedInputs.includes(input.key) ? 'border-bui-accent bg-bui-accent text-primary-content' : 'border-line-strong text-transparent'"
            >
              <Icon name="ph:check-bold" class="size-3" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ input.label }}</span>
          </button>
        </AiGlideMenu>
      </div>
    </div>

    <!-- Prompt: commits its plain text on blur (see the doc comment above). -->
    <div
      contenteditable="true"
      role="textbox"
      :aria-label="`Invite de calcul pour ${column.label}`"
      aria-multiline="true"
      spellcheck="true"
      class="mt-2 min-h-[88px] cursor-text rounded-[10px] bg-inset p-3 text-[13px] leading-relaxed shadow-hairline outline-none transition-[box-shadow] duration-150 focus:shadow-[0_0_0_2px_var(--accent)]"
      @blur="onPromptBlur"
    >
      <span v-if="column.prompt" class="text-ink">
        {{ column.prompt.before }}<span v-if="column.prompt.chip" contenteditable="false" class="rounded-[5px] bg-bui-accent-tint px-1.5 py-0.5 text-[12px] font-medium text-bui-accent-ink">{{ column.prompt.chip }}</span>{{ column.prompt.after }}
      </span>
      <span v-else class="text-ink-3">Définissez une invite (tapez @ pour mentionner une entrée)</span>
    </div>

    <button
      type="button"
      :disabled="busy"
      class="mt-2.5 flex h-9 w-full items-center justify-center gap-2 rounded-[9px] text-[12.5px] font-medium text-ink shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.98] disabled:opacity-60"
      @click="emit('run')"
    >
      <Icon name="ph:arrow-clockwise" class="size-3.5" />
      Lancer le calcul
    </button>

    <AiGlideMenu class="mt-3 flex flex-col gap-0.5 border-t border-line pt-2" highlight-class="-inset-x-1.5 rounded-[8px] bg-hover">
      <button
        data-menu-row
        type="button"
        :aria-pressed="pinned"
        class="relative z-10 -mx-1.5 flex h-8 items-center gap-2.5 rounded-[8px] px-1.5 text-left text-[13px] leading-none text-ink transition-transform duration-150 active:scale-[0.96]"
        @click="emit('togglePin')"
      >
        <span :class="pinned ? 'text-bui-accent' : 'text-ink-2'"><Icon name="ph:push-pin" class="size-3.5" /></span>
        {{ pinned ? 'Détacher' : 'Épingler' }}
      </button>
      <button
        data-menu-row
        type="button"
        :aria-expanded="moreSettingsOpen"
        class="relative z-10 -mx-1.5 flex h-8 items-center gap-2.5 rounded-[8px] px-1.5 text-left text-[13px] leading-none text-ink transition-transform duration-150 active:scale-[0.96]"
        @click="moreSettingsOpen = !moreSettingsOpen"
      >
        <span :class="moreSettingsOpen ? 'text-ink' : 'text-ink-2'"><Icon name="ph:gear-six" class="size-3.5" /></span>
        <span class="flex-1">Plus de réglages</span>
        <span class="text-ink-3 transition-transform duration-150" :class="{ 'rotate-90': moreSettingsOpen }"><Icon name="ph:caret-right" class="size-3" /></span>
      </button>
      <button
        v-if="removable"
        data-menu-row
        type="button"
        class="relative z-10 -mx-1.5 flex h-8 items-center gap-2.5 rounded-[8px] px-1.5 text-left text-[13px] leading-none text-ink transition-transform duration-150 active:scale-[0.96]"
        @click="emit('remove')"
      >
        <span class="text-ink-2"><Icon name="ph:eye-slash" class="size-3.5" /></span>
        Masquer
      </button>
    </AiGlideMenu>

    <div v-if="moreSettingsOpen" class="mt-2 border-t border-line pt-2" style="animation: fade-up 160ms cubic-bezier(0.23, 1, 0.32, 1) both">
      <div class="pb-1 text-[11.5px] font-medium text-ink-3">Comportement</div>
      <div class="relative flex h-8 items-center justify-between">
        <span class="text-[13px] text-ink-3">Valeur requise</span>
        <AiRecordsMiniSwitch :on="!!column.required" label="Valeur requise" @toggle="emit('update', { required: !column.required })" />
      </div>
      <div class="relative flex h-8 items-center justify-between">
        <span class="text-[13px] text-ink-3">Autoriser les résultats vides</span>
        <AiRecordsMiniSwitch :on="column.allowEmpty !== false" label="Autoriser les résultats vides" @toggle="emit('update', { allowEmpty: column.allowEmpty === false })" />
      </div>
      <div class="relative flex h-8 items-center justify-between">
        <span class="text-[13px] text-ink-3">Afficher la confiance</span>
        <AiRecordsMiniSwitch :on="!!column.showConfidence" label="Afficher la confiance" @toggle="emit('update', { showConfidence: !column.showConfidence })" />
      </div>
    </div>
  </div>
</template>
