"""leads_history.csv: every business delivered, so it is never delivered twice."""

from __future__ import annotations

import csv
import os
from pathlib import Path

from .models import Lead
from .normalize import to_e164

FIELDS = ["date", "company_name", "phone", "domain", "place_id", "trade", "city", "google_maps_url"]


def _read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _row_keys(row: dict) -> set[str]:
    keys = set()
    phone = to_e164(row.get("phone"))
    if phone:
        keys.add("phone:" + phone)
    if (row.get("domain") or "").strip():
        keys.add("domain:" + row["domain"].strip().lower())
    if (row.get("place_id") or "").strip():
        keys.add("place:" + row["place_id"].strip())
    return keys


def delivered_keys(path: Path, run_date: str) -> set[str]:
    """Keys of businesses delivered on any other day.

    Rows from run_date itself are ignored so a same-day rerun rebuilds the
    same list instead of skipping the leads it delivered an hour ago.
    """
    keys: set[str] = set()
    for row in _read(path):
        if (row.get("date") or "").strip() != run_date:
            keys |= _row_keys(row)
    return keys


def record(path: Path, run_date: str, leads: list[Lead]) -> None:
    """Replace run_date's rows with these leads; keep every other day."""
    rows = [r for r in _read(path) if (r.get("date") or "").strip() != run_date]
    rows += [
        {
            "date": run_date,
            "company_name": lead.name,
            "phone": lead.phone,
            "domain": lead.domain,
            "place_id": lead.place_id,
            "trade": ";".join(lead.trades),
            "city": lead.market.label,
            "google_maps_url": lead.maps_url,
        }
        for lead in leads
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    os.replace(tmp, path)
