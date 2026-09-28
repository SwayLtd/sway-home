/**
 * The hub client, and the single store the whole console reads from.
 *
 * One design decision runs through this file: **the server is the source of truth and the
 * event stream is how it talks**. There is no client-side cache invalidation strategy, no
 * refetch-on-focus, no polling loop. The hub pushes every state change over SSE, the store
 * applies it, and every screen is reactive to the same objects. A light toggled from the
 * phone, from a routine or from the agent updates this console within milliseconds, and the
 * code that makes that true is the twenty lines of `applyEvent` below.
 */

import type { Ref } from 'vue'
import { AREA_ICON as SHARED_AREA_ICON, CATEGORY_ICON as SHARED_CATEGORY_ICON } from '@sway-home/shared/icons'

export interface Device {
  id: string
  uid: string
  name: string
  aliases: string[]
  category: string
  capabilities: string[]
  endpoints: { id: string; index: number; name: string; category: string; capabilities: string[]; state: Record<string, unknown> }[]
  manufacturer: string | null
  model: string | null
  firmwareVersion: string | null
  adapterId: string
  nativeId: string
  transport: string
  areaId: string | null
  online: boolean
  reachableVia: string
  lastSeenAt: string | null
  state: Record<string, any>
  identificationConfidence: string
  notes: string | null
  favourite: boolean
  hidden: boolean
  critical: boolean
  network: { ip: string | null; mac: string | null; hostname: string | null; macVendor: string | null; openPorts: number[]; mdnsServices: string[] }
  createdAt: string
  updatedAt: string
}

export interface Area {
  id: string
  name: string
  kind: string
  floorId: string | null
  icon: string | null
  deviceCount?: number
}

export interface HouseEvent {
  id: string
  type: string
  at: string
  subjectType: string
  subjectId: string | null
  origin: string
  originDetail: string | null
  payload: Record<string, any>
  correlationId: string | null
  severity: string
}

export interface HouseSnapshot {
  mode: string
  devices: Device[]
  areas: Area[]
  counts: { total: number; online: number; byCategory: Record<string, number>; byAdapter: Record<string, number> }
  openAlerts: { id: string; kind: string; severity: string; title: string; detail: string | null; subjectId: string | null; raisedAt: string }[]
  power: { total: number; byArea: Record<string, number> }
  climate: { area: string; temperature: number | null; humidity: number | null }[]
  security: { locksUnlocked: string[]; openContacts: string[]; leaks: string[]; smoke: string[] }
  lightsOn: string[]
  mediaPlaying: string[]
  batteriesLow: { name: string; battery: number }[]
  offline: string[]
  suggestions: number
  pendingProposals: number
  undoAvailable: boolean
  scan: ScanState
}

export interface ScanState {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  durationMs: number
  hostCount: number
  newDevices: number
  updatedDevices: number
  phase: { phase: string; done: number; total: number; found: number; message?: string } | null
  error: string | null
}

function hubBase(): string {
  // In development the Nuxt dev server proxies `/api` to the hub, so a relative path works
  // in the browser and an absolute one works during server rendering.
  if (import.meta.client) return '/api'
  return `${useRuntimeConfig().public.hubUrl}/api`
}

export async function hubFetch<T>(path: string, options: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}): Promise<T> {
  return $fetch<T>(`${hubBase()}${path}`, {
    method: (options.method ?? 'GET') as never,
    body: options.body as never,
    query: options.query as never,
  })
}

// ---------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------

export function useHouse() {
  const house = useState<HouseSnapshot | null>('house', () => null)
  const devices = useState<Device[]>('devices', () => [])
  const areas = useState<Area[]>('areas', () => [])
  const events = useState<HouseEvent[]>('events', () => [])
  const connected = useState<boolean>('stream-connected', () => false)
  const loading = useState<boolean>('house-loading', () => false)
  const failed = useState<string | null>('house-failed', () => null)

  // Live-only state the stream also carries: what the hub is busy with, and a recording.
  const tasks = useState<HubTask[]>('hub-tasks', () => [])
  const teachStatus = useState<TeachStatus>('hub-teach', () => ({ ...TEACH_IDLE }))

  const deviceById = computed(() => new Map(devices.value.map((device) => [device.id, device])))
  const areaById = computed(() => new Map(areas.value.map((area) => [area.id, area])))

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const [snapshot, areaPayload] = await Promise.all([
        hubFetch<HouseSnapshot>('/house'),
        hubFetch<{ areas: Area[]; floors: unknown[] }>('/areas'),
      ])
      house.value = snapshot
      devices.value = snapshot.devices
      areas.value = areaPayload.areas
      failed.value = null
    } catch (error) {
      // A failed load is not an empty house: keep the last good data and say what broke.
      failed.value = (error as Error).message
    } finally {
      loading.value = false
    }
  }

  /**
   * The whole reactivity story. An event arrives, the matching object is patched in place,
   * and every component holding a reference re-renders. No refetch, no invalidation.
   */
  function applyEvent(event: HouseEvent): void {
    // A task reports every step and a recording every gesture: state, not history, so they
    // update their own store and stay out of the activity feed.
    if (event.type === 'task.updated') {
      tasks.value = upsertTask(tasks.value, event.payload as HubTask)
      return
    }
    if (event.type === 'teach.updated') {
      teachStatus.value = event.payload as TeachStatus
      return
    }

    events.value = [event, ...events.value].slice(0, 300)

    switch (event.type) {
      case 'device.state_changed': {
        const device = deviceById.value.get(String(event.payload.deviceId))
        if (!device) break
        Object.assign(device.state, event.payload.changes as Record<string, unknown>)
        device.updatedAt = event.at
        break
      }
      case 'device.online':
      case 'device.offline': {
        const device = event.subjectId ? deviceById.value.get(event.subjectId) : null
        if (device) device.online = event.type === 'device.online'
        break
      }
      case 'device.added':
      case 'device.removed':
      case 'device.updated':
        void refresh()
        break
      case 'house.mode_changed':
        if (house.value) house.value.mode = String(event.payload.mode)
        break
      case 'scan.progress':
        if (house.value) house.value.scan = { ...house.value.scan, running: true, phase: event.payload as never, hostCount: Number(event.payload.found ?? 0) }
        break
      case 'scan.finished':
        void refresh()
        break
      case 'alert.raised':
      case 'alert.cleared':
      case 'automation.suggested':
      case 'agent.action_proposed':
        void refresh()
        break
      default:
        break
    }
  }

  return { house, devices, areas, events, connected, loading, failed, deviceById, areaById, refresh, applyEvent }
}

// ---------------------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------------------

export function useHubStream(): { connected: Ref<boolean> } {
  const { applyEvent, connected } = useHouse()

  onMounted(() => {
    if (!import.meta.client) return

    let source: EventSource | null = null
    let retryDelay = 1000

    const connect = () => {
      source = new EventSource(`${hubBase()}/stream`)

      source.onopen = () => {
        connected.value = true
        retryDelay = 1000
      }

      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as HouseEvent
          if (event.type === 'stream.ready') return
          applyEvent(event)
        } catch {
          // A partial frame is normal when the hub restarts mid-write.
        }
      }

      source.onerror = () => {
        connected.value = false
        source?.close()
        // Back off, but never past five seconds: this is a LAN service, not the internet.
        setTimeout(connect, retryDelay)
        retryDelay = Math.min(5000, retryDelay * 1.6)
      }
    }

    connect()
    onBeforeUnmount(() => source?.close())
  })

  return { connected }
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

export function useCommands() {
  const { deviceById } = useHouse()
  const pending = useState<Set<string>>('pending-commands', () => new Set())

  async function send(deviceId: string, command: string, args: Record<string, unknown> = {}): Promise<boolean> {
    const key = `${deviceId}:${command}`
    pending.value = new Set([...pending.value, key])

    // Optimistic: the control must answer the finger immediately. The event stream either
    // confirms it a few milliseconds later, or the catch below puts it back.
    const device = deviceById.value.get(deviceId)
    const before = device ? { ...device.state } : null
    if (device) Object.assign(device.state, optimisticState(command, args, device.state))

    try {
      const result = await hubFetch<{ ok: boolean; error?: string; state?: Record<string, unknown> }>(`/devices/${deviceId}/command`, {
        method: 'POST',
        body: { command, args },
      })
      if (!result.ok && device && before) device.state = before
      return result.ok
    } catch {
      if (device && before) device.state = before
      return false
    } finally {
      const next = new Set(pending.value)
      next.delete(key)
      pending.value = next
    }
  }

  async function sendMany(selector: Record<string, unknown>, command: string, args: Record<string, unknown> = {}): Promise<boolean> {
    const result = await hubFetch<{ ok: boolean }>('/devices/command', { method: 'POST', body: { ...selector, command, args } })
    return result.ok
  }

  function isPending(deviceId: string, command: string): boolean {
    return pending.value.has(`${deviceId}:${command}`)
  }

  return { send, sendMany, isPending }
}

function optimisticState(command: string, args: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  switch (command) {
    case 'turnOn':
      return { on: true }
    case 'turnOff':
      return { on: false }
    case 'toggle':
      return { on: current.on !== true }
    case 'setBrightness':
      return { brightness: Number(args.brightness ?? 0), on: Number(args.brightness ?? 0) > 0 }
    case 'setColorTemperature':
      return { colorTemperature: Number(args.kelvin ?? 2700), on: true }
    case 'setColor':
      return { hue: Number(args.hue ?? 0), saturation: Number(args.saturation ?? 0), on: true }
    case 'setPosition':
      return { position: Number(args.position ?? 0) }
    case 'setTargetTemperature':
      return { targetTemperature: Number(args.celsius ?? 20) }
    case 'lock':
      return { locked: true }
    case 'unlock':
      return { locked: false }
    case 'setVolume':
      return { volume: Number(args.volume ?? 0) }
    case 'play':
      return { playback: 'playing' }
    case 'pause':
      return { playback: 'paused' }
    default:
      return {}
  }
}

// ---------------------------------------------------------------------------------------
// Display helpers, shared so a light reads the same on every screen
// ---------------------------------------------------------------------------------------

// The maps live in the shared package so the hub can put the same icon in a sentence.
export const CATEGORY_ICON = SHARED_CATEGORY_ICON
export const AREA_ICON = SHARED_AREA_ICON

/** The colour a light is actually making, so the UI shows the room rather than a checkbox. */
export function lightColour(state: Record<string, any>): string {
  if (state.on !== true) return 'transparent'
  if (typeof state.hue === 'number' && typeof state.saturation === 'number' && state.saturation > 5) {
    return `hsl(${state.hue} ${state.saturation}% ${Math.max(35, Math.min(70, Number(state.brightness ?? 80) * 0.6 + 20))}%)`
  }
  const kelvin = Number(state.colorTemperature ?? 2700)
  const warm = Math.max(0, Math.min(1, (6500 - kelvin) / 4000))
  return `hsl(${38 + (1 - warm) * 20} ${20 + warm * 60}% ${Math.max(40, Math.min(75, Number(state.brightness ?? 80) * 0.5 + 30))}%)`
}

/** One line that says what a device is doing. Used in lists, cards and the agent chat. */
export function stateSummary(device: Device): string {
  const state = device.state
  const bits: string[] = []

  if (typeof state.on === 'boolean') bits.push(state.on ? 'Allumé' : 'Éteint')
  if (state.on && typeof state.brightness === 'number') bits.push(`${Math.round(state.brightness)} %`)
  if (typeof state.temperature === 'number') bits.push(`${state.temperature.toFixed(1)} °C`)
  if (typeof state.targetTemperature === 'number') bits.push(`cible ${state.targetTemperature} °C`)
  if (typeof state.humidity === 'number') bits.push(`${Math.round(state.humidity)} %HR`)
  if (typeof state.position === 'number') bits.push(state.position === 0 ? 'Fermé' : state.position === 100 ? 'Ouvert' : `${state.position} %`)
  if (typeof state.locked === 'boolean') bits.push(state.locked ? 'Verrouillé' : 'Déverrouillé')
  if (typeof state.open === 'boolean') bits.push(state.open ? 'Ouvert' : 'Fermé')
  if (state.motion === true) bits.push('Mouvement')
  if (typeof state.playback === 'string' && state.playback !== 'idle') {
    bits.push(state.playback === 'playing' ? 'Lecture' : state.playback === 'paused' ? 'En pause' : 'Arrêté')
  }
  if (typeof state.power === 'number' && state.power >= 1) bits.push(`${Math.round(state.power)} W`)
  if (typeof state.battery === 'number' && state.battery <= 30) bits.push(`batterie ${Math.round(state.battery)} %`)
  if (typeof state.vacuumState === 'string') bits.push(String(state.vacuumState))
  if (typeof state.operationalState === 'string' && state.operationalState !== 'stopped') bits.push(String(state.operationalState))

  if (!device.online) return 'Hors ligne'
  return bits.slice(0, 3).join(' · ') || '-'
}

export function formatRelative(iso: string | null): string {
  if (!iso) return 'jamais'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 10) return "à l'instant"
  if (seconds < 60) return `il y a ${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  return `il y a ${Math.round(hours / 24)} j`
}
