/**
 * How an event is worded on screen.
 *
 * The dock and the journal page both render the same stream, so the wording lives here
 * once. An event line names the thing, the change, and who caused it - the origin is the
 * whole point of a house journal, because "the light went off" and "the agent turned the
 * light off" are different facts.
 */

export interface HouseEventView {
  id: string
  type: string
  at: string
  subjectType: string
  subjectId: string | null
  origin: string
  originDetail: string | null
  payload: Record<string, any>
  correlationId: string | null
  /** Loose on purpose: this mirrors the wire, where an unknown severity must not throw. */
  severity: string
}

export const EVENT_ICON: Record<string, string> = {
  'device.state_changed': 'ph:arrows-clockwise',
  'device.command_sent': 'ph:cursor-click',
  'device.command_failed': 'ph:warning-octagon',
  'device.added': 'ph:plus-circle',
  'device.discovered': 'ph:magnifying-glass',
  'device.updated': 'ph:pencil-simple',
  'device.removed': 'ph:minus-circle',
  'device.online': 'ph:plugs-connected',
  'device.offline': 'ph:plugs',
  'device.event': 'ph:bell-simple',
  'automation.triggered': 'ph:flow-arrow',
  'automation.action_run': 'ph:play',
  'automation.failed': 'ph:warning-octagon',
  'automation.suggested': 'ph:lightbulb',
  'scene.activated': 'ph:sparkle',
  'agent.message': 'ph:chat-circle',
  'agent.tool_call': 'ph:wrench',
  'agent.tool_result': 'ph:check-square-offset',
  'agent.action_proposed': 'ph:seal-question',
  'agent.action_approved': 'ph:thumbs-up',
  'agent.action_rejected': 'ph:thumbs-down',
  'agent.autonomy_changed': 'ph:steering-wheel',
  'agent.insight': 'ph:lightbulb-filament',
  'voice.wake': 'ph:microphone',
  'voice.transcript': 'ph:waveform',
  'voice.reply': 'ph:speaker-high',
  'presence.changed': 'ph:user',
  'scan.started': 'ph:broadcast',
  'scan.finished': 'ph:broadcast',
  'adapter.status_changed': 'ph:puzzle-piece',
  'house.mode_changed': 'ph:house',
  'alert.raised': 'ph:warning',
  'alert.cleared': 'ph:check-circle',
  'energy.tick': 'ph:lightning',
  'system.notice': 'ph:info',
  'system.error': 'ph:bug',
}

/** Who caused it. Shown verbatim, because "who" is the reason this journal exists. */
export const ORIGIN_LABEL: Record<string, string> = {
  user: 'vous',
  automation: 'routine',
  agent: 'assistant',
  device: 'appareil',
  schedule: 'planification',
  api: 'API',
  system: 'système',
}

export const ORIGIN_ICON: Record<string, string> = {
  user: 'ph:hand-pointing',
  automation: 'ph:flow-arrow',
  agent: 'ph:sparkle',
  device: 'ph:cpu',
  schedule: 'ph:clock',
  api: 'ph:terminal',
  system: 'ph:gear',
}

/** Groups used by the journal filter. Kept coarse: a filter with 45 rows filters nothing. */
export const EVENT_GROUPS: { id: string; label: string; icon: string; types: string[] }[] = [
  { id: 'devices', label: 'Appareils', icon: 'ph:lightbulb-filament', types: ['device.state_changed', 'device.command_sent', 'device.command_failed', 'device.added', 'device.removed', 'device.online', 'device.offline', 'device.event'] },
  { id: 'automation', label: 'Routines', icon: 'ph:flow-arrow', types: ['automation.triggered', 'automation.action_run', 'automation.failed', 'automation.suggested', 'scene.activated'] },
  { id: 'agent', label: 'Assistant', icon: 'ph:sparkle', types: ['agent.message', 'agent.tool_call', 'agent.action_proposed', 'agent.action_approved', 'agent.action_rejected', 'agent.autonomy_changed', 'agent.insight'] },
  { id: 'presence', label: 'Présence', icon: 'ph:user', types: ['presence.changed', 'house.mode_changed'] },
  { id: 'system', label: 'Système', icon: 'ph:gear', types: ['scan.started', 'scan.finished', 'adapter.status_changed', 'alert.raised', 'alert.cleared', 'system.notice', 'system.error'] },
]

function changeSummary(changes: Record<string, unknown> | undefined, limit = 2): string {
  return Object.entries(changes ?? {})
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .slice(0, limit)
    .join(' ')
}

export function eventLabel(event: HouseEventView, nameOf?: (id: string) => string | undefined): string {
  const name = event.subjectId ? nameOf?.(event.subjectId) ?? '' : ''
  switch (event.type) {
    case 'device.state_changed':
      return `${name} ${changeSummary(event.payload.changes)}`.trim()
    case 'device.command_sent':
      return `${name} ${event.payload.command}`.trim()
    case 'device.command_failed':
      return `${name} ${event.payload.command} a échoué${event.payload.error ? ` : ${event.payload.error}` : ''}`
    case 'device.added':
      return `${event.payload.name ?? name} ajouté`
    case 'device.discovered':
      return `${event.payload.name ?? name} découvert`
    case 'device.removed':
      return `${event.payload.name ?? name} retiré`
    case 'device.online':
      return `${name} en ligne`
    case 'device.offline':
      return `${name} hors ligne`
    case 'device.event':
      return `${name} ${event.payload.event ?? 'évènement'}`
    case 'automation.triggered':
      return `Routine ${event.payload.name}`
    case 'automation.action_run':
      return `Routine ${event.payload.name ?? ''} : ${event.payload.kind ?? 'action'}`
    case 'automation.failed':
      return `Routine ${event.payload.name ?? ''} a échoué : ${event.payload.error ?? ''}`
    case 'automation.suggested':
      return `Routine proposée : ${event.payload.name}`
    case 'scene.activated':
      return `Scène ${event.payload.name}`
    case 'agent.message':
      return `${event.payload.role === 'user' ? 'Vous' : 'Assistant'} : ${String(event.payload.content ?? '').slice(0, 120)}`
    case 'agent.tool_call':
      return `Outil ${event.payload.name}`
    case 'agent.tool_result':
      return `Outil ${event.payload.name} : ${event.payload.ok === false ? 'échec' : 'ok'}`
    case 'agent.action_proposed':
      return `Proposition : ${event.payload.summary}`
    case 'agent.action_approved':
      return `Proposition acceptée : ${event.payload.summary ?? ''}`
    case 'agent.action_rejected':
      return `Proposition refusée : ${event.payload.summary ?? ''}`
    case 'agent.autonomy_changed':
      return `Autonomie : ${event.payload.level}`
    case 'agent.insight':
      return String(event.payload.message ?? 'Observation')
    case 'voice.transcript':
      return `Dicté : ${event.payload.text ?? ''}`
    case 'voice.reply':
      return `Dit : ${event.payload.text ?? ''}`
    case 'presence.changed':
      return `${event.payload.home ? 'Arrivée' : 'Départ'} · ${event.payload.homeCount ?? 0} à la maison`
    case 'scan.started':
      return 'Scan réseau démarré'
    case 'scan.finished':
      return `Scan : ${event.payload.hosts} hôtes, ${event.payload.added} nouveaux`
    case 'adapter.status_changed':
      return `Intégration ${event.payload.adapter ?? name} : ${event.payload.health ?? ''}`
    case 'house.mode_changed':
      return `Mode : ${event.payload.mode}`
    case 'alert.raised':
      return String(event.payload.title ?? 'Alerte')
    case 'alert.cleared':
      return `Alerte levée : ${event.payload.title ?? ''}`
    case 'energy.tick':
      return `${event.payload.kwh ?? 0} kWh cumulés`
    case 'system.notice':
      return String(event.payload.message ?? '')
    case 'system.error':
      return String(event.payload.message ?? 'Erreur')
    default:
      return `${event.type} ${name}`.trim()
  }
}

export function severityClass(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'text-error'
    case 'warning':
      return 'text-warning'
    case 'debug':
      return 'text-base-content/40'
    default:
      return ''
  }
}
