"""Daily run: check sources, download documents, triage, match, write briefs.

    python run_daily.py                  # normal daily run
    python run_daily.py --weekly-report  # also queue the weekly report in the Outbox
    python run_daily.py --no-ai          # scrape only, spend nothing on Claude
    python run_daily.py --all            # also run weekly sources

Nothing is emailed from here. Reports wait in the dashboard Outbox for approval.
"""
from __future__ import annotations

import argparse

from biddesk import ai, briefs, db, ingest, match, reports
from biddesk.http import Fetcher


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-ai", action="store_true")
    ap.add_argument("--weekly-report", action="store_true")
    ap.add_argument("--all", action="store_true", help="include sources marked weekly")
    args = ap.parse_args()

    conn = db.connect()
    ingest.sync_sources(conn)
    match.sync_clients(conn)
    fetcher = Fetcher(conn)

    print("1. Checking sources")
    q = "SELECT * FROM sources WHERE active=1 AND method='scrape' AND parser IS NOT NULL"
    if not args.all:
        q += " AND check_freq='daily'"
    for s in conn.execute(q).fetchall():
        ingest.run_source(conn, fetcher, s)
        r = conn.execute("SELECT last_status,last_item_count,alert FROM sources WHERE id=?", (s["id"],)).fetchone()
        print(f"  {s['name']}: {r['last_status']}, {r['last_item_count']} items" + (f"  ALERT: {r['alert']}" if r["alert"] else ""))

    db.refresh_statuses(conn)
    print("2. Downloading documents for open bids")
    print(f"  {ingest.download_pending(conn, fetcher)} downloaded")

    if args.no_ai:
        print("3. AI skipped (--no-ai)")
    elif not ai.available():
        print("3. AI skipped: ANTHROPIC_API_KEY is not set in .env")
    else:
        print("3. Triage (Haiku)")
        print(f"  {briefs.triage_new(conn)} triaged")

    print("4. Matching")
    print(f"  {match.run_matching(conn)} client/bid pairs scored")

    if not args.no_ai and ai.available():
        print("5. Bid briefs (Fable) for matches scoring 60+")
        print(f"  {briefs.brief_top_matches(conn)} briefs written")

    if args.weekly_report:
        print(f"6. Weekly report: {reports.queue_weekly(conn)} queued in the Outbox for approval")

    spend = conn.execute("SELECT COALESCE(SUM(cost_usd),0) c FROM ai_usage WHERE ts>=date('now','start of month')").fetchone()["c"]
    open_n = conn.execute("SELECT COUNT(*) c FROM opportunities WHERE status='open'").fetchone()["c"]
    print(f"Done. {open_n} open bids in the database. AI spend this month: ${spend:.2f}")
    print("Open the dashboard with:  streamlit run app.py")


if __name__ == "__main__":
    main()
