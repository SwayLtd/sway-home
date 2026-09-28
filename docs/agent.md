# The assistant

A house assistant has to do three things: answer, act, and speak first. The third one is what
makes it feel like Jarvis rather than a search box, and it is also the one that turns into a
nuisance fastest if it is done without rules.

## It works with no API key

In front of every model call sits a deterministic French/English intent parser. It covers the
things people actually say:

- status: "comment va la maison", "il fait combien dans la chambre", "qui est là", "qu'est-ce
  qui consomme"
- commands: on/off, brightness as a percentage or relatively ("un peu plus fort"), named
  colours, thermostat set points, covers, locks, media, volume, scenes
- house mode: "je pars", "bonne nuit", "je suis rentré"
- memory: "retiens que ..."
- the dashboard: "mets l'humidité de la chambre sur le tableau de bord"

When the parser matches, no model is called at all: the tool runs directly and the answer is
phrased by the intent. That is not just a cost saving - it is what keeps the product usable on
a machine with no internet, and it makes the common path faster than any hosted model.

The model is what handles everything else: open questions, multi-step reasoning, writing a
routine from a description, explaining why something happened.

## Providers

Written without any vendor SDK: OpenAI-compatible, Anthropic, Gemini, plus Ollama, LM Studio
and llama.cpp discovered by probing their local ports. A local model is the right default for
this product once one is pulled; hosted models are there because most people do not have one.

The catalogue carries real per-million-token pricing, and the settings screen projects a
monthly cost from it. A daily budget in USD is enforced in the run loop, not suggested.

## Tools

34 of them, in four groups:

- **Read**: list devices, get one device, house snapshot, history, energy, timeline, routines,
  scenes, alerts, who is home, the network view, recall a memory, dashboard vocabulary, list
  widgets.
- **Act**: control a device, control many, activate a scene, save a scene, set the house mode,
  create a routine, run a routine, enable or pause a routine, assign a room, scan the network,
  undo the last action.
- **Remember**: remember, forget.
- **Speak and show**: notify, speak on a speaker, announce (proactive), create, update and
  remove dashboard widgets.

Two design rules run through all of them.

**The summary is the product.** Every tool returns one dense line per item, not a JSON dump.
Tool results are re-sent to the model on every subsequent turn, so this single decision
dominates both cost and latency - more than the choice of model does.

**Risk is checked inside the tool.** `control_device` asks the permission layer before acting
and returns a proposal instead of acting when the autonomy level is too low. The check is not
in the prompt, so no amount of model cleverness routes around it.

## Autonomy

| Level | What it may do |
|---|---|
| `observer` | Read only. It gets read-only tools and nothing else. |
| `assistant` | Acts when asked. Anything unprompted becomes a proposal. |
| `copilot` | Acts on low and medium risk on its own; proposes the rest. |
| `autopilot` | Acts on its own up to the risk ceiling, still bounded by the hourly budget. |

Locks, cameras, sirens, garage doors and anything the user marked critical always require a
confirmation, at every level including autopilot. That is a property of the command risk table,
not of the level.

Every action carries its origin into the event log, so "why is the hall light on" always has an
answer, and agent actions land in the undo stack with a toast.

## Memory

One fact per row, in plain language, with a kind (preference, fact, habit, person, place,
correction, schedule), a source (stated, observed, inferred, imported), a confidence and a
strength. Identical facts are reinforced rather than duplicated, because twenty copies of
"John aime le salon à 21 degrés" would dominate the prompt and add nothing.

The `/memory` page lists every row with a delete button. A memory the user cannot see is a
memory they cannot correct.

## Speaking first

The narrator watches the event bus and turns a short list of things into one French sentence:

| Event | What it says |
|---|---|
| Leak | "Fuite d'eau détectée par X dans la cuisine. Coupez l'arrivée d'eau." |
| Smoke | "Fumée détectée par X dans la cuisine." |
| Battery critical / low | "La pile de X est presque vide." |
| Device silent for an hour | "X ne répond plus depuis une heure." |
| Heating with a window open | "Le chauffage tourne dans le salon alors qu'une fenêtre est ouverte." |
| Someone arrives | "John est rentré. Au fait, 2 choses demandent votre attention." |
| House empties with lights on | "La maison est vide et 3 lumières sont restées allumées. Je m'en occupe ?" |
| A routine was suggested | "J'ai une idée de routine: ..." |
| A routine failed | "La routine X a échoué: ..." |
| New device on the network | "Nouvel appareil sur le réseau: X. Voulez-vous que je le range ?" |
| Morning briefing | temperature, batteries, what is still on |

Three rules, and they are the whole difference between an assistant and a nuisance:

1. **Silence is the default.** Only listed kinds produce a sentence. A light turning on is not
   news.
2. **Never twice.** Every announcement has a dedupe key and a repeat window - a low battery is
   mentioned once a day, a leak every fifteen minutes while it is still wet.
3. **Quiet hours win.** Between the configured hours nothing is spoken aloud. Critical safety
   events still appear on screen and still speak, because a leak at 3 am is the case the thing
   exists for.

An hourly budget (`maxUnpromptedActionsPerHour`, default 6) caps everything except urgent
safety events.

Announcements are stored, so one made while no browser was open is still shown when a tab
opens. They appear as cards at the top of the dashboard, under the prompt, with a "vu" button.

## Widgets the assistant writes

A widget is a declaration - a type, a source and a few options - never code. That boundary is
the security model: a model that can emit code into a dashboard has remote execution on the
machine that also holds the door locks. A model that can emit
`{ type: "metric", source: { kind: "capability", capability: "humidity" } }` can only ever
produce a wrong tile, and a wrong tile is one click to delete.

Every declaration is validated against the same zod schema on all three paths - the seed, the
REST API, and the tool call - and resolved against the real house before it is saved. A card
that would show nothing is refused with the reason instead of landing dead on the dashboard.

Asking works with no model too: the intent parser recognises "mets X sur le tableau de bord"
for temperature, humidity, power, air quality, luminosity and battery, per room.
