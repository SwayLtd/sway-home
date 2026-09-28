<script setup lang="ts">
/**
 * APPROVAL CARD - human in the loop, one question at a time (Beautiful UI).
 *
 * The stack slides vertically as you move between questions (the card's height animates to
 * fit), the step counter rolls like an odometer, and the footer uses pill actions - a quiet
 * Passer and a dark Continuer with Entrée. Single-choice answers auto-advance; multi-select
 * waits for Continuer. Also used for a single yes/no confirmation of a critical action: pass
 * one question with two options and no `multiple`.
 *
 * Props: `questions`, `labels?`, `resettable?` (default true).
 * Emits: `submit(answers)`, `skip(questionId)`, `close`.
 */

const props = defineProps<{
  questions: ApprovalQuestion[]
  labels?: Partial<ApprovalCardLabels>
  resettable?: boolean
}>()

const emit = defineEmits<{
  submit: [answers: Record<string, ApprovalAnswer>]
  skip: [questionId: string]
  close: []
}>()

const t = computed(() => ({ ...APPROVAL_CARD_DEFAULT_LABELS, ...props.labels }))
const resettable = computed(() => props.resettable ?? true)

const SLIDE = '360ms cubic-bezier(0.22, 1, 0.36, 1)'
const ROLL_MS = 400

const qi = ref(0)
const answers = ref<Record<string, string[]>>({})
const custom = ref<Record<string, string>>({})
const sent = ref(false)
const open = ref(true)

const last = computed(() => qi.value === props.questions.length - 1)
const currentQuestion = computed<ApprovalQuestion | undefined>(() => props.questions[qi.value])

function questionAnswer(id: string): ApprovalAnswer {
  const picked = answers.value[id] ?? []
  return picked.length > 0 ? picked : (custom.value[id] ?? '')
}
function questionHasAnswer(id: string): boolean {
  return approvalHasAnswer(questionAnswer(id))
}
const hasAnswer = computed(() => questionHasAnswer(currentQuestion.value?.id ?? ''))

/* height/slide animation - measures the active question and tracks the stack to it */
let questionRefs: (HTMLElement | null)[] = []
function setQuestionRef(idx: number, el: Element | null) {
  questionRefs[idx] = el as HTMLElement | null
}
let measured = false
const viewportH = ref<number | undefined>(undefined)
const trackY = ref(0)
const animateHeight = ref(false)
// Until the first question is measured, only the active one is mounted, so the initial height
// is Q1's height - not every question stacked, which would flash full height then shrink.
const ready = ref(false)

function sync(withAnim: boolean) {
  const item = questionRefs[qi.value]
  if (!item) return
  const reduce = import.meta.client && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  viewportH.value = item.offsetHeight
  trackY.value = item.offsetTop
  animateHeight.value = withAnim && !reduce
}

watch(
  [qi, answers, custom, open, sent],
  () => {
    const withAnim = measured
    measured = true
    sync(withAnim)
    ready.value = true
  },
  { immediate: true, flush: 'post' }
)

watch(qi, (_value, _old, onCleanup) => {
  const id = requestAnimationFrame(() => sync(measured))
  onCleanup(() => cancelAnimationFrame(id))
})

/* odometer counter - "qi+1 / total" rolls its changed digits up or down */
const counterValue = computed(() => `${qi.value + 1} / ${props.questions.length}`)
const counterOld = ref(counterValue.value)
const counterNew = ref(counterValue.value)
const counterRolling = ref(false)
const counterShifted = ref(false)
const counterDir = ref<'up' | 'down'>('up')
let counterRaf1 = 0
let counterRaf2 = 0
let counterDoneTimer: ReturnType<typeof setTimeout> | null = null

watch(counterValue, (value, oldValue) => {
  if (oldValue === undefined || oldValue === value) return
  const fromN = Number.parseInt(oldValue, 10)
  const toN = Number.parseInt(value, 10)
  counterDir.value = Number.isFinite(fromN) && Number.isFinite(toN) && toN < fromN ? 'down' : 'up'
  counterOld.value = oldValue
  counterNew.value = value
  counterRolling.value = true
  counterShifted.value = false
  if (counterRaf1) cancelAnimationFrame(counterRaf1)
  if (counterRaf2) cancelAnimationFrame(counterRaf2)
  if (counterDoneTimer) clearTimeout(counterDoneTimer)
  counterRaf1 = requestAnimationFrame(() => {
    counterRaf2 = requestAnimationFrame(() => {
      counterShifted.value = true
    })
  })
  counterDoneTimer = setTimeout(() => {
    counterRolling.value = false
    counterOld.value = value
    counterShifted.value = false
  }, ROLL_MS)
})

const counterCells = computed(() => {
  const chars = (counterRolling.value ? counterNew.value : counterOld.value).split('')
  return chars.map((n, i) => {
    const o = counterOld.value[i] ?? ''
    const changed = counterRolling.value && o !== n
    const down = counterDir.value === 'down'
    return {
      key: `${i}-${o}-${n}`,
      n,
      changed,
      top: down ? n : o,
      bottom: down ? o : n,
      restY: down ? '0' : '-1em',
      startY: down ? '-1em' : '0',
    }
  })
})

let advanceTimer: ReturnType<typeof setTimeout> | null = null

function toggle(question: ApprovalQuestion, optionId: string) {
  const picked = answers.value[question.id] ?? []
  const next = question.multiple
    ? picked.includes(optionId)
      ? picked.filter((id) => id !== optionId)
      : [...picked, optionId]
    : [optionId]
  answers.value = { ...answers.value, [question.id]: next }

  if (!question.multiple) {
    custom.value = { ...custom.value, [question.id]: '' }
    if (advanceTimer) clearTimeout(advanceTimer)
    advanceTimer = setTimeout(() => {
      if (qi.value === props.questions.length - 1) send()
      else qi.value = Math.min(props.questions.length - 1, qi.value + 1)
    }, 480)
  }
}

function onCustomInput(question: ApprovalQuestion, value: string) {
  custom.value = { ...custom.value, [question.id]: value }
  if (!question.multiple) answers.value = { ...answers.value, [question.id]: [] }
}

function buildAnswers(): Record<string, ApprovalAnswer> {
  const out: Record<string, ApprovalAnswer> = {}
  for (const question of props.questions) {
    const answer = questionAnswer(question.id)
    if (approvalHasAnswer(answer)) out[question.id] = answer
  }
  return out
}

function goTo(next: number) {
  if (advanceTimer) clearTimeout(advanceTimer)
  qi.value = Math.min(Math.max(next, 0), props.questions.length - 1)
}

function send() {
  if (advanceTimer) clearTimeout(advanceTimer)
  sent.value = true
  emit('submit', buildAnswers())
}

function advance() {
  if (last.value) send()
  else goTo(qi.value + 1)
}

function skipCurrent() {
  const question = currentQuestion.value
  if (!question) return
  emit('skip', question.id)
  if (last.value) open.value = false
  else goTo(qi.value + 1)
}

function dismiss() {
  open.value = false
  emit('close')
}

function reopen() {
  open.value = true
}

function reset() {
  qi.value = 0
  answers.value = {}
  custom.value = {}
  sent.value = false
  open.value = true
  measured = false
}

onBeforeUnmount(() => {
  if (advanceTimer) clearTimeout(advanceTimer)
  if (counterRaf1) cancelAnimationFrame(counterRaf1)
  if (counterRaf2) cancelAnimationFrame(counterRaf2)
  if (counterDoneTimer) clearTimeout(counterDoneTimer)
})
</script>

<template>
  <button
    v-if="!open"
    type="button"
    class="rounded-control bg-surface px-3 py-2 text-[12.5px] font-medium text-ink shadow-btn transition-colors duration-150 hover:bg-hover"
    @click="reopen"
  >
    {{ t.reopen }}
  </button>

  <div v-else-if="sent" class="flex w-full max-w-80 items-center gap-3" style="animation: pop-in 260ms cubic-bezier(0.23, 1, 0.32, 1) both">
    <span class="inline-flex items-center gap-1.5 rounded-full bg-green-tint py-1 pl-1 pr-2.5 text-[12.5px] font-medium text-green">
      <span class="flex size-4.5 items-center justify-center rounded-full bg-green text-white">
        <Icon name="ph:check-bold" class="size-2.5" />
      </span>
      {{ t.sentMessage }}
    </span>
    <button v-if="resettable" type="button" class="text-[12px] font-medium text-ink-3 transition-colors duration-150 hover:text-ink" @click="reset">
      {{ t.startOver }}
    </button>
  </div>

  <div v-else class="w-full max-w-80">
    <div class="relative overflow-hidden rounded-card bg-surface shadow-card" style="animation: fade-up 380ms cubic-bezier(0.23, 1, 0.32, 1) both">
      <button
        type="button"
        :aria-label="t.dismiss"
        class="primitive-icon-button absolute right-2.5 top-2.5 z-10 text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
        @click="dismiss"
      >
        <Icon name="ph:x" class="size-3.5" />
      </button>

      <div class="primitive-card-pad">
        <!-- the question itself is the heading -->
        <div class="overflow-hidden" :style="{ height: viewportH !== undefined ? `${viewportH}px` : undefined, transition: animateHeight ? `height ${SLIDE}` : undefined }" aria-live="polite">
          <div
            class="flex flex-col gap-[26px]"
            :style="{
              transform: `translate3d(0, ${-trackY}px, 0)`,
              transition: animateHeight ? `transform ${SLIDE}` : undefined,
              willChange: 'transform',
            }"
          >
            <template v-for="(question, qIdx) in questions" :key="question.id">
              <div
                v-if="ready || qIdx === qi"
                :ref="(el) => setQuestionRef(qIdx, el as Element | null)"
                :aria-hidden="qIdx === qi ? undefined : true"
                :style="{
                  opacity: qIdx === qi ? 1 : 0,
                  transition: animateHeight ? `opacity ${SLIDE}` : undefined,
                  pointerEvents: qIdx === qi ? undefined : 'none',
                }"
              >
                <div class="pr-7 text-[14px] font-medium text-ink">{{ question.title }}</div>
                <p v-if="question.description" class="mt-1 text-[12px] text-ink-3">{{ question.description }}</p>

                <AiGlideMenu class="mt-2.5 flex flex-col gap-1" highlight-class="inset-x-0 rounded-control bg-hover">
                  <button
                    v-for="option in question.options"
                    :key="option.id"
                    type="button"
                    data-menu-row
                    :aria-pressed="(answers[question.id] ?? []).includes(option.id)"
                    :tabindex="qIdx === qi ? 0 : -1"
                    class="relative z-10 flex items-center gap-1.5 rounded-control py-1 pl-1 pr-2 text-left transition-colors duration-100"
                    @click="qIdx === qi && toggle(question, option.id)"
                  >
                    <span
                      class="flex size-4 shrink-0 items-center justify-center transition-colors duration-200"
                      :class="[
                        question.multiple ? 'rounded-[5px]' : 'rounded-full',
                        (answers[question.id] ?? []).includes(option.id) ? 'bg-ink text-canvas' : 'text-transparent shadow-[inset_0_0_0_1.5px_var(--line-strong)]',
                      ]"
                    >
                      <span
                        v-if="!question.multiple"
                        class="size-1.5 rounded-full bg-canvas transition-transform duration-200"
                        :style="{ transform: (answers[question.id] ?? []).includes(option.id) ? 'scale(1)' : 'scale(0)' }"
                      />
                      <Icon v-else name="ph:check-bold" class="size-3" />
                    </span>
                    <span class="text-[13px] leading-none transition-colors duration-200" :class="(answers[question.id] ?? []).includes(option.id) ? 'text-ink' : 'text-ink-2'">
                      {{ option.label }}
                    </span>
                    <span v-if="option.hint" class="ml-auto shrink-0 pl-2 text-[11px] text-ink-3">{{ option.hint }}</span>
                  </button>

                  <label v-if="question.allowOther" data-menu-row class="relative z-10 flex items-center gap-1.5 rounded-control py-1 pl-1 pr-2 transition-colors duration-100">
                    <input
                      :value="custom[question.id] ?? ''"
                      :tabindex="qIdx === qi ? 0 : -1"
                      :placeholder="t.otherPlaceholder"
                      aria-label="Réponse libre"
                      class="min-w-0 flex-1 bg-transparent pl-1.5 text-[13px] text-ink outline-none placeholder:text-ink-3"
                      @input="onCustomInput(question, ($event.target as HTMLInputElement).value)"
                      @keydown.enter.prevent="qIdx === qi && questionHasAnswer(question.id) && advance()"
                    />
                  </label>
                </AiGlideMenu>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- footer - step nav (rolling counter) + pill actions -->
      <div class="primitive-card-footer flex items-center justify-between gap-3">
        <div class="flex items-center gap-1 text-ink-3">
          <button
            type="button"
            aria-label="Question précédente"
            :disabled="qi <= 0"
            class="flex size-[18px] items-center justify-center rounded-[5px] transition-colors duration-100 enabled:hover:text-ink disabled:opacity-30"
            @click="goTo(qi - 1)"
          >
            <Icon name="ph:caret-up" class="size-3.5" />
          </button>
          <span class="inline-flex items-center text-[12px] font-medium tabular-nums text-ink-3" style="letter-spacing: -0.1px; line-height: 1">
            <span v-for="cell in counterCells" :key="cell.key">
              <span v-if="!cell.changed">{{ cell.n }}</span>
              <span v-else class="relative inline-block overflow-hidden" style="height: 1em; line-height: 1em; vertical-align: -0.05em">
                <span class="flex flex-col" :style="{ transition: 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)', transform: `translateY(${counterShifted ? cell.restY : cell.startY})` }">
                  <span style="height: 1em; line-height: 1em">{{ cell.top }}</span>
                  <span style="height: 1em; line-height: 1em">{{ cell.bottom }}</span>
                </span>
              </span>
            </span>
          </span>
          <button
            type="button"
            aria-label="Question suivante"
            :disabled="last"
            class="flex size-[18px] items-center justify-center rounded-[5px] transition-colors duration-100 enabled:hover:text-ink disabled:opacity-30"
            @click="goTo(qi + 1)"
          >
            <Icon name="ph:caret-down" class="size-3.5" />
          </button>
        </div>

        <div class="-mr-0.5 flex items-center gap-1.5">
          <AiButton variant="ghost" size="sm" @click="skipCurrent">{{ t.skip }}</AiButton>
          <AiButton variant="accent" size="sm" :disabled="!hasAnswer" @click="advance">{{ last ? t.send : t.continueLabel }}</AiButton>
        </div>
      </div>
    </div>
  </div>
</template>
