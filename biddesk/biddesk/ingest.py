"""Run sources, store opportunities, download documents, extract text, hash for changes."""
from __future__ import annotations

import hashlib
import importlib
import io
import re
import sqlite3
from pathlib import Path

import yaml

from . import db, settings
from .http import Blocked, Fetcher
from .models import DocLink, Opportunity, ScrapeResult, guess_doc_type

# Under this many characters per page we treat a PDF as a scan and fall back to page images.
SCAN_CHARS_PER_PAGE = 80


# --- sources -----------------------------------------------------------------
def sync_sources(conn: sqlite3.Connection, path: Path | None = None) -> None:
    """Copy config/sources.yaml into the sources table (the YAML is the source of truth)."""
    data = yaml.safe_load((path or settings.SOURCES_PATH).read_text()) or {}
    for s in data.get("sources", []):
        conn.execute(
            "INSERT INTO sources(name,owner_name,owner_type,url,method,parser,county,city,check_freq,notes,active)"
            " VALUES(:name,:owner_name,:owner_type,:url,:method,:parser,:county,:city,:check,:notes,:active)"
            " ON CONFLICT(name) DO UPDATE SET owner_name=excluded.owner_name, owner_type=excluded.owner_type,"
            " url=excluded.url, method=excluded.method, parser=excluded.parser, county=excluded.county,"
            " city=excluded.city, check_freq=excluded.check_freq, notes=excluded.notes, active=excluded.active",
            {"name": s["name"], "owner_name": s.get("owner_name", ""), "owner_type": s.get("owner_type", ""),
             "url": s.get("url", ""), "method": s.get("method", "manual"), "parser": s.get("parser"),
             "county": s.get("county", ""), "city": s.get("city", ""), "check": s.get("check", "daily"),
             "notes": s.get("notes", ""), "active": 1 if s.get("active", True) else 0})
    conn.commit()


def manual_source_id(conn: sqlite3.Connection) -> int:
    conn.execute("INSERT OR IGNORE INTO sources(name,owner_type,method,active) VALUES('Manual upload','manual','manual',1)")
    conn.commit()
    return conn.execute("SELECT id FROM sources WHERE name='Manual upload'").fetchone()["id"]


def run_source(conn: sqlite3.Connection, fetcher: Fetcher, source: sqlite3.Row) -> ScrapeResult | None:
    """Scrape one source and record its health. A parser that used to find bids and now
    finds none (without the page saying 'nothing posted') raises a dashboard alert."""
    status, error, alert, result = "ok", None, None, None
    try:
        module = importlib.import_module(f"biddesk.sources.{source['parser']}")
        result = module.scrape(fetcher, source)
        count = len(result.items)
        if not result.layout_ok:
            status = "layout_changed"
            alert = "The page layout was not recognised. The site probably changed; the parser needs a look."
        elif count == 0 and (source["last_item_count"] or 0) > 0 and not result.explicit_empty:
            status = "suspicious_zero"
            alert = f"Found 0 items; last run found {source['last_item_count']}. Check the page by hand."
        for opp in result.items:
            if opp.raw_text or opp.documents:  # stubs for already-known items carry neither
                upsert_opportunity(conn, source, opp)
    except Blocked as e:
        status, error, count = "blocked", str(e), None
        alert = "The site refused the request or robots.txt disallows it. Not retried."
    except Exception as e:  # one broken source must not stop the daily run
        status, error, count = "error", f"{type(e).__name__}: {e}", None
        alert = "Scrape failed. See the error."
    conn.execute(
        "UPDATE sources SET last_checked=?, last_item_count=COALESCE(?, last_item_count),"
        " last_status=?, last_error=?, alert=? WHERE id=?",
        (db.now(), count, status, error, alert, source["id"]))
    conn.commit()
    return result


# --- opportunities -----------------------------------------------------------
def _dedupe_key(source_id: int, opp: Opportunity) -> str:
    basis = f"{source_id}|{opp.url}|{re.sub(r'[^a-z0-9]+', ' ', opp.title.lower()).strip()}|{opp.posted_date or ''}"
    return hashlib.sha256(basis.encode()).hexdigest()[:32]


def upsert_opportunity(conn: sqlite3.Connection, source, opp: Opportunity) -> int:
    key = _dedupe_key(source["id"], opp)
    now = db.now()
    status = "closed" if opp.due_datetime and opp.due_datetime < now else "open"
    row = conn.execute("SELECT id, raw_text, due_datetime FROM opportunities WHERE dedupe_key=?", (key,)).fetchone()
    if row:
        oid = row["id"]
        if row["raw_text"] != opp.raw_text or row["due_datetime"] != opp.due_datetime:
            conn.execute(
                "UPDATE opportunities SET raw_text=?, due_datetime=?, prebid_datetime=?, prebid_mandatory=?,"
                " status=CASE WHEN status IN ('awarded','cancelled') THEN status ELSE ? END, updated_at=? WHERE id=?",
                (opp.raw_text, opp.due_datetime, opp.prebid_datetime, _b(opp.prebid_mandatory), status, now, oid))
    else:
        cur = conn.execute(
            "INSERT INTO opportunities(source_id,owner_name,title,bid_number,url,county,city,posted_date,"
            "due_datetime,prebid_datetime,prebid_mandatory,est_value,status,raw_text,dedupe_key,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (source["id"], opp.owner_name or source["owner_name"], opp.title, opp.bid_number, opp.url,
             opp.county or source["county"], opp.city or source["city"], opp.posted_date, opp.due_datetime,
             opp.prebid_datetime, _b(opp.prebid_mandatory), opp.est_value, status, opp.raw_text, key, now, now))
        oid = cur.lastrowid
    for d in opp.documents:
        stable = d.url.split("?")[0]  # signed URLs change every page load; the path does not
        seen = conn.execute(
            "SELECT id FROM documents WHERE opportunity_id=? AND url_or_path=?", (oid, stable)).fetchone()
        if seen:
            conn.execute("UPDATE documents SET last_seen=? WHERE id=?", (now, seen["id"]))
        else:
            conn.execute(
                "INSERT INTO documents(opportunity_id,filename,url_or_path,doc_type,first_seen,last_seen,fetch_error)"
                " VALUES(?,?,?,?,?,?,?)", (oid, d.filename, stable, d.doc_type, now, now, "pending|" + d.url))
    conn.commit()
    return oid


def _b(v):
    return None if v is None else int(bool(v))


# --- documents ---------------------------------------------------------------
def extract_pdf(data: bytes) -> tuple[str, int, bool]:
    """Return (text with [[PAGE n]] markers, page count, needs_vision)."""
    import pdfplumber
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    pages = []
    for i, page in enumerate(reader.pages, 1):
        try:
            pages.append((i, page.extract_text() or ""))
        except Exception:
            pages.append((i, ""))
    # Tables (bid schedules) come out better through pdfplumber; append them per page.
    tables: dict[int, str] = {}
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for i, p in enumerate(pdf.pages[:150], 1):
                rows = []
                for t in p.extract_tables() or []:
                    rows += [" | ".join((c or "").replace("\n", " ") for c in r) for r in t]
                if rows:
                    tables[i] = "\n".join(rows)
    except Exception:
        pass
    total = sum(len(t.strip()) for _, t in pages)
    needs_vision = bool(pages) and total / len(pages) < SCAN_CHARS_PER_PAGE
    parts = []
    for i, t in pages:
        block = f"[[PAGE {i}]]\n{t.strip()}"
        if i in tables:
            block += f"\n[tables on page {i}]\n{tables[i]}"
        parts.append(block)
    return "\n\n".join(parts), len(pages), needs_vision


def extract_text(filename: str, data: bytes) -> tuple[str, int, bool]:
    if data[:5] == b"%PDF-" or filename.lower().endswith(".pdf"):
        return extract_pdf(data)
    if filename.lower().endswith((".txt", ".md", ".htm", ".html")):
        return "[[PAGE 1]]\n" + data.decode("utf-8", errors="replace"), 1, False
    return "", 0, False  # Word/Excel/zip: stored, but not read in Phase 1


def store_document(conn: sqlite3.Connection, opportunity_id: int, filename: str, data: bytes,
                   origin: str, doc_type: str | None = None, doc_id: int | None = None) -> int:
    """Save bytes to data/docs, extract text, record hash. Used by scrapers and manual upload."""
    sha = hashlib.sha256(data).hexdigest()
    folder = settings.DOCS_DIR / str(opportunity_id)
    folder.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._ -]+", "_", filename)[:120] or "document"
    path = folder / f"{sha[:10]}_{safe}"
    path.write_bytes(data)
    try:
        text, pages, vision = extract_text(filename, data)
        err = None if (text or vision) else "No text could be extracted from this file type."
    except Exception as e:
        text, pages, vision, err = "", 0, False, f"Could not read file: {type(e).__name__}: {e}"
    now = db.now()
    if doc_id is None:
        cur = conn.execute(
            "INSERT INTO documents(opportunity_id,filename,url_or_path,first_seen,last_seen) VALUES(?,?,?,?,?)",
            (opportunity_id, filename, origin, now, now))
        doc_id = cur.lastrowid
    conn.execute(
        "UPDATE documents SET local_path=?, sha256=?, page_count=?, text=?, needs_vision=?, doc_type=?,"
        " fetch_error=?, last_seen=? WHERE id=?",
        (str(path), sha, pages, text, int(vision), doc_type or guess_doc_type(filename), err, now, doc_id))
    conn.commit()
    return doc_id


def download_pending(conn: sqlite3.Connection, fetcher: Fetcher, only_open: bool = True) -> int:
    """Download documents the scrapers found links for. Failures are recorded, not hidden."""
    q = ("SELECT d.* FROM documents d JOIN opportunities o ON o.id=d.opportunity_id"
         " WHERE d.sha256 IS NULL AND d.fetch_error LIKE 'pending|%'")
    if only_open:
        q += " AND o.status='open'"
    done = 0
    for d in conn.execute(q).fetchall():
        url = d["fetch_error"].split("|", 1)[1]
        try:
            page = fetcher.get(url)
            store_document(conn, d["opportunity_id"], d["filename"], page.body, d["url_or_path"],
                           d["doc_type"], doc_id=d["id"])
            done += 1
        except Exception as e:
            conn.execute("UPDATE documents SET fetch_error=? WHERE id=?",
                         (f"Download failed ({type(e).__name__}: {e}). Upload it by hand.", d["id"]))
            conn.commit()
    return done


def create_manual_opportunity(conn: sqlite3.Connection, title: str, owner_name: str = "", county: str = "",
                              city: str = "", due_datetime: str | None = None,
                              files: list[tuple[str, bytes]] | None = None) -> int:
    """Dashboard upload: drag in a bid PDF, get an Opportunity."""
    sid = manual_source_id(conn)
    now = db.now()
    key = hashlib.sha256(f"manual|{title}|{now}".encode()).hexdigest()[:32]
    cur = conn.execute(
        "INSERT INTO opportunities(source_id,owner_name,title,county,city,due_datetime,status,raw_text,"
        "dedupe_key,created_at,updated_at) VALUES(?,?,?,?,?,?, 'open', ?,?,?,?)",
        (sid, owner_name, title, county, city, due_datetime, title, key, now, now))
    oid = cur.lastrowid
    for name, data in files or []:
        store_document(conn, oid, name, data, f"upload:{name}")
    conn.commit()
    return oid


def docs_fingerprint(conn: sqlite3.Connection, opportunity_id: int) -> str:
    """Changes whenever the set of readable documents (or the notice text) changes."""
    rows = conn.execute(
        "SELECT sha256 FROM documents WHERE opportunity_id=? AND sha256 IS NOT NULL ORDER BY sha256",
        (opportunity_id,)).fetchall()
    raw = conn.execute("SELECT raw_text FROM opportunities WHERE id=?", (opportunity_id,)).fetchone()["raw_text"] or ""
    return hashlib.sha256(("|".join(r["sha256"] for r in rows) + "|" + raw).encode()).hexdigest()[:32]
