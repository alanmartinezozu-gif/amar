import type { Sqlite } from "./database.js";
import { parseSettings, type ContractorSettings } from "../domain/settings.js";
import type {
  CalendarConnection,
  Call,
  Contractor,
  FacebookPage,
  Job,
  Lead,
  LeadEvent,
  LeadStatus,
} from "../domain/types.js";
import { randomId, randomSecret } from "../lib/crypto.js";

type Kind = "text" | "int" | "json" | "bool";
type ColumnMap<T> = Partial<Record<keyof T, [column: string, kind: Kind]>>;

type Row = Record<string, unknown>;

function toDb(kind: Kind, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  switch (kind) {
    case "json":
      return JSON.stringify(value);
    case "bool":
      return value ? 1 : 0;
    default:
      return value;
  }
}

function fromDb(kind: Kind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case "json":
      return JSON.parse(String(value));
    case "bool":
      return Boolean(value);
    default:
      return value;
  }
}

function mapRow<T>(row: Row | undefined, columns: ColumnMap<T>): T | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(columns) as Array<[string, [string, Kind]]>) {
    out[field] = fromDb(spec[1], row[spec[0]]);
  }
  return out as T;
}

const CONTRACTOR_COLUMNS: ColumnMap<Contractor> = {
  id: ["id", "text"],
  name: ["name", "text"],
  timezone: ["timezone", "text"],
  twilioNumber: ["twilio_number", "text"],
  publicKey: ["public_key", "text"],
  googleAdsKey: ["google_ads_key", "text"],
  settings: ["settings", "json"],
  active: ["active", "bool"],
  createdAt: ["created_at", "text"],
  updatedAt: ["updated_at", "text"],
};

const LEAD_COLUMNS: ColumnMap<Lead> = {
  id: ["id", "text"],
  contractorId: ["contractor_id", "text"],
  source: ["source", "text"],
  externalId: ["external_id", "text"],
  name: ["name", "text"],
  email: ["email", "text"],
  phone: ["phone", "text"],
  phoneRaw: ["phone_raw", "text"],
  address: ["address", "text"],
  zip: ["zip", "text"],
  formAnswers: ["form_answers", "json"],
  details: ["details", "json"],
  summary: ["summary", "text"],
  status: ["status", "text"],
  callAttempts: ["call_attempts", "int"],
  appointmentStart: ["appointment_start", "text"],
  appointmentEnd: ["appointment_end", "text"],
  appointmentEventId: ["appointment_event_id", "text"],
  metadata: ["metadata", "json"],
  createdAt: ["created_at", "text"],
  updatedAt: ["updated_at", "text"],
};

const CALL_COLUMNS: ColumnMap<Call> = {
  id: ["id", "text"],
  leadId: ["lead_id", "text"],
  contractorId: ["contractor_id", "text"],
  direction: ["direction", "text"],
  attempt: ["attempt", "int"],
  reason: ["reason", "text"],
  twilioCallSid: ["twilio_call_sid", "text"],
  status: ["status", "text"],
  answeredBy: ["answered_by", "text"],
  phase: ["phase", "text"],
  outcome: ["outcome", "text"],
  transferIndex: ["transfer_index", "int"],
  transferAcceptedBy: ["transfer_accepted_by", "text"],
  conversation: ["conversation", "json"],
  pendingToolResults: ["pending_tool_results", "json"],
  transcript: ["transcript", "json"],
  startedAt: ["started_at", "text"],
  answeredAt: ["answered_at", "text"],
  endedAt: ["ended_at", "text"],
  durationSeconds: ["duration_seconds", "int"],
  postProcessedAt: ["post_processed_at", "text"],
  createdAt: ["created_at", "text"],
  updatedAt: ["updated_at", "text"],
};

const PAGE_COLUMNS: ColumnMap<FacebookPage> = {
  pageId: ["page_id", "text"],
  contractorId: ["contractor_id", "text"],
  pageName: ["page_name", "text"],
  accessToken: ["access_token", "text"],
  createdAt: ["created_at", "text"],
};

const CALENDAR_COLUMNS: ColumnMap<CalendarConnection> = {
  contractorId: ["contractor_id", "text"],
  provider: ["provider", "text"],
  accountEmail: ["account_email", "text"],
  refreshToken: ["refresh_token", "text"],
  accessToken: ["access_token", "text"],
  accessTokenExpiresAt: ["access_token_expires_at", "text"],
  createdAt: ["created_at", "text"],
  updatedAt: ["updated_at", "text"],
};

const JOB_COLUMNS: ColumnMap<Job> = {
  id: ["id", "int"],
  type: ["type", "text"],
  payload: ["payload", "json"],
  runAt: ["run_at", "text"],
  status: ["status", "text"],
  attempts: ["attempts", "int"],
  lastError: ["last_error", "text"],
  dedupeKey: ["dedupe_key", "text"],
  createdAt: ["created_at", "text"],
  updatedAt: ["updated_at", "text"],
};

const EVENT_COLUMNS: ColumnMap<LeadEvent> = {
  id: ["id", "int"],
  contractorId: ["contractor_id", "text"],
  leadId: ["lead_id", "text"],
  callId: ["call_id", "text"],
  type: ["type", "text"],
  message: ["message", "text"],
  data: ["data", "json"],
  createdAt: ["created_at", "text"],
};

export type NewContractor = {
  name: string;
  timezone?: string;
  twilioNumber?: string | null;
  settings?: Partial<ContractorSettings> | Record<string, unknown>;
};

export type NewLead = Pick<Lead, "contractorId" | "source" | "status"> &
  Partial<Omit<Lead, "id" | "contractorId" | "source" | "status" | "createdAt" | "updatedAt">>;

export type NewCall = Pick<Call, "leadId" | "contractorId" | "direction" | "status"> &
  Partial<Omit<Call, "id" | "leadId" | "contractorId" | "direction" | "status" | "createdAt" | "updatedAt">>;

const ACTIVE_CALL_STATUSES = ["queued", "initiated", "ringing", "in-progress"];

export class Repo {
  constructor(
    readonly db: Sqlite,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  now(): string {
    return this.clock().toISOString();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private insert<T>(table: string, columns: ColumnMap<T>, values: Partial<T>): void {
    const cols: string[] = [];
    const params: unknown[] = [];
    for (const [field, spec] of Object.entries(columns) as Array<[string, [string, Kind]]>) {
      const v = toDb(spec[1], (values as Record<string, unknown>)[field]);
      if (v === undefined) continue;
      cols.push(spec[0]);
      params.push(v);
    }
    this.db
      .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(...params);
  }

  private update<T>(table: string, columns: ColumnMap<T>, keyColumn: string, key: unknown, patch: Partial<T>): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [field, value] of Object.entries(patch)) {
      const spec = (columns as Record<string, [string, Kind]>)[field];
      if (!spec || value === undefined || spec[0] === keyColumn) continue;
      sets.push(`${spec[0]} = ?`);
      params.push(toDb(spec[1], value));
    }
    if ("updatedAt" in columns && !("updatedAt" in patch)) {
      sets.push("updated_at = ?");
      params.push(this.now());
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${keyColumn} = ?`).run(...params, key);
  }

  /* ------------------------------ contractors ------------------------------ */

  createContractor(input: NewContractor): Contractor {
    const now = this.now();
    const contractor: Contractor = {
      id: randomId("ctr", 9),
      name: input.name,
      timezone: input.timezone ?? "America/New_York",
      twilioNumber: input.twilioNumber ?? null,
      publicKey: randomId("pk", 12),
      googleAdsKey: randomSecret(18),
      settings: parseSettings(input.settings ?? {}),
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.insert("contractors", CONTRACTOR_COLUMNS, contractor);
    return contractor;
  }

  private hydrateContractor(row: Row | undefined): Contractor | null {
    const c = mapRow<Contractor>(row, CONTRACTOR_COLUMNS);
    if (c) c.settings = parseSettings(c.settings);
    return c;
  }

  getContractor(id: string): Contractor | null {
    return this.hydrateContractor(this.db.prepare("SELECT * FROM contractors WHERE id = ?").get(id) as Row);
  }

  getContractorByPublicKey(key: string): Contractor | null {
    return this.hydrateContractor(this.db.prepare("SELECT * FROM contractors WHERE public_key = ?").get(key) as Row);
  }

  getContractorByTwilioNumber(phone: string): Contractor | null {
    return this.hydrateContractor(this.db.prepare("SELECT * FROM contractors WHERE twilio_number = ?").get(phone) as Row);
  }

  listContractors(): Contractor[] {
    return (this.db.prepare("SELECT * FROM contractors ORDER BY name COLLATE NOCASE").all() as Row[]).map(
      (r) => this.hydrateContractor(r)!,
    );
  }

  updateContractor(id: string, patch: Partial<Omit<Contractor, "id" | "createdAt">>): Contractor {
    this.update("contractors", CONTRACTOR_COLUMNS, "id", id, patch);
    return this.getContractor(id)!;
  }

  deleteContractor(id: string): void {
    this.db.prepare("DELETE FROM contractors WHERE id = ?").run(id);
  }

  /* ---------------------------- facebook pages ---------------------------- */

  upsertFacebookPage(page: Omit<FacebookPage, "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO facebook_pages (page_id, contractor_id, page_name, access_token, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET contractor_id = excluded.contractor_id,
           page_name = excluded.page_name, access_token = excluded.access_token`,
      )
      .run(page.pageId, page.contractorId, page.pageName, page.accessToken, this.now());
  }

  getFacebookPage(pageId: string): FacebookPage | null {
    return mapRow(this.db.prepare("SELECT * FROM facebook_pages WHERE page_id = ?").get(pageId) as Row, PAGE_COLUMNS);
  }

  listFacebookPages(contractorId: string): FacebookPage[] {
    return (this.db.prepare("SELECT * FROM facebook_pages WHERE contractor_id = ? ORDER BY page_name").all(contractorId) as Row[]).map(
      (r) => mapRow<FacebookPage>(r, PAGE_COLUMNS)!,
    );
  }

  deleteFacebookPage(pageId: string): void {
    this.db.prepare("DELETE FROM facebook_pages WHERE page_id = ?").run(pageId);
  }

  /* ------------------------- calendar connections ------------------------- */

  upsertCalendarConnection(conn: Omit<CalendarConnection, "createdAt" | "updatedAt">): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO calendar_connections (contractor_id, provider, account_email, refresh_token, access_token,
           access_token_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(contractor_id) DO UPDATE SET provider = excluded.provider, account_email = excluded.account_email,
           refresh_token = excluded.refresh_token, access_token = excluded.access_token,
           access_token_expires_at = excluded.access_token_expires_at, updated_at = excluded.updated_at`,
      )
      .run(
        conn.contractorId,
        conn.provider,
        conn.accountEmail,
        conn.refreshToken,
        conn.accessToken,
        conn.accessTokenExpiresAt,
        now,
        now,
      );
  }

  getCalendarConnection(contractorId: string): CalendarConnection | null {
    return mapRow(
      this.db.prepare("SELECT * FROM calendar_connections WHERE contractor_id = ?").get(contractorId) as Row,
      CALENDAR_COLUMNS,
    );
  }

  updateCalendarAccessToken(contractorId: string, accessToken: string, expiresAt: string): void {
    this.update("calendar_connections", CALENDAR_COLUMNS, "contractor_id", contractorId, {
      accessToken,
      accessTokenExpiresAt: expiresAt,
    });
  }

  deleteCalendarConnection(contractorId: string): void {
    this.db.prepare("DELETE FROM calendar_connections WHERE contractor_id = ?").run(contractorId);
  }

  /* --------------------------------- leads -------------------------------- */

  createLead(input: NewLead): Lead {
    const now = this.now();
    const lead: Lead = {
      id: randomId("ld"),
      externalId: null,
      name: null,
      email: null,
      phone: null,
      phoneRaw: null,
      address: null,
      zip: null,
      formAnswers: {},
      details: {},
      summary: null,
      callAttempts: 0,
      appointmentStart: null,
      appointmentEnd: null,
      appointmentEventId: null,
      metadata: {},
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.insert("leads", LEAD_COLUMNS, lead);
    return lead;
  }

  getLead(id: string): Lead | null {
    return mapRow(this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Row, LEAD_COLUMNS);
  }

  findLeadByExternalId(contractorId: string, source: string, externalId: string): Lead | null {
    return mapRow(
      this.db
        .prepare("SELECT * FROM leads WHERE contractor_id = ? AND source = ? AND external_id = ?")
        .get(contractorId, source, externalId) as Row,
      LEAD_COLUMNS,
    );
  }

  /** Most recent lead from this phone created at or after `sinceIso`. */
  findRecentLeadByPhone(contractorId: string, phone: string, sinceIso: string): Lead | null {
    return mapRow(
      this.db
        .prepare(
          "SELECT * FROM leads WHERE contractor_id = ? AND phone = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(contractorId, phone, sinceIso) as Row,
      LEAD_COLUMNS,
    );
  }

  updateLead(id: string, patch: Partial<Omit<Lead, "id" | "contractorId" | "createdAt">>): Lead {
    this.update("leads", LEAD_COLUMNS, "id", id, patch);
    return this.getLead(id)!;
  }

  setLeadStatus(id: string, status: LeadStatus): Lead {
    return this.updateLead(id, { status });
  }

  listLeads(opts: { contractorId?: string; status?: string; limit?: number; offset?: number } = {}): Lead[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.contractorId) {
      where.push("contractor_id = ?");
      params.push(opts.contractorId);
    }
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    const sql = `SELECT * FROM leads ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    return (this.db.prepare(sql).all(...params, opts.limit ?? 50, opts.offset ?? 0) as Row[]).map(
      (r) => mapRow<Lead>(r, LEAD_COLUMNS)!,
    );
  }

  /** Booked appointments overlapping [fromIso, toIso) - used to avoid double booking. */
  listAppointments(contractorId: string, fromIso: string, toIso: string): Array<{ start: string; end: string }> {
    return this.db
      .prepare(
        `SELECT appointment_start AS start, appointment_end AS "end" FROM leads
         WHERE contractor_id = ? AND appointment_start IS NOT NULL AND appointment_end > ? AND appointment_start < ?`,
      )
      .all(contractorId, fromIso, toIso) as Array<{ start: string; end: string }>;
  }

  leadStatusCounts(contractorId?: string, sinceIso?: string): Record<string, number> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (contractorId) {
      where.push("contractor_id = ?");
      params.push(contractorId);
    }
    if (sinceIso) {
      where.push("created_at >= ?");
      params.push(sinceIso);
    }
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM leads ${where.length ? "WHERE " + where.join(" AND ") : ""} GROUP BY status`)
      .all(...params) as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** Median seconds from lead creation to the first call being placed. */
  medianSecondsToFirstCall(sinceIso: string, contractorId?: string): number | null {
    const rows = this.db
      .prepare(
        `SELECT (julianday(MIN(c.created_at)) - julianday(l.created_at)) * 86400 AS secs
         FROM leads l JOIN calls c ON c.lead_id = l.id AND c.direction = 'outbound'
         WHERE l.created_at >= ? ${contractorId ? "AND l.contractor_id = ?" : ""}
         GROUP BY l.id ORDER BY secs`,
      )
      .all(...(contractorId ? [sinceIso, contractorId] : [sinceIso])) as Array<{ secs: number }>;
    if (rows.length === 0) return null;
    return Math.round(rows[Math.floor(rows.length / 2)].secs);
  }

  /* --------------------------------- calls -------------------------------- */

  createCall(input: NewCall): Call {
    const now = this.now();
    const call: Call = {
      id: randomId("call"),
      attempt: 1,
      reason: null,
      twilioCallSid: null,
      answeredBy: null,
      phase: "qualify",
      outcome: null,
      transferIndex: -1,
      transferAcceptedBy: null,
      conversation: [],
      pendingToolResults: [],
      transcript: [],
      startedAt: null,
      answeredAt: null,
      endedAt: null,
      durationSeconds: null,
      postProcessedAt: null,
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.insert("calls", CALL_COLUMNS, call);
    return call;
  }

  getCall(id: string): Call | null {
    return mapRow(this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id) as Row, CALL_COLUMNS);
  }

  getCallBySid(sid: string): Call | null {
    return mapRow(this.db.prepare("SELECT * FROM calls WHERE twilio_call_sid = ?").get(sid) as Row, CALL_COLUMNS);
  }

  updateCall(id: string, patch: Partial<Omit<Call, "id" | "leadId" | "contractorId" | "createdAt">>): Call {
    this.update("calls", CALL_COLUMNS, "id", id, patch);
    return this.getCall(id)!;
  }

  listCallsForLead(leadId: string): Call[] {
    return (this.db.prepare("SELECT * FROM calls WHERE lead_id = ? ORDER BY created_at").all(leadId) as Row[]).map(
      (r) => mapRow<Call>(r, CALL_COLUMNS)!,
    );
  }

  findActiveCallForLead(leadId: string): Call | null {
    return mapRow(
      this.db
        .prepare(
          `SELECT * FROM calls WHERE lead_id = ? AND status IN (${ACTIVE_CALL_STATUSES.map(() => "?").join(",")})
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(leadId, ...ACTIVE_CALL_STATUSES) as Row,
      CALL_COLUMNS,
    );
  }

  /* --------------------------------- jobs --------------------------------- */

  /** Returns the job id, or null when a pending job with the same dedupe key is already queued. */
  enqueueJob(type: string, payload: Record<string, unknown>, runAt: Date, dedupeKey?: string): number | null {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO jobs (type, payload, run_at, status, attempts, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(type, JSON.stringify(payload), runAt.toISOString(), dedupeKey ?? null, now, now);
    return result.changes > 0 ? Number(result.lastInsertRowid) : null;
  }

  /** Atomically marks up to `limit` due jobs as running and returns them. */
  claimDueJobs(limit: number): Job[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT ?")
        .all(this.now(), limit) as Row[];
      const jobs = rows.map((r) => mapRow<Job>(r, JOB_COLUMNS)!);
      const mark = this.db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?");
      for (const j of jobs) {
        mark.run(this.now(), j.id);
        j.status = "running";
        j.attempts += 1;
      }
      return jobs;
    });
  }

  completeJob(id: number): void {
    this.update("jobs", JOB_COLUMNS, "id", id, { status: "done" });
  }

  failJob(id: number, error: string, retryAt: Date | null): void {
    const lastError = error.slice(0, 2000);
    if (retryAt) {
      try {
        this.update("jobs", JOB_COLUMNS, "id", id, { status: "pending", lastError, runAt: retryAt.toISOString() });
        return;
      } catch (err) {
        // An identical job (same dedupe key) is already queued; let that one run instead.
        if (!(err instanceof Error && /UNIQUE/i.test(err.message))) throw err;
      }
    }
    this.update("jobs", JOB_COLUMNS, "id", id, { status: "failed", lastError });
  }

  /** Cancel pending jobs of a type whose payload has the given leadId (e.g. queued re-dials after a booking). */
  cancelPendingJobsForLead(type: string, leadId: string): number {
    return this.db
      .prepare(
        "UPDATE jobs SET status = 'canceled', updated_at = ? WHERE status = 'pending' AND type = ? AND json_extract(payload, '$.leadId') = ?",
      )
      .run(this.now(), type, leadId).changes;
  }

  pendingJobsForLead(leadId: string): Job[] {
    return (
      this.db
        .prepare("SELECT * FROM jobs WHERE status = 'pending' AND json_extract(payload, '$.leadId') = ? ORDER BY run_at")
        .all(leadId) as Row[]
    ).map((r) => mapRow<Job>(r, JOB_COLUMNS)!);
  }

  /** After a crash, jobs left "running" are retried. */
  resetRunningJobs(): number {
    return this.db.prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'").run(this.now()).changes;
  }

  /* -------------------------------- events -------------------------------- */

  addEvent(e: { contractorId?: string | null; leadId?: string | null; callId?: string | null; type: string; message?: string; data?: unknown }): void {
    this.db
      .prepare("INSERT INTO events (contractor_id, lead_id, call_id, type, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        e.contractorId ?? null,
        e.leadId ?? null,
        e.callId ?? null,
        e.type,
        e.message ?? null,
        e.data === undefined ? null : JSON.stringify(e.data),
        this.now(),
      );
  }

  listEventsForLead(leadId: string): LeadEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE lead_id = ? ORDER BY id").all(leadId) as Row[]).map(
      (r) => mapRow<LeadEvent>(r, EVENT_COLUMNS)!,
    );
  }
}
