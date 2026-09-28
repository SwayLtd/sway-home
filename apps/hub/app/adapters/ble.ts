/**
 * Bluetooth LE: the sensors that broadcast and never join a network, and beacons for people.
 *
 *  - **Nothing to pair.** A thermometer, a door sensor or a button appears the first time it
 *    is heard, with the capabilities its readings show, and gains more as they come (the
 *    battery often arrives in a later packet). Repeated copies of one packet count once, so a
 *    press is one press.
 *  - **Encrypted sensors** (BTHome, Xiaomi MiBeacon v4/v5) are listed and wait for their key,
 *    written in the settings as "address = key". Keys are never repeated in a state, a log or
 *    a status; a wrong one is said by the sensor's address.
 *  - **Beacons stand for people**: an iBeacon identity (a phone app broadcasting one) or a
 *    fixed address (keys, a watch), named in the settings, is home while heard and away a few
 *    minutes after it goes quiet.
 *  - **Silence**: a sensor that reports on a schedule (temperature, humidity...) and has not
 *    been heard for an hour is offline; one that speaks only when something happens (a
 *    button, a door) is never marked offline for being quiet.
 *  - **Where it listens**: the hub's own radio on Windows, and any Theengs Gateway or
 *    OpenMQTTGateway on MQTT (see `ble_sources`).
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deviceUid } from '@sway-home/shared'
import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterStatus,
  CapabilityId,
  CommandResult,
  DiscoveredDevice,
  NetworkHost,
  ProtocolAdapter,
} from '@sway-home/shared'
import {
  capabilitiesFor,
  decode,
  parseBeacons,
  parseKeys,
  stateFrom,
  type Advert,
  type BeaconRule,
  type Values,
} from '#adapters/ble_codec'
import {
  GatewaySource,
  ProcessScanner,
  windowsScanner,
  type AdvertSource,
} from '#adapters/ble_sources'

export interface BleOptions {
  /** Replaces the sources the settings would build: tests bring their own radio. */
  sources?: AdvertSource[]
  cacheDir?: string
  /** A sensor reporting on a schedule, silent this long, is offline. */
  staleMs?: number
  /** A beacon silent this long is away. Fixed here, it wins over the settings. */
  awayMs?: number
  /** How long a new sensor may wait for its name, which often travels in the scan response. */
  nameWaitMs?: number
  /** How long `init` waits for the radios; the rest of their start goes on without the hub. */
  startWaitMs?: number
  checkMs?: number
}

interface Sensor {
  address: string
  name: string
  /** False while the name is made up from the format: the real one may still come. */
  named: boolean
  firstSeen: number
  format: string
  model: string | null
  capabilities: CapabilityId[]
  state: Record<string, unknown>
  lastSeen: number
  lastPacket: string | null
  online: boolean
  locked: 'no-key' | 'wrong-key' | null
  device: DiscoveredDevice | null
}

interface Beacon {
  rule: BeaconRule
  nativeId: string
  state: Record<string, unknown>
  lastSeen: number | null
}

const MAKERS: Record<string, string> = {
  bthome: 'BTHome',
  pvvx: 'Xiaomi (pvvx)',
  atc1441: 'Xiaomi (ATC)',
  mibeacon: 'Xiaomi',
  govee: 'Govee',
  switchbot: 'SwitchBot',
  ruuvi: 'Ruuvi',
  thermobeacon: 'ThermoBeacon',
}

/** Measured on a schedule: silence means trouble. Buttons and doors speak only when used. */
const PERIODIC: CapabilityId[] = [
  'temperature',
  'humidity',
  'pressure',
  'illuminance',
  'airQuality',
]

function slug(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'balise'
  )
}

export class BleAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'ble',
    name: 'Bluetooth LE',
    vendor: 'Bluetooth SIG',
    transports: ['ble'],
    capabilities: [
      'temperature',
      'humidity',
      'pressure',
      'illuminance',
      'battery',
      'presence',
      'contact',
      'motion',
      'occupancy',
      'waterLeak',
      'smoke',
      'airQuality',
      'button',
      'power',
      'energy',
    ],
    zeroConfig: true,
    cloud: false,
    implemented: true,
    requiresHardware:
      'Le Bluetooth de la machine du hub (Windows), ou une passerelle Theengs / OpenMQTTGateway',
    docsUrl: 'https://bthome.io/',
    configSchema: [
      {
        key: 'localScan',
        label: 'Écouter avec le Bluetooth de cette machine (Windows)',
        type: 'boolean',
        default: true,
      },
      {
        key: 'activeScan',
        label: 'Écoute active',
        type: 'boolean',
        default: true,
        help: "Demande aux capteurs leur réponse de scan : certains (Govee) n'y mettent leurs mesures que là.",
      },
      {
        key: 'mqttHost',
        label: 'Passerelle MQTT (Theengs, OpenMQTTGateway)',
        type: 'host',
        placeholder: '192.168.1.10',
      },
      { key: 'mqttPort', label: 'Port MQTT', type: 'number', default: 1883 },
      { key: 'mqttUsername', label: 'Utilisateur MQTT', type: 'string' },
      { key: 'mqttPassword', label: 'Mot de passe MQTT', type: 'password' },
      {
        key: 'mqttTopic',
        label: 'Sujet MQTT des annonces',
        type: 'string',
        default: 'home/+/BTtoMQTT/#',
      },
      {
        key: 'bindkeys',
        label: 'Clés des capteurs chiffrés',
        type: 'password',
        help: 'Une par capteur, "adresse = clé" (32 caractères), séparées par des points-virgules : A4:C1:38:02:83:F4 = e9ea...a8',
      },
      {
        key: 'beacons',
        label: 'Balises des personnes',
        type: 'text',
        help: 'Une par ligne : "Téléphone de Camille = <identifiant iBeacon>[:major[:minor]]" ou "Clés de Sam = <adresse>".',
      },
      {
        key: 'awayMinutes',
        label: 'Absent après (minutes sans balise)',
        type: 'number',
        default: 3,
      },
    ],
  }

  readonly #options: Required<Omit<BleOptions, 'sources' | 'awayMs'>> & {
    sources: AdvertSource[] | null
    awayMs: number | null
  }
  #context: AdapterContext | null = null
  #sources: AdvertSource[] = []
  #problems = new Map<AdvertSource, string | null>()
  #working = new Set<AdvertSource>()
  #keys = new Map<string, Buffer>()
  #settingsErrors: string[] = []
  #sensors = new Map<string, Sensor>()
  #beacons: Beacon[] = []
  /** Names heard before their sensor spoke (the scan response came first). Bounded. */
  #names = new Map<string, string>()
  #waiting = new Map<string, ReturnType<typeof setTimeout>>()
  #awayMs: number
  #timer: ReturnType<typeof setInterval> | null = null
  #startedAt = Date.now()

  constructor(options: BleOptions = {}) {
    this.#options = {
      sources: options.sources ?? null,
      cacheDir: options.cacheDir ?? join(tmpdir(), 'sway-home'),
      staleMs: options.staleMs ?? 3_600_000,
      awayMs: options.awayMs ?? null,
      nameWaitMs: options.nameWaitMs ?? 3_000,
      startWaitMs: options.startWaitMs ?? 2_000,
      checkMs: options.checkMs ?? 60_000,
    }
    this.#awayMs = this.#options.awayMs ?? 180_000
  }

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#startedAt = Date.now()
    const away = Number(config.awayMinutes)
    this.#awayMs =
      this.#options.awayMs ??
      (config.awayMinutes !== undefined &&
      config.awayMinutes !== '' &&
      Number.isFinite(away) &&
      away > 0
        ? away * 60_000
        : 180_000)

    const keys = parseKeys(config.bindkeys)
    const beacons = parseBeacons(config.beacons)
    this.#keys = keys.keys
    this.#settingsErrors = [
      ...keys.errors.map((error) => `clés, ${error}`),
      ...beacons.errors.map((error) => `balises, ${error}`),
    ]
    this.#beacons = beacons.beacons.map((rule) => ({
      rule,
      nativeId: `beacon:${slug(rule.name)}`,
      state: {},
      lastSeen: null,
    }))

    this.#sources = this.#options.sources ?? this.#fromSettings(config)
    const sources = this.#sources
    const starting = sources.map(async (source) => {
      this.#problems.set(source, null)
      const ok = await source
        .start(
          (advert, decoded) => this.#heard(advert, decoded ?? null),
          (problem) => {
            if (this.#sources !== sources) return
            this.#problems.set(source, problem)
            if (problem === null) this.#working.add(source)
          }
        )
        .catch((error: Error) => {
          this.#problems.set(source, error.message)
          return false
        })
      if (ok && this.#sources === sources) this.#working.add(source)
    })
    this.#timer = setInterval(() => this.#check(), this.#options.checkMs)
    // The hub starts its adapters one after the other: a radio slow to come up (the Windows
    // scanner compiles itself the first time) must not hold the others back.
    let waited: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(starting),
      new Promise((resolve) => (waited = setTimeout(resolve, this.#options.startWaitMs))),
    ])
    clearTimeout(waited)
  }

  #fromSettings(config: Record<string, unknown>): AdvertSource[] {
    const sources: AdvertSource[] = []
    if (config.localScan !== false) {
      const active = config.activeScan !== false
      sources.push(
        new ProcessScanner({
          name: 'Bluetooth de cette machine',
          resolve: () => windowsScanner(this.#options.cacheDir, { active }),
        })
      )
    }
    const host = typeof config.mqttHost === 'string' ? config.mqttHost.trim() : ''
    if (host) {
      sources.push(
        new GatewaySource({
          host,
          port: Number(config.mqttPort ?? 1883) || 1883,
          username:
            typeof config.mqttUsername === 'string' && config.mqttUsername
              ? config.mqttUsername
              : undefined,
          password:
            typeof config.mqttPassword === 'string' && config.mqttPassword
              ? config.mqttPassword
              : undefined,
          topic:
            typeof config.mqttTopic === 'string' && config.mqttTopic.trim()
              ? config.mqttTopic.trim()
              : 'home/+/BTtoMQTT/#',
        })
      )
    }
    return sources
  }

  // -------------------------------------------------------------------------------------
  // What is heard
  // -------------------------------------------------------------------------------------

  #heard(advert: Advert, relayed: Values | null): void {
    const now = Date.now()
    if (advert.name?.trim()) this.#named(advert.address, advert.name.trim())
    for (const beacon of this.#beacons) {
      if (beacon.rule.address && beacon.rule.address === advert.address)
        this.#beaconHeard(beacon, advert, now)
    }
    const decoded = decode(advert, this.#keys)
    if (decoded?.kind === 'beacon') {
      for (const beacon of this.#beacons) {
        const rule = beacon.rule
        if (
          rule.uuid === decoded.uuid &&
          (rule.major === null || rule.major === decoded.major) &&
          (rule.minor === null || rule.minor === decoded.minor)
        )
          this.#beaconHeard(beacon, advert, now)
      }
      return
    }
    if (decoded?.kind === 'reading') {
      this.#reading(advert, decoded.format, decoded.model, decoded.packet, decoded.values, now)
      return
    }
    // A gateway may hold the key the hub lacks: what it decoded is a reading.
    if (relayed) {
      this.#reading(
        advert,
        decoded?.format ?? 'gateway',
        decoded?.model ?? null,
        null,
        relayed,
        now
      )
      return
    }
    if (decoded?.kind === 'locked')
      this.#locked(advert, decoded.format, decoded.model, decoded.reason, now)
  }

  #named(address: string, name: string): void {
    const sensor = this.#sensors.get(address)
    if (!sensor) {
      this.#names.delete(address)
      this.#names.set(address, name)
      if (this.#names.size > 512) this.#names.delete(this.#names.keys().next().value!)
      return
    }
    if (sensor.named) return
    sensor.name = this.#nameOf(address, name)
    sensor.named = true
    if (!sensor.device) this.#settle(sensor)
  }

  #nameOf(address: string, base: string): string {
    const tail = address.replace(/:/g, '').slice(-4)
    return base.toUpperCase().includes(tail) ? base : `${base} ${tail}`
  }

  #sensorFor(advert: Advert, format: string, model: string | null, now: number): Sensor {
    let sensor = this.#sensors.get(advert.address)
    if (!sensor) {
      const heard = advert.name?.trim() || this.#names.get(advert.address) || null
      this.#names.delete(advert.address)
      const base =
        heard ??
        (model
          ? `${MAKERS[format] ?? ''} ${model}`.trim()
          : `Capteur ${MAKERS[format] ?? 'Bluetooth'}`)
      sensor = {
        address: advert.address,
        name: this.#nameOf(advert.address, base),
        named: heard !== null,
        firstSeen: now,
        format,
        model,
        capabilities: [],
        state: {},
        lastSeen: now,
        lastPacket: null,
        online: true,
        locked: null,
        device: null,
      }
      this.#sensors.set(advert.address, sensor)
    }
    sensor.lastSeen = now
    if (!sensor.online) {
      sensor.online = true
      this.#context?.emitAvailability(sensor.address, true)
    }
    return sensor
  }

  #reading(
    advert: Advert,
    format: string,
    model: string | null,
    packet: number | null,
    values: Values,
    now: number
  ): void {
    const sensor = this.#sensorFor(advert, format, model, now)
    sensor.format = format
    sensor.model = model ?? sensor.model
    // Sensors repeat each packet several times: the same packet is the same event.
    const packetKey = packet === null ? null : `${format}:${packet}`
    if (packetKey !== null && packetKey === sensor.lastPacket) return
    sensor.lastPacket = packetKey

    const wasLocked = sensor.locked !== null
    sensor.locked = null
    const capabilities = [...new Set([...sensor.capabilities, ...capabilitiesFor(values)])]
    const grew = capabilities.length !== sensor.capabilities.length
    sensor.capabilities = capabilities

    const at = new Date(now).toISOString()
    const patch = stateFrom(values, at)
    if (
      patch.open !== undefined &&
      sensor.state.open !== undefined &&
      patch.open !== sensor.state.open
    )
      patch.lastChangedAt = at
    if (!sensor.device) {
      // Not in the house yet: nothing listens to it, so it can wait a moment for its name.
      Object.assign(sensor.state, patch)
      if (sensor.named || now - sensor.firstSeen >= this.#options.nameWaitMs) this.#settle(sensor)
      else this.#waitForName(sensor)
    } else {
      if (grew || wasLocked) this.#announce(sensor)
      this.#emit(advert.address, sensor.state, patch)
    }
    if (!sensor.device) return
    for (const button of values.buttons ?? [])
      this.#context?.emitEvent(advert.address, 'button', {
        action: button.event,
        buttonIndex: button.index,
      })
  }

  /** Into the house, with what it has said so far. */
  #settle(sensor: Sensor): void {
    const timer = this.#waiting.get(sensor.address)
    if (timer) clearTimeout(timer)
    this.#waiting.delete(sensor.address)
    if (sensor.device || (sensor.capabilities.length === 0 && !sensor.locked)) return
    this.#announce(sensor)
    if (Object.keys(sensor.state).length > 0)
      this.#context?.emitState(sensor.address, { ...sensor.state })
  }

  #waitForName(sensor: Sensor): void {
    if (this.#waiting.has(sensor.address)) return
    const wait = Math.max(0, sensor.firstSeen + this.#options.nameWaitMs - Date.now())
    this.#waiting.set(
      sensor.address,
      setTimeout(() => this.#settle(sensor), wait)
    )
  }

  #locked(
    advert: Advert,
    format: string,
    model: string | null,
    reason: 'no-key' | 'wrong-key',
    now: number
  ): void {
    const sensor = this.#sensorFor(advert, format, model, now)
    if (sensor.locked === reason) return
    sensor.locked = reason
    if (sensor.device) this.#announce(sensor)
    else if (sensor.named || now - sensor.firstSeen >= this.#options.nameWaitMs)
      this.#settle(sensor)
    else this.#waitForName(sensor)
    this.#context?.log(
      'warn',
      reason === 'no-key'
        ? `Capteur Bluetooth chiffré ${advert.address} : sa clé manque dans les réglages.`
        : `Capteur Bluetooth ${advert.address} : la clé donnée ne le déchiffre pas.`
    )
  }

  #announce(sensor: Sensor): void {
    const device: DiscoveredDevice = {
      adapterId: 'ble',
      nativeId: sensor.address,
      uid: deviceUid('ble', sensor.address),
      name: sensor.name,
      category: 'sensor',
      capabilities: sensor.capabilities,
      transport: 'ble',
      manufacturer: MAKERS[sensor.format] ?? null,
      model: sensor.model,
      confidence: 0.9,
      network: { mac: sensor.address },
      meta: { format: sensor.format },
      requiresPairing: sensor.locked
        ? {
            kind: 'code',
            instructions:
              sensor.locked === 'no-key'
                ? `Capteur chiffré : ajouter sa clé (bindkey, 32 caractères) dans les réglages Bluetooth, sous la forme "${sensor.address} = clé".`
                : `La clé donnée pour ${sensor.address} ne le déchiffre pas : la corriger dans les réglages Bluetooth ("${sensor.address} = clé").`,
          }
        : null,
    }
    sensor.device = device
    this.#context?.emitDiscovered(device)
  }

  #beaconHeard(beacon: Beacon, advert: Advert, now: number): void {
    beacon.lastSeen = now
    this.#emit(beacon.nativeId, beacon.state, {
      home: true,
      confidence: 1,
      source: 'bluetooth',
      rssi: advert.rssi,
      lastSeenAt: new Date(now).toISOString(),
    })
  }

  #emit(nativeId: string, current: Record<string, unknown>, patch: Record<string, unknown>): void {
    const changed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch))
      if (current[key] !== value) changed[key] = value
    if (Object.keys(changed).length === 0) return
    Object.assign(current, changed)
    this.#context?.emitState(nativeId, changed)
  }

  /** Beacons gone quiet are away; sensors reporting on a schedule and gone quiet are offline. */
  #check(): void {
    const now = Date.now()
    for (const beacon of this.#beacons) {
      const since = beacon.lastSeen ?? this.#startedAt
      if (now - since >= this.#awayMs && beacon.state.home !== false)
        this.#emit(beacon.nativeId, beacon.state, {
          home: false,
          confidence: 1,
          source: 'bluetooth',
        })
    }
    for (const sensor of this.#sensors.values()) {
      if (
        !sensor.online ||
        !sensor.capabilities.some((capability) => PERIODIC.includes(capability))
      )
        continue
      if (now - sensor.lastSeen >= this.#options.staleMs) {
        sensor.online = false
        this.#context?.emitAvailability(sensor.address, false)
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // The rest of the contract
  // -------------------------------------------------------------------------------------

  async discover(_hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    const sensors = [...this.#sensors.values()].flatMap((sensor) =>
      sensor.device ? [sensor.device] : []
    )
    const beacons = this.#beacons.map((beacon): DiscoveredDevice => ({
      adapterId: 'ble',
      nativeId: beacon.nativeId,
      uid: deviceUid('ble', beacon.nativeId),
      name: beacon.rule.name,
      category: 'phone',
      capabilities: ['presence'],
      transport: 'ble',
      confidence: 0.9,
      network: beacon.rule.address ? { mac: beacon.rule.address } : undefined,
      meta: beacon.rule.uuid
        ? { beacon: { uuid: beacon.rule.uuid, major: beacon.rule.major, minor: beacon.rule.minor } }
        : {},
    }))
    return [...beacons, ...sensors]
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    const beacon = this.#beacons.find((entry) => entry.nativeId === nativeId)
    if (beacon) return { ...beacon.state }
    return { ...(this.#sensors.get(nativeId)?.state ?? {}) }
  }

  async execute(nativeId: string, command: string): Promise<CommandResult> {
    const error =
      command === 'setPresence'
        ? 'La présence vient de la balise : elle se met à jour seule.'
        : 'Les capteurs Bluetooth ne font que parler : ils ne reçoivent pas de commande.'
    return { ok: false, deviceId: nativeId, command, error }
  }

  status(): AdapterStatus {
    const deviceCount =
      this.#beacons.length + [...this.#sensors.values()].filter((sensor) => sensor.device).length
    if (this.#sources.length === 0) {
      return {
        health: 'needs_setup',
        deviceCount,
        message:
          'Aucune écoute Bluetooth : activer celle de cette machine (Windows) ou donner une passerelle MQTT.',
      }
    }
    const problems = [...this.#problems.entries()].flatMap(([source, problem]) =>
      problem ? [`${source.name} : ${problem}`] : []
    )
    if (this.#working.size === 0)
      return {
        health: 'needs_setup',
        deviceCount,
        message: problems.join(' ; ') || 'Écoute Bluetooth en cours de démarrage.',
      }
    const locked = [...this.#sensors.values()]
      .filter((sensor) => sensor.locked === 'wrong-key')
      .map((sensor) => `clé refusée par ${sensor.address}`)
    const all = [...problems, ...locked, ...this.#settingsErrors]
    return {
      health: all.length > 0 ? 'degraded' : 'ok',
      deviceCount,
      message: all.length > 0 ? all.join(' ; ') : undefined,
    }
  }

  async shutdown(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    for (const timer of this.#waiting.values()) clearTimeout(timer)
    this.#waiting.clear()
    this.#names.clear()
    await Promise.all(this.#sources.map((source) => source.stop().catch(() => undefined)))
    this.#sources = []
    this.#problems.clear()
    this.#working.clear()
    this.#sensors.clear()
    this.#context = null
  }
}
