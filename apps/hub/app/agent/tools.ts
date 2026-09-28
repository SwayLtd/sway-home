/**
 * The agent's hands.
 *
 * Each tool is a name, a JSON Schema, a risk level and an implementation. Two rules run
 * through all of them:
 *
 *  1. **The summary is the product.** Whatever a tool returns is re-sent to the model on
 *     every subsequent turn, so it is written to be short and dense. `list_devices` returns
 *     one line per device, not a JSON dump of forty fields, and that single decision is
 *     worth more to cost and latency than any model choice.
 *  2. **Risk is checked before the act, not after.** `control_device` asks the permission
 *     layer first and returns a proposal instead of acting when the autonomy level is too
 *     low. The model cannot talk its way past it, because the check is in the tool.
 */

import {
  AUTONOMY_LEVELS,
  CAPABILITIES,
  commandRisk,
  deviceIcon,
  riskAllowed,
  widgetCatalogueForPrompt,
  widgetSchema,
  WIDGET_SIZES,
  WIDGET_TYPES,
  type AgentTool,
  type AgentToolContext,
  type AgentToolResult,
  type AutonomyLevel,
  type CapabilityId,
  type HouseMode,
} from '@sway-home/shared'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { houseService } from '#services/house'
import { automationEngine } from '#services/automation_engine'
import { insightEngine } from '#services/insight_engine'
import { scanService } from '#services/scan_service'
import { bus, queryEvents } from '#services/event_bus'
import { deviceRepository } from '#repositories/device_repository'
import { alerts, house, memories, people, places, routines, scenes, settings } from '#repositories/store'
import { widgets } from '#repositories/widget_repository'
import { describeSeries, energyByDevice, widgetService } from '#services/widget_service'
import { describeEnergy, describeRanking } from '#agent/briefing'
import { MEASURES, measureById, normalise } from '#agent/language'
import { narrator } from '#services/narrator'
import { autonomyEngine } from '#services/autonomy_engine'
import { describeAutonomy } from '#agent/reflexes'

// ---------------------------------------------------------------------------------------
// Formatting helpers: these decide how many tokens every turn costs.
// ---------------------------------------------------------------------------------------

function describeDevice(device: ReturnType<typeof deviceRepository.find>, areaNames: Map<string, string>): string {
  if (!device) return ''
  const area = device.areaId ? areaNames.get(device.areaId) ?? '?' : 'sans pièce'
  const bits: string[] = []
  const state = device.state

  if (typeof state.on === 'boolean') bits.push(state.on ? 'on' : 'off')
  if (typeof state.brightness === 'number' && state.on) bits.push(`${state.brightness}%`)
  if (typeof state.colorTemperature === 'number' && state.on) bits.push(`${state.colorTemperature}K`)
  if (typeof state.temperature === 'number') bits.push(`${state.temperature}°C`)
  if (typeof state.targetTemperature === 'number') bits.push(`cible ${state.targetTemperature}°C`)
  if (typeof state.humidity === 'number') bits.push(`${state.humidity}%HR`)
  if (typeof state.position === 'number') bits.push(`pos ${state.position}%`)
  if (typeof state.locked === 'boolean') bits.push(state.locked ? 'verrouillé' : 'DÉVERROUILLÉ')
  if (typeof state.open === 'boolean') bits.push(state.open ? 'OUVERT' : 'fermé')
  if (state.motion === true) bits.push('mouvement')
  if (typeof state.power === 'number' && state.power > 0.5) bits.push(`${state.power}W`)
  if (typeof state.battery === 'number') bits.push(`bat ${state.battery}%`)
  if (typeof state.playback === 'string' && state.playback !== 'idle') bits.push(String(state.playback))
  if (typeof state.volume === 'number') bits.push(`vol ${state.volume}`)
  if (!device.online) bits.push('HORS LIGNE')

  return `${device.id.slice(0, 8)} | ${device.name} | ${area} | ${device.category} | ${bits.join(' ') || 'aucun état'}`
}

function tool<T extends z.ZodType>(definition: AgentTool<T>): AgentTool<T> {
  return definition
}

function ok(summary: string, extra: Partial<AgentToolResult> = {}): AgentToolResult {
  return { ok: true, summary, ...extra }
}

function fail(summary: string): AgentToolResult {
  return { ok: false, summary }
}

function areaNameMap(): Map<string, string> {
  return new Map(places.areas().map((area) => [area.id, area.name]))
}

/** The model sees short ids; resolve a prefix, a full id, or a name. */
function resolveDevice(reference: string) {
  const direct = deviceRepository.find(reference)
  if (direct) return direct

  const all = deviceRepository.all({ limit: 1000, includeHidden: true })
  const byPrefix = all.find((device) => device.id.startsWith(reference))
  if (byPrefix) return byPrefix

  const normalised = reference.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
  const byName = all.find(
    (device) =>
      device.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() === normalised ||
      device.aliases.some((alias) => alias.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() === normalised)
  )
  if (byName) return byName

  const fuzzy = deviceRepository.search(reference, 1)[0]
  return fuzzy ?? null
}

// ---------------------------------------------------------------------------------------
// Read-only tools
// ---------------------------------------------------------------------------------------

const listDevices = tool({
  name: 'list_devices',
  description:
    'List the devices in the house, optionally narrowed by room, category or capability. Returns one compact line per device: short id, name, room, category, state.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({
    area: z.string().optional().describe('Room name, e.g. "Salon".'),
    category: z.string().optional().describe('light, switch, outlet, sensor, climate, cover, lock, camera, media, speaker, display, appliance, vacuum'),
    capability: z.string().optional().describe('A capability id such as onoff, brightness, thermostat, lock, motion, power.'),
    onlyOn: z.boolean().optional().describe('Only devices currently switched on.'),
    search: z.string().optional().describe('Free text over names and models.'),
  }),
  async execute(args) {
    const areas = places.areas()
    const areaId = args.area
      ? areas.find((area) => area.name.toLowerCase() === String(args.area).toLowerCase())?.id ?? undefined
      : undefined
    if (args.area && !areaId) {
      return fail(`Aucune pièce nommée "${args.area}". Pièces connues : ${areas.map((area) => area.name).join(', ')}`)
    }

    let devices = deviceRepository.all({
      areaId,
      category: args.category as never,
      capability: args.capability as never,
      search: args.search,
      limit: 200,
    })
    if (args.onlyOn) devices = devices.filter((device) => device.state.on === true || device.state.playback === 'playing')

    if (devices.length === 0) return ok('Aucun appareil ne correspond.')

    const names = areaNameMap()
    return ok(
      `${devices.length} appareil(s):\n${devices.map((device) => describeDevice(device, names)).join('\n')}`,
      { attachments: [{ kind: 'devices', data: { ids: devices.map((device) => device.id) } }] }
    )
  },
})

const getDevice = tool({
  name: 'get_device',
  description: 'Everything about one device: full state, capabilities, the commands it accepts, and where it is.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({ device: z.string().describe('Device id, short id, or name.') }),
  async execute(args) {
    const device = resolveDevice(args.device)
    if (!device) return fail(`Appareil introuvable : ${args.device}`)

    const commands = [...new Set(device.capabilities.flatMap((capability) => Object.keys(CAPABILITIES[capability as CapabilityId]?.commands ?? {})))]
    const area = device.areaId ? places.areas().find((candidate) => candidate.id === device.areaId)?.name ?? '?' : 'sans pièce'

    return ok(
      [
        `${device.name} (${device.id})`,
        `pièce: ${area} | catégorie: ${device.category} | ${device.online ? 'en ligne' : 'hors ligne'} | via ${device.adapterId}`,
        device.manufacturer || device.model ? `matériel: ${[device.manufacturer, device.model].filter(Boolean).join(' ')}` : '',
        `capacités: ${device.capabilities.join(', ')}`,
        `commandes: ${commands.join(', ')}`,
        `état: ${JSON.stringify(device.state)}`,
        device.notes ? `notes: ${device.notes}` : '',
      ].filter(Boolean).join('\n'),
      { attachments: [{ kind: 'device', data: { id: device.id } }] }
    )
  },
})

const houseSnapshot = tool({
  name: 'house_snapshot',
  description: 'One overview of the whole house: mode, counts, power draw, temperatures per room, security state, what is playing, open alerts. Use this before answering any "how is the house" question.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({}),
  async execute() {
    const snapshot = houseService.snapshot()
    const lines = [
      `mode: ${snapshot.mode}`,
      `appareils: ${snapshot.counts.online}/${snapshot.counts.total} en ligne`,
      `puissance: ${snapshot.power.total} W (${Object.entries(snapshot.power.byArea).map(([area, watts]) => `${area} ${watts}W`).join(', ') || 'aucune mesure'})`,
      `température: ${snapshot.climate.map((entry) => `${entry.area} ${entry.temperature ?? '?'}°C`).join(', ') || 'aucun capteur'}`,
      `lumières allumées: ${snapshot.lightsOn.length > 0 ? snapshot.lightsOn.join(', ') : 'aucune'}`,
      snapshot.security.locksUnlocked.length > 0 ? `DÉVERROUILLÉ: ${snapshot.security.locksUnlocked.join(', ')}` : 'toutes les serrures sont verrouillées',
      snapshot.security.openContacts.length > 0 ? `ouvert: ${snapshot.security.openContacts.join(', ')}` : '',
      snapshot.security.leaks.length > 0 ? `FUITE: ${snapshot.security.leaks.join(', ')}` : '',
      snapshot.mediaPlaying.length > 0 ? `en lecture: ${snapshot.mediaPlaying.join(', ')}` : '',
      snapshot.batteriesLow.length > 0 ? `piles faibles: ${snapshot.batteriesLow.map((entry) => `${entry.name} ${entry.battery}%`).join(', ')}` : '',
      snapshot.offline.length > 0 ? `hors ligne: ${snapshot.offline.join(', ')}` : '',
      snapshot.openAlerts.length > 0 ? `alertes: ${snapshot.openAlerts.map((alert) => alert.title).join(' | ')}` : 'aucune alerte',
    ].filter(Boolean)

    return ok(lines.join('\n'))
  },
})

const getHistory = tool({
  name: 'get_history',
  description: 'The recorded history of one attribute on one device, for answering questions about trends, averages and when something changed.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({
    device: z.string(),
    attribute: z.string().describe('temperature, humidity, power, brightness, on, motion, ...'),
    hours: z.number().min(1).max(720).default(24),
  }),
  async execute(args) {
    const device = resolveDevice(args.device)
    if (!device) return fail(`Appareil introuvable : ${args.device}`)

    const since = new Date(Date.now() - args.hours * 3_600_000).toISOString()
    const points = deviceRepository.history(device.id, args.attribute, { since, limit: 500 })
    if (points.length === 0) return ok(`Aucun historique pour ${args.attribute} sur ${device.name} depuis ${args.hours} h.`)

    const numeric = points.map((point) => point.value).filter((value): value is number => typeof value === 'number')
    const stats = numeric.length > 0
      ? `min ${Math.min(...numeric).toFixed(1)} | max ${Math.max(...numeric).toFixed(1)} | moyenne ${(numeric.reduce((sum, value) => sum + value, 0) / numeric.length).toFixed(1)}`
      : `${points.length} changements`

    return ok(
      `${device.name}.${args.attribute} sur ${args.hours} h : ${stats}. Dernière valeur ${String(points.at(-1)?.value)} à ${points.at(-1)?.at}.`,
      { attachments: [{ kind: 'chart', data: { deviceId: device.id, attribute: args.attribute, points } }] }
    )
  },
})

const getEnergy = tool({
  name: 'get_energy',
  description:
    'Energy used and what it cost over a period, in one sentence naming the device that weighs most, with a ranking card. Use it for any question about bills, consumption or what is expensive. hours overrides days; offsetHours ends the window in the past (24 with hours 24 = yesterday). by: device or area, for the card.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({
    days: z.number().min(1).max(365).default(7),
    hours: z.number().int().min(1).max(8760).optional(),
    offsetHours: z.number().int().min(0).max(8760).default(0),
    device: z.string().optional(),
    by: z.enum(['device', 'area']).default('device'),
  }),
  async execute(args) {
    const hours = args.hours ?? Math.round(args.days * 24)
    const period = periodLabel(hours, args.offsetHours)
    const price = settings.get<{ pricePerKwh: number; currency: string }>('energy', { pricePerKwh: 0.2516, currency: 'EUR' })
    const used = energyByDevice(hours, args.offsetHours)

    if (args.device) {
      const device = resolveDevice(args.device)
      if (!device) return fail(`Appareil introuvable : ${args.device}`)
      const own = used.get(device.id) ?? { kwh: 0, cost: 0 }
      return ok(describeEnergy({ period, kwh: own.kwh, cost: own.cost, currency: price.currency, top: null, device: { label: device.name, icon: deviceIcon(device) } }))
    }

    // The total counts every row, a device removed since included: it is on the bill.
    let kwh = 0
    let cost = 0
    for (const value of used.values()) {
      kwh += value.kwh
      cost += value.cost
    }

    const ranked = [...used.entries()]
      .map(([id, value]) => ({ device: deviceRepository.find(id), kwh: value.kwh }))
      .filter((entry): entry is { device: NonNullable<typeof entry.device>; kwh: number } => entry.device !== null)
      .sort((a, b) => b.kwh - a.kwh)
    const top = ranked.length >= 2 && kwh > 0 ? { label: ranked[0]!.device.name, icon: deviceIcon(ranked[0]!.device), share: ranked[0]!.kwh / kwh } : null

    const sentence = describeEnergy({ period, kwh, cost, currency: price.currency, top })
    if (kwh <= 0) return ok(sentence)

    const card = liveWidget('ranking', `Énergie ${args.by === 'area' ? 'par pièce' : 'par appareil'} (${period})`, 'md', {
      kind: 'ranking',
      capability: 'power',
      attribute: 'power',
      by: args.by,
      order: 'desc',
      hours,
      offsetHours: args.offsetHours,
      aggregate: 'sum',
      limit: 5,
    })
    const resolved = card.success ? widgetService.resolve(card.data) : null
    return ok(sentence, resolved?.data.kind === 'ranking' ? { attachments: [{ kind: 'widget', data: { widget: resolved } }] } : {})
  },
})

const getTimeline = tool({
  name: 'get_timeline',
  description: 'The recent event log. Use it to answer "why did that happen", "who turned that on", "what changed while I was out".',
  risk: 'none',
  readOnly: true,
  parameters: z.object({
    limit: z.number().min(1).max(200).default(40),
    device: z.string().optional(),
    types: z.array(z.string()).optional().describe('Event types, e.g. device.command_sent, automation.triggered.'),
  }),
  async execute(args) {
    const deviceId = args.device ? resolveDevice(args.device)?.id : undefined
    const events = queryEvents({ limit: args.limit, subjectId: deviceId, types: args.types })
    if (events.length === 0) return ok('Rien dans le journal pour ce filtre.')

    const names = new Map(deviceRepository.all({ limit: 1000, includeHidden: true }).map((device) => [device.id, device.name]))
    const lines = events.map((event) => {
      const subject = event.subjectId ? names.get(event.subjectId) ?? event.subjectId.slice(0, 8) : ''
      const detail = event.payload.command ? String(event.payload.command) : event.payload.name ? String(event.payload.name) : ''
      return `${event.at.slice(11, 19)} ${event.type} ${subject} ${detail} (${event.origin}${event.originDetail ? `:${event.originDetail}` : ''})`
    })

    return ok(lines.join('\n'), { attachments: [{ kind: 'timeline', data: { events } }] })
  },
})

const listRoutines = tool({
  name: 'list_routines',
  description: 'Every routine, with its state: active, suggested, paused. Suggested ones have not been approved and do not run.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({ status: z.enum(['active', 'suggested', 'paused', 'archived']).optional() }),
  async execute(args) {
    const list = routines.all(args.status)
    if (list.length === 0) return ok('Aucune routine.')
    return ok(
      list
        .map((routine) => `${routine.id.slice(0, 8)} | ${routine.name} | ${routine.status}${routine.enabled ? '' : ' (désactivée)'} | ${routine.triggers.map((trigger) => trigger.kind).join(',')} -> ${routine.actions.map((action) => action.kind).join(',')} | ${routine.runCount} exécutions`)
        .join('\n')
    )
  },
})

const listScenes = tool({
  name: 'list_scenes',
  description: 'The saved scenes and what each one sets.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({}),
  async execute() {
    const list = scenes.all()
    if (list.length === 0) return ok('Aucune scène enregistrée.')
    return ok(list.map((scene) => `${scene.id.slice(0, 8)} | ${scene.name} | ${scene.entries.length} appareils`).join('\n'))
  },
})

const networkView = tool({
  name: 'network_view',
  description:
    'What is on the local network, including hosts no adapter controls yet. Use it to answer "what is that device", "what did you find", "can you control my X".',
  risk: 'none',
  readOnly: true,
  parameters: z.object({ onlyUnclaimed: z.boolean().default(false) }),
  async execute(args) {
    const list = args.onlyUnclaimed ? scanService.unclaimed().map((entry) => entry.host) : scanService.hosts()
    if (list.length === 0) return ok('Aucun hôte connu. Lance un scan.')

    const lines = list.slice(0, 60).map((host) => {
      const fingerprint = (host as { fingerprint?: { category?: string; vendor?: string; confidence?: number; suggestedAdapters?: string[] } }).fingerprint
      return `${host.ip} | ${host.hostname ?? '-'} | ${fingerprint?.vendor ?? host.macVendor ?? '-'} | ${fingerprint?.category ?? '?'} | ports ${host.openPorts.slice(0, 6).join(',') || '-'}${fingerprint?.suggestedAdapters?.length ? ` | essayer: ${fingerprint.suggestedAdapters.join(',')}` : ''}`
    })
    return ok(`${list.length} hôte(s):\n${lines.join('\n')}`)
  },
})

const recall = tool({
  name: 'recall',
  description: 'Search what you have remembered about this house and the people in it.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({ query: z.string() }),
  async execute(args) {
    const found = memories.search(args.query, 10)
    if (found.length === 0) return ok('Rien en mémoire sur ce sujet.')
    return ok(found.map((memory) => `[${memory.kind}] ${memory.content}`).join('\n'))
  },
})

// ---------------------------------------------------------------------------------------
// Acting tools
// ---------------------------------------------------------------------------------------

function permissionCheck(context: AgentToolContext, command: string, deviceCritical: boolean): { allowed: boolean; risk: ReturnType<typeof commandRisk> } {
  const risk = commandRisk(command, deviceCritical)
  return { allowed: riskAllowed(context.autonomy, risk), risk }
}

const controlDevice = tool({
  name: 'control_device',
  description:
    'Send one command to one device. Commands come from the capability vocabulary: turnOn, turnOff, toggle, setBrightness, setColor, setColorTemperature, setPosition, setTargetTemperature, setHvacMode, lock, unlock, play, pause, setVolume, startCleaning, and so on.',
  risk: 'medium',
  readOnly: false,
  parameters: z.object({
    device: z.string().describe('Device id, short id or name.'),
    command: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  async execute(args, context) {
    const device = resolveDevice(args.device)
    if (!device) return fail(`Appareil introuvable : ${args.device}`)

    const { allowed, risk } = permissionCheck(context, args.command, device.critical)
    if (!allowed) {
      return {
        ok: false,
        summary: `Cette action (${args.command} sur ${device.name}) demande une validation. Une proposition a été créée.`,
        proposal: {
          summary: `${args.command} sur ${device.name}`,
          reason: 'Risque supérieur au niveau d autonomie actuel.',
          risk,
          commands: [{ deviceId: device.id, deviceName: device.name, command: args.command, args: args.args }],
          routine: null,
        },
      }
    }

    const result = await houseService.execute(device.id, args.command, args.args, {
      origin: 'agent',
      originDetail: context.unattended ? 'routine' : 'chat',
      correlationId: context.correlationId,
    })

    if (!result.ok) return fail(`${device.name} : ${result.error ?? 'échec'}`)
    return ok(
      `${device.name} : ${args.command} appliqué${result.state ? ` (${JSON.stringify(result.state).slice(0, 160)})` : ''}`,
      {
        attachments: [{ kind: 'device', data: { id: device.id } }],
        undo: result.undo ? [{ deviceId: device.id, command: result.undo.command, args: result.undo.args }] : undefined,
      }
    )
  },
})

const controlMany = tool({
  name: 'control_many',
  description: 'Send the same command to every device matching a selector. Use it for "turn off all the lights", "close the blinds upstairs", "mute everything".',
  risk: 'medium',
  readOnly: false,
  parameters: z.object({
    area: z.string().optional(),
    category: z.string().optional(),
    capability: z.string().optional(),
    command: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  async execute(args, context) {
    const { allowed, risk } = permissionCheck(context, args.command, false)
    const targets = houseService.resolve({
      areaName: args.area,
      category: args.category as never,
      capability: args.capability as never,
    })
    if (targets.length === 0) return fail('Aucun appareil ne correspond à ce filtre.')

    if (!allowed) {
      return {
        ok: false,
        summary: `${args.command} sur ${targets.length} appareils demande une validation.`,
        proposal: {
          summary: `${args.command} sur ${targets.length} appareils`,
          reason: 'Action groupée au-dessus du niveau d autonomie actuel.',
          risk,
          commands: targets.map((device) => ({ deviceId: device.id, deviceName: device.name, command: args.command, args: args.args })),
          routine: null,
        },
      }
    }

    const results = await houseService.executeMany(
      { areaName: args.area, category: args.category as never, capability: args.capability as never },
      args.command,
      args.args,
      { origin: 'agent', correlationId: context.correlationId }
    )

    const succeeded = results.filter((result) => result.ok).length
    return ok(`${args.command} : ${succeeded}/${results.length} appareils ont répondu.`, {
      attachments: [{ kind: 'devices', data: { ids: targets.map((device) => device.id) } }],
    })
  },
})

const activateScene = tool({
  name: 'activate_scene',
  description: 'Recall a saved scene.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({ scene: z.string().describe('Scene id or name.') }),
  async execute(args, context) {
    const scene = scenes.all().find((candidate) => candidate.id === args.scene || candidate.id.startsWith(args.scene) || candidate.name.toLowerCase() === args.scene.toLowerCase())
    if (!scene) return fail(`Scène introuvable : ${args.scene}`)
    const results = await houseService.applyScene(scene.id, { origin: 'agent', correlationId: context.correlationId })
    return ok(`Scène "${scene.name}" appliquée sur ${results.filter((result) => result.ok).length}/${results.length} commandes.`)
  },
})

const saveScene = tool({
  name: 'save_scene',
  description: 'Capture what a room (or the whole house) is doing right now as a named scene.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({ name: z.string(), area: z.string().optional() }),
  async execute(args) {
    const area = args.area ? places.areas().find((candidate) => candidate.name.toLowerCase() === args.area!.toLowerCase()) : null
    if (args.area && !area) return fail(`Pièce introuvable : ${args.area}`)
    const id = houseService.snapshotScene(args.name, area ? { areaId: area.id } : { all: true }, area?.id ?? null)
    const scene = scenes.find(id)
    return ok(`Scène "${args.name}" enregistrée avec ${scene?.entries.length ?? 0} appareils.`)
  },
})

const setHouseMode = tool({
  name: 'set_house_mode',
  description: 'Change the house mode: home, away, night, guest, vacation, party, focus, cinema, cleaning. Routines react to it.',
  risk: 'medium',
  readOnly: false,
  parameters: z.object({ mode: z.string() }),
  async execute(args, context) {
    const { allowed } = permissionCheck(context, 'setHouseMode', false)
    if (!allowed) return fail('Changer le mode de la maison demande une validation à ce niveau d autonomie.')
    const previous = house.mode()
    houseService.setMode(args.mode as HouseMode, 'agent')
    return ok(`Mode : ${previous} -> ${args.mode}`)
  },
})

const createRoutine = tool({
  name: 'create_routine',
  description:
    'Write a routine. It is created as "suggested" and does not run until a human approves it, unless autonomy is autopilot. Triggers: device_state, device_event, capability_state, time, sun, presence, house_mode, interval. Actions: device_command, scene, delay, notify, speak, set_house_mode, wait_until, stop.',
  risk: 'medium',
  readOnly: false,
  parameters: z.object({
    name: z.string(),
    description: z.string(),
    reason: z.string().describe('Why this routine is worth having. Shown to the user on the approval card.'),
    triggers: z.array(z.record(z.string(), z.unknown())),
    conditions: z.array(z.record(z.string(), z.unknown())).default([]),
    actions: z.array(z.record(z.string(), z.unknown())),
    area: z.string().optional(),
  }),
  async execute(args, context) {
    const area = args.area ? places.areas().find((candidate) => candidate.name.toLowerCase() === args.area!.toLowerCase()) : null
    const autopilot = context.autonomy === 'autopilot'

    const routine = routines.create({
      name: args.name,
      description: args.description,
      enabled: true,
      mode: 'restart',
      triggers: args.triggers as never,
      conditions: args.conditions as never,
      actions: args.actions as never,
      authoredBy: 'agent',
      status: autopilot ? 'active' : 'suggested',
      suggestionReason: args.reason,
      areaId: area?.id ?? null,
    })

    return ok(
      autopilot
        ? `Routine "${routine.name}" créée et active.`
        : `Routine "${routine.name}" proposée. Elle attend une validation avant de s exécuter.`,
      { attachments: [{ kind: 'routine', data: { id: routine.id } }] }
    )
  },
})

const runRoutine = tool({
  name: 'run_routine',
  description: 'Run a routine now, by hand.',
  risk: 'medium',
  readOnly: false,
  parameters: z.object({ routine: z.string() }),
  async execute(args) {
    const routine = routines.all().find((candidate) => candidate.id === args.routine || candidate.id.startsWith(args.routine) || candidate.name.toLowerCase() === args.routine.toLowerCase())
    if (!routine) return fail(`Routine introuvable : ${args.routine}`)
    await automationEngine.trigger(routine.id, 'agent')
    return ok(`Routine "${routine.name}" lancée.`)
  },
})

const toggleRoutine = tool({
  name: 'set_routine_state',
  description: 'Enable, pause, approve or archive a routine.',
  risk: 'medium',
  readOnly: false,
  parameters: z.object({ routine: z.string(), status: z.enum(['active', 'paused', 'archived']) }),
  async execute(args) {
    const routine = routines.all().find((candidate) => candidate.id === args.routine || candidate.id.startsWith(args.routine) || candidate.name.toLowerCase() === args.routine.toLowerCase())
    if (!routine) return fail(`Routine introuvable : ${args.routine}`)
    routines.update(routine.id, { status: args.status, enabled: args.status === 'active' })
    return ok(`Routine "${routine.name}" : ${args.status}.`)
  },
})

const remember = tool({
  name: 'remember',
  description:
    'Store one fact about the house or the people in it, in plain language. Use it when the user states a preference, corrects you, or tells you something that will matter next week.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({
    content: z.string().describe('One fact, one sentence. "John works from the office on Tuesdays."'),
    kind: z.enum(['preference', 'fact', 'habit', 'person', 'place', 'correction', 'schedule']).default('fact'),
    subject: z.string().optional().describe('A device or room this is about.'),
  }),
  async execute(args) {
    const device = args.subject ? resolveDevice(args.subject) : null
    const memory = memories.remember({
      kind: args.kind,
      content: args.content,
      subjectType: device ? 'device' : 'house',
      subjectId: device?.id ?? null,
      source: 'stated',
      confidence: 0.9,
    })
    return ok(`Mémorisé : ${memory.content}`)
  },
})

const forget = tool({
  name: 'forget',
  description: 'Delete a stored memory when it turns out to be wrong or no longer true.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({ query: z.string() }),
  async execute(args) {
    const found = memories.search(args.query, 1)[0]
    if (!found) return fail('Aucune mémoire ne correspond.')
    memories.forget(found.id)
    return ok(`Oublié : ${found.content}`)
  },
})

const notify = tool({
  name: 'notify',
  description: 'Send a notification that shows in the console and on the phone.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({
    message: z.string(),
    title: z.string().optional(),
    priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  }),
  async execute(args) {
    const { bus } = await import('#services/event_bus')
    bus.publish('system.notice', {
      origin: 'agent',
      severity: args.priority === 'critical' ? 'critical' : args.priority === 'high' ? 'warning' : 'notice',
      payload: { message: args.message, title: args.title ?? 'Assistant', channel: 'all' },
    })
    return ok('Notification envoyée.')
  },
})

const speak = tool({
  name: 'speak',
  description: 'Say something out loud on a speaker in the house.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({ text: z.string(), device: z.string().optional(), area: z.string().optional() }),
  async execute(args, context) {
    const targets = args.device
      ? [resolveDevice(args.device)].filter((device): device is NonNullable<typeof device> => device !== null)
      : houseService.resolve({ areaName: args.area, capability: 'speech' })
    if (targets.length === 0) return fail('Aucune enceinte capable de parler.')

    const results = await Promise.all(
      targets.map((device) => houseService.execute(device.id, 'speak', { text: args.text }, { origin: 'agent', correlationId: context.correlationId }))
    )
    return ok(`Énoncé sur ${results.filter((result) => result.ok).length} enceinte(s).`)
  },
})

const scanNetwork = tool({
  name: 'scan_network',
  description: 'Scan the local network for new devices. Takes several seconds. Use it when the user says they have plugged something in.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({ deep: z.boolean().default(false) }),
  async execute(args) {
    if (scanService.isRunning()) return ok('Un scan est déjà en cours.')
    const result = await scanService.run({ quick: !args.deep, deep: args.deep })
    return ok(`Scan terminé en ${(result.durationMs / 1000).toFixed(1)} s : ${result.hostCount} hôtes, ${result.newDevices} nouveaux appareils.`)
  },
})

const undoLast = tool({
  name: 'undo_last',
  description: 'Undo the last change made to the house.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({}),
  async execute() {
    const result = await houseService.undoLast()
    return result.ok ? ok(`Annulé : ${result.description}`) : fail('Rien à annuler.')
  },
})

const suggestRoutines = tool({
  name: 'suggest_routines',
  description: 'Look at what has been done by hand recently and propose routines for the repeated patterns.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({}),
  async execute() {
    const created = insightEngine.suggestFromHabits()
    if (created.length === 0) return ok('Aucune habitude assez régulière pour en faire une routine pour l instant.')
    return ok(`${created.length} routine(s) proposée(s) : ${created.map((routine) => routine.name).join(', ')}`)
  },
})

const listAlerts = tool({
  name: 'list_alerts',
  description: 'Open alerts: low batteries, offline devices, leaks, smoke, heating with a window open.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({}),
  async execute() {
    const open = alerts.open()
    if (open.length === 0) return ok('Aucune alerte ouverte.')
    return ok(open.map((alert) => `[${alert.severity}] ${alert.title}${alert.detail ? ` - ${alert.detail}` : ''}`).join('\n'))
  },
})

const whoIsHome = tool({
  name: 'who_is_home',
  description: 'Who is currently home.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({}),
  async execute() {
    const list = people.all()
    if (list.length === 0) return ok('Aucune personne enregistrée.')
    return ok(list.map((person) => `${person.name} : ${person.home ? 'à la maison' : 'absent'}`).join('\n'))
  },
})

const assignArea = tool({
  name: 'assign_area',
  description: 'Put a device in a room, or rename it. Use it after a scan when devices land with no room.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({ device: z.string(), area: z.string().optional(), name: z.string().optional() }),
  async execute(args) {
    const device = resolveDevice(args.device)
    if (!device) return fail(`Appareil introuvable : ${args.device}`)

    let areaId: string | undefined
    if (args.area) {
      const area = places.areas().find((candidate) => candidate.name.toLowerCase() === args.area!.toLowerCase())
      if (!area) return fail(`Pièce introuvable : ${args.area}. Pièces : ${places.areas().map((candidate) => candidate.name).join(', ')}`)
      areaId = area.id
    }

    deviceRepository.update(device.id, { areaId, name: args.name })
    return ok(`${args.name ?? device.name} ${args.area ? `placé dans ${args.area}` : 'mis à jour'}.`)
  },
})

// ---------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------------------

const listWidgets = tool({
  name: 'list_widgets',
  description: 'List the cards currently on the dashboard, with their id, type and what they show.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({}),
  async execute() {
    const list = widgets.all()
    if (list.length === 0) return ok('Le tableau de bord est vide.')
    return ok(
      list
        .map((widget) => `${widget.id.slice(0, 8)} ${widget.type} "${widget.title}" (${widget.size}, par ${widget.authoredBy})`)
        .join('\n')
    )
  },
})

const describeDashboardVocabulary = tool({
  name: 'dashboard_vocabulary',
  description:
    'What a widget can point at in THIS house: the areas, the capabilities and the categories that actually exist, plus the widget types and their sources. Call this before create_widget when unsure.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({}),
  async execute() {
    const vocabulary = widgetService.vocabulary()
    return ok(
      [
        `types : ${WIDGET_TYPES.join(', ')}`,
        `tailles : ${WIDGET_SIZES.join(', ')}`,
        `pièces : ${vocabulary.areas.map((area) => `${area.name}=${area.id.slice(0, 8)}`).join(', ')}`,
        `capacités : ${vocabulary.capabilities.join(', ')}`,
        `catégories : ${vocabulary.categories.join(', ')}`,
        widgetCatalogueForPrompt(),
      ].join('\n')
    )
  },
})

const showWidget = tool({
  name: 'show_widget',
  description:
    'Render a live card in the conversation to answer a question visually: a number, a gauge, a chart, a room, a list of devices. The card updates by itself and disappears with the conversation. Prefer this over describing numbers in prose, and use create_widget only when the user asks to keep it on the dashboard.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({
    type: z.enum(WIDGET_TYPES),
    title: z.string(),
    size: z.enum(WIDGET_SIZES).default('md'),
    source: z.record(z.string(), z.unknown()).describe('The data source. See dashboard_vocabulary for the shapes.'),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
  async execute(args) {
    const at = new Date().toISOString()
    const parsed = widgetSchema.safeParse({
      id: `live-${randomUUID()}`,
      type: args.type,
      title: args.title,
      size: args.size,
      source: args.source,
      options: args.options ?? {},
      authoredBy: 'agent',
      createdAt: at,
      updatedAt: at,
    })
    if (!parsed.success) {
      return fail(`Source invalide : ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'kind'} ${issue.message}`).join('; ')}`)
    }

    const resolved = widgetService.resolve(parsed.data)
    if (resolved.data.kind === 'empty') return fail(resolved.data.message)

    // Nothing is written: a question that produced a card must not leave the dashboard
    // cluttered with one tile per thing anyone ever asked about.
    return ok(`Carte "${resolved.title}" affichée.`, { attachments: [{ kind: 'widget', data: { widget: resolved } }] })
  },
})

/**
 * Turns a measure name into everything a chart needs. The model is given the short names in
 * the description rather than a schema of capability ids, because a model asked for
 * "humidity" gets it right far more often than one asked for `capability` and `attribute`.
 */
interface MeasureRef {
  capability: string | null
  attribute: string
  label: string
  unit: string | null
  decimals: number
  icon: string
  aggregate: 'avg' | 'sum' | 'min' | 'max'
  goodDirection: 'up' | 'down' | 'none'
}

function measureOrAttribute(name: string): MeasureRef | null {
  const measure = measureById(name) ?? MEASURES.find((entry) => entry.attribute === name || entry.capability === name) ?? null
  if (measure) {
    return { capability: measure.capability, attribute: measure.attribute, label: measure.label, unit: measure.unit, decimals: measure.decimals, icon: measure.icon, aggregate: measure.aggregate, goodDirection: measure.goodDirection }
  }
  // A raw attribute name is still allowed, so a measure nobody thought to name is reachable.
  if (/^[a-zA-Z][a-zA-Z0-9_]{1,30}$/.test(name)) return { capability: null, attribute: name, label: name, unit: null, decimals: 1, icon: 'ph:gauge', aggregate: 'avg', goodDirection: 'none' }
  return null
}

function liveWidget(type: string, title: string, size: string, source: Record<string, unknown>) {
  const at = new Date().toISOString()
  return widgetSchema.safeParse({ id: `live-${randomUUID()}`, type, title, size, source, options: {}, authoredBy: 'agent', createdAt: at, updatedAt: at })
}

const MEASURE_NAMES = MEASURES.map((measure) => measure.id).join(', ')

const analyseHistory = tool({
  name: 'analyse_history',
  description: `Analyse how a measurement moved over a period and show the curve. Returns the average, the range and the direction in one sentence, plus a chart card. Use it for "analyse the humidity over the last month", "how did the temperature move this week", "what was the peak". Measures: ${MEASURE_NAMES}, or any raw attribute name. hours is the width of the window (720 = a month); offsetHours ends it in the past (24 = yesterday).`,
  risk: 'none',
  readOnly: true,
  parameters: z.object({
    measure: z.string(),
    areaId: z.string().nullable().default(null),
    deviceId: z.string().nullable().default(null),
    hours: z.number().int().min(1).max(8760).default(24),
    offsetHours: z.number().int().min(0).max(8760).default(0),
    aggregate: z.enum(['avg', 'sum', 'min', 'max']).default('avg'),
  }),
  async execute(args) {
    const measure = measureOrAttribute(args.measure)
    if (!measure) return fail(`Je ne sais pas mesurer "${args.measure}". Mesures connues : ${MEASURE_NAMES}.`)

    const period = periodLabel(args.hours, args.offsetHours)
    const parsed = liveWidget('chart', `${measure.label.charAt(0).toUpperCase()}${measure.label.slice(1)} (${period})`, 'lg', {
      kind: 'history',
      capability: measure.capability,
      attribute: measure.attribute,
      areaId: args.areaId,
      deviceId: args.deviceId,
      hours: args.hours,
      offsetHours: args.offsetHours,
      aggregate: args.aggregate,
      bucket: 'auto',
    })
    if (!parsed.success) return fail('Cette analyse est mal formée.')

    const resolved = widgetService.resolve(parsed.data)
    if (resolved.data.kind === 'empty') return fail(resolved.data.message)

    const sentence = describeSeries(resolved.data, {
      label: measure.label.charAt(0).toUpperCase() + measure.label.slice(1),
      unit: measure.unit,
      decimals: measure.decimals,
      period,
      icon: measure.icon,
      goodDirection: measure.goodDirection,
    })
    return ok(sentence, { attachments: [{ kind: 'widget', data: { widget: resolved } }] })
  },
})

const compareHistory = tool({
  name: 'compare_history',
  description: `Compare the same measurement across several rooms or several devices, on one chart. Use it for "which room is the most humid", "compare the bedroom and the living room". Pass at least two areaIds, or at least two deviceIds. Measures: ${MEASURE_NAMES}.`,
  risk: 'none',
  readOnly: true,
  parameters: z.object({
    measure: z.string(),
    areaIds: z.array(z.string()).default([]),
    deviceIds: z.array(z.string()).default([]),
    hours: z.number().int().min(1).max(8760).default(168),
    offsetHours: z.number().int().min(0).max(8760).default(0),
    aggregate: z.enum(['avg', 'sum', 'min', 'max']).default('avg'),
  }),
  async execute(args) {
    const measure = measureOrAttribute(args.measure)
    if (!measure) return fail(`Je ne sais pas mesurer "${args.measure}". Mesures connues : ${MEASURE_NAMES}.`)
    if (args.areaIds.length < 2 && args.deviceIds.length < 2) return fail('Une comparaison demande au moins deux pièces ou deux appareils.')

    const period = windowLabel(args.hours)
    const parsed = liveWidget('compare', `${measure.label.charAt(0).toUpperCase()}${measure.label.slice(1)} (${period})`, 'lg', {
      kind: 'compare',
      capability: measure.capability ?? measure.attribute,
      attribute: measure.attribute,
      areaIds: args.areaIds,
      deviceIds: args.areaIds.length >= 2 ? [] : args.deviceIds,
      hours: args.hours,
      offsetHours: args.offsetHours,
      aggregate: args.aggregate,
    })
    if (!parsed.success) return fail('Cette comparaison est mal formée.')

    const resolved = widgetService.resolve(parsed.data)
    if (resolved.data.kind !== 'multi-series') return fail(resolved.data.kind === 'empty' ? resolved.data.message : 'Rien à comparer.')

    // Sorted, because the answer to "which room is the most humid" is the order.
    const ranked = [...resolved.data.series].sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0))
    const parts = ranked.map((entry) => `${entry.label} ${entry.avg === null ? '?' : entry.avg.toFixed(measure.decimals)}${measure.unit ? ` ${measure.unit}` : ''}`)
    return ok(`${measure.label.charAt(0).toUpperCase()}${measure.label.slice(1)} ${period} : ${parts.join(', ')}.`, {
      attachments: [{ kind: 'widget', data: { widget: resolved } }],
    })
  },
})

/** How a window is named in a title, so a pinned copy of the card still reads right. */
function windowLabel(hours: number): string {
  if (hours <= 36) return `sur ${hours} h`
  if (hours <= 24 * 14) return `sur ${Math.round(hours / 24)} jours`
  if (hours <= 24 * 90) return `sur ${Math.round(hours / 24 / 7)} semaines`
  return `sur ${Math.round(hours / 24 / 30)} mois`
}

/** A window that may end in the past: "hier" rather than "sur 24 h il y a 24 h". */
function periodLabel(hours: number, offsetHours: number): string {
  if (offsetHours === 0) return windowLabel(hours)
  if (hours === 24 && offsetHours === 24) return 'hier'
  if (hours === 24 && offsetHours === 48) return 'avant-hier'
  const ago = offsetHours % 24 === 0 ? `${offsetHours / 24} jours` : `${offsetHours} h`
  return `${windowLabel(hours)}, il y a ${ago}`
}

const rank = tool({
  name: 'rank',
  description: `Rank rooms or devices by a measurement, right now or over a period, as one sentence and a card of bars. Use it for "which room uses the most power", "what draws the most right now", "which device used the most this week", "where is it warmest", "the most humid room". hours 0 is right now; for power, a period ranks energy in kWh. order asc puts the lowest first (the coldest room). indoor leaves the garden out. areaId keeps the devices of one room. Measures: ${MEASURE_NAMES}.`,
  risk: 'none',
  readOnly: true,
  parameters: z.object({
    measure: z.string(),
    by: z.enum(['area', 'device']).default('area'),
    order: z.enum(['desc', 'asc']).default('desc'),
    hours: z.number().int().min(0).max(8760).default(0),
    offsetHours: z.number().int().min(0).max(8760).default(0),
    indoor: z.boolean().default(false),
    areaId: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(12).default(5),
  }),
  async execute(args) {
    const measure = measureOrAttribute(args.measure)
    if (!measure) return fail(`Je ne sais pas mesurer "${args.measure}". Mesures connues : ${MEASURE_NAMES}.`)

    const period = args.hours === 0 ? null : periodLabel(args.hours, args.offsetHours)
    const energy = args.hours > 0 && measure.attribute === 'power'
    const label = `${measure.label.charAt(0).toUpperCase()}${measure.label.slice(1)}`
    const title = `${energy ? 'Énergie' : label} ${args.by === 'area' ? 'par pièce' : 'par appareil'}${period ? ` (${period})` : ''}`
    const parsed = liveWidget('ranking', title, 'md', {
      kind: 'ranking',
      capability: measure.capability ?? measure.attribute,
      attribute: measure.attribute,
      by: args.by,
      order: args.order,
      hours: args.hours,
      offsetHours: args.offsetHours,
      aggregate: measure.aggregate,
      indoor: args.indoor,
      areaId: args.areaId,
      limit: args.limit,
    })
    if (!parsed.success) return fail('Ce classement est mal formé.')

    const resolved = widgetService.resolve(parsed.data)
    const sentence = describeRanking(resolved.data, { label: measure.label, icon: measure.icon, decimals: measure.decimals, period })
    if (resolved.data.kind !== 'ranking') return fail(sentence)
    return ok(sentence, { attachments: [{ kind: 'widget', data: { widget: resolved } }] })
  },
})

const createWidget = tool({
  name: 'create_widget',
  description:
    'Add a card to the dashboard. Use it when the user asks to see something on their dashboard. Call dashboard_vocabulary first when unsure which area id or capability to use.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({
    type: z.enum(WIDGET_TYPES),
    title: z.string(),
    size: z.enum(WIDGET_SIZES).default('sm'),
    subtitle: z.string().optional(),
    icon: z.string().optional().describe('A Phosphor icon name such as ph:drop'),
    source: z.record(z.string(), z.unknown()).describe('The data source. See dashboard_vocabulary for the shapes.'),
    options: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().optional().describe('Why you are adding it. Shown to the user on the card.'),
  }),
  async execute(args) {
    // Validated against the same schema the REST API uses: a source the resolver cannot read
    // fails here, with a message the model can act on, rather than producing a dead card.
    const parsed = widgetSchema
      .pick({ type: true, title: true, size: true, subtitle: true, icon: true, source: true, options: true })
      .safeParse({
        type: args.type,
        title: args.title,
        size: args.size,
        subtitle: args.subtitle ?? null,
        icon: args.icon ?? null,
        source: args.source,
        options: args.options ?? {},
      })
    if (!parsed.success) {
      return fail(`Source invalide: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
    }

    const widget = widgets.create({ ...parsed.data, authoredBy: 'agent', reason: args.reason ?? null })
    const data = widgetService.data(widget)
    if (data.kind === 'empty') {
      // A card that resolves to nothing is worse than no card: remove it and say why.
      widgets.remove(widget.id)
      return fail(`Cette carte ne donnerait rien: ${data.message}`)
    }
    return ok(`Carte "${widget.title}" ajoutée au tableau de bord.`, { data: { widgetId: widget.id, type: widget.type } })
  },
})

const updateWidget = tool({
  name: 'update_widget',
  description: 'Rename, resize, move or retarget an existing dashboard card.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({
    widgetId: z.string(),
    title: z.string().optional(),
    size: z.enum(WIDGET_SIZES).optional(),
    position: z.number().int().optional(),
    source: z.record(z.string(), z.unknown()).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
  async execute(args) {
    const target = widgets.all().find((widget) => widget.id === args.widgetId || widget.id.startsWith(args.widgetId))
    if (!target) return fail('Carte introuvable.')
    const updated = widgets.update(target.id, {
      title: args.title,
      size: args.size,
      position: args.position,
      source: args.source as never,
      options: args.options as never,
    })
    return ok(`Carte "${updated?.title}" mise à jour.`)
  },
})

const removeWidget = tool({
  name: 'remove_widget',
  description: 'Remove a card from the dashboard.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({ widgetId: z.string() }),
  async execute(args) {
    const target = widgets.all().find((widget) => widget.id === args.widgetId || widget.id.startsWith(args.widgetId))
    if (!target) return fail('Carte introuvable.')
    widgets.remove(target.id)
    return ok(`Carte "${target.title}" retirée.`)
  },
})

const announce = tool({
  name: 'announce',
  description:
    'Tell the user something without being asked: it appears in the console and is read out loud unless it is quiet hours. Use it sparingly, only for things worth interrupting for.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({
    text: z.string(),
    severity: z.enum(['info', 'notice', 'warning', 'critical']).default('info'),
    subjectId: z.string().nullable().default(null),
    dedupeKey: z.string().nullable().default(null).describe('Anything with the same key is only said once.'),
  }),
  async execute(args) {
    const said = narrator.announce({
      kind: 'agent.said',
      text: args.text,
      severity: args.severity,
      subjectId: args.subjectId,
      dedupeKey: args.dedupeKey,
      repeatAfterMinutes: 60,
    })
    if (!said) return ok('Rien dit : déjà annoncé récemment, ou budget horaire atteint.')
    return ok(said.speak ? 'Annoncé et énoncé à voix haute.' : "Annoncé à l'écran, heures calmes.")
  },
})

// ---------------------------------------------------------------------------------------
// Autonomy
// ---------------------------------------------------------------------------------------

const AUTONOMY_SAID: Record<AutonomyLevel, string> = {
  observer: "C'est noté : je regarde et je réponds, sans rien toucher.",
  assistant: "C'est noté : je vous demande avant d'agir.",
  copilot: "C'est noté : j'agis seul pour le quotidien et je vous demande pour le reste.",
  autopilot: "C'est noté : je gère la maison, seules les serrures, caméras et alarmes attendent votre accord.",
}

const getAutonomy = tool({
  name: 'get_autonomy',
  description:
    'What the assistant does on its own, without being asked: its autonomy level, the reflexes that are on (heating off when a window opens, lights off in empty rooms, water closed on a leak...) and how many times it acted today. Call it for "que fais-tu de proactif", "tu agis tout seul ?". Returns one sentence to say as is.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({}),
  async execute() {
    const status = autonomyEngine.status()
    return ok(describeAutonomy({ actsAlone: status.actsAlone, enabled: status.enabled, today: status.today }), { data: status })
  },
})

const setAutonomy = tool({
  name: 'set_autonomy',
  description:
    'Change how much the assistant does on its own. Only when the person explicitly asks: "agis seul", "sois autonome" -> copilot; "gère tout" -> autopilot; "demande-moi avant" -> assistant; "ne touche à rien" -> observer. Never on your own initiative.',
  risk: 'low',
  readOnly: false,
  parameters: z.object({ level: z.enum(AUTONOMY_LEVELS) }),
  async execute(args, context) {
    // A routine raising its own autonomy is exactly the loop a human must stay above.
    if (context.unattended) return fail("Le niveau d'autonomie ne se change pas depuis une routine.")
    const previous = autonomyEngine.level()
    settings.patch('agent', { autonomy: args.level })
    bus.publish('agent.autonomy_changed', { subjectType: 'agent', origin: 'user', payload: { level: args.level, previous } })
    return ok(AUTONOMY_SAID[args.level])
  },
})

// ---------------------------------------------------------------------------------------
// Asking back
// ---------------------------------------------------------------------------------------

/** A stable id from a label: "Plafonnier salon" becomes "plafonnier-salon". */
function slug(value: string, taken: Set<string>): string {
  const base = normalise(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'choix'
  let id = base
  for (let index = 2; taken.has(id); index += 1) id = `${base}-${index}`
  taken.add(id)
  return id
}

/** An id given by the caller is kept as it is (a device id, "*" for all) when it is usable. */
function keepOrSlug(id: string | undefined, label: string, taken: Set<string>): string {
  if (id && /^[A-Za-z0-9*_.:-]{1,60}$/.test(id) && !taken.has(id)) {
    taken.add(id)
    return id
  }
  return slug(id || label, taken)
}

const askUser = tool({
  name: 'ask_user',
  description:
    'Ask the person one to four short questions, each with two to eight options, when two choices are genuinely equivalent (which lamp, which day, which room). The run ends on the questions; the answer arrives as the next message. Never ask in plain text instead.',
  risk: 'none',
  readOnly: true,
  parameters: z.object({
    questions: z
      .array(
        z.object({
          id: z.string().max(40).optional(),
          title: z.string().min(1).max(160),
          description: z.string().max(400).optional(),
          options: z
            .array(z.object({ id: z.string().max(60).optional(), label: z.string().min(1).max(80), hint: z.string().max(160).optional() }))
            .min(2)
            .max(8),
          multiple: z.boolean().default(false),
          allowOther: z.boolean().default(false),
        })
      )
      .min(1)
      .max(4),
  }),
  async execute(args, context) {
    // A routine runs with nobody in front of the screen: a question would wait forever.
    if (context.unattended) return fail("Personne à qui poser la question : décide ou abstiens-toi.")

    const questionIds = new Set<string>()
    const questions = args.questions.map((question) => {
      const optionIds = new Set<string>()
      return {
        id: keepOrSlug(question.id, question.title, questionIds),
        title: question.title,
        ...(question.description ? { description: question.description } : {}),
        options: question.options.map((option) => ({
          id: keepOrSlug(option.id, option.label, optionIds),
          label: option.label,
          ...(option.hint ? { hint: option.hint } : {}),
        })),
        multiple: question.multiple,
        allowOther: question.allowOther,
      }
    })
    return ok(`Question posée : ${questions.map((question) => question.title).join(' / ')}. Attends la réponse.`, { questions })
  },
})

export const AGENT_TOOLS: AgentTool<z.ZodType>[] = [
  listDevices as unknown as AgentTool<z.ZodType>,
  getDevice as unknown as AgentTool<z.ZodType>,
  houseSnapshot as unknown as AgentTool<z.ZodType>,
  getHistory as unknown as AgentTool<z.ZodType>,
  getEnergy as unknown as AgentTool<z.ZodType>,
  getTimeline as unknown as AgentTool<z.ZodType>,
  listRoutines as unknown as AgentTool<z.ZodType>,
  listScenes as unknown as AgentTool<z.ZodType>,
  listAlerts as unknown as AgentTool<z.ZodType>,
  whoIsHome as unknown as AgentTool<z.ZodType>,
  networkView as unknown as AgentTool<z.ZodType>,
  recall as unknown as AgentTool<z.ZodType>,
  controlDevice as unknown as AgentTool<z.ZodType>,
  controlMany as unknown as AgentTool<z.ZodType>,
  activateScene as unknown as AgentTool<z.ZodType>,
  saveScene as unknown as AgentTool<z.ZodType>,
  setHouseMode as unknown as AgentTool<z.ZodType>,
  createRoutine as unknown as AgentTool<z.ZodType>,
  runRoutine as unknown as AgentTool<z.ZodType>,
  toggleRoutine as unknown as AgentTool<z.ZodType>,
  remember as unknown as AgentTool<z.ZodType>,
  forget as unknown as AgentTool<z.ZodType>,
  notify as unknown as AgentTool<z.ZodType>,
  speak as unknown as AgentTool<z.ZodType>,
  scanNetwork as unknown as AgentTool<z.ZodType>,
  undoLast as unknown as AgentTool<z.ZodType>,
  suggestRoutines as unknown as AgentTool<z.ZodType>,
  assignArea as unknown as AgentTool<z.ZodType>,
  showWidget as unknown as AgentTool<z.ZodType>,
  analyseHistory as unknown as AgentTool<z.ZodType>,
  compareHistory as unknown as AgentTool<z.ZodType>,
  rank as unknown as AgentTool<z.ZodType>,
  listWidgets as unknown as AgentTool<z.ZodType>,
  describeDashboardVocabulary as unknown as AgentTool<z.ZodType>,
  createWidget as unknown as AgentTool<z.ZodType>,
  updateWidget as unknown as AgentTool<z.ZodType>,
  removeWidget as unknown as AgentTool<z.ZodType>,
  announce as unknown as AgentTool<z.ZodType>,
  getAutonomy as unknown as AgentTool<z.ZodType>,
  setAutonomy as unknown as AgentTool<z.ZodType>,
  askUser as unknown as AgentTool<z.ZodType>,
]

export function toolByName(name: string): AgentTool<z.ZodType> | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name)
}

/** JSON Schema for the providers. Produced from the same zod objects the tools validate with. */
export function toolSchemas(): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) as Record<string, unknown>,
  }))
}

export { resolveDevice, describeDevice }
