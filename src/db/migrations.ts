/** Append-only list. Each entry runs once; `PRAGMA user_version` tracks progress. */
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE contractors (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    timezone        TEXT NOT NULL DEFAULT 'America/New_York',
    twilio_number   TEXT,
    public_key      TEXT NOT NULL UNIQUE,
    google_ads_key  TEXT NOT NULL,
    settings        TEXT NOT NULL DEFAULT '{}',
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE UNIQUE INDEX contractors_twilio_number ON contractors(twilio_number) WHERE twilio_number IS NOT NULL;

  CREATE TABLE facebook_pages (
    page_id         TEXT PRIMARY KEY,
    contractor_id   TEXT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
    page_name       TEXT,
    access_token    TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX facebook_pages_contractor ON facebook_pages(contractor_id);

  CREATE TABLE calendar_connections (
    contractor_id   TEXT PRIMARY KEY REFERENCES contractors(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL,
    account_email   TEXT,
    refresh_token   TEXT NOT NULL,
    access_token    TEXT,
    access_token_expires_at TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE leads (
    id              TEXT PRIMARY KEY,
    contractor_id   TEXT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
    source          TEXT NOT NULL,
    external_id     TEXT,
    name            TEXT,
    email           TEXT,
    phone           TEXT,
    phone_raw       TEXT,
    address         TEXT,
    zip             TEXT,
    form_answers    TEXT NOT NULL DEFAULT '{}',
    details         TEXT NOT NULL DEFAULT '{}',
    summary         TEXT,
    status          TEXT NOT NULL,
    call_attempts   INTEGER NOT NULL DEFAULT 0,
    appointment_start TEXT,
    appointment_end   TEXT,
    appointment_event_id TEXT,
    metadata        TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE UNIQUE INDEX leads_external ON leads(contractor_id, source, external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX leads_phone ON leads(contractor_id, phone, created_at);
  CREATE INDEX leads_created ON leads(created_at);
  CREATE INDEX leads_appointment ON leads(contractor_id, appointment_start) WHERE appointment_start IS NOT NULL;

  CREATE TABLE calls (
    id              TEXT PRIMARY KEY,
    lead_id         TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    contractor_id   TEXT NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
    direction       TEXT NOT NULL,
    attempt         INTEGER NOT NULL DEFAULT 1,
    reason          TEXT,
    twilio_call_sid TEXT UNIQUE,
    status          TEXT NOT NULL,
    answered_by     TEXT,
    phase           TEXT NOT NULL DEFAULT 'qualify',
    outcome         TEXT,
    transfer_index  INTEGER NOT NULL DEFAULT -1,
    transfer_accepted_by TEXT,
    conversation    TEXT NOT NULL DEFAULT '[]',
    pending_tool_results TEXT NOT NULL DEFAULT '[]',
    transcript      TEXT NOT NULL DEFAULT '[]',
    started_at      TEXT,
    answered_at     TEXT,
    ended_at        TEXT,
    duration_seconds INTEGER,
    post_processed_at TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX calls_lead ON calls(lead_id, created_at);

  CREATE TABLE jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    type            TEXT NOT NULL,
    payload         TEXT NOT NULL,
    run_at          TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    dedupe_key      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX jobs_due ON jobs(status, run_at);
  CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'pending';

  CREATE TABLE events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    contractor_id   TEXT,
    lead_id         TEXT,
    call_id         TEXT,
    type            TEXT NOT NULL,
    message         TEXT,
    data            TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX events_lead ON events(lead_id, id);
  `,
];
