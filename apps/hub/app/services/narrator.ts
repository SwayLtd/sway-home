/**
 * The part that speaks first.
 *
 * A house assistant that only answers is a remote control with a text box. What makes it
 * feel like someone in the house is that it says "il y a une fuite sous l'évier" before
 * being asked. This service watches the event bus and turns the few things worth
 * interrupting for into one French sentence.
 *
 * Three rules govern everything here, and they are the difference between an assistant and
 * a nuisance:
 *
 *  1. **Silence is the default.** Only the listed event kinds ever produce a sentence. A
 *     light turning on is not news.
 *  2. **Never twice.** Every announcement carries a dedupe key and a repeat window. The same
 *     low battery is mentioned once a day, not once per poll.
 *  3. **Quiet hours win.** Between the configured hours nothing is spoken out loud; critical
 *     safety events still appear on screen, because a water leak at 3 am is exactly what the
 *     thing is for, but it does not talk to an empty room.
 */

import type { HouseEvent } from '@sway-home/shared'
import { deviceRepository } from '#repositories/device_repository'
import { alerts, people, places, settings } from '#repositories/store'
import { announcements } from '#repositories/widget_repository'
import { bus } from '#services/event_bus'
import { insightEngine } from '#services/insight_engine'

interface Proactivity {
  suggestRoutines?: boolean
  suggestOnNewDevice?: boolean
  dailyBriefing?: boolean
  briefingTime?: string
  maxUnpromptedActionsPerHour?: number
  quietHours?: [string, string]
  announce?: boolean
  speak?: boolean
}

function proactivity(): Proactivity {
  return settings.get<{ proactivity?: Proactivity }>('agent', {}).proactivity ?? {}
}

/** Quiet hours wrap midnight, which is the normal case: 22:30 to 07:00. */
function inQuietHours(at = new Date()): boolean {
  const [from, to] = proactivity().quietHours ?? ['22:30', '07:00']
  const minutes = at.getHours() * 60 + at.getMinutes()
  const parse = (value: string) => {
    const [hours, mins] = value.split(':').map(Number)
    return (hours ?? 0) * 60 + (mins ?? 0)
  }
  const start = parse(from)
  const end = parse(to)
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

function deviceName(id: string | null): string {
  if (!id) return 'un appareil'
  return deviceRepository.find(id)?.name ?? 'un appareil'
}

function areaOf(id: string | null): string | null {
  if (!id) return null
  const device = deviceRepository.find(id)
  if (!device?.areaId) return null
  return places.areas().find((area) => area.id === device.areaId)?.name ?? null
}

class Narrator {
  #unsubscribes: (() => void)[] = []
  #briefingTimer: ReturnType<typeof setInterval> | null = null
  #lastBriefingDay: string | null = null
  #spokenThisHour = 0
  #hourStamp = new Date().getHours()

  start(): void {
    if (this.#unsubscribes.length > 0) return

    this.#unsubscribes.push(
      bus.on('alert.raised', (event) => this.#onAlert(event)),
      bus.on('automation.suggested', (event) => this.#onSuggestion(event)),
      bus.on('presence.changed', (event) => this.#onPresence(event)),
      bus.on('device.added', (event) => this.#onDeviceAdded(event)),
      bus.on('device.offline', (event) => this.#onOffline(event)),
      bus.on('automation.failed', (event) => this.#onAutomationFailed(event)),
      bus.on('scan.finished', (event) => this.#onScanFinished(event))
    )

    // The briefing is checked every minute rather than scheduled once, so changing the time
    // in settings takes effect without a restart.
    this.#briefingTimer = setInterval(() => this.#maybeBrief(), 60_000)
  }

  stop(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe()
    this.#unsubscribes = []
    if (this.#briefingTimer) clearInterval(this.#briefingTimer)
    this.#briefingTimer = null
  }

  /**
   * The one way anything gets said. Returns the announcement, or null when the narrator
   * decided to stay quiet - deduplicated, over budget, or outside the hours.
   */
  announce(input: {
    kind: string
    text: string
    severity?: 'info' | 'notice' | 'warning' | 'critical'
    subjectId?: string | null
    dedupeKey?: string | null
    repeatAfterMinutes?: number
    /** Critical safety events ignore the hourly budget, never the dedupe. */
    urgent?: boolean
    payload?: Record<string, unknown>
  }): { id: string; text: string; speak: boolean } | null {
    const config = proactivity()
    if (config.announce === false) return null

    const hour = new Date().getHours()
    if (hour !== this.#hourStamp) {
      this.#hourStamp = hour
      this.#spokenThisHour = 0
    }
    const budget = config.maxUnpromptedActionsPerHour ?? 6
    if (!input.urgent && this.#spokenThisHour >= budget) return null

    const announcement = announcements.say({
      kind: input.kind,
      text: input.text,
      severity: input.severity ?? 'info',
      subjectId: input.subjectId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      repeatAfterMinutes: input.repeatAfterMinutes,
      payload: input.payload,
    })
    if (!announcement) return null

    this.#spokenThisHour += 1

    // Spoken only if the house is awake, or if it is the kind of thing worth waking for.
    const speak = config.speak !== false && (!inQuietHours() || input.severity === 'critical')

    bus.publish('agent.insight', {
      subjectType: input.subjectId ? 'device' : 'agent',
      subjectId: input.subjectId ?? null,
      origin: 'agent',
      severity: input.severity ?? 'info',
      payload: {
        announcementId: announcement.id,
        message: input.text,
        kind: input.kind,
        speak,
        ...input.payload,
      },
    })

    if (speak) announcements.markSpoken(announcement.id)
    return { id: announcement.id, text: input.text, speak }
  }

  // -------------------------------------------------------------------------------------
  // What is worth saying
  // -------------------------------------------------------------------------------------

  #onAlert(event: HouseEvent): void {
    const payload = event.payload as { kind?: string; title?: string; detail?: string; severity?: string }
    const kind = payload.kind ?? 'alert'
    const name = deviceName(event.subjectId)
    const area = areaOf(event.subjectId)
    const where = area ? ` dans ${area.toLowerCase()}` : ''

    // Written per alert kind rather than echoing the stored title, because the titles are
    // English technical strings and this is the sentence a person hears out loud.
    const sentences: Record<string, { text: string; severity: 'info' | 'notice' | 'warning' | 'critical'; urgent?: boolean; repeat: number }> = {
      leak: { text: `Fuite d'eau détectée par ${name}${where}. Coupez l'arrivée d'eau.`, severity: 'critical', urgent: true, repeat: 15 },
      smoke: { text: `Fumée détectée par ${name}${where}.`, severity: 'critical', urgent: true, repeat: 15 },
      battery_critical: { text: `La pile de ${name} est presque vide.`, severity: 'warning', repeat: 60 * 24 },
      battery_low: { text: `La pile de ${name} faiblit.`, severity: 'info', repeat: 60 * 24 * 3 },
      offline: { text: `${name} ne répond plus depuis une heure.`, severity: 'warning', repeat: 60 * 6 },
      firmware: { text: `Une mise à jour est disponible pour ${name}.`, severity: 'info', repeat: 60 * 24 * 7 },
      heating_window_open: { text: `Le chauffage tourne${where} alors qu'une fenêtre est ouverte.`, severity: 'warning', repeat: 60 },
      night_drain: { text: `${name} consomme toute la nuit sans rien faire.`, severity: 'info', repeat: 60 * 24 },
    }

    const line = sentences[kind] ?? {
      text: payload.title ?? `Alerte sur ${name}.`,
      severity: (payload.severity as 'warning') ?? 'warning',
      repeat: 60 * 6,
    }

    this.announce({
      kind: `alert.${kind}`,
      text: line.text,
      severity: line.severity,
      subjectId: event.subjectId,
      dedupeKey: `alert:${kind}:${event.subjectId ?? 'house'}`,
      repeatAfterMinutes: line.repeat,
      urgent: line.urgent,
      payload: { alertKind: kind },
    })
  }

  #onSuggestion(event: HouseEvent): void {
    const payload = event.payload as { name?: string; reason?: string; routineId?: string }
    if (!proactivity().suggestRoutines) return
    this.announce({
      kind: 'routine.suggested',
      text: `J'ai une idée de routine: ${payload.name}. ${payload.reason ?? ''}`.trim(),
      severity: 'info',
      dedupeKey: `routine:${payload.routineId ?? payload.name}`,
      repeatAfterMinutes: 60 * 24 * 7,
      payload: { routineId: payload.routineId, action: 'open-routines' },
    })
  }

  #onPresence(event: HouseEvent): void {
    const payload = event.payload as { home?: boolean; homeCount?: number; personId?: string }
    const person = payload.personId ? people.all().find((entry) => entry.id === payload.personId) : null
    const name = person?.name ?? 'Quelqu un'

    if (payload.home) {
      const open = alerts.open().filter((alert) => alert.severity !== 'info')
      const extra = open.length > 0 ? ` Au fait, ${open.length} chose${open.length > 1 ? 's' : ''} demande${open.length > 1 ? 'nt' : ''} votre attention.` : ''
      this.announce({
        kind: 'presence.arrived',
        text: `${name} est rentré.${extra}`,
        dedupeKey: `presence:${payload.personId}:home`,
        repeatAfterMinutes: 30,
        payload: { personId: payload.personId },
      })
      return
    }

    if ((payload.homeCount ?? 0) === 0) {
      const snapshot = deviceRepository.all({ limit: 1000 })
      const lightsOn = snapshot.filter((device) => device.category === 'light' && device.state.on === true)
      const unlocked = snapshot.filter((device) => device.state.locked === false)
      const bits: string[] = []
      if (lightsOn.length > 0) bits.push(`${lightsOn.length} lumière${lightsOn.length > 1 ? 's sont restées allumées' : ' est restée allumée'}`)
      if (unlocked.length > 0) bits.push(`${unlocked.map((device) => device.name).join(', ')} n'est pas verrouillé`)
      if (bits.length === 0) return
      this.announce({
        kind: 'presence.empty',
        text: `La maison est vide et ${bits.join(', et ')}. Je m'en occupe ?`,
        severity: 'notice',
        dedupeKey: 'presence:empty',
        repeatAfterMinutes: 60,
        payload: { action: 'offer-leave-home', lightIds: lightsOn.map((device) => device.id) },
      })
    }
  }

  #onDeviceAdded(event: HouseEvent): void {
    const payload = event.payload as { name?: string }
    this.announce({
      kind: 'device.added',
      text: `Nouvel appareil sur le réseau: ${payload.name ?? deviceName(event.subjectId)}. Voulez-vous que je le range et lui propose une routine ?`,
      dedupeKey: `device-added:${event.subjectId}`,
      repeatAfterMinutes: 60 * 24 * 30,
      payload: { deviceId: event.subjectId, action: 'open-device' },
    })
  }

  #onOffline(event: HouseEvent): void {
    // Handled through alerts after an hour; a single missed poll is not worth a sentence.
    void event
  }

  #onAutomationFailed(event: HouseEvent): void {
    const payload = event.payload as { name?: string; error?: string }
    this.announce({
      kind: 'routine.failed',
      text: `La routine ${payload.name ?? ''} a échoué: ${payload.error ?? 'raison inconnue'}.`,
      severity: 'warning',
      dedupeKey: `routine-failed:${payload.name}`,
      repeatAfterMinutes: 60 * 6,
      payload: { action: 'open-routines' },
    })
  }

  #onScanFinished(event: HouseEvent): void {
    const payload = event.payload as { added?: number; hosts?: number }
    if (!payload.added) return
    this.announce({
      kind: 'scan.found',
      text: `Scan terminé: ${payload.added} nouvel${payload.added > 1 ? 's appareils' : ' appareil'} trouvé${payload.added > 1 ? 's' : ''} sur ${payload.hosts} machines.`,
      dedupeKey: `scan:${new Date().toISOString().slice(0, 13)}`,
      repeatAfterMinutes: 60,
      payload: { action: 'open-network' },
    })
  }

  #maybeBrief(): void {
    const config = proactivity()
    if (!config.dailyBriefing) return

    const now = new Date()
    const day = now.toISOString().slice(0, 10)
    if (this.#lastBriefingDay === day) return

    const [hours, minutes] = (config.briefingTime ?? '08:00').split(':').map(Number)
    if (now.getHours() !== (hours ?? 8) || now.getMinutes() !== (minutes ?? 0)) return

    this.#lastBriefingDay = day
    const briefing = insightEngine.briefing()
    this.announce({
      kind: 'briefing',
      text: `${briefing.headline} ${briefing.lines.join(' ')}`.trim(),
      severity: 'info',
      dedupeKey: `briefing:${day}`,
      urgent: true,
      payload: { lines: briefing.lines, action: 'open-agent' },
    })
  }

  /** Read on demand by the console when it connects, so a missed announcement is not lost. */
  pending(): ReturnType<typeof announcements.pending> {
    return announcements.pending()
  }

  status(): { quietHours: boolean; spokenThisHour: number; budget: number; pending: number } {
    return {
      quietHours: inQuietHours(),
      spokenThisHour: this.#spokenThisHour,
      budget: proactivity().maxUnpromptedActionsPerHour ?? 6,
      pending: announcements.pending().length,
    }
  }
}

export const narrator = new Narrator()
export { inQuietHours }
