/**
 * The Freebox OS API: what the box says about itself, how an app is let in, and the answers
 * the hub reads. No I/O.
 *
 * The box describes itself at /api_version (and in its `_fbx-api._tcp` mDNS record): the
 * HTTPS domain and port its API answers on, and the API version. An app asks once for a
 * token, which a human validates on the box's screen; after that it opens sessions with
 * HMAC-SHA1(app_token, challenge) and sends the session token in X-Fbx-App-Auth. A session
 * that expired answers 403 `auth_required` with a fresh challenge.
 *
 * Every answer is `{ success: true, result }` or `{ success: false, error_code, msg }`.
 *
 * Sources: Freebox OS SDK (login, lan, connection, system); freebox-api (hacf-fr) and Home
 * Assistant's freebox integration, whose fixtures are real answers.
 */

import { createHmac } from 'node:crypto'

export interface FreeboxInfo {
  uid: string
  apiDomain: string
  httpsPort: number
  /** False when remote HTTPS access is switched off in Freebox OS: the hub will not talk in clear. */
  httpsAvailable: boolean
  apiBaseUrl: string
  apiMajor: number
  model: string | null
  name: string | null
}

const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

/** From /api_version (JSON) or the mDNS TXT record (all text). */
export function parseApiVersion(value: unknown): FreeboxInfo | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const text = (key: string) => {
    const item = raw[key]
    return typeof item === 'string' ? item.trim() : typeof item === 'number' || typeof item === 'boolean' ? String(item) : ''
  }
  const apiDomain = text('api_domain')
  const httpsPort = Number(text('https_port'))
  const version = /^(\d+)(?:\.\d+)*$/.exec(text('api_version'))
  if (!HOST_NAME.test(apiDomain) || !Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535 || !version) return null
  const base = text('api_base_url')
  const https = text('https_available').toLowerCase()
  return {
    uid: text('uid') || apiDomain,
    apiDomain,
    httpsPort,
    httpsAvailable: https === 'true' || https === '1',
    apiBaseUrl: /^\/[\w/-]*\/$/.test(base) && !base.startsWith('//') ? base : '/api/',
    apiMajor: Number(version[1]),
    model: text('box_model') || null,
    name: text('box_model_name') || text('device_name') || null,
  }
}

export function apiBase(info: FreeboxInfo): string {
  return `https://${info.apiDomain}:${info.httpsPort}${info.apiBaseUrl}v${info.apiMajor}/`
}

export function sessionPassword(appToken: string, challenge: string): string {
  return createHmac('sha1', appToken).update(challenge).digest('hex')
}

export type Answer<T = unknown> = { ok: true; result: T } | { ok: false; code: string; message: string; challenge: string | null }

export function unwrap(json: unknown): Answer {
  if (!json || typeof json !== 'object') return { ok: false, code: 'invalid_answer', message: 'réponse illisible de la Freebox', challenge: null }
  const raw = json as Record<string, unknown>
  if (raw.success === true) return { ok: true, result: raw.result ?? null }
  const result = raw.result && typeof raw.result === 'object' ? (raw.result as Record<string, unknown>) : null
  return {
    ok: false,
    code: typeof raw.error_code === 'string' ? raw.error_code : 'unknown',
    message: typeof raw.msg === 'string' ? raw.msg : 'erreur de la Freebox',
    challenge: typeof result?.challenge === 'string' ? result.challenge : null,
  }
}

export type AuthorizationStatus = 'unknown' | 'pending' | 'timeout' | 'granted' | 'denied'
const STATUSES = new Set<AuthorizationStatus>(['unknown', 'pending', 'timeout', 'granted', 'denied'])

export function authorizationStatus(json: unknown): AuthorizationStatus | null {
  const answer = unwrap(json)
  if (!answer.ok) return null
  const status = (answer.result as { status?: unknown } | null)?.status
  return typeof status === 'string' && STATUSES.has(status as AuthorizationStatus) ? (status as AuthorizationStatus) : null
}

// ---------------------------------------------------------------------------------------
// What the box knows
// ---------------------------------------------------------------------------------------

const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const string = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

export interface Connection {
  internet: 'up' | 'down' | 'going_up' | 'going_down' | 'unknown'
  media: string | null
  ipv4: string | null
  ipv6: string | null
  /** Bytes per second, right now. */
  rateDown: number | null
  rateUp: number | null
  /** Bits per second, what the line can carry. */
  bandwidthDown: number | null
  bandwidthUp: number | null
}

export function parseConnection(result: unknown): Connection {
  const raw = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  const state = raw.state
  return {
    internet: state === 'up' || state === 'down' || state === 'going_up' || state === 'going_down' ? state : 'unknown',
    media: string(raw.media),
    ipv4: string(raw.ipv4),
    ipv6: string(raw.ipv6),
    rateDown: number(raw.rate_down),
    rateUp: number(raw.rate_up),
    bandwidthDown: number(raw.bandwidth_down),
    bandwidthUp: number(raw.bandwidth_up),
  }
}

export interface FreeboxSystem {
  name: string | null
  model: string | null
  mac: string | null
  serial: string | null
  firmware: string | null
}

export function parseSystem(result: unknown): FreeboxSystem {
  const raw = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  const model = (raw.model_info && typeof raw.model_info === 'object' ? raw.model_info : {}) as Record<string, unknown>
  return {
    name: string(model.pretty_name),
    model: string(model.name),
    mac: string(raw.mac)?.toLowerCase() ?? null,
    serial: string(raw.serial),
    firmware: string(raw.firmware_version),
  }
}

export interface LanHost {
  mac: string
  name: string
  /** Freebox's guess: smartphone, tablet, workstation, freebox_player... */
  type: string
  vendor: string | null
  active: boolean
  /** Milliseconds; the last time the box could reach it. */
  lastSeen: number | null
  ipv4: string | null
  /** On the guest Wi-Fi rather than the house network. */
  guest: boolean
}

export function parseHosts(result: unknown): LanHost[] {
  if (!Array.isArray(result)) return []
  return result.flatMap((item): LanHost[] => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    const l2 = (raw.l2ident && typeof raw.l2ident === 'object' ? raw.l2ident : {}) as Record<string, unknown>
    const mac = string(l2.id)?.toLowerCase()
    if (!mac || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return []
    const names = Array.isArray(raw.names) ? raw.names : []
    const firstName = names.map((entry) => string((entry as { name?: unknown } | null)?.name)).find((name) => name !== null) ?? null
    const seen = [number(raw.last_time_reachable), number(raw.last_activity)].filter((value): value is number => value !== null)
    const addresses = (Array.isArray(raw.l3connectivities) ? raw.l3connectivities : []).filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && (entry as Record<string, unknown>).af === 'ipv4'
    )
    const address = addresses.find((entry) => entry.active === true) ?? addresses[0]
    return [
      {
        mac,
        name: string(raw.primary_name) ?? string(raw.default_name) ?? firstName ?? mac,
        type: string(raw.host_type) ?? 'other',
        vendor: string(raw.vendor_name),
        active: raw.active === true,
        lastSeen: seen.length > 0 ? Math.max(...seen) * 1000 : null,
        ipv4: address ? string(address.addr) : null,
        guest: string(raw.interface) !== null && raw.interface !== 'pub',
      },
    ]
  })
}

const PERSONAL = new Set(['smartphone', 'tablet', 'watch'])

/** A device that says someone is home: a phone or a tablet, not Free's own boxes calling themselves phones. */
export function isPersonal(host: LanHost): boolean {
  return PERSONAL.has(host.type) && !/^freebox/i.test(host.vendor ?? '')
}

/**
 * Home while on the network, and for a while after: phones put their Wi-Fi to sleep, and a
 * phone gone quiet for five minutes has rarely left. `confidence` says which case it is.
 */
export function presenceOf(host: LanHost, now: number, awayAfterMs: number): { home: boolean; confidence: number; source: 'network'; lastSeenAt: string | null } {
  const lastSeenAt = host.lastSeen !== null ? new Date(host.lastSeen).toISOString() : null
  if (host.active) return { home: true, confidence: 1, source: 'network', lastSeenAt }
  if (host.lastSeen !== null && now - host.lastSeen < awayAfterMs) return { home: true, confidence: 0.6, source: 'network', lastSeenAt }
  return { home: false, confidence: 1, source: 'network', lastSeenAt }
}
