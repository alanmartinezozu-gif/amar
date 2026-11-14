"""SQLite schema and small helpers. One file: data/biddesk.db."""
from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

from . import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, owner_name TEXT, owner_type TEXT,
  url TEXT, method TEXT, parser TEXT, county TEXT, city TEXT, check_freq TEXT DEFAULT 'daily',
  notes TEXT, active INTEGER DEFAULT 1, last_checked TEXT, last_item_count INTEGER,
  last_status TEXT, last_error TEXT, alert TEXT);

CREATE TABLE IF NOT EXISTS opportunities(
  id INTEGER PRIMARY KEY, source_id INTEGER REFERENCES sources(id), owner_name TEXT,
  title TEXT NOT NULL, bid_number TEXT, url TEXT, county TEXT, city TEXT, posted_date TEXT,
  due_datetime TEXT, prebid_datetime TEXT, prebid_mandatory INTEGER, est_value REAL,
  status TEXT DEFAULT 'open', raw_text TEXT, dedupe_key TEXT UNIQUE,
  is_construction INTEGER, trade_tags TEXT, triage_confidence REAL,
  created_at TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS documents(
  id INTEGER PRIMARY KEY, opportunity_id INTEGER REFERENCES opportunities(id),
  filename TEXT, url_or_path TEXT, local_path TEXT, sha256 TEXT, page_count INTEGER,
  text TEXT, needs_vision INTEGER DEFAULT 0, doc_type TEXT, fetch_error TEXT,
  first_seen TEXT, last_seen TEXT);

CREATE TABLE IF NOT EXISTS analyses(
  id INTEGER PRIMARY KEY, opportunity_id INTEGER REFERENCES opportunities(id),
  client_id INTEGER REFERENCES clients(id), model TEXT, brief_json TEXT,
  checklist_json TEXT, docs_fingerprint TEXT, created_at TEXT, cost_usd REAL);

CREATE TABLE IF NOT EXISTS clients(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, tier TEXT, profile_yaml_path TEXT,
  email TEXT, active INTEGER DEFAULT 1, auto_send INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS matches(
  id INTEGER PRIMARY KEY, client_id INTEGER REFERENCES clients(id),
  opportunity_id INTEGER REFERENCES opportunities(id), score INTEGER, reason TEXT,
  decision TEXT DEFAULT 'pending', notes TEXT, updated_at TEXT,
  UNIQUE(client_id, opportunity_id));

CREATE TABLE IF NOT EXISTS addenda_alerts(
  id INTEGER PRIMARY KEY, opportunity_id INTEGER, document_id INTEGER, summary TEXT,
  sent_to_clients TEXT, created_at TEXT);

CREATE TABLE IF NOT EXISTS bid_results(
  id INTEGER PRIMARY KEY, opportunity_id INTEGER, external_ref TEXT, owner_name TEXT,
  project_name TEXT, letting_date TEXT, bidder_name TEXT, bidder_city TEXT, total_bid REAL,
  rank INTEGER, is_winner INTEGER, source_url TEXT);

CREATE TABLE IF NOT EXISTS bid_items(
  id INTEGER PRIMARY KEY, bid_result_id INTEGER REFERENCES bid_results(id), item_no TEXT,
  description TEXT, unit TEXT, quantity REAL, unit_price REAL, extended REAL);

CREATE TABLE IF NOT EXISTS companies(
  id INTEGER PRIMARY KEY, name TEXT, normalized_name TEXT UNIQUE, city TEXT, state TEXT,
  wydot_prequalified INTEGER, prequal_classes TEXT, phone TEXT, website TEXT,
  is_client INTEGER DEFAULT 0, is_prospect INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS ai_usage(
  id INTEGER PRIMARY KEY, ts TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
  cost_usd REAL, purpose TEXT, client_id INTEGER, opportunity_id INTEGER);

CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY, client_id INTEGER, kind TEXT, to_addr TEXT, subject TEXT,
  html TEXT, status TEXT DEFAULT 'pending', error TEXT, created_at TEXT, sent_at TEXT);

CREATE TABLE IF NOT EXISTS http_cache(
  url TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, sha256 TEXT, body BLOB,
  content_type TEXT, fetched_at TEXT);
"""


def now() -> str:
    return datetime.now(settings.TZ).replace(tzinfo=None).isoformat(timespec="seconds")


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    path = Path(path) if path else settings.db_path()
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def refresh_statuses(conn: sqlite3.Connection) -> None:
    """Open bids whose due time has passed become 'closed'."""
    conn.execute(
        "UPDATE opportunities SET status='closed', updated_at=? "
        "WHERE status='open' AND due_datetime IS NOT NULL AND due_datetime < ?",
        (now(), now()),
    )
    conn.commit()
