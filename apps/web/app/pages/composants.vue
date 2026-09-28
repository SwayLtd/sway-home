<script setup lang="ts">
/**
 * Every component of the agent interface kit, every variant, playing.
 *
 * The console uses them with live data - the trace in the assistant, the task rows of the
 * hub, the device table, the routine canvas. This page shows each one on its own with a
 * scripted story, so a variant that the house has not needed yet can still be seen, and the
 * choices made in Réglages can be compared with the others.
 *
 * Derived from Beautiful UI (https://www.beautifului.dev), MIT License.
 */

/** Where the console uses a component with real data: a page, a dock panel, the palette or the rail. */
interface Place {
  label: string
  to?: string
  dock?: Exclude<QuickTool, null>
  palette?: boolean
  rail?: boolean
}

interface Entry {
  id: string
  name: string
  description: string
  usedIn: Place[]
  demo: Component
}

const ENTRIES: Entry[] = [
  { id: 'loading-state', name: 'Chargement', description: "Grille de pixels, libellé qui scintille et chronomètre : ce qui se passe pendant qu'un travail dure.", usedIn: [{ label: 'Assistant', to: '/' }], demo: resolveComponent('AiDemoLoadingState') as Component },
  { id: 'thinking', name: 'Réflexion', description: "La trace de l'assistant pendant qu'il travaille, puis repliée au-dessus de la réponse.", usedIn: [{ label: 'Assistant', to: '/' }, { label: 'Apprendre une tâche', to: '/routines' }], demo: resolveComponent('AiDemoThinking') as Component },
  { id: 'streaming-text', name: 'Réponse en direct', description: 'Les mots sortent du flou, les sources apparaissent en contexte, puis les actions et les suites.', usedIn: [{ label: 'Assistant', to: '/' }], demo: resolveComponent('AiDemoStreamingText') as Component },
  { id: 'approval-card', name: 'Questions', description: "L'assistant demande au lieu de deviner : une question à la fois, choix unique ou multiple.", usedIn: [{ label: 'Assistant', to: '/' }], demo: resolveComponent('AiDemoApprovalCard') as Component },
  { id: 'tool-chips', name: 'Outils utilisés', description: 'Le déroulé d\'une réponse en lignes compactes, chacune dépliable pour voir ce que l\'outil a fait.', usedIn: [{ label: 'Assistant', to: '/' }], demo: resolveComponent('AiDemoToolChips') as Component },
  { id: 'task-rows', name: 'Tâches', description: 'Les travaux longs du hub : scan, routine, appairage, avec progression, échec et relance.', usedIn: [{ label: 'Panneau Tâches', dock: 'tasks' }, { label: 'Panneau Scan réseau', dock: 'scan' }], demo: resolveComponent('AiDemoTaskRows') as Component },
  { id: 'chat', name: 'Discussion compacte', description: "L'assistant dans le panneau latéral : onglets, étapes et zone de saisie.", usedIn: [{ label: 'Panneau Assistant', dock: 'agent' }], demo: resolveComponent('AiDemoChat') as Component },
  { id: 'prompt-bar', name: 'Zone de saisie', description: 'Pièces jointes, mentions avec @, commandes avec /, choix du modèle, dictée et envoi.', usedIn: [{ label: 'Assistant', to: '/' }], demo: resolveComponent('AiDemoPromptBar') as Component },
  { id: 'recommendation-card', name: 'Recommandation', description: 'Une suggestion pesée, avec ses alternatives : en choisir une la met en avant.', usedIn: [{ label: 'Routines', to: '/routines' }, { label: 'Assistant', to: '/' }], demo: resolveComponent('AiDemoRecommendationCard') as Component },
  { id: 'context-cards', name: 'Contexte', description: "Les souvenirs et les états que l'assistant avait en tête pour répondre.", usedIn: [{ label: 'Assistant', to: '/' }], demo: resolveComponent('AiDemoContextCards') as Component },
  { id: 'diff-table', name: 'Modifications proposées', description: "Chaque changement d'une proposition est une ligne que l'on garde ou que l'on retire.", usedIn: [{ label: 'Panneau Propositions', dock: 'proposals' }, { label: 'Assistant', to: '/' }], demo: resolveComponent('AiDemoDiffTable') as Component },
  { id: 'records-table', name: 'Tableau', description: 'Un tableur dont les colonnes sont des propriétés, y compris des colonnes calculées par l\'IA.', usedIn: [{ label: 'Appareils', to: '/devices' }], demo: resolveComponent('AiDemoRecordsTable') as Component },
  { id: 'filter-table', name: 'Tableau filtré', description: 'Des pastilles de statut qui filtrent le tableau, avec leurs comptes.', usedIn: [{ label: 'Routines', to: '/routines' }], demo: resolveComponent('AiDemoFilterTable') as Component },
  { id: 'sidebar-nav', name: 'Navigation', description: 'La maison, les pages, les conversations à rechercher, et un repli qui garde les icônes alignées.', usedIn: [{ label: 'Menu latéral', rail: true }], demo: resolveComponent('AiDemoSidebarNav') as Component },
  { id: 'search', name: 'Recherche', description: 'Chercher un appareil, une page ou une action, au clavier.', usedIn: [{ label: 'Recherche (Ctrl K)', palette: true }], demo: resolveComponent('AiDemoSearch') as Component },
  { id: 'flowchart', name: 'Schéma de routine', description: 'Déclencheurs, conditions et actions sur un canevas où les cartes se déplacent.', usedIn: [{ label: 'Routines', to: '/routines' }], demo: resolveComponent('AiDemoFlowchart') as Component },
  { id: 'insight-cards', name: 'Aperçus', description: "Trois lectures de la maison en graphiques : l'énergie, l'inhabituel, la répartition.", usedIn: [{ label: 'Énergie', to: '/energy' }], demo: resolveComponent('AiDemoInsightCards') as Component },
  { id: 'code-block', name: 'Code', description: "Une routine telle qu'elle est enregistrée, et ce qu'une modification y change.", usedIn: [{ label: 'Routines', to: '/routines' }], demo: resolveComponent('AiDemoCodeBlock') as Component },
  { id: 'fine-tune-card', name: 'Réglage fin', description: 'Des valeurs que l\'on règle en glissant sur le libellé, au clavier ou en tapant.', usedIn: [{ label: "Fiche d'un appareil", to: '/devices' }], demo: resolveComponent('AiDemoFineTuneCard') as Component },
  { id: 'selection-actions', name: 'Actions sur la sélection', description: 'Sélectionnez un passage : expliquer, raccourcir, reformuler, traduire, demander.', usedIn: [{ label: 'Assistant', to: '/' }], demo: resolveComponent('AiDemoSelectionActions') as Component },
  { id: 'agent-screen', name: 'Écran en direct', description: 'Une caméra en direct, et « Apprendre une tâche » pour enregistrer ce que vous faites.', usedIn: [{ label: 'Apprendre une tâche', to: '/routines' }, { label: "Fiche d'une caméra", to: '/devices' }], demo: resolveComponent('AiDemoAgentScreen') as Component },
]

const active = ref(ENTRIES[0]!.id)
let observer: IntersectionObserver | null = null

onMounted(() => {
  // The index follows the reading: the section nearest the top of the viewport is lit.
  observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (visible[0]) active.value = visible[0].target.id
    },
    { rootMargin: '-80px 0px -60% 0px' }
  )
  for (const entry of ENTRIES) {
    const element = document.getElementById(entry.id)
    if (element) observer.observe(element)
  }
})

onBeforeUnmount(() => observer?.disconnect())

function go(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const { dockTool, commandPaletteOpen, railPinned } = useShell()

function visit(place: Place) {
  if (place.to) void navigateTo(place.to)
  else if (place.dock) dockTool.value = place.dock
  else if (place.palette) commandPaletteOpen.value = true
  else if (place.rail) railPinned.value = true
}
</script>

<template>
  <div class="mx-auto max-w-7xl">
    <PageHeader
      title="Composants"
      :subtitle="`${ENTRIES.length} composants de l'interface d'agent, toutes les variantes`"
      :breadcrumb="[{ label: 'Système' }, { label: 'Composants' }]"
    >
      <template #actions>
        <NuxtLink to="/settings#interface" class="btn btn-sm btn-outline gap-2">
          <Icon name="ph:sliders-horizontal" class="size-4" />
          Choisir les variantes
        </NuxtLink>
      </template>
    </PageHeader>

    <div class="grid gap-8 lg:grid-cols-[13rem_1fr]">
      <nav class="hidden lg:block" aria-label="Composants">
        <div class="sticky top-20">
          <AiGlideMenu>
            <button
              v-for="entry in ENTRIES"
              :key="entry.id"
              data-menu-row
              class="relative flex h-8 w-full items-center rounded-control px-2.5 text-left text-[13px] transition-colors"
              :class="active === entry.id ? 'bg-primary/25 font-medium text-ink' : 'text-ink-2 hover:text-ink'"
              @click="go(entry.id)"
            >
              {{ entry.name }}
            </button>
          </AiGlideMenu>
        </div>
      </nav>

      <div class="min-w-0 space-y-14 pb-24">
        <section v-for="entry in ENTRIES" :id="entry.id" :key="entry.id" class="scroll-mt-20">
          <header class="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-lg font-semibold tracking-tight">{{ entry.name }}</h2>
              <p class="mt-0.5 max-w-2xl text-[13px] text-base-content/60">{{ entry.description }}</p>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-[11.5px] text-base-content/45">Dans :</span>
              <button
                v-for="place in entry.usedIn"
                :key="place.label"
                type="button"
                class="flex items-center gap-1.5 rounded-full border border-base-300 px-2.5 py-1 text-[11.5px] text-base-content/60 transition-colors hover:text-base-content"
                @click="visit(place)"
              >
                <Icon :name="place.to ? 'ph:arrow-square-out' : place.dock ? 'ph:sidebar-simple' : place.palette ? 'ph:magnifying-glass' : 'ph:list'" class="size-3.5" />
                {{ place.label }}
              </button>
            </div>
          </header>
          <component :is="entry.demo" />
        </section>

        <p class="text-[12px] text-base-content/45">
          Composants dérivés de
          <a href="https://www.beautifului.dev" target="_blank" rel="noreferrer" class="underline underline-offset-2">Beautiful UI</a>
          (licence MIT, Shane Levine), portés en Vue et habillés du thème Sway.
        </p>
      </div>
    </div>
  </div>
</template>
