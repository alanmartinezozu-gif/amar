"""Plain records passed from scrapers to ingest, plus date parsing."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class DocLink:
    filename: str
    url: str
    doc_type: str = "notice"


@dataclass
class Opportunity:
    title: str
    url: str = ""
    owner_name: str = ""
    bid_number: str = ""
    county: str = ""
    city: str = ""
    posted_date: str | None = None
    due_datetime: str | None = None
    prebid_datetime: str | None = None
    prebid_mandatory: bool | None = None
    est_value: float | None = None
    raw_text: str = ""
    documents: list[DocLink] = field(default_factory=list)


@dataclass
class ScrapeResult:
    items: list[Opportunity]
    # True when the page itself says "nothing posted" (as opposed to the parser finding nothing).
    explicit_empty: bool = False
    # True when the page layout was recognised at all.
    layout_ok: bool = True


MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], 1)}
MONTHS.update({k[:3]: v for k, v in list(MONTHS.items())})
MONTHS["sept"] = 9

_TIME = re.compile(r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?", re.I)
_NUMERIC = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b")
_WORDY = re.compile(r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b")


def parse_datetime(text: str | None) -> str | None:
    """Best-effort parse of things like 'Thursday, 6/26/25 at 2:00 PM MST' or
    '2:00 P.M., local time, Tuesday, March 31, 2026'. Returns ISO local time, or None.
    Never guesses: no date found means None."""
    if not text:
        return None
    text = " ".join(text.split())
    y = mo = d = None
    m = _NUMERIC.search(text)
    if m:
        mo, d, y = int(m[1]), int(m[2]), int(m[3])
        if y < 100:
            y += 2000
    else:
        for m in _WORDY.finditer(text):
            if m[1].lower() in MONTHS:
                mo, d, y = MONTHS[m[1].lower()], int(m[2]), int(m[3])
                break
    if y is None:
        return None
    hh = mm = 0
    has_time = False
    t = _TIME.search(text)
    if t:
        hh, mm = int(t[1]) % 12, int(t[2] or 0)
        if t[3].lower() == "p":
            hh += 12
        has_time = True
    try:
        dt = datetime(y, mo, d, hh, mm)
    except ValueError:
        return None
    return dt.isoformat(timespec="minutes") if has_time else dt.date().isoformat()


def guess_doc_type(filename: str) -> str:
    f = filename.lower()
    if "addend" in f:
        return "addendum"
    if "plan" in f or "drawing" in f:
        return "plans"
    if "spec" in f or "package" in f or "packet" in f:
        return "spec"
    if "form" in f:
        return "bidform"
    if "question" in f or "q&a" in f or "q & a" in f:
        return "qa"
    return "notice"
