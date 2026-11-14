"""SweetwaterNOW legal notices (https://www.sweetwaternow.com/category/legal-notice/).

The listing shows recent legal notices as <h2 class="entry-title"><a>. We keep the ones
whose headline looks like a bid notice and read each notice page once.

robots.txt (2026-11-14) asks generic bots for a 30 second crawl delay and disallows
/page/ URLs, so only the first listing page is read and the Fetcher waits 30s per request.
"""
from __future__ import annotations

import re

from bs4 import BeautifulSoup

from ..models import Opportunity, ScrapeResult, parse_datetime

BID_WORDS = re.compile(
    r"\b(bids?|bidders?|rfp|rfq|proposals?|invitation|solicitation|call for|advertisement for)\b", re.I)
_DUE = re.compile(r"\b(?:until|by|before|no later than|on or before)\s+(.{0,90}?\b20\d{2})", re.I)
MAX_NEW_PER_RUN = 5


def parse_listing(html: str) -> tuple[list[tuple[str, str]], bool]:
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for h in soup.find_all(["h2", "h3"], class_="entry-title"):
        a = h.find("a", href=True)
        if a:
            out.append((" ".join(a.get_text(" ").split()), a["href"]))
    return out, bool(out)


def parse_notice(html: str, url: str, fallback_title: str = "") -> Opportunity:
    soup = BeautifulSoup(html, "html.parser")
    body = soup.find(class_="entry-content") or soup.find("article") or soup
    for junk in body.find_all(["script", "style", "aside", "form"]):
        junk.extract()
    paras = [" ".join(p.split()) for p in body.get_text("\n").split("\n")]
    paras = [p for p in paras if p and not p.lower().startswith("advertisement - story continues")]
    text = "\n".join(paras)
    h1 = soup.find("h1")
    og = soup.find("meta", property="og:title")
    title = fallback_title or (" ".join(h1.get_text(" ").split()) if h1 else "") or (og.get("content", "") if og else "")
    title = re.sub(r"\s*-\s*SweetwaterNOW\s*$", "", " ".join(title.split()))
    posted = None
    meta = soup.find("meta", property="article:published_time")
    if meta and meta.get("content"):
        posted = meta["content"][:10]
    due = None
    flat = " ".join(paras)
    for m in _DUE.finditer(flat):
        due = parse_datetime(m.group(1))
        if due:
            break
    return Opportunity(title=title[:300], url=url, posted_date=posted, due_datetime=due, raw_text=text[:20000])


def scrape(fetcher, source) -> ScrapeResult:
    listing = fetcher.get(source["url"])
    entries, layout_ok = parse_listing(listing.text)
    known = {r["url"] for r in fetcher.conn.execute(
        "SELECT url FROM opportunities WHERE source_id=?", (source["id"],))}
    items: list[Opportunity] = []
    fetched = 0
    for title, url in entries:
        if not BID_WORDS.search(title):
            continue
        if url in known:
            # Already stored: re-emit a stub so the item count stays honest without a re-fetch.
            items.append(Opportunity(title=title, url=url))
            continue
        if fetched >= MAX_NEW_PER_RUN:
            break
        page = fetcher.get(url)
        fetched += 1
        items.append(parse_notice(page.text, url, title))
    # A listing with headlines but no bid notices is a normal quiet week, not a broken parser.
    return ScrapeResult(items, explicit_empty=layout_ok and not items, layout_ok=layout_ok)
