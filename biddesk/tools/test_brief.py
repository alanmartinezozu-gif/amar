"""Run the full pipeline on one PAST bid to prove the Fable brief works when nothing is open.

    python tools/test_brief.py "Lowell HVAC"          # download its documents, triage, write the brief
    python tools/test_brief.py "Lowell HVAC" --dry    # download and show what would be sent; no AI cost
    python tools/test_brief.py "RIVERVIEW" --url "https://www.grwyo.org/bids.aspx?bidID=213"

Scrapes first if the database is empty. The bid stays 'closed'; only this script briefs closed bids.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from biddesk import ai, briefs, db, ingest, match, settings  # noqa: E402
from biddesk.http import Fetcher  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("title", help="part of the bid title")
    ap.add_argument("--dry", action="store_true", help="no Claude calls")
    ap.add_argument("--url", default=None, help="CivicPlus bid detail page to load first (for closed bids)")
    ap.add_argument("--client", default=None, help="client name (default: first client)")
    args = ap.parse_args()

    conn = db.connect()
    ingest.sync_sources(conn)
    match.sync_clients(conn)
    fetcher = Fetcher(conn)
    find = lambda: conn.execute(  # noqa: E731
        "SELECT * FROM opportunities WHERE title LIKE ? ORDER BY due_datetime DESC LIMIT 1", (f"%{args.title}%",)).fetchone()
    if args.url:  # a closed CivicPlus bid detail page, e.g. https://www.grwyo.org/bids.aspx?bidID=213
        from biddesk.sources import civicplus
        src = conn.execute("SELECT * FROM sources WHERE parser='civicplus' LIMIT 1").fetchone()
        ingest.upsert_opportunity(conn, src, civicplus.parse_detail(fetcher.get(args.url).text, args.url))
    opp = find()
    if opp is None:
        print("Not in the database yet; checking sources first...")
        for s in conn.execute("SELECT * FROM sources WHERE active=1 AND method='scrape' AND parser IS NOT NULL").fetchall():
            ingest.run_source(conn, fetcher, s)
        opp = find()
    if opp is None:
        sys.exit(f"No bid with '{args.title}' in its title.")
    print(f"Bid #{opp['id']}: {opp['title']} (status {opp['status']}, due {opp['due_datetime']})")

    for d in conn.execute("SELECT * FROM documents WHERE opportunity_id=? AND sha256 IS NULL AND fetch_error LIKE 'pending|%'",
                          (opp["id"],)).fetchall():
        url = d["fetch_error"].split("|", 1)[1]
        try:
            ingest.store_document(conn, opp["id"], d["filename"], fetcher.get(url).body, d["url_or_path"], d["doc_type"], doc_id=d["id"])
        except Exception as e:
            conn.execute("UPDATE documents SET fetch_error=? WHERE id=?", (ingest.download_error(e), d["id"]))
            conn.commit()
    docs = conn.execute("SELECT * FROM documents WHERE opportunity_id=?", (opp["id"],)).fetchall()
    for d in docs:
        state = f"{d['page_count']} pages, {len(d['text'] or ''):,} chars" + (", SCANNED" if d["needs_vision"] else "") if d["sha256"] else d["fetch_error"]
        print(f"  - {d['filename']} [{d['doc_type']}]: {state}")

    q = "SELECT * FROM clients WHERE active=1" + (" AND name=?" if args.client else "") + " ORDER BY id LIMIT 1"
    client = conn.execute(q, (args.client,) if args.client else ()).fetchone()
    if args.dry:
        blocks = ai.build_brief_content(opp, docs, Path(client["profile_yaml_path"]).read_text())
        chars = sum(len(b.get("text", "")) for b in blocks)
        print(f"Dry run: would send {chars:,} characters (~{chars // 4:,} tokens) plus "
              f"{sum(b['type'] == 'image' for b in blocks)} page images to {settings.brief_model()} for client {client['name']}.")
        return
    if not ai.available():
        sys.exit("ANTHROPIC_API_KEY is not set in .env, so the brief cannot run. Use --dry to test without it.")
    t = ai.triage(conn, opp["id"], opp["title"], (opp["raw_text"] or "") + "\n" + next((d["text"][:6000] for d in docs if d["text"]), ""))
    print(f"Triage (Haiku): construction={t.is_construction}, trades={t.trade_tags}, confidence={t.confidence}")
    row = briefs.write_brief(conn, opp["id"], client)
    brief = json.loads(row["brief_json"])
    out = settings.DATA_DIR / f"test_brief_{opp['id']}.html"
    out.write_text("<meta charset='utf-8'><body style='font-family:Arial;max-width:760px;margin:30px auto'>"
                   + briefs.brief_html(brief) + f"<hr><small>{settings.FOOTER}</small></body>")
    (settings.DATA_DIR / f"test_brief_{opp['id']}.json").write_text(json.dumps(brief, indent=2))
    spend = conn.execute("SELECT model, input_tokens, output_tokens, cache_read_tokens, cost_usd FROM ai_usage WHERE opportunity_id=? ORDER BY id",
                         (opp["id"],)).fetchall()
    for s in spend:
        print(f"  {s['model']}: {s['input_tokens']:,} in / {s['output_tokens']:,} out / {s['cache_read_tokens']:,} cached = ${s['cost_usd']:.4f}")
    print(f"Brief saved: {out}")


if __name__ == "__main__":
    main()
