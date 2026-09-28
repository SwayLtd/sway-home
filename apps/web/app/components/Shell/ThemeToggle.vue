<script setup lang="ts">
/**
 * Light, dark, or whatever the system says.
 *
 * The theme is set on `<html data-theme>` and nothing else in the app ever branches on it:
 * a component that reads the theme to pick a colour has the wrong token.
 */

type Mode = 'system' | 'light' | 'dark'

const mode = useState<Mode>('theme-mode', () => 'system')

function apply(next: Mode) {
  mode.value = next
  if (!import.meta.client) return
  localStorage.setItem('sway-theme', next)
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const theme = next === 'system' ? (prefersDark ? 'sway-dark' : 'sway') : next === 'dark' ? 'sway-dark' : 'sway'
  document.documentElement.setAttribute('data-theme', theme)
}

onMounted(() => {
  apply((localStorage.getItem('sway-theme') as Mode) ?? 'system')
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (mode.value === 'system') apply('system')
  })
})

const icon = computed(() => (mode.value === 'dark' ? 'ph:moon' : mode.value === 'light' ? 'ph:sun' : 'ph:circle-half-tilt'))
const label = computed(() => (mode.value === 'dark' ? 'Sombre' : mode.value === 'light' ? 'Clair' : 'Système'))

function cycle() {
  apply(mode.value === 'system' ? 'light' : mode.value === 'light' ? 'dark' : 'system')
}
</script>

<template>
  <button class="btn btn-ghost btn-sm btn-square" :title="`Thème : ${label}`" :aria-label="`Thème : ${label}`" @click="cycle">
    <Icon :name="icon" class="size-5" />
  </button>
</template>
