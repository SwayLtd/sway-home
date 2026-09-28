<script setup lang="ts">
/**
 * AiDemoPromptBar - gallery demo for <AiPromptBar> (Beautiful UI, source 07).
 *
 * Two stages, Rounded and Pill, each run their own self-running walkthrough: open the @ menu
 * and narrow it by typing, close it, open the / menu the same way, then switch to the flagship
 * model to trigger glimm's rainbow sweep - the same structure and rough timing as
 * beautifului.dev's own AUTO_STEPS, driven here entirely through the component's public
 * `v-model` and `v-model:model` (menu visibility and filtering are derived from the text
 * itself inside AiPromptBar, exactly as they are in the source). Any real pointer or keyboard
 * interaction on a stage hands control to the person there; "Rejouer" restarts that stage.
 * Dictation is faked the way a real parent would own it: the demo flips its own `dictation`
 * ref and appends a mock transcript after a beat, matching the source's timing.
 */

const MENTIONS: PromptBarMention[] = [
  { id: 'lampe-salon', label: 'Lampe salon', kind: 'device' },
  { id: 'plafonnier-cuisine', label: 'Plafonnier cuisine', kind: 'device' },
  { id: 'thermostat', label: 'Thermostat', kind: 'device', hint: 'Salon' },
  { id: 'capteur-mouvement', label: 'Capteur de mouvement', kind: 'device', hint: 'Entrée' },
  { id: 'prise-bureau', label: 'Prise bureau', kind: 'device' },
  { id: 'serrure-entree', label: 'Serrure entrée', kind: 'device' },
  { id: 'camera-entree', label: 'Caméra entrée', kind: 'device' },
  { id: 'volet-chambre', label: 'Volet chambre', kind: 'device' },
  { id: 'salon', label: 'Salon', kind: 'area' },
  { id: 'cuisine', label: 'Cuisine', kind: 'area' },
  { id: 'chambre', label: 'Chambre', kind: 'area' },
  { id: 'bureau', label: 'Bureau', kind: 'area' },
  { id: 'entree', label: 'Entrée', kind: 'area' },
  { id: 'scene-cinema', label: 'Cinéma', kind: 'scene' },
  { id: 'scene-nuit', label: 'Nuit', kind: 'scene' },
  { id: 'scene-diner', label: 'Dîner', kind: 'scene' },
  { id: 'routine-reveil', label: 'Réveil en douceur', kind: 'routine' },
  { id: 'routine-depart', label: 'Départ de la maison', kind: 'routine' },
  { id: 'routine-arrosage', label: 'Arrosage du soir', kind: 'routine' },
]

const COMMANDS: PromptBarCommand[] = [
  { id: 'scene', label: '/scène', hint: 'Lancer une scène' },
  { id: 'routine', label: '/routine', hint: 'Lancer une routine' },
  { id: 'scan', label: '/scan', hint: 'Scanner le réseau' },
  { id: 'resume', label: '/résumé', hint: 'Résumer la maison' },
  { id: 'annuler', label: '/annuler', hint: 'Annuler la dernière action' },
  { id: 'nouvelle', label: '/nouvelle', hint: 'Nouvelle conversation' },
]

const MODELS: PromptBarModel[] = [
  { id: 'local', label: 'Moteur local', hint: 'Hors ligne' },
  { id: 'claude-sonnet-5', label: 'claude-sonnet-5', hint: 'Le plus capable', celebrate: true },
  { id: 'gpt-6-luna', label: 'gpt-6-luna', hint: 'Polyvalent' },
  { id: 'qwen3:8b', label: 'qwen3:8b', hint: 'Local, léger' },
]

const DICTATION_TRANSCRIPT = 'Allume la lampe du salon et lance la scène cinéma'

interface Step {
  text: string
  model?: string
  hold: number
}

/* same structure as the source's AUTO_STEPS: walk the @ menu, close it, walk the / menu,
   close it, then switch to the flagship model for the rainbow sweep, and loop */
const STEPS: Step[] = [
  { text: '', model: 'local', hold: 1100 },
  { text: '@', hold: 900 },
  { text: '@lampe', hold: 700 },
  { text: '@salon ', hold: 900 },
  { text: '', hold: 600 },
  { text: '/', hold: 900 },
  { text: '/sc', hold: 700 },
  { text: '/scène ', hold: 900 },
  { text: '', hold: 700 },
  { text: '', model: 'claude-sonnet-5', hold: 2600 },
  { text: '', hold: 900 },
]

function createStage(variant: PromptBarVariant) {
  return reactive({
    variant,
    text: '',
    model: (MODELS[0] ?? null) as PromptBarModel | null,
    dictation: 'idle' as PromptBarDictationState,
    auto: true,
    step: 0,
    lastSubmit: '',
    timer: null as ReturnType<typeof setTimeout> | null,
    dictationTimer: null as ReturnType<typeof setTimeout> | null,
  })
}
type Stage = ReturnType<typeof createStage>

const stages: Stage[] = [createStage('Rounded'), createStage('Pill')]

function runStep(stage: Stage) {
  if (!stage.auto) return
  const step = STEPS[stage.step % STEPS.length]!
  stage.text = step.text
  if (step.model) {
    const next = MODELS.find((m) => m.id === step.model)
    if (next) stage.model = next
  }
  stage.timer = setTimeout(() => {
    stage.step += 1
    runStep(stage)
  }, step.hold)
}

/* hand control to the person: stop the loop, and when they aim at the input itself, clear
   the demo's leftover draft for a clean start - same rule as the source's takeOver */
function stopAuto(stage: Stage, event: Event) {
  if (!stage.auto) return
  stage.auto = false
  if (stage.timer) {
    clearTimeout(stage.timer)
    stage.timer = null
  }
  if (event.target instanceof HTMLTextAreaElement) stage.text = ''
}

function restart(stage: Stage) {
  if (stage.timer) clearTimeout(stage.timer)
  if (stage.dictationTimer) clearTimeout(stage.dictationTimer)
  stage.step = 0
  stage.text = ''
  stage.model = MODELS[0] ?? null
  stage.dictation = 'idle'
  stage.auto = true
  runStep(stage)
}

function onDictate(stage: Stage) {
  if (stage.dictation === 'unavailable') return
  if (stage.dictation === 'listening') {
    stage.dictation = 'idle'
    if (stage.dictationTimer) {
      clearTimeout(stage.dictationTimer)
      stage.dictationTimer = null
    }
    return
  }
  stage.dictation = 'listening'
  stage.dictationTimer = setTimeout(() => {
    stage.text = stage.text ? `${stage.text.trimEnd()} ${DICTATION_TRANSCRIPT}` : DICTATION_TRANSCRIPT
    stage.dictation = 'idle'
    stage.dictationTimer = null
  }, 2200)
}

function onSubmit(stage: Stage, payload: PromptBarSubmitPayload) {
  stage.lastSubmit = payload.text || '(pièce jointe seule)'
  restart(stage)
}

onMounted(() => {
  for (const stage of stages) runStep(stage)
})
onBeforeUnmount(() => {
  for (const stage of stages) {
    if (stage.timer) clearTimeout(stage.timer)
    if (stage.dictationTimer) clearTimeout(stage.dictationTimer)
  }
})
</script>

<template>
  <section class="grid gap-4 lg:grid-cols-2">
    <div v-for="stage in stages" :key="stage.variant" class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-medium uppercase tracking-wider text-ink-3">{{ stage.variant }}</span>
        <AiButton size="xs" variant="secondary" @click="restart(stage)">Rejouer</AiButton>
      </div>
      <div class="flex min-h-64 flex-col justify-end gap-2 rounded-window bg-canvas p-6">
        <div @pointerdown.capture="stopAuto(stage, $event)" @keydown.capture="stopAuto(stage, $event)">
          <AiPromptBar
            v-model="stage.text"
            v-model:model="stage.model"
            :variant="stage.variant"
            :mentions="MENTIONS"
            :commands="COMMANDS"
            :models="MODELS"
            :dictation="stage.dictation"
            @dictate="onDictate(stage)"
            @submit="(payload) => onSubmit(stage, payload)"
          />
        </div>
        <p v-if="stage.lastSubmit" class="truncate text-[11px] text-ink-3">Dernier envoi : {{ stage.lastSubmit }}</p>
      </div>
    </div>
  </section>
</template>
