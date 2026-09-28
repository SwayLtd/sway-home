/**
 * The HTTP API.
 *
 * One file, because the surface is small and a reader should be able to see the whole
 * contract at once. Everything is under `/api`, everything returns JSON, and the realtime
 * feed is server-sent events rather than a WebSocket: the traffic is one-way, SSE
 * reconnects by itself, it survives every proxy, and it needs no dependency at all.
 */

import router from '@adonisjs/core/services/router'
import type { HttpContext } from '@adonisjs/core/http'
import { AUTONOMY, AUTONOMY_LEVELS, CAPABILITIES, CAPABILITY_IDS, DEVICE_CATEGORIES, HOUSE_MODES } from '@sway-home/shared'
import { bus, queryEvents } from '#services/event_bus'
import { houseService } from '#services/house'
import { adapters } from '#services/adapter_manager'
import { scanService } from '#services/scan_service'
import { automationEngine } from '#services/automation_engine'
import { insightEngine } from '#services/insight_engine'
import { allDescriptors, DECLARED } from '#adapters/registry'
import { agentService, parseAnswers } from '#agent/agent_service'
import { liveVoice } from '#services/live_voice'
import { publicAdapterConfig, publicSettings, saveAgentSettings, secrets, type ProviderSecret } from '#services/secrets'

const SECRETS_SETTING = 'agent.secrets'
import { PROVIDER_CATALOGUE, probeLocalRunners } from '#agent/providers'
import { widgets, announcements } from '#repositories/widget_repository'
import { widgetService } from '#services/widget_service'
import { narrator } from '#services/narrator'
import { autonomyEngine } from '#services/autonomy_engine'
import { followUpsFor } from '#agent/follow_ups'
import { describeProposal } from '#agent/proposal_changes'
import { tasks } from '#services/task_service'
import { insights } from '#services/insights'
import { teach } from '#services/teach_service'
import { deviceProperties, type PropertyKind } from '#services/device_properties'
import { parseRoutineInput } from '#services/routine_input'
import { liveModelChoices } from '#agent/model_choice'
import { parseMentions, slashCommands } from '#agent/composer'
import { REWRITE_ACTIONS, type RewriteAction } from '#agent/rewrite'
import { cameraSnapshot } from '#services/camera_snapshot'
import { deviceRepository } from '#repositories/device_repository'
import { alerts, adapterConfig, conversations, house, hosts, memories, messages, people, places, proposals, routines, scenes, settings, undo } from '#repositories/store'
import { database } from '#db/database'

router.group(() => {
  // -------------------------------------------------------------------------------------
  // Health and meta
  // -------------------------------------------------------------------------------------

  router.get('/health', async () => ({
    ok: true,
    at: new Date().toISOString(),
    driver: database().name,
    runtime: typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? `bun ${(globalThis as { Bun: { version: string } }).Bun.version}` : `node ${process.version}`,
    network: adapters.network(),
    sockets: bus.socketCount(),
    adapters: adapters.list().filter((entry) => entry.started).length,
  }))

  router.get('/meta', async () => ({
    capabilities: CAPABILITY_IDS.map((id) => ({
      id,
      kind: CAPABILITIES[id].kind,
      description: CAPABILITIES[id].description,
      unit: CAPABILITIES[id].unit ?? null,
      readOnly: CAPABILITIES[id].readOnly ?? false,
      commands: Object.keys(CAPABILITIES[id].commands),
      matterCluster: CAPABILITIES[id].matterCluster ?? null,
    })),
    categories: DEVICE_CATEGORIES,
    houseModes: HOUSE_MODES,
    autonomyLevels: AUTONOMY_LEVELS.map((level) => ({ id: level, ...AUTONOMY[level] })),
  }))

  // -------------------------------------------------------------------------------------
  // Realtime
  // -------------------------------------------------------------------------------------

  router.get('/stream', async ({ response }: HttpContext) => {
    response.response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const write = (event: unknown) => {
      response.response.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    // Replay the recent ring so a page that loads late still draws a timeline.
    for (const event of bus.recent(40)) write(event)
    write({ type: 'stream.ready', at: new Date().toISOString() })

    const detach = bus.attachSocket(write)
    // A comment frame every 20 s keeps intermediaries from closing an idle connection.
    const keepAlive = setInterval(() => response.response.write(': keep-alive\n\n'), 20_000)

    response.response.on('close', () => {
      clearInterval(keepAlive)
      detach()
    })

    return response.response
  })

  // -------------------------------------------------------------------------------------
  // House
  // -------------------------------------------------------------------------------------

  router.get('/house', async () => {
    const snapshot = houseService.snapshot()
    return {
      ...snapshot,
      suggestions: routines.all('suggested').length,
      pendingProposals: proposals.pending().length,
      undoAvailable: undo.stack(1).length > 0,
      scan: scanService.state(),
    }
  })

  router.get('/house/briefing', async () => insightEngine.briefing())

  router.post('/house/mode', async ({ request }: HttpContext) => {
    const mode = String(request.input('mode', 'home'))
    houseService.setMode(mode as never, 'api')
    return { ok: true, mode: house.mode() }
  })

  router.post('/house/undo', async () => houseService.undoLast())

  router.post('/house/undo/:id', async ({ params }: HttpContext) => houseService.undo(params.id))

  router.get('/house/undo-stack', async () => undo.stack(10))

  // -------------------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------------------

  router.get('/devices', async ({ request }: HttpContext) => {
    const devices = deviceRepository.all({
      areaId: request.input('areaId'),
      category: request.input('category'),
      capability: request.input('capability'),
      search: request.input('search'),
      online: request.input('online') === undefined ? undefined : request.input('online') === 'true',
      favourite: request.input('favourite') === undefined ? undefined : request.input('favourite') === 'true',
      includeHidden: request.input('includeHidden') === 'true',
      limit: Number(request.input('limit', 500)),
    })
    return { devices, counts: deviceRepository.counts() }
  })

  router.get('/devices/search', async ({ request }: HttpContext) => ({
    devices: deviceRepository.search(String(request.input('q', '')), Number(request.input('limit', 20))),
  }))

  // -------------------------------------------------------------------------------------
  // Computed columns of the device table
  // -------------------------------------------------------------------------------------

  router.get('/devices/properties', async () => ({ properties: deviceProperties.list(), values: deviceProperties.values() }))

  router.post('/devices/properties', async ({ request, response }: HttpContext) => {
    try {
      const options = request.input('options')
      const model = request.input('model')
      return {
        property: deviceProperties.define({
          label: String(request.input('label', '')),
          prompt: String(request.input('prompt', '')),
          kind: request.input('kind'),
          options: Array.isArray(options) ? options.filter((option): option is string => typeof option === 'string') : undefined,
          model: typeof model === 'string' && model ? model : undefined,
        }),
      }
    } catch (error) {
      return response.badRequest({ error: (error as Error).message })
    }
  })

  /** A partial edit: an absent field stays, `model: null` goes back to the settings' model. */
  router.patch('/devices/properties/:id', async ({ params, request, response }: HttpContext) => {
    const body = request.body() as Record<string, unknown>
    const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : undefined)
    try {
      const property = deviceProperties.update(params.id, {
        label: text('label'),
        prompt: text('prompt'),
        kind: text('kind') as PropertyKind | undefined,
        options: Array.isArray(body.options) ? body.options.filter((option): option is string => typeof option === 'string') : undefined,
        model: body.model === null ? null : text('model'),
      })
      if (!property) return response.notFound({ error: 'Colonne introuvable' })
      return { property }
    } catch (error) {
      return response.badRequest({ error: (error as Error).message })
    }
  })

  router.delete('/devices/properties/:id', async ({ params, response }: HttpContext) => {
    if (!deviceProperties.remove(params.id)) return response.notFound({ error: 'Colonne introuvable' })
    return { ok: true }
  })

  /** Fills a column; each value is pushed as its device resolves, then `{ kind: 'done' }`. */
  router.post('/devices/properties/:id/run', async ({ params, response }: HttpContext) => {
    const raw = response.response
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
    const controller = new AbortController()
    raw.on('close', () => {
      if (!raw.writableEnded) controller.abort()
    })
    const write = (payload: unknown) => {
      if (!controller.signal.aborted) raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    try {
      await deviceProperties.run(params.id, { signal: controller.signal, onValue: (deviceId, value) => write({ kind: 'value', deviceId, value }) })
      write({ kind: 'done' })
    } catch (error) {
      write({ kind: 'error', message: (error as Error).message })
    }
    if (!raw.writableEnded) raw.end()
    return raw
  })

  // The fixed paths under /devices/ come before /devices/:id: routes are tried in the
  // order they are registered, and :id would answer "properties" as a device id.
  router.get('/devices/:id', async ({ params, response }: HttpContext) => {
    const device = deviceRepository.find(params.id)
    if (!device) return response.notFound({ error: 'Device not found' })
    const commands = [...new Set(device.capabilities.flatMap((capability) => Object.keys(CAPABILITIES[capability]?.commands ?? {})))]
    return { device, commands, adapter: adapters.get(device.adapterId)?.descriptor ?? null }
  })

  router.patch('/devices/:id', async ({ params, request, response }: HttpContext) => {
    const device = deviceRepository.update(params.id, {
      name: request.input('name'),
      aliases: request.input('aliases'),
      areaId: request.input('areaId'),
      notes: request.input('notes'),
      favourite: request.input('favourite'),
      hidden: request.input('hidden'),
      critical: request.input('critical'),
      category: request.input('category'),
    })
    if (!device) return response.notFound({ error: 'Device not found' })
    bus.publish('device.updated', { subjectType: 'device', subjectId: device.id, origin: 'user', payload: { name: device.name } })
    return { device }
  })

  router.delete('/devices/:id', async ({ params }: HttpContext) => {
    const device = deviceRepository.find(params.id)
    // The adapter lets go first (a Matter device leaves the hub's fabric), or the next scan
    // would put the device straight back.
    const released = device ? await adapters.forget(device.adapterId, device.nativeId) : null
    deviceRepository.remove(params.id)
    if (device) bus.publish('device.removed', { subjectType: 'device', subjectId: params.id, origin: 'user', payload: { name: device.name } })
    return { ok: true, released }
  })

  router.post('/devices/:id/command', async ({ params, request, response }: HttpContext) => {
    const command = String(request.input('command', ''))
    if (!command) return response.badRequest({ error: 'command is required' })
    const result = await houseService.execute(params.id, command, request.input('args', {}) as Record<string, unknown>, {
      origin: 'user',
      endpointIndex: request.input('endpointIndex'),
    })
    return response.status(result.ok ? 200 : 422).send(result)
  })

  router.post('/devices/command', async ({ request }: HttpContext) => {
    const results = await houseService.executeMany(
      {
        deviceIds: request.input('deviceIds'),
        areaId: request.input('areaId'),
        capability: request.input('capability'),
        category: request.input('category'),
        // "Everything" is never inferred from an empty body: a request that lost its filter
        // would otherwise command every device in the house.
        all: request.input('all') === true,
      },
      String(request.input('command', '')),
      request.input('args', {}) as Record<string, unknown>,
      { origin: 'user' }
    )
    return { results, ok: results.every((result) => result.ok) }
  })

  router.get('/devices/:id/history', async ({ params, request }: HttpContext) => {
    const hours = Number(request.input('hours', 24))
    const attribute = String(request.input('attribute', 'temperature'))
    return {
      attribute,
      points: deviceRepository.history(params.id, attribute, {
        since: new Date(Date.now() - hours * 3_600_000).toISOString(),
        limit: Number(request.input('limit', 500)),
      }),
    }
  })

  router.post('/devices/:id/refresh', async ({ params, response }: HttpContext) => {
    const device = deviceRepository.find(params.id)
    if (!device) return response.notFound({ error: 'Device not found' })
    const state = await adapters.readState(device.adapterId, device.nativeId)
    if (state) deviceRepository.mergeState(device.id, state)
    return { device: deviceRepository.find(params.id) }
  })

  // -------------------------------------------------------------------------------------
  // Places
  // -------------------------------------------------------------------------------------

  router.get('/areas', async () => {
    const list = places.areas()
    const counts = new Map<string, number>()
    for (const device of deviceRepository.all({ limit: 1000 })) {
      if (!device.areaId) continue
      counts.set(device.areaId, (counts.get(device.areaId) ?? 0) + 1)
    }
    return {
      floors: places.floors(),
      areas: list.map((area) => ({ ...area, deviceCount: counts.get(area.id) ?? 0 })),
    }
  })

  router.post('/areas', async ({ request }: HttpContext) => ({
    area: places.createArea({ name: String(request.input('name', 'Nouvelle pièce')), kind: request.input('kind'), icon: request.input('icon') }),
  }))

  router.patch('/areas/:id', async ({ params, request }: HttpContext) => {
    places.updateArea(params.id, { name: request.input('name'), kind: request.input('kind'), icon: request.input('icon'), floorId: request.input('floorId') })
    return { ok: true }
  })

  router.delete('/areas/:id', async ({ params }: HttpContext) => {
    places.deleteArea(params.id)
    return { ok: true }
  })

  // -------------------------------------------------------------------------------------
  // Scan and network
  // -------------------------------------------------------------------------------------

  router.get('/scan', async () => ({ ...scanService.state(), last: settings.get('scan.last', null) }))

  router.post('/scan', async ({ request }: HttpContext) => {
    if (scanService.isRunning()) return { ...scanService.state(), alreadyRunning: true }
    const quick = request.input('quick', true) !== false
    // Fire and forget: the client follows the scan on the event stream.
    void scanService.run({ quick, deep: request.input('deep', false) === true })
    return scanService.state()
  })

  router.post('/scan/cancel', async () => {
    scanService.cancel()
    return { ok: true }
  })

  router.get('/network/hosts', async ({ request }: HttpContext) => ({
    hosts: hosts.all({ includeIgnored: request.input('includeIgnored') === 'true' }),
    unclaimed: scanService.unclaimed().length,
  }))

  router.post('/network/hosts/:ip/ignore', async ({ params, request }: HttpContext) => {
    hosts.ignore(params.ip, request.input('ignored', true) !== false)
    return { ok: true }
  })

  // -------------------------------------------------------------------------------------
  // Adapters
  // -------------------------------------------------------------------------------------

  router.get('/adapters', async () => ({
    adapters: allDescriptors().map((descriptor) => {
      // Tokens and passwords never leave the hub: the console gets which ones are set.
      const view = descriptor.declared ? { config: {}, secretsSet: [] } : publicAdapterConfig(descriptor.configSchema, adapterConfig.get(descriptor.id).config ?? {})
      return {
        ...descriptor,
        status: descriptor.declared ? { health: 'needs_setup', deviceCount: 0, message: (descriptor as { unlocks?: string }).unlocks } : adapters.statusOf(descriptor.id),
        config: view.config,
        secretsSet: view.secretsSet,
        enabled: descriptor.declared ? false : adapterConfig.get(descriptor.id).enabled,
      }
    }),
    declaredCount: DECLARED.length,
  }))

  router.post('/adapters/:id/enable', async ({ params, request }: HttpContext) => {
    const enable = request.input('enabled', true) !== false
    if (enable) await adapters.start(params.id)
    else await adapters.stop(params.id)
    return { ok: true, status: adapters.statusOf(params.id) }
  })

  router.post('/adapters/:id/config', async ({ params, request }: HttpContext) => {
    await adapters.configure(params.id, request.body() as Record<string, unknown>)
    return { ok: true, status: adapters.statusOf(params.id) }
  })

  router.post('/adapters/:id/pair', async ({ params, request, response }: HttpContext) => {
    const entry = adapters.get(params.id)
    if (!entry?.adapter.pair) return response.badRequest({ error: 'This adapter has no pairing flow' })
    // A pairing blocks until the accessory answers: it shows as a task meanwhile. No retry
    // payload is kept - the body can hold a setup code, and retrying means typing it again.
    const task = tasks.start({ kind: 'pairing', title: `Appairage ${entry.adapter.descriptor.name}`, steps: ['Connexion et échange des clés'] })
    task.step(0, 'running')
    try {
      const result = await entry.adapter.pair(request.body() as Record<string, unknown>)
      if (result.ok) task.done(result.message ?? null)
      else task.fail(result.message ?? 'Appairage refusé')
      return result
    } catch (error) {
      task.fail((error as Error).message)
      throw error
    }
  })

  // -------------------------------------------------------------------------------------
  // Tasks: what the hub is busy with
  // -------------------------------------------------------------------------------------

  router.get('/tasks', async () => ({ tasks: tasks.list() }))

  // -------------------------------------------------------------------------------------
  // Teaching a task by doing it
  // -------------------------------------------------------------------------------------

  router.get('/teach', async () => teach.status())

  router.post('/teach/start', async ({ request }: HttpContext) => {
    const title = request.input('title')
    return teach.start({ title: typeof title === 'string' ? title : null })
  })

  /** Ends the recording; what was taught comes back as a suggested routine. */
  router.post('/teach/stop', async () => teach.stop())

  router.post('/teach/cancel', async () => {
    teach.cancel()
    return { ok: true }
  })

  /** The insight cards: energy today against yesterday, something unusual, the week by room. */
  router.get('/insights', async () => ({ insights: insights.all() }))

  router.post('/tasks/:id/cancel', async ({ params, response }: HttpContext) => {
    if (!tasks.cancel(params.id)) return response.badRequest({ error: 'Cette tâche ne peut pas être annulée' })
    return { ok: true }
  })

  router.post('/tasks/:id/retry', async ({ params, response }: HttpContext) => {
    if (!(await tasks.retry(params.id))) return response.badRequest({ error: 'Cette tâche ne peut pas être relancée' })
    return { ok: true }
  })

  // -------------------------------------------------------------------------------------
  // Routines and scenes
  // -------------------------------------------------------------------------------------

  router.get('/routines', async ({ request }: HttpContext) => ({
    routines: routines.all(request.input('status')),
  }))

  /** A routine is checked against the shared schema before it is kept; errors come back in words. */
  router.post('/routines', async ({ request, response }: HttpContext) => {
    const parsed = parseRoutineInput(request.body())
    if (!parsed.ok) return response.badRequest({ error: parsed.errors.join(' | '), errors: parsed.errors })
    return { routine: routines.create({ ...parsed.value, authoredBy: 'user', suggestionReason: null }) }
  })

  router.patch('/routines/:id', async ({ params, request, response }: HttpContext) => {
    if (!routines.find(params.id)) return response.notFound({ error: 'Routine introuvable' })
    const parsed = parseRoutineInput(request.body(), { partial: true })
    if (!parsed.ok) return response.badRequest({ error: parsed.errors.join(' | '), errors: parsed.errors })
    return { routine: routines.update(params.id, parsed.value) }
  })

  router.delete('/routines/:id', async ({ params }: HttpContext) => {
    routines.remove(params.id)
    return { ok: true }
  })

  router.post('/routines/:id/run', async ({ params }: HttpContext) => ({ ok: await automationEngine.trigger(params.id, 'user') }))

  router.get('/routines/:id/runs', async ({ params }: HttpContext) => ({ runs: routines.runs(params.id) }))

  /** Approve a suggestion as proposed, or with one of its alternatives (`alternativeId`). */
  router.post('/routines/:id/approve', async ({ params, request, response }: HttpContext) => {
    const alternativeId = request.input('alternativeId')
    const routine = insightEngine.approveSuggestion(params.id, typeof alternativeId === 'string' ? alternativeId : undefined)
    if (!routine) return response.badRequest({ error: 'Routine ou alternative introuvable' })
    return { routine }
  })

  router.post('/routines/suggest', async () => ({ created: insightEngine.suggestFromHabits() }))

  router.get('/scenes', async () => ({ scenes: scenes.all() }))

  router.post('/scenes', async ({ request }: HttpContext) => ({
    scene: scenes.create({
      name: String(request.input('name', 'Nouvelle scène')),
      icon: request.input('icon', null),
      areaId: request.input('areaId', null),
      entries: request.input('entries', []),
    }),
  }))

  router.post('/scenes/snapshot', async ({ request }: HttpContext) => ({
    id: houseService.snapshotScene(String(request.input('name', 'Scène')), { areaId: request.input('areaId') }, request.input('areaId', null)),
  }))

  router.post('/scenes/:id/activate', async ({ params }: HttpContext) => ({ results: await houseService.applyScene(params.id, { origin: 'user' }) }))

  router.delete('/scenes/:id', async ({ params }: HttpContext) => {
    scenes.remove(params.id)
    return { ok: true }
  })

  /**
   * Force an event the simulated house would otherwise produce rarely: a leak, smoke, a
   * button press. It only reaches the virtual adapter, so it can never make a real sensor
   * lie - and it is the only way to check the alert path end to end without flooding a
   * kitchen.
   */
  router.post('/simulate/:nativeId/:event', async ({ params, response }: HttpContext) => {
    const entry = adapters.list().find((candidate) => candidate.descriptor.id === 'virtual')
    const adapter = entry?.adapter as unknown as { trigger?: (nativeId: string, event: string) => boolean } | undefined
    if (!adapter?.trigger) return response.badRequest({ error: 'The virtual adapter is not running' })
    const ok = adapter.trigger(params.nativeId, params.event)
    return ok ? { ok } : response.notFound({ error: 'Unknown simulated device or event' })
  })

  /**
   * A camera picture, fetched by the hub: the console never holds a camera's login. Nothing
   * is cached, and the answer runs nothing even when it is an SVG.
   */
  router.get('/cameras/:adapter/:nativeId/snapshot', async ({ params, response }: HttpContext) => {
    // The router hands segments over still percent-encoded; an ONVIF id holds a ":" (host:port).
    const segment = (value: unknown) => {
      try {
        return decodeURIComponent(String(value))
      } catch {
        return String(value)
      }
    }
    const answer = await cameraSnapshot(segment(params.adapter), segment(params.nativeId))
    if (!answer.ok) return response.status(answer.status).send({ error: answer.error })
    response.header('content-type', answer.contentType)
    response.header('cache-control', 'no-store')
    response.header('x-content-type-options', 'nosniff')
    response.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    return response.send(Buffer.from(answer.body))
  })

  // -------------------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------------------

  /** Widgets already resolved: one round trip gives the console everything it renders. */
  router.get('/dashboard', async ({ request }: HttpContext) => ({
    widgets: widgetService.all(String(request.input('dashboard', 'home'))),
    vocabulary: widgetService.vocabulary(),
  }))

  router.post('/dashboard/widgets', async ({ request }: HttpContext) => {
    const body = request.body() as Record<string, unknown>
    const widget = widgets.create({
      type: body.type as never,
      title: String(body.title ?? 'Carte'),
      subtitle: (body.subtitle as string) ?? null,
      icon: (body.icon as string) ?? null,
      size: (body.size as never) ?? 'sm',
      source: (body.source as never) ?? { kind: 'house' },
      options: (body.options as never) ?? {},
      authoredBy: 'user',
    })
    return { widget: widgetService.resolve(widget) }
  })

  router.patch('/dashboard/widgets/:id', async ({ params, request }: HttpContext) => {
    const updated = widgets.update(params.id, request.body() as never)
    return updated ? { widget: widgetService.resolve(updated) } : { widget: null }
  })

  router.delete('/dashboard/widgets/:id', async ({ params }: HttpContext) => {
    widgets.remove(params.id)
    return { ok: true }
  })

  router.post('/dashboard/reorder', async ({ request }: HttpContext) => {
    widgets.reorder((request.input('ids', []) as string[]) ?? [])
    return { ok: true }
  })

  /** Resolve a widget declaration without saving it: the preview in the create dialog. */
  router.post('/dashboard/preview', async ({ request }: HttpContext) => {
    const body = request.body() as Record<string, unknown>
    const at = new Date().toISOString()
    return {
      data: widgetService.data({
        id: 'preview',
        dashboardId: 'home',
        type: body.type as never,
        title: String(body.title ?? ''),
        subtitle: null,
        icon: null,
        size: (body.size as never) ?? 'sm',
        position: 0,
        source: (body.source as never) ?? { kind: 'house' },
        options: (body.options as never) ?? {},
        authoredBy: 'user',
        reason: null,
        visible: true,
        createdAt: at,
        updatedAt: at,
      }),
    }
  })

  // -------------------------------------------------------------------------------------
  // What the assistant said on its own
  // -------------------------------------------------------------------------------------

  router.get('/announcements', async () => ({
    announcements: announcements.recent(30),
    pending: announcements.pending(),
    narrator: narrator.status(),
  }))

  router.post('/announcements/:id/acknowledge', async ({ params }: HttpContext) => {
    announcements.acknowledge(params.id)
    return { ok: true }
  })

  router.post('/announcements/acknowledge-all', async () => {
    announcements.acknowledgeAll()
    return { ok: true }
  })

  // -------------------------------------------------------------------------------------
  // Agent
  // -------------------------------------------------------------------------------------

  router.get('/agent/status', async () => ({
    ...agentService.status(),
    providers: PROVIDER_CATALOGUE,
    conversations: conversations.all(20),
  }))

  router.post('/agent/ask', async ({ request }: HttpContext) =>
    agentService.ask(String(request.input('message', '')), {
      conversationId: request.input('conversationId'),
      answers: parseAnswers(request.input('answers')),
      model: typeof request.input('model') === 'string' ? String(request.input('model')).slice(0, 160) : undefined,
      mentions: parseMentions(request.input('mentions')),
    })
  )

  /** The model picker: every model, whether it can run now, and why not when it cannot. */
  router.get('/agent/models', async () => ({ models: liveModelChoices(await probeLocalRunners()) }))

  /** The `/` menu: fixed shortcuts, then the scenes, the active routines and the modes. */
  router.get('/agent/commands', async () => ({ commands: slashCommands() }))

  /**
   * Streaming variant: the same run, with each step pushed as it happens. When the page goes
   * away the run is aborted: it stops between steps, runs no tool on behalf of someone who
   * left, and saves what it did as an interrupted answer.
   */
  router.post('/agent/ask/stream', async ({ request, response }: HttpContext) => {
    const raw = response.response
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })

    const controller = new AbortController()
    raw.on('close', () => {
      if (!raw.writableEnded) controller.abort()
    })
    const write = (payload: unknown) => {
      if (!controller.signal.aborted) raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    const result = await agentService.ask(String(request.input('message', '')), {
      conversationId: request.input('conversationId'),
      answers: parseAnswers(request.input('answers')),
      model: typeof request.input('model') === 'string' ? String(request.input('model')).slice(0, 160) : undefined,
      mentions: parseMentions(request.input('mentions')),
      signal: controller.signal,
      onStep: (step) => write(step),
    })

    write({ kind: 'done', result })
    if (!raw.writableEnded) raw.end()
    return raw
  })

  /**
   * GPT-Live. The browser opens the WebRTC connection, but the SDP exchange is proxied here
   * because the OpenAI key must never reach a page. The session it gets back always uses
   * client delegation, so every tool call still comes back through this hub.
   */
  router.get('/voice/live', async () => liveVoice.status())

  router.post('/voice/live/session', async ({ request, response }: HttpContext) => {
    const result = await liveVoice.connect(String(request.input('sdp', '')))
    if (!result.ok) return response.status(result.status).send({ error: result.error })
    return { sessionId: result.sessionId, sdp: result.sdp }
  })

  router.get('/agent/conversations', async ({ request }: HttpContext) => ({
    conversations: conversations.all(50, {
      archived: request.input('archived') === '1' || request.input('archived') === 'true',
      q: typeof request.input('q') === 'string' ? String(request.input('q')).slice(0, 80) : undefined,
    }),
  }))

  /** Rename, pin, archive: `{ title?, pinned?, archived? }`. */
  router.patch('/agent/conversations/:id', async ({ params, request, response }: HttpContext) => {
    const title = request.input('title')
    const pinned = request.input('pinned')
    const archived = request.input('archived')
    const ok = conversations.update(params.id, {
      title: typeof title === 'string' ? title : undefined,
      pinned: typeof pinned === 'boolean' ? pinned : undefined,
      archived: typeof archived === 'boolean' ? archived : undefined,
    })
    if (!ok) return response.notFound({ error: 'Conversation introuvable' })
    return { ok: true }
  })

  /** Work on a selected passage: `{ text, action: explain|shorten|rephrase|translate|custom, prompt? }`. */
  router.post('/agent/rewrite', async ({ request, response }: HttpContext) => {
    const text = request.input('text')
    const action = request.input('action')
    const prompt = request.input('prompt')
    if (typeof text !== 'string' || text.trim().length === 0) return response.badRequest({ error: 'text manquant' })
    if (!(REWRITE_ACTIONS as readonly string[]).includes(action)) return response.badRequest({ error: 'action inconnue' })
    return agentService.rewrite(text, action as RewriteAction, { prompt: typeof prompt === 'string' ? prompt : undefined })
  })

  /** Thumbs up or down on an answer: `{ value: 'up' | 'down' | null }`. */
  router.post('/agent/messages/:id/feedback', async ({ params, request, response }: HttpContext) => {
    const value = request.input('value')
    if (value !== 'up' && value !== 'down' && value !== null) return response.badRequest({ error: 'value: up, down ou null' })
    const message = agentService.feedback(params.id, value)
    if (!message) return response.notFound({ error: 'Réponse introuvable' })
    return { feedback: message.feedback ?? null }
  })

  router.get('/agent/conversations/:id', async ({ params }: HttpContext) => ({
    messages: messages.forConversation(params.id, 200),
  }))

  router.post('/agent/conversations', async () => ({ id: conversations.create() }))

  router.delete('/agent/conversations/:id', async ({ params }: HttpContext) => {
    conversations.remove(params.id)
    return { ok: true }
  })

  router.post('/agent/autonomy', async ({ request, response }: HttpContext) => {
    const level = String(request.input('level', ''))
    if (!(AUTONOMY_LEVELS as readonly string[]).includes(level)) return response.badRequest({ error: `Unknown autonomy level: ${level}` })
    agentService.setAutonomy(level as never)
    return agentService.status()
  })

  /** Two or three follow-ups for under the last answer: what to ask next, from here. */
  router.get('/agent/suggestions', async ({ request }: HttpContext) => {
    const conversationId = request.input('conversationId', null)
    const after = request.input('after', null) === 'reflex' ? 'reflex' : null
    return { suggestions: followUpsFor(typeof conversationId === 'string' && conversationId.length > 0 ? conversationId : null, { after }) }
  })

  /** What the assistant does on its own: the reflexes, their switches, what they did. */
  router.get('/agent/reflexes', async () => ({ ...autonomyEngine.status(), reflexes: autonomyEngine.reflexSettings() }))

  router.post('/agent/reflexes/:id', async ({ params, request, response }: HttpContext) => {
    if (!autonomyEngine.setReflex(params.id as never, request.input('enabled', true) !== false)) return response.notFound({ error: 'Unknown reflex' })
    return { ...autonomyEngine.status(), reflexes: autonomyEngine.reflexSettings() }
  })

  /** Each proposal with its rows in words: what every device does now and will do after. */
  router.get('/agent/proposals', async () => ({
    proposals: proposals.pending().map((proposal) => ({ ...proposal, changes: describeProposal(proposal) })),
  }))

  router.get('/agent/proposals/:id', async ({ params, response }: HttpContext) => {
    const proposal = proposals.find(params.id)
    if (!proposal) return response.notFound({ error: 'Proposition introuvable' })
    return { proposal: { ...proposal, changes: describeProposal(proposal) } }
  })

  /** `include`: the indexes of the rows kept in the review. Absent, every row runs. */
  router.post('/agent/proposals/:id/approve', async ({ params, request }: HttpContext) => {
    const include = request.input('include')
    return agentService.approveProposal(params.id, {
      include: Array.isArray(include) ? include.filter((index): index is number => Number.isInteger(index)) : undefined,
    })
  })

  router.post('/agent/proposals/:id/reject', async ({ params }: HttpContext) => ({ ok: agentService.rejectProposal(params.id) }))

  router.get('/agent/memories', async () => ({ memories: memories.all(200) }))

  router.post('/agent/memories', async ({ request }: HttpContext) => ({
    memory: memories.remember({
      kind: request.input('kind', 'fact'),
      content: String(request.input('content', '')),
      source: 'stated',
    }),
  }))

  router.delete('/agent/memories/:id', async ({ params }: HttpContext) => {
    memories.forget(params.id)
    return { ok: true }
  })

  router.post('/agent/provider/test', async ({ request }: HttpContext) =>
    agentService.testProvider({
      provider: String(request.input('provider', '')),
      model: request.input('model'),
      apiKey: request.input('apiKey'),
      baseUrl: request.input('baseUrl'),
    })
  )

  router.get('/agent/local-runners', async () => ({ runners: await probeLocalRunners() }))

  // -------------------------------------------------------------------------------------
  // Timeline, alerts, people, settings, energy
  // -------------------------------------------------------------------------------------

  router.get('/events', async ({ request }: HttpContext) => ({
    events: queryEvents({
      limit: Number(request.input('limit', 100)),
      before: request.input('before'),
      types: request.input('types') ? String(request.input('types')).split(',') : undefined,
      subjectId: request.input('subjectId'),
      correlationId: request.input('correlationId'),
    }),
  }))

  router.get('/alerts', async () => ({ alerts: alerts.open() }))

  router.post('/alerts/:id/acknowledge', async ({ params }: HttpContext) => {
    alerts.acknowledge(params.id)
    return { ok: true }
  })

  router.delete('/alerts/:id', async ({ params }: HttpContext) => {
    alerts.dismiss(params.id)
    return { ok: true }
  })

  router.get('/people', async () => ({ people: people.all() }))

  router.post('/people', async ({ request }: HttpContext) => ({ person: people.create({ name: String(request.input('name', 'Quelqu un')) }) }))

  router.patch('/people/:id', async ({ params, request }: HttpContext) => {
    if (request.input('home') !== undefined) {
      const home = request.input('home') === true
      people.setHome(params.id, home)
      const homeCount = people.all().filter((person) => person.home).length
      bus.publish('presence.changed', { subjectType: 'person', subjectId: params.id, origin: 'user', payload: { home, personId: params.id, homeCount } })
    }
    people.update(params.id, { name: request.input('name'), trackerDeviceIds: request.input('trackerDeviceIds') })
    return { ok: true }
  })

  router.delete('/people/:id', async ({ params }: HttpContext) => {
    people.remove(params.id)
    return { ok: true }
  })

  router.get('/energy', async ({ request }: HttpContext) => {
    const days = Number(request.input('days', 7))
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 13)
    const byDevice = database().all(
      'SELECT device_id, SUM(kwh) AS kwh, SUM(cost) AS cost, MAX(max_power) AS peak FROM energy_hourly WHERE hour >= ? GROUP BY device_id ORDER BY kwh DESC',
      [since]
    )
    const byHour = database().all('SELECT hour, SUM(kwh) AS kwh, SUM(cost) AS cost FROM energy_hourly WHERE hour >= ? GROUP BY hour ORDER BY hour', [since])
    const names = new Map(deviceRepository.all({ limit: 1000, includeHidden: true }).map((device) => [device.id, device.name]))
    return {
      days,
      tariff: settings.get('energy', { pricePerKwh: 0.2516, currency: 'EUR' }),
      byDevice: byDevice.map((row) => ({ ...row, name: names.get(String((row as { device_id: string }).device_id)) ?? 'inconnu' })),
      byHour,
      live: houseService.snapshot().power,
    }
  })

  // API keys stay on the hub. The console only learns *whether* a provider has one: a key
  // echoed to a browser is a key in a devtools network log, and this API answers any page
  // on the network. `publicSettings` is the only settings reader exposed here.
  router.get('/settings', async () => publicSettings())

  router.patch('/settings/:key', async ({ params, request }: HttpContext) => {
    const body = request.body() as Record<string, unknown>
    // The agent blob is where the console sends a key; it is routed to the secret store and
    // stripped before anything is written or echoed.
    if (params.key === 'agent') return { value: saveAgentSettings(body) }
    if (params.key === SECRETS_SETTING) {
      for (const [provider, secret] of Object.entries(body)) secrets.set(provider, secret as ProviderSecret)
      return { value: secrets.presence() }
    }
    return { value: settings.patch(params.key, body) }
  })

  router.put('/settings/:key', async ({ params, request }: HttpContext) => {
    if (params.key === 'agent') {
      saveAgentSettings(request.input('value') as Record<string, unknown>)
      return { ok: true }
    }
    settings.set(params.key, request.input('value'))
    return { ok: true }
  })

  // Diagnostics: one endpoint that says whether every moving part is alive.
  router.get('/diagnostics', async () => {
    const counts = deviceRepository.counts()
    return {
      database: { driver: database().name, devices: counts.total, events: Number(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM events')?.n ?? 0) },
      adapters: adapters.list().map((entry) => ({ id: entry.descriptor.id, started: entry.started, ...adapters.statusOf(entry.descriptor.id) })),
      scan: scanService.state(),
      agent: agentService.status(),
      rollups: insightEngine.rollUp(),
      bus: { sockets: bus.socketCount(), listeners: bus.listenerCount() },
      network: adapters.network(),
    }
  })
}).prefix('/api')

// No blanket CORS header on the API: the console reaches it through its own origin (the Nuxt
// proxy), and the origin guard with config/cors.ts decides for everything else.

router.get('/', async () => ({
  name: 'Sway Home hub',
  version: '0.1.0',
  api: '/api',
  stream: '/api/stream',
  docs: '/api/meta',
}))
