/**
 * LG webOS over SSAP, the parts that do not need a TV.
 *
 * A webOS TV answers JSON over a WebSocket on port 3000 (3001 with TLS on recent firmware).
 * The client registers with a manifest; the first time, the TV shows a prompt and hands back
 * a client key that skips the prompt ever after. Requests are `{id, type, uri: 'ssap://...',
 * payload}`; answers carry the same id, and a failure is either `type: 'error'` or a payload
 * with `returnValue: false`.
 *
 * Since webOS 26 (2026 firmware) the historical *signed* manifest is refused ("403 Pairing
 * rejected: blacklisted certificate detected"); the unsigned one, with every permission in
 * the outer list, pairs on every firmware.
 *
 * Sources: aiowebostv 0.9.2 (handshake.py, endpoints.py, webos_client.py) and its PR #719,
 * Home Assistant's webostv media_player, home-assistant/core#179669.
 */

import { describe, expect, test } from 'bun:test'
import {
  LIVE_TV_APP,
  commandActions,
  currentSource,
  failureOf,
  findSource,
  isOn,
  playbackFrom,
  registerMessage,
  requestMessage,
  sourcesFrom,
  volumeFrom,
  type TvView,
} from '#adapters/webos_codec'

const INPUTS = {
  devices: [
    { id: 'HDMI_1', label: 'HDMI 1', appId: 'com.webos.app.hdmi1', connected: true },
    { id: 'HDMI_2', label: 'Console', appId: 'com.webos.app.hdmi2', connected: true },
  ],
}
const APPS = {
  launchPoints: [
    { id: 'netflix', title: 'Netflix' },
    { id: 'youtube.leanback.v4', title: 'YouTube' },
    { id: 'com.webos.app.hdmi1', title: 'HDMI 1' },
    { id: LIVE_TV_APP, title: 'Live TV' },
  ],
}

const sources = sourcesFrom(INPUTS, APPS)

function tv(patch: Partial<TvView> = {}): TvView {
  return { on: true, screenOn: true, appId: 'netflix', volume: 10, sources, ...patch }
}

describe('registering', () => {
  test('the first time: an unsigned manifest, a prompt on screen, no key yet', () => {
    const message = registerMessage(null)
    expect(message).toMatchObject({ type: 'register', id: 'register_0', payload: { forcePairing: false, pairingType: 'PROMPT' } })
    expect('client-key' in message.payload).toBe(false)
    expect(message.payload.manifest).not.toHaveProperty('signed')
    expect(message.payload.manifest).not.toHaveProperty('signatures')
    for (const permission of ['CONTROL_POWER', 'CONTROL_AUDIO', 'READ_POWER_STATE', 'WRITE_NOTIFICATION_TOAST', 'READ_INSTALLED_APPS', 'READ_INPUT_DEVICE_LIST']) {
      expect(message.payload.manifest.permissions).toContain(permission)
    }
  })

  test('after that, the key the TV gave skips the prompt', () => {
    expect(registerMessage('0123abcd').payload['client-key']).toBe('0123abcd')
  })
})

describe('requests and answers', () => {
  test('a request names its service with the ssap scheme', () => {
    expect(requestMessage('7', 'audio/getVolume')).toEqual({ id: '7', type: 'request', uri: 'ssap://audio/getVolume', payload: {} })
    expect(requestMessage('8', 'audio/getVolume', {}, 'subscribe').type).toBe('subscribe')
  })

  test('a failure is an error message or a payload that says returnValue: false', () => {
    expect(failureOf({ type: 'error', id: '1', error: '401 insufficient permissions', payload: {} })).toBe('401 insufficient permissions')
    expect(failureOf({ type: 'response', id: '1', payload: { returnValue: false, errorText: 'Invalid input' } })).toBe('Invalid input')
    expect(failureOf({ type: 'response', id: '1', payload: { returnValue: false, errorCode: -1000 } })).toBe('erreur -1000')
    expect(failureOf({ type: 'response', id: '1', payload: { returnValue: true } })).toBeNull()
  })
})

describe('what the TV is doing', () => {
  test('on, including with the screen off; off in standby', () => {
    expect(isOn('Active', null)).toBe(true)
    expect(isOn('Screen Off', null)).toBe(true)
    for (const state of ['Active Standby', 'Suspend', 'Power Off']) expect(isOn(state, 'netflix')).toBe(false)
  })

  test('older TVs without a power service: on when an app is in front', () => {
    expect(isOn(null, 'com.webos.app.hdmi1')).toBe(true)
    expect(isOn(null, '')).toBe(false)
    expect(isOn(null, null)).toBe(false)
  })

  test('volume and mute, from either payload shape', () => {
    expect(volumeFrom({ volumeStatus: { volume: 12, muteStatus: true } })).toEqual({ volume: 12, muted: true })
    expect(volumeFrom({ volume: 9, muted: false })).toEqual({ volume: 9, muted: false })
    expect(volumeFrom({ mute: true })).toEqual({ muted: true })
  })

  test('playback from the media foreground info', () => {
    expect(playbackFrom({ foregroundAppInfo: [{ appId: 'netflix', playState: 'playing' }] })).toBe('playing')
    expect(playbackFrom({ foregroundAppInfo: [{ playState: 'paused' }] })).toBe('paused')
    expect(playbackFrom({ foregroundAppInfo: [{ playState: 'unloaded' }] })).toBe('idle')
    expect(playbackFrom({ foregroundAppInfo: [] })).toBeNull()
  })
})

describe('sources', () => {
  test('inputs by label, apps by title, an input never listed twice', () => {
    expect(sources.map((source) => [source.kind, source.label])).toEqual([
      ['input', 'HDMI 1'],
      ['input', 'Console'],
      ['app', 'Netflix'],
      ['app', 'YouTube'],
      ['app', 'Live TV'],
    ])
  })

  test('Live TV is always offered, even when the TV does not list it', () => {
    const bare = sourcesFrom({ devices: [] }, { launchPoints: [{ id: 'netflix', title: 'Netflix' }] })
    expect(bare.find((source) => source.appId === LIVE_TV_APP)?.label).toBe('TV en direct')
  })

  test('the current source is named after the input or the app in front', () => {
    expect(currentSource(sources, 'com.webos.app.hdmi2')).toBe('Console')
    expect(currentSource(sources, 'netflix')).toBe('Netflix')
    expect(currentSource(sources, 'com.unknown.app')).toBeNull()
  })

  test('found however it is said', () => {
    expect(findSource(sources, 'netflix')?.id).toBe('netflix')
    expect(findSource(sources, 'hdmi1')?.id).toBe('HDMI_1')
    expect(findSource(sources, 'la console')?.id).toBe('HDMI_2')
    expect(findSource(sources, 'Disney+')).toBeNull()
  })
})

describe('commands', () => {
  const request = (uri: string, payload?: Record<string, unknown>) => ({ kind: 'request' as const, uri, ...(payload ? { payload } : {}) })

  test('power: off by request, on by waking the TV, or just its screen', () => {
    expect(commandActions('turnOff', {}, tv())).toEqual({ actions: [request('system/turnOff')], expect: { on: false } })
    expect(commandActions('turnOn', {}, tv({ on: false }))).toEqual({ actions: [{ kind: 'wake' }], expect: { on: true } })
    expect(commandActions('turnOn', {}, tv({ screenOn: false }))).toEqual({ actions: [request('com.webos.service.tvpower/power/turnOnScreen')], expect: { on: true } })
    expect(commandActions('turnOn', {}, tv())).toEqual({ actions: [], expect: { on: true } })
    expect(commandActions('toggle', {}, tv({ on: false }))).toEqual({ actions: [{ kind: 'wake' }], expect: { on: true } })
  })

  test('volume: absolute, clamped; a step from the known level; mute', () => {
    expect(commandActions('setVolume', { volume: 150 }, tv())).toEqual({ actions: [request('audio/setVolume', { volume: 100 })], expect: { volume: 100 } })
    expect(commandActions('stepVolume', { delta: 5 }, tv({ volume: 10 }))).toEqual({ actions: [request('audio/setVolume', { volume: 15 })], expect: { volume: 15 } })
    expect(commandActions('stepVolume', { delta: -3 }, tv({ volume: null }))).toEqual({ actions: [request('audio/volumeDown'), request('audio/volumeDown'), request('audio/volumeDown')] })
    expect(commandActions('setMuted', { muted: true }, tv())).toEqual({ actions: [request('audio/setMute', { mute: true })], expect: { muted: true } })
  })

  test('transport, and next is the next channel on live TV', () => {
    expect(commandActions('pause', {}, tv())).toEqual({ actions: [request('media.controls/pause')], expect: { playback: 'paused' } })
    expect(commandActions('next', {}, tv({ appId: LIVE_TV_APP }))).toEqual({ actions: [request('tv/channelUp')] })
    expect(commandActions('previous', {}, tv())).toEqual({ actions: [request('media.controls/rewind')] })
  })

  test('a source is an input switch or an app launch', () => {
    expect(commandActions('setSource', { source: 'Console' }, tv())).toEqual({ actions: [request('tv/switchInput', { inputId: 'HDMI_2' })], expect: { source: 'Console' } })
    expect(commandActions('setSource', { source: 'youtube' }, tv())).toEqual({
      actions: [request('com.webos.applicationManager/launch', { id: 'youtube.leanback.v4' })],
      expect: { source: 'YouTube' },
    })
    expect(commandActions('setSource', { source: 'Disney+' }, tv())).toEqual({ error: 'Aucune source "Disney+" sur ce téléviseur.' })
  })

  test('a notification is a toast on screen, with its title', () => {
    expect(commandActions('notify', { message: 'Le linge est prêt', title: 'Lave-linge' }, tv())).toEqual({
      actions: [request('system.notifications/createToast', { message: 'Lave-linge : Le linge est prêt' })],
    })
  })

  test('a web address opens on the TV; a search does not', () => {
    expect(commandActions('playMedia', { query: 'https://www.youtube.com/watch?v=x', kind: 'url' }, tv())).toEqual({
      actions: [request('system.launcher/open', { target: 'https://www.youtube.com/watch?v=x' })],
    })
    expect(commandActions('playMedia', { query: 'Daft Punk' }, tv())).toHaveProperty('error')
  })

  test('a TV that is off only takes on and off; seeking is not something it can do', () => {
    expect(commandActions('setVolume', { volume: 20 }, tv({ on: false }))).toEqual({ error: 'Le téléviseur est éteint.' })
    expect(commandActions('turnOff', {}, tv({ on: false }))).toEqual({ actions: [], expect: { on: false } })
    expect(commandActions('seek', { positionSeconds: 10 }, tv())).toHaveProperty('error')
  })
})
