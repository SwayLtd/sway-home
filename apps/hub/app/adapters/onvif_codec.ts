/**
 * ONVIF cameras: what goes on the wire and what comes back. No I/O.
 *
 * A camera answers a WS-Discovery probe (UDP multicast 239.255.255.250:3702) with the address
 * of its device service. Everything after that is SOAP 1.2 over HTTP, authenticated with a
 * WS-Security UsernameToken: the password travels as Base64(SHA-1(nonce + created + password)),
 * "created" being read on the camera's clock, which is why GetSystemDateAndTime (the one call
 * that needs no token) comes first. Snapshots are plain HTTP, usually behind HTTP Digest.
 *
 * Events are pulled: CreatePullPointSubscription gives an address, PullMessages long-polls it.
 * Each message names a topic (tns1:RuleEngine/CellMotionDetector/Motion, Reolink's
 * RuleEngine/MyRuleDetector/Visitor for the doorbell button...) and carries simple items, the
 * first boolean one saying whether it started or stopped.
 *
 * Sources: ONVIF Core Specification, Media and PTZ service specifications and the Application
 * Programmer's Guide; WS-Discovery 1.0; WS-Addressing 1.0 SOAP binding (reference parameters);
 * RFC 2617 and RFC 7616 (Digest); Home Assistant's onvif integration and onvif_parsers (event
 * topics per vendor, subscription timings, zeep's duration format).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { attributes, elements, encodeXml, firstText } from '#adapters/soap_xml'

export const WS_DISCOVERY = { address: '239.255.255.250', port: 3702 } as const

const NS = {
  soap: 'http://www.w3.org/2003/05/soap-envelope',
  addressing: 'http://www.w3.org/2005/08/addressing',
  device: 'http://www.onvif.org/ver10/device/wsdl',
  media: 'http://www.onvif.org/ver10/media/wsdl',
  ptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  events: 'http://www.onvif.org/ver10/events/wsdl',
  notification: 'http://docs.oasis-open.org/wsn/b-2',
  schema: 'http://www.onvif.org/ver10/schema',
  security: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  utility: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
} as const

// ---------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------

export function probeMessage(messageId: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    `<e:Header><w:MessageID>${encodeXml(messageId)}</w:MessageID>` +
    '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
    '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>' +
    '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>'
  )
}

export interface ProbeMatch {
  /** The endpoint reference, stable across address changes: "urn:uuid:...". */
  address: string
  /** Device service addresses, IPv4 and IPv6 alike. */
  xaddrs: string[]
  name: string | null
  hardware: string | null
}

function scope(scopes: string[], key: string): string | null {
  const prefix = `onvif://www.onvif.org/${key}/`
  const found = scopes.find((item) => item.toLowerCase().startsWith(prefix))
  if (!found) return null
  const raw = found.slice(prefix.length)
  try {
    return decodeURIComponent(raw) || null
  } catch {
    return raw || null
  }
}

export function parseProbeMatches(xml: string): ProbeMatch[] {
  return elements(xml, 'ProbeMatch').flatMap((match) => {
    const xaddrs = (firstText(match.inner, 'XAddrs') ?? '').split(/\s+/).filter((item) => /^https?:\/\//i.test(item))
    if (xaddrs.length === 0) return []
    const scopes = (firstText(match.inner, 'Scopes') ?? '').split(/\s+/).filter(Boolean)
    return [{ address: firstText(match.inner, 'Address') ?? xaddrs[0]!, xaddrs, name: scope(scopes, 'name'), hardware: scope(scopes, 'hardware') }]
  })
}

/**
 * Some cameras advertise service addresses on another host (a second interface, an address
 * they had before DHCP moved them). The camera we reached is the one to talk to: same port
 * and path, our host.
 */
export function rebaseXaddr(xaddr: string, deviceUrl: string): string {
  try {
    const service = new URL(xaddr)
    const device = new URL(deviceUrl)
    if (service.hostname === device.hostname) return xaddr
    service.hostname = device.hostname
    return service.toString()
  } catch {
    return xaddr
  }
}

// ---------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------

export function passwordDigest(nonce: Buffer, created: string, password: string): string {
  return createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
    .digest('base64')
}

export interface SoapOptions {
  username?: string | null
  password?: string | null
  /** The camera's clock, not ours: a token dated too far from it is refused. */
  now?: Date
  nonce?: Buffer
  /** WS-Addressing, for calls to a subscription. */
  to?: string
  action?: string
  messageId?: string
  /** Header blocks from `parseSubscription`, echoed on every call to that subscription. */
  referenceParameters?: string
}

export function soapRequest(body: string, options: SoapOptions): string {
  const headers: string[] = []
  if (options.to || options.action) {
    headers.push(`<wsa:MessageID>${encodeXml(options.messageId ?? `urn:uuid:${randomUUID()}`)}</wsa:MessageID>`)
    if (options.to) headers.push(`<wsa:To>${encodeXml(options.to)}</wsa:To>`)
    if (options.action) headers.push(`<wsa:Action>${encodeXml(options.action)}</wsa:Action>`)
  }
  if (options.referenceParameters) headers.push(options.referenceParameters)
  if (options.username) {
    const nonce = options.nonce ?? randomBytes(16)
    const created = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    headers.push(
      `<Security s:mustUnderstand="1" xmlns="${NS.security}"><UsernameToken>` +
        `<Username>${encodeXml(options.username)}</Username>` +
        `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${passwordDigest(nonce, created, options.password ?? '')}</Password>` +
        `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>` +
        `<Created xmlns="${NS.utility}">${created}</Created>` +
        '</UsernameToken></Security>'
    )
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<s:Envelope xmlns:s="${NS.soap}" xmlns:wsa="${NS.addressing}">` +
    (headers.length > 0 ? `<s:Header>${headers.join('')}</s:Header>` : '') +
    `<s:Body>${body}</s:Body></s:Envelope>`
  )
}

/** SOAP 1.2 carries the action in the content type; some cameras route on it. */
export function soapContentType(action?: string): string {
  return `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}`
}

/** xs:duration the way zeep writes it (what Home Assistant sends): 60 -> PT1M, 90 -> PT1M30S. */
function duration(seconds: number): string {
  const total = Math.max(1, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  return `PT${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}${rest ? `${rest}S` : ''}`
}

/** Three decimals are more than any camera resolves, and keep "0.1 + 0.2" out of the XML. */
function decimal(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}

const profileToken = (prefix: string, token: string) => `<${prefix}:ProfileToken>${encodeXml(token)}</${prefix}:ProfileToken>`

export interface Velocity {
  pan?: number
  tilt?: number
  zoom?: number
}

export const BODIES = {
  getSystemDateAndTime: `<tds:GetSystemDateAndTime xmlns:tds="${NS.device}"/>`,
  getDeviceInformation: `<tds:GetDeviceInformation xmlns:tds="${NS.device}"/>`,
  getCapabilities: `<tds:GetCapabilities xmlns:tds="${NS.device}"><tds:Category>All</tds:Category></tds:GetCapabilities>`,
  getProfiles: `<trt:GetProfiles xmlns:trt="${NS.media}"/>`,
  getStreamUri: (token: string) =>
    `<trt:GetStreamUri xmlns:trt="${NS.media}" xmlns:tt="${NS.schema}"><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>${profileToken('trt', token)}</trt:GetStreamUri>`,
  getSnapshotUri: (token: string) => `<trt:GetSnapshotUri xmlns:trt="${NS.media}">${profileToken('trt', token)}</trt:GetSnapshotUri>`,
  continuousMove: (token: string, velocity: Velocity) => {
    const panTilt = velocity.pan !== undefined || velocity.tilt !== undefined ? `<tt:PanTilt x="${decimal(velocity.pan ?? 0)}" y="${decimal(velocity.tilt ?? 0)}"/>` : ''
    const zoom = velocity.zoom !== undefined ? `<tt:Zoom x="${decimal(velocity.zoom)}"/>` : ''
    return `<tptz:ContinuousMove xmlns:tptz="${NS.ptz}" xmlns:tt="${NS.schema}">${profileToken('tptz', token)}<tptz:Velocity>${panTilt}${zoom}</tptz:Velocity></tptz:ContinuousMove>`
  },
  /** Zoom to a position of the generic 0..1 space. */
  absoluteZoom: (token: string, zoom: number) =>
    `<tptz:AbsoluteMove xmlns:tptz="${NS.ptz}" xmlns:tt="${NS.schema}">${profileToken('tptz', token)}<tptz:Position><tt:Zoom x="${decimal(zoom)}"/></tptz:Position></tptz:AbsoluteMove>`,
  stop: (token: string, what: { panTilt: boolean; zoom: boolean } = { panTilt: true, zoom: true }) =>
    `<tptz:Stop xmlns:tptz="${NS.ptz}">${profileToken('tptz', token)}<tptz:PanTilt>${what.panTilt}</tptz:PanTilt><tptz:Zoom>${what.zoom}</tptz:Zoom></tptz:Stop>`,
  createPullPointSubscription: (seconds: number) =>
    `<tev:CreatePullPointSubscription xmlns:tev="${NS.events}"><tev:InitialTerminationTime>${duration(seconds)}</tev:InitialTerminationTime></tev:CreatePullPointSubscription>`,
  pullMessages: (seconds: number, limit: number) =>
    `<tev:PullMessages xmlns:tev="${NS.events}"><tev:Timeout>${duration(seconds)}</tev:Timeout><tev:MessageLimit>${limit}</tev:MessageLimit></tev:PullMessages>`,
  renew: (seconds: number) => `<wsnt:Renew xmlns:wsnt="${NS.notification}"><wsnt:TerminationTime>${duration(seconds)}</wsnt:TerminationTime></wsnt:Renew>`,
  unsubscribe: `<wsnt:Unsubscribe xmlns:wsnt="${NS.notification}"/>`,
  getEventProperties: `<tev:GetEventProperties xmlns:tev="${NS.events}"/>`,
}

export const ACTIONS = {
  getSystemDateAndTime: `${NS.device}/GetSystemDateAndTime`,
  getDeviceInformation: `${NS.device}/GetDeviceInformation`,
  getCapabilities: `${NS.device}/GetCapabilities`,
  getProfiles: `${NS.media}/GetProfiles`,
  getStreamUri: `${NS.media}/GetStreamUri`,
  getSnapshotUri: `${NS.media}/GetSnapshotUri`,
  continuousMove: `${NS.ptz}/ContinuousMove`,
  absoluteMove: `${NS.ptz}/AbsoluteMove`,
  stop: `${NS.ptz}/Stop`,
  createPullPointSubscription: `${NS.events}/EventPortType/CreatePullPointSubscriptionRequest`,
  pullMessages: `${NS.events}/PullPointSubscription/PullMessagesRequest`,
  renew: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest',
  unsubscribe: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest',
  getEventProperties: `${NS.events}/EventPortType/GetEventPropertiesRequest`,
} as const

// ---------------------------------------------------------------------------------------
// HTTP Digest (snapshots, and the cameras that want it on SOAP too)
// ---------------------------------------------------------------------------------------

export interface DigestChallenge {
  realm: string
  nonce: string
  /** "auth" when offered; null for the RFC 2069 form without qop. */
  qop: 'auth' | null
  opaque: string | null
  algorithm: string
}

const DIGEST_HASHES: Record<string, string> = { 'MD5': 'md5', 'MD5-SESS': 'md5', 'SHA-256': 'sha256', 'SHA-256-SESS': 'sha256' }

/** The Digest challenge of a WWW-Authenticate header, even when a Basic one shares the line. */
export function parseDigestChallenge(header: string | null | undefined): DigestChallenge | null {
  if (!header) return null
  const start = header.search(/(?:^|[\s,])Digest\s/i)
  if (start < 0) return null
  let rest = header.slice(start).replace(/^[\s,]*Digest\s+/i, '')
  const params: Record<string, string> = {}
  const parameter = /^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))\s*(?:,|$)/
  while (rest.length > 0) {
    // "Basic realm=..." after ours: the next scheme, not one of our parameters.
    if (/^\s*[A-Za-z0-9_-]+\s+[A-Za-z0-9_-]+\s*=/.test(rest)) break
    const match = parameter.exec(rest)
    if (!match) break
    params[match[1]!.toLowerCase()] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : (match[3] ?? '')
    rest = rest.slice(match[0].length)
  }
  const algorithm = (params.algorithm ?? 'MD5').toUpperCase()
  if (!DIGEST_HASHES[algorithm] || params.realm === undefined || !params.nonce) return null
  const qops = (params.qop ?? '').split(',').map((item) => item.trim().toLowerCase())
  return { realm: params.realm, nonce: params.nonce, qop: qops.includes('auth') ? 'auth' : null, opaque: params.opaque ?? null, algorithm }
}

const quoted = (text: string) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

export function digestAuthorization(input: {
  method: string
  /** The request target: path and query. */
  uri: string
  username: string
  password: string
  challenge: DigestChallenge
  nc: number
  cnonce: string
}): string {
  const { challenge } = input
  const algorithm = challenge.algorithm.toUpperCase()
  const hash = (text: string) => createHash(DIGEST_HASHES[algorithm] ?? 'md5').update(text, 'utf8').digest('hex')
  let ha1 = hash(`${input.username}:${challenge.realm}:${input.password}`)
  if (algorithm.endsWith('-SESS')) ha1 = hash(`${ha1}:${challenge.nonce}:${input.cnonce}`)
  const ha2 = hash(`${input.method}:${input.uri}`)
  const nc = input.nc.toString(16).padStart(8, '0')
  const response = challenge.qop ? hash(`${ha1}:${challenge.nonce}:${nc}:${input.cnonce}:${challenge.qop}:${ha2}`) : hash(`${ha1}:${challenge.nonce}:${ha2}`)
  const parts = [
    `username="${quoted(input.username)}"`,
    `realm="${quoted(challenge.realm)}"`,
    `nonce="${quoted(challenge.nonce)}"`,
    `uri="${quoted(input.uri)}"`,
    `algorithm=${challenge.algorithm}`,
    `response="${response}"`,
  ]
  if (challenge.qop) parts.push(`qop=${challenge.qop}`, `nc=${nc}`, `cnonce="${quoted(input.cnonce)}"`)
  if (challenge.opaque !== null) parts.push(`opaque="${quoted(challenge.opaque)}"`)
  return `Digest ${parts.join(', ')}`
}

// ---------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------

export function parseSystemDateAndTime(xml: string): Date | null {
  const utc = elements(xml, 'UTCDateTime')[0]
  if (!utc) return null
  const [year, month, day, hour, minute, second] = ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'].map((name) =>
    Number.parseInt(firstText(utc.inner, name) ?? '', 10)
  ) as [number, number, number, number, number, number]
  if ([year, month, day, hour, minute, second].some((value) => Number.isNaN(value))) return null
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second))
}

export interface DeviceInformation {
  manufacturer: string | null
  model: string | null
  firmware: string | null
  serial: string | null
  hardware: string | null
}

const plainText = (xml: string, name: string) => {
  const text = firstText(xml, name)
  return text && !/</.test(text) ? text : null
}

export function parseDeviceInformation(xml: string): DeviceInformation {
  return {
    manufacturer: plainText(xml, 'Manufacturer'),
    model: plainText(xml, 'Model'),
    firmware: plainText(xml, 'FirmwareVersion'),
    serial: plainText(xml, 'SerialNumber'),
    hardware: plainText(xml, 'HardwareId'),
  }
}

export interface ServiceAddresses {
  media: string | null
  ptz: string | null
  events: string | null
}

export function parseCapabilities(xml: string): ServiceAddresses {
  const address = (section: string) => {
    const element = elements(xml, section)[0]
    const xaddr = element ? plainText(element.inner, 'XAddr') : null
    return xaddr && /^https?:\/\//i.test(xaddr) ? xaddr : null
  }
  return { media: address('Media'), ptz: address('PTZ'), events: address('Events') }
}

export interface MediaProfile {
  token: string
  name: string
  width: number | null
  height: number | null
  encoding: string | null
  /** Has a PTZ configuration: moves go through this profile. */
  ptz: boolean
}

export function parseProfiles(xml: string): MediaProfile[] {
  return elements(xml, 'Profiles').flatMap((profile) => {
    const token = profile.attributes.token
    if (!token) return []
    const encoder = elements(profile.inner, 'VideoEncoderConfiguration')[0]
    const size = (name: string) => {
      const value = encoder ? Number.parseInt(plainText(encoder.inner, name) ?? '', 10) : Number.NaN
      return Number.isFinite(value) ? value : null
    }
    return [
      {
        token,
        name: plainText(profile.inner, 'Name') ?? token,
        width: size('Width'),
        height: size('Height'),
        encoding: encoder ? plainText(encoder.inner, 'Encoding') : null,
        ptz: /<(?:[\w.-]+:)?PTZConfiguration[\s/>]/.test(profile.inner),
      },
    ]
  })
}

const VIDEO_ENCODINGS = /^(H\.?264|H\.?265|HEVC|MPEG4)$/i

/** The sharpest video profile for watching, the lightest other one for thumbnails. JPEG profiles only as a last resort. */
export function pickProfiles(profiles: MediaProfile[]): { main: MediaProfile | null; sub: MediaProfile | null } {
  const video = profiles.filter((profile) => profile.encoding === null || VIDEO_ENCODINGS.test(profile.encoding))
  const pool = video.length > 0 ? video : profiles
  const area = (profile: MediaProfile) => (profile.width ?? 0) * (profile.height ?? 0)
  const sorted = [...pool].sort((a, b) => area(b) - area(a))
  return { main: sorted[0] ?? null, sub: sorted.length > 1 ? sorted[sorted.length - 1]! : null }
}

export function parseUri(xml: string): string | null {
  const uri = plainText(xml, 'Uri')
  return uri && /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : null
}

const CREDENTIAL_PARAMETERS = new Set(['user', 'username', 'usr', 'pwd', 'pass', 'password', 'passwd', 'loginuse', 'loginpas', 'token', 'auth'])

/** Some cameras write the login into the URIs they hand out. Nothing that leaves the hub keeps it. */
export function withoutCredentials(uri: string): string {
  const bare = uri.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@?#]*@/i, '$1')
  const questionMark = bare.indexOf('?')
  if (questionMark < 0) return bare
  const hash = bare.indexOf('#', questionMark)
  const query = bare.slice(questionMark + 1, hash < 0 ? undefined : hash)
  const kept = query.split('&').filter((pair) => {
    if (!pair) return false
    const key = pair.split('=')[0]!
    let name = key
    try {
      name = decodeURIComponent(key)
    } catch {}
    return !CREDENTIAL_PARAMETERS.has(name.toLowerCase())
  })
  return bare.slice(0, questionMark) + (kept.length > 0 ? `?${kept.join('&')}` : '') + (hash < 0 ? '' : bare.slice(hash))
}

// ---------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------

export interface Subscription {
  address: string
  terminationTime: Date | null
  /** Header blocks to send back on every call to the subscription; empty for most cameras. */
  referenceParameters: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The top-level elements of a fragment, whole, with their start tag. */
function topLevelElements(xml: string): { name: string; startTag: string; whole: string }[] {
  const found: { name: string; startTag: string; whole: string }[] = []
  let index = 0
  while (index < xml.length) {
    const open = xml.indexOf('<', index)
    if (open < 0) break
    const start = /^<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(xml.slice(open))
    if (!start) {
      index = open + 1
      continue
    }
    const name = start[1]!
    if (start[3] === '/') {
      found.push({ name, startTag: start[0], whole: start[0] })
      index = open + start[0].length
      continue
    }
    const tags = new RegExp(`<(/?)${escapeRegExp(name)}(?=[\\s/>])[^>]*?(/?)>`, 'g')
    tags.lastIndex = open + start[0].length
    let depth = 1
    let end = -1
    for (let tag = tags.exec(xml); tag; tag = tags.exec(xml)) {
      if (tag[1] === '/') depth -= 1
      else if (tag[2] !== '/') depth += 1
      if (depth === 0) {
        end = tags.lastIndex
        break
      }
    }
    if (end < 0) break
    found.push({ name, startTag: start[0], whole: xml.slice(open, end) })
    index = end
  }
  return found
}

/**
 * WS-Addressing: each reference parameter becomes a header block marked IsReferenceParameter.
 * A prefix declared higher up in the camera's answer is declared again on the block, since
 * the block now lives in our envelope.
 */
function referenceHeaders(inner: string, document: string): string {
  return topLevelElements(inner)
    .map((element) => {
      let additions = ''
      const prefix = element.name.includes(':') ? element.name.split(':')[0]! : null
      if (prefix && !new RegExp(`xmlns:${escapeRegExp(prefix)}\\s*=`).test(element.whole)) {
        const declaration = new RegExp(`xmlns:${escapeRegExp(prefix)}\\s*=\\s*("[^"]*"|'[^']*')`).exec(document)
        if (declaration) additions += ` xmlns:${prefix}=${declaration[1]}`
      }
      if (!/IsReferenceParameter\s*=/.test(element.startTag)) additions += ' wsa:IsReferenceParameter="true"'
      const startTag = element.startTag.replace(/\s*(\/?)>$/, `${additions}$1>`)
      return startTag + element.whole.slice(element.startTag.length)
    })
    .join('')
}

export function parseSubscription(xml: string): Subscription | null {
  const reference = elements(xml, 'SubscriptionReference')[0]
  if (!reference) return null
  const address = plainText(reference.inner, 'Address')
  if (!address || !/^https?:\/\//i.test(address)) return null
  const termination = plainText(xml, 'TerminationTime')
  const time = termination ? new Date(termination) : null
  const parameters = elements(reference.inner, 'ReferenceParameters')[0]
  return {
    address,
    terminationTime: time && !Number.isNaN(time.getTime()) ? time : null,
    referenceParameters: parameters ? referenceHeaders(parameters.inner, xml) : '',
  }
}

export type PropertyOperation = 'Initialized' | 'Changed' | 'Deleted'

export interface CameraNotification {
  topic: string
  source: Record<string, string>
  data: Record<string, string>
  /** "Initialized" is the state at subscription time, not something that just happened. */
  operation: PropertyOperation | null
  time: string | null
}

function simpleItems(xml: string, section: string): Record<string, string> {
  const block = elements(xml, section)[0]
  const items: Record<string, string> = {}
  if (!block) return items
  for (const item of elements(block.inner, 'SimpleItem')) {
    const name = item.attributes.Name
    if (name !== undefined) items[name] = item.attributes.Value ?? ''
  }
  return items
}

export function parseNotifications(xml: string): CameraNotification[] {
  return elements(xml, 'NotificationMessage').flatMap((notification) => {
    const topic = plainText(notification.inner, 'Topic')
    if (!topic) return []
    // The tt:Message inside wsnt:Message: the one with the time and the operation.
    const start = /<(?:[\w.-]+:)?Message\s[^>]*(?:UtcTime|PropertyOperation)\s*=[^>]*>/.exec(notification.inner)
    const message = start ? notification.inner.slice(start.index) : notification.inner
    const attrs = start ? attributes(start[0]) : {}
    const operation = attrs.PropertyOperation
    return [
      {
        topic,
        source: simpleItems(message, 'Source'),
        data: simpleItems(message, 'Data'),
        operation: operation === 'Initialized' || operation === 'Changed' || operation === 'Deleted' ? operation : null,
        time: attrs.UtcTime ?? null,
      },
    ]
  })
}

export type CameraEventKind = 'doorbell' | 'person' | 'vehicle' | 'animal' | 'package' | 'tamper' | 'input' | 'motion'

/** First match wins: a "people" rule is a person even when it sits under a motion detector. */
const KIND_WORDS: [CameraEventKind, string[]][] = [
  ['doorbell', ['visitor', 'doorbell', 'bell', 'ring']],
  ['person', ['people', 'person', 'human', 'face', 'pedestrian']],
  ['vehicle', ['vehicle', 'car']],
  ['animal', ['dog', 'cat', 'pet', 'animal']],
  ['package', ['package', 'parcel']],
  ['tamper', ['tamper']],
  ['input', ['input']],
  ['motion', ['motion', 'vmd', 'inside', 'intrusion']],
]

/** "tns1:RuleEngine/TPSmartEventDetector" -> rule, engine, tp, smart, event, detector. Whole words: "Monitoring" is not a ring. */
function words(text: string): string[] {
  return text
    .split('/')
    .map((segment) => segment.replace(/^[^:]*:/, ''))
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function truth(value: string | undefined): boolean | null {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'active':
    case 'on':
      return true
    case 'false':
    case '0':
    case 'inactive':
    case 'off':
      return false
    default:
      return null
  }
}

/** What a notification means for the house, or null when it is not about something happening in view. */
export function classifyEvent(event: CameraNotification): { kind: CameraEventKind; active: boolean } | null {
  const entries = Object.entries(event.data)
  const item = entries.find(([name]) => /^Is[A-Z]/.test(name) || /^(state|logicalstate|active|value)$/i.test(name)) ?? entries[0]
  if (!item) return null
  const active = truth(item[1])
  if (active === null) return null
  const said = new Set([...words(event.topic), ...words(item[0])])
  for (const [kind, keys] of KIND_WORDS) {
    if (keys.some((key) => said.has(key))) return { kind, active }
  }
  return null
}

const MESSAGE_DESCRIPTION = /(?:^|:)MessageDescription$/

function innerOf(element: { name: string; startTag: string; whole: string }): string {
  return element.whole === element.startTag ? '' : element.whole.slice(element.startTag.length, element.whole.lastIndexOf('</'))
}

/**
 * The kinds of event a camera can raise, read from its topic set (GetEventProperties): a
 * doorbell says it is one before anyone rings. Each topic counts with the names of its data
 * items, since Tapo raises a vehicle as a TPSmartEvent carrying IsVehicle.
 */
export function topicKinds(xml: string): CameraEventKind[] {
  const set = elements(xml, 'TopicSet')[0]
  if (!set) return []
  const kinds = new Set<CameraEventKind>()
  const classify = (said: string[]) => {
    const heard = new Set(said)
    const found = KIND_WORDS.find(([, keys]) => keys.some((key) => heard.has(key)))
    if (found) kinds.add(found[0])
  }
  const walk = (fragment: string, path: string[], depth: number) => {
    if (depth > 12) return
    for (const element of topLevelElements(fragment)) {
      if (MESSAGE_DESCRIPTION.test(element.name)) continue
      const here = [...path, element.name]
      const inner = innerOf(element)
      const isTopic = Object.entries(attributes(element.startTag)).some(([key, value]) => /(?:^|:)topic$/.test(key) && value === 'true')
      if (isTopic) {
        const description = topLevelElements(inner).find((child) => MESSAGE_DESCRIPTION.test(child.name))
        const data = description ? elements(description.whole, 'Data')[0] : undefined
        const items = data ? elements(data.inner, 'SimpleItemDescription').flatMap((item) => (item.attributes.Name ? [item.attributes.Name] : [])) : []
        if (items.length === 0) classify(words(here.join('/')))
        for (const item of items) classify([...words(here.join('/')), ...words(item)])
      }
      walk(inner, here, depth + 1)
    }
  }
  walk(set.inner, [], 0)
  return [...kinds]
}
