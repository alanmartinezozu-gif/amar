# Graph Report - amar  (2026-11-13)

## Corpus Check
- Corpus is ~35,298 words - fits in a single context window. You may not need a graph.

## Summary
- 644 nodes · 1700 edges · 31 communities (24 shown, 7 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 53 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Lead Intake and Call Jobs
- SQLite Repository Layer
- Calendar Booking and Slots
- AI Call Tools and Prompt
- OAuth and Integrations
- Admin Dashboard
- Live Call Session
- Test Harness and Flows
- TypeScript Config
- Website Lead Form
- Telephony Interface
- Dev Dependencies
- App Config and Bootstrap
- Package Metadata
- Test Relay Client
- Runtime Dependencies
- Relay WebSocket Server
- Durable Job Queue
- Database and Migrations
- Fake Telephony
- Twilio Telephony
- LLM Client Interface
- NPM Scripts
- Build TS Config
- Logger
- Test Clock
- graphify Agent Rules
- Express Type Augment
- A2P 10DLC
- AI Disclosure
- Opt-Out Handling

## God Nodes (most connected - your core abstractions)
1. `Repo` - 59 edges
2. `Contractor` - 32 edges
3. `CallSession` - 32 edges
4. `Deps` - 30 edges
5. `Lead` - 25 edges
6. `twilioRouter()` - 25 edges
7. `adminRouter()` - 22 edges
8. `ingestLead()` - 19 edges
9. `mapRow()` - 17 edges
10. `html()` - 17 edges

## Surprising Connections (you probably didn't know these)
- `Password-protected admin dashboard` --references--> `basicAuth()`  [INFERRED]
  README.md → src/admin/auth.ts
- `Password-protected admin dashboard` --references--> `dashboardPage()`  [INFERRED]
  README.md → src/admin/views.ts
- `Warm transfer (owner then manager, press 1)` --references--> `TransferTarget`  [INFERRED]
  README.md → src/domain/settings.ts
- `Merge repeat submissions (30 min)` --references--> `ingestLead()`  [INFERRED]
  README.md → src/leads/intake.ts
- `Outbound webhook events` --references--> `emitWebhook()`  [INFERRED]
  README.md → src/notify/notify.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Lead sources feeding intake** — readme_facebook_instagram_lead_ads, readme_google_ads_lead_form, readme_website_form, src_leads_intake [EXTRACTED 1.00]
- **Qualify, transfer or book flow** — readme_ai_appointment_assistant, readme_warm_transfer, readme_estimate_booking, readme_google_calendar [EXTRACTED 1.00]
- **Calling compliance controls** — readme_tcpa_consent, readme_ai_disclosure, readme_calling_hours, readme_opt_out, readme_a2p_10dlc [EXTRACTED 1.00]

## Communities (31 total, 7 thin omitted)

### Community 0 - "Lead Intake and Call Jobs"
Cohesion: 0.05
Nodes (79): Answering-machine detection, Merge repeat submissions (30 min), Outbound webhook events, Re-dial schedule (2, 20, 240 min), Voicemail drop on first miss, registerJobs(), LeadSource, TERMINAL_LEAD_STATUSES (+71 more)

### Community 1 - "SQLite Repository Layer"
Cohesion: 0.05
Nodes (31): ContractorPageData, Sqlite, ACTIVE_CALL_STATUSES, CALENDAR_COLUMNS, CALL_COLUMNS, ColumnMap, CONTRACTOR_COLUMNS, EVENT_COLUMNS (+23 more)

### Community 2 - "Calendar Booking and Slots"
Cohesion: 0.06
Nodes (36): Google Calendar booking, luxon, CalendarBackend, CalendarService, eventDescription(), noCalendarBackend, SlotTakenError, findOpenSlots() (+28 more)

### Community 3 - "AI Call Tools and Prompt"
Cohesion: 0.06
Nodes (43): Claude phone model (ANTHROPIC_MODEL), Server-side refusal fallback (ANTHROPIC_FALLBACKS), Transfer hours, Twilio ConversationRelay, @anthropic-ai/sdk, BookingMode, TransferTarget, CallDirection (+35 more)

### Community 4 - "OAuth and Integrations"
Cohesion: 0.09
Nodes (40): csrf(), issueCsrfToken(), readCookie(), setCsrfCookie(), fail(), finishFacebookSelection(), oauthRouter(), OAuthState (+32 more)

### Community 5 - "Admin Dashboard"
Cohesion: 0.13
Nodes (36): Password-protected admin dashboard, basicAuth(), adminRouter(), back(), Body, lines(), MANUAL_STATUSES, num() (+28 more)

### Community 6 - "Live Call Session"
Cohesion: 0.15
Nodes (6): TranscriptEntry, Logger, CallSession, estimateSpeechMs(), RelayOutput, speakable()

### Community 7 - "Test Harness and Flows"
Cohesion: 0.14
Nodes (15): Flow tests (scripted model + fake carrier), supertest, vitest, createApp(), assertAppendOnly(), createContractor(), createTestEnv(), ScriptedReply (+7 more)

### Community 8 - "TypeScript Config"
Cohesion: 0.11
Nodes (17): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, noImplicitOverride, noUncheckedIndexedAccess (+9 more)

### Community 9 - "Website Lead Form"
Cohesion: 0.23
Nodes (14): Facebook/Instagram lead ads, Google Ads lead form, Speed to Lead system, Website form (embed, webhook, hosted page), escapeHtml(), consentText(), cors(), embedScript() (+6 more)

### Community 10 - "Telephony Interface"
Cohesion: 0.19
Nodes (7): twilio@^6.2.0, twilio, Config, Deps, GraphFetch, Telephony, TestEnv

### Community 11 - "Dev Dependencies"
Cohesion: 0.13
Nodes (15): devDependencies, supertest@^7.3.1, tsx@^4.23.15, @types/express@^5.0.6, @types/luxon@^3.7.6, @types/node@^22.20.5, @types/supertest@^6.0.3, typescript@^5.9.3 (+7 more)

### Community 12 - "App Config and Bootstrap"
Cohesion: 0.15
Nodes (11): bool, EnvSchema, loadConfig(), optionalString, config, db, deps, jobs (+3 more)

### Community 13 - "Package Metadata"
Cohesion: 0.17
Nodes (11): description, @types/better-sqlite3@^7.6.13, @types/ws@^8.18.2, engines, node, name, private, type (+3 more)

### Community 15 - "Runtime Dependencies"
Cohesion: 0.18
Nodes (11): dependencies, @anthropic-ai/sdk@^0.135.0, dotenv@^18.0.8, express@^5.3.0, libphonenumber-js@^1.13.15, luxon@^3.7.2, zod@^4.6.7, dotenv (+3 more)

### Community 16 - "Relay WebSocket Server"
Cohesion: 0.24
Nodes (7): ws@^8.22.0, ws, relayUrl(), createRelayServer(), handleUpgrade(), RelayMessage, SessionOptions

### Community 17 - "Durable Job Queue"
Cohesion: 0.27
Nodes (3): Durable SQLite job queue, shutdown(), JobQueue

### Community 18 - "Database and Migrations"
Cohesion: 0.28
Nodes (5): better-sqlite3@^13.0.3, better-sqlite3, migrate(), openDatabase(), MIGRATIONS

### Community 19 - "Fake Telephony"
Cohesion: 0.28
Nodes (3): ConfigureNumberOptions, PlaceCallOptions, FakeTelephony

### Community 21 - "LLM Client Interface"
Cohesion: 0.29
Nodes (3): LlmClient, TurnRequest, ScriptedLlm

### Community 22 - "NPM Scripts"
Cohesion: 0.29
Nodes (7): scripts, build, dev, start, test, test:watch, typecheck

### Community 23 - "Build TS Config"
Cohesion: 0.29
Nodes (6): ./tsconfig.json, compilerOptions, outDir, rootDir, extends, include

### Community 24 - "Logger"
Cohesion: 0.40
Nodes (5): createLogger(), Level, ORDER, serializeError(), silentLogger

### Community 26 - "graphify Agent Rules"
Cohesion: 0.67
Nodes (3): /graphify skill trigger, graphify rules for Codex, graphify rules for Claude Code

## Knowledge Gaps
- **8 isolated node(s):** `./tsconfig.json`, `Transfer hours`, `Outbound webhook events`, `Virtual-assistant disclosure`, `STOP / do-not-call opt-out` (+3 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 186 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Repo` connect `SQLite Repository Layer` to `Lead Intake and Call Jobs`, `Calendar Booking and Slots`, `OAuth and Integrations`, `Live Call Session`, `Test Harness and Flows`, `Telephony Interface`, `App Config and Bootstrap`?**
  _High betweenness centrality (0.094) - this node is a cross-community bridge._
- **What connects `./tsconfig.json`, `Transfer hours`, `Outbound webhook events` to the rest of the system?**
  _8 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Lead Intake and Call Jobs` be split into smaller, more focused modules?**
  _Cohesion score 0.05490734385724091 - nodes in this community are weakly interconnected._
- **Why does `Deps` connect `Telephony Interface` to `Lead Intake and Call Jobs`, `SQLite Repository Layer`, `Calendar Booking and Slots`, `AI Call Tools and Prompt`, `OAuth and Integrations`, `Admin Dashboard`, `Live Call Session`, `Test Harness and Flows`, `Website Lead Form`, `App Config and Bootstrap`, `Relay WebSocket Server`, `Durable Job Queue`, `LLM Client Interface`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **Should `SQLite Repository Layer` be split into smaller, more focused modules?**
  _Cohesion score 0.052531645569620256 - nodes in this community are weakly interconnected._
- **Why does `Contractor` connect `SQLite Repository Layer` to `Lead Intake and Call Jobs`, `Calendar Booking and Slots`, `AI Call Tools and Prompt`, `Admin Dashboard`, `Website Lead Form`?**
  _High betweenness centrality (0.043) - this node is a cross-community bridge._
- **Should `Calendar Booking and Slots` be split into smaller, more focused modules?**
  _Cohesion score 0.06390977443609022 - nodes in this community are weakly interconnected._