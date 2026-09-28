<script setup lang="ts">
/**
 * Demo gallery for AiFineTuneCard: a light, fine tuned live - luminosité (scrub %),
 * température de couleur (scrub K), transition (scrub s), ambiance (segmented control) and
 * scène (glide-menu dropdown select) - covering every control kind the source has.
 */

const lightFields: FineTuneField[] = [
  { key: 'brightness', kind: 'number', label: 'Luminosité', value: 80, min: 1, max: 100, step: 1, unit: '%' },
  { key: 'colorTemp', kind: 'number', label: 'Température', value: 4000, min: 2200, max: 6500, step: 50, unit: 'K' },
  { key: 'transition', kind: 'number', label: 'Transition', value: 2, min: 0, max: 10, step: 1, unit: 's' },
  {
    key: 'ambiance',
    kind: 'select',
    label: 'Ambiance',
    value: 'neutre',
    display: 'segment',
    options: [
      { value: 'doux', label: 'Doux' },
      { value: 'neutre', label: 'Neutre' },
      { value: 'vif', label: 'Vif' },
    ],
  },
  {
    key: 'scene',
    kind: 'select',
    label: 'Scène',
    value: '',
    placeholder: 'Aucune',
    options: [
      { value: 'cinema', label: 'Cinéma' },
      { value: 'nuit', label: 'Nuit' },
      { value: 'diner', label: 'Dîner' },
    ],
  },
]

const lightValues = ref<FineTuneValues>({ ...fineTuneBaseline(lightFields) })
const changeLog = ref<string[]>([])

function onChange(key: string, value: number | string) {
  changeLog.value = [`${key} = ${value}`, ...changeLog.value].slice(0, 5)
}

function replayLight() {
  lightValues.value = { ...fineTuneBaseline(lightFields) }
  changeLog.value = []
}
</script>

<template>
  <section>
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-medium uppercase tracking-wider text-ink-3">Lampe salon</span>
        <AiButton size="xs" variant="secondary" @click="replayLight">Rejouer</AiButton>
      </div>
      <div class="flex items-center justify-center bg-canvas rounded-window p-6">
        <AiFineTuneCard :fields="lightFields" v-model="lightValues" :labels="{ title: 'Lampe salon' }" @change="onChange" />
      </div>
      <ul class="flex min-h-16 flex-col gap-0.5 text-[11.5px] text-ink-3">
        <li v-for="line in changeLog" :key="line">{{ line }}</li>
      </ul>
    </div>
  </section>
</template>
