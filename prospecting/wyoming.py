#!/usr/bin/env python3
"""Contractor lead list for all of Wyoming, built on the Google Maps Scraper Kit.

1. Scrape: runs the kit's scrape.py once per town (a few trades per job, one job at a time,
   never in parallel), saving each raw CSV under out/raw/. Re-running skips what is done, so a
   run cut short by Google rate limits picks up where it stopped.
2. Merge: dedupes on place_id, keeps Wyoming businesses (address in WY, or no address and a
   307 phone), drops supply stores and rental shops that contractor searches pull in.
3. Enrich: enrich.py visits each website for owner name, ad tracking and lead forms.

Needs the kit's engine running (docker compose up -d in the kit folder).

    python3 wyoming.py --kit ~/google-maps-scraper-kit
    python3 wyoming.py --cities Casper,Cheyenne --trades "roofing contractor,plumber"
    python3 wyoming.py --skip-scrape          # only merge + enrich what out/raw/ already has
"""
import argparse, csv, glob, os, re, subprocess, sys

import enrich

# Hard-coded so no geocoding call is needed. Lat/lon of each town center.
TOWNS = {
    "Cheyenne": ("41.1400", "-104.8202"), "Casper": ("42.8666", "-106.3131"),
    "Laramie": ("41.3114", "-105.5911"), "Gillette": ("44.2911", "-105.5022"),
    "Rock Springs": ("41.5875", "-109.2029"), "Sheridan": ("44.7972", "-106.9562"),
    "Green River": ("41.5286", "-109.4662"), "Evanston": ("41.2683", "-110.9632"),
    "Riverton": ("43.0250", "-108.3801"), "Jackson": ("43.4799", "-110.7624"),
    "Cody": ("44.5263", "-109.0565"), "Rawlins": ("41.7911", "-107.2387"),
    "Lander": ("42.8330", "-108.7307"), "Douglas": ("42.7597", "-105.3822"),
    "Powell": ("44.7538", "-108.7574"), "Torrington": ("42.0625", "-104.1844"),
    "Worland": ("44.0169", "-107.9554"), "Buffalo": ("44.3483", "-106.6989"),
    "Wheatland": ("42.0541", "-104.9527"), "Pinedale": ("42.8666", "-109.8607"),
    "Thermopolis": ("43.6461", "-108.2121"), "Newcastle": ("43.8547", "-104.2049"),
    "Kemmerer": ("41.7925", "-110.5377"),
}
TRADES = ["general contractor", "roofing contractor", "HVAC contractor", "plumber",
          "electrician", "remodeling contractor", "concrete contractor"]
NOT_CONTRACTORS = re.compile(r"\bstore\b|supplier|supply|wholesaler|rental|dealer|manufacturer|school", re.I)
HERE = os.path.dirname(os.path.abspath(__file__))


def find_kit(path):
    candidates = [path, os.environ.get("GMAPS_KIT"), "google-maps-scraper-kit",
                  os.path.join(HERE, os.pardir, os.pardir, "google-maps-scraper-kit"),
                  os.path.expanduser("~/google-maps-scraper-kit")]
    for c in filter(None, candidates):
        script = os.path.join(c, "scripts", "scrape.py")
        if os.path.isfile(script):
            return script
    sys.exit("✗ Google Maps Scraper Kit not found. Clone it and pass --kit:\n"
             "  git clone https://github.com/Mahanaicoach/google-maps-scraper-kit.git")


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def count_rows(path):
    try:
        with open(path, newline="", encoding="utf-8") as f:
            return sum(1 for _ in csv.DictReader(f))
    except OSError:
        return 0


def scrape(script, towns, trades, raw_dir, depth, per_job):
    """One kit job per town and chunk of trades, sequentially. Stops after 3 failures in a row."""
    failures = 0
    for town in towns:
        lat, lon = TOWNS[town]
        for i in range(0, len(trades), per_job):
            chunk = trades[i:i + per_job]
            out = os.path.join(raw_dir, f"{slug(town)}-{i // per_job + 1}-{slug('-'.join(chunk))}.csv")
            if os.path.exists(out):
                continue
            keywords = [f"{t} in {town} WY" for t in chunk]
            print(f"\n▶ {town}: {', '.join(chunk)}", flush=True)
            cmd = [sys.executable, script, keywords[0], lat, lon, "--full", "--depth", str(depth),
                   "--max-time", str(300 * len(chunk)), "--out", out + ".part"]
            for k in keywords[1:]:
                cmd += ["--keyword", k]
            # A blocked or rate-limited job still ends "ok", just with no rows, so 0 rows is a failure
            # too: the town stays unfinished and the next run retries it.
            if subprocess.run(cmd).returncode == 0 and count_rows(out + ".part"):
                os.replace(out + ".part", out)
                failures = 0
                continue
            if os.path.exists(out + ".part"):
                os.remove(out + ".part")
            failures += 1
            print(f"  ⚠ {town} job failed or came back empty ({failures} in a row)")
            if failures >= 3:
                print("✗ 3 failures in a row: Google is probably rate-limiting this IP. Wait an hour "
                      "or add proxies, then re-run: finished towns are skipped.")
                return False
    return True


def in_wyoming(row):
    addr = enrich._json(row.get("complete_address"))
    state = str(addr.get("state") or "").strip().lower()
    if state:
        return state in ("wy", "wyoming")
    if re.search(r",\s*(?:WY|Wyoming)\b", row.get("address", "")):
        return True
    if re.search(r",\s*[A-Z]{2}\s+\d{5}", row.get("address", "")):
        return False  # an address in another state
    return re.sub(r"\D", "", row.get("phone", "")).lstrip("1").startswith("307")


def merge(raw_dir):
    rows, seen = [], set()
    for path in sorted(glob.glob(os.path.join(raw_dir, "*.csv"))):
        with open(path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                key = r.get("place_id") or r.get("cid") or r.get("link") or (r.get("title"), r.get("phone"))
                if key in seen:
                    continue
                seen.add(key)
                rows.append(r)
    kept = [r for r in rows if in_wyoming(r) and not NOT_CONTRACTORS.search(r.get("category", ""))]
    print(f"▶ Merged {len(rows)} unique listings; kept {len(kept)} Wyoming contractors "
          f"(dropped {len(rows) - len(kept)} out-of-state or supply/rental listings)")
    return kept


def main():
    ap = argparse.ArgumentParser(description="Wyoming contractor leads: phone, email, owner, ads, web form.")
    ap.add_argument("--kit", help="path to the google-maps-scraper-kit folder")
    ap.add_argument("--cities", help=f"comma-separated towns (default: all {len(TOWNS)})")
    ap.add_argument("--trades", help="comma-separated trades (default: " + ", ".join(TRADES) + ")")
    ap.add_argument("--depth", type=int, default=5, help="kit scroll depth per search (default 5)")
    ap.add_argument("--per-job", type=int, default=4, help="trades per kit job (default 4)")
    ap.add_argument("--out-dir", default=os.path.join(HERE, "out"))
    ap.add_argument("--skip-scrape", action="store_true", help="only merge and enrich existing raw CSVs")
    ap.add_argument("--workers", type=int, default=8, help="websites checked in parallel")
    a = ap.parse_args()

    towns = [t.strip() for t in a.cities.split(",")] if a.cities else list(TOWNS)
    unknown = [t for t in towns if t not in TOWNS]
    if unknown:
        sys.exit(f"✗ Unknown town(s): {', '.join(unknown)}. Known: {', '.join(TOWNS)}")
    trades = [t.strip() for t in a.trades.split(",")] if a.trades else TRADES
    raw_dir = os.path.join(a.out_dir, "raw")
    os.makedirs(raw_dir, exist_ok=True)

    if not a.skip_scrape:
        searches = len(towns) * len(trades)
        print(f"▶ {searches} searches ({len(towns)} towns x {len(trades)} trades), one job at a time.")
        print("⚠️  Heads-up: a run this size can get your IP temporarily rate-limited by Google. "
              "Re-run to resume; finished towns are skipped.")
        complete = scrape(find_kit(a.kit), towns, trades, raw_dir, a.depth, a.per_job)
        if not complete:
            print("  Enriching what was scraped so far.")

    rows = merge(raw_dir)
    if not rows:
        sys.exit("✗ Nothing to enrich yet.")
    print("▶ Checking websites for owner name, ad tracking and lead forms…")
    leads = enrich.enrich(rows, a.workers)
    out = os.path.join(a.out_dir, "wyoming_contractors.csv")
    enrich.write_csv(leads, out)
    print(f"✓ {enrich.summary(leads)}\n  saved → {out}")


if __name__ == "__main__":
    main()
