"""python -m daily_leads [--trade roofing --city "Houston, TX" --limit 10]"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import sys
from pathlib import Path

from .config import ConfigError, load_settings, require_keys
from .outreach import OutreachFatal
from .pipeline import Clients, NoLeadsError, run
from .source import FatalSourceError

log = logging.getLogger("daily_leads")
DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config.yaml"


def _setup_logging(log_dir: Path, run_date: str, verbose: bool) -> Path:
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"daily-leads_{run_date}.log"
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    console = logging.StreamHandler(sys.stderr)
    console.setLevel(logging.DEBUG if verbose else logging.INFO)
    console.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%H:%M:%S"))
    file = logging.FileHandler(log_file, encoding="utf-8")
    file.setLevel(logging.DEBUG)
    file.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root.addHandler(console)
    root.addHandler(file)
    for noisy in ("urllib3", "anthropic", "httpx", "httpx2", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    return log_file


def _samples(leads, n: int = 3):
    """Top n leads with copy, making sure a Spanish one is shown if there is one."""
    with_copy = [l for l in leads if l.dm_text]
    picks = with_copy[:n]
    spanish = next((l for l in with_copy if l.spanish_signal), None)
    if spanish and spanish not in picks and picks:
        picks[-1] = spanish
    return picks


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="daily_leads",
        description="Build today's contractor lead list for GoHighLevel. It only prepares the list; it never "
                    "calls, texts, emails or messages anyone.",
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG, help="path to config.yaml")
    parser.add_argument("--trade", action="append", help="only this trade (repeatable), e.g. --trade roofing")
    parser.add_argument("--city", action="append", help='only this city (repeatable), e.g. --city "Houston, TX"')
    parser.add_argument("--limit", type=int, help="number of leads (overrides leads_per_day)")
    parser.add_argument("--date", help="run date YYYY-MM-DD (default: today)")
    parser.add_argument("--no-history", action="store_true",
                        help="dry run: don't record these leads in leads_history.csv")
    parser.add_argument("-v", "--verbose", action="store_true", help="show per-lead details")
    args = parser.parse_args(argv)

    try:
        run_date = dt.date.fromisoformat(args.date).isoformat() if args.date else dt.date.today().isoformat()
    except ValueError:
        parser.error("--date must look like 2026-10-27")
    try:
        settings = load_settings(args.config, trades=args.trade, cities=args.city, limit=args.limit)
    except ConfigError as e:
        print(f"Config error: {e}", file=sys.stderr)
        return 2
    missing = require_keys(settings)
    if missing:
        print(f"Missing in {settings.base_dir / '.env'}: {', '.join(missing)} (see .env.example)", file=sys.stderr)
        return 2
    if not settings.hunter_api_key and settings.hunter.enabled:
        print("Note: HUNTER_API_KEY not set - emails will come from websites only.", file=sys.stderr)

    log_file = _setup_logging(settings.log_dir, run_date, args.verbose)

    import anthropic
    import requests
    from outscraper import OutscraperClient

    clients = Clients(
        outscraper=OutscraperClient(api_key=settings.outscraper_api_key),
        http=requests.Session(),
        claude=anthropic.Anthropic(api_key=settings.anthropic_api_key, max_retries=4),
    )
    try:
        result = run(settings, run_date, clients, record_history=not args.no_history)
    except (FatalSourceError, OutreachFatal, NoLeadsError) as e:
        log.error("%s", e)
        return 1

    leads = result.leads
    print()
    print(f"{len(leads)} leads ready for GoHighLevel")
    print(f"  CSV:     {result.csv_path}")
    print(f"  Summary: {result.summary_path}")
    print(f"  Log:     {log_file}")
    for i, lead in enumerate(_samples(leads), 1):
        lang = "Spanish" if lead.spanish_signal else "English"
        print(f"\nSample DM {i} - {lead.name} ({lead.city}, score {lead.score}, {lang}):\n  {lead.dm_text}")
    print("\nNothing was sent. Import the CSV into GoHighLevel and reach out yourself.")
    return 0
