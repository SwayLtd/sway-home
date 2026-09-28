/**
 * The dashboard's data.
 *
 * Widgets arrive already resolved from the hub, so a tile never issues its own request and
 * the grid cannot half-load. Live device state still comes from the SSE stream: a widget
 * holding device ids renders from the same store the device pages use, which is why a light
 * toggled anywhere updates its tile without the dashboard refetching.
 */

export type WidgetSize = 'sm' | 'md' | 'lg' | 'xl' | 'full'

export interface WidgetSeriesLine {
  id: string
  label: string
  points: { at: string; value: number }[]
  min: number | null
  max: number | null
  avg: number | null
  last: number | null
}

/**
 * Deliberately one flat optional bag rather than the hub's discriminated union: a template
 * cannot narrow a union across a `v-if`, so every field would need a cast at the point of
 * use. `kind` is still the switch; the fields are just all declared.
 */
export interface WidgetRankingEntry {
  id: string
  label: string
  icon: string
  value: number
  share: number | null
}

export interface WidgetData {
  kind: 'metric' | 'series' | 'multi-series' | 'ranking' | 'devices' | 'rows' | 'events' | 'text' | 'empty'
  value?: number | string | null
  unit?: string | null
  previous?: number | null
  label?: string
  tone?: 'default' | 'success' | 'warning' | 'error'
  points?: { at: string; value: number }[]
  min?: number | null
  max?: number | null
  /** Statistics over the window, on a series. */
  avg?: number | null
  last?: number | null
  count?: number
  bucket?: 'minute' | 'hour' | 'day'
  trend?: 'up' | 'down' | 'flat'
  changePct?: number | null
  /** One entry per compared room or device, on a multi-series. */
  series?: WidgetSeriesLine[]
  /** Rooms or devices in order, on a ranking; `count` is how many were measured in all. */
  entries?: WidgetRankingEntry[]
  by?: 'area' | 'device'
  order?: 'desc' | 'asc'
  total?: number | null
  deviceIds?: string[]
  rows?: { id: string; label: string; value: string; tone?: string; to?: string }[]
  events?: { id: string; at: string; type: string; origin: string; severity: string; subjectId: string | null; payload: Record<string, any> }[]
  text?: string
  message?: string
}

export interface Widget {
  id: string
  dashboardId: string
  type: string
  title: string
  subtitle: string | null
  icon: string | null
  size: WidgetSize
  position: number
  source: Record<string, any>
  options: Record<string, any>
  authoredBy: 'user' | 'agent' | 'system'
  reason: string | null
  visible: boolean
  createdAt: string
  updatedAt: string
  data: WidgetData
}

export interface Vocabulary {
  areas: { id: string; name: string }[]
  capabilities: string[]
  categories: string[]
}

/**
 * Container queries rather than viewport ones: the dock takes up to 640px on the right, so
 * a grid that asks the *window* how wide it is lays out four columns into a 400px strip.
 * The grid asks its own box instead, and the dashboard reflows when the dock opens.
 */
export const WIDGET_SPAN: Record<WidgetSize, string> = {
  sm: 'col-span-12 @2xl:col-span-6 @5xl:col-span-3',
  md: 'col-span-12 @2xl:col-span-6 @5xl:col-span-4',
  lg: 'col-span-12 @2xl:col-span-12 @5xl:col-span-6',
  xl: 'col-span-12 @5xl:col-span-8',
  full: 'col-span-12',
}

export function useWidgets() {
  const widgets = useState<Widget[]>('dashboard-widgets', () => [])
  const vocabulary = useState<Vocabulary>('dashboard-vocabulary', () => ({ areas: [], capabilities: [], categories: [] }))
  const loading = useState('dashboard-loading', () => true)
  const editing = useState('dashboard-editing', () => false)

  async function load() {
    const response = await hubFetch<{ widgets: Widget[]; vocabulary: Vocabulary }>('/dashboard')
    widgets.value = response.widgets
    vocabulary.value = response.vocabulary
    loading.value = false
  }

  async function add(input: Partial<Widget>) {
    const response = await hubFetch<{ widget: Widget }>('/dashboard/widgets', { method: 'POST', body: input })
    widgets.value = [...widgets.value, response.widget]
    return response.widget
  }

  async function update(id: string, patch: Partial<Widget>) {
    const response = await hubFetch<{ widget: Widget | null }>(`/dashboard/widgets/${id}`, { method: 'PATCH', body: patch })
    if (response.widget) {
      widgets.value = widgets.value.map((widget) => (widget.id === id ? response.widget! : widget))
    }
  }

  async function remove(id: string) {
    const previous = widgets.value
    widgets.value = widgets.value.filter((widget) => widget.id !== id)
    try {
      await hubFetch(`/dashboard/widgets/${id}`, { method: 'DELETE' })
    } catch (error) {
      widgets.value = previous
      throw error
    }
  }

  /** Move one card. The whole order is sent, because that is what the hub stores. */
  async function move(id: string, direction: -1 | 1) {
    const index = widgets.value.findIndex((widget) => widget.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= widgets.value.length) return
    const next = [...widgets.value]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved!)
    widgets.value = next
    await hubFetch('/dashboard/reorder', { method: 'POST', body: { ids: next.map((widget) => widget.id) } })
  }

  async function preview(input: { type: string; source: Record<string, unknown>; options?: Record<string, unknown> }) {
    return (await hubFetch<{ data: WidgetData }>('/dashboard/preview', { method: 'POST', body: input })).data
  }

  return { widgets, vocabulary, loading, editing, load, add, update, remove, move, preview }
}

// ---------------------------------------------------------------------------------------
// What the assistant says without being asked
// ---------------------------------------------------------------------------------------

export interface Announcement {
  id: string
  at: string
  kind: string
  subjectId: string | null
  text: string
  severity: 'info' | 'notice' | 'warning' | 'critical'
  spoken: boolean
  acknowledged: boolean
  payload: Record<string, any>
}

/**
 * The proactive half of the assistant.
 *
 * The hub decides *what* is worth saying and whether the hour allows speaking; this decides
 * how it appears and reads it out. Keeping the decision on the hub matters: the rule has to
 * hold when no browser tab is open, and a rule that lives in the page is a rule that only
 * applies while someone is looking.
 */
export function useAnnouncements() {
  const items = useState<Announcement[]>('announcements', () => [])
  const speaking = useState('announcement-speaking', () => false)
  const voice = useVoiceSettings()
  const speaker = useSpeaker(voice)
  const { events } = useHouse()

  async function load() {
    const response = await hubFetch<{ announcements: Announcement[]; pending: Announcement[] }>('/announcements')
    items.value = response.pending
  }

  async function acknowledge(id: string) {
    items.value = items.value.filter((item) => item.id !== id)
    await hubFetch(`/announcements/${id}/acknowledge`, { method: 'POST' })
  }

  async function acknowledgeAll() {
    items.value = []
    await hubFetch('/announcements/acknowledge-all', { method: 'POST' })
  }

  async function say(text: string) {
    if (!voice.value.speakReplies || voice.value.engine === 'off') return
    speaking.value = true
    try {
      await speaker.speak(text)
    } catch {
      /* a voice that fails to load must never break the notification itself */
    } finally {
      speaking.value = false
    }
  }

  // New announcements arrive as agent.insight on the same stream everything else uses.
  watch(
    () => events.value[0]?.id,
    () => {
      const event = events.value[0]
      if (!event || event.type !== 'agent.insight') return
      const payload = event.payload as Record<string, any>
      if (!payload.announcementId) return
      if (items.value.some((item) => item.id === payload.announcementId)) return

      items.value = [
        {
          id: String(payload.announcementId),
          at: event.at,
          kind: String(payload.kind ?? 'agent.said'),
          subjectId: event.subjectId,
          text: String(payload.message ?? ''),
          severity: (event.severity as Announcement['severity']) ?? 'info',
          spoken: payload.speak === true,
          acknowledged: false,
          payload,
        },
        ...items.value,
      ].slice(0, 8)

      if (payload.speak === true) void say(String(payload.message ?? ''))
    }
  )

  return { items, speaking, load, acknowledge, acknowledgeAll, say }
}
