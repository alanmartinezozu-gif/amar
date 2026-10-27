"""Runs the six steps in order. Prepares a list only - it never contacts anyone."""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

from . import history
from .cache import Cache
from .config import Settings
from .enrich import enrich_lead
from .export import write_ghl_csv, write_summary
from .fetcher import Fetcher
from .hunter import HunterAuthError, domain_search, pick_email
from .models import Lead
from .outreach import OutreachFatal, OutreachWriter
from .score import rank
from .source import collect_candidates

log = logging.getLogger(__name__)

SKIP_REASONS = {
    "closed": "closed on Google",
    "no_phone": "no US phone number",
    "no_name": "no business name",
    "review_count_out_of_range": "review count outside range",
    "delivered_on_previous_day": "already delivered on a previous day",
    "duplicate_in_this_run": "duplicate of another result today",
}


class NoLeadsError(Exception):
    pass


@dataclass
class Clients:
    outscraper: object  # outscraper.OutscraperClient
    http: object  # requests.Session
    claude: object  # anthropic.Anthropic


@dataclass
class RunResult:
    leads: list[Lead]
    csv_path: Path
    summary_path: Path


def _enrich_all(pool: list[Lead], fetcher: Fetcher, workers: int) -> None:
    with ThreadPoolExecutor(max_workers=workers) as pool_ex:
        futures = {pool_ex.submit(enrich_lead, lead, fetcher): lead for lead in pool}
        for future in as_completed(futures):
            lead = futures[future]
            try:
                future.result()
            except Exception as e:  # one broken site must not stop the run
                lead.enrich_error = f"{type(e).__name__}: {e}"
                log.warning("%s: enrichment failed, skipping its website (%s)", lead.name, lead.enrich_error)
                continue
            if lead.enrich_error:
                log.info("%s: website not read (%s)", lead.name, lead.enrich_error)
            else:
                log.debug("%s: owner=%r spanish=%s platforms=%s emergency=%s form=%s email=%s evidence=%s",
                          lead.name, lead.owner_name, lead.spanish_signal, lead.lead_platforms,
                          lead.emergency_service, lead.has_contact_form, lead.email, lead.evidence)


def _hunter_emails(leads: list[Lead], clients: Clients, cache: Cache, settings: Settings) -> tuple[int, int]:
    looked_up = found = 0
    for lead in leads:
        if lead.email or not lead.domain:
            continue
        looked_up += 1
        try:
            emails = domain_search(clients.http, cache, settings.hunter_api_key, lead.domain)
        except HunterAuthError as e:
            log.error("%s - skipping Hunter for the rest of this run", e)
            break
        except Exception as e:
            log.warning("%s: Hunter lookup failed (%s)", lead.name, e)
            continue
        lead.email = pick_email(emails, lead.owner_name, settings.hunter.min_confidence)
        if lead.email:
            lead.email_source = "hunter"
            found += 1
    return looked_up, found


def _write_outreach(leads: list[Lead], writer: OutreachWriter, workers: int) -> None:
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(writer.write, lead): lead for lead in leads}
        for future in as_completed(futures):
            lead = futures[future]
            try:
                future.result()
            except OutreachFatal:
                for f in futures:
                    f.cancel()
                raise
            except Exception as e:
                lead.outreach_error = f"{type(e).__name__}: {e}"
                log.warning("%s: outreach copy failed, left blank (%s)", lead.name, lead.outreach_error)


def run(settings: Settings, run_date: str, clients: Clients, record_history: bool = True) -> RunResult:
    cache = Cache(settings.cache_path, {
        "outscraper": settings.cache.outscraper_days,
        "page": settings.cache.pages_days,
        "hunter": settings.cache.hunter_days,
        "claude": settings.cache.claude_days,
    })
    try:
        delivered = history.delivered_keys(settings.history_file, run_date)
        log.info("Step 1-2: searching Google Maps (%d businesses delivered before)", len(delivered))
        pool, stats = collect_candidates(clients.outscraper, cache, settings, delivered)
        if not pool:
            raise NoLeadsError("No new businesses matched. Add cities or widen the review range in config.yaml.")

        log.info("Step 3: reading %d websites", sum(bool(l.website) for l in pool))
        _enrich_all(pool, Fetcher(clients.http, cache, settings.crawler), settings.crawler.concurrency)

        log.info("Step 4: scoring %d candidates", len(pool))
        leads = rank(pool)[: settings.leads_per_day]

        looked_up = found = 0
        if settings.hunter.enabled and settings.hunter_api_key:
            looked_up, found = _hunter_emails(leads, clients, cache, settings)

        log.info("Step 5: writing outreach copy for %d leads", len(leads))
        _write_outreach(leads, OutreachWriter(clients.claude, cache, settings), settings.claude.concurrency)
    finally:
        cache.close()

    csv_path = settings.output_dir / f"ghl_import_{run_date}.csv"
    summary_path = settings.output_dir / f"summary_{run_date}.md"
    log.info("Step 6: exporting %s", csv_path.name)
    write_ghl_csv(csv_path, leads)

    warnings = []
    if len(leads) < settings.leads_per_day:
        warnings.append(f"Only {len(leads)} of {settings.leads_per_day} leads found. Add cities to config.yaml.")
    warnings += [f'Google Maps has no more results for "{q}"; it will only give repeats from now on.'
                 for q in stats.exhausted]
    warnings += [f'Search failed: "{q}" (see log)' for q in stats.failed]
    blank = [l.name for l in leads if not l.dm_text]
    if blank:
        warnings.append(f"No outreach copy for {len(blank)} lead(s): {', '.join(blank)} (see log)")
    details = [
        ("Searches", ", ".join(f"{t} in {c.label}" for c in settings.cities for t in settings.trades)),
        ("Outscraper places billed this run", f"{stats.billed_places} in {stats.billed_requests} request(s); cached pages are free"),
        ("Places returned", stats.places_seen),
    ]
    details += [(f"Skipped: {SKIP_REASONS.get(k, k)}", v) for k, v in stats.skipped.most_common()]
    details += [
        ("Candidates scored", len(pool)),
        ("Websites read", sum(l.pages_fetched > 0 for l in pool)),
        ("Websites not readable (down, blocked by robots.txt, or no site)",
         sum(l.pages_fetched == 0 for l in pool)),
        ("Hunter lookups / emails found", f"{looked_up} / {found}"),
        ("History", "recorded in " + settings.history_file.name if record_history else "not recorded (--no-history)"),
    ]
    write_summary(summary_path, run_date, leads,
                  {"csv_name": csv_path.name, "details": details, "warnings": warnings})

    if record_history:
        history.record(settings.history_file, run_date, leads)
    return RunResult(leads, csv_path, summary_path)
