# Bid Desk code graph

14 modules, 17 classes, 63 functions. 113 call links, 37 import links.

Built from the Python syntax tree only. Calls made through objects (database rows, the Anthropic client, dynamically imported scrapers) are not resolved, so real coupling is somewhat higher.

## Most depended-on functions (called from the most places)

- `biddesk.db.now` - 13 callers (biddesk/db.py:79)
- `biddesk.settings.env` - 10 callers (biddesk/settings.py:28)
- `biddesk.briefs.latest_brief` - 4 callers (biddesk/briefs.py:36)
- `biddesk.models.Opportunity` - 4 callers (biddesk/models.py:17)
- `biddesk.models.guess_doc_type` - 3 callers (biddesk/models.py:88)
- `biddesk.models.ScrapeResult` - 3 callers (biddesk/models.py:34)
- `biddesk.ingest.store_document` - 3 callers (biddesk/ingest.py:165)
- `biddesk.models.parse_datetime` - 3 callers (biddesk/models.py:53)
- `biddesk.ingest.docs_fingerprint` - 3 callers (biddesk/ingest.py:232)
- `biddesk.db.connect` - 2 callers (biddesk/db.py:83)

## Functions that orchestrate the most (call the most others)

- `app` - calls 18 (app.py:1)
- `run_daily.main` - calls 12 (run_daily.py:18)
- `biddesk.sources.scsd1_facilities.parse` - calls 6 (biddesk/sources/scsd1_facilities.py:23)
- `biddesk.sources.revize.parse` - calls 5 (biddesk/sources/revize.py:20)
- `biddesk.http.Fetcher.get` - calls 5 (biddesk/http.py:79)
- `biddesk.briefs.write_brief` - calls 5 (biddesk/briefs.py:42)
- `biddesk.briefs.brief_top_matches` - calls 4 (biddesk/briefs.py:56)
- `biddesk.sources.sweetwaternow.scrape` - calls 4 (biddesk/sources/sweetwaternow.py:58)

## Module dependencies

- `app` -> `biddesk.ai`, `biddesk.briefs`, `biddesk.db`, `biddesk.ingest`, `biddesk.match`, `biddesk.reports`, `biddesk.settings`
- `biddesk.ai` -> `biddesk.db`, `biddesk.settings`
- `biddesk.briefs` -> `biddesk.ai`, `biddesk.db`, `biddesk.ingest`, `biddesk.match`, `biddesk.settings`
- `biddesk.db` -> `biddesk.settings`
- `biddesk.http` -> `biddesk.db`, `biddesk.settings`
- `biddesk.ingest` -> `biddesk.db`, `biddesk.http`, `biddesk.models`, `biddesk.settings`
- `biddesk.match` -> `biddesk.db`, `biddesk.settings`
- `biddesk.reports` -> `biddesk.briefs`, `biddesk.db`, `biddesk.match`, `biddesk.settings`
- `biddesk.sources.revize` -> `biddesk.models`
- `biddesk.sources.scsd1_facilities` -> `biddesk.models`
- `biddesk.sources.sweetwaternow` -> `biddesk.models`
- `run_daily` -> `biddesk.ai`, `biddesk.briefs`, `biddesk.db`, `biddesk.http`, `biddesk.ingest`, `biddesk.match`, `biddesk.reports`

## Functions with no resolved caller

Entry points, scraper `scrape`/`parse` functions loaded by name, methods called on objects, or unused code.

- `biddesk.http.Fetcher.get`
- `biddesk.http.Page.text`
- `biddesk.sources.revize.scrape`
- `biddesk.sources.scsd1_facilities.scrape`
- `biddesk.sources.sweetwaternow.scrape`
