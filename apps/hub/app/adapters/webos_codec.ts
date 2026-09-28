/**
 * LG webOS over SSAP, translated.
 *
 * A webOS TV speaks JSON over a WebSocket: port 3000 in the clear, 3001 with a self-signed
 * certificate on firmware that refuses the first. The conversation:
 *
 *   client register {manifest, client-key?} -> TV `registered` {client-key}
 *                                            or `response` {pairingType: PROMPT}, a prompt on
 *                                               screen, then `registered` or an `error`
 *   client {id, type: request | subscribe, uri: 'ssap://...', payload}
 *   TV     {id, type: response | error, payload}  (a subscription answers again on change)
 *
 * The manifest is unsigned: since webOS 26 the historical signed manifest is refused with
 * "403 Pairing rejected: blacklisted certificate detected", and putting every permission in
 * the outer list pairs on every firmware (aiowebostv 0.9.2, PR #719). The one permission that
 * then needs a new pairing, READ_UPDATE_INFO, only serves the firmware version, which is
 * therefore read as optional.
 *
 * Sources: aiowebostv (handshake.py, endpoints.py, webos_client.py), Home Assistant's webostv
 * media player, home-assistant/core#179669.
 */

export const WEBOS_PORTS = { ws: 3000, wss: 3001 } as const
export const LIVE_TV_APP = 'com.webos.app.livetv'

export const WEBOS_PERMISSIONS = [
  'APP_TO_APP',
  'CLOSE',
  'CONTROL_AUDIO',
  'CONTROL_DISPLAY',
  'CONTROL_INPUT_JOYSTICK',
  'CONTROL_INPUT_MEDIA_PLAYBACK',
  'CONTROL_INPUT_MEDIA_RECORDING',
  'CONTROL_INPUT_TEXT',
  'CONTROL_INPUT_TV',
  'CONTROL_MOUSE_AND_KEYBOARD',
  'CONTROL_POWER',
  'CONTROL_TV_SCREEN',
  'LAUNCH',
  'LAUNCH_WEBAPP',
  'READ_APP_STATUS',
  'READ_COUNTRY_INFO',
  'READ_CURRENT_CHANNEL',
  'READ_INPUT_DEVICE_LIST',
  'READ_INSTALLED_APPS',
  'READ_LGE_SDX',
  'READ_LGE_TV_INPUT_EVENTS',
  'READ_NETWORK_STATE',
  'READ_NOTIFICATIONS',
  'READ_POWER_STATE',
  'READ_RUNNING_APPS',
  'READ_SETTINGS',
  'READ_TV_CHANNEL_LIST',
  'READ_TV_CURRENT_TIME',
  'READ_UPDATE_INFO',
  'SEARCH',
  'TEST_OPEN',
  'TEST_PROTECTED',
  'TEST_SECURE',
  'UPDATE_FROM_REMOTE_APP',
  'WRITE_NOTIFICATION_ALERT',
  'WRITE_NOTIFICATION_TOAST',
  'WRITE_SETTINGS',
] as const

/** The services the adapter uses, as the TV names them. */
export const URI = {
  systemInfo: 'system/getSystemInfo',
  softwareInfo: 'com.webos.service.update/getCurrentSWInformation',
  powerState: 'com.webos.service.tvpower/power/getPowerState',
  turnOff: 'system/turnOff',
  turnOn: 'system/turnOn',
  screenOn: 'com.webos.service.tvpower/power/turnOnScreen',
  volume: 'audio/getVolume',
  audioStatus: 'audio/getStatus',
  foregroundApp: 'com.webos.applicationManager/getForegroundAppInfo',
  mediaForeground: 'com.webos.media/getForegroundAppInfo',
  inputs: 'tv/getExternalInputList',
  apps: 'com.webos.applicationManager/listLaunchPoints',
} as const

export interface RegisterMessage {
  type: 'register'
  id: 'register_0'
  payload: {
    forcePairing: false
    pairingType: 'PROMPT'
    manifest: { manifestVersion: 1; appVersion: string; permissions: string[] }
    'client-key'?: string
  }
}

export function registerMessage(clientKey: string | null): RegisterMessage {
  return {
    type: 'register',
    id: 'register_0',
    payload: {
      forcePairing: false,
      pairingType: 'PROMPT',
      manifest: { manifestVersion: 1, appVersion: '1.1', permissions: [...WEBOS_PERMISSIONS] },
      ...(clientKey ? { 'client-key': clientKey } : {}),
    },
  }
}

export function requestMessage(id: string, uri: string, payload: Record<string, unknown> = {}, type: 'request' | 'subscribe' = 'request') {
  return { id, type, uri: `ssap://${uri}`, payload }
}

export interface WebosMessage {
  type?: string
  id?: string | number
  error?: string
  payload?: Record<string, unknown>
}

export function parseMessage(data: unknown): WebosMessage | null {
  try {
    const parsed = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer))
    return parsed && typeof parsed === 'object' ? (parsed as WebosMessage) : null
  } catch {
    return null
  }
}

/** Why an answer failed, or null when it did not. */
export function failureOf(message: WebosMessage): string | null {
  if (message.type === 'error') return message.error || 'erreur'
  const payload = message.payload ?? {}
  if (payload.returnValue === false) {
    if (typeof payload.errorText === 'string' && payload.errorText.length > 0) return payload.errorText
    return payload.errorCode === undefined ? 'erreur' : `erreur ${String(payload.errorCode)}`
  }
  return null
}

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

const OFF_STATES = new Set(['Power Off', 'Suspend', 'Active Standby'])

/**
 * "Screen Off" is on: the TV plays sound with its panel dark. Older TVs have no power
 * service at all; for them an app in front is the only sign of life.
 */
export function isOn(power: string | null | undefined, appId: string | null | undefined): boolean {
  if (power === null || power === undefined) return typeof appId === 'string' && appId.length > 0
  return !OFF_STATES.has(power)
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

/** `audio/getVolume` on webOS 5+ nests it in volumeStatus; older firmware and getStatus do not. */
export function volumeFrom(payload: Record<string, unknown>): { volume?: number; muted?: boolean } {
  const status = (payload.volumeStatus && typeof payload.volumeStatus === 'object' ? payload.volumeStatus : {}) as Record<string, unknown>
  const volume = num(status.volume) ?? num(payload.volume)
  const muted = bool(status.muteStatus) ?? bool(payload.muted) ?? bool(payload.mute)
  return { ...(volume === undefined ? {} : { volume }), ...(muted === undefined ? {} : { muted }) }
}

export function playbackFrom(payload: Record<string, unknown>): 'playing' | 'paused' | 'idle' | null {
  const entries = Array.isArray(payload.foregroundAppInfo) ? (payload.foregroundAppInfo as Record<string, unknown>[]) : []
  const states = entries.map((entry) => entry.playState)
  if (states.includes('playing')) return 'playing'
  if (states.includes('paused')) return 'paused'
  if (states.includes('unloaded')) return 'idle'
  return null
}

// ---------------------------------------------------------------------------------------
// Sources: the inputs and the apps
// ---------------------------------------------------------------------------------------

export interface WebosSource {
  /** What the switch command takes: the input id, or the app id. */
  id: string
  label: string
  kind: 'input' | 'app'
  /** The app in front when this source is on screen. */
  appId: string
}

function list(payload: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[]
  const inner = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : null
  return Array.isArray(inner) ? (inner as Record<string, unknown>[]) : []
}

export function sourcesFrom(inputs: unknown, apps: unknown): WebosSource[] {
  const out: WebosSource[] = []
  for (const input of list(inputs, 'devices')) {
    if (typeof input.id !== 'string') continue
    const appId = typeof input.appId === 'string' ? input.appId : input.id
    out.push({ id: input.id, label: typeof input.label === 'string' ? input.label : input.id, kind: 'input', appId })
  }
  const inputApps = new Set(out.map((source) => source.appId))
  for (const app of list(apps, 'launchPoints')) {
    if (typeof app.id !== 'string' || inputApps.has(app.id)) continue
    out.push({ id: app.id, label: typeof app.title === 'string' ? app.title : app.id, kind: 'app', appId: app.id })
  }
  // Live TV does not always appear in either list, and it is the source people ask for most.
  if (!out.some((source) => source.appId === LIVE_TV_APP)) out.push({ id: LIVE_TV_APP, label: 'TV en direct', kind: 'app', appId: LIVE_TV_APP })
  return out
}

export function currentSource(sources: WebosSource[], appId: string | null | undefined): string | null {
  if (!appId) return null
  return sources.find((source) => source.kind === 'input' && source.appId === appId)?.label ?? sources.find((source) => source.appId === appId)?.label ?? null
}

const squash = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

export function findSource(sources: WebosSource[], wanted: string): WebosSource | null {
  const target = squash(wanted)
  if (target.length === 0) return null
  const exact = sources.find((source) => squash(source.label) === target || squash(source.id) === target)
  if (exact) return exact
  return sources.find((source) => {
    const label = squash(source.label)
    return label.length > 1 && (target.includes(label) || label.includes(target))
  }) ?? null
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

export type WebosAction = { kind: 'request'; uri: string; payload?: Record<string, unknown> } | { kind: 'wake' }

export interface TvView {
  on: boolean
  screenOn: boolean
  appId: string | null
  volume: number | null
  sources: WebosSource[]
}

export type WebosPlan = { actions: WebosAction[]; expect?: Record<string, unknown> } | { error: string }

const request = (uri: string, payload?: Record<string, unknown>): WebosAction => ({ kind: 'request', uri, ...(payload ? { payload } : {}) })
const clamp = (value: number) => Math.round(Math.min(100, Math.max(0, value)))

export function commandActions(command: string, args: Record<string, unknown>, tv: TvView): WebosPlan {
  if (command === 'toggle') return commandActions(tv.on ? 'turnOff' : 'turnOn', args, tv)
  if (command === 'turnOff') return { actions: tv.on ? [request('system/turnOff')] : [], expect: { on: false } }
  if (command === 'turnOn') {
    if (!tv.on) return { actions: [{ kind: 'wake' }], expect: { on: true } }
    return { actions: tv.screenOn ? [] : [request(URI.screenOn)], expect: { on: true } }
  }
  if (!tv.on) return { error: 'Le téléviseur est éteint.' }

  switch (command) {
    case 'setVolume': {
      const volume = clamp(Number(args.volume))
      return { actions: [request('audio/setVolume', { volume })], expect: { volume } }
    }
    case 'stepVolume': {
      const delta = Math.round(Number(args.delta ?? 0))
      if (tv.volume !== null) {
        const volume = clamp(tv.volume + delta)
        return { actions: [request('audio/setVolume', { volume })], expect: { volume } }
      }
      // Without a level to start from, one press per step, as a remote would.
      const steps = Math.min(10, Math.abs(delta))
      return { actions: Array.from({ length: steps }, () => request(delta >= 0 ? 'audio/volumeUp' : 'audio/volumeDown')) }
    }
    case 'setMuted':
      return { actions: [request('audio/setMute', { mute: args.muted === true })], expect: { muted: args.muted === true } }
    case 'play':
      return { actions: [request('media.controls/play')], expect: { playback: 'playing' } }
    case 'pause':
      return { actions: [request('media.controls/pause')], expect: { playback: 'paused' } }
    case 'stopPlayback':
      return { actions: [request('media.controls/stop')], expect: { playback: 'stopped' } }
    case 'next':
      return { actions: [request(tv.appId === LIVE_TV_APP ? 'tv/channelUp' : 'media.controls/fastForward')] }
    case 'previous':
      return { actions: [request(tv.appId === LIVE_TV_APP ? 'tv/channelDown' : 'media.controls/rewind')] }
    case 'setSource': {
      const wanted = String(args.source ?? '')
      const source = findSource(tv.sources, wanted)
      if (!source) return { error: `Aucune source "${wanted}" sur ce téléviseur.` }
      return source.kind === 'input'
        ? { actions: [request('tv/switchInput', { inputId: source.id })], expect: { source: source.label } }
        : { actions: [request('com.webos.applicationManager/launch', { id: source.id })], expect: { source: source.label } }
    }
    case 'notify': {
      const message = String(args.message ?? '')
      const title = typeof args.title === 'string' && args.title.length > 0 ? args.title : null
      return { actions: [request('system.notifications/createToast', { message: title ? `${title} : ${message}` : message })] }
    }
    case 'playMedia': {
      const query = String(args.query ?? '')
      if (!/^https?:\/\//i.test(query)) return { error: 'Le téléviseur ouvre une adresse web, pas une recherche.' }
      return { actions: [request('system.launcher/open', { target: query })] }
    }
    case 'seek':
      return { error: 'Le téléviseur ne sait pas se placer à un moment précis.' }
    default:
      return { error: `Un téléviseur LG ne sait pas faire "${command}".` }
  }
}
