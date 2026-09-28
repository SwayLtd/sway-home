/**
 * The assistant acting on its own, end to end: real database, real house service, a fake
 * adapter that records what reached the devices.
 *
 * What is pinned down is what a person would live with: at the default level the heating of
 * a room goes off by itself two minutes after its window opens, the chat says so with a way
 * to undo it, and the heating comes back when the window closes. At the "assistant" level
 * the same situation becomes a question and nothing moves until yes. A person who turns a
 * light back on wins for three hours. Locks are never touched unprompted, at any level.
 * Safety reflexes ignore the hourly budget; comfort ones respect it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { adapters } from '#services/adapter_manager'
import { autonomyEngine } from '#services/autonomy_engine'
import { houseService } from '#services/house'
import { agentService } from '#agent/agent_service'
import { deviceRepository } from '#repositories/device_repository'
import { proposals, settings, undo } from '#repositories/store'
import { announcements } from '#repositories/widget_repository'
import { bus } from '#services/event_bus'
import type { HouseEvent } from '@sway-home/shared'
import { dropDatabase, freshDatabase, makeDevice, seedHouse, type TestHouse } from './helpers.ts'
import { FakeAdapter } from './fake_adapter.ts'

const MIN = 60_000
const later = (minutes: number) => new Date(Date.now() + minutes * MIN)

const adapter = new FakeAdapter()
let fixture: TestHouse
let windowId: string

beforeAll(() => autonomyEngine.listen())
afterAll(() => {
  autonomyEngine.stop()
  dropDatabase()
})

beforeEach(async () => {
  await freshDatabase()
  adapter.reset()
  autonomyEngine.reset()
  fixture = seedHouse()
  adapters.register(adapter)
  await adapters.start('test')
  adapter.setState('thermo', { hvacMode: 'heat', targetTemperature: 20 })
  adapter.setState('lamp', { on: false })
  adapter.setState('lock', { locked: true })
  windowId = makeDevice({ nativeId: 'window', name: 'Fenêtre salon', category: 'sensor', capabilities: ['contact'], state: { open: true }, areaId: fixture.areas.salon })
})

function commandsTo(nativeId: string): { command: string; args: Record<string, unknown> }[] {
  return adapter.commandsFor(nativeId).map(({ command, args }) => ({ command, args }))
}

describe('at the default level it acts, says so, and can be undone', () => {
  test('the level out of the box acts on its own', () => {
    expect(agentService.status().autonomy).toBe('copilot')
  })

  test('a window open for two minutes turns the heating of that room off', async () => {
    const seen: HouseEvent[] = []
    const off = bus.on('device.command_sent', (event) => void seen.push(event))
    const outcomes = await autonomyEngine.evaluate(later(3))
    off()

    expect(commandsTo('thermo')).toEqual([{ command: 'setHvacMode', args: { mode: 'off' } }])
    expect(outcomes.map((outcome) => [outcome.reflex, outcome.action])).toEqual([['window_heating', 'done']])
    expect(seen[0]).toMatchObject({ origin: 'agent', originDetail: 'reflex:window_heating' })

    const [said] = announcements.pending()
    expect(said?.text).toContain('chauffage coupé')
    expect(said?.payload).toMatchObject({ reflex: 'window_heating', action: 'reflex-done' })
    expect(typeof said?.payload.undoId).toBe('string')
  })

  test('its undo puts the heating back the way it was', async () => {
    const [outcome] = await autonomyEngine.evaluate(later(3))
    expect(undo.stack(5).find((entry) => entry.id === outcome?.undoId)?.commands).toEqual([
      { deviceId: fixture.devices.thermostat, command: 'setHvacMode', args: { mode: 'heat' } },
    ])
    const result = await houseService.undo(outcome!.undoId!)
    expect(result.ok).toBe(true)
    expect(commandsTo('thermo').at(-1)).toEqual({ command: 'setHvacMode', args: { mode: 'heat' } })
  })

  test('nothing is done twice while the window stays open, and closing it brings the heating back', async () => {
    await autonomyEngine.evaluate(later(3))
    await autonomyEngine.evaluate(later(4))
    expect(commandsTo('thermo')).toHaveLength(1)

    adapter.push('window', { open: false })
    const outcomes = await autonomyEngine.evaluate(later(2))
    expect(outcomes.map((outcome) => outcome.action)).toEqual(['restored'])
    expect(commandsTo('thermo')).toEqual([
      { command: 'setHvacMode', args: { mode: 'off' } },
      { command: 'setHvacMode', args: { mode: 'heat' } },
    ])
    expect(announcements.pending()[0]?.text).toContain('chauffage rallumé')
  })
})

describe('below copilot it asks instead', () => {
  test('the same window becomes a question, and nothing moves until yes', async () => {
    agentService.setAutonomy('assistant')
    const [outcome] = await autonomyEngine.evaluate(later(3))
    expect(outcome?.action).toBe('asked')
    expect(commandsTo('thermo')).toEqual([])

    const [proposal] = proposals.pending()
    expect(proposal?.commands).toEqual([{ deviceId: fixture.devices.thermostat, deviceName: 'Thermostat salon', command: 'setHvacMode', args: { mode: 'off' } }])
    const [said] = announcements.pending()
    expect(said?.text).toMatch(/\?$/)
    expect(said?.payload.proposalId).toBe(proposal!.id)

    await autonomyEngine.evaluate(later(5))
    expect(proposals.pending()).toHaveLength(1)

    await agentService.approveProposal(proposal!.id)
    expect(commandsTo('thermo')).toEqual([{ command: 'setHvacMode', args: { mode: 'off' } }])
  })
})

describe('the person always wins', () => {
  test('a light turned back on by hand is not switched off again for three hours', async () => {
    const bedside = makeDevice({ nativeId: 'chevet', name: 'Lampe chevet', category: 'light', capabilities: ['onoff'], state: { on: true }, areaId: fixture.areas.chambre })
    adapter.setState('chevet', { on: true })
    deviceRepository.mergeState(windowId, { open: false })

    await autonomyEngine.evaluate(later(40))
    expect(commandsTo('chevet')).toEqual([{ command: 'turnOff', args: {} }])

    await houseService.execute(bedside, 'turnOn', {}, { origin: 'user' })
    await autonomyEngine.evaluate(later(80))
    expect(commandsTo('chevet').map((entry) => entry.command)).toEqual(['turnOff', 'turnOn'])

    await autonomyEngine.evaluate(later(4 * 60))
    expect(commandsTo('chevet').map((entry) => entry.command)).toEqual(['turnOff', 'turnOn', 'turnOff'])
  })

  test('locks are never touched unprompted, even at autopilot', async () => {
    agentService.setAutonomy('autopilot')
    deviceRepository.mergeState(fixture.devices.lock, { locked: false })
    deviceRepository.mergeState(windowId, { open: false })
    houseService.setMode('away')

    await autonomyEngine.evaluate(later(15))
    expect(commandsTo('thermo')).toEqual([{ command: 'setTargetTemperature', args: { celsius: 16 } }])
    expect(commandsTo('lock')).toEqual([])
    expect(proposals.pending().flatMap((proposal) => proposal.commands.map((command) => command.command))).toEqual(['lock'])
  })
})

describe('budgets and switches', () => {
  test('safety ignores the hourly budget, comfort does not', async () => {
    settings.patch('agent', { proactivity: { maxUnpromptedActionsPerHour: 0 } })
    makeDevice({ nativeId: 'valve', name: "Vanne d'arrivée", category: 'appliance', capabilities: ['valve'], state: { valveOpen: true }, areaId: fixture.areas.salon })
    deviceRepository.mergeState(fixture.devices.leak, { leak: true })

    await autonomyEngine.evaluate(later(3))
    expect(commandsTo('valve')).toEqual([{ command: 'closeValve', args: {} }])
    expect(commandsTo('thermo')).toEqual([])
    expect(proposals.pending()).toEqual([])
  })

  test('a switched-off reflex stays quiet, and the switch is remembered', async () => {
    autonomyEngine.setReflex('window_heating', false)
    expect(await autonomyEngine.evaluate(later(3))).toEqual([])
    expect(commandsTo('thermo')).toEqual([])
    expect(autonomyEngine.reflexSettings().find((reflex) => reflex.id === 'window_heating')?.enabled).toBe(false)
  })

  test('its status says what it does alone and what it did today', async () => {
    await autonomyEngine.evaluate(later(3))
    const status = autonomyEngine.status()
    expect(status.actsAlone).toBe(true)
    expect(status.enabled).toContain('window_heating')
    expect(status.today).toBe(1)
    expect(status.recent[0]?.text).toContain('chauffage coupé')
  })
})
