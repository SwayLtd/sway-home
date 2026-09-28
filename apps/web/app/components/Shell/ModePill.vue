<script setup lang="ts">
/**
 * House mode, in the header because it changes what every routine does.
 *
 * It is a segmented control rather than a dropdown: the modes are few, they are the things
 * a reader switches between most, and a dropdown would hide the current one behind a click.
 */

const { house } = useHouse()

const MODES = [
  { id: 'home', label: 'Maison', icon: 'ph:house' },
  { id: 'away', label: 'Absent', icon: 'ph:door' },
  { id: 'night', label: 'Nuit', icon: 'ph:moon' },
  { id: 'guest', label: 'Invités', icon: 'ph:users-three' },
  { id: 'vacation', label: 'Vacances', icon: 'ph:airplane-tilt' },
  { id: 'party', label: 'Soirée', icon: 'ph:confetti' },
  { id: 'focus', label: 'Focus', icon: 'ph:target' },
  { id: 'cinema', label: 'Cinéma', icon: 'ph:film-slate' },
  { id: 'cleaning', label: 'Ménage', icon: 'ph:broom' },
]

const open = ref(false)
const current = computed(() => MODES.find((mode) => mode.id === house.value?.mode) ?? MODES[0]!)
const saving = ref(false)

async function choose(mode: string) {
  open.value = false
  if (mode === house.value?.mode) return
  saving.value = true
  try {
    await hubFetch('/house/mode', { method: 'POST', body: { mode } })
    if (house.value) house.value.mode = mode
  } finally {
    saving.value = false
  }
}

const root = ref<HTMLElement | null>(null)
onClickOutside(root, () => (open.value = false))
</script>

<template>
  <div ref="root" class="relative">
    <button
      class="btn btn-ghost btn-sm gap-2 text-[13px] font-normal"
      :disabled="saving"
      @click="open = !open"
    >
      <Icon :name="current.icon" class="size-4" />
      <span class="hidden sm:inline">{{ current.label }}</span>
      <Icon name="ph:caret-down" class="size-3 opacity-50" />
    </button>

    <Transition
      enter-active-class="transition duration-100 ease-out"
      leave-active-class="transition duration-75 ease-in"
      enter-from-class="opacity-0 -translate-y-1"
      leave-to-class="opacity-0 -translate-y-1"
    >
      <div
        v-if="open"
        class="absolute right-0 top-full z-50 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
      >
        <p class="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-base-content/40">
          Mode de la maison
        </p>
        <button
          v-for="mode in MODES"
          :key="mode.id"
          class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] transition-colors"
          :class="mode.id === house?.mode ? 'bg-primary/25 font-medium' : 'hover:bg-base-200'"
          @click="choose(mode.id)"
        >
          <Icon :name="mode.icon" class="size-4" />
          {{ mode.label }}
          <Icon v-if="mode.id === house?.mode" name="ph:check" class="ml-auto size-4" />
        </button>
      </div>
    </Transition>
  </div>
</template>
