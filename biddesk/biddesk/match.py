"""Score open opportunities against client profiles (0-100) with plain rules.

Only matches at or above BRIEF_THRESHOLD get a full Fable brief (cost control), and the
same threshold decides what goes in the weekly report.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

import yaml

from . import db, settings

BRIEF_THRESHOLD = 60


def sync_clients(conn: sqlite3.Connection, folder: Path | None = None) -> None:
    for path in sorted((folder or settings.CLIENTS_DIR).glob("*.yaml")):
        p = yaml.safe_load(path.read_text()) or {}
        if not p.get("name"):
            continue
        conn.execute(
            "INSERT INTO clients(name,tier,profile_yaml_path,email,active) VALUES(?,?,?,?,1)"
            " ON CONFLICT(name) DO UPDATE SET tier=excluded.tier, profile_yaml_path=excluded.profile_yaml_path,"
            " email=excluded.email",
            (p["name"], p.get("tier", "finder"), str(path), p.get("contact_email", "")))
    conn.commit()


def load_profile(client_row) -> dict:
    return yaml.safe_load(Path(client_row["profile_yaml_path"]).read_text()) or {}


def score(profile: dict, opp, now: datetime | None = None) -> tuple[int, str]:
    """Return (score, reason). Unknown facts neither help nor hurt much; they are named."""
    now = now or datetime.now(settings.TZ).replace(tzinfo=None)
    reasons: list[str] = []
    if opp["is_construction"] == 0:
        return 0, "Triage: not construction work."
    pts, trade_miss = 0, False
    tags = set(json.loads(opp["trade_tags"] or "[]"))
    wanted = set(profile.get("trades") or [])
    if opp["is_construction"] is None:
        pts += 20
        reasons.append("Not triaged yet (trade unknown).")
    elif tags & wanted:
        pts += 45
        reasons.append("Trade match: " + ", ".join(sorted(tags & wanted)) + ".")
    else:
        trade_miss = True
        reasons.append("No trade match (" + (", ".join(sorted(tags)) or "no tags") + ").")
    counties = {c.lower() for c in profile.get("counties") or []}
    if opp["county"] and opp["county"].lower() in counties:
        pts += 25
        reasons.append(f"In {opp['county']} County.")
    elif opp["county"]:
        reasons.append(f"{opp['county']} County is outside the client's counties.")
    else:
        pts += 10
        reasons.append("County unknown.")
    lo, hi, val = profile.get("job_size_min"), profile.get("job_size_max"), opp["est_value"]
    if val is None:
        pts += 10
        reasons.append("Job size unknown.")
    elif (lo is None or val >= lo) and (hi is None or val <= hi):
        pts += 15
        reasons.append(f"Size ${val:,.0f} is in range.")
    else:
        reasons.append(f"Size ${val:,.0f} is outside the client's range.")
    if opp["due_datetime"]:
        try:
            days = (datetime.fromisoformat(opp["due_datetime"]) - now).total_seconds() / 86400
        except ValueError:
            days = None
        if days is None:
            pts += 8
        elif days < 0:
            return 0, "Bid deadline has passed."
        elif days >= 7:
            pts += 15
            reasons.append(f"{days:.0f} days until bids are due.")
        elif days >= 3:
            pts += 8
            reasons.append(f"Only {days:.0f} days until bids are due.")
        else:
            reasons.append(f"Under 3 days until bids are due.")
    else:
        pts += 8
        reasons.append("Deadline unknown.")
    if trade_miss:
        pts = min(pts, 45)  # a bid outside the client's trades never reaches the report on location alone
    return min(pts, 100), " ".join(reasons)


def run_matching(conn: sqlite3.Connection) -> int:
    n = 0
    opps = conn.execute("SELECT * FROM opportunities WHERE status='open'").fetchall()
    for c in conn.execute("SELECT * FROM clients WHERE active=1").fetchall():
        profile = load_profile(c)
        for o in opps:
            s, why = score(profile, o)
            conn.execute(
                "INSERT INTO matches(client_id,opportunity_id,score,reason,updated_at) VALUES(?,?,?,?,?)"
                " ON CONFLICT(client_id,opportunity_id) DO UPDATE SET score=excluded.score,"
                " reason=excluded.reason, updated_at=excluded.updated_at",
                (c["id"], o["id"], s, why, db.now()))
            n += 1
    conn.commit()
    return n
