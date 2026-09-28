<script setup lang="ts">
/**
 * Demo gallery for AiInsightCards (Beautiful UI source 16_InsightCards.tsx).
 *
 * Every card type the source has, fed with house data: energy today vs yesterday (two
 * series), the living room's temperature anomaly (toggled metrics), and the consumption
 * split by room (allocation segments). The source has no scripted timeline either - the
 * carousel is the whole interaction, autoplay included - so there is no "Rejouer" button;
 * paging through it or touching a chart/toggle/segment below is the story.
 */
import type { InsightCardPage } from '~/utils/aiInsightCards'

const pages: InsightCardPage[] = [
  {
    id: 'compare',
    kind: 'compare',
    prose: [
      { kind: 'text', text: "Aujourd'hui, le " },
      { kind: 'entity', name: 'Salon', dotClass: 'bg-orange' },
      { kind: 'text', text: ' consomme plus qu\'hier à la même heure - ' },
      { kind: 'mono', text: '+2,4 kWh', tone: 'red' },
      { kind: 'text', text: ' sur la journée.' },
    ],
    pill: "Comment réduire la consommation aujourd'hui ?",
    compare: {
      heading: 'Courbe du jour',
      series: [
        {
          id: 'today',
          name: "Aujourd'hui",
          values: [13.2, 13.8, 14.6, 15.9, 16.4, 17.5, 17.9, 18.4],
          sub: '+2,4 kWh vs moyenne',
          tone: 'red',
          dotClass: 'bg-orange',
          color: 'var(--orange)',
        },
        {
          id: 'yesterday',
          name: 'Hier',
          values: [12.6, 13.0, 13.4, 13.9, 14.2, 14.6, 14.9, 15.1],
          sub: '-0,8 kWh vs moyenne',
          tone: 'green',
          dotClass: 'bg-green',
          color: 'var(--green)',
        },
      ],
    },
  },
  {
    id: 'anomaly',
    kind: 'anomaly',
    prose: [
      { kind: 'text', text: 'Pic de température inhabituel au ' },
      { kind: 'entity', name: 'Salon', dotClass: 'bg-orange' },
      { kind: 'text', text: ' hier soir - ' },
      { kind: 'mono', text: '+3,2 °C', tone: 'red' },
      { kind: 'text', text: ' au-dessus de la moyenne.' },
    ],
    pill: 'Comment limiter la surchauffe du salon ?',
    anomaly: {
      heading: 'Chauffage du salon élevé',
      metrics: [
        { key: 'temperature', label: 'Température', unit: '°C', decimals: 1, values: [19.8, 19.6, 19.9, 20.1, 20.4, 22.6, 23.9, 24.8] },
        { key: 'humidity', label: 'Humidité', unit: '%', decimals: 0, values: [42, 41, 43, 44, 45, 51, 55, 58] },
      ],
      deltaLabel: '+3,2 °C',
      baselineLabel: 'vs moyenne 7 jours',
    },
  },
  {
    id: 'allocation',
    kind: 'allocation',
    prose: [
      { kind: 'text', text: 'Le ' },
      { kind: 'entity', name: 'Salon', dotClass: 'bg-orange' },
      { kind: 'text', text: " concentre l'essentiel de la consommation - " },
      { kind: 'strong', text: '61,4 %' },
      { kind: 'text', text: ' du total aujourd\'hui.' },
    ],
    pill: 'Et si on regarde la semaine dernière ?',
    allocation: {
      heading: 'Salon : part de la consommation',
      segments: [
        {
          name: 'Salon',
          label: 'Salon',
          pct: 61.4,
          amount: '15,1 kWh',
          colorClass: 'bg-orange',
          toneClass: 'text-orange',
          description: "Chauffage et éclairage du salon sur la journée. La sélection change le segment inspecté sans déplacer la carte.",
        },
        {
          name: 'Cuisine',
          label: 'Cuisine',
          pct: 28.9,
          amount: '7,1 kWh',
          colorClass: 'bg-line-strong',
          toneClass: 'text-ink-2',
          description: 'Four, réfrigérateur et plaques de cuisson.',
        },
        {
          name: 'Chambre',
          label: 'Chambre',
          pct: 9.7,
          amount: '2,4 kWh',
          colorClass: 'bg-line',
          toneClass: 'text-ink-3',
          description: 'Veille des appareils et charge du téléphone.',
        },
      ],
    },
  },
]
</script>

<template>
  <section>
    <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-3">Aperçus - comparaison, anomalie, répartition</p>
    <div class="bg-canvas rounded-window p-6">
      <AiInsightCards :pages="pages" />
    </div>
  </section>
</template>
