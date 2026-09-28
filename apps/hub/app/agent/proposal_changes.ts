/**
 * What a proposal changes, row by row.
 *
 * A proposal is a list of commands; a person reviews states. "turnOff" on the ceiling light
 * becomes "allumé -> éteint", "setTargetTemperature 21.5" becomes "20 °C -> 21,5 °C". Each row
 * is shown in the review table with a switch to leave it out, so the words have to say what
 * will actually be different afterwards, from the state the hub knows now.
 */

import type { Device, Proposal } from '@sway-home/shared'
import { deviceRepository } from '#repositories/device_repository'
import { places } from '#repositories/store'

export interface ProposalChange {
  /** Position in the proposal's command list: what `approveProposal(id, { include })` takes. */
  index: number
  deviceId: string
  deviceName: string
  area: string | null
  command: string
  /** The command in words, as a verb. */
  label: string
  /** What the device does now, when the hub knows; null for a device it no longer has. */
  before: string | null
  /** What it will do once the command has run. */
  after: string | null
}

const NUMBER = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })

function percent(value: unknown): string | null {
  return typeof value === 'number' ? `${NUMBER.format(value)} %` : null
}

function celsius(value: unknown): string | null {
  return typeof value === 'number' ? `${NUMBER.format(value)} °C` : null
}

function onOff(value: unknown): string | null {
  return typeof value === 'boolean' ? (value ? 'allumé' : 'éteint') : null
}

function locked(value: unknown): string | null {
  return typeof value === 'boolean' ? (value ? 'verrouillé' : 'déverrouillé') : null
}

function kelvin(value: unknown): string | null {
  return typeof value === 'number' ? `${NUMBER.format(value)} K` : null
}

/** One entry per command the review table knows how to word. */
const COMMANDS: Record<string, { label: string; read: (state: Record<string, unknown>) => string | null; after: (args: Record<string, unknown>, state: Record<string, unknown> | null) => string | null }> = {
  turnOn: { label: 'Allumer', read: (state) => onOff(state.on), after: () => 'allumé' },
  turnOff: { label: 'Éteindre', read: (state) => onOff(state.on), after: () => 'éteint' },
  toggle: {
    label: 'Basculer',
    read: (state) => onOff(state.on),
    after: (_args, state) => (state && typeof state.on === 'boolean' ? onOff(!state.on) : 'basculé'),
  },
  setBrightness: { label: 'Régler la luminosité', read: (state) => percent(state.brightness), after: (args) => percent(args.brightness) },
  setColorTemperature: { label: 'Régler la teinte', read: (state) => kelvin(state.colorTemperature), after: (args) => kelvin(args.colorTemperature ?? args.kelvin) },
  setTargetTemperature: { label: 'Régler la consigne', read: (state) => celsius(state.targetTemperature), after: (args) => celsius(args.celsius ?? args.temperature ?? args.targetTemperature) },
  lock: { label: 'Verrouiller', read: (state) => locked(state.locked), after: () => 'verrouillé' },
  unlock: { label: 'Déverrouiller', read: (state) => locked(state.locked), after: () => 'déverrouillé' },
  setPosition: { label: 'Régler la position', read: (state) => percent(state.position), after: (args) => percent(args.position) },
  open: { label: 'Ouvrir', read: (state) => percent(state.position), after: () => 'ouvert' },
  close: { label: 'Fermer', read: (state) => percent(state.position), after: () => 'fermé' },
  setVolume: { label: 'Régler le volume', read: (state) => percent(state.volume), after: (args) => percent(args.volume) },
  play: { label: 'Lancer la lecture', read: (state) => (typeof state.playback === 'string' ? String(state.playback) : null), after: () => 'lecture' },
  pause: { label: 'Mettre en pause', read: (state) => (typeof state.playback === 'string' ? String(state.playback) : null), after: () => 'pause' },
}

function areaOf(device: Device | null): string | null {
  if (!device?.areaId) return null
  return places.areas().find((area) => area.id === device.areaId)?.name ?? null
}

export function describeProposal(proposal: Proposal): ProposalChange[] {
  return proposal.commands.map((command, index) => {
    const device = deviceRepository.find(command.deviceId)
    const known = COMMANDS[command.command]
    const state = device?.state ?? null
    return {
      index,
      deviceId: command.deviceId,
      deviceName: device?.name ?? command.deviceName,
      area: areaOf(device),
      command: command.command,
      label: known?.label ?? command.command,
      before: known && state ? known.read(state) : null,
      after: known ? known.after(command.args, state) : null,
    }
  })
}
