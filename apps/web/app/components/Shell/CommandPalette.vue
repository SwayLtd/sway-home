<script setup lang="ts">
/**
 * ⌘K.
 *
 * One field over three kinds of target: a device (with its primary action inline), a page,
 * and a sentence for the assistant. Anything typed that matches nothing is not an error -
 * it is a question, and Enter sends it to the agent. That removes the dead end a search box
 * usually has.
 */

const { commandPaletteOpen, toggleDock } = useShell()
const { devices, areaById } = useHouse()
const { send } = useCommands()
const router = useRouter()

const query = ref('')
const index = ref(0)
const field = ref<HTMLInputElement | null>(null)

const items: NavItem[] = navigationItems()

interface Row {
  kind: 'device' | 'page' | 'ask' | 'action'
  id: string
  label: string
  hint?: string
  icon: string
  run: () => void | Promise<void>
}

function normalise(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

const rows = computed<Row[]>(() => {
  const text = normalise(query.value.trim())
  const out: Row[] = []

  if (text.length > 0) {
    for (const device of devices.value) {
      const area = device.areaId ? areaById.value.get(device.areaId)?.name ?? '' : ''
      if (!normalise(`${device.name} ${area} ${device.model ?? ''}`).includes(text)) continue
      out.push({
        kind: 'device',
        id: device.id,
        label: device.name,
        hint: `${area || 'sans pièce'} · ${stateSummary(device)}`,
        icon: CATEGORY_ICON[device.category] ?? 'ph:question',
        run: () => void router.push(`/devices/${device.id}`),
      })
      if (out.length > 8) break
    }
  }

  for (const item of items) {
    if (text.length > 0 && !normalise(item.label).includes(text)) continue
    out.push({ kind: 'page', id: item.to, label: item.label, icon: item.icon, hint: 'Page', run: () => void router.push(item.to) })
  }

  if (text.length > 0) {
    out.push({
      kind: 'ask',
      id: 'ask',
      label: `Demander : ${query.value.trim()}`,
      icon: 'ph:sparkle',
      hint: "L'assistant lit l'état réel et agit",
      run: () => {
        toggleDock('agent')
        askAgent(query.value.trim())
      },
    })
  } else {
    out.unshift(
      { kind: 'action', id: 'all-off', label: 'Tout éteindre', icon: 'ph:power', hint: 'Toutes les lumières et prises', run: () => sendAllOff() },
      { kind: 'action', id: 'scan', label: 'Scanner le réseau', icon: 'ph:broadcast', run: () => hubFetch('/scan', { method: 'POST', body: { quick: true } }) },
      { kind: 'action', id: 'undo', label: 'Annuler la dernière action', icon: 'ph:arrow-counter-clockwise', run: () => hubFetch('/house/undo', { method: 'POST' }) }
    )
  }

  return out.slice(0, 14)
})

async function sendAllOff() {
  await hubFetch('/devices/command', { method: 'POST', body: { capability: 'onoff', command: 'turnOff' } })
}

function askAgent(text: string) {
  // The chat component owns the conversation; this drops the question into it.
  const pending = useState<string | null>('agent-pending-question')
  pending.value = text
}

watch(commandPaletteOpen, async (open) => {
  if (!open) return
  query.value = ''
  index.value = 0
  await nextTick()
  field.value?.focus()
})

watch(query, () => (index.value = 0))

function move(delta: number) {
  const count = rows.value.length
  if (count === 0) return
  index.value = (index.value + delta + count) % count
}

async function run() {
  const row = rows.value[index.value]
  if (!row) return
  commandPaletteOpen.value = false
  await row.run()
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-100 ease-out"
      leave-active-class="transition duration-75 ease-in"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="commandPaletteOpen"
        class="fixed inset-0 z-[100] bg-base-content/20 p-4 backdrop-blur-sm"
        @click.self="commandPaletteOpen = false"
      >
        <div
          class="mx-auto mt-[12vh] w-full max-w-xl overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-2xl"
          role="dialog"
          aria-label="Recherche et commandes"
        >
          <div class="flex items-center gap-2 border-b border-base-200 px-3">
            <Icon name="ph:magnifying-glass" class="size-4 shrink-0 text-base-content/40" />
            <input
              ref="field"
              v-model="query"
              type="text"
              placeholder="Un appareil, une page, ou une question"
              class="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-base-content/35"
              @keydown.down.prevent="move(1)"
              @keydown.up.prevent="move(-1)"
              @keydown.enter.prevent="run"
              @keydown.esc="commandPaletteOpen = false"
            >
            <kbd class="rounded border border-base-300 px-1 font-mono text-[10px] text-base-content/40">esc</kbd>
          </div>

          <ul class="max-h-80 overflow-y-auto p-1.5 thin-scroll">
            <li v-for="(row, position) in rows" :key="row.kind + row.id">
              <button
                class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors"
                :class="position === index ? 'bg-primary/25' : 'hover:bg-base-200'"
                @mouseenter="index = position"
                @click="run"
              >
                <Icon :name="row.icon" class="size-4 shrink-0 text-base-content/55" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[13px]">{{ row.label }}</span>
                  <span v-if="row.hint" class="block truncate text-[11px] text-base-content/45">{{ row.hint }}</span>
                </span>
                <Icon v-if="position === index" name="ph:arrow-elbow-down-left" class="size-3.5 shrink-0 text-base-content/35" />
              </button>
            </li>
            <li v-if="rows.length === 0" class="px-2 py-6 text-center text-[13px] text-base-content/45">
              Rien ne correspond.
            </li>
          </ul>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
