"""Revize "bid posting" table. Used by the City of Rock Springs Open Bids page and
Sweetwater County Purchasing's Projects and Bidding page.

Layout (seen live 2026-11-14): <table class="rpfbids"> with a header row
(Description | Opening Date/Time | Closing Date/Time), then one nested table per bid whose
first row has three cells. When nothing is posted the plugin prints a placeholder row
anchored "rfpbid_rzNo Items in List".
"""
from __future__ import annotations

from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..models import DocLink, Opportunity, ScrapeResult, guess_doc_type, parse_datetime

DOC_EXT = (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".zip")


def parse(html: str, base_url: str) -> ScrapeResult:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", class_="rpfbids")
    if table is None:
        return ScrapeResult([], layout_ok=False)
    base = soup.find("base", href=True)
    link_base = urljoin(base_url, base["href"]) if base else base_url
    explicit_empty = "No Items in List" in str(table)
    items: list[Opportunity] = []
    for row in table.find_all("tr"):
        cells = row.find_all("td", recursive=False)
        if len(cells) != 3 or row.get("id") == "rz-rpfbids-row":
            continue
        desc = cells[0]
        for s in desc.find_all("script"):
            s.extract()
        title = " ".join(desc.get_text(" ").split())
        if not title or title.lower() == "description":
            continue
        opp = Opportunity(title=title[:300], raw_text=title)
        opening = " ".join(cells[1].get_text(" ").split())
        closing = " ".join(cells[2].get_text(" ").split())
        opp.posted_date = (parse_datetime(opening) or "")[:10] or None
        opp.due_datetime = parse_datetime(closing)
        opp.raw_text = f"{title}\nOpening: {opening}\nClosing: {closing}"
        for a in desc.find_all("a", href=True):
            href = urljoin(link_base, a["href"])
            path = href.split("?")[0].lower()
            if path.endswith(DOC_EXT):
                name = a.get_text(" ", strip=True) or path.rsplit("/", 1)[-1]
                opp.documents.append(DocLink(name, href, guess_doc_type(name)))
            elif not opp.url and not a["href"].startswith(("#", "mailto:", "javascript:")):
                opp.url = href
        opp.url = opp.url or base_url
        items.append(opp)
    return ScrapeResult(items, explicit_empty=explicit_empty and not items)


def scrape(fetcher, source) -> ScrapeResult:
    page = fetcher.get(source["url"])
    return parse(page.text, source["url"])
