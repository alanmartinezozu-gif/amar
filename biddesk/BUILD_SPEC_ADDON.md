# BUILD SPEC ADD-ON — Find & Close Jobs for A. Pleasant Construction

> Put this file next to `BUILD_SPEC.md`. Only start it **after Phase 1 of BUILD_SPEC.md works.**
> Tell Claude Code: **"Read BUILD_SPEC_ADDON.md and build Module A. Same guardrails as BUILD_SPEC.md."**

---

## Who this is for (first client)

**A. Pleasant Construction, Inc.** — general contractor, Green River, WY (since 1982). ~5–9 employees. Owner/contact: Andy Pleasant (confirm).
Builds: commercial + industrial buildings, renovations/remodels, professional & retail space, restaurants, schools, churches, libraries, banks/credit unions, auto dealerships, shop / compressor / public works buildings, pre-engineered (metal) buildings. Has done public work (e.g., Rock Springs–Sweetwater County Airport GA terminal & hangar).

Create `config/clients/a_pleasant.yaml` (fields marked `# confirm` get filled after the call with Andy):

```yaml
name: "A. Pleasant Construction"
tier: "full"
contact_name: "Andy Pleasant"        # confirm
contact_email: ""                    # confirm
home_base: "Green River, WY"
max_travel_miles: 200                # confirm
counties: ["Sweetwater", "Sublette", "Uinta", "Lincoln", "Carbon", "Fremont"]   # confirm
trades: ["general_building", "remodel_interior", "steel_metal_building"]
building_types: ["school", "library", "church", "public_works_shop", "maintenance_shop",
                 "compressor_building", "bank", "dealership", "retail", "office", "restaurant",
                 "airport_building", "metal_building", "hangar"]
job_size_min: 50000                  # confirm
job_size_max: 5000000                # confirm
bonding_capacity_single: null        # confirm
wydot_prequalified: null             # confirm
wyoming_resident_certified: null     # confirm
subs:                                # Andy's usual subs — confirm
  - {trade: "electrical", company: "", contact: "", email: "", phone: ""}
  - {trade: "plumbing", company: "", contact: "", email: "", phone: ""}
  - {trade: "hvac_mechanical", company: "", contact: "", email: "", phone: ""}
  - {trade: "concrete", company: "", contact: "", email: "", phone: ""}
past_projects: []                    # for proposals + portfolio — collect from Andy
```

Update `match.py` so `building_types` is scored too (Fable/Haiku tags each opportunity with a building type).

---

## Module A — Early Warning: Agenda Scanner

**Goal:** spot projects weeks before the bid posts so Andy can talk to the owner/architect early.

**Sources (search for and confirm each official agendas/minutes page before scraping):**
- City of Rock Springs — City Council + Planning & Zoning agendas/minutes
- City of Green River — City Council + Planning agendas/minutes
- Sweetwater County — Board of County Commissioners agendas/minutes
- Sweetwater County School District #1 and #2 — Board of Trustees agendas
- Western Wyoming Community College — Board of Trustees agendas
- Rock Springs–Sweetwater County Airport Joint Powers Board agendas
- Memorial Hospital of Sweetwater County — board agendas
- Wyoming State Construction Dept "Upcoming and Current Projects" page
- Add Sublette/Uinta/Lincoln towns later as needed

**How it works:**
1. `sources/agendas/*.py` downloads new agenda/minutes PDFs weekly (respect robots.txt, rate limits, no logins).
2. Haiku pre-filter: does this agenda mention construction, design, architect, renovation, building, bid, RFP, RFQ, capital project, facility, remodel, shop, roof, HVAC?
3. Fable extracts project signals as JSON: owner, meeting, date, project, stage (idea|funding_approved|architect_hired|design|request_to_bid|bids_opened|awarded), est_value, architect_or_engineer, expected_bid_timing, building_type, quote_or_page, source_url.
4. Save to new table project_signals. Link a signal to an Opportunity later when the bid posts.
5. Weekly report gets a new section: "Coming soon — projects not bid yet" with a suggested action ("Call [architect] and ask to be added to the bidders list").

Done when: I run it and see real signals from recent Rock Springs/Sweetwater agendas, each with a page/quote reference.

## Module B — Sub Quote Requests
Goal: more and faster sub prices so Andy's number is sharper.
1. When Andy marks a bid "go", Fable reads the specs and builds a scope package per trade (electrical, plumbing, HVAC, concrete, etc.): spec sections, sheet numbers, key items, bid due date, Andy's sub-quote deadline (default 3 business days before bid due), addenda list.
2. Draft an email per sub (from subs: in the profile) with the scope summary + document link.
3. Drafts go to the Outbox for approval. Sent from Andy's own email: make copy-paste drafts or Gmail drafts. Never send as Andy without his written OK.
4. Track in table sub_quotes(opportunity_id, trade, company, requested_at, followed_up_at, received_at, amount, notes).
5. Auto-draft a follow-up if no quote after 2 business days.
6. Dashboard: per bid "sub coverage" view (which trades have 0, 1, 2+ quotes).
Done when: for one real bid I get correct per-trade scope summaries with spec references and ready drafts.

## Module C — Private Job Leads
Goal: fill gaps between public bids with private work (banks, dealerships, churches, retail, restaurants, compressor/shop buildings).
Sources (confirm each exists online; skip if not): commercial building permit lists for Rock Springs, Green River, Sweetwater County; Planning & Zoning items from Module A (site plans, rezoning, conditional use permits); local business news (SweetwaterNOW, Rocket Miner, Wyoming Business Report) with keywords like "new building", "plans to build", "expansion", "groundbreaking"; a manual entry form in the dashboard.
Table: private_leads(id, company, project, building_type, location, stage, est_value, contact_name, contact_role, source_url, found_at, status [new|contacted|meeting|proposal_sent|won|lost], next_action, next_action_date).
Fable writes a 2-line "why this fits Andy + who to call" note per lead. Monthly report section: "Private projects to go after."
Rules: public business info only. No home addresses, no scraping personal social media, no buying contact lists without asking me.
Done when: I see real private leads with sources and can move one through statuses.

## Module D — Proposal Generator (private jobs)
1. Dashboard form: client, project, scope notes (rough notes OK), price (entered by Andy — AI never sets the price), inclusions, exclusions, schedule, payment terms.
2. Fable writes a branded proposal: cover page, project understanding, scope, inclusions/exclusions, schedule, price, terms, 2–3 relevant past projects, signature block.
3. Export Word (.docx) and PDF. Logo + colors in config/clients/a_pleasant_brand/.
4. Labeled DRAFT until Andy approves.
Done when: rough notes + a price produce a proposal PDF that reads like a real contractor wrote it.

## Module E — Follow-Up & Pipeline
1. One pipeline view combining public bids (matches) + private leads: New → Pursuing → Bid/Proposal sent → Won / Lost.
2. Reminders in Andy's weekly email + dashboard: proposal sent 7 days ago with no answer → "Call [name]" + drafted follow-up; bid opened → pull results (BUILD_SPEC §8) and log win/loss + price gap; lost → log reason (price/schedule/relationship/unknown).
3. Optional later: sync to GoHighLevel via API — ask me first.
Done when: every open bid and proposal shows in one list with next action + date.

## Module F — Portfolio Page (optional upsell)
1. Collect 6–10 past projects from Andy: name, owner, year, size, type, 2–4 photos, 1–2 sentences.
2. Build a simple static "Projects" page + a 1-page PDF Statement of Qualifications (company info, years in business, project list, bonding, insurance, references).
3. Deploy to Netlify as a draft URL for Andy to review. Don't touch his live website without his OK.
Done when: I have a draft projects page URL + qualifications PDF.
