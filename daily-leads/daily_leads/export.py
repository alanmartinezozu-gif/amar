"""Step 6: GoHighLevel import CSV and a daily summary."""

from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path

from .models import Lead

GHL_COLUMNS = [
    "First Name", "Last Name", "Phone", "Email", "Company Name", "Website", "Address", "City",
    "State", "Postal Code", "Tags", "Lead Score", "Spanish Signal", "Lead Platforms",
    "Call Note", "DM Text", "Missed Call Text", "Google Maps URL",
]
NAME_SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv"}


def split_name(full: str) -> tuple[str, str]:
    """("John", "Smith") from "John A. Smith"; ("", "") if unknown."""
    parts = full.split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    if len(parts) >= 3 and parts[-1].lower() in NAME_SUFFIXES:
        return parts[0], f"{parts[-2]} {parts[-1]}"
    return parts[0], parts[-1]


def tags_for(lead: Lead) -> str:
    tags = ["prospect", *(t.lower() for t in lead.trades), lead.market.tag]
    if lead.spanish_signal:
        tags.append("spanish")
    return ",".join(dict.fromkeys(tags))


def ghl_row(lead: Lead) -> dict:
    first, last = split_name(lead.owner_name)
    return {
        "First Name": first,
        "Last Name": last,
        "Phone": lead.phone,
        "Email": lead.email,
        "Company Name": lead.name,
        "Website": lead.website,
        "Address": lead.address,
        "City": lead.city,
        "State": lead.state,
        "Postal Code": lead.postal_code,
        "Tags": tags_for(lead),
        "Lead Score": lead.score,
        "Spanish Signal": "yes" if lead.spanish_signal else "no",
        "Lead Platforms": ", ".join(lead.lead_platforms),
        "Call Note": lead.call_note,
        "DM Text": lead.dm_text,
        "Missed Call Text": lead.missed_call_text,
        "Google Maps URL": lead.maps_url,
    }


def write_ghl_csv(path: Path, leads: list[Lead]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=GHL_COLUMNS)
        writer.writeheader()
        writer.writerows(ghl_row(lead) for lead in leads)


def _table(title: str, counts: Counter, key_header: str, order=None) -> list[str]:
    lines = [f"## {title}", "", f"| {key_header} | Leads |", "|---|---:|"]
    keys = order if order is not None else [k for k, _ in counts.most_common()]
    lines += [f"| {k} | {counts[k]} |" for k in keys if counts[k]]
    return lines + [""]


def write_summary(path: Path, run_date: str, leads: list[Lead], notes: dict) -> None:
    n = len(leads)

    def pct(k: int) -> str:
        return f"{k} ({k * 100 // n}%)" if n else "0"

    owners = sum(bool(l.owner_name) for l in leads)
    spanish = sum(l.spanish_signal for l in leads)
    lines = [
        f"# Daily leads - {run_date}",
        "",
        f"**{n} leads** in `{notes.get('csv_name', '')}`",
        "",
        "## Totals",
        "",
        "| | Leads |",
        "|---|---:|",
        f"| With owner name | {pct(owners)} |",
        f"| Spanish signal | {pct(spanish)} |",
        f"| With email | {pct(sum(bool(l.email) for l in leads))} |",
        f"| On lead platforms | {pct(sum(bool(l.lead_platforms) for l in leads))} |",
        f"| Emergency / 24-7 | {pct(sum(l.emergency_service for l in leads))} |",
        f"| Contact form | {pct(sum(l.has_contact_form for l in leads))} |",
        f"| Outreach copy written | {pct(sum(bool(l.dm_text) for l in leads))} |",
        "",
    ]
    lines += _table("By trade", Counter(l.trade for l in leads), "Trade")
    lines += _table("By city (market searched)", Counter(l.market.label for l in leads), "City")
    lines += _table("By city (business address)", Counter(f"{l.city}, {l.state}" for l in leads), "City")
    lines += _table("By score", Counter(l.score for l in leads), "Score", order=list(range(10, -1, -1)))

    lines += ["## Run details", ""]
    for label, value in notes.get("details", []):
        lines.append(f"- {label}: {value}")
    if notes.get("warnings"):
        lines += ["", "## Warnings", ""] + [f"- {w}" for w in notes["warnings"]]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
