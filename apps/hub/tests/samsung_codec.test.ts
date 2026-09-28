/**
 * Samsung Tizen TVs, the parts that do not need a TV.
 *
 * A Tizen TV (2016 and later) takes remote keys and app launches over a WebSocket channel,
 * `samsung.remote.control`, on port 8002 with TLS (8001 in clear on older firmware). The
 * first connection makes the TV ask "Autoriser ?" on screen; once allowed, it answers with a
 * token that skips the question ever after. The channel sends nothing on its own: power comes
 * from `GET :8001/api/v2/` (`PowerState`, 2018 and later), volume and mute from the TV's UPnP
 * renderer on port 9197, which only listens while the TV is on.
 *
 * Sources: samsungtvws 2.x (remote.py, connection.py, event.py, rest.py), Home Assistant's
 * samsungtv bridge, ioBroker.samsung_tizen#298 and geoffmcc/sidekick#506 for the renderer.
 */

import { describe, expect, test } from 'bun:test'
import {
  appsFrom,
  commandPlan,
  connectOutcome,
  findSource,
  keyMessages,
  launchMessage,
  muteFrom,
  parseDeviceInfo,
  remoteUrl,
  sourcesFrom,
  volumeFrom,
  type SamsungView,
} from '#adapters/samsung_codec'

const DEVICE_INFO = {
  device: {
    FrameTVSupport: 'false',
    OS: 'Tizen',
    PowerState: 'on',
    TokenAuthSupport: 'true',
    modelName: 'QE55Q80TATXXC',
    name: '[TV] Samsung Q80 Series (55)',
    type: 'Samsung SmartTV',
    wifiMac: 'F4:7B:09:AA:BB:CC',
  },
  name: '[TV] Samsung Q80 Series (55)',
  type: 'Samsung SmartTV',
  version: '2.0.25',
}

const APPS_EVENT = {
  event: 'ed.installedApp.get',
  from: 'host',
  data: {
    data: [
      { appId: '111299001912', app_type: 2, name: 'YouTube', icon: '/opt/share/webappservice/apps_icon/FirstScreen/111299001912/250x250.png' },
      { appId: '3201907018807', app_type: 2, name: 'Netflix' },
      { appId: 'org.tizen.browser', app_type: 4, name: 'Internet' },
    ],
  },
}

const sources = sourcesFrom(appsFrom(APPS_EVENT))

function view(patch: Partial<SamsungView> = {}): SamsungView {
  return { on: true, volume: 12, muted: false, renderer: true, frame: false, sources, ...patch }
}

describe('reaching the TV', () => {
  test('the remote channel, named after the hub, with the token once there is one', () => {
    expect(remoteUrl({ ip: '192.168.1.40', secure: true, port: 8002, name: 'Sway Home', token: null })).toBe(
      'wss://192.168.1.40:8002/api/v2/channels/samsung.remote.control?name=U3dheSBIb21l'
    )
    expect(remoteUrl({ ip: '192.168.1.40', secure: false, port: 8001, name: 'Maison é', token: '12345678' })).toBe(
      'ws://192.168.1.40:8001/api/v2/channels/samsung.remote.control?name=TWFpc29uIMOp&token=12345678'
    )
  })

  test('what the TV says about itself', () => {
    expect(parseDeviceInfo(DEVICE_INFO)).toEqual({
      name: 'Samsung Q80 Series (55)',
      model: 'QE55Q80TATXXC',
      mac: 'f4:7b:09:aa:bb:cc',
      power: 'on',
      tokenAuth: true,
      frame: false,
    })
    expect(parseDeviceInfo({ device: { ...DEVICE_INFO.device, PowerState: 'standby', FrameTVSupport: 'true' } })).toMatchObject({ power: 'standby', frame: true })
    // 2016 and 2017 models do not report their power: reachable means on.
    const { PowerState: _ignored, ...older } = DEVICE_INFO.device
    expect(parseDeviceInfo({ device: older })?.power).toBeNull()
    expect(parseDeviceInfo({ device: { type: 'Samsung Soundbar' } })).toBeNull()
    expect(parseDeviceInfo('not json')).toBeNull()
  })

  test('the answer to a connection: a token, a refusal, or the TV asleep', () => {
    expect(connectOutcome({ event: 'ms.channel.connect', data: { token: '12345678', clients: [] } })).toEqual({ kind: 'connected', token: '12345678' })
    expect(connectOutcome({ event: 'ms.channel.connect', data: { token: 87654321 } })).toEqual({ kind: 'connected', token: '87654321' })
    expect(connectOutcome({ event: 'ms.channel.connect', data: {} })).toEqual({ kind: 'connected', token: null })
    expect(connectOutcome({ event: 'ms.channel.unauthorized' })).toEqual({ kind: 'unauthorized' })
    expect(connectOutcome({ event: 'ms.channel.timeOut' })).toEqual({ kind: 'timeout' })
    expect(connectOutcome({ event: 'ms.error', data: { message: 'unrecognized method value : ms.remote.control' } })).toEqual({
      kind: 'error',
      message: 'unrecognized method value : ms.remote.control',
    })
    expect(connectOutcome({ event: 'ms.channel.clientConnect' })).toBeNull()
  })
})

describe('keys and apps', () => {
  test('a key is a click; a held key is a press, a pause and a release', () => {
    expect(keyMessages('KEY_VOLUP')).toEqual([{ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_VOLUP', Option: 'false', TypeOfRemote: 'SendRemoteKey' } }])
    const held = keyMessages('KEY_POWER', 3)
    expect(held.map((message) => ('params' in message ? message.params.Cmd : message))).toEqual(['Press', { pauseMs: 3000 }, 'Release'])
  })

  test('an app starts by deep link, a native one by native launch', () => {
    expect(launchMessage({ appId: '111299001912', appType: 2 })).toEqual({
      method: 'ms.channel.emit',
      params: { event: 'ed.apps.launch', to: 'host', data: { appId: '111299001912', action_type: 'DEEP_LINK', metaTag: '' } },
    })
    expect(launchMessage({ appId: 'org.tizen.browser', appType: 4 }, 'https://example.org').params.data).toEqual({
      appId: 'org.tizen.browser',
      action_type: 'NATIVE_LAUNCH',
      metaTag: 'https://example.org',
    })
  })

  test('sources: the TV tuner and HDMI first, then every installed app', () => {
    expect(sources.map((source) => source.label)).toEqual(['TV', 'HDMI', 'YouTube', 'Netflix', 'Internet'])
    expect(findSource(sources, 'youtube')?.id).toBe('111299001912')
    expect(findSource(sources, 'la télé')?.id).toBe('KEY_TV')
    expect(findSource(sources, 'hdmi')?.id).toBe('KEY_HDMI')
    expect(findSource(sources, 'Disney+')).toBeNull()
  })

  test('the renderer reads out volume and mute', () => {
    const answer = (name: string, value: string) =>
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:Get${name}Response xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><Current${name}>${value}</Current${name}></u:Get${name}Response></s:Body></s:Envelope>`
    expect(volumeFrom(answer('Volume', '23'))).toBe(23)
    expect(muteFrom(answer('Mute', '1'))).toBe(true)
    expect(muteFrom(answer('Mute', '0'))).toBe(false)
    expect(volumeFrom('<html>nope</html>')).toBeNull()
  })
})

describe('commands', () => {
  test('power: off by the power key, held on a Frame TV; on by waking it', () => {
    expect(commandPlan('turnOff', {}, view())).toEqual({ steps: [{ kind: 'key', key: 'KEY_POWER' }], expect: { on: false } })
    expect(commandPlan('turnOff', {}, view({ frame: true }))).toEqual({ steps: [{ kind: 'key', key: 'KEY_POWER', holdSeconds: 3 }], expect: { on: false } })
    expect(commandPlan('turnOn', {}, view({ on: false }))).toEqual({ steps: [{ kind: 'wake' }], expect: { on: true } })
    expect(commandPlan('turnOn', {}, view())).toEqual({ steps: [], expect: { on: true } })
    expect(commandPlan('toggle', {}, view())).toEqual({ steps: [{ kind: 'key', key: 'KEY_POWER' }], expect: { on: false } })
  })

  test('volume: an exact level through the renderer, clamped', () => {
    expect(commandPlan('setVolume', { volume: 130 }, view())).toEqual({
      steps: [{ kind: 'renderer', action: 'SetVolume', args: { InstanceID: 0, Channel: 'Master', DesiredVolume: 100 } }],
      expect: { volume: 100 },
    })
    expect(commandPlan('stepVolume', { delta: -5 }, view({ volume: 12 }))).toEqual({
      steps: [{ kind: 'renderer', action: 'SetVolume', args: { InstanceID: 0, Channel: 'Master', DesiredVolume: 7 } }],
      expect: { volume: 7 },
    })
    expect(commandPlan('setMuted', { muted: true }, view())).toEqual({
      steps: [{ kind: 'renderer', action: 'SetMute', args: { InstanceID: 0, Channel: 'Master', DesiredMute: 1 } }],
      expect: { muted: true },
    })
  })

  test('without the renderer: steps by key, and an exact level is refused with what to say instead', () => {
    const blind = view({ renderer: false, volume: null, muted: null })
    expect(commandPlan('stepVolume', { delta: 2 }, blind)).toEqual({ steps: [{ kind: 'key', key: 'KEY_VOLUP' }, { kind: 'key', key: 'KEY_VOLUP' }] })
    expect(commandPlan('setVolume', { volume: 20 }, blind)).toEqual({ error: 'Ce téléviseur ne donne pas son niveau de volume : dites plutôt "monte le son" ou "baisse le son".' })
    expect(commandPlan('setMuted', { muted: true }, blind)).toEqual({ steps: [{ kind: 'key', key: 'KEY_MUTE' }], expect: { muted: true } })
    expect(commandPlan('setMuted', { muted: false }, view({ renderer: false, muted: false }))).toEqual({ steps: [], expect: { muted: false } })
  })

  test('playback keys, channels for next and previous', () => {
    expect(commandPlan('pause', {}, view())).toEqual({ steps: [{ kind: 'key', key: 'KEY_PAUSE' }] })
    expect(commandPlan('play', {}, view())).toEqual({ steps: [{ kind: 'key', key: 'KEY_PLAY' }] })
    expect(commandPlan('stopPlayback', {}, view())).toEqual({ steps: [{ kind: 'key', key: 'KEY_STOP' }] })
    expect(commandPlan('next', {}, view())).toEqual({ steps: [{ kind: 'key', key: 'KEY_CHUP' }] })
    expect(commandPlan('previous', {}, view())).toEqual({ steps: [{ kind: 'key', key: 'KEY_CHDOWN' }] })
  })

  test('a source is a key or an app launch; a web address opens in the browser', () => {
    expect(commandPlan('setSource', { source: 'hdmi' }, view())).toEqual({ steps: [{ kind: 'key', key: 'KEY_HDMI' }], expect: { source: 'HDMI' } })
    expect(commandPlan('setSource', { source: 'Netflix' }, view())).toEqual({ steps: [{ kind: 'launch', appId: '3201907018807', appType: 2 }], expect: { source: 'Netflix' } })
    expect(commandPlan('setSource', { source: 'Disney+' }, view())).toEqual({ error: 'Aucune source "Disney+" sur ce téléviseur.' })
    expect(commandPlan('playMedia', { query: 'https://www.youtube.com/watch?v=x' }, view())).toEqual({
      steps: [{ kind: 'launch', appId: 'org.tizen.browser', appType: 4, metaTag: 'https://www.youtube.com/watch?v=x' }],
    })
    expect(commandPlan('playMedia', { query: 'Daft Punk' }, view())).toHaveProperty('error')
  })

  test('a TV that is off only takes on and off; what it cannot do is said', () => {
    expect(commandPlan('setVolume', { volume: 20 }, view({ on: false }))).toEqual({ error: 'Le téléviseur est éteint.' })
    expect(commandPlan('turnOff', {}, view({ on: false }))).toEqual({ steps: [], expect: { on: false } })
    expect(commandPlan('notify', { message: 'x' }, view())).toHaveProperty('error')
  })
})
