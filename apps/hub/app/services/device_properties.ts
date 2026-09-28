/**
 * Computed columns of the device table.
 *
 * The devices page is a spreadsheet whose columns are properties. Beside the facts (name,
 * room, state) it has computed columns: presets that are rules over what the hub knows
 * ("Batterie à changer ?", "Pièce probable", "Hors ligne depuis", "Conso 7 j"), and columns
 * a person describes in a sentence, which a model fills. Values are kept, so the table does
 * not ask again on every visit, and they arrive one device at a time while a column runs.
 *
 * A model's answer is checked before it is kept: a value outside the options, a device it
 * forgot, a reply that is not JSON - each leaves its cell empty and the run goes on.
 *
 * A column is edited in place. Its kept values stay while they still answer its question -
 * a new name, another model - and go when the question changes: a new instruction, kind or
 * list of choices. A column may name its own model; one that cannot run says why, and is
 * never swapped for the model in the settings.
 */

import { randomUUID } from 'node:crypto'
import type { Device } from '@sway-home/shared'
import { database, nowIso } from '#db/database'
import { deviceRepository } from '#repositories/device_repository'
import { places, settings } from '#repositories/store'
import { normalise } from '#agent/language'
import type { ModelProvider } from '#agent/providers'
import { configuredProvider, recordModelUse, withinBudget } from '#agent/agent_service'
import { OFFLINE, parseChoiceId, providerForChoice } from '#agent/model_choice'

export type PropertyKind = 'text' | 'select' | 'number' | 'boolean'
export type PropertyValue = string | number | boolean | null

export interface DeviceProperty {
  id: string
  label: string
  /** What the column is, in words: the instruction a model follows. */
  prompt: string
  kind: PropertyKind
  options?: string[]
  /** Presets are rules; a column described in words needs a model. */
  needsModel: boolean
  preset: boolean
  /** The picker's `provider:model` id; absent, the column uses the model in the settings. */
  model?: string
}

export interface PropertyInput {
  label: string
  prompt: string
  kind: PropertyKind
  options?: string[]
  model?: string
}

/** A partial edit. `model: null` forgets the column's own model (a JSON Merge Patch null). */
export type PropertyPatch = Partial<Omit<PropertyInput, 'model'>> & { model?: string | null }

const SETTINGS_KEY = 'devices.aiProperties'
const NEEDS_MODEL = 'Il faut un modèle pour remplir cette colonne : branchez-en un dans Réglages > Assistant.'
const DECIMAL = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 })

function areaName(device: Device): string | null {
  return device.areaId ? places.areas().find((area) => area.id === device.areaId)?.name ?? null : null
}

function since(iso: string | null | undefined): string | null {
  if (!iso) return null
  const hours = Math.max(0, (Date.now() - Date.parse(iso)) / 3_600_000)
  if (hours < 1) return "moins d'une heure"
  if (hours < 48) return `${Math.round(hours)} h`
  return `${Math.round(hours / 24)} j`
}

/** The rules behind the preset columns. */
const PRESET_RULES: Record<string, (device: Device) => PropertyValue> = {
  'battery-change': (device) => (typeof device.state.battery === 'number' ? (device.state.battery < 20 ? 'Oui' : 'Non') : null),
  'room-guess': (device) => {
    const own = areaName(device)
    if (own) return own
    const name = normalise(device.name)
    return places.areas().find((area) => name.includes(normalise(area.name)))?.name ?? null
  },
  'offline-since': (device) => (device.online ? null : since(device.lastSeenAt ?? device.updatedAt)),
  'energy-week': (device) => {
    const row = database().get<{ kwh: number | null }>(
      'SELECT SUM(kwh) AS kwh FROM energy_hourly WHERE device_id = ? AND hour >= ?',
      [device.id, new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 13)]
    )
    return row?.kwh ? Math.round(Number(row.kwh) * 100) / 100 : null
  },
}

export const PROPERTY_PRESETS: DeviceProperty[] = [
  { id: 'battery-change', label: 'Batterie à changer ?', prompt: 'Oui sous 20 % de batterie.', kind: 'select', options: ['Oui', 'Non'], needsModel: false, preset: true },
  { id: 'room-guess', label: 'Pièce probable', prompt: "La pièce de l'appareil, ou celle que son nom désigne.", kind: 'text', needsModel: false, preset: true },
  { id: 'offline-since', label: 'Hors ligne depuis', prompt: "Depuis quand l'appareil ne répond plus.", kind: 'text', needsModel: false, preset: true },
  { id: 'energy-week', label: 'Conso 7 j (kWh)', prompt: "L'énergie consommée sur sept jours.", kind: 'number', needsModel: false, preset: true },
]

function custom(): DeviceProperty[] {
  return settings.get<DeviceProperty[]>(SETTINGS_KEY, [])
}

function checkedModel(id: string): string {
  const trimmed = id.trim()
  if (trimmed === OFFLINE) throw new Error('Le moteur local ne remplit pas de colonne : choisissez un modèle.')
  const parsed = parseChoiceId(trimmed)
  if (!parsed) throw new Error('Modèle inconnu')
  return `${parsed.providerId}:${parsed.model}`
}

/** The fields of a column once checked - the same rules for a new column and for an edit. */
function checked(input: PropertyInput): Omit<DeviceProperty, 'id' | 'needsModel' | 'preset'> {
  const label = input.label?.trim().slice(0, 40)
  const prompt = input.prompt?.trim().slice(0, 300)
  if (!label) throw new Error('Nom de colonne manquant')
  if (!prompt) throw new Error('Consigne manquante')
  if (!['text', 'select', 'number', 'boolean'].includes(input.kind)) throw new Error('Type de colonne inconnu')
  const options = input.kind === 'select' ? [...new Set((input.options ?? []).map((option) => option.trim().slice(0, 40)).filter(Boolean))] : undefined
  if (options && (options.length < 2 || options.length > 8)) throw new Error('Une liste de choix a de deux à huit options')
  const model = input.model ? checkedModel(input.model) : undefined
  return { label, prompt, kind: input.kind, ...(options ? { options } : {}), ...(model ? { model } : {}) }
}

/** Whether the kept values still answer the column: only its question matters, not its name. */
function sameQuestion(before: DeviceProperty, after: DeviceProperty): boolean {
  return before.prompt === after.prompt && before.kind === after.kind && JSON.stringify(before.options ?? []) === JSON.stringify(after.options ?? [])
}

function dropValues(propertyId: string): void {
  database().run('DELETE FROM device_property_values WHERE property_id = ?', [propertyId])
}

/** The model a column runs on: its own, else the one in the settings. */
function providerFor(property: DeviceProperty): ModelProvider {
  if (property.model) {
    const chosen = providerForChoice(property.model)
    if (!chosen.provider) throw new Error(`Le modèle de la colonne ne peut pas servir : ${chosen.error ?? 'indisponible'}.`)
    return chosen.provider
  }
  const provider = configuredProvider()
  if (!provider) throw new Error(NEEDS_MODEL)
  return provider
}

function describe(device: Device): string {
  const bits: string[] = []
  const state = device.state
  if (typeof state.on === 'boolean') bits.push(state.on ? 'allumé' : 'éteint')
  if (typeof state.brightness === 'number') bits.push(`luminosité ${state.brightness} %`)
  if (typeof state.temperature === 'number') bits.push(`${DECIMAL.format(state.temperature)} °C`)
  if (typeof state.battery === 'number') bits.push(`batterie ${state.battery} %`)
  if (typeof state.power === 'number') bits.push(`${DECIMAL.format(state.power)} W`)
  if (typeof state.locked === 'boolean') bits.push(state.locked ? 'verrouillé' : 'déverrouillé')
  if (!device.online) bits.push('hors ligne')
  return `${device.id.slice(0, 8)} ${device.name} | pièce ${areaName(device) ?? 'aucune'} | ${device.category} | ${bits.join(', ') || 'aucun état'}`
}

function instruction(property: DeviceProperty): string {
  const rule =
    property.kind === 'select'
      ? `Chaque valeur est exactement l'une de : ${(property.options ?? []).join(', ')}.`
      : property.kind === 'number'
        ? 'Chaque valeur est un nombre.'
        : property.kind === 'boolean'
          ? 'Chaque valeur est true ou false.'
          : 'Chaque valeur est un texte de quelques mots, en français.'
  return [
    `Tu remplis la colonne « ${property.label} » d'un tableau des appareils d'une maison.`,
    `Consigne : ${property.prompt}`,
    rule,
    "Réponds uniquement par un objet JSON : les clés sont les identifiants courts (les 8 premiers caractères de chaque ligne), les valeurs le résultat pour l'appareil. Mets null quand tu ne sais pas.",
  ].join('\n')
}

/** A value from a model, as the column's kind allows it; anything else is no value. */
function accept(property: DeviceProperty, raw: unknown): PropertyValue {
  if (raw === null || raw === undefined) return null
  switch (property.kind) {
    case 'select': {
      const text = String(raw).trim()
      return property.options?.find((option) => normalise(option) === normalise(text)) ?? null
    }
    case 'number': {
      const value = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'))
      return Number.isFinite(value) ? value : null
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw
      if (/^(true|oui|yes)$/i.test(String(raw).trim())) return true
      if (/^(false|non|no)$/i.test(String(raw).trim())) return false
      return null
    default: {
      const text = String(raw).trim()
      return text.length > 0 ? text.slice(0, 80) : null
    }
  }
}

function parseReply(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function store(propertyId: string, deviceId: string, value: PropertyValue): void {
  database().run(
    `INSERT INTO device_property_values (property_id, device_id, value, computed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(property_id, device_id) DO UPDATE SET value = excluded.value, computed_at = excluded.computed_at`,
    [propertyId, deviceId, JSON.stringify(value), nowIso()]
  )
}

export const deviceProperties = {
  list(): DeviceProperty[] {
    return [...PROPERTY_PRESETS, ...custom()]
  },

  find(id: string): DeviceProperty | null {
    return deviceProperties.list().find((property) => property.id === id) ?? null
  },

  define(input: PropertyInput): DeviceProperty {
    const property: DeviceProperty = { id: `custom-${randomUUID().slice(0, 8)}`, ...checked(input), needsModel: true, preset: false }
    settings.set(SETTINGS_KEY, [...custom(), property])
    return property
  },

  /** Edits a column in place; null when there is no such column. */
  update(id: string, patch: PropertyPatch): DeviceProperty | null {
    if (PROPERTY_PRESETS.some((preset) => preset.id === id)) throw new Error('Une colonne prédéfinie ne se modifie pas.')
    const columns = custom()
    const before = columns.find((property) => property.id === id)
    if (!before) return null

    const model = patch.model === null ? undefined : patch.model ?? before.model
    const after: DeviceProperty = {
      id,
      ...checked({
        label: patch.label ?? before.label,
        prompt: patch.prompt ?? before.prompt,
        kind: patch.kind ?? before.kind,
        options: patch.options ?? before.options,
        model,
      }),
      needsModel: true,
      preset: false,
    }
    settings.set(SETTINGS_KEY, columns.map((property) => (property.id === id ? after : property)))
    if (!sameQuestion(before, after)) dropValues(id)
    return after
  },

  remove(id: string): boolean {
    const kept = custom().filter((property) => property.id !== id)
    if (kept.length === custom().length) return false
    settings.set(SETTINGS_KEY, kept)
    dropValues(id)
    return true
  },

  /** Every kept value, by column then device. */
  values(): Record<string, Record<string, { value: PropertyValue; computedAt: string }>> {
    const out: Record<string, Record<string, { value: PropertyValue; computedAt: string }>> = {}
    for (const row of database().all<{ property_id: string; device_id: string; value: string | null; computed_at: string }>('SELECT * FROM device_property_values')) {
      let value: PropertyValue = null
      try {
        value = row.value === null ? null : (JSON.parse(row.value) as PropertyValue)
      } catch {
        value = null
      }
      ;(out[row.property_id] ??= {})[row.device_id] = { value, computedAt: row.computed_at }
    }
    return out
  },

  /**
   * Fills a column for every device and keeps the values. `onValue` hears each device as it
   * resolves - one by one for a preset, a batch at a time for a model.
   */
  async run(
    id: string,
    options: { provider?: ModelProvider; batchSize?: number; onValue?: (deviceId: string, value: PropertyValue) => void; signal?: AbortSignal } = {}
  ): Promise<Map<string, PropertyValue>> {
    const property = deviceProperties.find(id)
    if (!property) throw new Error('Colonne inconnue')

    const devices = deviceRepository
      .all({ limit: 1000 })
      .filter((device) => !device.hidden)
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    const out = new Map<string, PropertyValue>()
    const settle = (deviceId: string, value: PropertyValue) => {
      out.set(deviceId, value)
      store(property.id, deviceId, value)
      options.onValue?.(deviceId, value)
    }

    const rule = PRESET_RULES[property.id]
    if (rule) {
      for (const device of devices) settle(device.id, rule(device))
      return out
    }

    const provider = options.provider ?? providerFor(property)
    if (!withinBudget(provider)) throw new Error('Budget quotidien atteint pour les modèles en ligne.')

    const size = Math.max(1, Math.min(50, options.batchSize ?? 20))
    for (let start = 0; start < devices.length; start += size) {
      if (options.signal?.aborted) break
      const batch = devices.slice(start, start + size)
      const started = performance.now()
      let reply: Record<string, unknown> | null = null
      try {
        const response = await provider.chat({
          messages: [
            { role: 'system', content: instruction(property) },
            { role: 'user', content: batch.map(describe).join('\n') },
          ],
          temperature: 0.2,
          maxTokens: 60 * batch.length + 100,
          signal: options.signal,
        })
        recordModelUse({ provider, trigger: 'property', goal: `property:${property.label}`, usage: response.usage, latencyMs: Math.round(performance.now() - started) })
        reply = parseReply(response.content)
      } catch (error) {
        if (options.signal?.aborted) break
        recordModelUse({ provider, trigger: 'property', goal: `property:${property.label}`, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, latencyMs: Math.round(performance.now() - started), error: (error as Error).message })
      }
      for (const device of batch) settle(device.id, accept(property, reply?.[device.id.slice(0, 8)]))
    }
    return out
  },
}
