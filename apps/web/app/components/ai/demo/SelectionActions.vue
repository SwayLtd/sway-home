<script setup lang="ts">
/**
 * DEMO: AiSelectionActions - a real passage the visitor can select from. "Rejouer"
 * re-selects a sample phrase with the live Selection API (the same path a mouse drag takes),
 * so the bar appears without anyone having to drag-select by hand first. Picking an action
 * calls a local `transform` that fakes a hub round trip: a short delay, then a canned French
 * result, the same way the source always resolves to one scripted rewrite.
 */

const PASSAGE =
  "Le Salon consomme 4,2 kWh cette semaine, en hausse de 17 % par rapport à la semaine dernière. Le radiateur du Salon reste le principal poste de consommation, suivi par l'éclairage. La Chambre et la Cuisine restent stables sur la même période."

const SAMPLE_PHRASE = '4,2 kWh cette semaine, en hausse de 17 %'

const RESULTS: Record<string, string> = {
  explain: "Le Salon a consommé plus d'énergie cette semaine à cause du chauffage : les températures ont baissé, donc le radiateur a tourné plus longtemps.",
  improve: "Le Salon a consommé 4,2 kWh cette semaine, soit 17 % de plus que la semaine dernière, surtout à cause du chauffage.",
  shorten: 'Salon : 4,2 kWh cette semaine (+17 %), surtout le chauffage.',
  translate: 'The Living Room used 4.2 kWh this week, up 17% from last week, mostly from the heater.',
  custom: 'Voici une reformulation qui tient compte de votre demande.',
}

/** Fakes the hub: a short delay, then a canned French result per action - the same shape as
 *  the source's own always-scripted rewrite, just with one result per action instead of one
 *  for all of them. */
async function transform(_text: string, actionId: string, prompt?: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 900))
  if (actionId === 'custom' && prompt) return `${RESULTS.custom} ("${prompt}")`
  return RESULTS[actionId] ?? RESULTS.improve!
}

const passageRef = ref<HTMLElement | null>(null)
const replayKey = ref(0)
const lastEvent = ref('')

function selectSample() {
  nextTick(() => {
    const node = passageRef.value?.firstChild
    if (!node || node.nodeType !== Node.TEXT_NODE) return
    const text = node.textContent ?? ''
    const start = text.indexOf(SAMPLE_PHRASE)
    if (start === -1) return
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + SAMPLE_PHRASE.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
}

function replay() {
  replayKey.value += 1
  lastEvent.value = ''
  selectSample()
}

onMounted(selectSample)
</script>

<template>
  <section>
    <div class="mb-2 flex items-center justify-between gap-2">
      <p class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Sélection dans une réponse</p>
      <AiButton size="xs" variant="secondary" @click="replay">Rejouer</AiButton>
    </div>
    <div class="bg-canvas rounded-window p-6">
      <AiSelectionActions :key="replayKey" :transform="transform" @ask="lastEvent = `Envoyé à l'assistant : ${$event}`" @accept="lastEvent = `Gardé : ${$event.result}`">
        <p ref="passageRef" class="max-w-[460px] text-[13px] leading-relaxed text-ink">{{ PASSAGE }}</p>
      </AiSelectionActions>
    </div>
    <p class="mt-2 text-[11px] text-ink-3">Sélectionnez un passage du texte pour ouvrir la barre : Expliquer, Reformuler, Raccourcir, Traduire, ou un prompt libre.</p>
    <p class="mt-1 min-h-4 text-[11px] text-ink-3">{{ lastEvent }}</p>
  </section>
</template>
