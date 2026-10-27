# daily-leads

Builds a daily list of roofing and HVAC contractors to pitch your bilingual speed-to-lead service, then exports it for import into GoHighLevel.

**It only prepares the list.** It never calls, texts, emails or messages anyone. You contact every lead yourself.

## What a run does

| Step | What happens |
|---|---|
| 1. Source | Searches Google Maps through Outscraper for `<trade> in <city>` and keeps businesses with `min_reviews`–`max_reviews` Google reviews (a stand-in for owner-operated shops). Closed listings and listings without a US phone number are dropped. |
| 2. Dedupe | Skips any business already delivered on an earlier day, matched on phone, website domain or Google place ID (`leads_history.csv`). |
| 3. Enrich | Reads each website's homepage, about page and contact page. Sites with no website, or only a Facebook page, skip this step. |
| 4. Score | Scores each lead 0–10: +3 Spanish signal, +2 lead platforms, +2 emergency service, +2 contact form, +1 for 20–200 reviews. Keeps the top `leads_per_day`. |
| 5. Outreach | Claude writes a call note, a DM and a missed-call text for each lead. |
| 6. Export | Writes `output/ghl_import_YYYY-MM-DD.csv` and `output/summary_YYYY-MM-DD.md`, then adds the leads to `leads_history.csv`. |

### What gets detected, and how

Everything in step 3 comes from the business's own public pages:

- **Owner name** is only filled in when the site names someone as owner, founder, president or dueño. Examples: "John Smith, Owner", "Owner: John Smith", "founded by John Smith", "Hi, I'm Mike, owner of…", or a `founder` in the site's structured data. The first name must be a common first name, so "Owner Portal" or "Sugar Land – Owner" are never read as a person. When in doubt the field stays blank.
- **Spanish signal** is "yes" when the pages say "se habla español", "hablamos español" or "we speak Spanish", when a page is written in Spanish, or when the site links to its own Spanish version. A Google Translate widget doesn't count. Business names and surnames are never used.
- **Lead platforms**: mentions or badges of Angi, HomeAdvisor, Thumbtack or Google Guaranteed.
- **Emergency service**: "24/7", "24 hours a day", "emergency", "around the clock" or "emergencia".
- **Contact form**: a real form (message box, or two of name/email/phone) or an embedded form tool (HubSpot, JotForm, GoHighLevel, ServiceTitan…).
- **Email**: an address on the business's own domain, or a Gmail/Yahoo/etc. address the site lists. A web designer's address in the footer is ignored. Cloudflare-hidden addresses are decoded. If the site has none, Hunter's domain search is tried, but only for the leads that make the final list.

### Outreach rules

Claude (`claude-opus-5-5`) gets only the facts above. Every draft is checked in code before it's accepted:

- DM and missed-call text are under 50 words and contain no links.
- None of the three fields mentions AI, "IA", artificial intelligence, bots or a virtual assistant.
- The DM opens with a question.
- The texts are in Spanish (with "usted", never "tú") when the Spanish signal is yes, and in English otherwise.

A draft that breaks a rule is rewritten, up to 3 tries. If it still fails, those fields stay blank and the summary lists the lead. Set `sender_name` in `config.yaml` to sign missed-call texts with your first name.

## Setup (once)

Needs Python 3.10 or newer.

```bash
cd daily-leads
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then paste your three API keys into .env
```

`.env` holds `OUTSCRAPER_API_KEY`, `ANTHROPIC_API_KEY` and `HUNTER_API_KEY`. Hunter is optional; without it, emails come from websites only. Keys are only read from `.env`, and `.env` is git-ignored.

Edit `config.yaml` for trades, cities, `leads_per_day`, the review range and `sender_name`.

## First run: 1 trade, 1 city, 10 leads

```bash
.venv/bin/python -m daily_leads --trade roofing --city "Houston, TX" --limit 10
```

It prints where the CSV is and shows 3 sample DMs. If there's a Spanish lead, at least one of the samples is Spanish. Open `output/ghl_import_<today>.csv` and check it before the full run.

Add `--no-history` to try settings without marking leads as delivered.

## Every morning

```bash
cd ~/daily-leads && .venv/bin/python -m daily_leads
```

(Windows: `cd %USERPROFILE%\daily-leads && .venv\Scripts\python -m daily_leads`)

To run it automatically at 7:40 on weekdays (macOS/Linux, `crontab -e`):

```
40 7 * * 1-5 cd ~/daily-leads && .venv/bin/python -m daily_leads >> logs/cron.log 2>&1
```

Running it again on the same day rebuilds the same list from cache. It doesn't skip the leads it just delivered, and it doesn't pay again.

## Importing into GoHighLevel

Contacts → Import → upload `ghl_import_YYYY-MM-DD.csv`. First Name, Last Name, Phone, Email, Company Name, Website, Address, City, State, Postal Code and Tags map to standard fields. Map Lead Score, Spanish Signal, Lead Platforms, Call Note, DM Text, Missed Call Text and Google Maps URL to custom fields. You can create them during your first import.

Tags are `prospect`, the trade, the city you searched (so a Katy roofer found by the Houston search is tagged `houston`) and `spanish` when the Spanish signal is yes.

## Files

| Path | What it is |
|---|---|
| `config.yaml` | Your settings |
| `.env` | API keys (never commit) |
| `leads_history.csv` | Every business delivered, by date. **Back this up.** It is what keeps a business from showing up twice. |
| `output/` | Daily CSV and summary |
| `logs/` | One log per day, with per-lead details and any skipped sites |
| `.cache/` | Saved Outscraper, Hunter, Claude and page responses so reruns don't re-bill |

## Costs and limits

- **Outscraper** bills per place returned. Each search fetches `sourcing.page_size` (40) places per page. The first day costs about 8 searches × 40 places. Later days reread cached pages for free and only buy the next page down. Cached pages expire after 30 days (`cache.outscraper_days`).
- **Hunter**: at most one domain search per final lead that has no email on its site, cached for 60 days.
- **Claude**: one request per final lead (more if a draft has to be rewritten), cached for 30 days. `claude.effort: low` in `config.yaml` costs less.
- **Websites**: robots.txt is obeyed, including Crawl-delay. If robots.txt can't be reached, the site is skipped. Each site gets at most 3 pages at least 1.5 s apart. Pages are cached for 14 days, failed sites for 1 day.

When a search runs out of Google Maps results, the summary says so. Add nearby cities (Katy, Sugar Land, Mesa…) to `config.yaml` to keep the list fresh.

A problem with one website, one search or one lead's copy is logged and skipped. The run only stops when a key is rejected, Outscraper is out of credit, or there are no new businesses left to find.

## Tests

```bash
.venv/bin/python -m pytest
```

The tests run offline with fake versions of Outscraper, Hunter, Claude and the websites.
