<script setup lang="ts">
/**
 * Demo gallery for AiCodeBlock: the "Réveil en douceur" routine as JSON (Code), and the diff
 * of that routine after an edit - trigger time moved earlier, a new action added (Diff).
 */

const routineBefore = {
  id: 'reveil-en-douceur',
  name: 'Réveil en douceur',
  trigger: { type: 'time', at: '07:00' },
  conditions: [{ type: 'day', in: ['lun', 'mar', 'mer', 'jeu', 'ven'] }],
  actions: [
    { device: 'lampe-salon', set: { power: true, brightness: 20 } },
    { device: 'thermostat', set: { target: 20.5 } },
  ],
}
const routineAfter = {
  ...routineBefore,
  trigger: { type: 'time', at: '06:45' },
  actions: [...routineBefore.actions, { device: 'volet-chambre', set: { position: 100 } }],
}

const routineBeforeJson = JSON.stringify(routineBefore, null, 2)
const routineAfterJson = JSON.stringify(routineAfter, null, 2)

const copiedText = ref('')
function onCopy(text: string) {
  copiedText.value = `Copié (${text.length} caractères)`
}
</script>

<template>
  <section class="grid gap-4 lg:grid-cols-2">
    <div class="flex flex-col gap-2">
      <span class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Code - routine JSON</span>
      <div class="flex items-center justify-center bg-canvas rounded-window p-6">
        <AiCodeBlock variant="Code" :code="routineBeforeJson" language="json" filename="reveil-en-douceur.json" @copy="onCopy" />
      </div>
      <p class="min-h-4 text-[11.5px] text-ink-3">{{ copiedText }}</p>
    </div>

    <div class="flex flex-col gap-2">
      <span class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Diff - routine modifiée</span>
      <div class="flex items-center justify-center bg-canvas rounded-window p-6">
        <AiCodeBlock variant="Diff" :before="routineBeforeJson" :after="routineAfterJson" language="json" filename="reveil-en-douceur.json" />
      </div>
    </div>
  </section>
</template>
