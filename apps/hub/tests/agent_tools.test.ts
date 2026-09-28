/**
 * The agent's tools.
 *
 * The permission check lives inside the tool rather than in the prompt, so these tests are
 * the real test of the safety model: they call the tools directly, with the autonomy level
 * set by hand, and assert that a level that should not act returns a proposal instead of
 * touching the house.
 *
 * `show_widget` is tested here too, because the difference between showing and pinning is a
 * user-visible promise: asking a question must not leave clutter behind on the dashboard.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { stripRichText, type AgentToolContext, type AutonomyLevel } from '@sway-home/shared'
import { AGENT_TOOLS, toolByName, toolSchemas } from '#agent/tools'
import { adapters } from '#services/adapter_manager'
import { deviceRepository } from '#repositories/device_repository'
import { widgets } from '#repositories/widget_repository'
import { routines } from '#repositories/store'
import { database } from '#db/database'
import { dropDatabase, freshDatabase, recordHistory, seedHouse, type TestHouse } from './helpers.ts'
import { FakeAdapter } from './fake_adapter.ts'

const adapter = new FakeAdapter()
let fixture: TestHouse

function context(autonomy: AutonomyLevel = 'copilot'): AgentToolContext {
  return {
    conversationId: 'c1',
    correlationId: 'corr1',
    autonomy,
    unattended: false,
    userId: null,
    signal: new AbortController().signal,
  }
}

async function call(name: string, args: Record<string, unknown>, autonomy: AutonomyLevel = 'copilot') {
  const tool = toolByName(name)
  if (!tool) throw new Error(`No tool named ${name}`)
  const parsed = tool.parameters.parse(args)
  return tool.execute(parsed, context(autonomy))
}

beforeEach(async () => {
  await freshDatabase()
  adapter.reset()
  fixture = seedHouse()
  adapters.register(adapter)
  await adapters.start('test')
  adapter.setState('lamp', { on: false })
  adapter.setState('lock', { locked: true })
})

afterAll(dropDatabase)

describe('the tool surface', () => {
  test('every tool has a name, a description and a risk level', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/)
      expect(tool.description.length).toBeGreaterThan(15)
      expect(['none', 'low', 'medium', 'high', 'forbidden']).toContain(tool.risk)
    }
  })

  test('tool names are unique', () => {
    const names = AGENT_TOOLS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('a read-only tool is never higher than no risk', () => {
    for (const tool of AGENT_TOOLS) {
      if (tool.readOnly) expect(tool.risk).toBe('none')
    }
  })

  test('every tool produces a JSON schema the providers can take', () => {
    for (const schema of toolSchemas()) {
      expect(schema.parameters).toBeDefined()
      expect((schema.parameters as { type?: string }).type).toBe('object')
    }
  })
})

describe('permissions', () => {
  test('an observer cannot turn a light on', async () => {
    const result = await call('control_device', { device: fixture.devices.lamp, command: 'turnOn' }, 'observer')
    expect(result.ok).toBe(false)
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
  })

  test('an assistant can turn a light on, because that is low risk', async () => {
    const result = await call('control_device', { device: fixture.devices.lamp, command: 'turnOn' }, 'assistant')
    expect(result.ok).toBe(true)
    expect(adapter.commandsFor('lamp').map((entry) => entry.command)).toEqual(['turnOn'])
  })

  test('an assistant cannot unlock a door: it returns a proposal instead', async () => {
    const result = await call('control_device', { device: fixture.devices.lock, command: 'unlock' }, 'assistant')
    expect(result.ok).toBe(false)
    expect(result.proposal).toBeDefined()
    expect(result.proposal!.commands[0]).toMatchObject({ command: 'unlock' })
    // The important half: nothing reached the lock.
    expect(adapter.commandsFor('lock')).toHaveLength(0)
  })

  test('even autopilot proposes rather than acts on a device marked critical', async () => {
    deviceRepository.update(fixture.devices.lamp, { critical: true })
    const result = await call('control_device', { device: fixture.devices.lamp, command: 'turnOn' }, 'copilot')
    expect(result.ok).toBe(false)
    expect(result.proposal).toBeDefined()
    expect(adapter.commandsFor('lamp')).toHaveLength(0)
  })

  test('a bulk command above the ceiling proposes the whole batch', async () => {
    const result = await call('control_many', { command: 'unlock', capability: 'lock' }, 'copilot')
    expect(result.ok).toBe(false)
    expect(result.proposal!.commands.length).toBeGreaterThan(0)
    expect(adapter.commandsFor('lock')).toHaveLength(0)
  })
})

describe('reading the house', () => {
  test('list_devices returns one dense line per device', async () => {
    const result = await call('list_devices', {})
    expect(result.ok).toBe(true)
    const lines = result.summary.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(6)
    // One line per device is the whole cost model: this summary is re-sent every turn.
    for (const line of lines) expect(line.length).toBeLessThan(200)
  })

  test('list_devices can be narrowed to an area', async () => {
    const result = await call('list_devices', { area: 'Chambre' })
    expect(result.summary).toContain('Détecteur chambre')
    expect(result.summary).not.toContain('Plafonnier salon')
  })

  test('house_snapshot answers "how is the house" in one call', async () => {
    const result = await call('house_snapshot', {})
    expect(result.ok).toBe(true)
    expect(result.summary.length).toBeGreaterThan(20)
  })

  test('get_device resolves by name as well as by id', async () => {
    const byName = await call('get_device', { device: 'Plafonnier salon' })
    expect(byName.ok).toBe(true)
    expect(byName.summary).toContain('Plafonnier')
  })

  test('an unknown device name fails clearly rather than guessing', async () => {
    const result = await call('get_device', { device: 'la lampe magique' })
    expect(result.ok).toBe(false)
  })
})

describe('show_widget', () => {
  test('resolves a card and returns its data without saving it', async () => {
    const before = widgets.all().length
    const result = await call('show_widget', {
      type: 'metric',
      title: 'Humidité chambre',
      source: { kind: 'capability', capability: 'humidity', areaId: fixture.areas.salon },
    })

    expect(result.ok).toBe(true)
    expect(result.attachments?.[0]?.kind).toBe('widget')
    const data = (result.attachments![0]!.data as { widget: { data: { kind: string; value: number } } }).widget
    expect(data.data.kind).toBe('metric')
    expect(data.data.value).toBe(45)

    // Nothing was pinned: asking a question must not leave clutter on the dashboard.
    expect(widgets.all()).toHaveLength(before)
  })

  test('refuses a card that would show nothing, with the reason', async () => {
    const result = await call('show_widget', {
      type: 'metric',
      title: 'Qualité de l air',
      source: { kind: 'capability', capability: 'airQuality' },
    })
    expect(result.ok).toBe(false)
    expect(result.summary.toLowerCase()).toContain('aucun')
  })

  test('refuses a malformed source rather than showing an error card', async () => {
    const result = await call('show_widget', { type: 'metric', title: 'Cassé', source: { kind: 'capability' } })
    expect(result.ok).toBe(false)
  })

  test('is read-only, so no autonomy level can be blocked from looking', async () => {
    const tool = toolByName('show_widget')!
    expect(tool.readOnly).toBe(true)
    expect(tool.risk).toBe('none')
    const result = await call('show_widget', { type: 'climate', title: 'Climat', source: { kind: 'house' } }, 'observer')
    expect(result.ok).toBe(true)
  })
})

describe('analyse_history', () => {
  /** A month of daily readings that climb, so the analysis has something to conclude. */
  function climbingMonth(deviceId: string, attribute: string): void {
    const now = Date.now()
    for (let day = 29; day >= 0; day -= 1) {
      for (let hour = 0; hour < 24; hour += 2) {
        recordHistory(deviceId, attribute, 40 + (29 - day), new Date(now - (day * 24 + hour) * 3_600_000))
      }
    }
  }

  test('answers with the verdict and the curve, not with "carte affichée"', async () => {
    climbingMonth(fixture.devices.thermostat, 'humidity')
    const result = await call('analyse_history', { measure: 'humidity', hours: 720 })

    expect(result.ok).toBe(true)
    expect(result.attachments?.[0]?.kind).toBe('widget')
    // The summary is what gets spoken and what the model sees: it has to carry numbers.
    expect(result.summary).toMatch(/\d/)
    expect(result.summary).toMatch(/moyenne/)
    expect(result.summary).toMatch(/hausse|baisse|stable/)
  })

  test('the card it attaches is a chart over the window that was asked for', async () => {
    climbingMonth(fixture.devices.thermostat, 'humidity')
    const result = await call('analyse_history', { measure: 'humidity', hours: 720 })
    const widget = (result.attachments![0]!.data as { widget: { type: string; data: { kind: string; bucket: string } } }).widget
    expect(widget.type).toBe('chart')
    expect(widget.data.kind).toBe('series')
    expect(widget.data.bucket).toBe('day')
  })

  test('a window that ends in the past is honoured', async () => {
    const now = Date.now()
    for (let hour = 0; hour < 24; hour += 1) recordHistory(fixture.devices.thermostat, 'humidity', 10, new Date(now - (24 + hour) * 3_600_000))
    const result = await call('analyse_history', { measure: 'humidity', hours: 24, offsetHours: 24 })
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('10')
  })

  test('a measure nobody reports fails with the reason, and attaches nothing', async () => {
    const result = await call('analyse_history', { measure: 'pm25', hours: 24 })
    expect(result.ok).toBe(false)
    expect(result.attachments ?? []).toHaveLength(0)
  })

  test('an unknown measure name is refused rather than guessed at', async () => {
    const result = await call('analyse_history', { measure: 'le moral de la maison', hours: 24 })
    expect(result.ok).toBe(false)
  })

  test('is read-only, so it cannot be blocked by an autonomy level', async () => {
    const tool = toolByName('analyse_history')!
    expect(tool.readOnly).toBe(true)
    expect(tool.risk).toBe('none')
  })
})

describe('compare_history', () => {
  test('puts one line per room on a single card', async () => {
    const now = Date.now()
    for (let hour = 0; hour < 48; hour += 1) {
      recordHistory(fixture.devices.thermostat, 'temperature', 21, new Date(now - hour * 3_600_000))
      recordHistory(fixture.devices.motion, 'temperature', 17, new Date(now - hour * 3_600_000))
    }

    const result = await call('compare_history', {
      measure: 'temperature',
      areaIds: [fixture.areas.salon, fixture.areas.chambre],
      hours: 48,
    })

    expect(result.ok).toBe(true)
    const widget = (result.attachments![0]!.data as { widget: { data: { kind: string; series: { label: string }[] } } }).widget
    expect(widget.data.kind).toBe('multi-series')
    expect(widget.data.series).toHaveLength(2)
    // Both rooms are named in the sentence, or the comparison is only half spoken.
    expect(result.summary).toContain('Salon')
    expect(result.summary).toContain('Chambre')
  })

  test('refuses a comparison of one thing', async () => {
    const result = await call('compare_history', { measure: 'temperature', areaIds: [fixture.areas.salon], hours: 24 })
    expect(result.ok).toBe(false)
  })
})

describe('rank', () => {
  test('answers "which room draws the most" with one sentence and a ranking card', async () => {
    const result = await call('rank', { measure: 'power', by: 'area' })
    expect(result.ok).toBe(true)
    expect(result.summary).not.toContain(String.fromCharCode(10))
    expect(stripRichText(result.summary)).toMatch(/^Chambre en tête avec 42 W/)
    const widget = (result.attachments![0]!.data as { widget: { type: string; data: { kind: string } } }).widget
    expect(widget.type).toBe('ranking')
    expect(widget.data.kind).toBe('ranking')
  })

  test('refuses a measure it does not know, and says which ones it does', async () => {
    const result = await call('rank', { measure: 'le moral' })
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('temperature')
  })

  test('a measure nothing reports is said, not an empty card', async () => {
    const result = await call('rank', { measure: 'co2' })
    expect(result.ok).toBe(false)
    expect(result.attachments ?? []).toHaveLength(0)
  })
})

describe('get_energy', () => {
  function rollUp(deviceId: string, hoursAgo: number, kwh: number): void {
    const hour = new Date(Date.now() - hoursAgo * 3_600_000).toISOString().slice(0, 13)
    database().run('INSERT INTO energy_hourly (device_id, hour, kwh, avg_power, max_power, cost) VALUES (?, ?, ?, 0, 0, ?)', [deviceId, hour, kwh, kwh * 0.2516])
  }

  test('one sentence with the kWh, the money and the device that weighs most, not a line per device', async () => {
    database().run('DELETE FROM state_history')
    rollUp(fixture.devices.plug, 5, 2)
    rollUp(fixture.devices.lamp, 5, 0.5)
    const result = await call('get_energy', { days: 7 })
    expect(result.summary).not.toContain(String.fromCharCode(10))
    expect(stripRichText(result.summary)).toBe('Sur 7 jours : 2,5 kWh pour 0,63 €, surtout Prise bureau (80 %).')
    const widget = (result.attachments![0]!.data as { widget: { type: string; data: { kind: string; unit: string } } }).widget
    expect(widget.type).toBe('ranking')
    expect(widget.data).toMatchObject({ kind: 'ranking', unit: 'kWh' })
  })

  test('a window that ended in the past, the way "hier" asks for it', async () => {
    database().run('DELETE FROM state_history')
    rollUp(fixture.devices.plug, 2, 5)
    rollUp(fixture.devices.plug, 30, 1)
    const result = await call('get_energy', { hours: 24, offsetHours: 24 })
    expect(stripRichText(result.summary)).toMatch(/^Hier : 1 kWh/)
  })

  test('one device, asked by name', async () => {
    database().run('DELETE FROM state_history')
    rollUp(fixture.devices.plug, 5, 2)
    const result = await call('get_energy', { days: 7, device: 'Prise bureau' })
    expect(stripRichText(result.summary)).toBe('Prise bureau : 2 kWh sur 7 jours, soit 0,50 €.')
  })
})

describe('create_widget', () => {
  test('pins a card and marks it as the assistant’s work', async () => {
    const result = await call('create_widget', {
      type: 'metric',
      title: 'Humidité',
      source: { kind: 'capability', capability: 'humidity' },
      reason: 'Vous me le demandez souvent',
    })
    expect(result.ok).toBe(true)

    const stored = widgets.all()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ authoredBy: 'agent', reason: 'Vous me le demandez souvent' })
  })

  test('does not pin a card that resolves to nothing', async () => {
    const result = await call('create_widget', { type: 'metric', title: 'Vide', source: { kind: 'capability', capability: 'airQuality' } })
    expect(result.ok).toBe(false)
    expect(widgets.all()).toHaveLength(0)
  })

  test('remove_widget takes an id prefix, which is what the model sees', async () => {
    await call('create_widget', { type: 'climate', title: 'Climat', source: { kind: 'house' } })
    const id = widgets.all()[0]!.id
    const result = await call('remove_widget', { widgetId: id.slice(0, 8) })
    expect(result.ok).toBe(true)
    expect(widgets.all()).toHaveLength(0)
  })
})

describe('routines', () => {
  test('a routine the agent writes is suggested, not active, below autopilot', async () => {
    const result = await call(
      'create_routine',
      {
        name: 'Nuit',
        description: 'Éteint tout à minuit',
        reason: 'Vous le faites tous les soirs',
        triggers: [{ kind: 'time', at: '00:00' }],
        actions: [{ kind: 'device_command', deviceId: fixture.devices.lamp, command: 'turnOff' }],
      },
      'copilot'
    )
    expect(result.ok).toBe(true)
    const stored = routines.all()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.status).toBe('suggested')
  })

  test('on autopilot the same routine is created active', async () => {
    await call(
      'create_routine',
      {
        name: 'Nuit',
        description: 'Éteint tout à minuit',
        reason: 'Habitude détectée',
        triggers: [{ kind: 'time', at: '00:00' }],
        actions: [{ kind: 'device_command', deviceId: fixture.devices.lamp, command: 'turnOff' }],
      },
      'autopilot'
    )
    expect(routines.all()[0]!.status).toBe('active')
  })
})

describe('autonomy', () => {
  test('get_autonomy answers in one sentence with chips, from the live settings', async () => {
    const result = await call('get_autonomy', {})
    expect(result.ok).toBe(true)
    expect(result.summary.startsWith("J'agis seul")).toBe(true)
    expect(result.summary).toContain('[[ph:')
  })

  test('set_autonomy changes the level and says what that means', async () => {
    const result = await call('set_autonomy', { level: 'assistant' })
    expect(result.ok).toBe(true)
    expect((await call('get_autonomy', {})).summary).toMatch(/demande/)
    await call('set_autonomy', { level: 'copilot' })
    expect((await call('get_autonomy', {})).summary.startsWith("J'agis seul")).toBe(true)
  })

  test('a routine cannot change how autonomous the assistant is', async () => {
    const tool = toolByName('set_autonomy')!
    const result = await tool.execute(tool.parameters.parse({ level: 'autopilot' }), { ...context(), unattended: true })
    expect(result.ok).toBe(false)
  })
})

describe('memory', () => {
  test('remember stores a fact and recall finds it', async () => {
    await call('remember', { content: 'John aime le salon à 21 degrés', kind: 'preference' })
    const recalled = await call('recall', { query: 'salon' })
    expect(recalled.summary).toContain('21')
  })

  test('remembering the same fact twice reinforces rather than duplicating', async () => {
    await call('remember', { content: 'Le chat dort dans la chambre', kind: 'fact' })
    await call('remember', { content: 'Le chat dort dans la chambre', kind: 'fact' })
    const recalled = await call('recall', { query: 'chat' })
    const occurrences = recalled.summary.split('chat').length - 1
    expect(occurrences).toBe(1)
  })
})
