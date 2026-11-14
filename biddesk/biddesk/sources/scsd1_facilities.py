"""Sweetwater County School District #1 - Facilities "Current and Upcoming Project Bids".

Layout (seen live 2026-11-14): plain tables whose header row reads
Post Date | Location | Project Name | Bid Date/Time | Other Requirements. The project cell
holds the project name followed by links to the bid documents (signed S3 URLs).
"""
from __future__ import annotations

import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..models import DocLink, Opportunity, ScrapeResult, guess_doc_type, parse_datetime

_DATE = re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}$")


def _clean(cell) -> str:
    return " ".join(cell.get_text(" ").split())


def parse(html: str, base_url: str) -> ScrapeResult:
    soup = BeautifulSoup(html, "html.parser")
    tables = [t for t in soup.find_all("table") if "Post Date" in t.get_text() and "Bid Date" in t.get_text()]
    if not tables:
        return ScrapeResult([], layout_ok=False)
    items: list[Opportunity] = []
    for table in tables:
        for row in table.find_all("tr"):
            cells = [c for c in row.find_all("td", recursive=False)]
            texts = [_clean(c) for c in cells]
            if len(cells) < 4 or not _DATE.match(texts[0]):
                continue
            project = cells[2]
            docs = []
            for a in project.find_all("a", href=True):
                name = a.get_text(" ", strip=True)
                if name:
                    docs.append(DocLink(name, urljoin(base_url, a["href"]), guess_doc_type(name)))
            # Project name = the cell text with the document link labels removed.
            name = texts[2]
            for d in docs:
                name = name.replace(d.filename, " ")
            name = " ".join(name.split()) or (docs[0].filename.rsplit(".", 1)[0] if docs else "")
            if not name:
                continue
            other = " ".join(t for t in texts[4:] if t)
            opp = Opportunity(
                title=f"{name} ({texts[1]})" if texts[1] else name,
                url=base_url,
                posted_date=parse_datetime(texts[0]),
                due_datetime=parse_datetime(texts[3]),
                documents=docs,
                raw_text=f"Project: {name}\nLocation: {texts[1]}\nPosted: {texts[0]}\n"
                         f"Bid date/time: {texts[3]}\nOther requirements: {other}",
            )
            if re.search(r"pre-?bid|bid walk|bidder'?s (walk|tour)", other, re.I):
                opp.prebid_datetime = parse_datetime(other)
                opp.prebid_mandatory = True if re.search(r"mandatory", other, re.I) else None
            items.append(opp)
    return ScrapeResult(items)


def scrape(fetcher, source) -> ScrapeResult:
    page = fetcher.get(source["url"])
    return parse(page.text, source["url"])
