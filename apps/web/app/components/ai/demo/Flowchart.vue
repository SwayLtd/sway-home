<script setup lang="ts">
/**
 * Demo gallery for AiFlowchart (Beautiful UI source 15_Flowchart.tsx).
 *
 * Two cases: the source's own two-card story (a trigger plus an AND-ed condition with two
 * chip rows) translated to the house, and a full Sway routine with a trigger, a one-row
 * condition and four actions running in sequence - proof the canvas draws any number of
 * nodes, not just the source's fixed pair. The source has no scripted timeline (it is a
 * static, purely interactive canvas), so there is no "Rejouer" button here: dragging a card
 * or picking a dropdown value is the whole interaction, and both are live below.
 */
import type { FlowchartNode } from '~/utils/aiFlowchart'

const PURPLE = '#9a5cff'

/* case 1 - the source's "new order / flavor / topping" example, translated to a device */
const translated = ref<FlowchartNode[]>([
  {
    id: 'trigger-1',
    row: 0,
    x: 0.5,
    w: 300,
    kind: { label: 'Déclencheur', hue: PURPLE },
    hue: PURPLE,
    icon: 'ph:broadcast',
    title: 'Nouvel appareil détecté',
    caption: 'Se déclenche quand un appareil rejoint le réseau',
  },
  {
    id: 'cond-1',
    row: 1,
    x: 0.5,
    w: 356,
    kind: { label: 'Condition', hue: 'var(--orange)' },
    condition: {
      rows: [
        {
          id: 'row-1',
          connector: 'Si',
          segments: [
            { kind: 'source', icon: 'ph:cpu', text: 'appareil' },
            { kind: 'select', id: 'prop1', value: 'pièce', options: [{ name: 'pièce' }, { name: 'type' }, { name: 'intégration' }, { name: 'fabricant' }], width: 'w-36' },
            { kind: 'text', text: 'est' },
            {
              kind: 'select',
              id: 'val1',
              value: 'Salon',
              width: 'w-44',
              align: 'right',
              dot: true,
              options: [
                { name: 'Salon', tag: 'RDC' },
                { name: 'Cuisine', tag: 'RDC' },
                { name: 'Chambre', tag: 'Étage' },
                { name: 'Bureau', tag: 'Étage' },
                { name: 'Entrée', tag: 'RDC' },
              ],
            },
          ],
        },
        {
          id: 'row-2',
          connector: 'et',
          segments: [
            { kind: 'source', icon: 'ph:cpu', text: 'appareil' },
            { kind: 'select', id: 'prop2', value: 'type', options: [{ name: 'pièce' }, { name: 'type' }, { name: 'intégration' }, { name: 'fabricant' }], width: 'w-36' },
            { kind: 'text', text: 'est' },
            {
              kind: 'select',
              id: 'val2',
              value: 'Ampoule',
              width: 'w-64',
              dot: true,
              options: [{ name: 'Ampoule' }, { name: 'Prise' }, { name: 'Capteur' }, { name: 'Serrure' }, { name: 'Caméra' }],
            },
          ],
        },
      ],
    },
  },
])

/* case 2 - a full routine: "Réveil en douceur" */
const wakeUp = ref<FlowchartNode[]>([
  {
    id: 'trigger',
    row: 0,
    x: 0.5,
    w: 300,
    kind: { label: 'Déclencheur', hue: PURPLE },
    hue: PURPLE,
    icon: 'ph:alarm',
    title: 'Semaine à 7 h',
    caption: 'Se déclenche du lundi au vendredi à 07:00',
  },
  {
    id: 'cond',
    row: 1,
    x: 0.5,
    w: 356,
    kind: { label: 'Condition', hue: 'var(--orange)' },
    condition: {
      rows: [
        {
          id: 'row-1',
          connector: 'Si',
          segments: [
            { kind: 'source', icon: 'ph:users', text: 'présence' },
            { kind: 'select', id: 'who', value: "quelqu'un", options: [{ name: "quelqu'un" }, { name: 'tout le monde' }], width: 'w-36' },
            { kind: 'text', text: 'est' },
            {
              kind: 'select',
              id: 'state',
              value: 'à la maison',
              width: 'w-36',
              dot: true,
              options: [{ name: 'à la maison' }, { name: 'absent' }],
            },
          ],
        },
      ],
    },
  },
  {
    id: 'action-1',
    row: 2,
    x: 0.5,
    w: 300,
    kind: { label: 'Commande', hue: 'var(--green)' },
    hue: 'var(--green)',
    icon: 'ph:square-half-bottom',
    title: 'Ouvrir le volet',
    caption: 'Volet chambre -> ouvert',
  },
  {
    id: 'action-2',
    row: 3,
    x: 0.5,
    w: 300,
    kind: { label: 'Commande', hue: 'var(--green)' },
    hue: 'var(--green)',
    icon: 'ph:lightbulb',
    title: 'Allumer la lampe',
    caption: 'Lampe salon -> 30 %',
  },
  {
    id: 'action-3',
    row: 4,
    x: 0.5,
    w: 300,
    kind: { label: 'Attente', hue: 'var(--ink-3)' },
    hue: 'var(--ink-3)',
    icon: 'ph:hourglass',
    title: 'Attendre 10 minutes',
    caption: "Avant l'étape suivante",
  },
  {
    id: 'action-4',
    row: 5,
    x: 0.5,
    w: 300,
    kind: { label: 'Scène', hue: PURPLE },
    hue: PURPLE,
    icon: 'ph:film-strip',
    title: 'Lancer la scène Matin',
    caption: 'Active la scène "Matin"',
  },
])

/* the card is controlled: it only shows `segment.value` and asks to change it */
function applyChange(
  nodes: FlowchartNode[],
  nodeId: string,
  rowIndex: number,
  value: { segmentId: string; value: string }
): FlowchartNode[] {
  return nodes.map((node) => {
    if (node.id !== nodeId || !node.condition) return node
    const rows = node.condition.rows.map((row, index) => {
      if (index !== rowIndex) return row
      const segments = row.segments.map((segment) =>
        segment.kind === 'select' && segment.id === value.segmentId ? { ...segment, value: value.value } : segment
      )
      return { ...row, segments }
    })
    return { ...node, condition: { rows } }
  })
}
</script>

<template>
  <section class="flex flex-col gap-8">
    <div>
      <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-3">Déclencheur + condition</p>
      <div class="bg-canvas rounded-window p-6">
        <AiFlowchart
          :nodes="translated"
          @update:nodes="translated = $event"
          @change="(nodeId, rowIndex, value) => (translated = applyChange(translated, nodeId, rowIndex, value))"
        />
      </div>
    </div>

    <div>
      <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-3">Routine complète - Réveil en douceur</p>
      <div class="bg-canvas rounded-window p-6">
        <AiFlowchart
          :nodes="wakeUp"
          @update:nodes="wakeUp = $event"
          @change="(nodeId, rowIndex, value) => (wakeUp = applyChange(wakeUp, nodeId, rowIndex, value))"
        />
      </div>
    </div>
  </section>
</template>
