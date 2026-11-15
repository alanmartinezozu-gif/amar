# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Two unrelated projects live here

| Path | What | Stack |
|---|---|---|
| repo root (`src/`, `test/`) | **Speed to Lead**: an AI phone agent that calls a contractor's new lead within seconds, warm-transfers to the team or books an estimate | Node 22+, TypeScript (ESM), Express 5, Twilio ConversationRelay, better-sqlite3 |
| `biddesk/` | **Bid Desk**: finds Wyoming public construction bids, writes Claude bid briefs, matches them to client profiles, builds weekly reports | Python 3.11+, SQLite, Streamlit, Anthropic SDK |

They share nothing: separate dependencies, databases, `.env` files and test suites. Work out which one a request is about before touching code. Bid Desk commands run from inside `biddesk/`.

## Speed to Lead (repo root)

```bash
npm run dev          # tsx watch src/index.ts
npm test             # vitest run (all of test/**/*.test.ts)
npx vitest run test/leads.test.ts            # one file
npx vitest run -t "books on the calendar"    # tests matching a name
npm run typecheck
npm run build && npm start
```

Imports use `.js` extensions on `.ts` sources (NodeNext ESM).

### Architecture

- **Everything hangs off `Deps`** (`src/deps.ts`): config, repo, telephony, llm, calendar, job queue, logger, clock, Facebook Graph fetch. `src/index.ts` builds it with real clients; `src/app.ts` `createApp(deps)` mounts the routers and `registerJobs(deps)` registers queue handlers. New external services go behind an interface on `Deps`.
- **Tests never touch the network.** `test/helpers.ts` builds `Deps` with `FakeTelephony`, a scripted `LlmClient`, a fake calendar backend and a controllable clock, then drives the real HTTP routes and a real WebSocket the way Twilio does. Add fakes there instead of mocking modules.
- **Lead flow:** `src/sources/*` (Facebook, Google Ads, website) → `src/leads/intake.ts` (normalise, merge duplicates, text the lead, queue the call) → `src/jobs/queue.ts` (durable SQLite queue; re-dials, callbacks, texts and webhooks survive restarts) → `src/voice/dialer.ts` → live call in `src/voice/session.ts` over the relay WebSocket (`src/voice/relay.ts`), with tools in `src/voice/tools.ts` and Twilio webhooks/transfer logic in `src/voice/routes.ts`.
- **Live calls are held in memory**, so the app is single-instance by design.
- **Claude conversation history must stay append-only**, including across the transfer hand-off when the AI reconnects to book. A flow test asserts this; do not rewrite or drop earlier turns.
- Calendar providers plug in behind `CalendarBackend` (`src/calendar/service.ts`); only Google exists.
- The model is set by `ANTHROPIC_MODEL` / `ANTHROPIC_EFFORT` / `ANTHROPIC_FALLBACKS` in `.env` (default `claude-opus-5-5`, low effort for phone latency).

## Bid Desk (`biddesk/`)

`biddesk/BUILD_SPEC.md` is the product spec (Phases 1–4) and `biddesk/BUILD_SPEC_ADDON.md` adds Modules A–F for the first client. Phase 1 is built; nothing from the add-on is built. Read the relevant section before adding features, and do not start a phase or module the user has not asked for.

```bash
cd biddesk
pip install -r requirements.txt
python -m pytest -q                              # all tests; no network or API key needed
python -m pytest -q -k civicplus                 # tests matching a name
python run_daily.py --no-ai                      # scrape only, spends nothing
python run_daily.py --weekly-report              # full run, queues the weekly report in the Outbox
streamlit run app.py                             # dashboard (needs DASHBOARD_PASSWORD in .env)
python tools/test_brief.py "FAITH" --url "https://www.grwyo.org/bids.aspx?bidID=208" [--dry]   # brief one closed bid
python tools/code_graph.py                       # regenerate graphify-out/ (code graph + report)
```

### Pipeline

`run_daily.py` runs these in order; `app.py` (Streamlit) reads the same SQLite file (`data/biddesk.db`, git-ignored).

1. `ingest.sync_sources` copies `config/sources.yaml` into the `sources` table (the YAML is the source of truth); `match.sync_clients` does the same for `config/clients/*.yaml`.
2. `ingest.run_source` imports `biddesk/sources/<parser>.py` by the `parser` name in the YAML and calls its `scrape(fetcher, source)`, which returns a `ScrapeResult` of `Opportunity` records (`models.py`).
3. `ingest.download_pending` fetches linked documents; `extract_pdf` stores text with `[[PAGE n]]` markers (these are what let the brief cite pages) and flags scans for the vision fallback.
4. `briefs.triage_new` (Haiku) tags trade and construction/not; `match.run_matching` scores each client/bid 0–100 with plain rules; `briefs.brief_top_matches` writes Fable briefs only for scores ≥ `match.BRIEF_THRESHOLD` (60), capped by `MAX_BRIEFS_PER_RUN`, and only when `ingest.docs_fingerprint` has changed.
5. `reports.queue_weekly` puts HTML reports in the `outbox` table; `reports.send_approved` sends one only after the Approve click in the dashboard.

### Rules that are easy to break

- **All HTTP goes through `biddesk/http.py` `Fetcher`**: robots.txt, ≥3 s per host (longer if `Crawl-delay` says so), conditional requests, cache. Never fetch a bid site with a bare client, and never work around a `Blocked` error. Known blocks: QuestCDN and SCSD#1's document host (`echalk-slate-prod.s3.amazonaws.com`) disallow all crawlers, so those documents are uploaded by hand.
- **Source health:** a parser returns `layout_ok=False` when it does not recognise the page and `explicit_empty=True` only when the page itself says nothing is posted. `run_source` turns "zero items after some, without an explicit empty" into a dashboard alert. Keep that distinction in every new parser.
- **Parser tests use saved live pages** in `tests/fixtures/`. `revize_populated_SYNTHETIC.html` is hand-made because both live Revize tables were empty; replace it when a real bid appears.
- **Claude calls live only in `biddesk/ai.py`**, through `call_json`: JSON-schema output (`transform_schema` of a pydantic model), validated, one retry, cost logged to `ai_usage`. Models: `claude-fable-5-2` for briefs (streamed via `client.beta.messages` with `fallbacks="default"`; system prompt = instructions + `config/wyoming_rules.md`, cached) and `claude-haiku-5-5` for triage. These calls have only ever run against a fake client in tests; they have not been exercised against the live API.
- **Email is gated twice:** nothing sends without Approve, and `send_approved` always addresses `REPORT_TO` (the operator), whatever `to_addr` is stored. Do not add a path that emails a client.
- **Client separation:** reports and briefs are keyed by `client_id`; a report must read only that client's matches.
- **Product guardrails (BUILD_SPEC §12):** never submit a bid or set a price; no logins, paywalls or CAPTCHAs; every requirement in a brief cites a page or says "unknown"; ask the user before adding a paid service or emailing anyone but them.
- Streamlit widgets need picklable options: pass `dict(row)`, not `sqlite3.Row`.

### Source status (checked 2026-11-14)

Scraped: City of Rock Springs and Sweetwater County Purchasing (`revize` parser), SCSD#1 Facilities (`scsd1_facilities`), City of Green River (`civicplus`, newest posting June 2025), SweetwaterNOW legal notices (`sweetwaternow`). Not scraped: WWCC and recent Green River bids are on Public Purchase (Phase 2 email parser), Sweetwater County road work is on QuestCDN (manual).
