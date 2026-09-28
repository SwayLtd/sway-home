# Voice: what it costs and where the audio goes

Two questions decide this, and only one of them is about money.

## The decision

**Speech-to-text and text-to-speech both run in the browser by default.** The audio never
leaves the page, there is no per-hour bill, and it works with the network down. Hosted
providers are listed in the settings screen with their real rates so the comparison is
auditable, but none of them is the default and none is required.

For a home assistant this is not a compromise. The vocabulary is small and repetitive
("éteins le salon", "il fait combien dans la chambre"), the audio is short, and the latency of
a local Whisper on WebGPU is lower than a round trip to a hosted API anyway.

## What runs locally

| Layer | Implementation | Size | Notes |
|---|---|---|---|
| STT | Whisper via Transformers.js, ONNX | 45 Mo (tiny) to 800 Mo (large-v3-turbo) | WebGPU when available, WASM otherwise. `whisper-base` at ~145 Mo is the default: correct French, reasonable download |
| STT alternative | Moonshine base, ~90 Mo | | English only, but the lowest latency of the local options |
| TTS | Kokoro-82M via kokoro-js | ~80 Mo | Real-time on CPU. `ff_siwis` is the French voice |
| TTS fallback | Web Speech API | 0 | Uses the OS voices. On this machine: Hortense, Julie, Paul for French |

The model downloads once and is cached by the browser. The first utterance after a page load
waits for a user gesture, which is a browser rule no application can work around.

## Hosted options, for comparison

Rates checked against each vendor's own pricing page on **26 September 2026**. They move; the
date is in the code as `VOICE_PRICING_CHECKED_ON` so the settings screen cannot quietly lie.

| Provider | Speech-to-text | Text-to-speech | Where the audio goes |
|---|---|---|---|
| Local (Whisper + Kokoro) | free | free | stays in the page |
| Web Speech API | free | free | Chrome uploads the audio to Google |
| Deepgram Nova-3 | $0.0043/min batch ($0.258/h), $0.0048/min streaming | - | their servers |
| AssemblyAI Universal-3.5 Pro | $0.21/h pre-recorded, $0.45/h streaming | - | their servers |
| Cartesia Sonic | - | per character, volume discounts; ~40 ms to first audio | their servers |
| ElevenLabs Flash v2.5 | - | $0.05-$0.10/min depending on model | their servers |

Deepgram is the cheapest capable hosted STT by a clear margin. Cartesia is the fastest to first
audio. ElevenLabs has the best voices. None of that changes the default, because the question a
home assistant has to answer first is not "which is cheapest" but "who hears the inside of my
house".

Note that ElevenLabs and Cartesia now publish per-minute and per-character rates respectively
rather than the per-million-character figures that circulate in comparison articles; the table
above follows what they publish.

## Wake word

Off by default, and it should stay off by default. An always-listening microphone is a
different product with a different threat model. The setting exists (`wakeWordEnabled`), the
plumbing is there, and turning it on is a deliberate act.

## What is spoken, and when

The assistant speaks in two situations:

1. **You asked it something** and `speakReplies` is on (it is, by default).
2. **It decided something was worth interrupting you for** - see `docs/agent.md`. The hub, not
   the browser, decides whether that is allowed: quiet hours, an hourly budget, and a dedupe
   window per kind of event. A critical safety event (leak, smoke) speaks through quiet hours;
   nothing else does.

The rule lives on the hub rather than in the page on purpose: it has to hold when no tab is
open, and a rule that lives in the browser only applies while someone is already looking.
