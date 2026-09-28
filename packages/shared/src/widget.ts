/**
 * Widgets: what the dashboard is made of, and what the assistant writes when someone asks
 * for "a tile with the bathroom humidity".
 *
 * A widget is a *declaration*, never code. The assistant picks a type, a data source and a
 * few options; the hub resolves that against the house and returns numbers. That boundary is
 * the whole security model here: a model that can emit arbitrary code into a dashboard is a
 * model with remote execution on the machine that also holds the door locks. A model that
 * can emit `{ type: "metric", source: { kind: "capability", capability: "humidity" } }` can
 * only ever produce a wrong tile, and a wrong tile is deleted with one click.
 */

import { z } from 'zod'

export const WIDGET_TYPES = [
  'metric', // one number, big
  'gauge', // one number against a range
  'chart', // a series over time
  'devices', // a set of device cards with their controls
  'room', // one room: climate, lights, everything in it
  'toggle-row', // a row of on/off buttons, one per device
  'scenes', // scene buttons
  'alerts', // what needs attention
  'timeline', // recent activity
  'presence', // who is home
  'energy', // cost and draw
  'climate', // temperature and humidity across areas
  'media', // what is playing
  'note', // free text the assistant wrote
  'agent-suggestions', // routines waiting for a yes
  'list', // a computed list of devices matching a filter
  'compare', // several lines on one chart: two rooms, two devices, two weeks
  'ranking', // rooms or devices from most to least: what draws the most, the warmest room
] as const
export type WidgetType = (typeof WIDGET_TYPES)[number]

/** Widths in a 12-column grid. Height is in 80px rows, because a dashboard is not a document. */
export const WIDGET_SIZES = ['sm', 'md', 'lg', 'xl', 'full'] as const
export type WidgetSize = (typeof WIDGET_SIZES)[number]

export const WIDGET_SPAN: Record<WidgetSize, number> = { sm: 3, md: 4, lg: 6, xl: 8, full: 12 }

/**
 * Where a widget's numbers come from.
 *
 * Every source is a query over things that already exist - devices, capabilities, areas,
 * history, energy roll-ups, events. No source can reach outside the house database.
 */
export const widgetSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('device'),
    deviceId: z.string(),
    attribute: z.string().optional(),
  }),
  z.object({
    kind: z.literal('capability'),
    capability: z.string(),
    /** Optional narrowing: one area, one category, one set of devices. */
    areaId: z.string().nullable().default(null),
    category: z.string().nullable().default(null),
    deviceIds: z.array(z.string()).default([]),
    attribute: z.string().optional(),
    aggregate: z.enum(['avg', 'sum', 'min', 'max', 'count', 'first', 'any', 'all']).default('avg'),
  }),
  z.object({
    kind: z.literal('area'),
    areaId: z.string(),
  }),
  z.object({
    kind: z.literal('history'),
    deviceId: z.string().nullable().default(null),
    capability: z.string().nullable().default(null),
    attribute: z.string(),
    areaId: z.string().nullable().default(null),
    /** Width of the window. A year is the ceiling: past that nobody is reading a line. */
    hours: z.number().int().min(1).max(24 * 365).default(24),
    /** How far back the window ends. 24 is "yesterday", which must not include today. */
    offsetHours: z.number().int().min(0).max(24 * 365).default(0),
    aggregate: z.enum(['avg', 'sum', 'min', 'max']).default('avg'),
    /**
     * How wide one point is. `auto` picks from the window, which is what keeps a month of
     * hourly readings from arriving as 720 points nobody can draw.
     */
    bucket: z.enum(['auto', 'minute', 'hour', 'day']).default('auto'),
  }),
  z.object({
    kind: z.literal('compare'),
    capability: z.string(),
    attribute: z.string(),
    /** One line per area, named by the area. */
    areaIds: z.array(z.string()).default([]),
    /** Or one line per device, when the question named devices rather than rooms. */
    deviceIds: z.array(z.string()).default([]),
    hours: z.number().int().min(1).max(24 * 365).default(168),
    offsetHours: z.number().int().min(0).max(24 * 365).default(0),
    aggregate: z.enum(['avg', 'sum', 'min', 'max']).default('avg'),
  }),
  z.object({
    kind: z.literal('ranking'),
    capability: z.string(),
    attribute: z.string(),
    /** One bar per room, or one per device. */
    by: z.enum(['area', 'device']).default('area'),
    /** `desc` puts the highest first: the biggest draw, the warmest room. */
    order: z.enum(['desc', 'asc']).default('desc'),
    /**
     * 0 is right now, from the live state of online devices. Any other width reads history
     * over that window; for `power` that means energy, in kWh, because "what used the most
     * this week" is the question a bill answers.
     */
    hours: z.number().int().min(0).max(24 * 365).default(0),
    offsetHours: z.number().int().min(0).max(24 * 365).default(0),
    /** How several devices in one room collapse: draws add up, temperatures average. */
    aggregate: z.enum(['avg', 'sum', 'min', 'max']).default('avg'),
    /** Leaves out the garden and the balcony: "quelle pièce" is asking about rooms. */
    indoor: z.boolean().default(false),
    /** Only the devices of one room: "quel appareil de la cuisine consomme le plus". */
    areaId: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(12).default(5),
  }),
  z.object({
    kind: z.literal('energy'),
    days: z.number().int().min(1).max(90).default(7),
    deviceId: z.string().nullable().default(null),
    areaId: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal('events'),
    types: z.array(z.string()).default([]),
    subjectId: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  z.object({
    kind: z.literal('filter'),
    /** The same selector the agent already uses to command several devices at once. */
    category: z.string().nullable().default(null),
    areaId: z.string().nullable().default(null),
    capability: z.string().nullable().default(null),
    state: z.record(z.string(), z.unknown()).default({}),
    online: z.boolean().nullable().default(null),
    limit: z.number().int().min(1).max(60).default(12),
  }),
  z.object({ kind: z.literal('house') }),
  z.object({ kind: z.literal('static') }),
])

export type WidgetSource = z.infer<typeof widgetSourceSchema>

export const widgetSchema = z.object({
  id: z.string(),
  dashboardId: z.string().default('home'),
  type: z.enum(WIDGET_TYPES),
  title: z.string(),
  /** Shown under the title. A widget that needs a paragraph is the wrong widget. */
  subtitle: z.string().nullable().default(null),
  icon: z.string().nullable().default(null),
  size: z.enum(WIDGET_SIZES).default('sm'),
  position: z.number().int().default(0),
  source: widgetSourceSchema.default({ kind: 'house' }),
  options: z
    .object({
      unit: z.string().optional(),
      decimals: z.number().int().min(0).max(3).optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      /** Thresholds that turn the value amber or red. Below `warn` for inverted metrics. */
      warnAbove: z.number().optional(),
      warnBelow: z.number().optional(),
      criticalAbove: z.number().optional(),
      criticalBelow: z.number().optional(),
      showControls: z.boolean().optional(),
      compare: z.enum(['previous', 'none']).optional(),
      text: z.string().optional(),
      commands: z.array(z.object({ label: z.string(), command: z.string(), args: z.record(z.string(), z.unknown()).default({}) })).optional(),
    })
    .prefault({}),
  /** 'user' for a hand-placed widget, 'agent' when the assistant created it, 'system' for the defaults. */
  authoredBy: z.enum(['user', 'agent', 'system']).default('user'),
  /** Why the assistant made it. Shown on hover, so a surprise tile can always be explained. */
  reason: z.string().nullable().default(null),
  visible: z.boolean().default(true),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export type Widget = z.infer<typeof widgetSchema>

/** What the hub sends back for a widget: the declaration plus the numbers it resolves to. */
export interface ResolvedWidget extends Widget {
  data: WidgetData
}

export type WidgetData =
  | { kind: 'metric'; value: number | string | null; unit: string | null; previous?: number | null; label?: string; tone?: 'default' | 'success' | 'warning' | 'error' }
  | {
      kind: 'series'
      points: { at: string; value: number }[]
      unit: string | null
      min: number | null
      max: number | null
      avg: number | null
      last: number | null
      /** Number of buckets, which is what `points.length` means once the grain is coarse. */
      count: number
      bucket: 'minute' | 'hour' | 'day'
      /** Where the line went over the window, from the first third to the last. */
      trend: 'up' | 'down' | 'flat'
      /** The same thing as a percentage, null when the baseline is zero. */
      changePct: number | null
    }
  | {
      kind: 'multi-series'
      unit: string | null
      series: { id: string; label: string; points: { at: string; value: number }[]; min: number | null; max: number | null; avg: number | null; last: number | null }[]
    }
  | {
      kind: 'ranking'
      unit: string | null
      by: 'area' | 'device'
      order: 'desc' | 'asc'
      /** The sum over every entry, past the limit too; null where adding up means nothing. */
      total: number | null
      /** How many rooms or devices were measured, including those past the limit. */
      count: number
      entries: { id: string; label: string; icon: string; value: number; share: number | null }[]
    }
  | { kind: 'devices'; deviceIds: string[] }
  | { kind: 'rows'; rows: { id: string; label: string; value: string; tone?: string; to?: string }[] }
  | {
      kind: 'events'
      // The payload travels with the event because the console words the line itself: the
      // same phrasing has to hold in the dock, the journal and a dashboard tile.
      events: { id: string; at: string; type: string; origin: string; severity: string; subjectId: string | null; payload: Record<string, unknown> }[]
    }
  | { kind: 'text'; text: string }
  | { kind: 'empty'; message: string }

/**
 * The catalogue the assistant reads before writing a widget. Kept as prose rather than a
 * JSON schema dump because a model writes better widgets from examples than from types.
 */
export function widgetCatalogueForPrompt(): string {
  return [
    'metric: one big number. source: capability (with aggregate) | device+attribute | energy | history.',
    'gauge: a number against min/max. source: same as metric, plus options.min and options.max.',
    'chart: a line over time, with min/max/average and the trend. source: history (attribute required; hours up to 8760; offsetHours to end the window in the past, 24 = yesterday).',
    'compare: several lines on one chart. source: compare (attribute, plus areaIds OR deviceIds).',
    'ranking: rooms or devices from most to least, as bars. source: ranking (attribute, by area|device, order desc|asc, hours 0 = right now; power over a period ranks kWh).',
    'devices: full device cards with their controls. source: filter | capability | area.',
    'room: one room at a glance. source: area.',
    'toggle-row: compact on/off buttons. source: filter (usually category=light).',
    'list: label and value rows. source: filter | capability.',
    'scenes, alerts, timeline, presence, energy, climate, media, agent-suggestions: source house.',
    'note: a sentence you wrote. options.text holds it. source static.',
    'Sizes: sm=3 cols, md=4, lg=6, xl=8, full=12, out of 12.',
  ].join('\n')
}
