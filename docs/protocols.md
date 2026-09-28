# Protocols and compatibility

What Sway Home speaks today, what it will speak, and how each one was implemented. The short
version: where a protocol is simple enough to write by hand, it was written by hand. That is
not purity - it is that a home hub with forty npm dependencies has forty ways to be
compromised, and most of these protocols are a few hundred lines.

## Discovery

Eight phases, run in order, each feeding the next. Every one is dependency-free.

| Phase | What it does | Why it is there |
|---|---|---|
| ARP table | Reads the OS neighbour table (`arp -a`, `ip neigh`, `arp -an`) | Instant, free, gives MAC addresses the sweep cannot |
| mDNS / DNS-SD | Browses ~70 service types over UDP 5353 | The richest source: name, model, protocol, often the exact product |
| SSDP / UPnP | M-SEARCH on UDP 1900, then fetches the description XML | Finds TVs, media renderers, routers, printers |
| TCP sweep | Connects to 38 fingerprint-bearing ports | Works without admin rights, unlike ICMP ping |
| Deep scan | A wider port set on hosts that answered | Only for hosts already known to exist |
| NetBIOS | UDP 137 name query | Names Windows machines that answer nothing else |
| HTTP banners | Fetches `/`, `/shelly`, `/json`, `/cm?cmnd=Status 0` | Turns "something on port 80" into "a Shelly Plus 1PM" |
| Fingerprint | ~60 weighted rules over everything above | Produces category, vendor, product guess, confidence, candidate adapters |

The DNS wire format is implemented from scratch (`dns-wire.ts`), including name compression
pointers with a 128-jump budget so a malformed packet cannot loop the parser.

**No online MAC lookup.** The OUI table is ~300 curated entries embedded in the source, and an
IEEE CSV can be dropped at `data/oui.csv` to extend it. Sending the MAC addresses of everything
in someone's home to an API is exactly the thing this product exists to avoid.

## Implemented adapters

| Adapter | Transport | How | Covers |
|---|---|---|---|
| `virtual` | in-process | 37 simulated devices with physics | Development and testing without hardware |
| `shelly` | HTTP | Gen1 flat REST + Gen2 JSON-RPC, identified by `/shelly` | Every Shelly relay, dimmer, roller, plug, sensor |
| `wled` | HTTP | Single `/json` endpoint | Any WLED LED controller, effects included |
| `tasmota` | HTTP | `/cm?cmnd=Status 0` | Sonoff, Athom, Nous, Gosund and anything reflashed |
| `hue` | HTTP | v1 API over plain HTTP, link-button pairing | Hue bridge: lights, ZLL/ZHA sensors |
| `kasa` | TCP 9999 | Hand-written XOR autokey cipher, key 171 | TP-Link Kasa plugs, bulbs, strips, with emeter |
| `roku` | HTTP 8060 | ECP, XML parsing | Every Roku TV and stick |
| `googlecast` | TLS 8009 | Hand-written CASTV2 protobuf codec | Chromecast, Google TV, Nest speakers, Sony BRAVIA |
| `esphome` | HTTP + SSE | web_server REST plus the `/events` stream | Any ESPHome device with web_server enabled |
| `mqtt` | TCP 1883 | Hand-written MQTT 3.1.1 client | zigbee2mqtt, Home Assistant discovery, Tasmota topics |
| `lifx` | UDP 56700 | LAN protocol, broadcast discovery plus an OUI probe, acked and retried | Every LIFX bulb and strip |
| `sonos` | UPnP, HTTP 1400 | SOAP, zone topology so transport goes to the group coordinator | Every Sonos player and group |
| `tuya` | TCP 6668, UDP 6666/6667/7000 | Protocols 3.3, 3.4 and 3.5, session key agreement, one kept-open connection per device | Tuya plugs, switches, bulbs, curtains, with each device's local key |
| `onvif` | HTTP (SOAP), WS-Discovery | Profile S, WS-Security on the camera's clock, PullPoint events | ONVIF cameras: snapshots, motion and AI events, doorbell, PTZ |
| `samsungtv` | WebSocket 8002/8001 | Remote channel, TLS first and pinned, token pairing on screen, Wake-on-LAN | Samsung Tizen TVs, 2016 and later |
| `webos` | WebSocket 3001/3000 | SSAP with subscriptions, TLS first and pinned, key pairing on screen, Wake-on-LAN | LG webOS TVs |
| `freebox` | HTTPS | App token validated on the box's screen, HMAC-SHA1 sessions, Free's own CAs | Presence from the hosts list, internet up and down |
| `knx` | UDP 3671 | KNXnet/IP tunnelling, acknowledged and confirmed telegrams, group map from ETS | KNX installations, through an IP interface or router |
| `modbus` | TCP 502 | Hand-written Modbus TCP, SunSpec model chain, point maps for the rest | Solar inverters and meters by themselves, heat pumps and relay boards by map |
| `homeassistant` | WebSocket | Auth, registries, `state_changed` events, service calls, full resync after a drop | Every entity of an existing Home Assistant, grouped back into devices |
| `zigbee` | MQTT | Dedicated zigbee2mqtt client: exposes, availability, `permit_join` pairing | Every device zigbee2mqtt supports, on a coordinator stick |
| `zwave` | WebSocket | zwave-js-server client, S2 inclusion with the PIN on the label | Every Z-Wave device, on a controller stick |
| `ble` | Bluetooth LE | WinRT advertisement watcher on the hub, or Theengs / OpenMQTTGateway on MQTT | BTHome, Xiaomi, Govee and other broadcasting sensors; beacons for presence |
| `matter` | UDP 5540 (IPv6) | matter.js controller in the hub's own fabric, on-network commissioning | Matter devices on Wi-Fi, Ethernet and Thread, bridges included |
| `homekit` | TCP (HAP over HTTP) | Hand-written HAP controller: SRP pairing, ChaCha20-Poly1305 sessions, events | HomeKit accessories over IP, and bridges (Homebridge, Hue, Aqara...) |

A few of these are worth calling out.

**Google Cast** is a protobuf-framed protocol over TLS with a self-signed device certificate,
so `rejectUnauthorized: false` is a protocol requirement rather than a shortcut - the
connection is to a local IP and the certificate is the device's own. The codec is written by
hand (varints, length-delimited fields) because the alternative is a protobuf runtime for five
message types. Two behaviours cost real debugging and are documented in the adapter: a LAUNCH
reply can take longer than five seconds, so the timeout is 15 s with a polling loop on the
transport id; and the receiver broadcasts MEDIA_STATUS frames with no request id, so the media
session id is cached from any frame that carries one.

**MQTT** is ~200 lines: CONNECT/CONNACK, SUBSCRIBE, PUBLISH, PUBACK, PINGREQ, DISCONNECT, with
the varint length encoding. It then speaks three dialects on top - zigbee2mqtt, Home Assistant
discovery, Tasmota - which is where the real compatibility comes from: anything already bridged
to MQTT is supported without a new adapter.

**Matter** is the one protocol not written by hand. Commissioning means certificates, a fabric,
CASE and PASE sessions and a cluster model of hundreds of attributes; matter.js (the
implementation the Matter test harnesses themselves use) does that, loaded only once a device
has been paired, with the fabric kept in a SQLite file next to the house's database.
**Bluetooth commissioning on Windows is a known dead end in matter.js**, so devices are
commissioned on the network: already on Wi-Fi or Thread, their pairing window opened from the
app they are in, or reset into pairing mode. Thread devices need a border router (a HomePod, a
Nest Hub, a recent ISP box).

**HomeKit** is written by hand: SRP-6a over the 3072-bit group for pairing, Ed25519 and X25519
for the long-term and session keys, HKDF-SHA512, and ChaCha20-Poly1305 implemented in the
adapter because Bun's `node:crypto` does not provide it. It is tested against HAP-NodeJS, the
accessory side Homebridge is built on, run as a real bridge. Only HomeKit over IP is covered:
Bluetooth and Thread accessories are out of reach, and so is camera video.

## Declared, not yet implemented

None at the moment. The registry keeps the mechanism (`DECLARED` in `registry.ts`): a
protocol added there appears on the integrations page greyed out, with what it unlocks and
what hardware it needs, until its adapter is written.

What the adapters above need, beyond the hub itself:

| Adapter | Needs |
|---|---|
| `zigbee` | A coordinator (Sonoff ZBDongle-E, SkyConnect, ConBee III) driven by zigbee2mqtt |
| `zwave` | A controller stick (Aeotec Z-Stick, Zooz ZST39) driven by Z-Wave JS UI or zwave-js-server |
| `matter` | Nothing for Wi-Fi devices; a Thread border router for Thread devices |
| `knx` | A KNX IP interface or router |
| `freebox` | A Freebox (Server or Pop) in router mode |
| `ble` | A Bluetooth adapter on the hub, or a Theengs / OpenMQTTGateway on MQTT |

## The capability layer

Every device is a set of capabilities rather than a type. A capability carries its state
schema, its commands, its unit and its Matter cluster id:

```ts
brightness: {
  kind: 'actuator',
  state: z.object({ brightness: z.number().min(0).max(100) }),
  commands: { setBrightness: ..., dim: ..., brighten: ... },
  unit: '%',
  matterCluster: 0x0008,
}
```

This is what makes breadth cheap. A new adapter declares `['onoff', 'brightness',
'colorTemperature']` and immediately gets: the right controls in the UI, the right tools for
the agent, the right triggers in the automation engine, and the right entry in a scene. No UI
work, no agent work.

Mapping onto Matter cluster ids from the start also means the Matter adapter, when it lands,
maps cluster to capability rather than inventing a third vocabulary.
