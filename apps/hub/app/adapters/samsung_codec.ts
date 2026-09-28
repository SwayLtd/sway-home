/**
 * Samsung Tizen TVs: messages and translation, no I/O.
 *
 * Three doors on the same TV, each for what it does best:
 *  - the remote channel (`samsung.remote.control`, WebSocket on 8002 with TLS, 8001 in clear
 *    on older firmware): remote keys and app launches, after a one-time "Autoriser ?" on
 *    screen that yields a token;
 *  - `GET :8001/api/v2/`: who the TV is, its Wi-Fi MAC and, from 2018 on, `PowerState`;
 *  - the UPnP renderer on 9197 (RenderingControl): the volume level and mute, read and set
 *    exactly, while the TV is on. Without it, the volume only moves one key press at a time.
 *
 * Sources: samsungtvws 2.x, Home Assistant's samsungtv bridge, ioBroker.samsung_tizen#298.
 */

import { firstText } from '#adapters/soap_xml'

export const SAMSUNG_PORTS = { ws: 8001, wss: 8002, renderer: 9197 } as const
export const REMOTE_CHANNEL = 'samsung.remote.control'
export const RENDERING_CONTROL = 'urn:schemas-upnp-org:service:RenderingControl:1'
export const RENDERER_PATH = '/upnp/control/RenderingControl1'
export const BROWSER_APP = 'org.tizen.browser'

// ---------------------------------------------------------------------------------------
// Reaching the TV
// ---------------------------------------------------------------------------------------

export function remoteUrl(target: { ip: string; secure: boolean; port: number; name: string; token: string | null }): string {
  const query = new URLSearchParams({ name: Buffer.from(target.name, 'utf8').toString('base64') })
  if (target.token) query.set('token', target.token)
  return `${target.secure ? 'wss' : 'ws'}://${target.ip}:${target.port}/api/v2/channels/${REMOTE_CHANNEL}?${query}`
}

export interface SamsungInfo {
  name: string
  model: string | null
  mac: string | null
  /** null on 2016 and 2017 models, which do not report it: reachable then means on. */
  power: 'on' | 'standby' | null
  tokenAuth: boolean
  frame: boolean
}

function normaliseMac(value: unknown): string | null {
  const hex = String(value ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  return hex.length === 12 ? hex.match(/.{2}/g)!.join(':') : null
}

const yes = (value: unknown) => value === true || String(value).toLowerCase() === 'true'

export function parseDeviceInfo(body: unknown): SamsungInfo | null {
  let value = body
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const root = value as Record<string, unknown>
  const device = root.device
  if (!device || typeof device !== 'object') return null
  const info = device as Record<string, unknown>
  if (!/smart\s*tv/i.test(String(info.type ?? root.type ?? ''))) return null

  const state = typeof info.PowerState === 'string' ? info.PowerState.toLowerCase() : null
  const name = String(info.name ?? root.name ?? '')
    .replace(/^\[TV\]\s*/i, '')
    .trim()
  const model = info.modelName ?? info.model
  return {
    name: name.length > 0 ? name : 'Téléviseur Samsung',
    model: typeof model === 'string' && model.length > 0 ? model : null,
    mac: normaliseMac(info.wifiMac),
    power: state === null ? null : /^(on|normal)$/.test(state) ? 'on' : 'standby',
    tokenAuth: yes(info.TokenAuthSupport),
    frame: yes(info.FrameTVSupport),
  }
}

export interface SamsungEvent {
  event: string
  data?: unknown
}

export function parseEvent(raw: unknown): SamsungEvent | null {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    return value && typeof value === 'object' && typeof (value as SamsungEvent).event === 'string' ? (value as SamsungEvent) : null
  } catch {
    return null
  }
}

export type ConnectOutcome = { kind: 'connected'; token: string | null } | { kind: 'unauthorized' } | { kind: 'timeout' } | { kind: 'error'; message: string }

/** What an event means for the connection; null for everything else the channel says. */
export function connectOutcome(message: SamsungEvent): ConnectOutcome | null {
  const data = (message.data ?? {}) as Record<string, unknown>
  switch (message.event) {
    case 'ms.channel.connect': {
      const token = data.token
      return { kind: 'connected', token: typeof token === 'string' || typeof token === 'number' ? String(token) : null }
    }
    case 'ms.channel.unauthorized':
      return { kind: 'unauthorized' }
    case 'ms.channel.timeOut':
      return { kind: 'timeout' }
    case 'ms.error':
      return { kind: 'error', message: typeof data.message === 'string' ? data.message : 'erreur' }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------
// Keys and apps
// ---------------------------------------------------------------------------------------

export interface KeyMessage {
  method: 'ms.remote.control'
  params: { Cmd: 'Click' | 'Press' | 'Release'; DataOfCmd: string; Option: 'false'; TypeOfRemote: 'SendRemoteKey' }
}

const key = (Cmd: KeyMessage['params']['Cmd'], name: string): KeyMessage => ({
  method: 'ms.remote.control',
  params: { Cmd, DataOfCmd: name, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
})

/** A click; a key held for `holdSeconds` is a press, a pause, then a release. */
export function keyMessages(name: string, holdSeconds?: number): (KeyMessage | { pauseMs: number })[] {
  if (!holdSeconds) return [key('Click', name)]
  return [key('Press', name), { pauseMs: holdSeconds * 1000 }, key('Release', name)]
}

export interface SamsungApp {
  appId: string
  name: string
  /** 2: web app, launched by deep link; 4: native. */
  appType: number
}

export function launchMessage(app: { appId: string; appType: number }, metaTag = '') {
  return {
    method: 'ms.channel.emit' as const,
    params: {
      event: 'ed.apps.launch',
      to: 'host',
      data: { appId: app.appId, action_type: app.appType === 4 ? 'NATIVE_LAUNCH' : 'DEEP_LINK', metaTag },
    },
  }
}

export const APPS_REQUEST = { method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } } as const

export function appsFrom(message: SamsungEvent): SamsungApp[] {
  if (message.event !== 'ed.installedApp.get') return []
  const list = ((message.data ?? {}) as { data?: unknown }).data
  if (!Array.isArray(list)) return []
  return list.flatMap((entry) => {
    const app = entry as Record<string, unknown>
    if (typeof app.appId !== 'string' || typeof app.name !== 'string') return []
    return [{ appId: app.appId, name: app.name, appType: Number(app.app_type ?? 2) }]
  })
}

export type SamsungSource = { id: string; label: string; kind: 'key' } | { id: string; label: string; kind: 'app'; appType: number }

export function sourcesFrom(apps: SamsungApp[]): SamsungSource[] {
  const seen = new Set<string>()
  const list: SamsungSource[] = [
    { id: 'KEY_TV', label: 'TV', kind: 'key' },
    { id: 'KEY_HDMI', label: 'HDMI', kind: 'key' },
  ]
  for (const app of apps) {
    if (seen.has(app.name)) continue
    seen.add(app.name)
    list.push({ id: app.appId, label: app.name, kind: 'app', appType: app.appType })
  }
  return list
}

const squash = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

/** Words for the tuner: "mets la télé" means the TV input, not an app. */
const TUNER_WORDS = new Set(['tele', 'television', 'tnt', 'antenne', 'chaines', 'chaine', 'direct', 'tv'])

export function findSource(sources: SamsungSource[], wanted: string): SamsungSource | null {
  const words = wanted
    .toLowerCase()
    .replace(/^(la|le|les|l'|sur|mets|passe)\s+/g, '')
    .trim()
  const target = squash(words)
  if (target.length === 0) return null
  if (TUNER_WORDS.has(target)) return sources.find((source) => source.id === 'KEY_TV') ?? null
  const exact = sources.find((source) => squash(source.label) === target || squash(source.id) === target)
  if (exact) return exact
  return (
    sources.find((source) => {
      const label = squash(source.label)
      return label.length > 2 && (target.includes(label) || label.includes(target))
    }) ?? null
  )
}

/** The level in a GetVolume answer from the renderer. */
export function volumeFrom(xml: string): number | null {
  const value = Number.parseInt(firstText(xml, 'CurrentVolume') ?? '', 10)
  return Number.isFinite(value) ? value : null
}

export function muteFrom(xml: string): boolean | null {
  const value = firstText(xml, 'CurrentMute')
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return null
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

export interface SamsungView {
  on: boolean
  volume: number | null
  muted: boolean | null
  /** Whether the UPnP renderer answers: exact volume and mute. */
  renderer: boolean
  frame: boolean
  sources: SamsungSource[]
}

export type SamsungStep =
  | { kind: 'key'; key: string; holdSeconds?: number }
  | { kind: 'wake' }
  | { kind: 'launch'; appId: string; appType: number; metaTag?: string }
  | { kind: 'renderer'; action: 'SetVolume' | 'SetMute'; args: Record<string, string | number> }

export type SamsungPlan = { steps: SamsungStep[]; expect?: Record<string, unknown> } | { error: string }

const clamp = (value: number) => Math.round(Math.min(100, Math.max(0, value)))
const press = (name: string): SamsungStep => ({ kind: 'key', key: name })
const setVolume = (volume: number): SamsungStep => ({ kind: 'renderer', action: 'SetVolume', args: { InstanceID: 0, Channel: 'Master', DesiredVolume: volume } })

export function commandPlan(command: string, args: Record<string, unknown>, tv: SamsungView): SamsungPlan {
  if (command === 'toggle') return commandPlan(tv.on ? 'turnOff' : 'turnOn', args, tv)
  if (command === 'turnOff') {
    if (!tv.on) return { steps: [], expect: { on: false } }
    // On a Frame TV a click only switches to art mode; held, the key really turns it off.
    return { steps: [tv.frame ? { kind: 'key', key: 'KEY_POWER', holdSeconds: 3 } : press('KEY_POWER')], expect: { on: false } }
  }
  if (command === 'turnOn') return { steps: tv.on ? [] : [{ kind: 'wake' }], expect: { on: true } }
  if (!tv.on) return { error: 'Le téléviseur est éteint.' }

  switch (command) {
    case 'setVolume': {
      if (!tv.renderer) return { error: 'Ce téléviseur ne donne pas son niveau de volume : dites plutôt "monte le son" ou "baisse le son".' }
      const volume = clamp(Number(args.volume))
      return { steps: [setVolume(volume)], expect: { volume } }
    }
    case 'stepVolume': {
      const delta = Math.round(Number(args.delta ?? 0))
      if (tv.renderer && tv.volume !== null) {
        const volume = clamp(tv.volume + delta)
        return { steps: [setVolume(volume)], expect: { volume } }
      }
      const steps = Math.min(10, Math.abs(delta))
      return { steps: Array.from({ length: steps }, () => press(delta >= 0 ? 'KEY_VOLUP' : 'KEY_VOLDOWN')) }
    }
    case 'setMuted': {
      const muted = args.muted === true
      if (tv.renderer) return { steps: [{ kind: 'renderer', action: 'SetMute', args: { InstanceID: 0, Channel: 'Master', DesiredMute: muted ? 1 : 0 } }], expect: { muted } }
      // The mute key toggles: pressed only when the TV is not already where it should be.
      return { steps: tv.muted === muted ? [] : [press('KEY_MUTE')], expect: { muted } }
    }
    case 'play':
      return { steps: [press('KEY_PLAY')] }
    case 'pause':
      return { steps: [press('KEY_PAUSE')] }
    case 'stopPlayback':
      return { steps: [press('KEY_STOP')] }
    case 'next':
      return { steps: [press('KEY_CHUP')] }
    case 'previous':
      return { steps: [press('KEY_CHDOWN')] }
    case 'setSource': {
      const wanted = String(args.source ?? '')
      const source = findSource(tv.sources, wanted)
      if (!source) return { error: `Aucune source "${wanted}" sur ce téléviseur.` }
      return source.kind === 'key'
        ? { steps: [press(source.id)], expect: { source: source.label } }
        : { steps: [{ kind: 'launch', appId: source.id, appType: source.appType }], expect: { source: source.label } }
    }
    case 'playMedia': {
      const query = String(args.query ?? '')
      if (!/^https?:\/\//i.test(query)) return { error: 'Le téléviseur ouvre une adresse web, pas une recherche.' }
      return { steps: [{ kind: 'launch', appId: BROWSER_APP, appType: 4, metaTag: query }] }
    }
    default:
      return { error: `Un téléviseur Samsung ne sait pas faire "${command}".` }
  }
}
