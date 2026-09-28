/**
 * Sonos over UPnP, translated.
 *
 * Every Sonos player answers SOAP on port 1400. Three services matter here:
 *   AVTransport (/MediaRenderer/AVTransport/Control)        play, pause, seek, what is playing
 *   RenderingControl (/MediaRenderer/RenderingControl/Control)  volume and mute, per speaker
 *   ZoneGroupTopology (/ZoneGroupTopology/Control)          who coordinates which group
 *
 * Transport belongs to the group coordinator - a grouped member answers GetTransportInfo with
 * PLAYING whatever is happening, and refuses transport actions with UPnP error 800 - so every
 * transport call carries `scope: 'group'` and the adapter routes it; volume is `scope: 'player'`.
 * Sources: https://sonos.svrooij.io/services/av-transport and SoCo (zonegroupstate.py).
 */

import { decodeXml, elements, firstText } from '#adapters/soap_xml'

export const SONOS_PORT = 1400

export const SONOS_SERVICES = {
  AVTransport: { path: '/MediaRenderer/AVTransport/Control', type: 'urn:schemas-upnp-org:service:AVTransport:1' },
  RenderingControl: { path: '/MediaRenderer/RenderingControl/Control', type: 'urn:schemas-upnp-org:service:RenderingControl:1' },
  ZoneGroupTopology: { path: '/ZoneGroupTopology/Control', type: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1' },
} as const

export type SonosService = keyof typeof SONOS_SERVICES

export interface SonosDescription {
  uuid: string
  room: string
  model: string
  modelNumber: string | null
  serial: string | null
  firmware: string | null
  /** False for a Boost or a Bridge: on the network, but nothing to play on. */
  player: boolean
}

export function parseDescription(xml: string): SonosDescription | null {
  const udn = firstText(xml, 'UDN')
  if (!udn || !/RINCON_/i.test(udn)) return null
  const model = firstText(xml, 'modelName') ?? 'Sonos'
  const renders = /urn:schemas-upnp-org:service:AVTransport:1/.test(xml)
  return {
    uuid: udn.replace(/^uuid:/, ''),
    room: firstText(xml, 'roomName') ?? firstText(xml, 'displayName') ?? model,
    model,
    modelNumber: firstText(xml, 'modelNumber'),
    serial: firstText(xml, 'serialNum'),
    firmware: firstText(xml, 'softwareVersion'),
    player: renders && !/boost|bridge/i.test(model),
  }
}

export interface SonosGroup {
  coordinator: string
  members: { uuid: string; address: string; room: string; invisible: boolean }[]
}

/** The ZoneGroupState XML, already unescaped from its SOAP envelope; either firmware format. */
export function parseZoneGroups(xml: string): SonosGroup[] {
  return elements(xml, 'ZoneGroup').map((group) => ({
    coordinator: group.attributes.Coordinator ?? '',
    members: elements(group.inner, 'ZoneGroupMember').map((member) => {
      let address = ''
      try {
        address = new URL(member.attributes.Location ?? '').host
      } catch {
        address = ''
      }
      return { uuid: member.attributes.UUID ?? '', address, room: member.attributes.ZoneName ?? '', invisible: member.attributes.Invisible === '1' }
    }),
  }))
}

export function playbackFrom(transportState: string | null): 'playing' | 'paused' | 'stopped' | 'buffering' | 'idle' {
  switch (transportState) {
    case 'PLAYING':
      return 'playing'
    case 'PAUSED_PLAYBACK':
      return 'paused'
    case 'STOPPED':
      return 'stopped'
    case 'TRANSITIONING':
      return 'buffering'
    default:
      return 'idle'
  }
}

export function parseTime(value: string | null): number | null {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(value ?? '')
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export interface SonosTrack {
  title: string | null
  artist: string | null
  album: string | null
  artworkUrl: string | null
}

/** DIDL-Lite track metadata. Artwork paths are relative to the speaker that served them. */
export function parseTrack(didl: string, address: string): SonosTrack {
  const art = firstText(didl, 'albumArtURI')
  return {
    title: firstText(didl, 'title') ?? firstText(didl, 'streamContent'),
    artist: firstText(didl, 'creator'),
    album: firstText(didl, 'album'),
    artworkUrl: art ? (/^https?:\/\//.test(art) ? art : `http://${address}${art.startsWith('/') ? '' : '/'}${art}`) : null,
  }
}

export interface SonosCall {
  scope: 'group' | 'player'
  service: SonosService
  action: string
  args: Record<string, string | number>
}

const transport = (action: string, args: Record<string, string | number> = {}): SonosCall => ({ scope: 'group', service: 'AVTransport', action, args: { InstanceID: 0, ...args } })
const rendering = (action: string, args: Record<string, string | number>): SonosCall => ({ scope: 'player', service: 'RenderingControl', action, args: { InstanceID: 0, Channel: 'Master', ...args } })

export function commandCalls(command: string, args: Record<string, unknown>): SonosCall[] | null {
  switch (command) {
    case 'play':
      return [transport('Play', { Speed: 1 })]
    case 'pause':
      return [transport('Pause')]
    case 'stopPlayback':
      return [transport('Stop')]
    case 'next':
      return [transport('Next')]
    case 'previous':
      return [transport('Previous')]
    case 'seek':
      return [transport('Seek', { Unit: 'REL_TIME', Target: formatTime(Number(args.positionSeconds)) })]
    case 'setVolume':
      return [rendering('SetVolume', { DesiredVolume: Math.round(Math.min(100, Math.max(0, Number(args.volume)))) })]
    case 'stepVolume':
      return [rendering('SetRelativeVolume', { Adjustment: Math.round(Number(args.delta)) })]
    case 'setMuted':
      return [rendering('SetMute', { DesiredMute: args.muted ? 1 : 0 })]
    case 'playMedia': {
      const query = String(args.query ?? '')
      // Only a URL can be played directly; a search needs a music service account.
      if (!/^(https?|x-rincon-mp3radio|x-sonosapi-stream):/.test(query)) return null
      return [transport('SetAVTransportURI', { CurrentURI: query, CurrentURIMetaData: '' }), transport('Play', { Speed: 1 })]
    }
    default:
      return null
  }
}

/** ZoneGroupState comes back escaped inside the SOAP answer. */
export function zoneGroupStateFrom(soapAnswer: string): string {
  const inner = firstText(soapAnswer, 'ZoneGroupState') ?? ''
  return /<ZoneGroup/.test(inner) ? inner : decodeXml(inner)
}
