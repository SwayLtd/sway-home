/**
 * The virtual house.
 *
 * A simulated flat full of devices that behave the way real ones do: lights that fade,
 * a thermostat whose room temperature actually converges on the set point, motion sensors
 * that fire on a plausible schedule, a washing machine that finishes its cycle, energy
 * meters whose numbers add up.
 *
 * This is not a toy. It is how the rest of the system gets tested: the agent, the routines,
 * the charts, the undo stack and the whole UI can be exercised end to end with no hardware
 * in the room, and a regression in any of them shows up here first. It is also what makes a
 * demo possible for someone whose house has three Wi-Fi devices in it.
 *
 * Every simulated device carries `simulated: true` in its meta, and the UI marks them, so
 * nobody ever mistakes the virtual living room for the real one.
 */

import type {
  AdapterContext,
  AdapterDescriptor,
  AdapterStatus,
  CapabilityId,
  CommandResult,
  DeviceCategory,
  DiscoveredDevice,
  NetworkHost,
  ProtocolAdapter,
} from '@sway-home/shared'
import { clamp, hsToRgb, kelvinToRgb, NAMED_COLOURS } from '@sway-home/shared'
import { encodeXml } from '#adapters/soap_xml'

interface VirtualDevice {
  nativeId: string
  name: string
  area: string
  category: DeviceCategory
  capabilities: CapabilityId[]
  state: Record<string, unknown>
  manufacturer: string
  model: string
  /** Set for devices that drift on their own: thermostats, sensors, meters. */
  tick?: (device: VirtualDevice, elapsedMs: number, clock: Date) => Record<string, unknown> | null
}

const AREAS = ['Salon', 'Cuisine', 'Chambre', 'Bureau', 'Salle de bain', 'Entrée', 'Garage', 'Jardin'] as const

function light(nativeId: string, name: string, area: string, options: { colour?: boolean; tunable?: boolean; power?: number } = {}): VirtualDevice {
  const capabilities: CapabilityId[] = ['onoff', 'brightness', 'identify', 'connectivity', 'firmware']
  if (options.tunable !== false) capabilities.push('colorTemperature')
  if (options.colour) capabilities.push('color', 'effect')
  capabilities.push('power', 'energy')

  return {
    nativeId,
    name,
    area,
    category: 'light',
    capabilities,
    manufacturer: 'Sway Virtual',
    model: options.colour ? 'VL-100 RGBW' : 'VL-50 White',
    state: {
      on: false,
      brightness: 80,
      colorTemperature: 2700,
      colorTemperatureRange: [2200, 6500],
      hue: 40,
      saturation: 20,
      effect: null,
      availableEffects: options.colour ? ['Bougie', 'Aurore', 'Orage', 'Cinéma', 'Fête'] : [],
      power: 0,
      energyTotal: Number((Math.random() * 40).toFixed(3)),
      rssi: -40 - Math.round(Math.random() * 30),
      firmwareVersion: '1.4.2',
      updateAvailable: Math.random() < 0.2,
    },
    tick: (device, elapsedMs) => {
      const on = device.state.on === true
      const brightness = Number(device.state.brightness ?? 0)
      const maxPower = options.power ?? 9
      const power = on ? Number(((brightness / 100) * maxPower + 0.4).toFixed(2)) : 0.3
      const energyTotal = Number((Number(device.state.energyTotal ?? 0) + (power * elapsedMs) / 3_600_000 / 1000).toFixed(5))
      if (power === device.state.power && energyTotal === device.state.energyTotal) return null
      return { power, energyTotal }
    },
  }
}

function plug(nativeId: string, name: string, area: string, load: number): VirtualDevice {
  return {
    nativeId,
    name,
    area,
    category: 'outlet',
    capabilities: ['onoff', 'power', 'energy', 'connectivity', 'identify'],
    manufacturer: 'Sway Virtual',
    model: 'VP-16A',
    state: { on: false, power: 0, voltage: 231, current: 0, energyTotal: Number((Math.random() * 120).toFixed(3)), rssi: -55 },
    tick: (device, elapsedMs) => {
      const on = device.state.on === true
      // A real appliance is never perfectly steady; jitter keeps the charts honest.
      const power = on ? Number((load * (0.92 + Math.random() * 0.16)).toFixed(1)) : 0.2
      const current = Number((power / 231).toFixed(3))
      const energyTotal = Number((Number(device.state.energyTotal ?? 0) + (power * elapsedMs) / 3_600_000 / 1000).toFixed(5))
      return { power, current, energyTotal }
    },
  }
}

function climateSensor(nativeId: string, name: string, area: string, base: number): VirtualDevice {
  return {
    nativeId,
    name,
    area,
    category: 'sensor',
    capabilities: ['temperature', 'humidity', 'battery', 'connectivity'],
    manufacturer: 'Sway Virtual',
    model: 'VS-TH',
    state: { temperature: base, humidity: 45, battery: 70 + Math.round(Math.random() * 25), batteryLow: false, rssi: -62 },
    tick: (device, _elapsed, clock) => {
      // Daily curve: coolest around 05:00, warmest around 16:00.
      const hour = clock.getHours() + clock.getMinutes() / 60
      const daily = Math.sin(((hour - 9) / 24) * 2 * Math.PI) * 1.4
      const drift = (Math.random() - 0.5) * 0.15
      const temperature = Number((base + daily + drift).toFixed(1))
      const humidity = Number(clamp(Number(device.state.humidity ?? 45) + (Math.random() - 0.5) * 1.2, 30, 70).toFixed(0))
      return { temperature, humidity }
    },
  }
}

function motionSensor(nativeId: string, name: string, area: string, activity: number): VirtualDevice {
  return {
    nativeId,
    name,
    area,
    category: 'sensor',
    capabilities: ['motion', 'illuminance', 'battery', 'connectivity'],
    manufacturer: 'Sway Virtual',
    model: 'VS-PIR',
    state: { motion: false, lastMotionAt: null, illuminance: 120, battery: 88, batteryLow: false, rssi: -70 },
    tick: (device, _elapsed, clock) => {
      const hour = clock.getHours()
      // Nobody walks through the hallway at 4am; the odds follow the day.
      const awake = hour >= 7 && hour <= 23 ? 1 : 0.05
      const chance = activity * awake
      const motion = device.state.motion === true
      const next = motion ? Math.random() > 0.55 : Math.random() < chance
      const illuminance = Math.round(clamp(hour >= 8 && hour <= 19 ? 200 + Math.random() * 600 : 2 + Math.random() * 30, 0, 2000))
      if (next === motion && Math.abs(illuminance - Number(device.state.illuminance ?? 0)) < 25) return null
      return { motion: next, illuminance, lastMotionAt: next ? clock.toISOString() : device.state.lastMotionAt }
    },
  }
}

function buildHouse(): VirtualDevice[] {
  const devices: VirtualDevice[] = [
    light('vl-salon-plafond', 'Plafonnier salon', 'Salon', { colour: true, power: 22 }),
    light('vl-salon-lampadaire', 'Lampadaire salon', 'Salon', { colour: true, power: 12 }),
    light('vl-salon-tv', 'Rétroéclairage TV', 'Salon', { colour: true, power: 18 }),
    light('vl-cuisine-plan', 'Plan de travail', 'Cuisine', { power: 14 }),
    light('vl-cuisine-table', 'Suspension table', 'Cuisine', { colour: true, power: 16 }),
    light('vl-chambre-plafond', 'Plafonnier chambre', 'Chambre'),
    light('vl-chambre-chevet-g', 'Chevet gauche', 'Chambre', { colour: true, power: 6 }),
    light('vl-chambre-chevet-d', 'Chevet droit', 'Chambre', { colour: true, power: 6 }),
    light('vl-bureau-bandeau', 'Bandeau bureau', 'Bureau', { colour: true, power: 24 }),
    light('vl-sdb-miroir', 'Miroir salle de bain', 'Salle de bain', { power: 11 }),
    light('vl-entree', 'Applique entrée', 'Entrée'),
    light('vl-jardin-terrasse', 'Terrasse', 'Jardin', { colour: true, power: 30 }),

    plug('vp-machine-cafe', 'Machine à café', 'Cuisine', 1350),
    plug('vp-tv', 'TV salon', 'Salon', 95),
    plug('vp-bureau-setup', 'Setup bureau', 'Bureau', 210),
    plug('vp-lave-linge', 'Lave-linge', 'Salle de bain', 480),

    climateSensor('vs-salon-th', 'Capteur salon', 'Salon', 20.5),
    climateSensor('vs-chambre-th', 'Capteur chambre', 'Chambre', 19),
    climateSensor('vs-exterieur-th', 'Capteur extérieur', 'Jardin', 12),

    motionSensor('vs-entree-pir', 'Détecteur entrée', 'Entrée', 0.08),
    motionSensor('vs-couloir-pir', 'Détecteur couloir', 'Entrée', 0.12),
    motionSensor('vs-bureau-pir', 'Détecteur bureau', 'Bureau', 0.15),

    {
      nativeId: 'vt-salon',
      name: 'Thermostat salon',
      area: 'Salon',
      category: 'climate',
      capabilities: ['thermostat', 'temperature', 'humidity', 'connectivity'],
      manufacturer: 'Sway Virtual',
      model: 'VT-200',
      state: {
        targetTemperature: 20.5,
        currentTemperature: 20.1,
        hvacMode: 'heat',
        hvacAction: 'idle',
        preset: 'comfort',
        temperature: 20.1,
        humidity: 44,
      },
      tick: (device) => {
        const target = Number(device.state.targetTemperature ?? 20)
        const current = Number(device.state.currentTemperature ?? 20)
        const mode = String(device.state.hvacMode ?? 'heat')
        if (mode === 'off') {
          const cooling = Number((current - 0.02).toFixed(2))
          return { currentTemperature: cooling, temperature: cooling, hvacAction: 'off' }
        }
        const delta = target - current
        const action = Math.abs(delta) < 0.15 ? 'idle' : delta > 0 ? 'heating' : 'cooling'
        // Slow approach, so a routine that nudges the set point is visible over minutes.
        const next = Number((current + clamp(delta * 0.08, -0.25, 0.25) + (Math.random() - 0.5) * 0.03).toFixed(2))
        return { currentTemperature: next, temperature: next, hvacAction: action }
      },
    },

    {
      nativeId: 'vc-salon-volet',
      name: 'Volet salon',
      area: 'Salon',
      category: 'cover',
      capabilities: ['position', 'tilt', 'connectivity'],
      manufacturer: 'Sway Virtual',
      model: 'VC-Roll',
      state: { position: 100, tilt: 50, moving: 'idle' },
    },
    {
      nativeId: 'vc-chambre-volet',
      name: 'Volet chambre',
      area: 'Chambre',
      category: 'cover',
      capabilities: ['position', 'connectivity'],
      manufacturer: 'Sway Virtual',
      model: 'VC-Roll',
      state: { position: 0, moving: 'idle' },
    },

    {
      nativeId: 'vlk-entree',
      name: 'Serrure entrée',
      area: 'Entrée',
      category: 'lock',
      capabilities: ['lock', 'battery', 'connectivity'],
      manufacturer: 'Sway Virtual',
      model: 'VL-Bolt',
      state: { locked: true, jammed: false, lastActor: null, battery: 64, batteryLow: false },
    },
    {
      nativeId: 'vd-entree',
      name: 'Capteur porte entrée',
      area: 'Entrée',
      category: 'sensor',
      capabilities: ['contact', 'battery'],
      manufacturer: 'Sway Virtual',
      model: 'VS-Contact',
      state: { open: false, lastChangedAt: null, battery: 91, batteryLow: false },
    },
    {
      nativeId: 'vd-fenetre-chambre',
      name: 'Fenêtre chambre',
      area: 'Chambre',
      category: 'sensor',
      capabilities: ['contact', 'battery'],
      manufacturer: 'Sway Virtual',
      model: 'VS-Contact',
      state: { open: false, lastChangedAt: null, battery: 77, batteryLow: false },
    },

    {
      nativeId: 'vm-salon-enceinte',
      name: 'Enceinte salon',
      area: 'Salon',
      category: 'speaker',
      capabilities: ['mediaPlayback', 'volume', 'mediaSource', 'speech', 'notify'],
      manufacturer: 'Sway Virtual',
      model: 'VM-Sound',
      state: {
        playback: 'stopped',
        volume: 28,
        muted: false,
        title: null,
        artist: null,
        album: null,
        source: 'Spotify',
        availableSources: ['Spotify', 'Radio', 'Bluetooth', 'AirPlay', 'Ligne'],
        speaking: false,
      },
      tick: (device) => {
        if (device.state.playback !== 'playing') return null
        const position = Number(device.state.positionSeconds ?? 0) + 2
        const duration = Number(device.state.durationSeconds ?? 210)
        if (position >= duration) return { playback: 'stopped', positionSeconds: 0 }
        return { positionSeconds: position }
      },
    },
    {
      nativeId: 'vm-salon-tv',
      name: 'TV salon',
      area: 'Salon',
      category: 'display',
      capabilities: ['onoff', 'mediaPlayback', 'volume', 'mediaSource'],
      manufacturer: 'Sway Virtual',
      model: 'VM-Screen 55',
      state: { on: false, playback: 'idle', volume: 14, muted: false, source: 'HDMI 1', availableSources: ['HDMI 1', 'HDMI 2', 'Netflix', 'YouTube', 'TNT'] },
    },

    {
      nativeId: 'va-lave-linge',
      name: 'Lave-linge',
      area: 'Salle de bain',
      category: 'appliance',
      capabilities: ['appliance', 'power', 'energy', 'notify'],
      manufacturer: 'Sway Virtual',
      model: 'VA-Wash',
      state: { operationalState: 'stopped', program: 'Coton 40', remainingSeconds: null, doorOpen: false, power: 0, energyTotal: 82.4 },
      tick: (device, elapsedMs) => {
        if (device.state.operationalState !== 'running') return null
        const remaining = Math.max(0, Number(device.state.remainingSeconds ?? 0) - elapsedMs / 1000)
        const power = remaining > 0 ? Number((120 + Math.random() * 900).toFixed(0)) : 0
        if (remaining <= 0) return { operationalState: 'finished', remainingSeconds: 0, power: 0 }
        return { remainingSeconds: Math.round(remaining), power }
      },
    },
    {
      nativeId: 'vv-robot',
      name: 'Aspirateur',
      area: 'Salon',
      category: 'vacuum',
      capabilities: ['vacuum', 'battery'],
      manufacturer: 'Sway Virtual',
      model: 'VV-Roomy',
      state: { vacuumState: 'docked', fanPower: 60, areas: [...AREAS], battery: 100, batteryLow: false },
      tick: (device) => {
        const state = String(device.state.vacuumState)
        const battery = Number(device.state.battery ?? 100)
        if (state === 'cleaning') {
          const next = Math.max(0, battery - 0.4)
          if (next < 15) return { vacuumState: 'returning', battery: Number(next.toFixed(1)) }
          return { battery: Number(next.toFixed(1)) }
        }
        if (state === 'returning') return { vacuumState: 'docked' }
        if (state === 'docked' && battery < 100) return { battery: Number(Math.min(100, battery + 1.2).toFixed(1)) }
        return null
      },
    },

    {
      nativeId: 'vq-air',
      name: 'Qualité de l air',
      area: 'Salon',
      category: 'sensor',
      capabilities: ['airQuality', 'temperature', 'humidity'],
      manufacturer: 'Sway Virtual',
      model: 'VS-Air',
      state: { airQuality: 'good', co2: 610, pm25: 7, voc: 120, temperature: 20.4, humidity: 46 },
      tick: (device) => {
        const co2 = Math.round(clamp(Number(device.state.co2 ?? 600) + (Math.random() - 0.45) * 40, 400, 2000))
        const pm25 = Number(clamp(Number(device.state.pm25 ?? 7) + (Math.random() - 0.5) * 1.5, 0, 90).toFixed(1))
        const quality = co2 > 1400 || pm25 > 35 ? 'poor' : co2 > 1000 || pm25 > 20 ? 'moderate' : co2 > 800 ? 'fair' : 'good'
        return { co2, pm25, airQuality: quality }
      },
    },
    {
      nativeId: 'vs-fuite-cuisine',
      name: 'Détecteur de fuite',
      area: 'Cuisine',
      category: 'sensor',
      capabilities: ['waterLeak', 'battery'],
      manufacturer: 'Sway Virtual',
      model: 'VS-Leak',
      state: { leak: false, battery: 95, batteryLow: false },
    },
    {
      nativeId: 'vs-fumee-cuisine',
      name: 'Détecteur de fumée',
      area: 'Cuisine',
      category: 'sensor',
      capabilities: ['smoke', 'battery'],
      manufacturer: 'Sway Virtual',
      model: 'VS-Smoke',
      state: { smoke: false, testing: false, battery: 82, batteryLow: false },
    },
    {
      nativeId: 'vcam-entree',
      name: 'Caméra entrée',
      area: 'Entrée',
      category: 'camera',
      capabilities: ['camera', 'motion', 'doorbell'],
      manufacturer: 'Sway Virtual',
      model: 'VC-Eye',
      state: { streaming: false, recording: false, motion: false, snapshotUrl: '/api/cameras/virtual/vcam-entree/snapshot', streamUrl: null, lastRingAt: null },
    },
    {
      nativeId: 'vb-bouton-salon',
      name: 'Bouton salon',
      area: 'Salon',
      category: 'sensor',
      capabilities: ['button', 'battery'],
      manufacturer: 'Sway Virtual',
      model: 'VS-Button',
      state: { lastEvent: null, lastEventAt: null, buttonIndex: 0, battery: 99, batteryLow: false },
    },
  ]

  return devices
}

export class VirtualAdapter implements ProtocolAdapter {
  readonly descriptor: AdapterDescriptor = {
    id: 'virtual',
    name: 'Virtual house',
    vendor: 'Sway',
    transports: ['virtual'],
    capabilities: [
      'onoff', 'brightness', 'colorTemperature', 'color', 'effect', 'position', 'tilt', 'thermostat',
      'lock', 'contact', 'motion', 'temperature', 'humidity', 'illuminance', 'airQuality', 'waterLeak',
      'smoke', 'battery', 'power', 'energy', 'mediaPlayback', 'volume', 'mediaSource', 'speech',
      'camera', 'doorbell', 'button', 'vacuum', 'appliance', 'identify', 'connectivity', 'firmware', 'notify',
    ],
    zeroConfig: true,
    cloud: false,
    implemented: true,
    docsUrl: '/docs/adapters/virtual',
    configSchema: [
      { key: 'enabled', label: 'Simulate a house', type: 'boolean', default: true, help: 'Adds a full flat of simulated devices so the hub can be used and tested with no hardware.' },
      { key: 'speed', label: 'Simulation speed', type: 'number', default: 1, help: 'Multiplies how fast simulated sensors drift. 1 is real time.' },
    ],
  }

  #context: AdapterContext | null = null
  #devices = new Map<string, VirtualDevice>()
  #timer: ReturnType<typeof setInterval> | null = null
  #lastTick = Date.now()
  #speed = 1
  #transitions = new Map<string, ReturnType<typeof setInterval>>()

  async init(context: AdapterContext, config: Record<string, unknown>): Promise<void> {
    this.#context = context
    this.#speed = Number(config.speed ?? 1) || 1
    for (const device of buildHouse()) this.#devices.set(device.nativeId, device)

    this.#lastTick = Date.now()
    this.#timer = setInterval(() => this.#tick(), 2000)
    context.log('info', `virtual house ready with ${this.#devices.size} devices`)
  }

  async discover(_hosts: NetworkHost[]): Promise<DiscoveredDevice[]> {
    return [...this.#devices.values()].map((device) => ({
      adapterId: 'virtual',
      nativeId: device.nativeId,
      uid: `virtual:${device.nativeId}`,
      name: device.name,
      category: device.category,
      capabilities: device.capabilities,
      transport: 'virtual' as const,
      manufacturer: device.manufacturer,
      model: device.model,
      firmwareVersion: String(device.state.firmwareVersion ?? '1.0.0'),
      confidence: 1,
      meta: { simulated: true, suggestedArea: device.area },
    }))
  }

  async getState(nativeId: string): Promise<Record<string, unknown>> {
    return { ...(this.#devices.get(nativeId)?.state ?? {}) }
  }

  /** A simulated camera has no sensor: it draws its name, the time, and a red dot while it sees movement. */
  async snapshot(nativeId: string): Promise<{ contentType: string; body: Uint8Array } | null> {
    const device = this.#devices.get(nativeId)
    if (!device?.capabilities.includes('camera')) return null
    const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">' +
      '<rect width="640" height="360" fill="#1f2937"/>' +
      `<text x="24" y="44" fill="#e5e7eb" font-family="sans-serif" font-size="22">${encodeXml(device.name)}</text>` +
      `<text x="24" y="330" fill="#9ca3af" font-family="monospace" font-size="18">${time} | caméra simulée</text>` +
      (device.state.motion === true ? '<circle cx="610" cy="36" r="10" fill="#ef4444"/>' : '') +
      '</svg>'
    return { contentType: 'image/svg+xml', body: new TextEncoder().encode(svg) }
  }

  async execute(nativeId: string, command: string, args: Record<string, unknown>): Promise<CommandResult> {
    const started = performance.now()
    const device = this.#devices.get(nativeId)
    if (!device) return { ok: false, deviceId: nativeId, command, error: 'Unknown virtual device' }

    const before = { ...device.state }
    const patch = this.#apply(device, command, args)
    if (patch === null) {
      return { ok: false, deviceId: nativeId, command, error: `Virtual device does not support ${command}` }
    }

    // A real bulb takes a moment; simulating that keeps optimistic UI honest.
    const transitionMs = Number(args.transitionMs ?? 0)
    if (transitionMs > 0 && typeof patch.brightness === 'number') {
      this.#fade(device, Number(before.brightness ?? 0), patch.brightness, transitionMs)
    }

    device.state = { ...device.state, ...patch }
    this.#context?.emitState(nativeId, patch)

    return {
      ok: true,
      deviceId: nativeId,
      command,
      state: patch,
      latencyMs: Math.round(performance.now() - started),
      undo: this.#undoFor(command, before),
    }
  }

  #apply(device: VirtualDevice, command: string, args: Record<string, unknown>): Record<string, unknown> | null {
    const has = (capability: CapabilityId) => device.capabilities.includes(capability)

    switch (command) {
      case 'turnOn':
        return has('onoff') ? { on: true } : null
      case 'turnOff':
        return has('onoff') ? { on: false } : null
      case 'toggle':
        return has('onoff') ? { on: device.state.on !== true } : null
      case 'setBrightness':
        return has('brightness') ? { brightness: clamp(Number(args.brightness ?? 0), 0, 100), on: Number(args.brightness ?? 0) > 0 } : null
      case 'stepBrightness':
        return has('brightness') ? { brightness: clamp(Number(device.state.brightness ?? 0) + Number(args.delta ?? 0), 0, 100) } : null
      case 'setColorTemperature':
        return has('colorTemperature') ? { colorTemperature: clamp(Number(args.kelvin ?? 2700), 1500, 6500), on: true } : null
      case 'setColor':
        return has('color') ? { hue: clamp(Number(args.hue ?? 0), 0, 360), saturation: clamp(Number(args.saturation ?? 0), 0, 100), on: true } : null
      case 'setColorRgb': {
        if (!has('color')) return null
        const { hue, saturation } = rgbToHueSaturation(Number(args.r ?? 0), Number(args.g ?? 0), Number(args.b ?? 0))
        return { hue, saturation, on: true }
      }
      case 'setColorName': {
        if (!has('color')) return null
        const resolved = NAMED_COLOURS[String(args.name ?? '').toLowerCase()]
        if (!resolved) return null
        return { hue: resolved[0], saturation: resolved[1], on: true }
      }
      case 'setEffect':
        return has('effect') ? { effect: String(args.effect ?? ''), on: true } : null
      case 'clearEffect':
        return has('effect') ? { effect: null } : null

      case 'open':
        return has('position') ? { position: 100, moving: 'idle' } : has('valve') ? { valveOpen: true } : null
      case 'close':
        return has('position') ? { position: 0, moving: 'idle' } : has('valve') ? { valveOpen: false } : null
      case 'stop':
        return has('position') ? { moving: 'idle' } : null
      case 'setPosition':
        return has('position') ? { position: clamp(Number(args.position ?? 0), 0, 100), moving: 'idle' } : null
      case 'setTilt':
        return has('tilt') ? { tilt: clamp(Number(args.tilt ?? 0), 0, 100) } : null

      case 'setTargetTemperature':
        return has('thermostat') ? { targetTemperature: clamp(Number(args.celsius ?? 20), 5, 35) } : null
      case 'setHvacMode':
        return has('thermostat') ? { hvacMode: String(args.mode ?? 'heat') } : null
      case 'setPreset': {
        if (!has('thermostat')) return null
        const preset = String(args.preset ?? 'comfort')
        const targets: Record<string, number> = { eco: 17, comfort: 20.5, boost: 23, away: 15, sleep: 18.5 }
        return { preset, targetTemperature: targets[preset] ?? Number(device.state.targetTemperature ?? 20) }
      }
      case 'boost':
        return has('thermostat') ? { targetTemperature: 23, preset: 'boost' } : null

      case 'lock':
        return has('lock') ? { locked: true, lastActor: 'hub' } : null
      case 'unlock':
        return has('lock') ? { locked: false, lastActor: 'hub' } : null

      case 'play':
        return has('mediaPlayback')
          ? { playback: 'playing', title: device.state.title ?? 'Titre de démonstration', artist: device.state.artist ?? 'Sway Virtual', durationSeconds: 214, positionSeconds: Number(device.state.positionSeconds ?? 0) }
          : null
      case 'pause':
        return has('mediaPlayback') ? { playback: 'paused' } : null
      case 'stopPlayback':
        return has('mediaPlayback') ? { playback: 'stopped', positionSeconds: 0 } : null
      case 'next':
        return has('mediaPlayback') ? { title: `Titre ${Math.floor(Math.random() * 90) + 1}`, positionSeconds: 0, playback: 'playing' } : null
      case 'previous':
        return has('mediaPlayback') ? { positionSeconds: 0, playback: 'playing' } : null
      case 'seek':
        return has('mediaPlayback') ? { positionSeconds: Math.max(0, Number(args.positionSeconds ?? 0)) } : null
      case 'playMedia':
        return has('mediaPlayback') ? { playback: 'playing', title: String(args.query ?? 'Lecture'), artist: 'Sway Virtual', durationSeconds: 214, positionSeconds: 0 } : null
      case 'setVolume':
        return has('volume') ? { volume: clamp(Number(args.volume ?? 0), 0, 100) } : null
      case 'stepVolume':
        return has('volume') ? { volume: clamp(Number(device.state.volume ?? 0) + Number(args.delta ?? 0), 0, 100) } : null
      case 'setMuted':
        return has('volume') ? { muted: args.muted === true } : null
      case 'setSource':
        return has('mediaSource') ? { source: String(args.source ?? '') } : null
      case 'speak': {
        if (!has('speech')) return null
        const text = String(args.text ?? '')
        this.#context?.emitEvent(device.nativeId, 'spoke', { text })
        setTimeout(() => {
          this.#devices.get(device.nativeId)!.state.speaking = false
          this.#context?.emitState(device.nativeId, { speaking: false })
        }, Math.min(8000, 400 + text.length * 55))
        return { speaking: true }
      }
      case 'notify':
        this.#context?.emitEvent(device.nativeId, 'notified', { message: String(args.message ?? '') })
        return {}

      case 'startCleaning':
        return has('vacuum') ? { vacuumState: 'cleaning' } : null
      case 'pauseCleaning':
        return has('vacuum') ? { vacuumState: 'paused' } : null
      case 'returnToDock':
        return has('vacuum') ? { vacuumState: 'returning' } : null
      case 'locateVacuum':
        this.#context?.emitEvent(device.nativeId, 'located', {})
        return {}

      case 'startProgram':
        return has('appliance') ? { operationalState: 'running', program: String(args.program ?? device.state.program ?? 'Coton 40'), remainingSeconds: 5400 } : null
      case 'pauseProgram':
        return has('appliance') ? { operationalState: 'paused' } : null
      case 'stopProgram':
        return has('appliance') ? { operationalState: 'stopped', remainingSeconds: null, power: 0 } : null

      case 'snapshot':
        return has('camera') ? { snapshotUrl: `/api/cameras/virtual/${encodeURIComponent(device.nativeId)}/snapshot?t=${Date.now()}` } : null
      case 'startRecording':
        return has('camera') ? { recording: true } : null
      case 'stopRecording':
        return has('camera') ? { recording: false } : null

      case 'identify':
        this.#context?.emitEvent(device.nativeId, 'identify', {})
        setTimeout(() => this.#context?.emitState(device.nativeId, { identifying: false }), 3000)
        return { identifying: true }

      case 'installUpdate':
        setTimeout(() => this.#context?.emitState(device.nativeId, { updateAvailable: false, firmwareVersion: '1.5.0' }), 4000)
        return {}

      case 'resetEnergy':
        return has('energy') ? { energyTotal: 0 } : null

      default:
        return null
    }
  }

  #undoFor(command: string, before: Record<string, unknown>): CommandResult['undo'] {
    switch (command) {
      case 'turnOn':
      case 'turnOff':
      case 'toggle':
        return { command: before.on === true ? 'turnOn' : 'turnOff', args: {} }
      case 'setBrightness':
      case 'stepBrightness':
        return { command: 'setBrightness', args: { brightness: Number(before.brightness ?? 0) } }
      case 'setColorTemperature':
        return { command: 'setColorTemperature', args: { kelvin: Number(before.colorTemperature ?? 2700) } }
      case 'setColor':
      case 'setColorRgb':
      case 'setColorName':
        return { command: 'setColor', args: { hue: Number(before.hue ?? 0), saturation: Number(before.saturation ?? 0) } }
      case 'setPosition':
      case 'open':
      case 'close':
        return { command: 'setPosition', args: { position: Number(before.position ?? 0) } }
      case 'setTargetTemperature':
      case 'boost':
      case 'setPreset':
        return { command: 'setTargetTemperature', args: { celsius: Number(before.targetTemperature ?? 20) } }
      case 'lock':
      case 'unlock':
        return { command: before.locked === true ? 'lock' : 'unlock', args: {} }
      case 'setVolume':
      case 'stepVolume':
        return { command: 'setVolume', args: { volume: Number(before.volume ?? 0) } }
      case 'setSource':
        return { command: 'setSource', args: { source: String(before.source ?? '') } }
      default:
        return null
    }
  }

  #fade(device: VirtualDevice, from: number, to: number, durationMs: number): void {
    const existing = this.#transitions.get(device.nativeId)
    if (existing) clearInterval(existing)

    const steps = Math.max(2, Math.min(20, Math.round(durationMs / 80)))
    let step = 0
    const timer = setInterval(() => {
      step += 1
      const value = Math.round(from + ((to - from) * step) / steps)
      device.state.brightness = value
      this.#context?.emitState(device.nativeId, { brightness: value })
      if (step >= steps) {
        clearInterval(timer)
        this.#transitions.delete(device.nativeId)
      }
    }, durationMs / steps)
    this.#transitions.set(device.nativeId, timer)
  }

  #tick(): void {
    const now = Date.now()
    const elapsed = (now - this.#lastTick) * this.#speed
    this.#lastTick = now
    const clock = new Date()

    for (const device of this.#devices.values()) {
      if (!device.tick) continue
      const patch = device.tick(device, elapsed, clock)
      if (!patch) continue
      device.state = { ...device.state, ...patch }
      this.#context?.emitState(device.nativeId, patch)

      if (patch.operationalState === 'finished') {
        this.#context?.emitEvent(device.nativeId, 'program_finished', { program: device.state.program })
      }
      if (patch.motion === true) {
        this.#context?.emitEvent(device.nativeId, 'motion_started', {})
      }
    }
  }

  status(): AdapterStatus {
    return {
      health: this.#devices.size > 0 ? 'ok' : 'disabled',
      deviceCount: this.#devices.size,
      message: `${this.#devices.size} simulated devices`,
    }
  }

  async shutdown(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    for (const timer of this.#transitions.values()) clearInterval(timer)
    this.#transitions.clear()
    this.#devices.clear()
  }

  /** Test hooks: force an event the simulation would otherwise produce rarely. */
  trigger(nativeId: string, event: 'motion' | 'doorbell' | 'leak' | 'smoke' | 'button' | 'contact'): boolean {
    const device = this.#devices.get(nativeId)
    if (!device) return false
    const now = new Date().toISOString()
    const patches: Record<string, Record<string, unknown>> = {
      motion: { motion: true, lastMotionAt: now },
      doorbell: { lastRingAt: now },
      leak: { leak: true },
      smoke: { smoke: true },
      button: { lastEvent: 'single', lastEventAt: now },
      contact: { open: device.state.open !== true, lastChangedAt: now },
    }
    const patch = patches[event]
    if (!patch) return false
    device.state = { ...device.state, ...patch }
    this.#context?.emitState(nativeId, patch)
    this.#context?.emitEvent(nativeId, event, {})

    // A simulated leak that never dries leaves the demo house permanently in alarm and every
    // watchdog re-raising it forever. Real detectors clear themselves; so does this one.
    const clears: Record<string, Record<string, unknown>> = {
      leak: { leak: false },
      smoke: { smoke: false },
      motion: { motion: false },
    }
    const clear = clears[event]
    if (clear) {
      setTimeout(() => {
        const current = this.#devices.get(nativeId)
        if (!current) return
        current.state = { ...current.state, ...clear }
        this.#context?.emitState(nativeId, clear)
      }, 90_000)
    }

    return true
  }

  /** The colour a UI should paint for a simulated light, so the house map looks real. */
  static renderColour(state: Record<string, unknown>): [number, number, number] {
    if (typeof state.hue === 'number' && typeof state.saturation === 'number' && state.saturation > 5) {
      return hsToRgb(state.hue, state.saturation, Number(state.brightness ?? 100))
    }
    return kelvinToRgb(Number(state.colorTemperature ?? 2700))
  }
}


function rgbToHueSaturation(r: number, g: number, b: number): { hue: number; saturation: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min
  let hue = 0
  if (delta !== 0) {
    if (max === rn) hue = 60 * (((gn - bn) / delta) % 6)
    else if (max === gn) hue = 60 * ((bn - rn) / delta + 2)
    else hue = 60 * ((rn - gn) / delta + 4)
  }
  if (hue < 0) hue += 360
  return { hue: Math.round(hue), saturation: Math.round((max === 0 ? 0 : delta / max) * 100) }
}
