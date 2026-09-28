/**
 * What the assistant does on its own, decided without a network or a database.
 *
 * `decideReflexes` reads a picture of the house - devices, rooms, who is home, when each
 * attribute last changed, which episodes are still open - and returns what it would do and
 * the sentence it would say. The engine around it decides whether it may act or must ask.
 * Everything a person would notice is pinned down here: the heating goes off two minutes
 * after a window opens and comes back when it closes, lights go off in a room nobody has
 * moved in for half an hour, a leak closes the water, and nothing is decided twice.
 */

import { describe, expect, test } from 'bun:test'
import { decideReflexes, describeAutonomy, REFLEXES, type ReflexDevice, type ReflexEpisode, type ReflexWorld } from '#agent/reflexes'
import { parseRichText } from '@sway-home/shared'

const NOW = new Date('2026-09-26T15:00:00')
const MIN = 60_000
const ago = (minutes: number) => NOW.getTime() - minutes * MIN

const SALON = { id: 'salon', name: 'Salon', kind: 'living_room' }
const SDB = { id: 'sdb', name: 'Salle de bain', kind: 'bathroom' }
const CHAMBRE = { id: 'chambre', name: 'Chambre', kind: 'bedroom' }
const JARDIN = { id: 'jardin', name: 'Jardin', kind: 'garden' }

function device(spec: Partial<ReflexDevice> & Pick<ReflexDevice, 'id' | 'name' | 'category' | 'capabilities' | 'state'>): ReflexDevice {
  return { areaId: 'salon', online: true, critical: false, ...spec }
}

const lamp = (state: Record<string, unknown> = { on: true }, areaId = 'salon', id = 'lamp') =>
  device({ id, name: id === 'lamp' ? 'Plafonnier salon' : `Lampe ${id}`, category: 'light', capabilities: ['onoff', 'brightness'], state, areaId })
const thermostat = (state: Record<string, unknown> = { hvacMode: 'heat', targetTemperature: 20, currentTemperature: 19.5 }, areaId = 'salon') =>
  device({ id: `thermo-${areaId}`, name: `Thermostat ${areaId}`, category: 'climate', capabilities: ['thermostat', 'temperature'], state, areaId })
const windowSensor = (open: boolean, name = 'Fenêtre salon', areaId = 'salon') =>
  device({ id: `contact-${name}`, name, category: 'sensor', capabilities: ['contact'], state: { open }, areaId })
const motion = (moving = false, areaId = 'salon') =>
  device({ id: `motion-${areaId}`, name: `Détecteur ${areaId}`, category: 'sensor', capabilities: ['motion'], state: { motion: moving }, areaId })

interface WorldSpec {
  devices: ReflexDevice[]
  changed?: Record<string, number>
  motionAt?: Record<string, number | null>
  occupied?: boolean | null
  emptyForMinutes?: number | null
  episodes?: ReflexEpisode[]
  disabled?: string[]
}

function world(spec: WorldSpec): ReflexWorld {
  return {
    now: NOW,
    devices: spec.devices,
    areas: [SALON, SDB, CHAMBRE, JARDIN],
    occupied: spec.occupied === undefined ? true : spec.occupied,
    emptyForMinutes: spec.emptyForMinutes ?? null,
    changedAt: (deviceId, attribute) => spec.changed?.[`${deviceId}:${attribute}`] ?? null,
    lastMotion: (areaId) => {
      const sensors = spec.devices.filter((candidate) => candidate.areaId === areaId && candidate.capabilities.includes('motion'))
      if (sensors.length === 0) return undefined
      return spec.motionAt?.[areaId] ?? null
    },
    episodes: spec.episodes ?? [],
    enabled: (reflex) => !(spec.disabled ?? []).includes(reflex),
  }
}

const chipsOf = (text: string) => parseRichText(text).filter((segment) => segment.kind === 'chip')

describe('the catalogue', () => {
  test('every reflex has a French label, a line to explain it and an icon', () => {
    expect(REFLEXES.length).toBeGreaterThanOrEqual(8)
    for (const reflex of REFLEXES) {
      expect(reflex.label.length).toBeGreaterThan(5)
      expect(reflex.description.length).toBeGreaterThan(10)
      expect(reflex.icon).toMatch(/^ph:[a-z-]+$/)
    }
    expect(REFLEXES.filter((reflex) => reflex.safety).map((reflex) => reflex.id).sort()).toEqual(['frost_guard', 'leak_shutoff', 'smoke_safety'])
  })
})

describe('a water leak', () => {
  const detector = device({ id: 'leak', name: 'Détecteur évier', category: 'sensor', capabilities: ['waterLeak'], state: { leak: true } })
  const valve = (open: boolean | undefined, online = true) =>
    device({ id: 'valve', name: "Vanne d'arrivée", category: 'appliance', capabilities: ['valve'], state: open === undefined ? {} : { valveOpen: open }, online })

  test('closes every open water valve, and says which detector and which valve', () => {
    const [decision, ...rest] = decideReflexes(world({ devices: [detector, valve(true)] }))
    expect(rest).toEqual([])
    expect(decision).toMatchObject({ reflex: 'leak_shutoff', severity: 'critical', commands: [{ deviceId: 'valve', command: 'closeValve', args: {} }] })
    expect(chipsOf(decision!.done).map((segment) => segment.text)).toEqual(['Détecteur évier', "Vanne d'arrivée"])
    expect(decision!.ask).toMatch(/\?$/)
  })

  test('a valve that is already closed, offline, or missing leaves nothing to do', () => {
    expect(decideReflexes(world({ devices: [detector, valve(false)] }))).toEqual([])
    expect(decideReflexes(world({ devices: [detector, valve(true, false)] }))).toEqual([])
    expect(decideReflexes(world({ devices: [detector] }))).toEqual([])
  })

  test('a valve whose state is unknown is closed anyway: during a leak, closing twice costs nothing', () => {
    expect(decideReflexes(world({ devices: [detector, valve(undefined)] }))[0]?.commands).toEqual([{ deviceId: 'valve', command: 'closeValve', args: {} }])
  })
})

describe('smoke and carbon monoxide', () => {
  const speaker = device({ id: 'sonos', name: 'Sonos salon', category: 'speaker', capabilities: ['mediaPlayback', 'volume'], state: { playback: 'playing' } })
  const fan = device({ id: 'fan', name: 'Ventilateur', category: 'climate', capabilities: ['fan'], state: { fanMode: 'high', fanSpeed: 80 } })

  test('smoke lights the way out, silences the music and stops the air from spreading it', () => {
    const detector = device({ id: 'smoke', name: 'Détecteur cuisine', category: 'sensor', capabilities: ['smoke'], state: { smoke: true } })
    const [decision] = decideReflexes(world({ devices: [detector, lamp({ on: false, brightness: 20 }), speaker, fan] }))
    expect(decision?.reflex).toBe('smoke_safety')
    expect(decision?.severity).toBe('critical')
    expect(decision?.commands).toEqual([
      { deviceId: 'lamp', command: 'setBrightness', args: { brightness: 100 } },
      { deviceId: 'sonos', command: 'pause', args: {} },
      { deviceId: 'fan', command: 'setFanMode', args: { mode: 'off' } },
    ])
    expect(decision?.done).toContain('Détecteur cuisine')
  })

  test('carbon monoxide lights up too but keeps the air moving, and says to get out', () => {
    const detector = device({ id: 'co', name: 'Détecteur CO', category: 'sensor', capabilities: ['carbonMonoxide'], state: { co: true } })
    const [decision] = decideReflexes(world({ devices: [detector, lamp({ on: false }), speaker, fan] }))
    expect(decision?.commands.map((command) => command.command)).toEqual(['setBrightness', 'pause'])
    expect(decision?.done).toMatch(/sortez/i)
  })

  test('a detector being tested is not a fire', () => {
    const detector = device({ id: 'smoke', name: 'Détecteur cuisine', category: 'sensor', capabilities: ['smoke'], state: { smoke: true, testing: true } })
    expect(decideReflexes(world({ devices: [detector, lamp({ on: false })] }))).toEqual([])
  })
})

describe('a window open while the heating runs', () => {
  test('open for two minutes: the heating goes off, and the episode remembers its mode', () => {
    const contact = windowSensor(true)
    const [decision] = decideReflexes(world({ devices: [contact, thermostat()], changed: { [`${contact.id}:open`]: ago(3) } }))
    expect(decision).toMatchObject({ reflex: 'window_heating', key: 'window_heating:salon', commands: [{ deviceId: 'thermo-salon', command: 'setHvacMode', args: { mode: 'off' } }] })
    expect(decision?.opens?.restore).toEqual([{ deviceId: 'thermo-salon', command: 'setHvacMode', args: { mode: 'heat' }, ifState: { hvacMode: 'off' } }])
    expect(chipsOf(decision!.done)[0]?.text).toBe('Salon')
  })

  test('a thermostat that only says it is heating counts, and comes back in heat', () => {
    const contact = windowSensor(true)
    const [decision] = decideReflexes(world({ devices: [contact, thermostat({ hvacAction: 'heating', currentTemperature: 19 })], changed: { [`${contact.id}:open`]: ago(3) } }))
    expect(decision?.commands).toEqual([{ deviceId: 'thermo-salon', command: 'setHvacMode', args: { mode: 'off' } }])
    expect(decision?.opens?.restore[0]?.args).toEqual({ mode: 'heat' })
  })

  test('thirty seconds is someone airing the room for a moment: not yet', () => {
    const contact = windowSensor(true)
    expect(decideReflexes(world({ devices: [contact, thermostat()], changed: { [`${contact.id}:open`]: NOW.getTime() - 30_000 } }))).toEqual([])
  })

  test('a door, a fridge or a mailbox is not a window', () => {
    for (const name of ["Porte d'entrée", 'Réfrigérateur', 'Boîte aux lettres']) {
      const contact = windowSensor(true, name)
      expect(decideReflexes(world({ devices: [contact, thermostat()], changed: { [`${contact.id}:open`]: ago(10) } }))).toEqual([])
    }
  })

  test('a heating that is already off, or in another room, is left alone', () => {
    const contact = windowSensor(true)
    expect(decideReflexes(world({ devices: [contact, thermostat({ hvacMode: 'off', targetTemperature: 20 })], changed: { [`${contact.id}:open`]: ago(5) } }))).toEqual([])
    expect(decideReflexes(world({ devices: [contact, thermostat(undefined, 'chambre')], changed: { [`${contact.id}:open`]: ago(5) } }))).toEqual([])
  })

  test('an episode already open means the heating is not switched off a second time', () => {
    const contact = windowSensor(true)
    const episode: ReflexEpisode = { key: 'window_heating:salon', reflex: 'window_heating', openedAt: new Date(ago(4)).toISOString(), restore: [] }
    expect(
      decideReflexes(world({ devices: [contact, thermostat({ hvacMode: 'off', targetTemperature: 20 })], changed: { [`${contact.id}:open`]: ago(5) }, episodes: [episode] }))
    ).toEqual([])
  })

  test('closed again for a minute: the heating comes back', () => {
    const contact = windowSensor(false)
    const episode: ReflexEpisode = {
      key: 'window_heating:salon',
      reflex: 'window_heating',
      openedAt: new Date(ago(20)).toISOString(),
      restore: [{ deviceId: 'thermo-salon', command: 'setHvacMode', args: { mode: 'heat' }, ifState: { hvacMode: 'off' } }],
    }
    const [decision] = decideReflexes(
      world({ devices: [contact, thermostat({ hvacMode: 'off', targetTemperature: 20 })], changed: { [`${contact.id}:open`]: ago(2) }, episodes: [episode] })
    )
    expect(decision).toMatchObject({ reflex: 'window_heating', closes: 'window_heating:salon', commands: [{ deviceId: 'thermo-salon', command: 'setHvacMode', args: { mode: 'heat' } }] })
    expect(decision?.silent).toBeFalsy()
  })

  test('still open, the episode stays open', () => {
    const contact = windowSensor(true)
    const episode: ReflexEpisode = { key: 'window_heating:salon', reflex: 'window_heating', openedAt: new Date(ago(20)).toISOString(), restore: [] }
    expect(decideReflexes(world({ devices: [contact, thermostat({ hvacMode: 'off' })], changed: { [`${contact.id}:open`]: ago(21) }, episodes: [episode] }))).toEqual([])
  })

  test('if someone put the heating back on meanwhile, the episode closes without touching it', () => {
    const contact = windowSensor(false)
    const episode: ReflexEpisode = {
      key: 'window_heating:salon',
      reflex: 'window_heating',
      openedAt: new Date(ago(20)).toISOString(),
      restore: [{ deviceId: 'thermo-salon', command: 'setHvacMode', args: { mode: 'heat' }, ifState: { hvacMode: 'off' } }],
    }
    const [decision] = decideReflexes(
      world({ devices: [contact, thermostat({ hvacMode: 'auto', targetTemperature: 21 })], changed: { [`${contact.id}:open`]: ago(2) }, episodes: [episode] })
    )
    expect(decision).toMatchObject({ closes: 'window_heating:salon', commands: [], silent: true })
  })
})

describe('an empty house', () => {
  const tv = device({ id: 'tv', name: 'Télé', category: 'display', capabilities: ['onoff', 'mediaPlayback'], state: { on: true, playback: 'playing' } })
  const lock = device({ id: 'lock', name: 'Serrure entrée', category: 'lock', capabilities: ['lock'], state: { locked: false } })

  test('nobody home for ten minutes: lights and TV off, heating down to 16 °C and remembered', () => {
    const decisions = decideReflexes(world({ devices: [lamp(), tv, thermostat()], occupied: false, emptyForMinutes: 12 }))
    const [decision] = decisions
    expect(decision?.reflex).toBe('empty_house')
    expect(decision?.commands).toEqual([
      { deviceId: 'lamp', command: 'turnOff', args: {} },
      { deviceId: 'tv', command: 'turnOff', args: {} },
      { deviceId: 'thermo-salon', command: 'setTargetTemperature', args: { celsius: 16 } },
    ])
    expect(decision?.opens?.restore).toEqual([{ deviceId: 'thermo-salon', command: 'setTargetTemperature', args: { celsius: 20 }, ifState: { targetTemperature: 16 } }])
    expect(decisions.filter((candidate) => candidate.reflex === 'idle_room')).toEqual([])
  })

  test('music playing to an empty flat is paused', () => {
    const speaker = device({ id: 'sonos', name: 'Sonos salon', category: 'speaker', capabilities: ['mediaPlayback'], state: { playback: 'playing' } })
    expect(decideReflexes(world({ devices: [speaker], occupied: false, emptyForMinutes: 15 }))[0]?.commands).toEqual([{ deviceId: 'sonos', command: 'pause', args: {} }])
  })

  test('five minutes is someone taking the bins out: nothing yet', () => {
    expect(decideReflexes(world({ devices: [lamp(), thermostat()], occupied: false, emptyForMinutes: 5 }))).toEqual([])
  })

  test('when the house cannot tell who is home, it does not guess', () => {
    expect(decideReflexes(world({ devices: [lamp(), thermostat()], occupied: null, emptyForMinutes: null }))).toEqual([])
  })

  test('an unlocked door is only ever asked about', () => {
    // The empty-house episode still opens, silently, so a light switched on later by a
    // presence simulation is not fought; the only thing said is the question about the lock.
    const decisions = decideReflexes(world({ devices: [lock], occupied: false, emptyForMinutes: 30 })).filter((decision) => !decision.silent)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ reflex: 'empty_house', key: 'empty_house:locks', askOnly: true, commands: [{ deviceId: 'lock', command: 'lock', args: {} }] })
    expect(decisions[0]?.ask).toMatch(/\?$/)
  })

  test('back home: the heating goes back to where it was', () => {
    const episode: ReflexEpisode = {
      key: 'empty_house',
      reflex: 'empty_house',
      openedAt: new Date(ago(120)).toISOString(),
      restore: [{ deviceId: 'thermo-salon', command: 'setTargetTemperature', args: { celsius: 20 }, ifState: { targetTemperature: 16 } }],
    }
    const [decision] = decideReflexes(world({ devices: [thermostat({ hvacMode: 'heat', targetTemperature: 16 })], occupied: true, episodes: [episode] }))
    expect(decision).toMatchObject({ closes: 'empty_house', commands: [{ deviceId: 'thermo-salon', command: 'setTargetTemperature', args: { celsius: 20 } }] })
    expect(decision?.done).toMatch(/retour/i)
  })
})

describe('a room nobody is in', () => {
  const still = (lightOnMinutes: number, motionMinutes: number | null, extra: ReflexDevice[] = []) =>
    decideReflexes(
      world({
        devices: [lamp(), motion(false), ...extra],
        changed: { 'lamp:on': ago(lightOnMinutes) },
        motionAt: { salon: motionMinutes === null ? null : ago(motionMinutes) },
      })
    )

  test('no movement for thirty minutes and a light on for as long: it goes off', () => {
    const [decision] = still(45, 35)
    expect(decision).toMatchObject({ reflex: 'idle_room', key: 'idle_room:salon', commands: [{ deviceId: 'lamp', command: 'turnOff', args: {} }] })
    expect(chipsOf(decision!.done)[0]?.text).toBe('Salon')
  })

  test('movement five minutes ago keeps the light on', () => {
    expect(still(45, 5)).toEqual([])
  })

  test('someone moving right now keeps it on, whatever the history says', () => {
    expect(decideReflexes(world({ devices: [lamp(), motion(true)], changed: { 'lamp:on': ago(60) }, motionAt: { salon: ago(60) } }))).toEqual([])
  })

  test('a light switched on a minute ago stays on, even in a still room', () => {
    expect(still(1, 40)).toEqual([])
  })

  test('a room without a motion sensor, or one that never reported, is never judged empty', () => {
    expect(decideReflexes(world({ devices: [lamp()], changed: { 'lamp:on': ago(90) } }))).toEqual([])
    expect(still(90, null)).toEqual([])
  })

  test('a television is not switched off because its audience sits still', () => {
    const tv = device({ id: 'tv', name: 'Télé', category: 'display', capabilities: ['onoff'], state: { on: true } })
    expect(still(45, 35, [tv])[0]?.commands).toEqual([{ deviceId: 'lamp', command: 'turnOff', args: {} }])
  })

  test('the garden light is not an empty room', () => {
    expect(
      decideReflexes(world({ devices: [lamp({ on: true }, 'jardin'), motion(false, 'jardin')], changed: { 'lamp:on': ago(90) }, motionAt: { jardin: ago(90) } }))
    ).toEqual([])
  })
})

describe('the bathroom after a shower', () => {
  const extractor = (on: boolean) => device({ id: 'vmc', name: 'Extracteur', category: 'climate', capabilities: ['onoff'], state: { on }, areaId: 'sdb' })
  const hygro = (humidity: number) => device({ id: 'hygro', name: 'Capteur SDB', category: 'sensor', capabilities: ['humidity'], state: { humidity }, areaId: 'sdb' })

  test('70 % and the extractor off: it starts, to stop again below 60 %', () => {
    const [decision] = decideReflexes(world({ devices: [hygro(78), extractor(false)] }))
    expect(decision).toMatchObject({ reflex: 'humid_bathroom', key: 'humid_bathroom:sdb', commands: [{ deviceId: 'vmc', command: 'turnOn', args: {} }] })
    expect(decision?.opens?.restore).toEqual([{ deviceId: 'vmc', command: 'turnOff', args: {}, ifState: { on: true } }])
    expect(chipsOf(decision!.done).map((segment) => segment.text)).toContain('78 %')
  })

  test('between 60 and 70 % nothing changes either way', () => {
    const episode: ReflexEpisode = {
      key: 'humid_bathroom:sdb',
      reflex: 'humid_bathroom',
      openedAt: new Date(ago(10)).toISOString(),
      restore: [{ deviceId: 'vmc', command: 'turnOff', args: {}, ifState: { on: true } }],
    }
    expect(decideReflexes(world({ devices: [hygro(65), extractor(false)] }))).toEqual([])
    expect(decideReflexes(world({ devices: [hygro(65), extractor(true)], episodes: [episode] }))).toEqual([])
  })

  test('below 60 % the extractor it started stops', () => {
    const episode: ReflexEpisode = {
      key: 'humid_bathroom:sdb',
      reflex: 'humid_bathroom',
      openedAt: new Date(ago(25)).toISOString(),
      restore: [{ deviceId: 'vmc', command: 'turnOff', args: {}, ifState: { on: true } }],
    }
    expect(decideReflexes(world({ devices: [hygro(55), extractor(true)], episodes: [episode] }))[0]).toMatchObject({
      closes: 'humid_bathroom:sdb',
      commands: [{ deviceId: 'vmc', command: 'turnOff', args: {} }],
    })
  })
})

describe('stale air', () => {
  const co2 = (ppm: number) => device({ id: 'co2', name: 'Capteur chambre', category: 'sensor', capabilities: ['airQuality'], state: { co2: ppm }, areaId: 'chambre' })

  test('over 1 400 ppm with nothing to switch: advice, once per episode', () => {
    const [decision] = decideReflexes(world({ devices: [co2(1450)] }))
    expect(decision).toMatchObject({ reflex: 'stale_air', key: 'stale_air:chambre', commands: [], adviceOnly: true })
    expect(chipsOf(decision!.done).map((segment) => segment.text)).toContain('1450 ppm')
    const episode: ReflexEpisode = { key: 'stale_air:chambre', reflex: 'stale_air', openedAt: NOW.toISOString(), restore: [] }
    expect(decideReflexes(world({ devices: [co2(1500)], episodes: [episode] }))).toEqual([])
  })

  test('with a ventilation in the room, it starts it', () => {
    const fan = device({ id: 'vmc', name: 'VMC chambre', category: 'climate', capabilities: ['fan'], state: { fanMode: 'off', fanSpeed: 0 }, areaId: 'chambre' })
    expect(decideReflexes(world({ devices: [co2(1600), fan] }))[0]?.commands).toEqual([{ deviceId: 'vmc', command: 'setFanMode', args: { mode: 'high' } }])
  })

  test('back under 1 000 ppm, the episode closes quietly', () => {
    const episode: ReflexEpisode = { key: 'stale_air:chambre', reflex: 'stale_air', openedAt: NOW.toISOString(), restore: [] }
    expect(decideReflexes(world({ devices: [co2(900)], episodes: [episode] }))[0]).toMatchObject({ closes: 'stale_air:chambre', commands: [], silent: true })
  })
})

describe('frost', () => {
  test('7 °C inside with the heating off: frost protection at 8 °C', () => {
    const [decision] = decideReflexes(world({ devices: [thermostat({ hvacMode: 'off', targetTemperature: 19, currentTemperature: 6.5 })] }))
    expect(decision).toMatchObject({
      reflex: 'frost_guard',
      severity: 'warning',
      commands: [
        { deviceId: 'thermo-salon', command: 'setHvacMode', args: { mode: 'heat' } },
        { deviceId: 'thermo-salon', command: 'setTargetTemperature', args: { celsius: 8 } },
      ],
    })
  })

  test('cold but heating, or 12 °C, is not frost', () => {
    expect(decideReflexes(world({ devices: [thermostat({ hvacMode: 'heat', targetTemperature: 19, currentTemperature: 6.5 })] }))).toEqual([])
    expect(decideReflexes(world({ devices: [thermostat({ hvacMode: 'off', targetTemperature: 19, currentTemperature: 12 })] }))).toEqual([])
  })
})

describe('what the person switched off', () => {
  test('a disabled reflex decides nothing', () => {
    const contact = windowSensor(true)
    expect(decideReflexes(world({ devices: [contact, thermostat()], changed: { [`${contact.id}:open`]: ago(5) }, disabled: ['window_heating'] }))).toEqual([])
  })
})

describe('saying what it does on its own', () => {
  const all = REFLEXES.map((reflex) => reflex.id)

  test('acting alone: one sentence, three reflexes at most, and what it did today', () => {
    const sentence = describeAutonomy({ actsAlone: true, enabled: all, today: 2 })
    expect(sentence.startsWith("J'agis seul")).toBe(true)
    expect(sentence.endsWith('.')).toBe(true)
    expect(sentence.split('. ').length).toBe(1)
    expect(chipsOf(sentence).length).toBeLessThanOrEqual(4)
    expect(chipsOf(sentence).map((segment) => segment.text)).toContain('2 fois')
  })

  test('nothing done yet today: no count', () => {
    expect(describeAutonomy({ actsAlone: true, enabled: ['window_heating'], today: 0 })).not.toMatch(/aujourd/)
  })

  test('below copilot it says it spots but asks, and how to let it act', () => {
    const sentence = describeAutonomy({ actsAlone: false, enabled: all, today: 0 })
    expect(sentence).toMatch(/demande/)
    expect(sentence).toMatch(/agis seul/)
  })

  test('every reflex switched off: it only acts when asked', () => {
    expect(describeAutonomy({ actsAlone: true, enabled: [], today: 0 })).toMatch(/sur demande/)
  })
})
