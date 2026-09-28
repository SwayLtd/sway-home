/**
 * Routine <-> Flowchart mapping.
 *
 * AiFlowchart (components/ai/Flowchart.vue) draws OR-ed triggers at row 0, one AND-ed
 * condition card at row 1 whose chip rows carry the only editable dropdowns the component
 * has, then N action cards running in strict sequence - exactly the shape of a Sway routine
 * (packages/shared/src/automation.ts). Trigger and action cards are read-only step cards in
 * the kit's own demo (nothing there ever sets `.condition` on them), so this file keeps that
 * split: triggers/actions become plain French sentences, and only the condition rows expose
 * `select` segments, one per editable field the condition schema actually has (a comparator,
 * a time, a weekday set, a threshold, a mode...). A segment's `value` is always a string the
 * component hands back verbatim on `change`, so every option list here is built so its `name`
 * already IS (or trivially parses back to) the raw value - no separate lookup table needed to
 * undo a French label.
 *
 * `routine.conditions` is a flat, AND-ed list (automation_engine.ts's `#conditionsHold` does
 * `.every(...)`), which is exactly what the condition card's rows already mean - so row index
 * i is always `routine.conditions[i]`, with no translation table to keep in sync. A nested
 * `and`/`or`/`not` condition (legal in the schema, rare in practice) renders as a single
 * read-only summary row instead of trying to force boolean logic into a flat AND-only card.
 */

import type { Action, Condition, Routine, Trigger } from '@sway-home/shared/automation'
import {
  FLOWCHART_ACTION_ICON,
  FLOWCHART_DEFAULT_ICON,
  FLOWCHART_TRIGGER_ICON,
  type FlowchartConditionOption,
  type FlowchartConditionRow,
  type FlowchartConditionSegment,
  type FlowchartNode,
} from '~/utils/aiFlowchart'

/** What the mapping needs resolved from outside (devices, areas, scenes, other routines) - kept
 *  as plain lookup functions so this file never has to know the shape of a Device or an Area. */
export interface RoutineFlowContext {
  deviceName: (deviceId: string) => string
  areaName: (areaId: string | null) => string | null
  sceneName: (sceneId: string) => string
  routineName: (routineId: string) => string
}

/** Fixed id: there is at most one condition card, so a `change` event's `nodeId` only ever
 *  needs to tell "this is the condition card" apart from... nothing else editable. */
export const CONDITION_NODE_ID = 'condition'

const TRIGGER_HUE = '#9a5cff' /* same purple the kit's own demo uses for "Déclencheur" */
const CONDITION_HUE = 'var(--orange)'

// ---------------------------------------------------------------------------------------
// French vocabularies
// ---------------------------------------------------------------------------------------

type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

const WEEKDAY_LABEL: Record<Weekday, string> = { mon: 'lundi', tue: 'mardi', wed: 'mercredi', thu: 'jeudi', fri: 'vendredi', sat: 'samedi', sun: 'dimanche' }
const WORKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri']
const WEEKEND: Weekday[] = ['sat', 'sun']

const ATTRIBUTE_LABEL: Record<string, string> = {
  on: 'allumage',
  brightness: 'luminosité',
  colorTemperature: 'température de couleur',
  hue: 'teinte',
  saturation: 'saturation',
  position: 'position',
  tilt: 'orientation',
  targetTemperature: 'consigne',
  currentTemperature: 'température',
  temperature: 'température',
  hvacMode: 'mode de chauffage',
  hvacAction: 'action de chauffage',
  volume: 'volume',
  fanSpeed: 'vitesse de ventilation',
  effect: 'effet',
  locked: 'verrouillage',
  open: 'ouverture',
  motion: 'mouvement',
  battery: 'batterie',
  power: 'puissance',
  leak: 'fuite',
  smoke: 'fumée',
  humidity: 'humidité',
  playback: 'lecture',
  updateAvailable: 'mise à jour',
}
function attributeLabel(attribute: string): string {
  return ATTRIBUTE_LABEL[attribute] ?? attribute
}

/** All nine trigger operators (device_state's full set; capability_state uses a subset). Not
 *  editable - triggers are read-only cards - so this only ever renders into a caption. */
const TRIGGER_OPERATOR_PHRASE: Record<string, string> = {
  eq: 'est égal à',
  neq: "n'est pas égal à",
  gt: 'est supérieur à',
  gte: 'est au moins',
  lt: 'est inférieur à',
  lte: 'est au plus',
  changed: 'change',
  changed_to: 'devient',
  changed_from: 'quitte',
}

const SUN_EVENT_LABEL: Record<string, string> = {
  sunrise: 'Lever du soleil',
  sunset: 'Coucher du soleil',
  dawn: 'Aube',
  dusk: 'Crépuscule',
  solar_noon: 'Midi solaire',
}

const PRESENCE_TRANSITION_LABEL: Record<string, string> = {
  arrives: "Quelqu'un arrive",
  leaves: "Quelqu'un part",
  first_arrives: 'Première arrivée',
  last_leaves: 'Dernier départ',
}

/** packages/shared/src/automation.ts HOUSE_MODES, in words. */
const HOUSE_MODE_LABEL: Record<string, string> = {
  home: 'Maison',
  away: 'Absent',
  night: 'Nuit',
  guest: 'Invité',
  vacation: 'Vacances',
  party: 'Fête',
  focus: 'Concentration',
  cinema: 'Cinéma',
  cleaning: 'Ménage',
}
const HOUSE_MODES = Object.keys(HOUSE_MODE_LABEL)

const CATEGORY_LABEL: Record<string, string> = {
  light: 'Lumières',
  switch: 'Interrupteurs',
  outlet: 'Prises',
  lock: 'Serrures',
  cover: 'Volets',
  climate: 'Climatisation',
  sensor: 'Capteurs',
  media: 'Lecteurs',
  speaker: 'Enceintes',
}

const COMMAND_LABEL: Record<string, string> = {
  turnOn: 'Allumer',
  turnOff: 'Éteindre',
  toggle: 'Basculer',
  setBrightness: 'Régler la luminosité',
  setColorTemperature: 'Régler la température de couleur',
  setColor: 'Régler la couleur',
  setPosition: 'Régler la position',
  setTargetTemperature: 'Régler la consigne',
  setHvacMode: 'Régler le mode',
  lock: 'Verrouiller',
  unlock: 'Déverrouiller',
  setVolume: 'Régler le volume',
  play: 'Lecture',
  pause: 'Pause',
  stopPlayback: 'Arrêter',
  next: 'Suivant',
  previous: 'Précédent',
  identify: 'Localiser',
  startCleaning: 'Nettoyer',
  returnToDock: 'Retour à la base',
  openValve: 'Ouvrir la vanne',
  closeValve: 'Fermer la vanne',
  open: 'Ouvrir',
  close: 'Fermer',
}

// ---------------------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------------------

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds} s`
  const totalMinutes = Math.round(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours} h ${minutes}` : `${hours} h`
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'boolean') return value ? 'vrai' : 'faux'
  if (typeof value === 'string') return `"${value}"`
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function weekdaysSentence(days: string[]): string {
  if (days.length === 0) return 'Tous les jours'
  if (sameDays(days, WORKDAYS)) return 'En semaine'
  if (sameDays(days, WEEKEND)) return 'Le week-end'
  const sentence = days.map((day) => WEEKDAY_LABEL[day as Weekday] ?? day).join(', ')
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`
}

function sameDays(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((day) => b.includes(day))
}

function describeSelector(selector: { areaId: string | null; capability: string | null; category: string | null; tag: string | null }, ctx: RoutineFlowContext): string {
  const subject = selector.category ? (CATEGORY_LABEL[selector.category] ?? selector.category) : selector.capability ? selector.capability : 'Appareils'
  const area = selector.areaId ? ctx.areaName(selector.areaId) : null
  return area ? `${subject} (${area})` : subject
}

/** Compact one-line summary, reused for a `wait_until` action's caption and for a nested
 *  and/or/not condition row, which the flat AND-only card cannot expand into real segments. */
function describeConditionShort(condition: Condition): string {
  switch (condition.kind) {
    case 'device_state':
      return `${attributeLabel(condition.attribute)} ${conditionOperatorSymbol(condition.operator)} ${formatValue(condition.value)}`.trim()
    case 'time_window':
      return `entre ${condition.after} et ${condition.before}`
    case 'sun_position':
      return condition.state === 'above_horizon' ? 'soleil levé' : 'soleil couché'
    case 'presence':
      return condition.home ? 'présence à la maison' : 'personne absente'
    case 'house_mode':
      return `mode parmi ${condition.modeIn.map((mode) => HOUSE_MODE_LABEL[mode] ?? mode).join(', ')}`
    case 'area_occupied':
      return condition.occupied ? 'pièce occupée' : 'pièce libre'
    case 'numeric':
      return `${condition.expression} ${conditionOperatorSymbol(condition.operator)} ${condition.value}`
    case 'and':
      return condition.conditions.map(describeConditionShort).join(' et ')
    case 'or':
      return condition.conditions.map(describeConditionShort).join(' ou ')
    case 'not':
      return `non (${describeConditionShort(condition.condition)})`
    default:
      return (condition as Condition).kind
  }
}

// ---------------------------------------------------------------------------------------
// Trigger and action nodes - read-only step cards, same as the kit's own demo
// ---------------------------------------------------------------------------------------

function describeTrigger(trigger: Trigger, ctx: RoutineFlowContext): { title: string; caption: string } {
  switch (trigger.kind) {
    case 'device_state': {
      const value = trigger.operator === 'changed' ? '' : ` ${formatValue(trigger.value)}`
      const forNote = trigger.forSeconds > 0 ? ` pendant ${formatDuration(trigger.forSeconds)}` : ''
      return { title: ctx.deviceName(trigger.deviceId), caption: `${attributeLabel(trigger.attribute)} ${TRIGGER_OPERATOR_PHRASE[trigger.operator] ?? trigger.operator}${value}${forNote}` }
    }
    case 'device_event':
      return { title: ctx.deviceName(trigger.deviceId), caption: `Évènement : ${trigger.event}` }
    case 'capability_state': {
      const value = trigger.operator === 'changed' ? '' : ` ${formatValue(trigger.value)}`
      const forNote = trigger.forSeconds > 0 ? ` pendant ${formatDuration(trigger.forSeconds)}` : ''
      const area = trigger.areaId ? ctx.areaName(trigger.areaId) : null
      return { title: `Capacité ${trigger.capability}${area ? ` (${area})` : ''}`, caption: `${attributeLabel(trigger.attribute)} ${TRIGGER_OPERATOR_PHRASE[trigger.operator] ?? trigger.operator}${value}${forNote}` }
    }
    case 'time':
      return { title: 'Heure fixe', caption: `${weekdaysSentence(trigger.days)} à ${trigger.at.replace(':', ' h ')}` }
    case 'cron':
      return { title: 'Planification', caption: trigger.expression }
    case 'sun':
      return { title: SUN_EVENT_LABEL[trigger.event] ?? trigger.event, caption: trigger.offsetMinutes === 0 ? "à l'heure exacte" : `${trigger.offsetMinutes > 0 ? '+' : ''}${trigger.offsetMinutes} min` }
    case 'presence':
      return { title: 'Présence', caption: PRESENCE_TRANSITION_LABEL[trigger.transition] ?? trigger.transition }
    case 'house_mode':
      return { title: 'Mode de la maison', caption: `Passage en mode ${HOUSE_MODE_LABEL[trigger.mode] ?? trigger.mode}` }
    case 'interval':
      return { title: 'Intervalle', caption: `Toutes les ${formatDuration(trigger.everySeconds)}` }
    case 'webhook':
      return { title: 'Webhook', caption: 'Appel HTTP entrant' }
    case 'voice_intent':
      return { title: 'Phrase vocale', caption: `"${trigger.phrase}"` }
    case 'manual':
      return { title: 'Manuel', caption: 'Déclenché à la demande' }
    default:
      return { title: (trigger as Trigger).kind, caption: '' }
  }
}

function describeAction(action: Action, ctx: RoutineFlowContext): { title: string; caption: string } {
  switch (action.kind) {
    case 'device_command': {
      const target = action.deviceId ? ctx.deviceName(action.deviceId) : action.selector ? describeSelector(action.selector, ctx) : 'Appareils'
      return { title: target, caption: COMMAND_LABEL[action.command] ?? action.command }
    }
    case 'scene':
      return { title: 'Scène', caption: ctx.sceneName(action.sceneId) }
    case 'delay':
      return { title: 'Attente', caption: formatDuration(action.seconds) }
    case 'notify':
      return { title: 'Notification', caption: action.message }
    case 'speak':
      return { title: 'Voix', caption: `"${action.text}"` }
    case 'set_house_mode':
      return { title: 'Mode de la maison', caption: `Passer en mode ${HOUSE_MODE_LABEL[action.mode] ?? action.mode}` }
    case 'run_routine':
      return { title: 'Lancer une routine', caption: ctx.routineName(action.routineId) }
    case 'webhook':
      return { title: 'Webhook', caption: `${action.method} ${action.url}` }
    case 'ask_agent':
      return { title: "Demander à l'assistant", caption: action.goal }
    case 'wait_until':
      return { title: 'Attendre', caption: `Jusqu'à : ${describeConditionShort(action.condition as Condition)} (max ${formatDuration(action.timeoutSeconds)})` }
    case 'stop':
      return { title: 'Arrêter', caption: action.reason ?? 'Fin de la routine' }
    default:
      return { title: (action as Action).kind, caption: '' }
  }
}

/** Per-action-kind pill label + hue, the same idea as the kit demo's "Commande"/"Attente"/
 *  "Scène" cards - grouped by what the action DOES rather than its literal schema kind. */
const ACTION_STYLE: Record<string, { label: string; hue: string }> = {
  device_command: { label: 'Commande', hue: 'var(--green)' },
  scene: { label: 'Scène', hue: TRIGGER_HUE },
  run_routine: { label: 'Routine', hue: TRIGGER_HUE },
  set_house_mode: { label: 'Mode maison', hue: TRIGGER_HUE },
  delay: { label: 'Attente', hue: 'var(--ink-3)' },
  wait_until: { label: 'Attente', hue: 'var(--ink-3)' },
  webhook: { label: 'Webhook', hue: 'var(--ink-3)' },
  ask_agent: { label: 'Assistant', hue: 'var(--ink-3)' },
  notify: { label: 'Notification', hue: CONDITION_HUE },
  speak: { label: 'Notification', hue: CONDITION_HUE },
  stop: { label: 'Arrêt', hue: 'var(--red)' },
}

function triggerNode(trigger: Trigger, index: number, total: number, ctx: RoutineFlowContext): FlowchartNode {
  const { title, caption } = describeTrigger(trigger, ctx)
  return {
    id: `trigger-${index}`,
    row: 0,
    x: (index + 1) / (total + 1),
    w: 300,
    kind: { label: 'Déclencheur', hue: TRIGGER_HUE },
    hue: TRIGGER_HUE,
    icon: FLOWCHART_TRIGGER_ICON[trigger.kind] ?? FLOWCHART_DEFAULT_ICON,
    title,
    caption,
  }
}

function actionNode(action: Action, index: number, row: number, ctx: RoutineFlowContext): FlowchartNode {
  const { title, caption } = describeAction(action, ctx)
  const style = ACTION_STYLE[action.kind] ?? { label: 'Action', hue: 'var(--ink-3)' }
  return {
    id: `action-${index}`,
    row,
    x: 0.5,
    w: 300,
    kind: { label: style.label, hue: style.hue },
    hue: style.hue,
    icon: FLOWCHART_ACTION_ICON[action.kind] ?? FLOWCHART_DEFAULT_ICON,
    title,
    caption,
  }
}

// ---------------------------------------------------------------------------------------
// The condition card - the only editable node
// ---------------------------------------------------------------------------------------

/** Enum options as {value, name} pairs: `name` is what the chip shows AND what `change` hands
 *  back, so reading it back is just a lookup in the same array - no separate reverse map. */
type EnumOption<T> = { value: T; name: string }

const DEVICE_STATE_OPERATORS: EnumOption<string>[] = [
  { value: 'eq', name: '=' },
  { value: 'neq', name: '≠' },
  { value: 'gt', name: '>' },
  { value: 'gte', name: '≥' },
  { value: 'lt', name: '<' },
  { value: 'lte', name: '≤' },
  { value: 'in', name: 'dans' },
  { value: 'between', name: 'entre' },
]
const NUMERIC_OPERATORS: EnumOption<string>[] = [
  { value: 'gt', name: '>' },
  { value: 'gte', name: '≥' },
  { value: 'lt', name: '<' },
  { value: 'lte', name: '≤' },
  { value: 'eq', name: '=' },
]
const BOOLEAN_OPTIONS: EnumOption<boolean>[] = [
  { value: true, name: 'vrai' },
  { value: false, name: 'faux' },
]
const SUN_STATE_OPTIONS: EnumOption<'above_horizon' | 'below_horizon'>[] = [
  { value: 'above_horizon', name: 'levé' },
  { value: 'below_horizon', name: 'couché' },
]
const PRESENCE_HOME_OPTIONS: EnumOption<boolean>[] = [
  { value: true, name: 'à la maison' },
  { value: false, name: 'absent' },
]
const OCCUPIED_OPTIONS: EnumOption<boolean>[] = [
  { value: true, name: 'occupée' },
  { value: false, name: 'libre' },
]
const HOUSE_MODE_OPTIONS: EnumOption<string>[] = HOUSE_MODES.map((mode) => ({ value: mode, name: HOUSE_MODE_LABEL[mode]! }))
const WEEKDAY_PRESETS: EnumOption<Weekday[]>[] = [
  { value: [], name: 'tous les jours' },
  { value: WORKDAYS, name: 'en semaine' },
  { value: WEEKEND, name: 'le week-end' },
]
/** Every half hour, 00:00 to 23:30 - a time picker as a fixed dropdown, and its own reverse
 *  mapping for free since the option's `name` is the HH:MM value itself. */
const TIME_OF_DAY_OPTIONS: FlowchartConditionOption[] = Array.from({ length: 48 }, (_, i) => ({
  name: `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}`,
}))

function optionValue<T>(options: EnumOption<T>[], name: string, fallback: T): T {
  return options.find((option) => option.name === name)?.value ?? fallback
}
function conditionOperatorSymbol(operator: string): string {
  return DEVICE_STATE_OPERATORS.find((option) => option.value === operator)?.name ?? NUMERIC_OPERATORS.find((option) => option.value === operator)?.name ?? operator
}
function weekdayPresetName(days: string[]): string {
  return WEEKDAY_PRESETS.find((preset) => sameDays(preset.value, days))?.name ?? days.map((day) => WEEKDAY_LABEL[day as Weekday] ?? day).join(', ')
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
}

/** A threshold as a fixed ladder around its current value, so "a number" stays a dropdown like
 *  every other editable segment: 4 steps below, the value itself, 4 steps above. The step grows
 *  with the magnitude (a battery percentage and a wattage do not want the same granularity) -
 *  best-effort, and the current value is always in the list so nothing is ever lost by opening
 *  the dropdown and closing it again. */
function numericLadder(current: number): FlowchartConditionOption[] {
  const magnitude = Math.abs(current)
  const step = magnitude >= 100 ? 10 : magnitude >= 20 ? 5 : magnitude >= 5 ? 1 : 0.5
  const values = new Set<number>([current])
  for (let i = 1; i <= 4; i += 1) {
    values.add(Math.round((current - i * step) * 10) / 10)
    values.add(Math.round((current + i * step) * 10) / 10)
  }
  return [...values].sort((a, b) => a - b).map((value) => ({ name: formatNumber(value) }))
}

function valueSegment(value: unknown, id: string): FlowchartConditionSegment {
  if (typeof value === 'boolean') return { kind: 'select', id, value: value ? 'vrai' : 'faux', options: BOOLEAN_OPTIONS.map((option) => ({ name: option.name })), width: 'w-24', dot: true }
  if (typeof value === 'number') return { kind: 'select', id, value: formatNumber(value), options: numericLadder(value), width: 'w-24', align: 'right' }
  return { kind: 'text', text: formatValue(value) }
}

/** One condition -> one AND-ed row. `and`/`or`/`not` (legal, rare) fall back to a single
 *  read-only summary segment: the card has no way to draw nested boolean logic. */
function conditionRow(condition: Condition, index: number, ctx: RoutineFlowContext): FlowchartConditionRow {
  const connector = index === 0 ? 'Si' : 'et'
  const segments = conditionSegments(condition, ctx)
  return { id: `row-${index}`, connector, segments }
}

function conditionSegments(condition: Condition, ctx: RoutineFlowContext): FlowchartConditionSegment[] {
  switch (condition.kind) {
    case 'device_state':
      return [
        { kind: 'source', icon: 'ph:cpu', text: ctx.deviceName(condition.deviceId) },
        { kind: 'text', text: attributeLabel(condition.attribute) },
        { kind: 'select', id: 'operator', value: conditionOperatorSymbol(condition.operator), options: DEVICE_STATE_OPERATORS.map((option) => ({ name: option.name })), width: 'w-20' },
        valueSegment(condition.value, 'value'),
      ]
    case 'numeric':
      return [
        { kind: 'source', icon: 'ph:function', text: condition.expression },
        { kind: 'select', id: 'operator', value: conditionOperatorSymbol(condition.operator), options: NUMERIC_OPERATORS.map((option) => ({ name: option.name })), width: 'w-16' },
        { kind: 'select', id: 'value', value: formatNumber(condition.value), options: numericLadder(condition.value), width: 'w-24', align: 'right' },
      ]
    case 'time_window':
      return [
        { kind: 'text', text: 'entre' },
        { kind: 'select', id: 'after', value: condition.after, options: TIME_OF_DAY_OPTIONS, width: 'w-24' },
        { kind: 'text', text: 'et' },
        { kind: 'select', id: 'before', value: condition.before, options: TIME_OF_DAY_OPTIONS, width: 'w-24' },
        { kind: 'select', id: 'days', value: weekdayPresetName(condition.days), options: WEEKDAY_PRESETS.map((option) => ({ name: option.name })), width: 'w-32', align: 'right' },
      ]
    case 'sun_position':
      return [
        { kind: 'source', icon: 'ph:sun-dim', text: 'soleil' },
        { kind: 'select', id: 'state', value: SUN_STATE_OPTIONS.find((option) => option.value === condition.state)?.name ?? condition.state, options: SUN_STATE_OPTIONS.map((option) => ({ name: option.name })), width: 'w-24' },
      ]
    case 'presence':
      return [
        { kind: 'source', icon: 'ph:users', text: condition.personId ?? "quelqu'un" },
        { kind: 'select', id: 'home', value: condition.home ? 'à la maison' : 'absent', options: PRESENCE_HOME_OPTIONS.map((option) => ({ name: option.name })), width: 'w-28', dot: true },
      ]
    case 'house_mode':
      return [
        { kind: 'text', text: 'mode parmi' },
        {
          kind: 'select',
          id: 'modeIn',
          value: condition.modeIn.map((mode) => HOUSE_MODE_LABEL[mode] ?? mode).join(', ') || 'aucun',
          options: HOUSE_MODE_OPTIONS.map((option) => ({ name: option.name })),
          width: 'w-32',
          align: 'right',
          dot: true,
        },
      ]
    case 'area_occupied':
      return [
        { kind: 'source', icon: 'ph:door-open', text: ctx.areaName(condition.areaId) ?? condition.areaId },
        { kind: 'select', id: 'occupied', value: condition.occupied ? 'occupée' : 'libre', options: OCCUPIED_OPTIONS.map((option) => ({ name: option.name })), width: 'w-24', dot: true },
      ]
    case 'and':
    case 'or':
    case 'not':
      return [{ kind: 'text', text: describeConditionShort(condition) }]
    default:
      return [{ kind: 'text', text: (condition as Condition).kind }]
  }
}

function conditionNode(conditions: Condition[], ctx: RoutineFlowContext): FlowchartNode {
  return {
    id: CONDITION_NODE_ID,
    row: 1,
    x: 0.5,
    w: 356,
    kind: { label: 'Condition', hue: CONDITION_HUE },
    condition: { rows: conditions.map((condition, index) => conditionRow(condition, index, ctx)) },
  }
}

// ---------------------------------------------------------------------------------------
// Public mapping
// ---------------------------------------------------------------------------------------

/** Routine -> the node list AiFlowchart draws. Row numbers are computed, not hard-coded, so a
 *  routine with no conditions still connects its triggers straight to its first action. */
export function routineToFlowchartNodes(routine: Routine, ctx: RoutineFlowContext): FlowchartNode[] {
  const nodes: FlowchartNode[] = routine.triggers.map((trigger, index) => triggerNode(trigger, index, routine.triggers.length, ctx))
  const hasConditions = routine.conditions.length > 0
  if (hasConditions) nodes.push(conditionNode(routine.conditions, ctx))
  const actionRow = hasConditions ? 2 : 1
  routine.actions.forEach((action, index) => nodes.push(actionNode(action, index, actionRow + index, ctx)))
  return nodes
}

/** One condition's field, patched from a `change` event's raw string back into its real type -
 *  the mirror image of `conditionSegments`/`valueSegment` above, kind by kind and id by id. */
function patchCondition(condition: Condition, segmentId: string, value: string): Condition {
  switch (condition.kind) {
    case 'device_state':
      if (segmentId === 'operator') return { ...condition, operator: optionValue(DEVICE_STATE_OPERATORS, value, condition.operator) as typeof condition.operator }
      if (segmentId === 'value') {
        if (typeof condition.value === 'boolean') return { ...condition, value: value === 'vrai' }
        if (typeof condition.value === 'number') return { ...condition, value: Number(value) }
      }
      return condition
    case 'numeric':
      if (segmentId === 'operator') return { ...condition, operator: optionValue(NUMERIC_OPERATORS, value, condition.operator) as typeof condition.operator }
      if (segmentId === 'value') return { ...condition, value: Number(value) }
      return condition
    case 'time_window':
      if (segmentId === 'after') return { ...condition, after: value }
      if (segmentId === 'before') return { ...condition, before: value }
      if (segmentId === 'days') return { ...condition, days: optionValue(WEEKDAY_PRESETS, value, condition.days as Weekday[]) }
      return condition
    case 'sun_position':
      if (segmentId === 'state') return { ...condition, state: optionValue(SUN_STATE_OPTIONS, value, condition.state) }
      return condition
    case 'presence':
      if (segmentId === 'home') return { ...condition, home: optionValue(PRESENCE_HOME_OPTIONS, value, condition.home) }
      return condition
    case 'house_mode':
      if (segmentId === 'modeIn') return { ...condition, modeIn: [optionValue(HOUSE_MODE_OPTIONS, value, condition.modeIn[0] ?? 'home')] }
      return condition
    case 'area_occupied':
      if (segmentId === 'occupied') return { ...condition, occupied: optionValue(OCCUPIED_OPTIONS, value, condition.occupied) }
      return condition
    default:
      return condition
  }
}

/** Applies one `AiFlowchart` `change` event to a draft routine. Only the condition card is
 *  editable (see the file header), so any other `nodeId` is a no-op rather than an error - a
 *  future click target that is not the condition card should do nothing, not throw. */
export function applyFlowchartChange(routine: Routine, nodeId: string, rowIndex: number, segmentId: string, value: string): Routine {
  if (nodeId !== CONDITION_NODE_ID) return routine
  const condition = routine.conditions[rowIndex]
  if (!condition) return routine
  const conditions = routine.conditions.slice()
  conditions[rowIndex] = patchCondition(condition, segmentId, value)
  return { ...routine, conditions }
}
