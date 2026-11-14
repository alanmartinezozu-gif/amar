"""Weekly report email per client. Nothing sends by itself: reports land in the outbox
and go out only when approved in the dashboard.

Phase 1 safety: every email is addressed to REPORT_TO (the operator), never to a client.
"""
from __future__ import annotations

import html
import json
import smtplib
import sqlite3
from datetime import datetime, timedelta
from email.message import EmailMessage

from . import briefs, db, match, settings


def _fmt(dt: str | None) -> str:
    if not dt:
        return "unknown"
    try:
        d = datetime.fromisoformat(dt)
    except ValueError:
        return dt
    return d.strftime("%a %b %-d, %Y %-I:%M %p") if "T" in dt else d.strftime("%a %b %-d, %Y")


def build_weekly(conn: sqlite3.Connection, client_row, now: datetime | None = None) -> tuple[str, str]:
    """Return (subject, html). Only this client's matches and briefs are read."""
    now = now or datetime.now(settings.TZ).replace(tzinfo=None)
    cid = client_row["id"]
    week_ago = (now - timedelta(days=7)).isoformat(timespec="seconds")
    two_weeks = (now + timedelta(days=14)).isoformat(timespec="seconds")
    rows = conn.execute(
        "SELECT m.score, m.reason, m.decision, o.* FROM matches m JOIN opportunities o ON o.id=m.opportunity_id"
        " WHERE m.client_id=? AND o.status='open' AND m.score>=? ORDER BY m.score DESC",
        (cid, match.BRIEF_THRESHOLD)).fetchall()
    new = [r for r in rows if r["created_at"] >= week_ago]
    deadlines = sorted((r for r in rows if r["due_datetime"] and r["due_datetime"] <= two_weeks),
                       key=lambda r: r["due_datetime"])
    prebids = sorted((r for r in rows if r["prebid_datetime"] and now.isoformat() <= r["prebid_datetime"] <= two_weeks),
                     key=lambda r: r["prebid_datetime"])
    pursuing = [r for r in rows if r["decision"] in ("go", "bidding", "submitted")]
    e = html.escape
    p = ['<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;color:#222">',
         f"<h2>Bid Desk weekly report - {e(client_row['name'])}</h2>",
         f"<p>Week of {now.strftime('%B %-d, %Y')}. {len(rows)} open bids match your profile; {len(new)} are new this week.</p>"]

    def section(title, items, line):
        p.append(f"<h3>{title}</h3>")
        p.append("<ul>" + "".join(f"<li>{line(r)}</li>" for r in items) + "</ul>" if items else "<p>None.</p>")

    def link(r):
        t = e(r["title"])
        return f'<a href="{e(r["url"])}">{t}</a>' if r["url"] else t

    section("Deadlines in the next two weeks", deadlines,
            lambda r: f"<b>{_fmt(r['due_datetime'])}</b> - {link(r)} ({e(r['owner_name'] or '')})")
    section("Pre-bid meetings in the next two weeks", prebids,
            lambda r: f"<b>{_fmt(r['prebid_datetime'])}</b>{' (MANDATORY)' if r['prebid_mandatory'] else ''} - {link(r)}")
    section("Bids you are pursuing", pursuing,
            lambda r: f"{link(r)} - status: {e(r['decision'])}, due {_fmt(r['due_datetime'])}")
    p.append("<h3>New matching bids</h3>")
    if not new:
        p.append("<p>No new matching bids this week.</p>")
    for r in new:
        p.append('<div style="border:1px solid #ddd;border-radius:6px;padding:12px;margin:10px 0">')
        a = briefs.latest_brief(conn, r["id"], cid)
        if a:
            p.append(briefs.brief_html(json.loads(a["brief_json"])))
        else:
            p.append(f"<h3>{e(r['title'])}</h3><p>{e(r['owner_name'] or '')} &middot; due {_fmt(r['due_datetime'])}"
                     f" &middot; match {r['score']}/100<br>{e(r['reason'] or '')}</p>"
                     "<p><i>No AI brief yet for this bid.</i></p>")
        if r["url"]:
            p.append(f'<p><a href="{e(r["url"])}">Official posting</a></p>')
        p.append("</div>")
    p.append(f'<hr><p style="font-size:12px;color:#555">{e(settings.FOOTER)}</p></div>')
    subject = f"Bid Desk weekly report - {client_row['name']} - {now.strftime('%b %-d')}"
    return subject, "\n".join(p)


def queue_weekly(conn: sqlite3.Connection) -> int:
    """Put one weekly report per active client in the outbox (status 'pending')."""
    to = settings.env("REPORT_TO")
    n = 0
    for c in conn.execute("SELECT * FROM clients WHERE active=1").fetchall():
        subject, body = build_weekly(conn, c)
        conn.execute(
            "INSERT INTO outbox(client_id,kind,to_addr,subject,html,status,created_at) VALUES(?,?,?,?,?,'pending',?)",
            (c["id"], "weekly", to, subject, body, db.now()))
        n += 1
    conn.commit()
    return n


def send_approved(conn: sqlite3.Connection, outbox_id: int, smtp_factory=smtplib.SMTP) -> str:
    """Send one outbox email after the operator clicks Approve. Returns 'sent' or the error."""
    row = conn.execute("SELECT * FROM outbox WHERE id=?", (outbox_id,)).fetchone()
    if row is None or row["status"] == "sent":
        return "nothing to send"
    to = settings.env("REPORT_TO")  # Phase 1: operator only, regardless of what is stored
    host, user, pw = settings.env("SMTP_HOST"), settings.env("SMTP_USER"), settings.env("SMTP_PASSWORD")
    try:
        if not (to and host and user and pw):
            raise RuntimeError("Email is not set up. Fill SMTP_HOST, SMTP_USER, SMTP_PASSWORD and REPORT_TO in .env.")
        msg = EmailMessage()
        msg["Subject"], msg["From"], msg["To"] = row["subject"], settings.env("EMAIL_FROM") or user, to
        msg.set_content("This report is best viewed as HTML.\n\n" + settings.FOOTER)
        msg.add_alternative(row["html"], subtype="html")
        with smtp_factory(host, int(settings.env("SMTP_PORT", "587") or 587), timeout=30) as s:
            s.starttls()
            s.login(user, pw)
            s.send_message(msg)
        conn.execute("UPDATE outbox SET status='sent', to_addr=?, sent_at=?, error=NULL WHERE id=?",
                     (to, db.now(), outbox_id))
        result = "sent"
    except Exception as ex:
        conn.execute("UPDATE outbox SET status='error', error=? WHERE id=?", (f"{type(ex).__name__}: {ex}", outbox_id))
        result = f"error: {ex}"
    conn.commit()
    return result
