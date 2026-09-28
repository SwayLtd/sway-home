# Sway Home - the plan

An AI-first, privacy-first home assistant. Not a dashboard with a chatbot bolted on: an
assistant that reads the house, acts on it, notices things and says so, with the dashboard as
the pre-rendered answer to "how is the house doing".

Everything in this document is either built (marked **built**) or a decision already made about
what comes next. Nothing here is aspirational marketing.

---

## 1. The product in one paragraph

You plug things into your home network. Sway Home finds them without you naming anything,
works out what they are, groups them by room, and hands you one prompt. You say "il fait froid
dans la chambre" and the heating changes. It watches for the handful of things worth
interrupting a person for - a leak, smoke, a door left unlocked when the house empties, a
battery about to die - and says them out loud. It notices that you dim the living room at
22:30 every night and offers to do it for you. Everything it knows is a row you can read and
delete, the database is a file on your machine, and it works with no API key at all.

## 2. Principles, in the order they win

1. **Compatibility first.** A home assistant that supports six brands is a toy. The device
   model is capability-based and mapped onto Matter cluster ids, so every adapter written
   against it gets the whole UI for free.
2. **Privacy is a property of the architecture, not a policy page.** The MAC vendor table is
   embedded rather than looked up online. The database is SQLite on the user's disk. The agent
   runs against a local model if one is available. Nothing phones home, ever.
3. **It works with no key.** A deterministic French/English intent parser handles the common
   commands. An LLM makes it better; it is not a dependency.
4. **The assistant never acts beyond its leash.** Risk is checked inside the tool, not in the
   prompt, so no amount of model cleverness gets past it.
5. **Everything the assistant does is attributable.** Every event carries who caused it. Every
   memory is readable and deletable. Every widget it creates says why.
6. **Zero-dependency where the protocol is simple.** mDNS, SSDP, NetBIOS, MQTT, CASTV2 and the
   Kasa cipher are each a few hundred lines. Pulling a package for each of them costs more in
   supply-chain surface than it saves in effort.

## 3. Architecture

```
apps/hub      AdonisJS 6 on Bun. The house lives here: SQLite, adapters, automation,
              the agent, the event bus, the REST + SSE API on :3333.
apps/web      Nuxt 4 console on :3000. Tailwind v4 + DaisyUI. Talks to the hub over
              /api (proxied in dev) and one SSE stream.
packages/shared      The vocabulary: capabilities, devices, events, automation, agent,
                     widgets. Everything else is written against this.
packages/discovery   Network discovery with no dependencies at all.
```

**Data flow.** Adapter polls or subscribes to a device, calls `emitState`, which merges into
SQLite, writes `state_history`, and publishes `device.state_changed` on the bus. The bus fans
out to: SSE clients, the automation engine, the insight engine, the narrator. The console
patches its store in place - it never refetches on a state change.

**The single mutation path.** Every command goes through `houseService.execute()`. That is
where events are emitted, undo entries are built and risk is recorded. The agent, the REST
API, a routine and the UI all go through it; there is no second way to change a device.

## 4. What is built

### Discovery (`packages/discovery`)
- Hand-written DNS wire codec with name compression and a pointer budget, used for mDNS.
- mDNS/DNS-SD browse over ~70 service types, two passes with a meta-query.
- SSDP/UPnP M-SEARCH plus description-XML fetch.
- ARP table read per platform, TCP sweep over 38 fingerprint-bearing ports (no admin rights
  needed, unlike ICMP), NetBIOS name query, HTTP banner grab.
- ~300-entry embedded OUI table, optionally extended from an IEEE CSV on disk.
- ~60 weighted fingerprint rules producing a category, vendor, product guess, a confidence and
  the adapters that should try to claim the host.

### Device model (`packages/shared/capabilities.ts`)
40+ capabilities, each with a zod state schema, its commands, its unit and its Matter cluster
id. A device is a set of capabilities; the UI renders controls from the capability list, so a
new adapter needs no UI work.

### Adapters - implemented
Virtual house (37 simulated devices with real physics, for testing), Shelly Gen1 + Gen2, WLED,
Tasmota, Philips Hue, TP-Link Kasa, Roku, Google Cast, ESPHome, MQTT (zigbee2mqtt + Home
Assistant discovery + Tasmota topics), LIFX, Sonos, Tuya (local), ONVIF cameras, Samsung TV,
LG webOS, Freebox, KNX, Modbus (SunSpec + point maps), Home Assistant bridge, Zigbee (through
zigbee2mqtt), Z-Wave (through Z-Wave JS), Bluetooth LE sensors and beacons, Matter, HomeKit.
See `docs/protocols.md` for how each one works and what it needs.

### Adapters - declared, not yet implemented
None at the moment; the registry keeps the mechanism for the next ones.

### Automation
Event-driven triggers (device state, capability state, device event, time, cron, sun, presence,
house mode, interval, webhook, voice intent, manual), recursive conditions, an action runner
with single/restart/queued/parallel modes and a depth-3 loop guard. Sun times computed with
the NOAA algorithm rather than an API call.

### The insight engine
Hourly roll-ups so a month of charts is a hundred rows. Watchdogs for batteries, leaks, smoke,
devices that went quiet, firmware, heating with a window open, night-time standby drain. Habit
detection over the event log that produces routine suggestions - never routines.

### The agent
- Provider-agnostic, written without SDKs: OpenAI-compatible, Anthropic, Gemini, Ollama, LM
  Studio, llama.cpp. Real pricing in the catalogue.
- 34 tools. Tool results are one dense line each, because every result is re-sent on every
  subsequent turn and that single decision dominates cost.
- Four autonomy levels: observer, assistant, copilot, autopilot. Risk per command. Locks,
  cameras, sirens and anything marked critical always ask, at every level.
- A deterministic intent parser in front of the model, covering status questions, on/off,
  brightness, colours, thermostats, covers, locks, media, scenes, memory, routine suggestions
  and dashboard cards.

### The narrator (proactive)
Watches the bus and turns the few things worth interrupting for into one French sentence:
leaks, smoke, dying batteries, a device that stopped answering, a routine that failed, an empty
house with lights on, a new device on the network, the morning briefing. Deduplicated with a
per-kind repeat window, capped by an hourly budget, silent during quiet hours except for
critical safety events. The console shows each one as a card and reads it aloud.

### The dashboard
Widgets are *declarations*: a type, a data source and a few options, resolved by the hub
against the house. Because they are declarations and not code, the agent can write them: ask
for "l'humidité de la salle de bain" and a tile appears. Sixteen widget types, nine source
kinds, all resolved through one validated path. A card that would resolve to nothing is
refused with the reason rather than created dead.

### Voice
Speech-to-text and text-to-speech both run in the browser: Whisper via Transformers.js
(WebGPU, falling back to WASM) and Kokoro-82M, with the Web Speech API as a fallback. The audio
never leaves the page. Hosted options are listed with real per-hour pricing for comparison, and
none is default.

## 5. What comes next, in order

1. **Matter.** The one that matters most for compatibility. On-network commissioning first -
   BLE commissioning on Windows is a known dead end in matter.js, so pairing over the network
   or via a QR code with an already-provisioned device is the viable path.
2. **Zigbee and Z-Wave natively**, so a coordinator dongle needs no second daemon.
3. **Tests.** The discovery codecs, the capability conversions, the intent parser and the
   widget resolver are all pure functions with obvious cases; they should have been written
   already.
4. **The Rust scanner.** The TCP sweep is the one part where a native binary is a real win.
   Deferred because no toolchain is installed on this machine.
5. **Flutter mobile app** against the same REST + SSE API.
6. **Multi-user and remote access**: Supabase for identity and sync, Cloudflare R2 for camera
   snapshots and voice clips, with the hub staying authoritative and offline-capable.
7. **Cameras**: ONVIF discovery, snapshot on motion, and a local vision model for "quelqu'un
   est à la porte" rather than "motion detected in zone 3".
8. **Energy**: tariff windows (heures creuses), per-device baselines, and "you left this on"
   detection that names the cost.

## 6. Non-goals

- A cloud account required to turn on a light.
- A plugin store that runs third-party code in the hub process.
- Voice always-on by default. Wake-word listening is opt-in and off.
- Any telemetry.
