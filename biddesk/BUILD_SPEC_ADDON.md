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
2. Haiku pre-filter:
