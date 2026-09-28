/**
 * Reviewing a proposal line by line.
 *
 * A proposal that switches off five lights is five changes, and the person reviewing it may
 * want four. The console shows each command as a row with what the device does now and what
 * it will do (the DiffTable), each row can be left out, and approving runs only the rows that
 * were kept. A row left out is also a lesson: the assistant remembers it, so the same light
 * is not proposed again tomorrow.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { agentService } from '#agent/agent_service'
import { describeProposal } from '#agent/proposal_changes'
import { adapters } from '#services/adapter_manager'
import { memories, proposals, settings } from '#repositories/store'
import { deviceRepository } from '#repositories/device_repository'
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
  settings.set('agent', { autonomy: 'assistant', llm: { provider: 'none', model: '', temperature: 0.3, maxSteps: 8, dailyBudgetUsd: 2 } })
})

afterAll(dropDatabase)

function threeCommands() {
  return proposals.create({
    summary: 'Tout couper dans le salon',
    reason: 'Personne à la maison.',
    risk: 'medium',
    routine: null,
    commands: [
      { deviceId: fixture.devices.lamp, deviceName: 'Plafonnier salon', command: 'turnOff', args: {} },
      { deviceId: fixture.devices.plug, deviceName: 'Prise bureau', command: 'turnOff', args: {} },
      { deviceId: fixture.devices.thermostat, deviceName: 'Thermostat salon', command: 'setTargetTemperature', args: { temperature: 17 } },
    ],
  })
}

describe('approving part of a proposal', () => {
  test('runs only the rows that were kept', async () => {
    const proposal = threeCommands()

    const result = await agentService.approveProposal(proposal.id, { include: [1] })

    expect(result.ok).toBe(true)
    expect(result.ran).toBe(1)
    expect(adapter.commandsFor('plug').map((entry) => entry.command)).toEqual(['turnOff'])
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
    expect(adapter.commandsFor('thermo')).toHaveLength(0)
    expect(proposals.find(proposal.id)?.status).toBe('executed')
  })

  test('without a selection, every row runs, as before', async () => {
    const proposal = threeCommands()
    const result = await agentService.approveProposal(proposal.id)
    expect(result.ran).toBe(3)
  })

  test('an empty or meaningless selection runs nothing and leaves the proposal open', async () => {
    const proposal = threeCommands()

    expect(await agentService.approveProposal(proposal.id, { include: [] })).toEqual({ ok: false, ran: 0 })
    expect(await agentService.approveProposal(proposal.id, { include: [7, -1] })).toEqual({ ok: false, ran: 0 })

    expect(adapter.commands).toHaveLength(0)
    expect(proposals.find(proposal.id)?.status).toBe('pending')
  })

  test('a row left out is remembered as a correction', async () => {
    const proposal = threeCommands()

    await agentService.approveProposal(proposal.id, { include: [0, 2] })

    const corrections = memories.all().filter((memory) => memory.kind === 'correction')
    expect(corrections).toHaveLength(1)
    expect(corrections[0]?.content).toContain('Prise bureau')
  })
})

describe('what each row of a proposal changes', () => {
  test('a row says what the device does now and what it will do', () => {
    deviceRepository.mergeState(fixture.devices.lamp, { on: true }, null)
    deviceRepository.mergeState(fixture.devices.thermostat, { targetTemperature: 20 }, null)
    const proposal = proposals.create({
      summary: 'Soirée',
      reason: 'Demandé.',
      risk: 'high',
      routine: null,
      commands: [
        { deviceId: fixture.devices.lamp, deviceName: 'Plafonnier salon', command: 'turnOff', args: {} },
        { deviceId: fixture.devices.thermostat, deviceName: 'Thermostat salon', command: 'setTargetTemperature', args: { temperature: 21.5 } },
        { deviceId: fixture.devices.lock, deviceName: 'Serrure entrée', command: 'unlock', args: {} },
        { deviceId: fixture.devices.lamp, deviceName: 'Plafonnier salon', command: 'setBrightness', args: { brightness: 30 } },
      ],
    })

    const rows = describeProposal(proposal)

    expect(rows.map((row) => row.index)).toEqual([0, 1, 2, 3])
    expect(rows.map((row) => [row.before, row.after])).toEqual([
      ['allumé', 'éteint'],
      ['20 °C', '21,5 °C'],
      ['verrouillé', 'déverrouillé'],
      ['60 %', '30 %'],
    ])
    expect(rows[0]?.deviceName).toBe('Plafonnier salon')
    expect(rows[0]?.label).toBe('Éteindre')
    expect(rows[1]?.label).toBe('Régler la consigne')
    expect(rows[2]?.label).toBe('Déverrouiller')
    expect(rows[2]?.area).toBe('Salon')
  })

  test('a device that no longer exists is still listed, with nothing known about it', () => {
    const proposal = proposals.create({
      summary: 'x',
      reason: 'y',
      risk: 'low',
      routine: null,
      commands: [{ deviceId: 'gone', deviceName: 'Ancienne lampe', command: 'turnOn', args: {} }],
    })

    const [row] = describeProposal(proposal)

    expect(row?.deviceName).toBe('Ancienne lampe')
    expect(row?.before).toBeNull()
    expect(row?.after).toBe('allumé')
  })
})
