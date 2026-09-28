/**
 * Sonos over UPnP, the parts that do not need a network.
 *
 * A Sonos speaker answers SOAP on port 1400. Transport commands (play, pause, next) belong
 * to the group coordinator - a grouped member answers `GetTransportInfo` with PLAYING
 * whatever the group is doing, and refuses transport actions with UPnP error 800 - while
 * volume belongs to each speaker. The zone topology says who coordinates whom, as XML
 * escaped inside a SOAP answer.
 *
 * Sources: https://sonos.svrooij.io/services/av-transport,
 * https://sonos.svrooij.io/services/zone-group-topology, SoCo's zonegroupstate.py.
 */

import { describe, expect, test } from 'bun:test'
import { commandCalls, formatTime, parseDescription, parseTime, parseTrack, parseZoneGroups, playbackFrom } from '#adapters/sonos_codec'

const DESCRIPTION = `<?xml version="1.0" encoding="utf-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>
    <friendlyName>192.168.1.20 - Sonos One - RINCON_48A6B8000001001400</friendlyName>
    <manufacturer>Sonos, Inc.</manufacturer>
    <modelNumber>S18</modelNumber>
    <modelName>Sonos One</modelName>
    <softwareVersion>80.1-55240</softwareVersion>
    <serialNum>48-A6-B8-00-00-01:A</serialNum>
    <UDN>uuid:RINCON_48A6B8000001001400</UDN>
    <roomName>Salon</roomName>
    <displayName>One</displayName>
    <deviceList>
      <device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
        <serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType></service></serviceList>
      </device>
    </deviceList>
  </device>
</root>`

const BOOST = DESCRIPTION.replace('<modelName>Sonos One</modelName>', '<modelName>Sonos Boost</modelName>').replace(/<deviceList>[\s\S]*<\/deviceList>/, '')

const TOPOLOGY = `<ZoneGroupState><ZoneGroups>
<ZoneGroup Coordinator="RINCON_A01400" ID="RINCON_A01400:12">
  <ZoneGroupMember UUID="RINCON_A01400" Location="http://192.168.1.20:1400/xml/device_description.xml" ZoneName="Salon"/>
  <ZoneGroupMember UUID="RINCON_B01400" Location="http://192.168.1.21:1400/xml/device_description.xml" ZoneName="Cuisine"/>
  <ZoneGroupMember UUID="RINCON_S01400" Location="http://192.168.1.22:1400/xml/device_description.xml" ZoneName="Salon" Invisible="1"/>
</ZoneGroup>
<ZoneGroup Coordinator="RINCON_C01400" ID="RINCON_C01400:3">
  <ZoneGroupMember UUID="RINCON_C01400" Location="http://192.168.1.23:1400/xml/device_description.xml" ZoneName="Chambre"/>
</ZoneGroup>
</ZoneGroups><VanishedDevices/></ZoneGroupState>`

describe('what a speaker is', () => {
  test('a player, named after its room', () => {
    expect(parseDescription(DESCRIPTION)).toEqual({
      uuid: 'RINCON_48A6B8000001001400',
      room: 'Salon',
      model: 'Sonos One',
      modelNumber: 'S18',
      serial: '48-A6-B8-00-00-01:A',
      firmware: '80.1-55240',
      player: true,
    })
  })

  test('a Boost or a Bridge is not a player', () => {
    expect(parseDescription(BOOST)?.player).toBe(false)
  })

  test('garbage is not a speaker', () => {
    expect(parseDescription('<html>nope</html>')).toBeNull()
  })
})

describe('the zone topology', () => {
  test('groups, their coordinator, and members with their address', () => {
    const groups = parseZoneGroups(TOPOLOGY)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({
      coordinator: 'RINCON_A01400',
      members: [
        { uuid: 'RINCON_A01400', address: '192.168.1.20:1400', room: 'Salon', invisible: false },
        { uuid: 'RINCON_B01400', address: '192.168.1.21:1400', room: 'Cuisine', invisible: false },
        { uuid: 'RINCON_S01400', address: '192.168.1.22:1400', room: 'Salon', invisible: true },
      ],
    })
  })

  test('the older format, without the ZoneGroupState wrapper, reads the same', () => {
    const older = TOPOLOGY.replace('<ZoneGroupState>', '').replace('<VanishedDevices/></ZoneGroupState>', '')
    expect(parseZoneGroups(older)).toEqual(parseZoneGroups(TOPOLOGY))
  })
})

describe('what is playing', () => {
  test('transport states in Sway words', () => {
    expect(playbackFrom('PLAYING')).toBe('playing')
    expect(playbackFrom('PAUSED_PLAYBACK')).toBe('paused')
    expect(playbackFrom('STOPPED')).toBe('stopped')
    expect(playbackFrom('TRANSITIONING')).toBe('buffering')
    expect(playbackFrom('NO_MEDIA_PRESENT')).toBe('idle')
  })

  test('hh:mm:ss both ways', () => {
    expect(parseTime('0:03:21')).toBe(201)
    expect(parseTime('1:00:00')).toBe(3600)
    expect(parseTime('NOT_IMPLEMENTED')).toBeNull()
    expect(formatTime(90)).toBe('0:01:30')
    expect(formatTime(3725)).toBe('1:02:05')
  })

  test('title, artist, album and artwork from the track metadata', () => {
    const didl =
      '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="-1" parentID="-1"><dc:title>Clair de lune</dc:title><dc:creator>Debussy &amp; Co</dc:creator><upnp:album>Suite bergamasque</upnp:album><upnp:albumArtURI>/getaa?s=1&amp;u=x-sonos-spotify</upnp:albumArtURI></item></DIDL-Lite>'
    expect(parseTrack(didl, '192.168.1.20:1400')).toEqual({ title: 'Clair de lune', artist: 'Debussy & Co', album: 'Suite bergamasque', artworkUrl: 'http://192.168.1.20:1400/getaa?s=1&u=x-sonos-spotify' })
    expect(parseTrack('', '192.168.1.20:1400')).toEqual({ title: null, artist: null, album: null, artworkUrl: null })
  })
})

describe('commands as SOAP calls', () => {
  test('transport goes to the group; each call names its service and action', () => {
    expect(commandCalls('play', {})).toEqual([{ scope: 'group', service: 'AVTransport', action: 'Play', args: { InstanceID: 0, Speed: 1 } }])
    expect(commandCalls('pause', {})).toEqual([{ scope: 'group', service: 'AVTransport', action: 'Pause', args: { InstanceID: 0 } }])
    expect(commandCalls('next', {})?.[0]).toMatchObject({ action: 'Next' })
    expect(commandCalls('seek', { positionSeconds: 90 })).toEqual([{ scope: 'group', service: 'AVTransport', action: 'Seek', args: { InstanceID: 0, Unit: 'REL_TIME', Target: '0:01:30' } }])
  })

  test('volume belongs to the speaker itself', () => {
    expect(commandCalls('setVolume', { volume: 35 })).toEqual([{ scope: 'player', service: 'RenderingControl', action: 'SetVolume', args: { InstanceID: 0, Channel: 'Master', DesiredVolume: 35 } }])
    expect(commandCalls('stepVolume', { delta: -5 })).toEqual([{ scope: 'player', service: 'RenderingControl', action: 'SetRelativeVolume', args: { InstanceID: 0, Channel: 'Master', Adjustment: -5 } }])
    expect(commandCalls('setMuted', { muted: true })).toEqual([{ scope: 'player', service: 'RenderingControl', action: 'SetMute', args: { InstanceID: 0, Channel: 'Master', DesiredMute: 1 } }])
  })

  test('a URL is loaded, then played', () => {
    expect(commandCalls('playMedia', { query: 'http://radio.example/stream.mp3', kind: 'url' })).toEqual([
      { scope: 'group', service: 'AVTransport', action: 'SetAVTransportURI', args: { InstanceID: 0, CurrentURI: 'http://radio.example/stream.mp3', CurrentURIMetaData: '' } },
      { scope: 'group', service: 'AVTransport', action: 'Play', args: { InstanceID: 0, Speed: 1 } },
    ])
  })

  test('a search query is not something a speaker can do on its own', () => {
    expect(commandCalls('playMedia', { query: 'Daft Punk' })).toBeNull()
    expect(commandCalls('turnOn', {})).toBeNull()
  })
})
