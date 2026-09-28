<script setup lang="ts">
/**
 * Gallery demo for AiSidebarNav: the same rail, expanded and collapsed side by side, sharing
 * one reactive data set so a click in either card is visible in both.
 *
 * The source has no scripted timeline for this component (no setTimeout stages) - it is
 * purely interactive - so there is no "Rejouer" button here, unlike the demos that replay a
 * story.
 *
 * Primary-nav items carry no `to`: this is a components gallery, not the app, and every real
 * page calls the hub on mount, which a demo must not do. Workspace-menu and footer actions
 * are always inert buttons in AiSidebarNav itself, so they may show a `to` for realism without
 * risking navigation.
 */

const workspaces = ref<SidebarNavWorkspace[]>([
  { id: 'maison-principale', name: 'Maison principale', subtitle: 'Chez moi', monogram: 'M' },
  { id: 'chalet', name: 'Chalet', subtitle: 'Absent', monogram: 'C' },
])
const activeWorkspaceId = ref('maison-principale')
const workspace = computed(() => workspaces.value.find((entry) => entry.id === activeWorkspaceId.value) ?? workspaces.value[0]!)
const workspaceActions: SidebarNavAction[] = [{ id: 'settings', label: 'Réglages de la maison', icon: 'ph:gear', to: '/settings' }]

const items: SidebarNavItem[] = [
  { id: 'assistant', label: 'Assistant', icon: 'ph:sparkle', section: 'house' },
  { id: 'devices', label: 'Appareils', icon: 'ph:lightbulb-filament', section: 'house', badge: 14 },
  { id: 'areas', label: 'Pièces', icon: 'ph:house-line', section: 'house' },
  { id: 'scenes', label: 'Scènes', icon: 'ph:sparkle', section: 'house' },
  { id: 'energy', label: 'Énergie', icon: 'ph:lightning', section: 'house' },
  { id: 'conversations', label: 'Conversations', icon: 'ph:chat-circle-dots', section: 'intelligence' },
  { id: 'routines', label: 'Routines', icon: 'ph:flow-arrow', section: 'intelligence', badge: 2 },
  { id: 'memory', label: 'Mémoire', icon: 'ph:brain', section: 'intelligence' },
  { id: 'timeline', label: 'Journal', icon: 'ph:clock-counter-clockwise', section: 'intelligence' },
  { id: 'network', label: 'Réseau', icon: 'ph:wifi-high', section: 'system' },
  { id: 'integrations', label: 'Intégrations', icon: 'ph:puzzle-piece', section: 'system' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'ph:heartbeat', section: 'system' },
  { id: 'settings', label: 'Réglages', icon: 'ph:sliders-horizontal', section: 'system' },
]
const sections: SidebarNavSection[] = [
  { key: 'house', label: 'Maison' },
  { key: 'intelligence', label: 'Intelligence' },
  { key: 'system', label: 'Système' },
]

const history: SidebarNavHistoryEntry[] = [
  { id: 'h1', title: 'Pourquoi le salon est à 19 °C ce matin ?', at: 'il y a 12 min' },
  { id: 'h2', title: 'Programmer le Réveil en douceur', at: 'il y a 1 h' },
  { id: 'h3', title: "La caméra d'entrée a détecté un colis", at: 'hier' },
  { id: 'h4', title: 'Réduire la consommation du bureau' },
  { id: 'h5', title: 'Ajouter une routine Arrosage du soir' },
  { id: 'h6', title: 'Qui a laissé la lumière de la cuisine allumée ?' },
  { id: 'h7', title: 'Préparer la scène Cinéma pour ce soir' },
  { id: 'h8', title: "Vérifier la serrure de l'entrée" },
]

const active = ref('conversations')
const activeHistoryId = ref<string | null>('h2')
const footer: SidebarNavAction = { id: 'alerts', label: '2 alertes', icon: 'ph:warning' }

function onNavigate(item: SidebarNavEmittedItem) {
  if (items.some((entry) => entry.id === item.id)) active.value = item.id
}
function onNewChat() {
  active.value = 'conversations'
  activeHistoryId.value = null
}
function onOpenChat(id: string) {
  active.value = 'conversations'
  activeHistoryId.value = id
}
function onSwitchWorkspace(id: string) {
  activeWorkspaceId.value = id
}

const expandedCollapsed = ref(false)
const collapsedCollapsed = ref(true)
</script>

<template>
  <section class="grid gap-4 lg:grid-cols-2">
    <div>
      <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-3">Déployée</p>
      <div class="bg-canvas rounded-window p-6">
        <AiSidebarNav
          v-model:collapsed="expandedCollapsed"
          :workspace="workspace"
          :workspaces="workspaces"
          :workspace-actions="workspaceActions"
          :items="items"
          :sections="sections"
          :active="active"
          :history="history"
          :active-history-id="activeHistoryId"
          :footer="footer"
          @navigate="onNavigate"
          @new-chat="onNewChat"
          @open-chat="onOpenChat"
          @switch-workspace="onSwitchWorkspace"
        />
      </div>
    </div>

    <div>
      <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-3">Réduite</p>
      <div class="bg-canvas rounded-window p-6">
        <AiSidebarNav
          v-model:collapsed="collapsedCollapsed"
          :workspace="workspace"
          :workspaces="workspaces"
          :workspace-actions="workspaceActions"
          :items="items"
          :sections="sections"
          :active="active"
          :history="history"
          :active-history-id="activeHistoryId"
          :footer="footer"
          @navigate="onNavigate"
          @new-chat="onNewChat"
          @open-chat="onOpenChat"
          @switch-workspace="onSwitchWorkspace"
        />
      </div>
    </div>
  </section>
</template>
