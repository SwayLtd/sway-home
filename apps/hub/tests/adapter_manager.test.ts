/**
 * Discovery, as the rest of the hub sees it.
 *
 * Discovery says what a device is; it used to say nothing about how it is, so a thermostat
 * found at boot showed no set point, and a window no position, until the first change came
 * in - hours, for a window. The reflexes read that state, so a device must arrive with it.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { adapters } from '#services/adapter_manager'
import { deviceRepository } from '#repositories/device_repository'
import { dropDatabase, freshDatabase } from './helpers.ts'
import { FakeAdapter } from './fake_adapter.ts'

const adapter = new FakeAdapter()

beforeEach(async () => {
  await freshDatabase()
  adapter.reset()
  adapters.register(adapter)
  await adapters.start('test')
})

afterAll(dropDatabase)

const offer = (nativeId: string, name: string) =>
  adapter.offerDevices([
    { adapterId: 'test', nativeId, uid: `test:${nativeId}`, name, category: 'climate', capabilities: ['thermostat'], transport: 'virtual', confidence: 0.95 },
  ])

describe('a discovered device', () => {
  test('arrives with its state, not blank until its first change', async () => {
    offer('thermo-bureau', 'Thermostat bureau')
    adapter.setState('thermo-bureau', { hvacMode: 'heat', targetTemperature: 19, currentTemperature: 18.5 })
    const { added } = await adapters.discover([])
    expect(added).toBe(1)
    expect(deviceRepository.findByNative('test', 'thermo-bureau')?.state).toMatchObject({ hvacMode: 'heat', targetTemperature: 19, currentTemperature: 18.5 })
  })

  test('a device with nothing to say is still added', async () => {
    offer('mute', 'Thermostat muet')
    await adapters.discover([])
    expect(deviceRepository.findByNative('test', 'mute')?.state).toEqual({})
  })
})

describe('a device the house lets go of', () => {
  test('its adapter is told, so the next scan does not bring it back', async () => {
    offer('thermo-garage', 'Thermostat garage')
    await adapters.discover([])
    expect(await adapters.forget('test', 'thermo-garage')).toEqual({ ok: true })
    expect(adapter.forgotten).toEqual(['thermo-garage'])
    const { added } = await adapters.discover([])
    expect(added).toBe(0)
  })

  test('an adapter with nothing to let go of is not asked', async () => {
    expect(await adapters.forget('nobody', 'x')).toBeNull()
  })
})
