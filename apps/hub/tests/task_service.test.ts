/**
 * The work the hub is doing, as a list of tasks.
 *
 * A network scan takes a minute, a routine with a delay takes ten, a pairing blocks until the
 * accessory answers. The console shows them as task rows: a progress ring, the steps, the
 * failure with a retry, the cancel. These tests pin the registry and the two producers that
 * feed it the most: the scan (its phases become steps) and the routine runs (their actions
 * become steps, and each one is now announced on the bus as it runs).
 *
 * Retry payloads stay inside the hub: a pairing retry holds a setup code, and nothing that
 * leaves over HTTP may carry one.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { HouseEvent } from '@sway-home/shared'
import { tasks, scanPhaseState, SCAN_PHASES } from '#services/task_service'
import { automationEngine } from '#services/automation_engine'
import { adapters } from '#services/adapter_manager'
import { bus } from '#services/event_bus'
import { routines } from '#repositories/store'
import { dropDatabase, freshDatabase, seedHouse, type TestHouse } from './helpers.ts'
import { FakeAdapter } from './fake_adapter.ts'

const adapter = new FakeAdapter()
let fixture: TestHouse

beforeEach(async () => {
  await freshDatabase()
  adapter.reset()
  fixture = seedHouse()
  adapters.register(adapter)
  await adapters.start('test')
  tasks.reset()
})

afterAll(dropDatabase)

const offs: (() => void)[] = []
afterEach(() => {
  for (const off of offs.splice(0)) off()
})

function listen(type: string): HouseEvent[] {
  const seen: HouseEvent[] = []
  offs.push(bus.on(type, (event) => void seen.push(event)))
  return seen
}

describe('the task registry', () => {
  test('a task moves through its steps and ends done, and every change is broadcast', () => {
    const updates = listen('task.updated')
    const task = tasks.start({ kind: 'routine', title: 'Réveil en douceur', steps: ['Ouvrir le volet', 'Allumer la lampe'] })

    task.step(0, 'running')
    task.step(0, 'done')
    task.step(1, 'running', 'à 30 %')
    task.progress(0.75)
    task.done('2 actions')

    const [view] = tasks.list()
    expect(view?.status).toBe('done')
    expect(view?.subtitle).toBe('2 actions')
    expect(view?.progress).toBe(1)
    expect(view?.steps.map((step) => step.status)).toEqual(['done', 'done'])
    expect(view?.steps[1]?.detail).toBe('à 30 %')
    expect(view?.finishedAt).not.toBeNull()
    expect(updates.length).toBeGreaterThanOrEqual(6)
    expect((updates.at(-1)?.payload as { status?: string }).status).toBe('done')
  })

  test('a failed task keeps its error and the step that failed', () => {
    const task = tasks.start({ kind: 'scan', title: 'Scan du réseau', steps: ['ARP', 'mDNS'] })
    task.step(0, 'done')
    task.step(1, 'running')
    task.fail('Interface introuvable')

    const [view] = tasks.list()
    expect(view?.status).toBe('failed')
    expect(view?.error).toBe('Interface introuvable')
    expect(view?.steps.map((step) => step.status)).toEqual(['done', 'failed'])
  })

  test('retry runs the same work again, from what the hub kept, and the payload never leaves', async () => {
    const received: unknown[] = []
    tasks.registerRunner('pairing', async (payload) => {
      received.push(payload)
    })
    const task = tasks.start({ kind: 'pairing', title: 'Appairage HomeKit', retry: { code: '123-45-678' } })
    task.fail('Code refusé')

    expect(JSON.stringify(tasks.list())).not.toContain('123-45-678')
    expect(tasks.list()[0]?.retryable).toBe(true)

    expect(await tasks.retry(task.id)).toBe(true)
    expect(received).toEqual([{ code: '123-45-678' }])
  })

  test('only a failed or cancelled task with a runner can be retried', async () => {
    const running = tasks.start({ kind: 'scan', title: 'Scan', retry: {} })
    expect(await tasks.retry(running.id)).toBe(false)
    const orphan = tasks.start({ kind: 'agent', title: 'Sans lanceur', retry: {} })
    orphan.fail('x')
    expect(await tasks.retry(orphan.id)).toBe(false)
    expect(await tasks.retry('missing')).toBe(false)
  })

  test('cancel asks the work to stop, once', () => {
    let stopped = 0
    const task = tasks.start({ kind: 'scan', title: 'Scan', onCancel: () => (stopped += 1) })

    expect(tasks.list()[0]?.cancellable).toBe(true)
    expect(tasks.cancel(task.id)).toBe(true)
    expect(tasks.list()[0]?.status).toBe('cancelled')
    expect(tasks.cancel(task.id)).toBe(false)
    expect(stopped).toBe(1)
  })

  test('running tasks come first, then the latest finished ones, twenty at most', () => {
    for (let index = 0; index < 25; index += 1) tasks.start({ kind: 'agent', title: `Fini ${index}` }).done()
    tasks.start({ kind: 'scan', title: 'En cours' })

    const list = tasks.list()
    expect(list).toHaveLength(20)
    expect(list[0]?.title).toBe('En cours')
    expect(list[1]?.title).toBe('Fini 24')
  })

  test('an update after the end is ignored', () => {
    const task = tasks.start({ kind: 'agent', title: 'x', steps: ['a'] })
    task.done()
    task.fail('trop tard')
    task.step(0, 'failed')
    expect(tasks.list()[0]?.status).toBe('done')
    expect(tasks.list()[0]?.steps[0]?.status).toBe('done')
  })
})

describe('a network scan as a task', () => {
  test('the phases are the steps, and progress moves within a phase', () => {
    expect(SCAN_PHASES.map((phase) => phase.label)).toEqual(['Table ARP', 'mDNS', 'SSDP', 'Balayage TCP', 'Ports étendus', 'Noms', 'Pages web', 'Empreintes'])

    const state = scanPhaseState({ phase: 'sweep', done: 127, total: 254, found: 9 })
    expect(state.index).toBe(3)
    expect(state.detail).toBe('127/254, 9 hôtes')
    expect(state.progress).toBeCloseTo((3 + 0.5) / 8, 5)
  })

  test('a finished phase with nothing to count says only what it found', () => {
    expect(scanPhaseState({ phase: 'arp', done: 1, total: 1, found: 4 }).detail).toBe('4 hôtes')
  })
})

describe('a routine run as a task', () => {
  test('each action is a step, announced on the bus as it runs', async () => {
    const actions = listen('automation.action_run')
    const routine = routines.create({
      name: 'Soirée',
      status: 'active',
      enabled: true,
      mode: 'single',
      authoredBy: 'user',
      triggers: [{ kind: 'manual' }],
      conditions: [],
      actions: [
        { kind: 'device_command', deviceId: fixture.devices.lamp, command: 'turnOn', args: {} },
        { kind: 'delay', seconds: 0 },
        { kind: 'device_command', deviceId: fixture.devices.plug, command: 'turnOff', args: {} },
      ],
    } as never)

    await automationEngine.trigger(routine.id, 'user')

    const task = tasks.list().find((entry) => entry.kind === 'routine')
    expect(task?.title).toBe('Soirée')
    expect(task?.status).toBe('done')
    expect(task?.steps.map((step) => step.label)).toEqual(['Plafonnier salon : allumer', 'Attendre 0 s', 'Prise bureau : éteindre'])
    expect(task?.steps.map((step) => step.status)).toEqual(['done', 'done', 'done'])
    expect(actions.map((event) => (event.payload as { index: number }).index)).toEqual([0, 1, 2])
    expect(task?.retryable).toBe(false)
  })

  test('an action that fails fails the task, and says how many', async () => {
    const routine = routines.create({
      name: 'Cassée',
      status: 'active',
      enabled: true,
      mode: 'single',
      authoredBy: 'user',
      triggers: [{ kind: 'manual' }],
      conditions: [],
      actions: [
        { kind: 'device_command', deviceId: 'gone', command: 'turnOn', args: {} },
        { kind: 'device_command', deviceId: fixture.devices.lamp, command: 'turnOn', args: {} },
      ],
    } as never)

    await automationEngine.trigger(routine.id, 'user')

    const task = tasks.list().find((entry) => entry.kind === 'routine')
    expect(task?.status).toBe('failed')
    expect(task?.error).toBe('1 action en échec')
    expect(task?.steps.map((step) => step.status)).toEqual(['failed', 'done'])
    expect(task?.retryable).toBe(true)
  })
})
