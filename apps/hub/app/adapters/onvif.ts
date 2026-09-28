/**
 * ONVIF cameras (Profile S): found by WS-Discovery, watched through a PullPoint subscription.
 *
 *  - **Found by themselves** on the WS-Discovery multicast group, and among the scanned
 *    hosts that look like cameras (RTSP open, a camera vendor). Cameras that answer neither
 *    (another subnet, discovery switched off) are listed by address in the settings.
 *  - **One login for the house**, from the settings, or one per camera through pairing. It
 *    never leaves the hub: the stream address in the state carries no login, and pictures
 *    are fetched by the hub (`snapshot`), so the console asks the hub, never the camera.
 *  - **Tokens on the camera's clock.** The clock is read first and every WS-Security token
 *    is dated on it; a refused token gets the clock read again, once, before giving up.
 *    Cameras that also want HTTP Digest on SOAP get it.
 *  - **Events are pulled**: a 10-minute PullPoint subscription, long polls of 60 s, renewed
 *    every 8 minutes, as Home Assistant does. A subscription the camera dropped is made again
 *    at once; an unreachable camera is retried with a growing delay (up to a minute) and
 *    marked offline after two failures. Motion, person, vehicle, animal, package, tamper and
 *    the doorbell button become state and events; what the camera reports at subscription
 *    time is state, never an event.
 *  - **Pan and tilt are nudges** (ContinuousMove, then Stop); zoom goes to a position.
 *
 * Not covered: Media2-only (Profile T) cameras, multi-channel recorders (one camera per
 * device service), recording control (Profile G), HTTPS with self-signed certificates.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { deviceUid, fingerprint } from '@sway-home/shared'
import type { AdapterContext, AdapterDescriptor, AdapterStatus, CapabilityId, CommandResult, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { mapLimit } from '#adapters/base'
import { soapFault } from '#adapters/soap_xml'
import {
  ACTIONS,
  BODIES,
  WS_DISCOVERY,
  classifyEvent,
  digestAuthorization,
  parseCapabilities,
  parseDeviceInformation,
  parseDigestChallenge,
  parseNotifications,
  parseProbeMatches,
  parseProfiles,
  parseSubscription,
  parseSystemDateAndTime,
  parseUri,
  pickProfiles,
  probeMessage,
  rebaseXaddr,
  soapContentType,
  soapRequest,
  topicKinds,
  withoutCredentials,
  type CameraEventKind,
  type CameraNotification,
  type DeviceInformation,
  type DigestChallenge,
  type ProbeMatch,
  type ServiceAddresses,
  type Subscription,
} from '#adapters/onvif_codec'

export interface OnvifOptions {
  /** Where probes go: the WS-Discovery multicast group; tests aim at a camera directly. */
  discoveryTargets?: { address: string; port: number }[]
  probeMs?: number
  requestTimeoutMs?: number
  /** PullMessages long-poll length. */
  pullSeconds?: number
  subscriptionSeconds?: number
  renewMs?: number
  /** First wait after a failure; it doubles up to `maxRetryMs`. */
  retryMs?: number
  maxRetryMs?: number
  /** Pause after a pull that came back at once with nothing, for cameras that ignore the timeout. */
  cooldownMs?: number
  /** How long a pan or tilt nudge lasts before Stop. */
  moveMs?: number
  /** Consecutive failures before a camera is offline. */
  offlineAfter?: number
}

interface Login {
  username: string
  password: string
}

interface StoredCamera {
  nativeId: string
  deviceUrl: string
  name: string
  manufacturer: string | null
  model: string | null
  firmware: string | null
  serial: string | null
  services: ServiceAddresses
  profiles: { main: string | null; sub: string | null; ptz: string | null }
  /** As the camera gave them: they may carry its login, so they stay in the hub. */
  streamUri: string | null
  snapshotUri: string | null
  kinds: CameraEventKind[]
  /** Set by pairing when this camera does not use the house login. */
  login: Login | null
}

interface Pending {
  nativeId: string
  deviceUrl: string
  name: string
  reason: 'missing' | 'refused'
}

/** What a SOAP exchange with one camera needs. */
interface Session {
  deviceUrl: string
  offsetMs: number
  login: Login | null
  soapDigest: { challenge: DigestChallenge; nc: number } | null
}

interface Camera {
  stored: StoredCamera
  session: Session
  httpAuth: { digest: { challenge: DigestChallenge; nc: number } | null; basic: boolean }
  online: boolean | null
  failures: number
  problem: string | null
  lastLog: string | null
  watch: AbortController | null
  loop: Promise<void> | null
  subscription: Subscription | null
  active: Map<CameraEventKind, Set<string>>
  state: Record<string, unknown>
}

class OnvifError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null
  ) {
    super(message)
  }
}

class Unreachable extends Error {}

/** The camera dropped the subscription (reboot, expiry): make another at once. */
class SubscriptionLost extends Error {}

const AUTH_FAILURE = /NotAuthorized|FailedAuthentication|InvalidSecurity|SecurityTokenUnavailable|Unauthorized/i

function isAuthFailure(error: unknown): boolean {
  return error instanceof OnvifError && (error.status === 401 || AUTH_FAILURE.test(error.code) || AUTH_FAILURE.test(error.message))
}

const STORE_KEY = 'cameras'
const ONVIF_PORTS = [80, 8000, 2020, 8899, 8080, 81]
const CAMERA_VENDORS = /hikvision|dahua|reolink|amcrest|axis|tp-?link|tapo|uniview|hanwha|wisenet|foscam|annke|lorex|swann|imou|ezviz|vivotek|ubiquiti|sercomm|hisilicon/i
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024

const LOGIN_HELP =
  "Renseigner l'identifiant et le mot de passe des caméras dans les réglages de l'intégration ONVIF : le compte ONVIF de la caméra, que certaines (Reolink, Tapo) demandent d'activer dans leur application."
const REFUSED_HELP =
  "La caméra refuse cet identifiant ou ce mot de passe. Vérifier son compte ONVIF (certaines, comme Reolink ou Tapo, en ont un distinct de l'application), puis l'appairer avec le bon mot de passe."

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** "192.168.1.70:8000" whatever the path, so one camera found two ways is one camera. */
function hostKey(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return url
  }
}

/** "192.168.1.70", "192.168.1.70:8000" or a full address: the device service to call. */
function deviceUrlFrom(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      if (url.pathname === '/' || url.pathname === '') url.pathname = '/onvif/device_service'
      return url.toString()
    } catch {
      return null
    }
  }
  const match = /^([\w.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?\/?$/i.exec(trimmed)
  if (!match) return null
  return `http://${match[1]}${match[2] && match[2] !== '80' ? `:${match[2]}` : ''}/onvif/device_service`
}

function parseHosts(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/[\s,;]+/)
    .map(deviceUrlFrom)
    .filter((url): url is string => url !== null)
}

/** The IPv4 address when a camera gives several. */
function preferredXaddr(xaddrs: string[]): string | null {
  return xaddrs.find((xaddr) => /^https?:\/\/\d{1,3}(\.\d{1,3}){3}[:/]/i.test(xaddr)) ?? xaddrs[0] ?? null
}

/** Reolink reports zeros; a serial nobody can use is no serial. */
function meaningfulSerial(serial: string | null): string | null {
  return serial && /[1-9a-z]/i.test(serial) ? serial : null
}

function finite(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : null
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export function snapshotPath(nativeId: string): string {
  return `/api/cameras/onvif/${encodeURIComponent(nativeId)}/snapshot`
}

const EMPTY_INFORMATION: DeviceInformation = { manufacturer: null, model: null, firmware: null, serial: null, hardware: null }

type SetUp = { kind: 'camera'; stored: StoredCamera; session: Session } | { kind: 'pending'; pending: Pending } | null

export class OnvifAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'onvif',
    name: 'ONVIF cameras',
    vendor: 'ONVIF',
    transports: ['wifi', 'ethernet'],
    capabilities: ['camera', 'motion', 'doorbell'],
    zeroConfig: false,
    cloud: false,
    implemented: true,
    docsUrl: 'https://www.onvif.org/profiles/profile-s/',
    configSchema: [
      { key: 'username', label: 'Identifiant des caméras', type: 'string', required: true, help: 'Le compte ONVIF, souvent le même pour toutes les caméras de la maison.' },
      { key: 'password', label: 'Mot de passe des caméras', type: 'password', required: true },
      {
        key: 'hosts',
        label: 'Caméras à ajouter à la main',
        type: 'text',
        placeholder: '192.168.1.70:8000',
        help: 'Une adresse par ligne, pour les caméras qui ne répondent pas à la découverte ONVIF (autre sous-réseau, découverte désactivée).',
      },
    ],
  }

  readonly #options: Required<OnvifOptions>
  #context: AdapterContext | null = null
  #houseLogin: Login | null = null
  #manualHosts: string[] = []
  #cameras = new Map<string, Camera>()
  #pending = new Map<string, Pending>()
  #stopped = false

  constructor(options: OnvifOptions = {}) {
    this.#options = {
      discoveryTargets: options.discoveryTargets ?? [{ address: WS_DISCOVERY.address, port: WS_DISCOVERY.port }],
      probeMs: options.probeMs ?? 3000,
      requestTimeoutMs: options.requestTimeoutMs ?? 5000,
      pullSeconds: options.pullSeconds ?? 60,
      subscriptionSeconds: options.subscriptionSeconds ?? 600,
      renewMs: options.renewMs ?? 8 * 60_000,
      retryMs: options.retryMs ?? 5000,
      maxRetryMs: options.maxRetryMs ?? 60_000,
      cooldownMs: options.cooldownMs ?? 750,
      moveMs: options.moveMs ?? 500,
      offlineAfter: options.offlineAfter ?? 2,
    }
  }

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#stopped = false
    const username = typeof config.username === 'string' ? config.username.trim() : ''
    this.#houseLogin = username ? { username, password: typeof config.password === 'string' ? config.password : '' } : null
    this.#manualHosts = parseHosts(config.hosts)
    const stored = (await context.store.get<StoredCamera[]>(STORE_KEY)) ?? []
    for (const entry of stored) {
      const camera = this.#adopt(entry, { deviceUrl: entry.deviceUrl, offsetMs: 0, login: entry.login ?? this.#houseLogin, soapDigest: null })
      // The clock first, then the subscription: in the background, a camera that is off must not hold the boot.
      void this.#syncClock(camera.session).then(() => this.#watch(camera))
    }
  }

  // -------------------------------------------------------------------------------------
  // Discovery and pairing
  // -------------------------------------------------------------------------------------

  async discover(hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    if (this.#stopped) return []
    const candidates = new Map<string, { deviceUrl: string; probe: ProbeMatch | null; nativeId: string | null }>()
    const add = (deviceUrl: string, probe: ProbeMatch | null, nativeId: string | null) => {
      const key = hostKey(deviceUrl)
      const before = candidates.get(key)
      candidates.set(key, { deviceUrl: before?.deviceUrl ?? deviceUrl, probe: probe ?? before?.probe ?? null, nativeId: nativeId ?? before?.nativeId ?? null })
    }
    for (const camera of this.#cameras.values()) add(camera.stored.deviceUrl, null, camera.stored.nativeId)
    for (const match of await this.#probe()) {
      const deviceUrl = preferredXaddr(match.xaddrs)
      if (deviceUrl) add(deviceUrl, match, this.#knownByProbe(match))
    }
    for (const deviceUrl of this.#manualHosts) add(deviceUrl, null, null)
    for (const deviceUrl of this.#scanned(hosts)) if (!candidates.has(hostKey(deviceUrl))) add(deviceUrl, null, null)

    const results = await mapLimit([...candidates.values()], 4, (candidate) => this.#setUp(candidate.deviceUrl, candidate.probe, candidate.nativeId))
    if (this.#stopped) return []

    const devices = new Map<string, DiscoveredDevice>()
    for (const result of results) {
      if (result?.kind !== 'camera') continue
      const camera = this.#adopt(result.stored, result.session)
      this.#pending.delete(result.stored.nativeId)
      devices.set(result.stored.nativeId, this.#describe(camera))
      this.#watch(camera)
    }
    for (const result of results) {
      if (result?.kind !== 'pending' || devices.has(result.pending.nativeId) || this.#cameras.has(result.pending.nativeId)) continue
      this.#pending.set(result.pending.nativeId, result.pending)
      devices.set(result.pending.nativeId, this.#describePending(result.pending))
    }
    await this.#save()
    return [...devices.values()]
  }

  /**
   * With a camera named (`nativeId`, or `host` for one discovery missed), its login is tried
   * on it. From the settings form, with neither, the login is tried on every camera waiting
   * for one and on the addresses the form lists.
   */
  async pair(input: Record<string, unknown>): Promise<{ ok: boolean; message: string; device?: DiscoveredDevice }> {
    const username = typeof input.username === 'string' ? input.username.trim() : ''
    const typed = typeof input.password === 'string' ? input.password : ''
    // The console never holds a saved password: a blank one in the form means the saved one.
    const password = typed || (this.#houseLogin?.username === username ? this.#houseLogin.password : '')
    if (!username) return { ok: false, message: "Il faut l'identifiant ONVIF de la caméra." }
    const login = { username, password }

    const nativeId = typeof input.nativeId === 'string' && input.nativeId ? input.nativeId : null
    const host = typeof input.host === 'string' ? deviceUrlFrom(input.host) : null
    const targets: { deviceUrl: string; nativeId: string | null }[] = []
    if (nativeId) {
      const deviceUrl = this.#cameras.get(nativeId)?.stored.deviceUrl ?? this.#pending.get(nativeId)?.deviceUrl
      if (!deviceUrl) return { ok: false, message: 'Caméra inconnue : lancer une recherche, ou donner son adresse.' }
      targets.push({ deviceUrl, nativeId })
    } else if (host) {
      targets.push({ deviceUrl: host, nativeId: this.#nativeIdAt(host) })
    } else {
      for (const pending of this.#pending.values()) targets.push({ deviceUrl: pending.deviceUrl, nativeId: pending.nativeId })
      for (const deviceUrl of parseHosts(input.hosts)) {
        const known = targets.some((target) => hostKey(target.deviceUrl) === hostKey(deviceUrl)) || this.#nativeIdAt(deviceUrl) !== null
        if (!known) targets.push({ deviceUrl, nativeId: null })
      }
      if (targets.length === 0) return { ok: false, message: "Aucune caméra n'attend d'identifiants : lancer une recherche, ou donner une adresse." }
    }

    const added: DiscoveredDevice[] = []
    let refused = 0
    let silent = 0
    for (const target of targets) {
      const result = await this.#setUp(target.deviceUrl, null, target.nativeId, login)
      if (!result) silent += 1
      else if (result.kind === 'pending') refused += 1
      else {
        const sameAsHouse = this.#houseLogin?.username === username && this.#houseLogin.password === password
        result.stored.login = sameAsHouse ? null : login
        const camera = this.#adopt(result.stored, result.session)
        this.#pending.delete(result.stored.nativeId)
        this.#watch(camera)
        const device = this.#describe(camera)
        this.#context?.emitDiscovered(device)
        added.push(device)
      }
    }
    await this.#save()

    if (nativeId || host) {
      if (added[0]) return { ok: true, message: `Caméra ajoutée : ${added[0].name}.`, device: added[0] }
      return { ok: false, message: refused > 0 ? 'La caméra refuse cet identifiant ou ce mot de passe.' : 'La caméra ne répond pas à cette adresse.' }
    }
    const parts = [
      ...(refused > 0 ? [refused === 1 ? '1 refuse ces identifiants' : `${refused} refusent ces identifiants`] : []),
      ...(silent > 0 ? [silent === 1 ? '1 ne répond pas' : `${silent} ne répondent pas`] : []),
    ]
    const head = added.length === 0 ? 'Aucune caméra ajoutée' : added.length === 1 ? '1 caméra ajoutée' : `${added.length} caméras ajoutées`
    return { ok: added.length > 0, message: `${[head, ...parts].join(' ; ')}.`, device: added[0] }
  }

  /** The camera already known at this address, if any. */
  #nativeIdAt(deviceUrl: string): string | null {
    const key = hostKey(deviceUrl)
    for (const camera of this.#cameras.values()) if (hostKey(camera.stored.deviceUrl) === key) return camera.stored.nativeId
    return null
  }

  #knownByProbe(match: ProbeMatch): string | null {
    const nativeId = match.address.replace(/^urn:uuid:/i, '')
    return this.#cameras.has(nativeId) ? nativeId : null
  }

  /** Scanned hosts that look like cameras, on the ports ONVIF usually listens on. */
  #scanned(hosts: NetworkHost[]): string[] {
    const urls: string[] = []
    for (const host of hosts) {
      const camera = fingerprint.hasPort(host, 554, 2020, 8899) || fingerprint.vendorMatches(host, CAMERA_VENDORS)
      if (!camera) continue
      for (const port of ONVIF_PORTS.filter((candidate) => host.openPorts.includes(candidate))) {
        urls.push(`http://${host.ip}${port === 80 ? '' : `:${port}`}/onvif/device_service`)
      }
    }
    return urls
  }

  async #probe(): Promise<ProbeMatch[]> {
    const targets = this.#options.discoveryTargets
    if (targets.length === 0) return []
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    const matches = new Map<string, ProbeMatch>()
    socket.on('message', (message) => {
      for (const match of parseProbeMatches(message.toString('utf8'))) matches.set(match.address, match)
    })
    socket.on('error', () => undefined)
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.bind(0, () => resolve())
      })
      const localIp = this.#context?.network.localIp
      if (localIp && !localIp.startsWith('127.')) {
        try {
          socket.setMulticastInterface(localIp)
        } catch {
          /* the default interface will do */
        }
      }
      const probe = Buffer.from(probeMessage(`uuid:${randomUUID()}`), 'utf8')
      // SOAP over UDP says twice: a lost datagram is a missed camera.
      for (let round = 0; round < 2; round += 1) {
        for (const target of targets) socket.send(probe, target.port, target.address)
        await sleep(Math.min(200, this.#options.probeMs / 4))
      }
      await sleep(this.#options.probeMs - Math.min(200, this.#options.probeMs / 4) * 2)
    } catch {
      /* no multicast here: the settings and the scan still work */
    } finally {
      socket.close()
    }
    return [...matches.values()]
  }

  /** Everything the hub needs from one camera, or why it cannot have it. Null: not an ONVIF camera, or not answering. */
  async #setUp(deviceUrl: string, probe: ProbeMatch | null, knownNativeId: string | null, loginOverride?: Login): Promise<SetUp> {
    const nativeId = knownNativeId ?? (probe ? probe.address.replace(/^urn:uuid:/i, '') : hostKey(deviceUrl))
    const existing = this.#cameras.get(nativeId) ?? null
    const login = loginOverride ?? existing?.stored.login ?? this.#houseLogin
    const session: Session = { deviceUrl, offsetMs: 0, login, soapDigest: existing?.session.soapDigest ?? null }
    const fallbackName = probe?.name ?? existing?.stored.name ?? `Caméra ${hostOf(deviceUrl)}`
    const pending = (reason: Pending['reason']): SetUp => ({ kind: 'pending', pending: { nativeId, deviceUrl, name: fallbackName, reason } })

    try {
      const clock = parseSystemDateAndTime(await this.#post(session, deviceUrl, BODIES.getSystemDateAndTime, ACTIONS.getSystemDateAndTime, { anonymous: true }))
      if (clock) session.offsetMs = clock.getTime() - Date.now()
    } catch (error) {
      // A SOAP fault, or a 401, is still ONVIF speaking; a 404 page or silence is not.
      if (error instanceof Unreachable || (error instanceof OnvifError && error.code === 'http' && error.status !== 401)) return null
    }
    if (!login) return pending('missing')

    let information = EMPTY_INFORMATION
    let services: ServiceAddresses = { media: null, ptz: null, events: null }
    try {
      information = parseDeviceInformation(await this.#call(session, deviceUrl, BODIES.getDeviceInformation, ACTIONS.getDeviceInformation))
      const capabilities = parseCapabilities(await this.#call(session, deviceUrl, BODIES.getCapabilities, ACTIONS.getCapabilities))
      const rebase = (xaddr: string | null) => (xaddr ? rebaseXaddr(xaddr, deviceUrl) : null)
      services = { media: rebase(capabilities.media), ptz: rebase(capabilities.ptz), events: rebase(capabilities.events) }
    } catch (error) {
      if (isAuthFailure(error)) return pending('refused')
      if (error instanceof Unreachable) return null
      // GetCapabilities refused: a camera without the services we use, still a camera.
    }

    const profiles: StoredCamera['profiles'] = { main: null, sub: null, ptz: null }
    let streamUri: string | null = null
    let snapshotUri: string | null = null
    if (services.media) {
      try {
        const list = parseProfiles(await this.#call(session, services.media, BODIES.getProfiles, ACTIONS.getProfiles))
        const picked = pickProfiles(list)
        profiles.main = picked.main?.token ?? null
        profiles.sub = picked.sub?.token ?? null
        profiles.ptz = services.ptz ? ((picked.main?.ptz ? picked.main : list.find((profile) => profile.ptz))?.token ?? null) : null
        if (picked.main) streamUri = await this.#uri(session, services.media, BODIES.getStreamUri(picked.main.token), ACTIONS.getStreamUri)
        const still = picked.sub ?? picked.main
        if (still) snapshotUri = await this.#uri(session, services.media, BODIES.getSnapshotUri(still.token), ACTIONS.getSnapshotUri)
      } catch (error) {
        if (isAuthFailure(error)) return pending('refused')
        if (error instanceof Unreachable) return null
      }
    }

    let kinds: CameraEventKind[] = []
    if (services.events) {
      try {
        kinds = topicKinds(await this.#call(session, services.events, BODIES.getEventProperties, ACTIONS.getEventProperties))
      } catch {
        /* no topic list: events are still pulled and read as they come */
      }
    }

    const madeBy = [information.manufacturer, information.model].filter(Boolean).join(' ')
    return {
      kind: 'camera',
      session,
      stored: {
        nativeId,
        deviceUrl,
        name: probe?.name ?? existing?.stored.name ?? (madeBy || fallbackName),
        manufacturer: information.manufacturer,
        model: information.model,
        firmware: information.firmware,
        serial: meaningfulSerial(information.serial),
        services,
        profiles,
        streamUri,
        snapshotUri,
        kinds,
        login: loginOverride ?? existing?.stored.login ?? null,
      },
    }
  }

  async #uri(session: Session, url: string, body: string, action: string): Promise<string | null> {
    try {
      const uri = parseUri(await this.#call(session, url, body, action))
      return uri ? rebaseXaddr(uri, session.deviceUrl) : null
    } catch (error) {
      if (isAuthFailure(error) || error instanceof Unreachable) throw error
      return null
    }
  }

  #adopt(stored: StoredCamera, session: Session): Camera {
    const existing = this.#cameras.get(stored.nativeId)
    const camera: Camera = existing ?? {
      stored,
      session,
      httpAuth: { digest: null, basic: false },
      online: null,
      failures: 0,
      problem: null,
      lastLog: null,
      watch: null,
      loop: null,
      subscription: null,
      active: new Map(),
      state: {},
    }
    camera.stored = stored
    camera.session = session
    camera.problem = null
    this.#cameras.set(stored.nativeId, camera)
    this.#emit(camera, {
      streaming: false,
      recording: false,
      streamUrl: stored.streamUri ? withoutCredentials(stored.streamUri) : null,
      snapshotUrl: stored.snapshotUri ? snapshotPath(stored.nativeId) : null,
      ...(stored.services.events && camera.state.motion === undefined ? { motion: false } : {}),
    })
    return camera
  }

  #describe(camera: Camera): DiscoveredDevice {
    const { stored } = camera
    const capabilities: CapabilityId[] = ['camera']
    if (stored.services.events) capabilities.push('motion')
    if (stored.kinds.includes('doorbell') || /doorbell|sonnette/i.test(`${stored.name} ${stored.model ?? ''}`)) capabilities.push('doorbell')
    return {
      adapterId: 'onvif',
      nativeId: stored.nativeId,
      uid: deviceUid('onvif', stored.nativeId),
      name: stored.name,
      category: 'camera',
      capabilities,
      transport: 'ethernet',
      manufacturer: stored.manufacturer,
      model: stored.model,
      firmwareVersion: stored.firmware,
      serialNumber: stored.serial,
      confidence: 0.95,
      network: { ip: hostOf(stored.deviceUrl) },
      meta: { ptz: stored.profiles.ptz !== null, events: stored.services.events !== null, kinds: stored.kinds },
      requiresPairing: null,
    }
  }

  #describePending(pending: Pending): DiscoveredDevice {
    return {
      adapterId: 'onvif',
      nativeId: pending.nativeId,
      uid: deviceUid('onvif', pending.nativeId),
      name: pending.name,
      category: 'camera',
      capabilities: ['camera'],
      transport: 'ethernet',
      confidence: 0.9,
      network: { ip: hostOf(pending.deviceUrl) },
      requiresPairing: { kind: 'token', instructions: pending.reason === 'missing' ? LOGIN_HELP : REFUSED_HELP },
    }
  }

  async #save(): Promise<void> {
    await this.#context?.store.set(
      STORE_KEY,
      [...this.#cameras.values()].map((camera) => camera.stored)
    )
  }

  // -------------------------------------------------------------------------------------
  // SOAP and HTTP
  // -------------------------------------------------------------------------------------

  async #request(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal, maxBytes = MAX_SNAPSHOT_BYTES): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const forward = () => controller.abort()
    signal?.addEventListener('abort', forward, { once: true })
    if (signal?.aborted) controller.abort()
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      const length = Number(response.headers.get('content-length') ?? 0)
      if (length > maxBytes) {
        controller.abort()
        return { status: 413, headers: response.headers, body: new Uint8Array() }
      }
      const body = new Uint8Array(await response.arrayBuffer())
      return { status: response.status, headers: response.headers, body: body.byteLength > maxBytes ? new Uint8Array() : body }
    } catch {
      throw new Unreachable(`${hostOf(url)} ne répond pas`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    }
  }

  #digestHeader(state: { challenge: DigestChallenge; nc: number }, method: string, url: string, login: Login): string {
    state.nc += 1
    let uri = url
    try {
      const parsed = new URL(url)
      uri = parsed.pathname + parsed.search
    } catch {
      /* keep it whole */
    }
    return digestAuthorization({ method, uri, username: login.username, password: login.password, challenge: state.challenge, nc: state.nc, cnonce: randomBytes(8).toString('hex') })
  }

  /** One SOAP exchange; HTTP Digest is added when the camera asks for it. */
  async #post(
    session: Session,
    url: string,
    body: string,
    action: string,
    options: { anonymous?: boolean; to?: string; referenceParameters?: string; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<string> {
    const login = options.anonymous ? null : session.login
    const send = () => {
      const headers: Record<string, string> = { 'content-type': soapContentType(action) }
      if (login && session.soapDigest) headers.authorization = this.#digestHeader(session.soapDigest, 'POST', url, login)
      const envelope = soapRequest(body, {
        username: login?.username,
        password: login?.password,
        now: new Date(Date.now() + session.offsetMs),
        to: options.to,
        action: options.to ? action : undefined,
        referenceParameters: options.referenceParameters,
      })
      return this.#request(url, { method: 'POST', headers, body: envelope }, options.timeoutMs ?? this.#options.requestTimeoutMs, options.signal)
    }
    let answer = await send()
    if (answer.status === 401 && login) {
      const challenge = parseDigestChallenge(answer.headers.get('www-authenticate'))
      if (challenge) {
        session.soapDigest = { challenge, nc: 0 }
        answer = await send()
      }
    }
    const text = new TextDecoder().decode(answer.body)
    const fault = soapFault(text)
    if (fault) throw new OnvifError(fault.code, fault.message, answer.status)
    if (answer.status < 200 || answer.status >= 300) throw new OnvifError('http', `HTTP ${answer.status}`, answer.status)
    return text
  }

  /** A refused token is most often a clock that moved: read it again, once, and retry. */
  async #call(session: Session, url: string, body: string, action: string, options: { to?: string; referenceParameters?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
    try {
      return await this.#post(session, url, body, action, options)
    } catch (error) {
      if (!isAuthFailure(error) || options.signal?.aborted) throw error
      await this.#syncClock(session)
      return await this.#post(session, url, body, action, options)
    }
  }

  async #syncClock(session: Session): Promise<void> {
    try {
      const clock = parseSystemDateAndTime(await this.#post(session, session.deviceUrl, BODIES.getSystemDateAndTime, ACTIONS.getSystemDateAndTime, { anonymous: true }))
      if (clock) session.offsetMs = clock.getTime() - Date.now()
    } catch {
      /* the next call will say what is wrong */
    }
  }

  // -------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------

  #watch(camera: Camera): void {
    if (this.#stopped || camera.loop || !camera.stored.services.events) return
    const controller = new AbortController()
    camera.watch = controller
    camera.loop = this.#run(camera, controller.signal).finally(() => {
      camera.loop = null
    })
  }

  async #run(camera: Camera, signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (!signal.aborted) {
      const events = camera.stored.services.events
      if (!events) return
      try {
        const created = parseSubscription(
          await this.#call(camera.session, events, BODIES.createPullPointSubscription(this.#options.subscriptionSeconds), ACTIONS.createPullPointSubscription, { signal })
        )
        if (!created) throw new OnvifError('subscription', "la caméra n'a pas donné d'adresse d'abonnement", null)
        const subscription: Subscription = { ...created, address: rebaseXaddr(created.address, camera.stored.deviceUrl) }
        camera.subscription = subscription
        this.#reachable(camera)
        attempt = 0
        await this.#pull(camera, subscription, signal)
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof SubscriptionLost && attempt === 0) {
          attempt = 1
          continue
        }
        this.#failed(camera, error)
        attempt += 1
        await sleep(Math.min(this.#options.retryMs * 2 ** (attempt - 1), this.#options.maxRetryMs), signal)
      }
    }
  }

  /** Pull until something breaks: it throws, always. */
  async #pull(camera: Camera, subscription: Subscription, signal: AbortSignal): Promise<void> {
    const addressing = { to: subscription.address, referenceParameters: subscription.referenceParameters, signal }
    const lost = (error: unknown) => (error instanceof OnvifError && !isAuthFailure(error) ? new SubscriptionLost(error.message) : error)
    let renewAt = Date.now() + this.#options.renewMs
    for (;;) {
      const started = Date.now()
      let answer: string
      try {
        answer = await this.#call(camera.session, subscription.address, BODIES.pullMessages(this.#options.pullSeconds, 100), ACTIONS.pullMessages, {
          ...addressing,
          timeoutMs: this.#options.pullSeconds * 1000 + this.#options.requestTimeoutMs,
        })
      } catch (error) {
        throw lost(error)
      }
      this.#reachable(camera)
      const notifications = parseNotifications(answer)
      for (const notification of notifications) this.#heard(camera, notification)
      if (Date.now() >= renewAt) {
        try {
          await this.#call(camera.session, subscription.address, BODIES.renew(this.#options.subscriptionSeconds), ACTIONS.renew, addressing)
        } catch (error) {
          throw lost(error)
        }
        renewAt = Date.now() + this.#options.renewMs
      }
      if (notifications.length === 0 && Date.now() - started < 1000) await sleep(this.#options.cooldownMs, signal)
      if (signal.aborted) throw new Error('stopped')
    }
  }

  #heard(camera: Camera, notification: CameraNotification): void {
    const meaning = classifyEvent(notification)
    if (!meaning) return
    const key = `${notification.topic}|${JSON.stringify(notification.source)}`
    const active = notification.operation === 'Deleted' ? false : meaning.active
    const set = camera.active.get(meaning.kind) ?? new Set<string>()
    camera.active.set(meaning.kind, set)
    const before = set.size > 0
    if (active) set.add(key)
    else set.delete(key)
    const now = set.size > 0
    // What the camera reports at subscription time is how things are, not something that happened.
    const happened = now && !before && notification.operation !== 'Initialized'
    const at = new Date().toISOString()
    const nativeId = camera.stored.nativeId

    if (meaning.kind === 'doorbell') {
      // A press, not a state: only a new one counts.
      if (happened) {
        this.#emit(camera, { lastRingAt: at })
        this.#context?.emitEvent(nativeId, 'doorbell', {})
      }
      return
    }
    const patch: Record<string, unknown> = { [meaning.kind]: now }
    if (meaning.kind === 'motion' && now && !before) patch.lastMotionAt = at
    this.#emit(camera, patch)
    if (happened) this.#context?.emitEvent(nativeId, meaning.kind, {})
  }

  #emit(camera: Camera, patch: Record<string, unknown>): void {
    const changed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch)) {
      if (camera.state[key] !== value) changed[key] = value
    }
    if (Object.keys(changed).length === 0) return
    Object.assign(camera.state, changed)
    this.#context?.emitState(camera.stored.nativeId, changed)
  }

  #reachable(camera: Camera): void {
    camera.failures = 0
    camera.problem = null
    camera.lastLog = null
    if (camera.online !== true) {
      camera.online = true
      this.#context?.emitAvailability(camera.stored.nativeId, true)
    }
  }

  #failed(camera: Camera, error: unknown): void {
    let message: string
    if (error instanceof Unreachable) {
      camera.failures += 1
      message = 'injoignable'
      if (camera.failures >= this.#options.offlineAfter && camera.online !== false) {
        camera.online = false
        this.#context?.emitAvailability(camera.stored.nativeId, false)
      }
    } else if (isAuthFailure(error)) {
      message = 'identifiants refusés'
    } else {
      message = `événements indisponibles (${(error as Error).message})`
    }
    camera.problem = message
    if (camera.lastLog !== message) {
      camera.lastLog = message
      this.#context?.log('warn', `${camera.stored.name} : ${message}`)
    }
  }

  // -------------------------------------------------------------------------------------
  // The rest of the contract
  // -------------------------------------------------------------------------------------

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const camera = this.#cameras.get(nativeId)
    return camera ? { ...camera.state } : {}
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const fail = (error: string): CommandResult => ({ ok: false, deviceId: nativeId, command, error })
    const camera = this.#cameras.get(nativeId)
    if (!camera) return fail(this.#pending.has(nativeId) ? 'Cette caméra attend son identifiant et son mot de passe.' : 'Caméra inconnue.')
    switch (command) {
      case 'snapshot':
        return { ok: true, deviceId: nativeId, command, state: { snapshotUrl: `${snapshotPath(nativeId)}?t=${Date.now()}` }, undo: null }
      case 'startRecording':
      case 'stopRecording':
        return fail("L'enregistrement se règle sur la caméra ou sur son enregistreur : ONVIF ne le pilote pas ici.")
      case 'ptz':
        return this.#ptz(camera, args)
      default:
        return fail(`Une caméra ne sait pas faire "${command}".`)
    }
  }

  async #ptz(camera: Camera, args: Record<string, unknown>): Promise<CommandResult> {
    const nativeId = camera.stored.nativeId
    const fail = (error: string): CommandResult => ({ ok: false, deviceId: nativeId, command: 'ptz', error })
    const token = camera.stored.profiles.ptz
    const service = camera.stored.services.ptz
    if (!token || !service) return fail("Cette caméra ne s'oriente pas : elle n'a pas de commande PTZ.")
    const pan = finite(args.pan)
    const tilt = finite(args.tilt)
    const zoom = finite(args.zoom)
    if (pan === null && tilt === null && zoom === null) return fail('Indiquer pan, tilt ou zoom.')
    try {
      if (pan !== null || tilt !== null) {
        await this.#call(camera.session, service, BODIES.continuousMove(token, { pan: clamp(pan ?? 0, -1, 1), tilt: clamp(tilt ?? 0, -1, 1) }), ACTIONS.continuousMove)
        await sleep(this.#options.moveMs)
        await this.#call(camera.session, service, BODIES.stop(token, { panTilt: true, zoom: false }), ACTIONS.stop)
      }
      if (zoom !== null) await this.#call(camera.session, service, BODIES.absoluteZoom(token, clamp(zoom, 0, 1)), ACTIONS.absoluteMove)
      return { ok: true, deviceId: nativeId, command: 'ptz', state: {}, undo: null }
    } catch (error) {
      if (error instanceof Unreachable) return fail('La caméra ne répond pas.')
      if (isAuthFailure(error)) return fail('La caméra refuse les identifiants.')
      return fail(`La caméra a refusé le mouvement : ${(error as Error).message}`)
    }
  }

  async snapshot(nativeId: string): Promise<{ contentType: string; body: Uint8Array } | null> {
    const camera = this.#cameras.get(nativeId)
    const uri = camera?.stored.snapshotUri
    if (!camera || !uri) return null
    const login = camera.session.login
    const headers = (): Record<string, string> => {
      const out: Record<string, string> = { accept: 'image/*' }
      if (login && camera.httpAuth.digest) out.authorization = this.#digestHeader(camera.httpAuth.digest, 'GET', uri, login)
      else if (login && camera.httpAuth.basic) out.authorization = `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`
      return out
    }
    const timeoutMs = this.#options.requestTimeoutMs * 2
    try {
      let answer = await this.#request(uri, { headers: headers() }, timeoutMs)
      if (answer.status === 401 && login) {
        const header = answer.headers.get('www-authenticate')
        const challenge = parseDigestChallenge(header)
        if (challenge) camera.httpAuth = { digest: { challenge, nc: 0 }, basic: false }
        else if (/^\s*Basic/i.test(header ?? '')) camera.httpAuth = { digest: null, basic: true }
        else return null
        answer = await this.#request(uri, { headers: headers() }, timeoutMs)
      }
      const contentType = (answer.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (answer.status !== 200 || !contentType.startsWith('image/') || answer.body.byteLength === 0) return null
      return { contentType, body: answer.body }
    } catch {
      return null
    }
  }

  status(): AdapterStatus {
    const cameras = [...this.#cameras.values()]
    const pending = [...this.#pending.values()]
    if (!this.#houseLogin && cameras.length === 0) {
      return {
        health: 'needs_setup',
        deviceCount: 0,
        message: pending.length > 0 ? `${pending.length} caméra(s) trouvée(s) : identifiant et mot de passe à renseigner.` : 'Identifiant et mot de passe des caméras à renseigner.',
      }
    }
    const problems = [
      ...pending.map((entry) => `${entry.name} : ${entry.reason === 'refused' ? 'identifiants refusés' : 'identifiants à renseigner'}`),
      ...cameras.filter((camera) => camera.problem !== null).map((camera) => `${camera.stored.name} : ${camera.problem}`),
    ]
    return { health: problems.length > 0 ? 'degraded' : 'ok', deviceCount: cameras.length, message: problems.length > 0 ? problems.join(' ; ') : undefined }
  }

  async shutdown(): Promise<void> {
    this.#stopped = true
    const cameras = [...this.#cameras.values()]
    for (const camera of cameras) camera.watch?.abort()
    await Promise.all(cameras.map((camera) => camera.loop ?? Promise.resolve()))
    await Promise.all(
      cameras.map(async (camera) => {
        const subscription = camera.subscription
        camera.subscription = null
        if (!subscription) return
        try {
          await this.#post(camera.session, subscription.address, BODIES.unsubscribe, ACTIONS.unsubscribe, {
            to: subscription.address,
            referenceParameters: subscription.referenceParameters,
            timeoutMs: 1500,
          })
        } catch {
          /* it lapses by itself */
        }
      })
    )
    this.#cameras.clear()
    this.#pending.clear()
    this.#context = null
  }
}
