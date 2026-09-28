<script setup lang="ts">
/**
 * FINE-TUNE CARD - compact interactive inspector (Beautiful UI).
 *
 * Number fields scrub: hover the label for an <-> cursor and drag to adjust, use up/down
 * arrows (Shift for x10), or type directly. Select fields render as a segmented control
 * (`display: 'segment'`) or a glide-menu dropdown (`display: 'menu'`, the default).
 *
 * Props: `fields`, `labels?`. v-model of the values object (`modelValue`, uncontrolled -
 * self-managed from each field's own `value` - when omitted).
 * Emits: `update:modelValue(values)`, `change(key, value)` (debounce is the parent's job).
 */

const props = defineProps<{
  fields: FineTuneField[]
  modelValue?: FineTuneValues
  labels?: Partial<FineTuneCardLabels>
}>()

const emit = defineEmits<{
  'update:modelValue': [values: FineTuneValues]
  change: [key: string, value: number | string]
}>()

const t = computed(() => ({ ...FINE_TUNE_CARD_DEFAULT_LABELS, ...props.labels }))

const baseline = computed(() => fineTuneBaseline(props.fields))
const internalValues = ref<FineTuneValues>({ ...baseline.value, ...props.modelValue })
// A field added later (a different device selected) is seeded from its own baseline without
// clobbering values already edited for the fields already shown.
watch(
  () => props.fields.map((field) => field.key).join('|'),
  () => {
    internalValues.value = { ...baseline.value, ...internalValues.value }
  }
)

const values = computed<FineTuneValues>(() => props.modelValue ?? internalValues.value)

function setValue(key: string, value: number | string) {
  const next = { ...values.value, [key]: value }
  internalValues.value = next
  emit('update:modelValue', next)
  emit('change', key, value)
}

const anyChanged = computed(() => props.fields.some((field) => values.value[field.key] !== baseline.value[field.key]))

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size))
  return rows
}

const numberFields = computed(() => props.fields.filter((field): field is FineTuneNumberField => field.kind === 'number'))
const segmentFields = computed(() => props.fields.filter((field): field is FineTuneSelectField => field.kind === 'select' && field.display === 'segment'))
const menuFields = computed(() => props.fields.filter((field): field is FineTuneSelectField => field.kind === 'select' && (field.display ?? 'menu') === 'menu'))
const numberFieldPairs = computed(() => chunk(numberFields.value, 2))

/* number fields - drag the label to scrub, arrow keys (Shift x10), or type */
const drag = ref<{ key: string; x: number; v: number } | null>(null)

function onScrubStart(event: PointerEvent, field: FineTuneNumberField) {
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  drag.value = { key: field.key, x: event.clientX, v: Number(values.value[field.key] ?? field.value) }
}
function onScrubMove(event: PointerEvent, field: FineTuneNumberField) {
  if (!drag.value || drag.value.key !== field.key) return
  const step = field.step ?? 1
  setValue(field.key, fineTuneClamp(drag.value.v + ((event.clientX - drag.value.x) / 2) * step, field.min, field.max, step))
}
function onScrubEnd() {
  drag.value = null
}
function onScrubKey(event: KeyboardEvent, field: FineTuneNumberField) {
  const step = field.step ?? 1
  const mult = event.shiftKey ? 10 : 1
  const current = Number(values.value[field.key] ?? field.value)
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
    event.preventDefault()
    setValue(field.key, fineTuneClamp(current + step * mult, field.min, field.max, step))
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
    event.preventDefault()
    setValue(field.key, fineTuneClamp(current - step * mult, field.min, field.max, step))
  }
}
function onScrubInput(event: Event, field: FineTuneNumberField) {
  const raw = (event.target as HTMLInputElement).value
  const n = Number(raw.replace(/[^\d-]/g, ''))
  if (!Number.isNaN(n)) setValue(field.key, fineTuneClamp(n, field.min, field.max, field.step ?? 1))
}

/* segmented select fields */
function segmentIndex(field: FineTuneSelectField): number {
  const idx = field.options.findIndex((option) => option.value === values.value[field.key])
  return idx === -1 ? 0 : idx
}
function selectSegment(field: FineTuneSelectField, option: FineTuneOption) {
  setValue(field.key, option.value)
}

/* glide-menu dropdown select fields - one open at a time, closes on an outside click or Escape */
const openField = ref<string | null>(null)
const root = ref<HTMLElement | null>(null)

function toggleMenu(key: string) {
  openField.value = openField.value === key ? null : key
}
function selectMenuOption(field: FineTuneSelectField, option: FineTuneOption) {
  setValue(field.key, option.value)
  openField.value = null
}
function optionLabel(field: FineTuneSelectField): string {
  const match = field.options.find((option) => option.value === values.value[field.key])
  return match?.label ?? field.placeholder ?? t.value.placeholder
}
function onDocumentClick(event: MouseEvent) {
  if (openField.value && root.value && !root.value.contains(event.target as Node)) openField.value = null
}

onMounted(() => {
  if (import.meta.client) document.addEventListener('mousedown', onDocumentClick)
})
onBeforeUnmount(() => {
  if (import.meta.client) document.removeEventListener('mousedown', onDocumentClick)
})
</script>

<template>
  <div ref="root" class="relative w-full max-w-60 rounded-card bg-surface shadow-raised">
    <!-- header -->
    <div class="primitive-card-bar flex items-center justify-between border-b border-line">
      <span class="text-[13px] font-medium text-ink">{{ t.title }}</span>
      <span v-if="anyChanged" class="flex items-center gap-1.5 text-[12px] font-medium text-green" style="animation: pop-in 250ms cubic-bezier(0.23, 1, 0.32, 1) both">
        <Icon name="ph:check-bold" class="size-2.5" />
        {{ t.edited }}
      </span>
      <span v-else class="flex items-center gap-1.5">
        <span class="flex size-4.5 items-center justify-center rounded-[5px] border border-bui-accent/30 bg-bui-accent-tint">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="var(--accent)"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg>
        </span>
        <span
          class="bg-clip-text text-[12px] font-medium text-transparent"
          :style="{ backgroundImage: 'linear-gradient(90deg, var(--accent) 35%, var(--accent-ink) 50%, var(--accent) 65%)', backgroundSize: '200% 100%', animation: 'shimmer-text 1.4s linear infinite' }"
        >
          {{ t.adjust }}
        </span>
      </span>
    </div>

    <!-- scrub-able fields -->
    <div class="primitive-card-pad flex flex-col gap-2" :class="menuFields.length ? 'border-b border-line' : ''">
      <div v-for="field in segmentFields" :key="field.key" class="flex flex-col gap-2">
        <p class="text-[12.5px] font-medium text-ink">{{ field.label }}</p>
        <div class="relative grid rounded-control bg-field p-0.5" :style="{ gridTemplateColumns: `repeat(${field.options.length}, 1fr)` }">
          <span
            aria-hidden="true"
            class="absolute inset-y-0.5 rounded-[6px] bg-surface shadow-btn transition-transform duration-300"
            :style="{
              width: `calc((100% - 4px) / ${field.options.length})`,
              left: '2px',
              transform: `translateX(${segmentIndex(field) * 100}%)`,
              transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
            }"
          />
          <button
            v-for="(option, oi) in field.options"
            :key="option.value"
            type="button"
            :aria-label="option.label"
            :aria-pressed="oi === segmentIndex(field)"
            class="relative z-10 flex h-6 items-center justify-center gap-1 transition-colors duration-200"
            :class="oi === segmentIndex(field) ? 'text-bui-accent' : 'text-ink-3'"
            @click="selectSegment(field, option)"
          >
            <Icon v-if="option.icon" :name="option.icon" class="size-3" />
            <span v-else class="text-[10px] font-medium">{{ option.label }}</span>
          </button>
        </div>
      </div>

      <div v-for="(pair, ri) in numberFieldPairs" :key="ri" class="grid min-w-0 grid-cols-2 gap-2">
        <!-- a card with a single number (a thermostat's setpoint) gives it the whole row -->
        <label
          v-for="field in pair"
          :key="field.key"
          class="flex h-6.5 min-w-0 items-center gap-1 rounded-chip py-1 pl-0.5 pr-1 transition-[background-color,box-shadow] duration-200"
          :class="numberFields.length === 1 ? 'col-span-2' : ''"
          :style="{
            background: values[field.key] !== baseline[field.key] ? 'var(--accent-tint)' : 'var(--field)',
            boxShadow: values[field.key] !== baseline[field.key] ? '0 0 0 1px var(--accent)' : 'none',
          }"
        >
          <span
            role="slider"
            :aria-label="field.label"
            :aria-valuenow="Number(values[field.key])"
            :aria-valuemin="field.min"
            :aria-valuemax="field.max"
            tabindex="0"
            class="flex h-full shrink-0 cursor-ew-resize touch-none select-none items-center rounded-[4px] px-0.5 text-[12px] text-ink-3 hover:text-ink-2 focus-visible:text-bui-accent-ink focus-visible:outline-none"
            @pointerdown="onScrubStart($event, field)"
            @pointermove="onScrubMove($event, field)"
            @pointerup="onScrubEnd"
            @pointercancel="onScrubEnd"
            @keydown="onScrubKey($event, field)"
          >
            {{ field.label }}
          </span>
          <input
            inputmode="numeric"
            :value="values[field.key]"
            :aria-label="`Valeur ${field.label}`"
            class="min-w-0 flex-1 bg-transparent text-[12px] text-ink tabular-nums outline-none"
            @input="onScrubInput($event, field)"
          />
          <span v-if="field.unit" class="shrink-0 pr-0.5 text-[11.5px] text-ink-3">{{ field.unit }}</span>
        </label>
      </div>
    </div>

    <!-- dropdown select fields -->
    <div v-if="menuFields.length" class="primitive-card-footer flex flex-col gap-2">
      <div v-for="field in menuFields" :key="field.key" class="flex items-center justify-between">
        <span class="text-[12px] text-ink-3">{{ field.label }}</span>
        <div class="relative -mr-0.5 w-30">
          <button
            type="button"
            :aria-expanded="openField === field.key"
            class="flex h-6.5 w-full items-center justify-between rounded-chip bg-inset py-1 pl-2 pr-1 shadow-hairline transition-shadow duration-200 focus-visible:outline-none"
            :style="{ boxShadow: openField === field.key ? '0 0 0 1px var(--accent)' : undefined }"
            @click="toggleMenu(field.key)"
            @keydown.esc="openField = null"
          >
            <span class="text-[12px]" :class="values[field.key] ? 'text-ink' : 'text-ink-3'">{{ optionLabel(field) }}</span>
            <Icon name="ph:caret-down" class="size-2.5 text-ink-3 transition-transform duration-200" :style="{ transform: openField === field.key ? 'rotate(180deg)' : 'rotate(0)' }" />
          </button>

          <div
            v-if="openField === field.key"
            class="absolute bottom-8 right-0 z-10 w-30 rounded-[10px] bg-surface p-1 shadow-raised"
            style="animation: pop-in 200ms cubic-bezier(0.23, 1, 0.32, 1) both; transform-origin: bottom right"
          >
            <AiGlideMenu class="flex flex-col gap-px" highlight-class="inset-x-0 rounded-[6px] bg-field">
              <button
                v-for="option in field.options"
                :key="option.value"
                data-menu-row
                type="button"
                class="relative z-10 flex h-6.5 w-full items-center rounded-[6px] px-2 text-left text-[12.5px] text-ink"
                @click="selectMenuOption(field, option)"
              >
                {{ option.label }}
              </button>
            </AiGlideMenu>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
