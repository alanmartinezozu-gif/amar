# BUILD SPEC — "Bid Desk" (Wyoming Public Bid Service, starting in Rock Springs)

> Paste this whole file into your Claude Code project folder as `BUILD_SPEC.md`.
> Then start Claude Code and say: **"Read BUILD_SPEC.md and build Phase 1. Ask me before anything that costs money or needs a login."**

---

## 0. What we're building (plain English)

I (Alan) run a **done-for-you bid service** for construction contractors in Wyoming, starting in Rock Springs / Sweetwater County.
Every week my tool:

1. **Finds** every public construction bid in their area (city, county, school district, college, state, WYDOT).
2. **Reads** each bid package with Claude Fable 5.2 and writes a 1-page brief: scope, size, deadline, requirements, red flags, go/no-go.
3. **Builds a requirements checklist** for the bids they pick (bonds, prequal, forms, pre-bid meetings, addenda).
4. **Watches for addenda** (changes) so they never miss one.
5. **Tracks bid results** (who bid, how much, who won) and builds **competitor price intel**.
6. **Sends a weekly email report** per client + a monthly results report.

The contractor does the pricing and signs/submits. **The tool never submits a bid.**

Pricing tiers this must support: Bid Finder ($1K), Bid Department ($2K), Full Bid Desk with price intel ($3K).

---

## 1. Tech stack (keep it simple — I'm not a full-time developer)

- **Language:** Python 3.11+
- **Database:** SQLite (one file, `biddesk.db`)
- **Dashboard:** Streamlit (simple local web app for me to review + approve)
- **AI:** Anthropic Python SDK
  - `claude-fable-5-2` → deep reading of bid packages, briefs, checklists, bid-tab analysis
  - `claude-haiku-5-5` → cheap first-pass triage ("is this even construction?") to save money
- **PDF text:** `pypdf` + `pdfplumber` (tables). If a PDF is a scan, fall back to sending page images to Fable (vision).
- **Scraping:** `httpx` + `beautifulsoup4`. Use `playwright` only if a page needs JavaScript.
- **Email out:** SMTP (Gmail app password) or Resend — ask me which.
- **Email in:** IMAP reader for a dedicated inbox (see §3 Public Purchase).
- **Scheduling:** a `run_daily.py` script I can run with cron, or GitHub Actions on a schedule.
- **Secrets:** `.env` file (`ANTHROPIC_API_KEY`, email creds). Never commit `.env`. Add `.gitignore`.

Folder layout:
```
biddesk/
  BUILD_SPEC.md
  .env.example
  config/
    sources.yaml        # every bid source (see §3)
    clients/            # one YAML per client (see §6)
    wyoming_rules.md    # knowledge base for the AI (see §2)
  biddesk/
    db.py
    sources/            # one scraper module per source
    ingest.py           # download docs, extract text, hash for change detection
    ai.py               # all Claude calls + prompt templates
    match.py            # match bids to client profiles
    briefs.py           # write go/no-go briefs + checklists
    addenda.py          # detect new/changed documents
    bidtabs.py          # parse bid results/tabulations
    intel.py            # competitor + price analysis
    prospects.py        # build sales lead list from bid results
    reports.py          # weekly + monthly email reports
  app.py                # Streamlit dashboard
  run_daily.py
  tests/
```

---

## 2. Wyoming bidding knowledge (put this in `config/wyoming_rules.md` and include it in AI prompts)

These are facts I researched. The AI should use them to flag requirements, but **always defer to the actual bid document** and quote the page/section.

**Resident preference**
- W.S. 16-6-102: if bids are advertised, the contract goes to the lowest responsible *certified Wyoming resident* bidder if their bid is not more than **5% higher** than the lowest responsible nonresident bidder. → Flag whether the client has a resident certification (issued through WY Dept. of Workforce Services, Labor Standards).
- W.S. 16-6-104 / 16-6-105 / 16-6-107: preference for Wyoming materials. Some bids say these preferences apply; some say they DO NOT. → Extract which.

**Bid security / bonds (varies by owner — always extract from the doc)**
- City of Rock Springs: typically a certified check, cashier's check or bid bond of **5%** of the bid (W.S. 15-1-113 cited).
- Sweetwater County: seen at **5%** and **10%**, payable to Sweetwater County Clerk.
- Sweetwater County School District #1: seen at **10%** if the bid is over $7,499.
- Bids usually can't be withdrawn for **30 days** (sometimes 40) after opening.
- Performance/payment bonds per W.S. 16-6-112 on awarded contracts.

**Prequalification**
- WYDOT road/bridge work: prime contractors must be **prequalified through WYDOT's iCX system**; non-prequalified bids are not read. Primes must **self-perform at least 30%** of the work. Prequal needs reviewed/compiled or audited financials; negative net worth can't be prequalified.
- Some **Sweetwater County and City of Green River** road projects require the general contractor to be on **WYDOT's Prequalified Contractors List** even though WYDOT isn't the owner. → Always check.
- City of Rock Springs sometimes runs a separate **Statement of Prequalification** step before releasing bid packages (e.g., large facility projects). → Flag "prequal deadline" separately from "bid deadline."

**How local bids actually happen**
- City of Rock Springs: sealed bids filed with the **City Clerk at City Hall**, opened by **City Council at its 7:00 pm meeting**. Envelope must be marked with project name + contractor name/address. Questions go to the ENGINEER; questions < 10 days before opening may not be answered.
- Sweetwater County: sealed bids to the Board of County Commissioners; awarded at a regular commission meeting.
- SCSD#1: sealed bids, often paper only ("electronic proposals will not be accepted"); bid questions + answers posted on the district's bids pages.
- WWCC: sealed bids to the Board of Trustees at 2500 College Drive; often a pre-bid/bidders conference; questions < 7 days before opening can't be answered.
- Addenda on Public Purchase are posted **only on the platform**; bidders are responsible for monitoring — no direct notifications.

**Notice rules (useful for finding bids)**
- Public works bids are advertised as **legal notices in the local newspaper**, usually twice ~7 days apart. In Rock Springs that's the **Rock Springs Rocket Miner** (legals@rocketminer.com); SCSD#1 also uses the Casper Star-Tribune.

---

## 3. Bid sources (`config/sources.yaml`)

Build one scraper module per source. Each returns a list of `Opportunity` records (see §4). For each source store: `name, owner_type (city/county/school/college/state/wydot/federal), url, method (scrape | email | manual | rss), county, notes`.

### 3A. Rock Springs / Sweetwater County (PHASE 1 — build these first)

> Only the full URLs below were verified. Domains like rswy.net, cityofgreenriver.org and wwcc.wy.edu are best guesses — **search for and confirm each official bids page before writing its scraper.**

| Source | Where | Method |
|---|---|---|
| City of Rock Springs — Open Bids page | rswy.net (find the "Open Bids" / Bids & RFPs page) | scrape daily |
| City of Rock Springs — City Council agendas & minutes | rswy.net (agenda center) | scrape weekly → catches "request to bid" items early AND bid openings/results |
| Sweetwater County — bids/RFPs | sweetwatercountywy.gov (Public Works + Commissioners bid notices) | scrape daily |
| Sweetwater County School District #1 — Facilities bids | https://sweetwater-county-school-district-1.echalksites.com/groups/4804/facilities/current_and_upcoming_project_bids | scrape daily |
| SCSD#1 — other bid pages (tech, transportation, CIA) | sweetwater1.org groups pages | scrape weekly (mostly non-construction; triage with Haiku) |
| Sweetwater County School District #2 (Green River) | district website bids page | scrape daily |
| Western Wyoming Community College | wwcc.wy.edu (purchasing/bids) + Public Purchase | scrape daily + email |
| City of Green River | cityofgreenriver.org (bids) | scrape daily |
| Memorial Hospital of Sweetwater County | hospital website (bids/RFPs) | scrape weekly |
| Rock Springs–Sweetwater County Airport | airport website (bids) | scrape weekly |
| Joint Powers Water Board / other special districts | their websites | scrape weekly |
| SweetwaterNOW legal notices + news | sweetwaternow.com (search "invitation to bid", "bids", "council opens bids") | scrape daily → also gives **bid results with bidder names + amounts** |
| Rock Springs Rocket Miner legal notices | rocketminer.com legals | scrape daily (respect paywall — headlines/notices only) |

### 3B. Statewide (PHASE 2)

| Source | Where | Method |
|---|---|---|
| WYDOT highway/bridge lettings | dot.state.wy.us → Business with WYDOT → Contractors → Bid Information (advertised projects, letting schedule) | scrape |
| **WYDOT Bid Tabulations** | https://dot.state.wy.us/home/business_with_wydot/purchasing/bid_results.html + Contractors → Bid Letting Results / Bid Tabulations | download all → `bidtabs.py` |
| WYDOT Prequalified Contractors List | https://dot.state.wy.us/home/business_with_wydot/pre_qualification.html | download → prospect list + prequal checks |
| WY State Construction Dept (Game & Fish, Corrections, State Parks, schools, etc.) | https://stateconstruction.wyo.gov/procurement/bid-listings (Public Purchase) | email alerts (see below) |
| WY School Facilities Division projects | linked from stateconstruction.wyo.gov | scrape |
| WY A&I Procurement (non-construction state purchasing) | ai.wyo.gov (Public Purchase) | email alerts |
| WYDOT Procurement Services (non-highway: rest areas, janitorial, buildings) | Public Purchase | email alerts |
| University of Wyoming | https://www.uwyo.edu/uwops/news/ (also Public Purchase) | scrape |
| Other cities/counties statewide | add one by one as clients need them | scrape |

### 3C. Federal (PHASE 3, optional)
- SAM.gov (BLM, Forest Service, Army Corps work in Wyoming). Use the official SAM.gov public API (needs a free API key — ask me). Filter by place of performance = WY and construction NAICS (236, 237, 238).

### Public Purchase (important — don't scrape behind a login)
Many Wyoming agencies post on **publicpurchase.com**, which needs a free vendor login. **Do not automate logins or scrape behind it.** Instead:
1. I'll register a dedicated vendor account per client (or with client permission) and pick the right NIGP commodity codes so Public Purchase **emails bid notifications**.
2. Forward those notifications to a dedicated inbox (e.g. bids@getnuxu.com).
3. `sources/public_purchase_email.py` reads that inbox via IMAP, parses each notification (agency, bid #, title, due date, link) into an Opportunity.
4. I (or the client) download the documents manually and drop them in a folder / upload in the dashboard → the AI reads them.

### Paid aggregators
ConstructConnect, Dodge, GovWin, BidNet, etc. have this data but are paid and have terms of use. **Do not scrape them.** If a client already subscribes, I can manually upload docs they download.

### Scraping rules (build into a shared `http.py`)
- Respect robots.txt. Identify with a real User-Agent including my contact email.
- Max 1 request every 3 seconds per domain. Cache pages; only re-download if changed (ETag/Last-Modified or content hash).
- Never bypass logins, paywalls, or CAPTCHAs.
- If a site's structure changes and the parser finds 0 items where it used to find some, raise an alert in the dashboard instead of silently failing.

---

## 4. Database tables (`db.py`)

- `sources(id, name, owner_type, url, method, county, active, last_checked, last_item_count)`
- `opportunities(id, source_id, owner_name, title, bid_number, url, county, city, posted_date, due_datetime, prebid_datetime, prebid_mandatory, est_value, status [open|closed|awarded|cancelled], raw_text, created_at, updated_at)`
- `documents(id, opportunity_id, filename, url_or_path, sha256, page_count, text, doc_type [notice|spec|plans|addendum|bidform|qa], first_seen, last_seen)`
- `analyses(id, opportunity_id, model, brief_json, checklist_json, created_at, cost_usd)`
- `clients(id, name, tier, profile_yaml_path, email, active)`
- `matches(id, client_id, opportunity_id, score, reason, decision [pending|go|no_go|bidding|submitted], notes)`
- `addenda_alerts(id, opportunity_id, document_id, summary, sent_to_clients, created_at)`
- `bid_results(id, opportunity_id or external_ref, owner_name, project_name, letting_date, bidder_name, bidder_city, total_bid, rank, is_winner, source_url)`
- `bid_items(id, bid_result_id, item_no, description, unit, quantity, unit_price, extended)` — from WYDOT tabulations
- `companies(id, name, normalized_name, city, state, wydot_prequalified, prequal_classes, phone, website, is_client, is_prospect)`
- `ai_usage(id, ts, model, input_tokens, output_tokens, cost_usd, purpose)`

---

## 5. AI tasks (`ai.py`) — prompts + JSON outputs

All AI calls:
- Return **strict JSON** matching a schema (validate with `pydantic`; retry once on bad JSON).
- Must **cite page numbers / section numbers** for every requirement and red flag.
- Must say `"unknown"` instead of guessing. Never invent dates, amounts or requirements.
- Log tokens + cost to `ai_usage`. Show monthly AI spend per client in the dashboard.
- Use prompt caching for the big static part (wyoming_rules.md + instructions).

### 5.1 Triage (Haiku — cheap)
Input: title + notice text. Output: `{is_construction: bool, trade_tags: [...], est_value_if_stated, confidence}`.
Trade tags list: `asphalt_paving, concrete, earthwork_excavation, utilities_water_sewer, roofing, hvac_mechanical, plumbing, electrical, general_building, remodel_interior, painting, flooring, demolition, fencing, landscaping_grounds, snow_removal, steel_metal_building, playground_sports_surfaces, glazing, low_voltage_data, janitorial, other`.

### 5.2 Bid Brief (Fable) — the main product
Input: all document text for an opportunity + client profile + wyoming_rules.md.
Output JSON:
```json
{
  "project_name": "", "owner": "", "location": "",
  "scope_summary": "3-5 plain-English sentences",
  "trades_involved": [],
  "estimated_value": {"amount": null, "source": "stated|engineer_estimate|unknown", "page": null},
  "key_dates": {"posted": "", "questions_due": "", "prebid_meeting": "", "prebid_mandatory": true, "prequal_due": "", "bid_due": "", "bid_opening": "", "completion_date": ""},
  "submission": {"method": "sealed_paper|public_purchase_upload|wydot_icx|email|other", "deliver_to": "", "envelope_marking": "", "copies": null},
  "requirements": [{"item": "5% bid bond", "detail": "", "page": ""}],
  "prequalification": {"required": true, "type": "WYDOT list|owner prequal packet|none|unknown", "detail": "", "page": ""},
  "resident_preference_applies": "yes|no|unknown",
  "wyoming_materials_preference_applies": "yes|no|unknown",
  "liquidated_damages": {"amount_per_day": null, "page": ""},
  "red_flags": [{"flag": "", "why_it_matters": "", "page": ""}],
  "questions_to_ask_owner": [],
  "fit_for_client": {"score_0_100": 0, "go_no_go": "go|maybe|no_go", "reasons": []},
  "addenda_count": 0
}
```

### 5.3 Requirements Checklist (Fable)
For bids the client marks "go". A numbered checklist of **every** form, signature, bond, insurance certificate, license, acknowledgment of addenda, residency certificate, bid schedule/unit price form, and deadline — each with page reference and a checkbox. Export as PDF + show in dashboard.

### 5.4 Addendum Summary (Fable)
When `addenda.py` finds a new or changed document: compare old vs new, output `{what_changed: [...], affects_price: bool, affects_schedule: bool, new_deadline: null, must_acknowledge: true, page_refs: [...]}` and email affected clients the same day.

### 5.5 Bid-Tab Analysis (Fable)
Input: parsed `bid_results` + `bid_items` for a work type/region. Output: who bids what, typical winning margin vs 2nd place, unit price ranges per item (low/median/high), and for a specific client: jobs they lost and by how much.

### 5.6 Drafting help (Fable)
Draft the written parts (cover letter, qualifications/experience statement, project approach) from the client profile. Always labeled DRAFT for the client to review.

---

## 6. Client profile (`config/clients/<name>.yaml`)

```yaml
name: "APLeasant"            # example
tier: "full"                 # finder | department | full
contact_email: ""
home_base: "Rock Springs, WY"
max_travel_miles: 150
counties: ["Sweetwater", "Sublette", "Uinta", "Lincoln", "Carbon"]
trades: ["concrete", "earthwork_excavation", "general_building"]
job_size_min: 25000
job_size_max: 2000000
bonding_capacity_single: null
bonding_capacity_aggregate: null
wydot_prequalified: false
wydot_prequal_classes: []
wyoming_resident_certified: null   # yes/no/unknown
licenses: []
insurance: {general_liability: null, auto: null, workers_comp: true}
past_projects: []                  # for drafting qualifications
competitors_to_watch: []
notes: ""
```

Build a simple **onboarding form** in the dashboard that fills this YAML.

---

## 7. Matching (`match.py`)

Score each open opportunity for each client (0–100): trade match, inside counties/travel radius, size within range, prequal/bonding OK, enough time before due date. Haiku triage + rules first; only send top matches to Fable for a full brief (cost control). Anything ≥ 60 goes in the weekly report.

---

## 8. Bid results + competitor intel (`bidtabs.py`, `intel.py`)

1. Download every WYDOT bid tabulation (PDF/XLS) by month. Parse into `bid_results` + `bid_items`. Normalize company names ("Kilgore Companies dba Lewis & Lewis" = one company).
2. Parse local results from City Council minutes and SweetwaterNOW articles ("X bids were received… lowest bid by…"). Use Fable to extract `{project, bidder, amount, rank}` with the source URL.
3. Intel outputs per client:
   - Competitors who bid against them most + their win rate
   - Unit-price ranges for their common items
   - "You lost [project] by $X (Y%) — the gap was mostly in items A, B, C"
4. Never present intel as guaranteed future pricing — label as historical public data.

---

## 9. Prospect list (`prospects.py`) — this is my sales pipeline

From `bid_results` + WYDOT prequalified list, build a table of every company that bids in Sweetwater + nearby counties: name, city, # bids last 24 months, # wins, win rate, avg bid size, trades, closest losses (project, $ gap). Export CSV. Sort by "bids often, wins rarely" = hottest leads.

For each prospect, generate a 1-page **"free loss report"** (their last 3 close losses + 3 open bids that fit them) I can bring to a sales call.

---

## 10. Reports (`reports.py`)

- **Weekly (every Monday 7am MT) per client:** new matching bids (brief summary + link), upcoming deadlines this week + next, mandatory pre-bid meetings, new addenda, status of bids they're pursuing. Clean HTML email + PDF.
- **Same-day alerts:** new addendum on a bid they're pursuing; a mandatory pre-bid meeting within 5 days; a deadline within 48 hours.
- **Monthly (full tier):** bids found, bids pursued, submitted, won, total $ won, price-gap analysis on losses, competitor activity.
- Every report ends with: "Prices and submission are your responsibility. Always verify against the official bid documents."

All outgoing emails go to a **review queue in the dashboard first** — I click Approve before anything sends (for the first 30 days; then make auto-send a per-client toggle).

---

## 11. Dashboard (`app.py`, Streamlit)

Pages: **Inbox** (new opportunities) · **Opportunity detail** (docs, brief, checklist, addenda history) · **Clients** (profiles, onboarding form) · **Matches** (per client, set go/no-go) · **Results & Intel** · **Prospects** · **Outbox** (approve emails) · **Sources health** (last run, item counts, errors) · **AI cost**.

Must work on my laptop at `localhost`. Simple password via `.env`.

---

## 12. Guardrails (non-negotiable)

- Never submit, sign or upload a bid for anyone. Never enter prices for a client.
- Never log into sites with credentials to scrape. Never bypass paywalls/CAPTCHAs. Respect robots.txt and rate limits.
- Every AI claim about a requirement must include a page/section reference, or be marked "unknown — verify."
- If a document can't be read (bad scan), say so in the brief. Don't guess.
- Keep client data separate; one client's profile/intel never appears in another client's report.
- Ask me before: adding any paid API, signing up for any service, or sending any email to a real client.

---

## 13. Build phases + "done" tests

**Phase 1 — Rock Springs MVP (build first)**
- [ ] Project skeleton, `.env.example`, SQLite schema, Streamlit shell
- [ ] Scrapers: City of Rock Springs open bids, SCSD#1 facilities, Sweetwater County, WWCC, City of Green River, SweetwaterNOW legal notices
- [ ] Manual upload: drag a bid PDF into the dashboard → creates an Opportunity
- [ ] Doc ingest + text extraction + hashing
- [ ] Haiku triage + Fable Bid Brief (§5.2)
- [ ] One client profile (APLeasant) + matching
- [ ] Weekly report email (to me only, through the Outbox approval)
- **Done when:** I run `python run_daily.py`, open the dashboard, and see real current Rock Springs-area bids with Fable briefs, and I get a test weekly report in my inbox.

**Phase 2 — Bid prep + addenda + statewide**
- [ ] Requirements Checklist (§5.3) + PDF export
- [ ] Addenda detection + same-day alerts (§5.4)
- [ ] Public Purchase email-notification parser
- [ ] WYDOT advertised projects + State Construction Dept + UW
- **Done when:** I upload v1 and v2 of a bid doc and get a correct "what changed" alert.

**Phase 3 — Price intel + prospects**
- [ ] WYDOT bid tabulations downloader + parser (§8)
- [ ] Local results extraction from council minutes / SweetwaterNOW
- [ ] Competitor + loss analysis; prospect list CSV + "free loss report" PDF (§9)
- **Done when:** I can type a company name and get their bid history, win rate, and closest losses.

**Phase 4 — Polish**
- [ ] Monthly report, per-client auto-send toggle, AI cost per client, source-health alerts, SAM.gov (optional)

Write tests for every parser using saved sample HTML/PDF files in `tests/fixtures/`. Commit after each working step with a clear message.

---

## 14. First message to send Claude Code

```
Read BUILD_SPEC.md fully. Then:
1. Summarize the plan back to me in 10 bullets.
2. Build Phase 1 step by step. Before writing each scraper, fetch the live page, show me what you found, and confirm the right URL with me.
3. Use claude-fable-5-2 for briefs and claude-haiku-5-5 for triage. Read my API key from .env.
4. Stop and ask me before signing up for anything, spending money, or emailing anyone other than me.
5. When Phase 1 works, show me how to run it and open the dashboard.
```
