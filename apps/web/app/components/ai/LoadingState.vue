<script setup lang="ts">
/**
 * LOADING STATE - pixel-grid loader for long-running work (Beautiful UI).
 *
 *   Drive   square cells, a chevron wavefront driving right; the 650 ms cycle is shorter than
 *           the sweep, so two fronts are always in flight
 *   Dots    the same wavefront, circular cells
 *   Orbit   a comet lapping the grid perimeter
 *   Surfer  the Drive loader with a meme video below it
 *
 * A shimmering label and a live elapsed timer in tabular figures go with it. Reduced motion
 * freezes the grid to its dim state; the timer still ticks. Without a variant, the one chosen
 * in Réglages is used.
 */
import type { LoaderVariant } from '~/composables/useAiPreferences'

const props = withDefaults(
  defineProps<{
    label?: string
    variant?: LoaderVariant
    /** The Surfer variant's video: Beautiful UI's own, heavily compressed (about 265 KB). */
    videoSrc?: string
    /** When the work started, so the timer survives a re-render; now by default. */
    startedAt?: number
  }>(),
  { videoSrc: 'https://95dnc2a95qgwt9ff.public.blob.vercel-storage.com/subway-surfers-min.mp4' }
)

const { preferences } = useAiPreferences()
const chosen = computed<LoaderVariant>(() => props.variant ?? preferences.value.loader)

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3)
  const c = i % 3
  return (c + Math.abs(r - 1)) * 90
})
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3]
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i)
  return k === -1 ? null : k * 110
})
const PATTERNS: Record<'Drive' | 'Dots' | 'Orbit', { delays: (number | null)[]; dur: number; round: boolean }> = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
}

const surfer = computed(() => chosen.value === 'Surfer')
const pattern = computed(() => (surfer.value ? PATTERNS.Drive : PATTERNS[chosen.value as 'Drive' | 'Dots' | 'Orbit'] ?? PATTERNS.Drive))
const resolvedLabel = computed(() => props.label ?? (surfer.value ? 'Subway surfing' : 'Réfléchit'))
const videoOk = ref(true)

const origin = ref(props.startedAt ?? Date.now())
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 100)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
watch(
  () => props.startedAt,
  (value) => {
    if (value) origin.value = value
  }
)
const elapsed = computed(() => {
  const total = Math.max(0, Math.floor((now.value - origin.value) / 100)) / 10
  if (total < 60) return `${total.toFixed(1)}s`
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`
})
</script>

<template>
  <div role="status" class="flex w-fit" :class="surfer ? 'flex-col items-start' : 'items-center gap-2.5'">
    <div class="flex items-center gap-2.5">
      <span aria-hidden="true" class="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
        <span
          v-for="(delay, index) in pattern.delays"
          :key="index"
          class="size-[4px] bg-ink"
          :class="pattern.round ? 'rounded-full' : 'rounded-[1px]'"
          :style="{
            opacity: delay === null ? 0.07 : 0.15,
            animation: delay === null ? 'none' : `pixel-on ${pattern.dur}ms ease-in-out ${delay}ms infinite`,
          }"
        />
      </span>
      <span
        class="bg-clip-text text-[13px] font-medium text-transparent"
        :style="{
          backgroundImage: 'linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)',
          backgroundSize: '200% 100%',
          animation: 'shimmer-text 1.4s linear infinite',
        }"
      >
        {{ resolvedLabel }}
      </span>
      <span class="font-mono text-[12px] tabular-nums text-ink-3">{{ elapsed }}</span>
    </div>

    <!-- The context card follows the status text it illustrates. -->
    <div
      v-if="surfer"
      class="mt-2 w-56 overflow-hidden rounded-[10px] shadow-overlay"
      :style="{ animation: 'pop-in 200ms cubic-bezier(0.16,1,0.3,1) both', transformOrigin: 'top left' }"
    >
      <div class="relative aspect-video w-full" :style="{ background: 'var(--tooltip-bg)' }">
        <video v-if="videoOk" :src="videoSrc" autoplay muted loop playsinline class="h-full w-full object-cover" @error="videoOk = false" />
        <div v-else class="flex h-full w-full flex-col items-center justify-center gap-1.5">
          <span aria-hidden="true" class="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
            <span
              v-for="(delay, index) in PATTERNS.Drive.delays"
              :key="index"
              class="size-[4px] rounded-[1px] bg-ink"
              :style="{ opacity: 0.15, animation: `pixel-on 650ms ease-in-out ${delay}ms infinite` }"
            />
          </span>
          <span class="px-3 text-center font-mono text-[10px]" :style="{ color: 'var(--tooltip-muted)' }">Vidéo indisponible</span>
        </div>
      </div>
    </div>
  </div>
</template>
