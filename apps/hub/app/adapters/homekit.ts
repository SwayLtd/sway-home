/**
 * HomeKit: accessories paired with the hub itself, without Apple's Home app.
 *
 *  - **Pairing** takes the accessory's setup code - the 8 digits printed on it or on its
 *    notice, or the text of its QR code ("X-HM://...") - and an accessory waiting for a
 *    controller: found by mDNS (`_hap._tcp`, status flag "not paired"), or given by address.
 *    A QR code names its accessory among several (its setup hash); 8 digits are tried on each
 *    accessory waiting until one accepts them. An accessory already in Apple's Home app has to
 *    be removed from it (or reset) first: a HomeKit accessory has one owner.
 *  - **One HomeKit accessory, one device**. A bridge (Homebridge, a Hue or Aqara hub...) is a
 *    device of its own, and so is each accessory behind it, named as the bridge names it. An
 *    accessory with several things to switch (a power strip) lists them as endpoints.
 *  - **Everything is pushed**: once the encrypted session is open the hub subscribes to every
 *    characteristic able to notify, so a lamp switched at the wall or a button pressed reaches
 *    the house at once. What cannot notify is read every minute, which also proves the session
 *    alive. The session stays open; when it drops the hub reconnects at once, then less and
 *    less often, looking the accessory up again by mDNS in case it moved.
 *  - **What the hub keeps**, in the adapter's store: its own controller identity (an Ed25519
 *    key pair) and, per accessory, its identifier, its public key and its last address. The
 *    setup code is not kept: it is never needed again.
 *
 * Only HomeKit over IP (Wi-Fi, Ethernet) is spoken. Bluetooth and Thread accessories are out
 * of its reach, and so are cameras' video and TVs.
 */

import type { AdapterContext, AdapterDescriptor, AdapterStatus, CommandResult, DeviceCategory, DiscoveredDevice, NetworkHost, ProtocolAdapter } from '@sway-home/shared'
import { browse } from '@sway-home/discovery'
import { HapConnection, HapError, newControllerIdentity, statusText, type AccessoryKeys, type CharacteristicEvent, type ControllerIdentity } from '#adapters/hap_client'
import {
  buttonAction,
  C,
  capabilitiesOf,
  categoryOf,
  isBridge,
  parseAccessories,
  parseAdvert,
  parseSetupCode,
  planWrite,
  S,
  setupHash,
  stateOf,
  type HapAccessory,
  type HapAdvert,
  type HapCharacteristic,
  type HapService,
} from '#adapters/hap_codec'

export interface HomekitOptions {
  /** Looks for HomeKit accessories on the network: mDNS by default. */
  browse?: (durationMs: number) => Promise<HapAdvert[]>
  /** How long one look at the network lasts. */
  browseMs?: number
  /** How long a connection or a request may take before the accessory is said not to answer. */
  requestTimeoutMs?: number
  /** First wait before reconnecting an accessory that dropped; half as long again each time. */
  retryMs?: number
  maxRetryMs?: number
  /** While an accessory cannot be reached, how often it is looked up again on the network. */
  rediscoverMs?: number
  /** How often the network is checked for accessories that moved or whose database changed. */
  checkMs?: number
  /** How often what cannot notify is read. */
  pollMs?: number
}

interface StoredController {
  id: string
  privateKey: string
  publicKey: string
}

interface StoredPairing {
  id: string
  /** The accessory's long-term public key, hex. */
  key: string
  host: string
  port: number
  name: string
  /** The database version it last advertised ("c#"). */
  configNumber: number | null
  /** Devices behind a bridge the house removed: the bridge keeps them, the house does not. */
  hidden: string[]
  /** The devices it had, to say they are offline before it has answered once. */
  devices: string[]
}

interface HubDevice {
  nativeId: string
  aid: number
  name: string
  /** Service iids listed to the house as endpoints, when there is more than one thing to switch. */
  listed: number[]
  discovered: DiscoveredDevice
}

interface Link {
  stored: StoredPairing
  connection: HapConnection | null
  connecting: boolean
  accessories: HapAccessory[]
  devices: HubDevice[]
  /** Null until the accessory has answered, or failed to, once. */
  online: boolean | null
  /** The accessory answers but no longer knows the hub: reset, or removed from elsewhere. */
  refused: boolean
  retry: ReturnType<typeof setTimeout> | null
  retryDelay: number
  /** When the current session opened: one that drops at once is not reopened at once. */
  connectedAt: number
  poll: ReturnType<typeof setInterval> | null
  /** "aid.iid" of characteristics able to notify that the accessory would not subscribe: read instead. */
  unheard: Set<string>
  lookedUpAt: number
  /** Let go of: nothing it does matters any more. */
  gone: boolean
}

/** A session that lasted this long was a working one: its drop is reconnected at once. */
const STABLE_SESSION_MS = 30_000

/** Services that do something, as opposed to measuring: more than one makes endpoints. */
const ACTUATORS = new Set<string>([S.lightbulb, S.outlet, S.switch, S.fan, S.fanV2, S.covering, S.garage, S.lock, S.thermostat, S.valve])

/** Services and characteristics not worth reading again: they do not change. */
const STATIC_SERVICES = new Set<string>([S.info, S.protocol])
const STATIC_CHARACTERISTICS = new Set<string>([C.name, C.labelIndex])

const ENDPOINT_LABELS: Partial<Record<DeviceCategory, string>> = {
  light: 'Lumière',
  outlet: 'Prise',
  switch: 'Interrupteur',
  cover: 'Volet',
  lock: 'Serrure',
  climate: 'Climat',
  appliance: 'Appareil',
}

const same = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b))

async function browseNetwork(durationMs: number): Promise<HapAdvert[]> {
  const result = await browse({ serviceTypes: ['_hap._tcp.local'], durationMs })
  return result.services.flatMap((service) => parseAdvert(service) ?? [])
}

export class HomekitAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'homekit',
    name: 'HomeKit accessories',
    vendor: 'Apple',
    transports: ['wifi'],
    capabilities: [
      'onoff',
      'brightness',
      'colorTemperature',
      'color',
      'position',
      'garage',
      'thermostat',
      'fan',
      'lock',
      'valve',
      'temperature',
      'humidity',
      'illuminance',
      'motion',
      'occupancy',
      'contact',
      'waterLeak',
      'smoke',
      'carbonMonoxide',
      'airQuality',
      'battery',
      'button',
      'doorbell',
      'identify',
    ],
    zeroConfig: true,
    cloud: false,
    implemented: true,
    requiresHardware: null,
    docsUrl: 'https://developer.apple.com/apple-home/',
  }

  readonly #options: Required<HomekitOptions>
  #context: AdapterContext | null = null
  #links = new Map<string, Link>()
  #identity: Promise<ControllerIdentity> | null = null
  #browsing: Promise<HapAdvert[]> | null = null
  #checker: ReturnType<typeof setInterval> | null = null
  #checking = false
  /** What was last pushed for each device (and endpoint), so only changes go up. */
  #pushed = new Map<string, Record<string, unknown>>()
  #closed = false

  constructor(options: HomekitOptions = {}) {
    this.#options = {
      browse: options.browse ?? browseNetwork,
      browseMs: options.browseMs ?? 3000,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      retryMs: options.retryMs ?? 500,
      maxRetryMs: options.maxRetryMs ?? 60_000,
      rediscoverMs: options.rediscoverMs ?? 30_000,
      checkMs: options.checkMs ?? 300_000,
      pollMs: options.pollMs ?? 60_000,
    }
  }

  async init(context: AdapterContext, _config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#closed = false
    for (const stored of (await context.store.get<StoredPairing[]>('pairings')) ?? []) {
      void this.#connect(this.#link(stored))
    }
    this.#checker = setInterval(() => void this.#check(), this.#options.checkMs)
  }

  #link(stored: StoredPairing): Link {
    const link: Link = {
      stored,
      connection: null,
      connecting: false,
      accessories: [],
      devices: [],
      online: null,
      refused: false,
      retry: null,
      retryDelay: this.#options.retryMs,
      connectedAt: 0,
      poll: null,
      unheard: new Set(),
      lookedUpAt: 0,
      gone: false,
    }
    this.#links.set(stored.id, link)
    return link
  }

  async #save(): Promise<void> {
    await this.#context?.store.set(
      'pairings',
      [...this.#links.values()].map((link) => link.stored)
    )
  }

  /** The hub as a HomeKit controller: made once, the first time an accessory is paired. */
  #controller(): Promise<ControllerIdentity> {
    this.#identity ??= (async () => {
      const store = this.#context!.store
      const stored = await store.get<StoredController>('controller')
      if (stored) return { id: stored.id, privateKey: Buffer.from(stored.privateKey, 'hex'), publicKey: Buffer.from(stored.publicKey, 'hex') }
      const identity = newControllerIdentity()
      await store.set('controller', { id: identity.id, privateKey: identity.privateKey.toString('hex'), publicKey: identity.publicKey.toString('hex') })
      return identity
    })()
    return this.#identity
  }

  /** One look at the network at a time, shared by whoever asks meanwhile. */
  #adverts(): Promise<HapAdvert[]> {
    this.#browsing ??= this.#options
      .browse(this.#options.browseMs)
      .catch(() => [])
      .finally(() => {
        this.#browsing = null
      })
    return this.#browsing
  }

  // -------------------------------------------------------------------------------------
  // The session
  // -------------------------------------------------------------------------------------

  async #connect(link: Link): Promise<void> {
    if (link.connecting || link.connection || link.gone || this.#closed) return
    link.connecting = true
    let connection: HapConnection | null = null
    try {
      const controller = await this.#controller()
      connection = await HapConnection.connect(link.stored.host, link.stored.port, this.#options.requestTimeoutMs)
      await connection.pairVerify({ accessoryId: link.stored.id, accessoryKey: Buffer.from(link.stored.key, 'hex') }, controller)
      const accessories = parseAccessories(await connection.getJson('/accessories'))
      if (link.gone || this.#closed) {
        connection.close()
        return
      }
      const session = connection
      link.connection = session
      link.refused = false
      session.onEvent = (events) => this.#changed(link, events)
      session.onClose = () => this.#dropped(link, session)
      this.#load(link, accessories)
      await this.#subscribe(link)
      await this.#catchUp(link)
      link.connectedAt = Date.now()
      this.#available(link, true)
      link.poll = setInterval(() => void this.#poll(link), this.#options.pollMs)
    } catch (error) {
      if (connection && link.connection === connection) return // it dropped meanwhile: handled there
      connection?.close()
      this.#failed(link, error as Error)
    } finally {
      link.connecting = false
    }
  }

  #failed(link: Link, error: Error): void {
    if (link.gone || this.#closed) return
    const refused = error instanceof HapError && error.code === 'authentication'
    if (refused && !link.refused) {
      this.#context?.log('warn', `HomeKit : "${link.stored.name}" ne reconnaît plus le hub (remis à zéro, ou retiré depuis un autre contrôleur).`)
    }
    link.refused = refused
    this.#available(link, false)
    this.#retryLater(link)
  }

  #dropped(link: Link, connection: HapConnection): void {
    if (link.connection !== connection) return
    link.connection = null
    if (link.poll) clearInterval(link.poll)
    link.poll = null
    if (link.gone || this.#closed) return
    // A session that held is reopened at once: the drop is often a blip (the accessory
    // restarted its server, Wi-Fi roamed), offline only if the new connection fails too. One
    // that drops as soon as it opens (an accessory out of sessions) waits, longer each time.
    if (Date.now() - link.connectedAt >= STABLE_SESSION_MS) {
      link.retryDelay = this.#options.retryMs
      void this.#connect(link)
    } else {
      this.#retryLater(link)
    }
  }

  #retryLater(link: Link): void {
    if (link.retry || link.gone || this.#closed) return
    const delay = link.retryDelay
    link.retryDelay = Math.min(Math.round(link.retryDelay * 1.5), this.#options.maxRetryMs)
    link.retry = setTimeout(async () => {
      link.retry = null
      if (link.gone || this.#closed || link.connection) return
      // It may have moved: DHCP gave it another address, or it restarted on another port.
      if (Date.now() - link.lookedUpAt >= this.#options.rediscoverMs) await this.#lookUp(link)
      void this.#connect(link)
    }, delay)
  }

  async #lookUp(link: Link): Promise<void> {
    link.lookedUpAt = Date.now()
    const advert = (await this.#adverts()).find((candidate) => candidate.id === link.stored.id)
    if (advert) await this.#moved(link, advert)
  }

  async #moved(link: Link, advert: HapAdvert): Promise<boolean> {
    if (advert.host === link.stored.host && advert.port === link.stored.port) return false
    link.stored.host = advert.host
    link.stored.port = advert.port
    await this.#save()
    return true
  }

  /** Every few minutes: accessories that moved, and bridges whose database changed. */
  async #check(): Promise<void> {
    if (this.#checking || this.#links.size === 0 || this.#closed) return
    this.#checking = true
    try {
      const adverts = await this.#adverts()
      for (const link of this.#links.values()) {
        const advert = adverts.find((candidate) => candidate.id === link.stored.id)
        if (!advert || link.gone) continue
        if ((await this.#moved(link, advert)) && !link.connection) {
          if (link.retry) clearTimeout(link.retry)
          link.retry = null
          void this.#connect(link)
        }
        if (advert.configNumber === null || advert.configNumber === link.stored.configNumber) continue
        const known = link.stored.configNumber
        link.stored.configNumber = advert.configNumber
        await this.#save()
        // A number first learnt says nothing new: the database was read at connection.
        if (known !== null && link.connection) await this.#reload(link)
      }
    } finally {
      this.#checking = false
    }
  }

  async #reload(link: Link): Promise<void> {
    const connection = link.connection
    if (!connection) return
    try {
      this.#load(link, parseAccessories(await connection.getJson('/accessories')))
      await this.#subscribe(link)
      await this.#catchUp(link)
    } catch (error) {
      this.#context?.log('warn', `HomeKit : "${link.stored.name}" n'a pas redonné ses accessoires : ${(error as Error).message}`)
    }
  }

  /**
   * One request per accessory, as aiohomekit does: some accessories choke on one big request.
   * What an accessory will not notify is read with the minute's reading instead.
   */
  async #subscribe(link: Link): Promise<void> {
    link.unheard.clear()
    for (const accessory of link.accessories) {
      const connection = link.connection
      if (!connection) return
      const items = accessory.services
        .flatMap((service) => service.characteristics)
        .filter((characteristic) => characteristic.perms.includes('ev'))
        .map((characteristic) => ({ aid: characteristic.aid, iid: characteristic.iid, ev: true }))
      if (items.length === 0) continue
      try {
        const refused = await connection.putCharacteristics(items)
        for (const entry of refused) link.unheard.add(`${entry.aid}.${entry.iid}`)
      } catch (error) {
        // A dropped session is handled where it drops; anything else costs that accessory its
        // notifications, not the whole session its devices.
        if (!link.connection) return
        for (const item of items) link.unheard.add(`${item.aid}.${item.iid}`)
        this.#context?.log('warn', `HomeKit : "${accessory.info.name ?? link.stored.name}" ne notifie pas ses changements : ${(error as Error).message}`)
      }
    }
  }

  /**
   * The values read with the database may have moved before the subscriptions took: read what
   * notifies once more, now that nothing can be missed any longer.
   */
  async #catchUp(link: Link): Promise<void> {
    const notifying = link.accessories
      .flatMap((accessory) => accessory.services.flatMap((service) => service.characteristics))
      .filter((characteristic) => characteristic.perms.includes('ev') && characteristic.perms.includes('pr') && characteristic.type !== C.switchEvent)
    try {
      await this.#read(link, notifying)
    } catch (error) {
      if (link.connection) this.#context?.log('debug', `HomeKit : "${link.stored.name}" n'a pas relu ses valeurs : ${(error as Error).message}`)
    }
  }

  /** What cannot notify is read; with nothing to read, the bridge's name keeps the session honest. */
  async #poll(link: Link): Promise<void> {
    const all = link.accessories.flatMap((accessory) => accessory.services.filter((service) => !STATIC_SERVICES.has(service.type)).flatMap((service) => service.characteristics))
    const quiet = (characteristic: HapCharacteristic) => !characteristic.perms.includes('ev') || link.unheard.has(`${characteristic.aid}.${characteristic.iid}`)
    let targets: HapCharacteristic[] = all.filter(
      (characteristic) => characteristic.perms.includes('pr') && quiet(characteristic) && characteristic.type !== C.switchEvent && !STATIC_CHARACTERISTICS.has(characteristic.type)
    )
    if (targets.length === 0) {
      const name = link.accessories[0]?.services.find((service) => service.type === S.info)?.characteristics.find((characteristic) => characteristic.type === C.name)
      targets = name ? [name] : []
    }
    try {
      await this.#read(link, targets)
    } catch {
      // A request that times out closes the session: the drop is handled there.
    }
  }

  /** GET /characteristics, fifty at a time: an accessory's request line is not unlimited. */
  async #read(link: Link, characteristics: HapCharacteristic[]): Promise<void> {
    for (let start = 0; start < characteristics.length; start += 50) {
      const connection = link.connection
      if (!connection) return
      const ids = characteristics
        .slice(start, start + 50)
        .map((characteristic) => `${characteristic.aid}.${characteristic.iid}`)
        .join(',')
      const answer = (await connection.getJson(`/characteristics?id=${ids}`)) as { characteristics?: (CharacteristicEvent & { status?: number })[] }
      this.#changed(
        link,
        (answer.characteristics ?? []).filter((entry) => 'value' in entry && !entry.status)
      )
    }
  }

  // -------------------------------------------------------------------------------------
  // Accessories as devices
  // -------------------------------------------------------------------------------------

  #load(link: Link, accessories: HapAccessory[]): void {
    link.accessories = accessories
    const previous = new Map(link.devices.map((device) => [device.nativeId, JSON.stringify(device.discovered)]))
    link.devices = this.#structure(link).filter((device) => !link.stored.hidden.includes(device.nativeId))
    for (const device of link.devices) {
      if (previous.get(device.nativeId) !== JSON.stringify(device.discovered)) this.#context?.emitDiscovered(device.discovered)
    }
    // Gone from the bridge: offline in the house until it is removed there too.
    for (const nativeId of previous.keys()) {
      if (!link.devices.some((device) => device.nativeId === nativeId)) this.#context?.emitAvailability(nativeId, false)
    }
    const ids = link.devices.map((device) => device.nativeId)
    const name = link.devices[0]?.name ?? link.stored.name
    if (JSON.stringify(ids) !== JSON.stringify(link.stored.devices) || name !== link.stored.name) {
      link.stored.devices = ids
      link.stored.name = name
      void this.#save()
    }
    this.#refresh(link)
  }

  /** The accessory as the house sees it: its own device, and one per accessory behind a bridge. */
  #structure(link: Link): HubDevice[] {
    const accessories = link.accessories
    const main = accessories.find((accessory) => accessory.aid === 1) ?? accessories[0]
    if (!main) return []
    const bridge = isBridge(accessories)
    const mainName = main.info.name ?? link.stored.name
    return accessories.map((accessory) => {
      const isMain = accessory === main
      const nativeId = isMain ? link.stored.id : `${link.stored.id}/${accessory.aid}`
      const name = accessory.info.name ?? (isMain ? mainName : `${mainName} ${accessory.aid}`)
      const actuators = accessory.services.filter((service) => ACTUATORS.has(service.type))
      const listed = actuators.length > 1 ? actuators : []
      let category = categoryOf(accessory.services)
      if (isMain && bridge && category === 'unknown') category = 'gateway'
      const discovered: DiscoveredDevice = {
        adapterId: 'homekit',
        nativeId,
        uid: `homekit:${nativeId}`,
        name,
        category,
        capabilities: capabilitiesOf(accessory.services),
        transport: 'wifi',
        manufacturer: accessory.info.manufacturer,
        model: accessory.info.model,
        firmwareVersion: accessory.info.firmware,
        serialNumber: accessory.info.serialNumber,
        confidence: 1,
        endpoints:
          listed.length > 0
            ? listed.map((service, index) => ({
                index: service.iid,
                name: service.name ?? `${ENDPOINT_LABELS[categoryOf([service])] ?? 'Partie'} ${index + 1}`,
                category: categoryOf([service]),
                capabilities: capabilitiesOf([service]),
              }))
            : undefined,
        network: isMain ? { ip: link.stored.host } : undefined,
        meta: { accessoryId: link.stored.id, aid: accessory.aid },
      }
      return { nativeId, aid: accessory.aid, name, listed: listed.map((service) => service.iid), discovered }
    })
  }

  /** Recompute the devices' state from the characteristics' values, and push what changed. */
  #refresh(link: Link, only?: Set<number>): void {
    const now = new Date().toISOString()
    for (const device of link.devices) {
      if (only && !only.has(device.aid)) continue
      const accessory = link.accessories.find((candidate) => candidate.aid === device.aid)
      if (!accessory) continue
      this.#push(device.nativeId, stateOf(accessory.services, now))
      for (const iid of device.listed) {
        const service = accessory.services.find((candidate) => candidate.iid === iid)
        if (service) this.#push(device.nativeId, stateOf([service], now), iid)
      }
    }
  }

  #push(nativeId: string, state: Record<string, unknown>, endpointIndex?: number): void {
    const key = `${nativeId}|${endpointIndex ?? ''}`
    const previous = this.#pushed.get(key) ?? {}
    const patch: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(state)) if (!same(previous[name], value)) patch[name] = value
    // Dates that belong to a change, not to every report.
    if ('lastMotionAt' in patch && !('motion' in patch)) delete patch.lastMotionAt
    if ('open' in patch && previous.open !== undefined) patch.lastChangedAt = new Date().toISOString()
    if (Object.keys(patch).length === 0) return
    this.#pushed.set(key, { ...previous, ...patch })
    if (endpointIndex === undefined) this.#context?.emitState(nativeId, patch)
    else this.#context?.emitState(nativeId, patch, endpointIndex)
  }

  #changed(link: Link, events: CharacteristicEvent[]): void {
    const touched = new Set<number>()
    const at = new Date().toISOString()
    for (const event of events) {
      const accessory = link.accessories.find((candidate) => candidate.aid === event.aid)
      const service = accessory?.services.find((candidate) => candidate.characteristics.some((characteristic) => characteristic.iid === event.iid))
      const characteristic = service?.characteristics.find((candidate) => candidate.iid === event.iid)
      if (!accessory || !service || !characteristic) continue
      if (characteristic.type === C.switchEvent) {
        this.#pressed(link, accessory, service, event.value, at)
        continue
      }
      characteristic.value = event.value
      touched.add(event.aid)
    }
    if (touched.size > 0) this.#refresh(link, touched)
  }

  /** A button pressed or a doorbell rung: an event, not a state; reading it back gives nothing. */
  #pressed(link: Link, accessory: HapAccessory, service: HapService, value: unknown, at: string): void {
    const device = link.devices.find((candidate) => candidate.aid === accessory.aid)
    if (!device) return
    if (service.type === S.doorbell) {
      this.#push(device.nativeId, { lastRingAt: at })
      this.#context?.emitEvent(device.nativeId, 'doorbell', {})
      return
    }
    const action = buttonAction(value)
    if (!action) return
    const buttons = accessory.services.filter((candidate) => candidate.type === S.button)
    const label = service.characteristics.find((characteristic) => characteristic.type === C.labelIndex)?.value
    const buttonIndex = buttons.length > 1 ? (typeof label === 'number' ? label - 1 : buttons.indexOf(service)) : 0
    this.#push(device.nativeId, { lastEvent: action, lastEventAt: at, buttonIndex })
    this.#context?.emitEvent(device.nativeId, 'button', { action, buttonIndex })
  }

  #available(link: Link, online: boolean): void {
    if (link.online === online) return
    link.online = online
    const ids = link.devices.length > 0 ? link.devices.map((device) => device.nativeId) : link.stored.devices.filter((id) => !link.stored.hidden.includes(id))
    for (const nativeId of ids) this.#context?.emitAvailability(nativeId, online)
  }

  // -------------------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------------------

  async pair(input: Record<string, unknown>): Promise<{ ok: boolean; message: string; device?: DiscoveredDevice }> {
    const raw = [input.pin, input.code, input.setupCode].find((value) => typeof value === 'string' && value.trim())
    if (typeof raw !== 'string') {
      return { ok: false, message: 'Donner le code de configuration HomeKit de l\'accessoire : les 8 chiffres imprimés dessus ou sur sa notice (123-45-678), ou le texte de son QR code ("X-HM://...").' }
    }
    const setup = parseSetupCode(raw)
    if ('error' in setup) return { ok: false, message: setup.error }
    const address = typeof input.address === 'string' ? /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(input.address.trim()) : null
    const wanted = typeof input.id === 'string' && input.id.trim() ? input.id.trim().toUpperCase() : null

    let candidates: { host: string; port: number; name: string | null; configNumber: number | null }[]
    if (address) {
      candidates = [{ host: address[1]!, port: Number(address[2]), name: null, configNumber: null }]
    } else {
      const adverts = (await this.#adverts()).filter((advert) => !wanted || advert.id === wanted)
      const waiting = adverts.filter((advert) => !advert.paired)
      // The QR code's setup id names one accessory; failing that, every accessory waiting is tried.
      const named = setup.setupId ? waiting.filter((advert) => advert.setupHash === setupHash(setup.setupId!, advert.id)) : []
      const chosen = named.length > 0 ? named : waiting
      if (chosen.length === 0) {
        const taken = adverts.filter((advert) => advert.paired && !this.#links.has(advert.id))
        if (taken.length > 0) {
          const names = taken.map((advert) => `"${advert.name}"`).join(', ')
          return {
            ok: false,
            message: `Aucun accessoire HomeKit n'attend d'appairage : ${names} ${taken.length > 1 ? 'sont déjà appairés' : 'est déjà appairé'} (à Maison d'Apple ou à un autre contrôleur). L'en retirer, ou le remettre à zéro, puis réessayer.`,
          }
        }
        return {
          ok: false,
          message: "Aucun accessoire HomeKit en attente d'appairage sur le réseau. Vérifier qu'il est allumé et sur le même réseau que le hub (ou donner son adresse), puis réessayer.",
        }
      }
      candidates = chosen.map((advert) => ({ host: advert.host, port: advert.port, name: advert.name, configNumber: advert.configNumber }))
    }

    const controller = await this.#controller()
    let refusedCode = false
    let lastError: string | null = null
    for (const candidate of candidates) {
      let connection: HapConnection | null = null
      try {
        connection = await HapConnection.connect(candidate.host, candidate.port, this.#options.requestTimeoutMs)
        const keys = await connection.pairSetup(setup.code, controller)
        connection.close()
        return await this.#paired(keys, candidate)
      } catch (error) {
        connection?.close()
        if (error instanceof HapError && error.code === 'authentication') refusedCode = true
        else lastError = (error as Error).message
      }
    }
    if (refusedCode) {
      return { ok: false, message: "L'accessoire refuse ce code : vérifier qu'il est recopié en entier (8 chiffres, sur l'accessoire, sa notice ou son emballage)." }
    }
    return { ok: false, message: `L'appairage a échoué : ${lastError ?? 'aucune réponse'}.` }
  }

  async #paired(keys: AccessoryKeys, candidate: { host: string; port: number; name: string | null; configNumber: number | null }): Promise<{ ok: boolean; message: string; device?: DiscoveredDevice }> {
    // Paired again after a reset: the new pairing replaces the old one, hidden devices kept.
    const previous = this.#links.get(keys.accessoryId)
    if (previous) this.#release(previous)
    const link = this.#link({
      id: keys.accessoryId,
      key: keys.accessoryKey.toString('hex'),
      host: candidate.host,
      port: candidate.port,
      name: candidate.name ?? keys.accessoryId,
      configNumber: candidate.configNumber,
      hidden: previous?.stored.hidden ?? [],
      devices: previous?.stored.devices ?? [],
    })
    await this.#save()
    await this.#connect(link)
    if (!link.connection) {
      return { ok: false, message: `"${link.stored.name}" est appairé au hub, mais ne s'est pas encore présenté : il apparaîtra dès qu'il répondra.` }
    }
    const [first, ...others] = link.devices
    const behind = others.length > 0 ? `, avec ${others.length} appareil${others.length > 1 ? 's' : ''} derrière lui` : ''
    return { ok: true, message: `"${first?.name ?? link.stored.name}" ajouté${behind}.`, device: first?.discovered }
  }

  /** Stops everything a link does, without touching the accessory. */
  #release(link: Link): void {
    link.gone = true
    if (link.retry) clearTimeout(link.retry)
    if (link.poll) clearInterval(link.poll)
    link.retry = null
    link.poll = null
    const connection = link.connection
    link.connection = null
    connection?.close()
    this.#links.delete(link.stored.id)
    for (const nativeId of new Set([...link.devices.map((device) => device.nativeId), ...link.stored.devices])) this.#forgetPushed(nativeId)
  }

  #forgetPushed(nativeId: string): void {
    for (const key of [...this.#pushed.keys()]) if (key.startsWith(`${nativeId}|`)) this.#pushed.delete(key)
  }

  // -------------------------------------------------------------------------------------
  // The rest of the contract
  // -------------------------------------------------------------------------------------

  #find(nativeId: string): { link: Link; device: HubDevice | null } | null {
    for (const link of this.#links.values()) {
      const device = link.devices.find((candidate) => candidate.nativeId === nativeId) ?? null
      if (device || link.stored.id === nativeId || link.stored.devices.includes(nativeId)) return { link, device }
    }
    return null
  }

  async forget(nativeId: string): Promise<{ ok: boolean; message?: string }> {
    const found = this.#find(nativeId)
    if (!found) return { ok: true }
    const { link, device } = found
    if (nativeId !== link.stored.id) {
      // Behind a bridge: the bridge decides what it bridges. The hub stops showing it.
      if (!link.stored.hidden.includes(nativeId)) link.stored.hidden.push(nativeId)
      link.devices = link.devices.filter((candidate) => candidate.nativeId !== nativeId)
      link.stored.devices = link.stored.devices.filter((id) => id !== nativeId)
      this.#forgetPushed(nativeId)
      await this.#save()
      return { ok: true, message: `"${device?.name ?? nativeId}" n'est plus suivi ; il reste sur le pont "${link.stored.name}" tant qu'il n'en est pas retiré.` }
    }

    // The hub removes its own pairing from the accessory, which frees it for another controller.
    let connection = link.connection
    let reachable = false
    link.gone = true
    try {
      const controller = await this.#controller()
      if (!connection) {
        connection = await HapConnection.connect(link.stored.host, link.stored.port, this.#options.requestTimeoutMs)
        await connection.pairVerify({ accessoryId: link.stored.id, accessoryKey: Buffer.from(link.stored.key, 'hex') }, controller)
      }
      await connection.removePairing(controller.id)
      reachable = true
    } catch {
      // Unreachable, or it already forgot the hub: nothing more can be done from here.
    }
    connection?.close()
    this.#release(link)
    await this.#save()
    const name = link.stored.name
    return {
      ok: true,
      message: reachable
        ? `"${name}" a quitté le hub : il attend un nouveau contrôleur.`
        : `"${name}" est retiré du hub ; injoignable, il garde l'appairage du hub jusqu'à sa remise à zéro.`,
    }
  }

  async discover(_hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    return [...this.#links.values()].flatMap((link) => link.devices.map((device) => device.discovered))
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    return { ...(this.#pushed.get(`${nativeId}|`) ?? {}) }
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>, endpointIndex?: number): Promise<CommandResult> {
    const fail = (error: string): CommandResult => ({ ok: false, deviceId: nativeId, command, error })
    const found = this.#find(nativeId)
    if (!found?.device) return fail('Accessoire HomeKit inconnu.')
    const { link, device } = found
    const connection = link.connection
    if (!connection) return fail(`"${device.name}" ne répond pas : il est hors ligne.`)
    const accessory = link.accessories.find((candidate) => candidate.aid === device.aid)
    if (!accessory) return fail('Accessoire HomeKit inconnu.')

    let services = accessory.services
    if (endpointIndex !== undefined) {
      const service = device.listed.includes(endpointIndex) ? services.find((candidate) => candidate.iid === endpointIndex) : undefined
      if (!service) return fail(`"${device.name}" n'a pas de partie ${endpointIndex}.`)
      services = [service, ...services.filter((candidate) => candidate.type === S.info)]
    }
    const plan = planWrite(services, command, args ?? {})
    if ('error' in plan) return fail(plan.error)
    try {
      const refused = await connection.putCharacteristics(plan.writes.map((write) => ({ aid: write.aid, iid: write.iid, value: write.value })))
      if (refused.length > 0) return fail(`"${device.name}" a refusé : ${statusText(refused[0]!.status)}.`)
    } catch {
      return fail(`"${device.name}" ne répond pas.`)
    }
    // An accessory tells every controller of a change except the one that made it: the hub
    // notes its own writes.
    const touched = new Set<number>()
    for (const write of plan.writes) {
      const characteristic = link.accessories
        .find((candidate) => candidate.aid === write.aid)
        ?.services.flatMap((service) => service.characteristics)
        .find((candidate) => candidate.iid === write.iid)
      if (!characteristic || characteristic.type === C.identify) continue
      characteristic.value = write.value
      touched.add(write.aid)
    }
    this.#refresh(link, touched)
    return { ok: true, deviceId: nativeId, command }
  }

  status(): AdapterStatus {
    const links = [...this.#links.values()]
    const deviceCount = links.reduce((total, link) => total + (link.devices.length || link.stored.devices.filter((id) => !link.stored.hidden.includes(id)).length), 0)
    if (links.length === 0) {
      return {
        health: 'needs_setup',
        deviceCount,
        message: 'Aucun accessoire HomeKit : en ajouter un avec son code de configuration (les 8 chiffres 123-45-678 imprimés dessus) ou le texte de son QR code ("X-HM://...").',
      }
    }
    const refused = links.filter((link) => link.refused).map((link) => `"${link.stored.name}"`)
    const offline = links.filter((link) => link.online === false && !link.refused).map((link) => link.stored.name)
    const problems: string[] = []
    if (refused.length > 0) {
      problems.push(`${refused.join(', ')} ${refused.length > 1 ? 'ne reconnaissent' : 'ne reconnaît'} plus le hub (remis à zéro, ou retiré depuis un autre contrôleur) : l'appairer à nouveau avec son code.`)
    }
    if (offline.length > 0) problems.push(`Hors ligne : ${offline.join(', ')}.`)
    if (problems.length > 0) return { health: 'degraded', deviceCount, message: problems.join(' ') }
    return { health: 'ok', deviceCount }
  }

  async shutdown(): Promise<void> {
    this.#closed = true
    if (this.#checker) clearInterval(this.#checker)
    this.#checker = null
    for (const link of [...this.#links.values()]) this.#release(link)
    this.#links.clear()
    this.#pushed.clear()
    this.#identity = null
    this.#context = null
  }
}
