<script setup lang="ts">
/**
 * AGENT SCREEN - a live viewer (Beautiful UI).
 *
 *   default   the resting card is a framed capture; hover reveals an "Ouvrir" pill; opening it
 *             expands to a full-width viewer where the teach-a-task button starts a teach-by
 *             -demonstration recording, collapsing keeps it running behind a REC badge, and
 *             "Terminer" ends it.
 *   Loading   a connecting placeholder (spinner on black) instead of the capture, in both the
 *             resting card and the expanded viewer.
 *
 * Real use: `src` is a camera snapshot URL the parent refreshes every few seconds, or a live
 * video URL. With no `src` a neutral room-from-a-camera illustration is drawn instead of the
 * source's static placeholder image, which is not available here.
 *
 * `recording` is a plain prop, not a v-model: starting or stopping a teach-by-demonstration
 * capture is a real call to the hub, so the component only signals intent (`record`, `stop`)
 * and waits to be told the true state, the same way a tool call's result flows back as a prop
 * rather than being guessed locally.
 */

const SCREEN_ASPECT = 'aspect-[2964/1856]'

const props = withDefaults(
  defineProps<{
    /** Image or video URL. Absent: draw the neutral placeholder. */
    src?: string
    title?: string
    /** Shows an "En direct" badge when there is no recording in progress. */
    live?: boolean
    recording?: boolean
    variant?: AgentScreenVariant
    /** When the current recording actually started, so the timer survives a remount. */
    startedAt?: number
  }>(),
  {
    src: undefined,
    title: 'Écran',
    live: false,
    recording: false,
    variant: 'default',
    startedAt: undefined,
  }
)

const emit = defineEmits<{ record: []; stop: [] }>()

const open = defineModel<boolean>('open', { default: false })

const loading = computed(() => props.variant === 'Loading')
const isVideo = computed(() => (props.src ? agentScreenIsVideoSrc(props.src) : false))

/* the resting frame takes the source's own shape once it has loaded: a camera draws its name
 * and clock near the edges, and covering the kit's screen shape with a 16:9 feed cut them off.
 * Kept across `src` changes (a snapshot URL changes every refresh) so the frame never jumps. */
const sourceAspect = ref<number | null>(null)
function onSourceLoad(event: Event) {
  const media = event.target as HTMLImageElement | HTMLVideoElement
  const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth
  const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight
  if (width > 0 && height > 0) sourceAspect.value = width / height
}
const frameShape = computed(() => (props.src && sourceAspect.value && !loading.value ? { class: '', style: { aspectRatio: String(sourceAspect.value) } } : { class: SCREEN_ASPECT, style: undefined }))

/* ---- recording timer: ticks while `recording` is true, survives a remount via `startedAt` */

const elapsedSeconds = ref(0)
let recordTimer: ReturnType<typeof setInterval> | null = null

watch(
  () => props.recording,
  (recording) => {
    if (recordTimer) {
      clearInterval(recordTimer)
      recordTimer = null
    }
    if (!recording) {
      elapsedSeconds.value = 0
      return
    }
    const origin = props.startedAt ?? Date.now()
    elapsedSeconds.value = Math.max(0, Math.floor((Date.now() - origin) / 1000))
    recordTimer = setInterval(() => {
      elapsedSeconds.value += 1
    }, 1000)
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  if (recordTimer) clearInterval(recordTimer)
})

const elapsedLabel = computed(() => agentScreenFormatElapsed(elapsedSeconds.value))

function startTeaching() {
  emit('record')
}
function endTeaching() {
  emit('stop')
}

/* ---- expanded viewer: Esc to close, scroll lock while open ------------- */

function openViewer() {
  if (loading.value) return
  open.value = true
}
function closeViewer() {
  open.value = false
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeViewer()
}
watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('keydown', onKeydown)
    document.body.style.overflow = 'hidden'
  } else {
    document.removeEventListener('keydown', onKeydown)
    document.body.style.overflow = ''
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (open.value) document.body.style.overflow = ''
})

/* a branded pointer standing in for the system cursor ([cursor:none] on the viewer), tracked
 * live so two people looking at the same feed can point at something in it together */
const cursorPos = ref<{ x: number; y: number } | null>(null)
function onScreenMouseMove(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  cursorPos.value = { x: event.clientX - rect.left, y: event.clientY - rect.top }
}
function onScreenMouseLeave() {
  cursorPos.value = null
}

/* connecting spinner geometry (Loading variant), same ring as LoadingState/TaskRows */
const SPINNER_SIZE = 26
const SPINNER_STROKE = 2
const SPINNER_R = (SPINNER_SIZE - SPINNER_STROKE) / 2
const SPINNER_C = 2 * Math.PI * SPINNER_R
</script>

<template>
  <div class="w-full max-w-[340px]">
    <!-- resting card - hover/click scoped to the frame only -->
    <div
      class="group/screen relative overflow-hidden rounded-window bg-inset shadow-card transition-shadow duration-150"
      :class="[frameShape.class, loading ? '' : 'cursor-pointer hover:shadow-raised']"
      :style="[{ animation: 'fade-up 380ms cubic-bezier(0.23, 1, 0.32, 1) both' }, frameShape.style]"
      @click="openViewer"
    >
      <!-- connecting -->
      <div v-if="loading" class="absolute inset-0 bg-black">
        <span class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <svg :width="SPINNER_SIZE" :height="SPINNER_SIZE" class="block" style="animation: spin 1.1s linear infinite" aria-hidden="true">
            <circle :cx="SPINNER_SIZE / 2" :cy="SPINNER_SIZE / 2" :r="SPINNER_R" fill="none" stroke="rgba(255,255,255,0.18)" :stroke-width="SPINNER_STROKE" />
            <circle
              :cx="SPINNER_SIZE / 2"
              :cy="SPINNER_SIZE / 2"
              :r="SPINNER_R"
              fill="none"
              stroke="#fff"
              :stroke-width="SPINNER_STROKE"
              stroke-linecap="round"
              :stroke-dasharray="`${SPINNER_C * 0.28} ${SPINNER_C * 0.72}`"
            />
          </svg>
        </span>
        <span class="absolute inset-x-0 text-center text-[12.5px] font-medium text-white/70" style="top: calc(50% + 28px)">Connexion en cours</span>
      </div>

      <template v-else>
        <div class="absolute inset-0 overflow-hidden bg-inset">
          <video v-if="src && isVideo" :src="src" autoplay muted loop playsinline class="absolute inset-0 h-full w-full object-cover" @loadedmetadata="onSourceLoad" />
          <img v-else-if="src" :src="src" alt="" class="absolute inset-0 h-full w-full object-cover" @load="onSourceLoad" />
          <svg v-else class="absolute inset-0 h-full w-full" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <rect width="320" height="200" fill="var(--inset)" />
            <rect x="0" y="0" width="320" height="132" fill="var(--field)" />
            <polygon points="0,132 320,132 258,200 62,200" fill="var(--line-soft)" />
            <rect x="36" y="28" width="72" height="52" rx="4" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="2" />
            <rect x="140" y="42" width="26" height="18" rx="2" fill="none" stroke="var(--line-strong)" stroke-width="1.5" />
            <rect x="266" y="18" width="42" height="114" rx="3" fill="var(--surface)" stroke="var(--line)" stroke-width="2" />
            <rect x="178" y="96" width="104" height="34" rx="10" fill="var(--line-strong)" />
            <rect x="184" y="86" width="26" height="20" rx="8" fill="var(--line-strong)" />
            <rect x="252" y="86" width="26" height="20" rx="8" fill="var(--line-strong)" />
            <g stroke="var(--ink-3)" stroke-width="2" opacity="0.35" fill="none">
              <path d="M10 10 L10 24 M10 10 L24 10" />
              <path d="M310 10 L310 24 M310 10 L296 10" />
              <path d="M10 190 L10 176 M10 190 L24 190" />
              <path d="M310 190 L310 176 M310 190 L296 190" />
            </g>
          </svg>
        </div>

        <!-- status overlay: recording takes priority over the ambient live badge -->
        <div v-if="recording" class="absolute left-2 top-2 z-10 inline-flex items-center gap-1.5 rounded-full bg-red-tint py-0.5 pl-1.5 pr-2 text-[11px] font-medium tabular-nums text-red">
          <span class="size-2 rounded-full bg-red" style="animation: records-pulse 1.1s ease-in-out infinite" />
          REC {{ elapsedLabel }}
        </div>
        <div v-else-if="live" class="absolute left-2 top-2 z-10 inline-flex items-center gap-1.5 rounded-full bg-surface/90 py-0.5 pl-1.5 pr-2 text-[11px] font-medium text-ink shadow-hairline">
          <span class="size-1.5 rounded-full bg-green" />
          En direct
        </div>

        <!-- hover reveal - the source's blue accent button is ink here, like every primary action -->
        <div class="absolute inset-0 flex items-center justify-center bg-[rgba(17,19,24,0)] transition-colors duration-150 group-hover/screen:bg-[rgba(17,19,24,0.18)]">
          <span class="translate-y-1 opacity-0 transition duration-150 group-hover/screen:translate-y-0 group-hover/screen:opacity-100">
            <AiButton variant="accent" size="sm" @click.stop="openViewer">
              <Icon name="ph:corners-out" class="size-[14px]" />
              Ouvrir
            </AiButton>
          </span>
        </div>
      </template>
    </div>

    <div class="mt-2.5 truncate px-0.5 text-[13px] font-medium text-ink">{{ title }}</div>

    <!-- expanded viewer -->
    <Teleport to="body">
      <div v-if="open" class="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6" role="dialog" aria-modal="true" :aria-label="title">
        <!-- a fixed scrim, not a token: it sits over arbitrary video content, not app chrome.
             This codebase has no Tailwind `dark:` variant wired to [data-theme=sway-dark]
             (see ai.css / app.css), so a single opacity is used for both themes. -->
        <div class="absolute inset-0 bg-black/65" style="animation: fade-in 180ms ease-out both" @click="closeViewer" />

        <div class="relative flex max-h-full flex-col overflow-hidden rounded-[16px] bg-surface p-2 pt-0 shadow-overlay" style="animation: pop-in 240ms cubic-bezier(0.23, 1, 0.32, 1) both">
          <div class="flex h-11 shrink-0 items-center justify-between gap-3 px-1.5">
            <div class="flex min-w-0 items-center gap-2">
              <span class="truncate text-[13px] font-semibold text-ink">{{ title }}</span>
              <span v-if="recording" class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-red-tint py-0.5 pl-1.5 pr-2 text-[11.5px] font-medium tabular-nums text-red">
                <span class="size-2 rounded-full bg-red" style="animation: records-pulse 1.1s ease-in-out infinite" />
                {{ elapsedLabel }}
              </span>
            </div>

            <div class="flex shrink-0 items-center gap-1.5">
              <button
                v-if="recording"
                type="button"
                class="inline-flex h-[27px] items-center gap-1.5 rounded-full bg-red pl-2.5 pr-3 text-[13px] font-medium leading-none text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] transition-[transform,filter] duration-150 ease-out hover:brightness-95 active:scale-[0.96]"
                @click="endTeaching"
              >
                <span class="size-2.5 rounded-[2px] bg-white" />
                Terminer
              </button>
              <AiButton v-else variant="secondary" size="sm" class="gap-1 pl-1.5" @click="startTeaching">
                <Icon name="ph:record" class="size-[15px]" />
                Apprendre une tâche
              </AiButton>

              <button type="button" aria-label="Réduire" class="primitive-icon-button text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink" @click="closeViewer">
                <Icon name="ph:corners-in" class="size-[15px]" />
              </button>
            </div>
          </div>

          <div class="relative min-h-0 overflow-hidden rounded-[8px] bg-inset [cursor:none]" @mousemove="onScreenMouseMove" @mouseleave="onScreenMouseLeave">
            <div v-if="loading" :class="[SCREEN_ASPECT, 'relative']" style="width: min(960px, 90vw)">
              <div class="absolute inset-0 bg-black">
                <span class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                  <svg :width="SPINNER_SIZE" :height="SPINNER_SIZE" class="block" style="animation: spin 1.1s linear infinite" aria-hidden="true">
                    <circle :cx="SPINNER_SIZE / 2" :cy="SPINNER_SIZE / 2" :r="SPINNER_R" fill="none" stroke="rgba(255,255,255,0.18)" :stroke-width="SPINNER_STROKE" />
                    <circle
                      :cx="SPINNER_SIZE / 2"
                      :cy="SPINNER_SIZE / 2"
                      :r="SPINNER_R"
                      fill="none"
                      stroke="#fff"
                      :stroke-width="SPINNER_STROKE"
                      stroke-linecap="round"
                      :stroke-dasharray="`${SPINNER_C * 0.28} ${SPINNER_C * 0.72}`"
                    />
                  </svg>
                </span>
                <span class="absolute inset-x-0 text-center text-[12.5px] font-medium text-white/70" style="top: calc(50% + 28px)">Connexion en cours</span>
              </div>
            </div>

            <template v-else>
              <video v-if="src && isVideo" :src="src" autoplay muted loop playsinline class="block h-auto w-auto object-contain" style="max-height: calc(100vh - 150px); max-width: min(960px, 90vw)" />
              <img v-else-if="src" :src="src" alt="" class="block h-auto w-auto object-contain" style="max-height: calc(100vh - 150px); max-width: min(960px, 90vw)" />
              <div v-else :class="[SCREEN_ASPECT, 'relative']" style="width: min(960px, 90vw)">
                <svg class="absolute inset-0 h-full w-full" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
                  <rect width="320" height="200" fill="var(--inset)" />
                  <rect x="0" y="0" width="320" height="132" fill="var(--field)" />
                  <polygon points="0,132 320,132 258,200 62,200" fill="var(--line-soft)" />
                  <rect x="36" y="28" width="72" height="52" rx="4" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="2" />
                  <rect x="140" y="42" width="26" height="18" rx="2" fill="none" stroke="var(--line-strong)" stroke-width="1.5" />
                  <rect x="266" y="18" width="42" height="114" rx="3" fill="var(--surface)" stroke="var(--line)" stroke-width="2" />
                  <rect x="178" y="96" width="104" height="34" rx="10" fill="var(--line-strong)" />
                  <rect x="184" y="86" width="26" height="20" rx="8" fill="var(--line-strong)" />
                  <rect x="252" y="86" width="26" height="20" rx="8" fill="var(--line-strong)" />
                  <g stroke="var(--ink-3)" stroke-width="2" opacity="0.35" fill="none">
                    <path d="M10 10 L10 24 M10 10 L24 10" />
                    <path d="M310 10 L310 24 M310 10 L296 10" />
                    <path d="M10 190 L10 176 M10 190 L24 190" />
                    <path d="M310 190 L310 176 M310 190 L296 190" />
                  </g>
                </svg>
              </div>

              <svg
                v-if="cursorPos"
                class="pointer-events-none absolute z-10"
                width="30"
                height="30"
                viewBox="0 0 24 24"
                fill="#111318"
                stroke="#fff"
                stroke-width="1.4"
                stroke-linejoin="round"
                aria-hidden="true"
                :style="{ left: `${cursorPos.x}px`, top: `${cursorPos.y}px`, filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,0.35))' }"
              >
                <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
              </svg>
            </template>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
