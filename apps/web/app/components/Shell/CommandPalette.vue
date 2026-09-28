<script setup lang="ts">
/**
 * ⌘K.
 *
 * One field over three kinds of target: a device (with its primary action inline), a page,
 * and a sentence for the assistant. Anything typed that matches nothing is not an error -
 * it is a question, and Enter sends it to the agent. That removes the dead end a search box
 * usually has.
 *
 * The list itself is AiSearch: it already groups, highlights and moves a keyboard-active
 * row, arrow keys included. `rows` below stays the one place that decides *what* can be
 * found and in what order - AiSearch is told `:filter="false"` and only renders it, since
 * its own accent-insensitive label match is narrower than the device search (name, area,
 * model) this palette already does.
 */

const { commandPaletteOpen, toggleDock } = useShell()
const { devices, areaById } = useHouse()
const { send } = useCommands()
const router = useRouter()

const query = ref('')
// A structural type rather than `InstanceType<typeof AiSearch>`: AiSearch is a global,
// auto-imported component, not a value this script otherwise imports.
const search = ref<{ focus: () => void } | null>(null)

const items: NavItem[] = navigationItems()

interface Row {
  kind: 'device' | 'page' | 'ask' | 'action'
  id: string
  label: string
  hint?: string
  icon: string
  run: () => void | Promise<void>
}

const GROUP_LABEL: Record<Row['kind'], string | undefined> = {
  device: 'Appareils',
  page: 'Pages',
  action: 'Actions',
  ask: undefined,
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

const searchItems = computed<SearchItem[]>(() =>
  rows.value.map((row) => ({ id: `${row.kind}:${row.id}`, label: row.label, hint: row.hint, icon: row.icon, group: GROUP_LABEL[row.kind] }))
)

async function onSelect(item: SearchItem) {
  const row = rows.value.find((entry) => `${entry.kind}:${entry.id}` === item.id)
  if (!row) return
  commandPaletteOpen.value = false
  await row.run()
}

watch(commandPaletteOpen, async (open) => {
  if (!open) return
  query.value = ''
  await nextTick()
  search.value?.focus()
})
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
        <div class="mx-auto mt-[12vh] w-full max-w-xl" role="dialog" aria-label="Recherche et commandes" @keydown.esc="commandPaletteOpen = false">
          <AiSearch
            ref="search"
            v-model="query"
            :items="searchItems"
            :filter="false"
            placeholder="Un appareil, une page, ou une question"
            empty-title="Rien ne correspond"
            empty-hint="Essayez une autre recherche, ou posez la question à l'assistant"
            @select="onSelect"
          />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
