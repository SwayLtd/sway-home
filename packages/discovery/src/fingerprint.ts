/**
 * Turning a host into a guess.
 *
 * Discovery produces facts (this IP has 8009 open, advertises `_googlecast._tcp`, and its
 * MAC belongs to Google). This file turns those facts into a category, a vendor and a
 * confidence - and nothing more. Deciding that the thing is controllable is an adapter's
 * job, and it will overwrite this guess the moment it succeeds.
 *
 * Every rule carries a weight rather than a boolean, because the cheap signals (a MAC
 * prefix) and the strong ones (an mDNS service type that only one product uses) must not
 * count the same.
 */

import type { DeviceCategory, NetworkHost } from '@sway-home/shared'

export interface Fingerprint {
  category: DeviceCategory
  vendor: string | null
  productGuess: string | null
  /** 0 to 1. Above 0.8 the UI stops saying "probably". */
  confidence: number
  /** Adapter ids worth trying against this host, best first. */
  suggestedAdapters: string[]
  /** Human-readable reasons, shown in the device drawer so a guess is never a black box. */
  evidence: string[]
}

interface Rule {
  name: string
  weight: number
  category?: DeviceCategory
  vendor?: string
  product?: string
  adapters?: string[]
  test: (host: NetworkHost) => boolean
}

const hasService = (host: NetworkHost, needle: string) => host.mdnsServices.some((s) => s.includes(needle))
const hasPort = (host: NetworkHost, ...ports: number[]) => ports.some((p) => host.openPorts.includes(p))
const vendorIs = (host: NetworkHost, pattern: RegExp) => host.macVendor !== null && pattern.test(host.macVendor)
const textMatch = (host: NetworkHost, pattern: RegExp) =>
  [host.hostname, host.httpBanner, host.httpTitle, host.ssdp?.server, host.ssdp?.friendlyName, host.ssdp?.modelName]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .some((v) => pattern.test(v))
const txtMatch = (host: NetworkHost, key: string, pattern: RegExp) => {
  const value = host.mdnsTxt[key]
  return typeof value === 'string' && pattern.test(value)
}

/**
 * Ordered by how much a hit tells you. An mDNS service type is near-proof; an open port 80
 * tells you almost nothing on its own.
 */
const RULES: Rule[] = [
  // --- near-proof: service types owned by one product ----------------------------------
  { name: 'mDNS _hue._tcp', weight: 0.95, category: 'hub', vendor: 'Signify (Philips Hue)', product: 'Hue Bridge', adapters: ['hue'], test: (h) => hasService(h, '_hue._tcp') },
  { name: 'mDNS _googlecast._tcp', weight: 0.9, category: 'media', vendor: 'Google', adapters: ['googlecast'], test: (h) => hasService(h, '_googlecast._tcp') },
  { name: 'mDNS _sonos._tcp', weight: 0.92, category: 'speaker', vendor: 'Sonos', adapters: ['sonos'], test: (h) => hasService(h, '_sonos._tcp') },
  { name: 'mDNS _esphomelib._tcp', weight: 0.95, category: 'sensor', vendor: 'ESPHome', adapters: ['esphome'], test: (h) => hasService(h, '_esphomelib._tcp') },
  { name: 'mDNS _shelly._tcp', weight: 0.95, category: 'switch', vendor: 'Shelly', adapters: ['shelly'], test: (h) => hasService(h, '_shelly._tcp') },
  { name: 'mDNS _wled._tcp', weight: 0.95, category: 'light', vendor: 'WLED', adapters: ['wled'], test: (h) => hasService(h, '_wled._tcp') },
  { name: 'mDNS _tasmota._tcp', weight: 0.92, category: 'switch', vendor: 'Tasmota', adapters: ['tasmota'], test: (h) => hasService(h, '_tasmota._tcp') },
  { name: 'mDNS _matter._tcp', weight: 0.97, category: 'unknown', adapters: ['matter'], test: (h) => hasService(h, '_matter._tcp') },
  { name: 'mDNS _matterc._udp (uncommissioned)', weight: 0.97, category: 'unknown', adapters: ['matter'], test: (h) => hasService(h, '_matterc._udp') },
  { name: 'mDNS _meshcop._udp (Thread border router)', weight: 0.9, category: 'gateway', adapters: ['matter', 'thread'], test: (h) => hasService(h, '_meshcop._udp') },
  { name: 'mDNS _hap._tcp (HomeKit)', weight: 0.88, category: 'unknown', adapters: ['homekit'], test: (h) => hasService(h, '_hap._tcp') },
  { name: 'mDNS _nanoleafapi._tcp', weight: 0.95, category: 'light', vendor: 'Nanoleaf', adapters: ['nanoleaf'], test: (h) => hasService(h, '_nanoleafapi._tcp') },
  { name: 'mDNS _airplay._tcp', weight: 0.85, category: 'media', vendor: 'Apple', adapters: ['airplay'], test: (h) => hasService(h, '_airplay._tcp') },
  { name: 'mDNS _raop._tcp', weight: 0.8, category: 'speaker', adapters: ['airplay'], test: (h) => hasService(h, '_raop._tcp') },
  { name: 'mDNS _spotify-connect._tcp', weight: 0.7, category: 'speaker', adapters: ['spotify'], test: (h) => hasService(h, '_spotify-connect') },
  { name: 'mDNS _printer/_ipp', weight: 0.9, category: 'printer', adapters: [], test: (h) => hasService(h, '_ipp._tcp') || hasService(h, '_printer._tcp') || hasService(h, '_pdl-datastream') },
  { name: 'mDNS _home-assistant._tcp', weight: 0.95, category: 'hub', vendor: 'Home Assistant', adapters: ['homeassistant'], test: (h) => hasService(h, '_home-assistant._tcp') },
  { name: 'mDNS _octoprint/_prusa/_bambu', weight: 0.9, category: 'appliance', adapters: [], test: (h) => hasService(h, '_octoprint') || hasService(h, '_prusa-link') || hasService(h, '_bambulab') },
  { name: 'mDNS _miio._udp', weight: 0.9, category: 'unknown', vendor: 'Xiaomi', adapters: ['miio'], test: (h) => hasService(h, '_miio._udp') },
  { name: 'mDNS _dyson_mqtt._tcp', weight: 0.95, category: 'appliance', vendor: 'Dyson', adapters: ['dyson'], test: (h) => hasService(h, '_dyson_mqtt') },
  { name: 'mDNS _elg._tcp (Elgato)', weight: 0.95, category: 'light', vendor: 'Elgato', adapters: ['elgato'], test: (h) => hasService(h, '_elg._tcp') },
  { name: 'mDNS _freebox/_livebox/_bbox', weight: 0.9, category: 'gateway', adapters: ['router'], test: (h) => hasService(h, '_freebox') || hasService(h, '_livebox') || hasService(h, '_bbox') },

  // --- ports that only one product uses -------------------------------------------------
  { name: 'port 1400 (Sonos)', weight: 0.85, category: 'speaker', vendor: 'Sonos', adapters: ['sonos'], test: (h) => hasPort(h, 1400) },
  { name: 'port 8060 (Roku ECP)', weight: 0.9, category: 'media', vendor: 'Roku', adapters: ['roku'], test: (h) => hasPort(h, 8060) },
  { name: 'port 9999 (TP-Link Kasa)', weight: 0.9, category: 'switch', vendor: 'TP-Link', adapters: ['kasa'], test: (h) => hasPort(h, 9999) },
  { name: 'port 56700 (LIFX)', weight: 0.9, category: 'light', vendor: 'LIFX', adapters: ['lifx'], test: (h) => hasPort(h, 56700) },
  { name: 'port 6668 (Tuya local)', weight: 0.85, category: 'switch', vendor: 'Tuya', adapters: ['tuya'], test: (h) => hasPort(h, 6668) },
  { name: 'port 8123 (Home Assistant)', weight: 0.85, category: 'hub', vendor: 'Home Assistant', adapters: ['homeassistant'], test: (h) => hasPort(h, 8123) },
  { name: 'port 32400 (Plex)', weight: 0.85, category: 'media', vendor: 'Plex', adapters: ['plex'], test: (h) => hasPort(h, 32400) },
  { name: 'port 1883/8883 (MQTT broker)', weight: 0.8, category: 'hub', adapters: ['mqtt'], test: (h) => hasPort(h, 1883, 8883) },
  { name: 'port 5540 (Matter operational)', weight: 0.85, category: 'unknown', adapters: ['matter'], test: (h) => hasPort(h, 5540) },
  { name: 'port 554 (RTSP)', weight: 0.7, category: 'camera', adapters: ['onvif'], test: (h) => hasPort(h, 554) },
  { name: 'port 9100/631 (printer)', weight: 0.75, category: 'printer', adapters: [], test: (h) => hasPort(h, 9100, 631) },
  { name: 'port 8008/8009 (Cast)', weight: 0.8, category: 'media', vendor: 'Google', adapters: ['googlecast'], test: (h) => hasPort(h, 8008, 8009) },
  { name: 'port 7000 (AirPlay)', weight: 0.6, category: 'media', adapters: ['airplay'], test: (h) => hasPort(h, 7000) },
  { name: 'port 445/139 (SMB host)', weight: 0.45, category: 'computer', adapters: [], test: (h) => hasPort(h, 445, 139) },
  { name: 'port 53 (DNS server)', weight: 0.4, category: 'gateway', adapters: [], test: (h) => hasPort(h, 53) },

  // --- SSDP and HTTP text ---------------------------------------------------------------
  { name: 'SSDP Sonos ZonePlayer', weight: 0.9, category: 'speaker', vendor: 'Sonos', adapters: ['sonos'], test: (h) => textMatch(h, /ZonePlayer|Sonos/i) },
  { name: 'SSDP Samsung TV', weight: 0.85, category: 'display', vendor: 'Samsung', adapters: ['samsungtv'], test: (h) => textMatch(h, /Samsung.*(TV|Display)|RemoteControlReceiver/i) },
  { name: 'SSDP LG webOS', weight: 0.85, category: 'display', vendor: 'LG', adapters: ['webos'], test: (h) => textMatch(h, /webOS|LG Smart ?TV/i) },
  { name: 'SSDP Sony Bravia', weight: 0.85, category: 'display', vendor: 'Sony', adapters: ['bravia'], test: (h) => textMatch(h, /BRAVIA|ScalarWebAPI/i) },
  { name: 'SSDP Wemo', weight: 0.9, category: 'switch', vendor: 'Belkin', adapters: ['wemo'], test: (h) => textMatch(h, /Belkin|Wemo/i) },
  { name: 'SSDP Freebox', weight: 0.9, category: 'gateway', vendor: 'Free', adapters: ['freebox'], test: (h) => textMatch(h, /Freebox/i) },
  { name: 'SSDP Livebox / Orange', weight: 0.85, category: 'gateway', vendor: 'Orange', adapters: ['router'], test: (h) => textMatch(h, /Livebox|Orange/i) },
  { name: 'HTTP title Shelly', weight: 0.9, category: 'switch', vendor: 'Shelly', adapters: ['shelly'], test: (h) => textMatch(h, /Shelly/i) },
  { name: 'HTTP title Tasmota', weight: 0.9, category: 'switch', vendor: 'Tasmota', adapters: ['tasmota'], test: (h) => textMatch(h, /Tasmota/i) },
  { name: 'HTTP title WLED', weight: 0.9, category: 'light', vendor: 'WLED', adapters: ['wled'], test: (h) => textMatch(h, /WLED/i) },
  { name: 'HTTP title ESPHome', weight: 0.85, category: 'sensor', vendor: 'ESPHome', adapters: ['esphome'], test: (h) => textMatch(h, /ESPHome/i) },
  { name: 'HTTP server hue', weight: 0.9, category: 'hub', vendor: 'Signify (Philips Hue)', adapters: ['hue'], test: (h) => textMatch(h, /hue.?(bridge|personal)/i) },
  { name: 'HTTP camera vendor', weight: 0.8, category: 'camera', adapters: ['onvif'], test: (h) => textMatch(h, /Hikvision|Dahua|Reolink|Amcrest|Foscam|Axis|Tapo ?C\d/i) },
  { name: 'HTTP NAS', weight: 0.8, category: 'computer', adapters: [], test: (h) => textMatch(h, /Synology|DiskStation|QNAP|TrueNAS|Unraid/i) },
  { name: 'HTTP router', weight: 0.7, category: 'gateway', adapters: ['router'], test: (h) => textMatch(h, /router|gateway|OpenWrt|pfSense|UniFi|FRITZ!/i) },

  // --- mDNS TXT is often the most precise thing on the wire -----------------------------
  { name: 'TXT md= model name', weight: 0.6, test: (h) => typeof h.mdnsTxt.md === 'string' },
  { name: 'TXT Cast model', weight: 0.75, category: 'media', vendor: 'Google', adapters: ['googlecast'], test: (h) => txtMatch(h, 'md', /Chromecast|Nest|Google Home|Android TV/i) },
  { name: 'TXT HomeKit ci= category', weight: 0.7, adapters: ['homekit'], test: (h) => typeof h.mdnsTxt.ci === 'string' },

  // --- MAC vendors: cheap, and only ever a tie-breaker ----------------------------------
  { name: 'MAC Espressif', weight: 0.35, category: 'switch', vendor: 'Espressif', adapters: ['shelly', 'tasmota', 'wled', 'esphome'], test: (h) => vendorIs(h, /Espressif/i) },
  { name: 'MAC Apple', weight: 0.3, category: 'phone', vendor: 'Apple', test: (h) => vendorIs(h, /Apple/i) },
  { name: 'MAC Google', weight: 0.4, category: 'media', vendor: 'Google', adapters: ['googlecast'], test: (h) => vendorIs(h, /Google/i) },
  { name: 'MAC Amazon', weight: 0.4, category: 'speaker', vendor: 'Amazon', test: (h) => vendorIs(h, /Amazon/i) },
  { name: 'MAC Sonos', weight: 0.6, category: 'speaker', vendor: 'Sonos', adapters: ['sonos'], test: (h) => vendorIs(h, /Sonos/i) },
  { name: 'MAC Signify', weight: 0.6, category: 'hub', vendor: 'Signify', adapters: ['hue'], test: (h) => vendorIs(h, /Signify/i) },
  { name: 'MAC TP-Link', weight: 0.4, category: 'switch', vendor: 'TP-Link', adapters: ['kasa'], test: (h) => vendorIs(h, /TP-Link/i) },
  { name: 'MAC Raspberry Pi', weight: 0.5, category: 'computer', vendor: 'Raspberry Pi', test: (h) => vendorIs(h, /Raspberry/i) },
  { name: 'MAC Samsung', weight: 0.3, category: 'display', vendor: 'Samsung', adapters: ['samsungtv'], test: (h) => vendorIs(h, /Samsung/i) },
  { name: 'MAC Xiaomi/Aqara', weight: 0.4, category: 'unknown', vendor: 'Xiaomi', adapters: ['miio'], test: (h) => vendorIs(h, /Xiaomi|Aqara|Lumi/i) },
  { name: 'MAC LIFX', weight: 0.7, category: 'light', vendor: 'LIFX', adapters: ['lifx'], test: (h) => vendorIs(h, /LIFX/i) },
  { name: 'MAC Tuya', weight: 0.5, category: 'switch', vendor: 'Tuya', adapters: ['tuya'], test: (h) => vendorIs(h, /Tuya/i) },
  { name: 'MAC ISP box', weight: 0.6, category: 'gateway', adapters: ['router'], test: (h) => vendorIs(h, /Freebox|Sagemcom|AVM|Technicolor/i) },
  { name: 'MAC Ubiquiti/Netgear', weight: 0.5, category: 'network', test: (h) => vendorIs(h, /Ubiquiti|Netgear|Aruba|Cisco|Zyxel/i) },
  { name: 'MAC printer vendor', weight: 0.55, category: 'printer', test: (h) => vendorIs(h, /Brother|Epson|Kyocera|Xerox|Canon|HP\b/i) },
  { name: 'MAC camera vendor', weight: 0.6, category: 'camera', adapters: ['onvif'], test: (h) => vendorIs(h, /Axis|Dahua|Hikvision|Reolink/i) },
  { name: 'MAC Roku', weight: 0.6, category: 'media', vendor: 'Roku', adapters: ['roku'], test: (h) => vendorIs(h, /Roku/i) },
  { name: 'MAC Shelly', weight: 0.7, category: 'switch', vendor: 'Shelly', adapters: ['shelly'], test: (h) => vendorIs(h, /Shelly|Allterco/i) },
  { name: 'MAC Netatmo/Withings/Tado', weight: 0.6, category: 'sensor', adapters: [], test: (h) => vendorIs(h, /Netatmo|Withings|Tado/i) },

  // --- hostname heuristics ---------------------------------------------------------------
  { name: 'hostname looks like a phone', weight: 0.5, category: 'phone', test: (h) => textMatch(h, /iphone|ipad|android|galaxy|pixel|oneplus|xiaomi-mi/i) },
  { name: 'hostname looks like a PC', weight: 0.5, category: 'computer', test: (h) => textMatch(h, /desktop-|laptop-|macbook|imac|-pc$|windows/i) },
  { name: 'hostname looks like a TV', weight: 0.6, category: 'display', test: (h) => textMatch(h, /\btv\b|bravia|aquos|philips-?tv|hisense|tcl/i) },
  { name: 'hostname looks like a watch', weight: 0.6, category: 'wearable', test: (h) => textMatch(h, /watch|band|fitbit|garmin/i) },
]

export function fingerprintHost(host: NetworkHost): Fingerprint {
  const categoryScores = new Map<DeviceCategory, number>()
  const vendorScores = new Map<string, number>()
  const adapterScores = new Map<string, number>()
  const evidence: string[] = []
  let product: string | null = null
  let best = 0

  for (const rule of RULES) {
    let matched = false
    try {
      matched = rule.test(host)
    } catch {
      matched = false
    }
    if (!matched) continue

    evidence.push(rule.name)
    best = Math.max(best, rule.weight)

    if (rule.category) {
      categoryScores.set(rule.category, (categoryScores.get(rule.category) ?? 0) + rule.weight)
    }
    if (rule.vendor) {
      vendorScores.set(rule.vendor, (vendorScores.get(rule.vendor) ?? 0) + rule.weight)
    }
    if (rule.product && !product) product = rule.product
    for (const adapter of rule.adapters ?? []) {
      adapterScores.set(adapter, (adapterScores.get(adapter) ?? 0) + rule.weight)
    }
  }

  const category = [...categoryScores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'
  const vendor = [...vendorScores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? host.macVendor
  const suggestedAdapters = [...adapterScores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)

  // Two independent signals agreeing is worth more than one strong signal alone.
  const agreementBonus = Math.min(0.12, Math.max(0, evidence.length - 1) * 0.04)
  const confidence = Math.min(0.99, Number((best + agreementBonus).toFixed(2)))

  return {
    category,
    vendor: vendor ?? null,
    // Optional chaining on every host field read outside the rule loop: a host row can come
    // back from the database with a null column, and only the rules themselves are wrapped
    // in a try. One undefined here would lose an otherwise complete fingerprint.
    productGuess: product ?? host.ssdp?.modelName ?? host.mdnsTxt?.md ?? null,
    confidence: evidence.length === 0 ? 0.1 : confidence,
    suggestedAdapters,
    evidence,
  }
}

/** A short label for a host that has no name anywhere: "Espressif device at .42". */
export function fallbackName(host: NetworkHost, fingerprint: Fingerprint): string {
  const lastOctet = host.ip.split('.').pop() ?? '?'
  if (host.hostname) return host.hostname
  if (host.ssdp?.friendlyName) return host.ssdp.friendlyName
  if (fingerprint.productGuess) return `${fingerprint.productGuess} (.${lastOctet})`
  if (fingerprint.vendor) return `${fingerprint.vendor} device (.${lastOctet})`
  return `Unknown device (.${lastOctet})`
}
