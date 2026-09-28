<script setup lang="ts">
/**
 * FLOWCHART - a routine on the dotted editor canvas (Beautiful UI).
 *
 * Trigger card(s) sit at row 0 (OR-ed - every trigger fans into the same condition card),
 * one condition card at row 1 (its chip rows are AND-ed, each row a dropdown pair like the
 * PromptBar model picker), then N action cards run in strict sequence, one per row. Sway
 * routines have no if/else action: the condition only ever decides whether the action chain
 * runs at all, so the card never branches into two paths. Cards drag anywhere on the canvas
 * and the connectors follow; dropdown values are controlled by the caller (the card shows
 * `segment.value` from props and asks to change it through `change`, it never edits props
 * itself), so a parent can wire this straight onto a routine's triggers/conditions/actions.
 */
import type { FlowchartConditionRow, FlowchartConditionSegment, FlowchartNode, FlowchartNodeKind } from '~/utils/aiFlowchart'

const props = defineProps<{ nodes: FlowchartNode[] }>()
const emit = defineEmits<{
  'update:nodes': [nodes: FlowchartNode[]]
  change: [nodeId: string, rowIndex: number, value: { segmentId: string; value: string }]
}>()

const canvasRef = ref<HTMLElement | null>(null)
const nodeRefs = new Map<string, HTMLElement>()
const width = ref(0)
const heights = ref<Record<string, number>>({})
const selected = ref<string | null>(null)
const offsets = ref<Record<string, { dx: number; dy: number }>>({})
const openSelect = ref<string | null>(null)
const draggingId = ref<string | null>(null)

type DragState = { id: string; startX: number; startY: number; baseDx: number; baseDy: number; moved: boolean }
let drag: DragState | null = null
let observer: ResizeObserver | null = null

function setNodeRef(id: string, el: Element | null) {
  if (el instanceof HTMLElement) {
    nodeRefs.set(id, el)
    observer?.observe(el)
  } else {
    nodeRefs.delete(id)
  }
}

function measure() {
  const canvas = canvasRef.value
  if (!canvas) return
  width.value = canvas.clientWidth
  const next = { ...heights.value }
  let changed = false
  nodeRefs.forEach((el, id) => {
    const h = el.offsetHeight
    if (h && Math.abs(h - (next[id] ?? 0)) > 0.5) {
      next[id] = h
      changed = true
    }
  })
  if (changed) heights.value = next
}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return
  measure()
  observer = new ResizeObserver(measure)
  observer.observe(canvas)
  nodeRefs.forEach((el) => observer?.observe(el))
})
onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  document.removeEventListener('pointerdown', closeOnOutsideClick)
})

const edges = computed(() => flowchartEdges(props.nodes))
const layout = computed(() => flowchartRowLayout(props.nodes, heights.value))
const canvasWidth = computed(() => width.value || 480)

function nodeHeight(node: FlowchartNode) {
  return heights.value[node.id] ?? FLOWCHART_FALLBACK_HEIGHT
}

function place(node: FlowchartNode) {
  const w = Math.min(node.w, canvasWidth.value * 0.92)
  const off = offsets.value[node.id]
  const rowIndex = layout.value.rows.indexOf(node.row)
  return {
    w,
    cx: node.x * canvasWidth.value + (off?.dx ?? 0),
    top: layout.value.rowY[rowIndex]! + (off?.dy ?? 0),
  }
}

function nodeStyle(node: FlowchartNode) {
  const { cx, top, w } = place(node)
  return {
    left: `${cx}px`,
    top: `${top}px`,
    width: `${w}px`,
    zIndex: draggingId.value === node.id ? 2 : 1,
  }
}

function nodeIcon(node: FlowchartNode) {
  return node.icon ?? FLOWCHART_DEFAULT_ICON
}

function kindPillStyle(kind: FlowchartNodeKind) {
  return {
    background: flowchartMix(kind.hue, 14, 'var(--page)'),
    color: flowchartMix(kind.hue, 80, 'var(--ink)'),
  }
}

function stepIconStyle(node: FlowchartNode) {
  const hue = node.hue ?? 'var(--ink-3)'
  return {
    background: flowchartMix(hue, 12),
    color: hue,
    boxShadow: `0 0 0 1px ${flowchartMix(hue, 20)}`,
  }
}

function rowConnector(row: FlowchartConditionRow, index: number) {
  return flowchartRowConnector(row, index)
}

/* card anchor points - pills sit above the card, so offset the top anchor */
function anchors(node: FlowchartNode) {
  const { cx, top } = place(node)
  return {
    top: { x: cx, y: top + (node.kind ? FLOWCHART_PILL_OFFSET : 0) },
    bottom: { x: cx, y: top + nodeHeight(node) },
  }
}

function edgePath(edge: { from: string; to: string }) {
  const fromNode = props.nodes.find((node) => node.id === edge.from)
  const toNode = props.nodes.find((node) => node.id === edge.to)
  if (!fromNode || !toNode) return ''
  return flowchartBezier(anchors(fromNode).bottom, anchors(toNode).top)
}

function isLit(edge: { from: string; to: string }) {
  return selected.value === edge.from || selected.value === edge.to
}

/* ── dragging ── */
function onPointerDown(node: FlowchartNode, event: PointerEvent) {
  if ((event.target as Element).closest('[data-ui]')) return
  const off = offsets.value[node.id]
  drag = {
    id: node.id,
    startX: event.clientX,
    startY: event.clientY,
    baseDx: off?.dx ?? 0,
    baseDy: off?.dy ?? 0,
    moved: false,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(node: FlowchartNode, event: PointerEvent) {
  if (!drag || drag.id !== node.id) return
  const dx = drag.baseDx + event.clientX - drag.startX
  const dy = drag.baseDy + event.clientY - drag.startY
  if (!drag.moved && Math.hypot(dx - drag.baseDx, dy - drag.baseDy) < 3) return
  drag.moved = true
  draggingId.value = node.id

  /* keep the card inside the canvas */
  const { w } = place(node)
  const h = nodeHeight(node)
  const baseCx = node.x * canvasWidth.value
  const rowIndex = layout.value.rows.indexOf(node.row)
  const baseTop = layout.value.rowY[rowIndex]!
  const cx = flowchartClamp(baseCx + dx, w / 2 + 8, canvasWidth.value - w / 2 - 8)
  const top = flowchartClamp(baseTop + dy, 8, layout.value.canvasHeight - h - 8)
  offsets.value = { ...offsets.value, [node.id]: { dx: cx - baseCx, dy: top - baseTop } }
}

function onPointerUp(node: FlowchartNode) {
  if (drag?.id !== node.id) return
  if (drag.moved) {
    const { cx } = place(node)
    const updated = props.nodes.map((n) => (n.id === node.id ? { ...n, x: cx / canvasWidth.value } : n))
    emit('update:nodes', updated)
  }
  draggingId.value = null
  drag = null
}

function onCardClick(node: FlowchartNode) {
  if (drag?.id === node.id && drag.moved) return /* a real drag should not also toggle selection */
  selected.value = selected.value === node.id ? null : node.id
}

/* ── condition dropdowns ── */
function toggleSelect(id: string) {
  openSelect.value = openSelect.value === id ? null : id
}

function closeOnOutsideClick(event: PointerEvent) {
  if (!(event.target as Element).closest('[data-ui]')) openSelect.value = null
}

watch(openSelect, (value) => {
  if (value) document.addEventListener('pointerdown', closeOnOutsideClick)
  else document.removeEventListener('pointerdown', closeOnOutsideClick)
})

function pickOption(node: FlowchartNode, rowIndex: number, segment: FlowchartConditionSegment, value: string) {
  if (segment.kind !== 'select') return
  emit('change', node.id, rowIndex, { segmentId: segment.id, value })
  openSelect.value = null
}
</script>

<template>
  <div
    ref="canvasRef"
    class="relative w-full select-none overflow-hidden rounded-card bg-page shadow-hairline"
    :style="{
      height: `${layout.canvasHeight}px`,
      backgroundImage: 'radial-gradient(var(--line-strong) 1px, transparent 1.25px)',
      backgroundSize: '22px 22px',
      backgroundPosition: 'center',
    }"
  >
    <!-- connectors -->
    <svg :width="canvasWidth" :height="layout.canvasHeight" class="pointer-events-none absolute inset-0">
      <path
        v-for="edge in edges"
        :key="`${edge.from}-${edge.to}`"
        :d="edgePath(edge)"
        fill="none"
        :stroke="isLit(edge) ? 'var(--accent)' : 'var(--line-strong)'"
        stroke-width="1.25"
        class="transition-[stroke] duration-150"
      />
    </svg>

    <!-- nodes -->
    <div
      v-for="node in props.nodes"
      :key="node.id"
      :ref="(el) => setNodeRef(node.id, el as Element | null)"
      class="absolute flex -translate-x-1/2 touch-none flex-col items-start gap-1.5"
      :style="nodeStyle(node)"
      @pointerdown="onPointerDown(node, $event)"
      @pointermove="onPointerMove(node, $event)"
      @pointerup="onPointerUp(node)"
    >
      <span v-if="node.kind" class="inline-flex h-6 items-center rounded-[6px] px-2 text-[11.5px] font-medium" :style="kindPillStyle(node.kind)">
        {{ node.kind.label }}
      </span>

      <!-- condition card: chip rows, AND-ed -->
      <div v-if="node.condition" class="w-full rounded-[18px] bg-surface shadow-card transition-shadow duration-150 hover:shadow-raised">
        <div
          v-for="(row, rowIndex) in node.condition.rows"
          :key="row.id"
          class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1.5 px-3 py-2.5"
        >
          <Icon name="ph:dots-six-vertical" class="size-2.5 shrink-0 cursor-grab text-ink-3/70" />
          <span class="w-7 text-[12.5px] text-ink-2">{{ rowConnector(row, rowIndex) }}</span>
          <template v-for="(segment, segmentIndex) in row.segments" :key="segmentIndex">
            <span v-if="segment.kind === 'text'" class="text-[12.5px] text-ink-2">{{ segment.text }}</span>
            <span
              v-else-if="segment.kind === 'source'"
              data-ui
              class="inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] bg-surface px-1.5 text-[12px] font-medium text-ink shadow-btn"
            >
              <span class="text-ink-2"><Icon :name="segment.icon" class="size-3" /></span>
              {{ segment.text }}
            </span>
            <span v-else-if="segment.kind === 'select'" data-ui class="relative inline-flex min-w-0">
              <button
                type="button"
                :aria-expanded="openSelect === segment.id"
                class="inline-flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-[6px] px-1.5 text-[12px] font-medium text-ink transition-colors duration-100"
                :class="openSelect === segment.id ? 'bg-hover-2' : 'bg-field hover:bg-hover-2'"
                @click="toggleSelect(segment.id)"
              >
                <span v-if="segment.dot" class="size-1.5 shrink-0 rounded-full bg-orange" />
                <span class="min-w-0 truncate">{{ segment.value }}</span>
                <Icon name="ph:caret-down" class="size-2.5 shrink-0 text-ink-3" />
              </button>
              <div
                v-if="openSelect === segment.id"
                data-ui
                class="absolute bottom-full z-20 mb-1.5 rounded-[10px] bg-surface p-1 shadow-raised"
                :class="[segment.width, segment.align === 'right' ? 'right-0' : 'left-0']"
                :style="{
                  animation: 'pop-in 180ms cubic-bezier(0.23,1,0.32,1) both',
                  transformOrigin: segment.align === 'right' ? 'bottom right' : 'bottom left',
                }"
              >
                <AiGlideMenu highlight-class="inset-x-1 rounded-[6px] bg-hover">
                  <button
                    v-for="option in segment.options"
                    :key="option.name"
                    type="button"
                    data-menu-row
                    class="relative z-10 flex h-7.5 w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left"
                    @click="pickOption(node, rowIndex, segment, option.name)"
                  >
                    <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{{ option.name }}</span>
                    <span v-if="option.tag" class="shrink-0 text-[11px] text-ink-3">{{ option.tag }}</span>
                    <span class="shrink-0 text-ink" :class="{ invisible: option.name !== segment.value }">
                      <Icon name="ph:check" class="size-3" />
                    </span>
                  </button>
                </AiGlideMenu>
              </div>
            </span>
          </template>
        </div>
      </div>

      <!-- trigger / action card -->
      <button
        v-else
        type="button"
        :aria-pressed="selected === node.id"
        class="w-full cursor-pointer rounded-[18px] bg-surface text-left outline-none transition-shadow duration-150 focus-visible:shadow-[0_0_0_1.5px_var(--accent)]"
        :class="selected === node.id ? 'shadow-[0_0_0_1.5px_var(--accent),0_2px_10px_rgba(0,0,0,0.045)]' : 'shadow-card hover:shadow-raised'"
        @click="onCardClick(node)"
      >
        <div class="flex items-center gap-2.5 p-2.5">
          <span class="flex size-9 shrink-0 items-center justify-center rounded-[8px]" :style="stepIconStyle(node)">
            <Icon :name="nodeIcon(node)" class="size-4" />
          </span>
          <span class="min-w-0 text-left">
            <span class="block truncate text-[13px] font-semibold leading-tight text-ink">{{ node.title }}</span>
            <span v-if="node.caption" class="mt-0.5 block text-[12px] leading-snug text-ink-2">{{ node.caption }}</span>
          </span>
        </div>
      </button>
    </div>
  </div>
</template>
