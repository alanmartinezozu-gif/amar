"""CivicPlus (CivicEngage) "Bid Postings" module. Used by the City of Green River:
https://www.grwyo.org/bids.aspx

Layout (seen live 2026-11-14): each bid is <div class="listItemsRow bid"> holding
.bidTitle (link to bids.aspx?bidID=N plus a teaser) and .bidStatus (Status / Closes).
With nothing open the page says "There are no open bid postings at this time."
The detail page lists label/value pairs and "Related Documents" links.
"""
from __future__ import annotations

import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..models import DocLink, Opportunity, ScrapeResult, guess_doc_type, parse_datetime

MAX_NEW_PER_RUN = 8
LABELS = ["Bid Number", "Bid Title", "Category", "Status", "Additional Status Information", "Description",
          "Publication Date/Time", "Publication Information", "Closing Date/Time", "Submittal Information",
          "Bid Opening Information", "Addendum Date/Time", "Pre-bid Meeting", "Contact Person",
          "Download Available", "Fee", "Plan & Spec Available", "Business Hours", "Fax Number",
          "Plan Holders List", "Special Requirements", "Miscellaneous", "Qualifications", "Related Documents"]


def parse_list(html: str, base_url: str) -> ScrapeResult:
    soup = BeautifulSoup(html, "html.parser")
    rows = soup.find_all(class_="listItemsRow")
    layout_ok = bool(rows) or "bid postings" in soup.get_text(" ").lower()
    items = []
    for row in rows:
        a = row.find("a", href=re.compile(r"bidID=\d+", re.I))
        if not a:
            continue
        status = row.find(class_="bidStatus")
        values = [s.get_text(" ", strip=True) for s in status.find_all("div")[-1].find_all("span")] if status else []
        state = values[0] if values else ""
        closes = values[1] if len(values) > 1 else ""
        teaser = " ".join(row.find(class_="bidTitle").get_text(" ").split()) if row.find(class_="bidTitle") else ""
        opp = Opportunity(title=" ".join(a.get_text(" ").split())[:300], url=urljoin(base_url, a["href"]),
                          due_datetime=parse_datetime(closes),
                          raw_text=f"{teaser}\nStatus: {state}\nCloses: {closes}")
        opp.bid_number = re.search(r"bidID=(\d+)", a["href"], re.I)[1]
        items.append(opp)
    empty = "no open bid postings" in soup.get_text(" ").lower()
    return ScrapeResult(items, explicit_empty=empty and not items, layout_ok=layout_ok)


def parse_detail(html: str, url: str) -> Opportunity:
    soup = BeautifulSoup(html, "html.parser")
    box = soup.find(class_="moduleContent") or soup
    for junk in box.find_all(["script", "style"]):
        junk.extract()
    lines = [" ".join(x.split()) for x in box.get_text("\n").split("\n")]
    lines = [x for x in lines if x]
    fields: dict[str, list[str]] = {}
    current = None
    for line in lines:
        label = line.rstrip(":")
        if line.endswith(":") and label in LABELS:
            current = label
            fields[current] = []
        elif line.startswith("Return To Main Bid Postings"):
            break
        elif current:
            fields[current].append(line)
    get = lambda k: " ".join(fields.get(k, []))  # noqa: E731
    docs = []
    for a in box.find_all("a", href=True):
        if re.search(r"DocumentCenter|Archive\.aspx|\.pdf|\.docx?$", a["href"], re.I):
            name = a.get_text(" ", strip=True) or "document"
            docs.append(DocLink(name if "." in name[-5:] else name + ".pdf", urljoin(url, a["href"]), guess_doc_type(name)))
    text = "\n".join(f"{k}: {get(k)}" for k in LABELS if k in fields and k != "Related Documents")
    return Opportunity(
        title=get("Bid Title")[:300], url=url, bid_number=get("Bid Number"),
        posted_date=(parse_datetime(get("Publication Date/Time")) or "")[:10] or None,
        due_datetime=parse_datetime(get("Closing Date/Time")),
        prebid_datetime=parse_datetime(get("Pre-bid Meeting")),
        prebid_mandatory=True if re.search(r"mandatory", get("Pre-bid Meeting"), re.I) else None,
        raw_text=text, documents=docs)


def scrape(fetcher, source) -> ScrapeResult:
    result = parse_list(fetcher.get(source["url"]).text, source["url"])
    known = {r["url"] for r in fetcher.conn.execute("SELECT url FROM opportunities WHERE source_id=?", (source["id"],))}
    items, fetched = [], 0
    for stub in result.items:
        if stub.url in known:
            items.append(Opportunity(title=stub.title, url=stub.url))  # counted, not re-fetched
        elif fetched < MAX_NEW_PER_RUN:
            fetched += 1
            detail = parse_detail(fetcher.get(stub.url).text, stub.url)
            detail.title = detail.title or stub.title
            detail.due_datetime = detail.due_datetime or stub.due_datetime
            items.append(detail)
    result.items = items
    return result
