# Architecture

## The shape

```
                      ┌──────────────────────────────┐
  browser  ──HTTP──▶  │  apps/web  Nuxt 4  :3000     │
           ◀─SSE───   │  (dev proxy /api → :3333)    │
                      └──────────────┬───────────────┘
                                     │ REST + SSE
                      ┌──────────────▼───────────────┐
                      │  apps/hub  AdonisJS on Bun   │
                      │  :3333                       │
                      │                              │
                      │  routes ─▶ services ─▶ repos │
                      │              │               │
                      │           event bus          │
                      │              │               │
                      │  adapters ◀──┴──▶ agent      │
                      └──────────────┬───────────────┘
                                     │
                               data/house.sqlite
```

## Why Bun, and what it cost

The user's stack. It works, with two constraints that shaped real decisions:

- **AdonisJS under Bun** needs a `bun` condition on every entry in the package's `imports`
  map, because Adonis resolves its subpath imports at runtime.
- **better-sqlite3 hard-crashes Bun on Windows.** `app/db/database.ts` therefore picks
  `bun:sqlite` or `node:sqlite` at runtime behind one small interface. Lucid was dropped with
  it: migrations are hand-written SQL and queries are hand-written SQL. For a schema this size
  that is less code than the ORM configuration would have been.

## The database

SQLite in WAL mode, one file. Six migrations:

| Migration | Tables |
|---|---|
| `0001_core` | settings, floors, areas, devices, device_endpoints, events, state_history, adapters, adapter_store, network_hosts |
| `0002_automation` | routines, routine_runs, scenes, people, undo_entries |
| `0003_agent` | conversations, agent_messages, memories, proposals, agent_runs |
| `0004_energy_and_rollups` | energy_hourly, sensor_hourly, alerts |
| `0005_voice_and_search` | voice_sessions, FTS5 device_search, FTS5 memory_search |
| `0006_dashboard` | dashboards, widgets, agent_announcements |

`state_history` is raw and short-lived: the insight engine compacts it hourly into
`energy_hourly` and `sensor_hourly` and prunes what it has folded in. A month of charts is a
few hundred rows, and the charts stay instant.

## The event bus

One class, three consumers:

1. **Listeners** - the automation engine, the insight engine, the narrator.
2. **SQLite** - a whitelist of event types is persisted; the rest stay in a 500-event ring.
3. **SSE sockets** - the console's single `/api/stream` connection.

Every event carries `origin` (user, automation, agent, device, schedule, api, system) and a
`correlationId` that ties a command, the state change it caused and the reply that mentioned it
into one thread. That is what makes the journal answer "who did this".

## The single mutation path

`houseService.execute()` is the only way a device changes:

```
execute(deviceId, command, args, { origin, correlationId })
  ├── resolve the device and the adapter
  ├── risk check (for agent origins)
  ├── adapter.execute(...) with a 45 s ceiling
  ├── merge the resulting state
  ├── publish device.command_sent / device.command_failed
  └── push an undo entry
```

The REST API, the agent's tools, the automation engine and the UI all call it. There is no
second path, so there is no way for an action to skip the event log or the undo stack.

## Realtime

Server-Sent Events rather than WebSocket. The traffic is one-directional (the hub tells the
console what changed; the console uses REST to change things), SSE reconnects by itself, and it
survives proxies that mangle upgrades. The client backs off up to 5 s and patches its store in
place - a state change never triggers a refetch.

## The console

Nuxt 4, Tailwind v4, DaisyUI v5, Phosphor icons bundled locally so the console works offline.

Layout: a 48 px app header with the breadcrumb, a collapsible rail, a recessed content panel
and a resizable right dock for quick tools (assistant, activity, scan, proposals). The
breadcrumb is published by the page and rendered once in the header, client-side only - the
page sets it during its own setup, which on the server happens after the header has been
emitted.

The widget grid uses **container queries**, not viewport ones, because the dock takes up to
640 px and a grid that asks the window how wide it is lays four columns into a 400 px strip.

## Conventions worth knowing before editing

- `packages/shared` is the vocabulary. If a concept exists in the hub and the console, it is
  defined there once.
- Adapters never write to the database. They call `context.emitState` / `emitEvent`, and the
  adapter manager owns persistence.
- A tool's return value is re-sent on every model turn. Keep it to one line per item.
- Anything the assistant creates carries who created it and why.
- No em dashes anywhere, including in code comments.

## Running it

```bash
bun install
bun run db:migrate
bun run dev          # hub on :3333 and console on :3000
bun run scan         # one-off network scan from the CLI
bun run doctor       # environment check
```

`DB_PATH` overrides the database location; it defaults to `data/house.sqlite` at the repo root.
