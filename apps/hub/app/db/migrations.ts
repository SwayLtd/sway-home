/**
 * Migrations.
 *
 * Plain SQL in an ordered list, applied once each and recorded in `_migrations`. No ORM
 * migration runner, because the schema is the interesting part and hiding it behind a
 * builder makes it harder to read, not easier to write.
 *
 * Rules: append, never edit. A migration that has run on any machine is frozen.
 */

export interface Migration {
  id: string
  up: string
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_core',
    up: `
      CREATE TABLE settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE floors (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        level       INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE areas (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'other',
        floor_id    TEXT REFERENCES floors(id) ON DELETE SET NULL,
        icon        TEXT,
        polygon     TEXT,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_areas_floor ON areas(floor_id);

      CREATE TABLE devices (
        id            TEXT PRIMARY KEY,
        uid           TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        aliases       TEXT NOT NULL DEFAULT '[]',
        category      TEXT NOT NULL DEFAULT 'unknown',
        capabilities  TEXT NOT NULL DEFAULT '[]',
        manufacturer  TEXT,
        model         TEXT,
        firmware_version TEXT,
        serial_number TEXT,
        adapter_id    TEXT NOT NULL,
        native_id     TEXT NOT NULL,
        transport     TEXT NOT NULL DEFAULT 'unknown',
        area_id       TEXT REFERENCES areas(id) ON DELETE SET NULL,
        linked_device_ids TEXT NOT NULL DEFAULT '[]',
        online        INTEGER NOT NULL DEFAULT 0,
        reachable_via TEXT NOT NULL DEFAULT 'lan',
        last_seen_at  TEXT,
        state         TEXT NOT NULL DEFAULT '{}',
        identification_confidence TEXT NOT NULL DEFAULT 'guess',
        notes         TEXT,
        favourite     INTEGER NOT NULL DEFAULT 0,
        hidden        INTEGER NOT NULL DEFAULT 0,
        critical      INTEGER NOT NULL DEFAULT 0,
        network       TEXT NOT NULL DEFAULT '{}',
        meta          TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_devices_adapter ON devices(adapter_id);
      CREATE INDEX idx_devices_area ON devices(area_id);
      CREATE INDEX idx_devices_category ON devices(category);
      CREATE UNIQUE INDEX idx_devices_native ON devices(adapter_id, native_id);

      CREATE TABLE device_endpoints (
        id            TEXT PRIMARY KEY,
        device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        idx           INTEGER NOT NULL,
        name          TEXT NOT NULL,
        category      TEXT NOT NULL DEFAULT 'unknown',
        capabilities  TEXT NOT NULL DEFAULT '[]',
        state         TEXT NOT NULL DEFAULT '{}',
        area_id       TEXT REFERENCES areas(id) ON DELETE SET NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_endpoints_device_idx ON device_endpoints(device_id, idx);

      CREATE TABLE events (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL,
        at            TEXT NOT NULL,
        subject_type  TEXT NOT NULL DEFAULT 'system',
        subject_id    TEXT,
        origin        TEXT NOT NULL DEFAULT 'system',
        origin_detail TEXT,
        payload       TEXT NOT NULL DEFAULT '{}',
        correlation_id TEXT,
        severity      TEXT NOT NULL DEFAULT 'info'
      );
      CREATE INDEX idx_events_at ON events(at DESC);
      CREATE INDEX idx_events_type_at ON events(type, at DESC);
      CREATE INDEX idx_events_subject ON events(subject_type, subject_id, at DESC);
      CREATE INDEX idx_events_correlation ON events(correlation_id);

      CREATE TABLE state_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id   TEXT NOT NULL,
        endpoint_id TEXT,
        attribute   TEXT NOT NULL,
        value_num   REAL,
        value_text  TEXT,
        at          TEXT NOT NULL
      );
      CREATE INDEX idx_history_device_attr_at ON state_history(device_id, attribute, at DESC);
      CREATE INDEX idx_history_at ON state_history(at);

      CREATE TABLE adapters (
        id          TEXT PRIMARY KEY,
        enabled     INTEGER NOT NULL DEFAULT 1,
        config      TEXT NOT NULL DEFAULT '{}',
        status      TEXT NOT NULL DEFAULT '{}',
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE adapter_store (
        adapter_id  TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (adapter_id, key)
      );

      CREATE TABLE network_hosts (
        ip            TEXT PRIMARY KEY,
        mac           TEXT,
        mac_vendor    TEXT,
        hostname      TEXT,
        open_ports    TEXT NOT NULL DEFAULT '[]',
        mdns_services TEXT NOT NULL DEFAULT '[]',
        mdns_txt      TEXT NOT NULL DEFAULT '{}',
        ssdp          TEXT,
        http_banner   TEXT,
        http_title    TEXT,
        rtt_ms        REAL,
        sources       TEXT NOT NULL DEFAULT '[]',
        fingerprint   TEXT NOT NULL DEFAULT '{}',
        device_id     TEXT REFERENCES devices(id) ON DELETE SET NULL,
        ignored       INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL
      );
      CREATE INDEX idx_hosts_mac ON network_hosts(mac);
    `,
  },

  {
    id: '0002_automation',
    up: `
      CREATE TABLE routines (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT,
        enabled       INTEGER NOT NULL DEFAULT 1,
        mode          TEXT NOT NULL DEFAULT 'single',
        triggers      TEXT NOT NULL DEFAULT '[]',
        conditions    TEXT NOT NULL DEFAULT '[]',
        actions       TEXT NOT NULL DEFAULT '[]',
        authored_by   TEXT NOT NULL DEFAULT 'user',
        status        TEXT NOT NULL DEFAULT 'active',
        suggestion_reason TEXT,
        area_id       TEXT REFERENCES areas(id) ON DELETE SET NULL,
        last_triggered_at TEXT,
        run_count     INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_routines_status ON routines(status, enabled);

      CREATE TABLE routine_runs (
        id          TEXT PRIMARY KEY,
        routine_id  TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        status      TEXT NOT NULL DEFAULT 'running',
        trigger     TEXT NOT NULL DEFAULT '{}',
        steps       TEXT NOT NULL DEFAULT '[]',
        error       TEXT
      );
      CREATE INDEX idx_runs_routine ON routine_runs(routine_id, started_at DESC);

      CREATE TABLE scenes (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        icon        TEXT,
        area_id     TEXT REFERENCES areas(id) ON DELETE SET NULL,
        entries     TEXT NOT NULL DEFAULT '[]',
        authored_by TEXT NOT NULL DEFAULT 'user',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE people (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        avatar        TEXT,
        home          INTEGER NOT NULL DEFAULT 0,
        presence_source TEXT NOT NULL DEFAULT 'network',
        tracker_device_ids TEXT NOT NULL DEFAULT '[]',
        last_seen_at  TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE undo_entries (
        id          TEXT PRIMARY KEY,
        at          TEXT NOT NULL,
        description TEXT NOT NULL,
        origin      TEXT NOT NULL DEFAULT 'agent',
        commands    TEXT NOT NULL DEFAULT '[]',
        applied     INTEGER NOT NULL DEFAULT 0,
        expires_at  TEXT NOT NULL
      );
      CREATE INDEX idx_undo_at ON undo_entries(at DESC);
    `,
  },

  {
    id: '0003_agent',
    up: `
      CREATE TABLE conversations (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL DEFAULT 'New conversation',
        pinned      INTEGER NOT NULL DEFAULT 0,
        archived    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

      CREATE TABLE agent_messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL DEFAULT '',
        attachments     TEXT NOT NULL DEFAULT '[]',
        tool_calls      TEXT NOT NULL DEFAULT '[]',
        tool_call_id    TEXT,
        usage           TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_messages_conversation ON agent_messages(conversation_id, created_at);

      CREATE TABLE memories (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        content       TEXT NOT NULL,
        subject_type  TEXT NOT NULL DEFAULT 'house',
        subject_id    TEXT,
        confidence    REAL NOT NULL DEFAULT 0.7,
        strength      REAL NOT NULL DEFAULT 0.5,
        source        TEXT NOT NULL DEFAULT 'observed',
        evidence_count INTEGER NOT NULL DEFAULT 1,
        last_used_at  TEXT,
        expires_at    TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_memories_kind ON memories(kind, strength DESC);
      CREATE INDEX idx_memories_subject ON memories(subject_type, subject_id);

      CREATE TABLE proposals (
        id          TEXT PRIMARY KEY,
        summary     TEXT NOT NULL,
        reason      TEXT NOT NULL DEFAULT '',
        risk        TEXT NOT NULL DEFAULT 'medium',
        commands    TEXT NOT NULL DEFAULT '[]',
        routine     TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        decided_at  TEXT
      );
      CREATE INDEX idx_proposals_status ON proposals(status, created_at DESC);

      CREATE TABLE agent_runs (
        id            TEXT PRIMARY KEY,
        conversation_id TEXT,
        goal          TEXT NOT NULL DEFAULT '',
        trigger       TEXT NOT NULL DEFAULT 'chat',
        steps         INTEGER NOT NULL DEFAULT 0,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd      REAL NOT NULL DEFAULT 0,
        latency_ms    INTEGER NOT NULL DEFAULT 0,
        provider      TEXT,
        model         TEXT,
        status        TEXT NOT NULL DEFAULT 'ok',
        error         TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_agent_runs_created ON agent_runs(created_at DESC);
    `,
  },

  {
    id: '0004_energy_and_rollups',
    up: `
      CREATE TABLE energy_hourly (
        device_id   TEXT NOT NULL,
        hour        TEXT NOT NULL,
        kwh         REAL NOT NULL DEFAULT 0,
        avg_power   REAL NOT NULL DEFAULT 0,
        max_power   REAL NOT NULL DEFAULT 0,
        cost        REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (device_id, hour)
      );
      CREATE INDEX idx_energy_hour ON energy_hourly(hour);

      CREATE TABLE sensor_hourly (
        device_id   TEXT NOT NULL,
        attribute   TEXT NOT NULL,
        hour        TEXT NOT NULL,
        min_value   REAL,
        max_value   REAL,
        avg_value   REAL,
        samples     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (device_id, attribute, hour)
      );
      CREATE INDEX idx_sensor_hour ON sensor_hourly(hour);

      CREATE TABLE alerts (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        severity    TEXT NOT NULL DEFAULT 'warning',
        title       TEXT NOT NULL,
        detail      TEXT,
        subject_type TEXT NOT NULL DEFAULT 'device',
        subject_id  TEXT,
        raised_at   TEXT NOT NULL,
        cleared_at  TEXT,
        acknowledged_at TEXT
      );
      CREATE INDEX idx_alerts_open ON alerts(cleared_at, raised_at DESC);
    `,
  },

  {
    id: '0005_voice_and_search',
    up: `
      CREATE TABLE voice_sessions (
        id            TEXT PRIMARY KEY,
        started_at    TEXT NOT NULL,
        ended_at      TEXT,
        wake_word     TEXT,
        transcript    TEXT,
        reply         TEXT,
        stt_provider  TEXT,
        tts_provider  TEXT,
        stt_ms        INTEGER,
        llm_ms        INTEGER,
        tts_ms        INTEGER,
        audio_path    TEXT,
        conversation_id TEXT
      );
      CREATE INDEX idx_voice_started ON voice_sessions(started_at DESC);

      CREATE VIRTUAL TABLE device_search USING fts5(
        device_id UNINDEXED,
        name,
        aliases,
        manufacturer,
        model,
        area,
        notes,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE VIRTUAL TABLE memory_search USING fts5(
        memory_id UNINDEXED,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `,
  },

  {
    // Widgets are declarations, not code: a type, a data source and a few options, resolved
    // against the house by the hub. That is what lets the assistant create one on request
    // without ever being able to run anything on this machine.
    id: '0006_dashboard',
    up: `
      CREATE TABLE dashboards (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        icon        TEXT,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE widgets (
        id            TEXT PRIMARY KEY,
        dashboard_id  TEXT NOT NULL DEFAULT 'home',
        type          TEXT NOT NULL,
        title         TEXT NOT NULL,
        subtitle      TEXT,
        icon          TEXT,
        size          TEXT NOT NULL DEFAULT 'sm',
        position      INTEGER NOT NULL DEFAULT 0,
        source        TEXT NOT NULL DEFAULT '{"kind":"house"}',
        options       TEXT NOT NULL DEFAULT '{}',
        authored_by   TEXT NOT NULL DEFAULT 'user',
        reason        TEXT,
        visible       INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_widgets_dashboard ON widgets(dashboard_id, position);

      -- What the assistant said on its own initiative, so the same alert is not announced
      -- twice and so "why did it tell me that" has an answer.
      CREATE TABLE agent_announcements (
        id           TEXT PRIMARY KEY,
        at           TEXT NOT NULL,
        kind         TEXT NOT NULL,
        subject_id   TEXT,
        text         TEXT NOT NULL,
        severity     TEXT NOT NULL DEFAULT 'info',
        spoken       INTEGER NOT NULL DEFAULT 0,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        dedupe_key   TEXT,
        payload      TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_announce_at ON agent_announcements(at DESC);
      CREATE UNIQUE INDEX idx_announce_dedupe ON agent_announcements(dedupe_key) WHERE dedupe_key IS NOT NULL;
    `,
  },
]

export const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id          TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL
  );
`
