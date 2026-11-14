# Bid Desk

Finds public construction bids around Rock Springs / Sweetwater County, reads the bid
packages with Claude, matches them to client profiles and builds a weekly report.
The tool never submits a bid and never enters prices.

This is **Phase 1** of the build spec. It lives in its own folder and is separate from the
speed-to-lead app at the top of this repository.

## Set up (once)

```bash
cd biddesk
```

```bash
python3 -m venv .venv && source .venv/bin/activate
```

```bash
pip install -r requirements.txt
```

```bash
cp .env.example .env
```

Then open `.env` and fill in `ANTHROPIC_API_KEY`, `CONTACT_EMAIL`, `DASHBOARD_PASSWORD`,
and the SMTP lines plus `REPORT_TO` (your own address) if you want the report emailed.

## Run it

```bash
python run_daily.py
```

Checks every source, downloads bid documents, triages with Haiku, scores matches and
writes Fable briefs for matches scoring 60 or more. Add `--weekly-report` to queue the
weekly report, `--no-ai` to scrape without spending anything, `--all` to include weekly
sources.

```bash
streamlit run app.py
```

Opens the dashboard at http://localhost:8501.

```bash
python -m pytest -q
```

Runs the parser and pipeline tests (no network, no API key needed).

## How it fits together

| File | Job |
|---|---|
| `config/sources.yaml` | Every bid source and how it is read |
| `config/clients/*.yaml` | One profile per client (edit in the dashboard) |
| `config/wyoming_rules.md` | Wyoming bidding notes included in the brief prompt |
| `biddesk/http.py` | Polite fetching: robots.txt, 3 seconds per site, caching |
| `biddesk/sources/` | One parser per site layout |
| `biddesk/ingest.py` | Stores bids, downloads documents, extracts text with page markers |
| `biddesk/ai.py` | Haiku triage and the Fable bid brief, with cost logging |
| `biddesk/match.py` | 0-100 score per client and bid |
| `biddesk/reports.py` | Weekly report into the Outbox; sends only after Approve |
| `app.py` | Dashboard |

## Safety rules built in

- Scrapers obey robots.txt, wait at least 3 seconds per site, and never log in.
- A source that used to return bids and now returns none raises an alert on
  **Sources health** instead of failing quietly.
- Emails wait in the **Outbox** until approved, and in Phase 1 they go only to `REPORT_TO`.
- A weekly report reads only that client's matches and briefs.
- Briefs must cite a page or say "unknown".

## Costs

Claude calls cost money. Triage is fractions of a cent per notice. A Fable brief on a
large bid package can cost a few dollars. `MAX_BRIEFS_PER_RUN` caps briefs per run and the
**AI cost** page shows spend by month and client.
