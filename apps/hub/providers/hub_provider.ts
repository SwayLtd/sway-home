/**
 * Hub boot.
 *
 * Opens the database, applies migrations, registers every adapter, starts the ones that are
 * enabled, seeds a house on first run and kicks off the first scan. Ordering matters: the
 * database has to exist before an adapter can read its configuration, and the adapters have
 * to be running before a scan can hand them anything.
 */

import type { ApplicationService } from '@adonisjs/core/types'
import { openDatabase } from '#db/database'
import { databasePath, runMigrations } from '#db/migrate'
import { adapters } from '#services/adapter_manager'
import { bus } from '#services/event_bus'
import { scanService } from '#services/scan_service'
import { automationEngine } from '#services/automation_engine'
import { insightEngine } from '#services/insight_engine'
import { widgetService } from '#services/widget_service'
import { narrator } from '#services/narrator'
import { autonomyEngine } from '#services/autonomy_engine'
import { registerAdapters } from '#adapters/registry'
import { places, settings } from '#repositories/store'

export default class HubProvider {
  constructor(protected app: ApplicationService) {}

  register(): void {}

  async boot(): Promise<void> {}

  /** Runs once the HTTP server is listening, so the UI can watch the boot on the socket. */
  async ready(): Promise<void> {
    const started = performance.now()

    await openDatabase(databasePath())
    const migrations = await runMigrations({ silent: true })
    if (migrations.applied.length > 0) {
      console.log(`[hub] applied ${migrations.applied.length} migration(s)`)
    }

    seedFirstRun()
    scanService.refreshNetworkFacts()

    registerAdapters()
    await adapters.startAll()

    // Adapters that do not need the network scan - the virtual house, a radio coordinator,
    // an MQTT broker already full of retained state - can report immediately. Doing this
    // before the scan means the console has content the moment it loads rather than after
    // twenty seconds of subnet sweeping.
    const immediate = await adapters.discover([])
    if (immediate.added > 0) console.log(`[hub] ${immediate.added} device(s) from adapters that need no scan`)

    automationEngine.start()
    insightEngine.start()
    // The dashboard is seeded after the adapters have reported, so the starter cards land on
    // a house that already has devices in it rather than on an empty one.
    widgetService.seedDefaults()
    narrator.start()
    // Last, so the reflexes act on a house whose devices and history are already loaded.
    autonomyEngine.start()

    const network = adapters.network()
    console.log(`[hub] ready in ${Math.round(performance.now() - started)} ms on ${network.interfaceName} ${network.localIp} (${network.cidr})`)
    bus.publish('system.notice', {
      payload: {
        message: 'Hub ready',
        adapters: adapters.list().filter((entry) => entry.started).map((entry) => entry.descriptor.id),
        network,
      },
    })

    // The first scan runs in the background: the console must be usable immediately, and a
    // scan takes tens of seconds on a full subnet.
    if (settings.get('scan.onBoot', true)) {
      void scanService.run({ quick: true }).then(() => {
        if (settings.get('scan.deepOnBoot', false)) void scanService.run({ deep: true })
      })
    }
  }

  async shutdown(): Promise<void> {
    automationEngine.stop()
    insightEngine.stop()
    narrator.stop()
    autonomyEngine.stop()
    await adapters.shutdownAll()
  }
}

/**
 * A brand new database has no rooms, and a hub with no rooms cannot group anything. Seed
 * the rooms a European flat actually has; the user renames them in thirty seconds and the
 * agent has somewhere to put every device it finds.
 */
function seedFirstRun(): void {
  if (settings.get('hub.seeded', false)) return

  const defaults: { name: string; kind: Parameters<typeof places.createArea>[0]['kind']; icon: string }[] = [
    { name: 'Salon', kind: 'living_room', icon: 'ph:couch' },
    { name: 'Cuisine', kind: 'kitchen', icon: 'ph:cooking-pot' },
    { name: 'Chambre', kind: 'bedroom', icon: 'ph:bed' },
    { name: 'Bureau', kind: 'office', icon: 'ph:desk' },
    { name: 'Salle de bain', kind: 'bathroom', icon: 'ph:bathtub' },
    { name: 'Entrée', kind: 'entrance', icon: 'ph:door' },
    { name: 'Garage', kind: 'garage', icon: 'ph:garage' },
    { name: 'Jardin', kind: 'garden', icon: 'ph:tree' },
  ]

  const ground = places.createFloor('Rez-de-chaussée', 0)
  for (const area of defaults) {
    places.createArea({ name: area.name, kind: area.kind, icon: area.icon, floorId: ground.id })
  }

  settings.set('hub.seeded', true)
  settings.set('hub.createdAt', new Date().toISOString())
  settings.set('house.mode', 'home')
  settings.set('agent', {
    autonomy: 'assistant',
    voice: { enabled: true, wakeWord: 'hey jarvis', wakeWordEnabled: false, sttProvider: 'browser-local', ttsProvider: 'browser-kokoro', ttsVoice: 'ff_siwis', language: 'fr', speakReplies: true },
    llm: { provider: 'none', model: '', temperature: 0.3, maxSteps: 12, dailyBudgetUsd: 2 },
    privacy: { localOnly: false, shareDeviceNames: true, retainTranscriptsDays: 30, retainAudio: false },
    proactivity: { suggestRoutines: true, suggestOnNewDevice: true, dailyBriefing: true, briefingTime: '08:00', maxUnpromptedActionsPerHour: 6, quietHours: ['22:30', '07:00'] },
  })
  settings.set('energy', { pricePerKwh: 0.2516, currency: 'EUR', contractKva: 9 })
  console.log('[hub] first run: seeded 8 rooms and default settings')
}
