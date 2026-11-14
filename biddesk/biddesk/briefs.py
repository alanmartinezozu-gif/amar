"""Triage new opportunities and write Fable bid briefs for the top matches."""
from __future__ import annotations

import html
import json
import sqlite3
from pathlib import Path

from . import ai, db, ingest, match, settings


def triage_new(conn: sqlite3.Connection, log=print) -> int:
    n = 0
    rows = conn.execute("SELECT * FROM opportunities WHERE status='open' AND is_construction IS NULL").fetchall()
    for o in rows:
        text = o["raw_text"] or ""
        doc = conn.execute(
            "SELECT text FROM documents WHERE opportunity_id=? AND text IS NOT NULL AND text!='' LIMIT 1",
            (o["id"],)).fetchone()
        if doc:
            text += "\n\n" + doc["text"][:6000]
        try:
            t = ai.triage(conn, o["id"], o["title"], text)
        except Exception as e:
            log(f"  triage failed for #{o['id']}: {e}")
            continue
        conn.execute(
            "UPDATE opportunities SET is_construction=?, trade_tags=?, triage_confidence=?,"
            " est_value=COALESCE(est_value, ?), updated_at=? WHERE id=?",
            (int(t.is_construction), json.dumps(t.trade_tags), t.confidence, t.est_value_if_stated, db.now(), o["id"]))
        conn.commit()
        n += 1
    return n


def latest_brief(conn: sqlite3.Connection, opportunity_id: int, client_id: int | None):
    return conn.execute(
        "SELECT * FROM analyses WHERE opportunity_id=? AND client_id IS ? ORDER BY id DESC LIMIT 1",
        (opportunity_id, client_id)).fetchone()


def write_brief(conn: sqlite3.Connection, opportunity_id: int, client_row) -> sqlite3.Row:
    opp = conn.execute("SELECT * FROM opportunities WHERE id=?", (opportunity_id,)).fetchone()
    docs = conn.execute("SELECT * FROM documents WHERE opportunity_id=? ORDER BY id", (opportunity_id,)).fetchall()
    profile_yaml = Path(client_row["profile_yaml_path"]).read_text()
    brief, cost = ai.bid_brief(conn, opp, docs, profile_yaml, client_row["id"])
    conn.execute(
        "INSERT INTO analyses(opportunity_id,client_id,model,brief_json,docs_fingerprint,created_at,cost_usd)"
        " VALUES(?,?,?,?,?,?,?)",
        (opportunity_id, client_row["id"], settings.brief_model(), brief.model_dump_json(),
         ingest.docs_fingerprint(conn, opportunity_id), db.now(), cost))
    conn.commit()
    return latest_brief(conn, opportunity_id, client_row["id"])


def brief_top_matches(conn: sqlite3.Connection, log=print) -> int:
    """Brief open matches scoring >= threshold that have no brief for the current documents."""
    limit, done = settings.max_briefs_per_run(), 0
    rows = conn.execute(
        "SELECT m.*, o.title FROM matches m JOIN opportunities o ON o.id=m.opportunity_id"
        " WHERE o.status='open' AND m.score>=? AND m.decision!='no_go' ORDER BY m.score DESC",
        (match.BRIEF_THRESHOLD,)).fetchall()
    for m in rows:
        if done >= limit:
            log(f"  brief limit reached ({limit} per run); the rest wait for the next run.")
            break
        existing = latest_brief(conn, m["opportunity_id"], m["client_id"])
        if existing and existing["docs_fingerprint"] == ingest.docs_fingerprint(conn, m["opportunity_id"]):
            continue
        c = conn.execute("SELECT * FROM clients WHERE id=?", (m["client_id"],)).fetchone()
        try:
            write_brief(conn, m["opportunity_id"], c)
            done += 1
            log(f"  brief written: {m['title'][:70]} for {c['name']}")
        except Exception as e:
            log(f"  brief failed for #{m['opportunity_id']}: {e}")
    return done


# --- rendering ---------------------------------------------------------------
def _e(v) -> str:
    return html.escape(str(v if v not in (None, "") else "unknown"))


def brief_html(b: dict) -> str:
    """One-page brief as simple HTML (used in the dashboard and in report emails)."""
    kd, sub, fit = b["key_dates"], b["submission"], b["fit_for_client"]
    ev = b["estimated_value"]
    value = f"${ev['amount']:,.0f} ({ev['source']}, {ev.get('page') or 'no page'})" if ev.get("amount") else "unknown"
    out = [
        f"<h3>{_e(b['project_name'])}</h3>",
        f"<p><b>Owner:</b> {_e(b['owner'])} &middot; <b>Location:</b> {_e(b['location'])}<br>",
        f"<b>Fit:</b> {fit['score_0_100']}/100 &middot; <b>{_e(fit['go_no_go']).upper()}</b><br>",
        f"<b>Estimated value:</b> {_e(value)}</p>",
        f"<p>{_e(b['scope_summary'])}</p>",
        "<p><b>Key dates</b><br>" + "<br>".join(
            f"{label}: {_e(kd[k])}" for k, label in [
                ("bid_due", "Bids due"), ("bid_opening", "Bid opening"), ("prebid_meeting", "Pre-bid meeting"),
                ("prequal_due", "Prequalification due"), ("questions_due", "Questions due"),
                ("completion_date", "Completion")]) +
        f"<br>Pre-bid mandatory: {_e({True: 'yes', False: 'no'}.get(kd['prebid_mandatory']))}</p>",
        f"<p><b>Submission:</b> {_e(sub['method'])} &middot; deliver to {_e(sub['deliver_to'])}"
        f" &middot; envelope: {_e(sub['envelope_marking'])} &middot; copies: {_e(sub['copies'])}</p>",
        f"<p><b>Prequalification:</b> {_e(b['prequalification']['type'])} - {_e(b['prequalification']['detail'])}"
        f" [{_e(b['prequalification']['page'])}]<br>"
        f"<b>Resident preference:</b> {_e(b['resident_preference_applies'])} &middot; "
        f"<b>Wyoming materials preference:</b> {_e(b['wyoming_materials_preference_applies'])}<br>"
        f"<b>Liquidated damages:</b> {_e(b['liquidated_damages']['amount_per_day'])} per day"
        f" [{_e(b['liquidated_damages']['page'])}] &middot; <b>Addenda:</b> {b['addenda_count']}</p>",
    ]
    if b["requirements"]:
        out.append("<p><b>Requirements</b></p><ul>" + "".join(
            f"<li>{_e(r['item'])}: {_e(r['detail'])} <i>[{_e(r['page'])}]</i></li>" for r in b["requirements"]) + "</ul>")
    if b["red_flags"]:
        out.append("<p><b>Red flags</b></p><ul>" + "".join(
            f"<li><b>{_e(r['flag'])}</b> - {_e(r['why_it_matters'])} <i>[{_e(r['page'])}]</i></li>"
            for r in b["red_flags"]) + "</ul>")
    if fit["reasons"]:
        out.append("<p><b>Why this score</b></p><ul>" + "".join(f"<li>{_e(r)}</li>" for r in fit["reasons"]) + "</ul>")
    if b["questions_to_ask_owner"]:
        out.append("<p><b>Questions to ask the owner</b></p><ul>" + "".join(
            f"<li>{_e(q)}</li>" for q in b["questions_to_ask_owner"]) + "</ul>")
    if b.get("unreadable_documents"):
        out.append("<p><b>Could not be read:</b> " + _e(", ".join(b["unreadable_documents"])) + "</p>")
    return "\n".join(out)
