/**
 * Home Assistant entities, read as Sway devices.
 *
 * Home Assistant already speaks to a thousand integrations; this adapter's whole job is to
 * translate. An entity's state and attributes become capability state, a Sway command becomes
 * a service call, and the entities of one physical device - a plug's switch, its power and its
 * energy sensors - become one device again, the way a person thinks of the plug.
 *
 * Fixtures follow the entity model documented at
 * https://developers.home-assistant.io/docs/core/entity/ and the WebSocket API at
 * https://developers.home-assistant.io/docs/api/websocket.
 */

import { describe, expect, test } from 'bun:test'
import { groupEntities, readEntity, toServiceCall, type HaState } from '#adapters/homeassistant_codec'

const entity = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): HaState => ({ entity_id, state, attributes })

describe('reading one entity', () => {
  test('a colour light: every mode it supports becomes a capability, in Sway units', () => {
    const read = readEntity(
      entity('light.salon', 'on', { supported_color_modes: ['color_temp', 'hs'], color_mode: 'hs', brightness: 128, color_temp_kelvin: 2700, hs_color: [30, 50], friendly_name: 'Salon' })
    )
    expect(read.category).toBe('light')
    expect(read.capabilities).toEqual(['onoff', 'brightness', 'colorTemperature', 'color'])
    expect(read.state).toEqual({ on: true, brightness: 50, colorTemperature: 2700, hue: 30, saturation: 50 })
    expect(read.available).toBe(true)
  })

  test('an on/off-only light is only on/off', () => {
    expect(readEntity(entity('light.cave', 'off', { supported_color_modes: ['onoff'] })).capabilities).toEqual(['onoff'])
  })

  test('a switch is a switch, and one HA calls an outlet is an outlet', () => {
    expect(readEntity(entity('switch.pompe', 'on')).category).toBe('switch')
    expect(readEntity(entity('switch.prise', 'off', { device_class: 'outlet' }))).toMatchObject({ category: 'outlet', state: { on: false } })
  })

  test('a blind reports its position and which way it is moving', () => {
    expect(readEntity(entity('cover.store', 'open', { current_position: 40 })).state).toEqual({ position: 40, moving: 'idle' })
    expect(readEntity(entity('cover.store', 'closing', { current_position: 40 })).state).toMatchObject({ moving: 'closing' })
    // No position attribute: open is all the way open.
    expect(readEntity(entity('cover.volet', 'open')).state).toMatchObject({ position: 100 })
  })

  test('a garage door is a garage door, not a blind', () => {
    const read = readEntity(entity('cover.garage', 'opening', { device_class: 'garage' }))
    expect(read.capabilities).toEqual(['garage'])
    expect(read.state).toEqual({ doorState: 'opening' })
  })

  test('a thermostat: set point, reading, mode and what it is doing', () => {
    const read = readEntity(entity('climate.salon', 'heat', { temperature: 21, current_temperature: 19.5, hvac_action: 'heating', hvac_modes: ['off', 'heat'] }))
    expect(read.capabilities).toEqual(['thermostat', 'temperature'])
    expect(read.state).toEqual({ targetTemperature: 21, currentTemperature: 19.5, temperature: 19.5, hvacMode: 'heat', hvacAction: 'heating' })
    expect(readEntity(entity('climate.pac', 'heat_cool', {})).state).toMatchObject({ hvacMode: 'auto' })
  })

  test('a lock, including a jammed one', () => {
    expect(readEntity(entity('lock.porte', 'locked')).state).toEqual({ locked: true, jammed: false })
    expect(readEntity(entity('lock.porte', 'jammed')).state).toEqual({ locked: false, jammed: true })
  })

  test('a media player: playback, volume in percent, what is playing and the inputs', () => {
    const read = readEntity(
      entity('media_player.tv', 'playing', {
        device_class: 'tv',
        volume_level: 0.35,
        is_volume_muted: false,
        media_title: 'Le Bureau des légendes',
        media_artist: null,
        source: 'HDMI 1',
        source_list: ['HDMI 1', 'Netflix'],
        app_name: 'Netflix',
      })
    )
    expect(read.category).toBe('display')
    expect(read.capabilities).toEqual(['onoff', 'mediaPlayback', 'volume', 'mediaSource'])
    expect(read.state).toMatchObject({ on: true, playback: 'playing', volume: 35, muted: false, title: 'Le Bureau des légendes', source: 'HDMI 1', availableSources: ['HDMI 1', 'Netflix'], app: 'Netflix' })
    expect(readEntity(entity('media_player.tv', 'off', {})).state).toMatchObject({ on: false, playback: 'stopped' })
  })

  test('sensors land in Sway units whatever unit HA reports them in', () => {
    expect(readEntity(entity('sensor.t', '68', { device_class: 'temperature', unit_of_measurement: '°F' })).state).toEqual({ temperature: 20 })
    expect(readEntity(entity('sensor.p', '1.2', { device_class: 'power', unit_of_measurement: 'kW' })).state).toEqual({ power: 1200 })
    expect(readEntity(entity('sensor.e', '1500', { device_class: 'energy', unit_of_measurement: 'Wh' })).state).toEqual({ energyTotal: 1.5 })
    expect(readEntity(entity('sensor.pr', '101.3', { device_class: 'pressure', unit_of_measurement: 'kPa' })).state).toEqual({ pressure: 1013 })
    expect(readEntity(entity('sensor.h', '45.5', { device_class: 'humidity', unit_of_measurement: '%' })).state).toEqual({ humidity: 45.5 })
    expect(readEntity(entity('sensor.b', '12', { device_class: 'battery', unit_of_measurement: '%' })).state).toEqual({ battery: 12, batteryLow: true })
  })

  test('a CO2 reading comes with the air-quality verdict the capability needs', () => {
    const read = readEntity(entity('sensor.co2', '1250', { device_class: 'carbon_dioxide', unit_of_measurement: 'ppm' }))
    expect(read.capabilities).toEqual(['airQuality'])
    expect(read.state).toEqual({ co2: 1250, airQuality: 'moderate' })
  })

  test('binary sensors by what they detect', () => {
    expect(readEntity(entity('binary_sensor.m', 'on', { device_class: 'motion' }))).toMatchObject({ capabilities: ['motion'], state: { motion: true } })
    expect(readEntity(entity('binary_sensor.d', 'off', { device_class: 'door' }))).toMatchObject({ capabilities: ['contact'], state: { open: false } })
    expect(readEntity(entity('binary_sensor.w', 'on', { device_class: 'moisture' }))).toMatchObject({ capabilities: ['waterLeak'], state: { leak: true } })
    expect(readEntity(entity('binary_sensor.s', 'off', { device_class: 'smoke' }))).toMatchObject({ capabilities: ['smoke'], state: { smoke: false } })
    expect(readEntity(entity('binary_sensor.o', 'on', { device_class: 'occupancy' }))).toMatchObject({ capabilities: ['occupancy'], state: { occupied: true } })
  })

  test('a person is presence', () => {
    expect(readEntity(entity('person.john', 'not_home'))).toMatchObject({ capabilities: ['presence'], state: { home: false } })
  })

  test('unavailable is offline, not "off"', () => {
    const read = readEntity(entity('light.salon', 'unavailable', { supported_color_modes: ['brightness'] }))
    expect(read.available).toBe(false)
    expect(read.state).toEqual({})
  })

  test('what Sway has no word for is left alone', () => {
    expect(readEntity(entity('sun.sun', 'above_horizon')).capabilities).toEqual([])
    expect(readEntity(entity('sensor.uptime', '3', { unit_of_measurement: 'd' })).capabilities).toEqual([])
  })
})

describe('entities grouped back into devices', () => {
  const registry = {
    areas: [{ area_id: 'salon', name: 'Salon' }],
    devices: [
      { id: 'dev-plug', name: 'Prise TV', name_by_user: null, manufacturer: 'Shelly', model: 'Plug S', sw_version: '1.2', area_id: 'salon' },
      { id: 'dev-relay', name: 'Relais double', name_by_user: 'Relais cuisine', manufacturer: 'Sonoff', model: 'Dual', sw_version: null, area_id: null },
      { id: 'dev-door', name: 'Capteur porte', name_by_user: null, manufacturer: 'Aqara', model: 'MCCGQ11LM', sw_version: null, area_id: 'salon' },
    ],
    entities: [
      { entity_id: 'switch.prise_tv', device_id: 'dev-plug', area_id: null, entity_category: null, disabled_by: null, hidden_by: null },
      { entity_id: 'sensor.prise_tv_power', device_id: 'dev-plug', area_id: null, entity_category: null, disabled_by: null, hidden_by: null },
      { entity_id: 'sensor.prise_tv_energy', device_id: 'dev-plug', area_id: null, entity_category: null, disabled_by: null, hidden_by: null },
      { entity_id: 'sensor.prise_tv_rssi', device_id: 'dev-plug', area_id: null, entity_category: 'diagnostic', disabled_by: null, hidden_by: null },
      { entity_id: 'switch.relais_1', device_id: 'dev-relay', area_id: null, entity_category: null, disabled_by: null, hidden_by: null },
      { entity_id: 'switch.relais_2', device_id: 'dev-relay', area_id: null, entity_category: null, disabled_by: null, hidden_by: null },
      { entity_id: 'sensor.relais_temperature', device_id: 'dev-relay', area_id: null, entity_category: 'diagnostic', disabled_by: null, hidden_by: null },
      { entity_id: 'switch.old', device_id: null, area_id: null, entity_category: null, disabled_by: 'user', hidden_by: null },
      { entity_id: 'binary_sensor.porte', device_id: 'dev-door', area_id: null, entity_category: null, disabled_by: null, hidden_by: null },
      { entity_id: 'sensor.porte_battery', device_id: 'dev-door', area_id: null, entity_category: 'diagnostic', disabled_by: null, hidden_by: null },
      { entity_id: 'sensor.porte_device_temperature', device_id: 'dev-door', area_id: null, entity_category: 'diagnostic', disabled_by: null, hidden_by: null },
    ],
  }
  const states = [
    entity('switch.prise_tv', 'on', { friendly_name: 'Prise TV' }),
    entity('sensor.prise_tv_power', '42.5', { device_class: 'power', unit_of_measurement: 'W', friendly_name: 'Prise TV Power' }),
    entity('sensor.prise_tv_energy', '3.2', { device_class: 'energy', unit_of_measurement: 'kWh' }),
    entity('sensor.prise_tv_rssi', '-60', { device_class: 'signal_strength', unit_of_measurement: 'dBm' }),
    entity('switch.relais_1', 'off', { friendly_name: 'Relais cuisine Canal 1' }),
    entity('switch.relais_2', 'on', { friendly_name: 'Relais cuisine Canal 2' }),
    entity('sensor.relais_temperature', '41', { device_class: 'temperature', unit_of_measurement: '°C' }),
    entity('light.orphan', 'off', { supported_color_modes: ['onoff'], friendly_name: 'Lampe sans appareil' }),
    entity('switch.old', 'off', {}),
    entity('binary_sensor.porte', 'off', { device_class: 'door' }),
    entity('sensor.porte_battery', '87', { device_class: 'battery', unit_of_measurement: '%' }),
    entity('sensor.porte_device_temperature', '26', { device_class: 'temperature', unit_of_measurement: '°C' }),
  ]
  const groups = groupEntities(states, registry)
  const byId = new Map(groups.map((group) => [group.nativeId, group]))

  test('a plug with its power and energy sensors is one device', () => {
    expect(byId.get('dev-plug')).toMatchObject({
      name: 'Prise TV',
      category: 'switch',
      capabilities: ['onoff', 'power', 'energy'],
      bindings: { onoff: 'switch.prise_tv', power: 'sensor.prise_tv_power', energy: 'sensor.prise_tv_energy' },
      manufacturer: 'Shelly',
      model: 'Plug S',
      area: 'Salon',
    })
  })

  test('two channels of one relay are two devices', () => {
    expect(byId.get('switch.relais_1')).toMatchObject({ name: 'Relais cuisine Canal 1', capabilities: ['onoff'] })
    expect(byId.get('switch.relais_2')).toMatchObject({ capabilities: ['onoff'] })
  })

  test("a device's own chip temperature is not the room's: diagnostics are dropped, except the battery", () => {
    // HA marks the internal temperature of a relay or a sensor as diagnostic precisely
    // because it is not the air. Counting it would put a 41 °C "salon" in every answer.
    expect(byId.has('dev-relay')).toBe(false)
    expect(byId.get('dev-door')).toMatchObject({ name: 'Capteur porte', category: 'sensor', capabilities: ['contact', 'battery'] })
    expect(groups.flatMap((group) => Object.values(group.bindings))).not.toContain('sensor.porte_device_temperature')
  })

  test('an entity with no device is its own device', () => {
    expect(byId.get('light.orphan')).toMatchObject({ name: 'Lampe sans appareil', category: 'light', capabilities: ['onoff'] })
  })

  test('disabled entities and signal diagnostics are not devices', () => {
    expect(byId.has('switch.old')).toBe(false)
    expect(groups.flatMap((group) => Object.values(group.bindings))).not.toContain('sensor.prise_tv_rssi')
  })
})

describe('commands as service calls', () => {
  test('on and off, with the transition in seconds', () => {
    expect(toServiceCall('light.salon', 'turnOn', { transitionMs: 500 })).toEqual({ domain: 'light', service: 'turn_on', service_data: { transition: 0.5 }, target: { entity_id: 'light.salon' } })
    expect(toServiceCall('switch.prise', 'turnOff', {})).toEqual({ domain: 'switch', service: 'turn_off', service_data: {}, target: { entity_id: 'switch.prise' } })
    expect(toServiceCall('switch.prise', 'toggle', {})).toMatchObject({ service: 'toggle' })
    expect(toServiceCall('media_player.tv', 'turnOn', {})).toMatchObject({ domain: 'media_player', service: 'turn_on' })
  })

  test('light levels and colours', () => {
    expect(toServiceCall('light.salon', 'setBrightness', { brightness: 40 })).toMatchObject({ service: 'turn_on', service_data: { brightness_pct: 40 } })
    expect(toServiceCall('light.salon', 'stepBrightness', { delta: -10 })).toMatchObject({ service_data: { brightness_step_pct: -10 } })
    expect(toServiceCall('light.salon', 'setColorTemperature', { kelvin: 3000 })).toMatchObject({ service_data: { color_temp_kelvin: 3000 } })
    expect(toServiceCall('light.salon', 'setColor', { hue: 200, saturation: 80 })).toMatchObject({ service_data: { hs_color: [200, 80] } })
    expect(toServiceCall('light.salon', 'setColorRgb', { r: 255, g: 0, b: 10 })).toMatchObject({ service_data: { rgb_color: [255, 0, 10] } })
  })

  test('covers, garage doors and valves', () => {
    expect(toServiceCall('cover.store', 'setPosition', { position: 30 })).toMatchObject({ domain: 'cover', service: 'set_cover_position', service_data: { position: 30 } })
    expect(toServiceCall('cover.store', 'stop', {})).toMatchObject({ service: 'stop_cover' })
    expect(toServiceCall('cover.garage', 'openDoor', {})).toMatchObject({ service: 'open_cover' })
    expect(toServiceCall('valve.arrosage', 'closeValve', {})).toMatchObject({ domain: 'valve', service: 'close_valve' })
  })

  test('climate: set point, and "auto" means heat_cool where that is what the device offers', () => {
    expect(toServiceCall('climate.salon', 'setTargetTemperature', { celsius: 20.5 })).toMatchObject({ service: 'set_temperature', service_data: { temperature: 20.5 } })
    expect(toServiceCall('climate.pac', 'setHvacMode', { mode: 'auto' }, entity('climate.pac', 'off', { hvac_modes: ['off', 'heat_cool', 'cool'] }))).toMatchObject({
      service: 'set_hvac_mode',
      service_data: { hvac_mode: 'heat_cool' },
    })
  })

  test('locks', () => {
    expect(toServiceCall('lock.porte', 'unlock', { reason: 'livreur' })).toEqual({ domain: 'lock', service: 'unlock', service_data: {}, target: { entity_id: 'lock.porte' } })
  })

  test('media: transport, volume in HA units, relative steps from the current level', () => {
    expect(toServiceCall('media_player.tv', 'setVolume', { volume: 30 })).toMatchObject({ service: 'volume_set', service_data: { volume_level: 0.3 } })
    expect(toServiceCall('media_player.tv', 'stepVolume', { delta: 10 }, entity('media_player.tv', 'on', { volume_level: 0.25 }))).toMatchObject({ service: 'volume_set', service_data: { volume_level: 0.35 } })
    expect(toServiceCall('media_player.tv', 'next', {})).toMatchObject({ service: 'media_next_track' })
    expect(toServiceCall('media_player.tv', 'setSource', { source: 'Netflix' })).toMatchObject({ service: 'select_source', service_data: { source: 'Netflix' } })
    expect(toServiceCall('media_player.tv', 'setMuted', { muted: true })).toMatchObject({ service: 'volume_mute', service_data: { is_volume_muted: true } })
  })

  test('a command the entity cannot take is refused, not guessed', () => {
    expect(toServiceCall('sensor.temperature', 'turnOn', {})).toBeNull()
    expect(toServiceCall('light.salon', 'lock', {})).toBeNull()
  })
})
