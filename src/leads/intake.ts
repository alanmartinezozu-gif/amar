import type { Deps } from "../deps.js";
import type { Contractor, Lead, LeadSource } from "../domain/types.js";
import { nextOpening } from "../lib/hours.js";
import { normalizePhone } from "../lib/phone.js";
import { alertTeam, emitWebhook, leadPayload, messages, queueSms, sourceLabel } from "../notify/notify.js";

/** A lead as it arrives from any source, before normalization. */
export interface IncomingLead {
  source: LeadSource;
  /** Source's own id (Facebook leadgen id, Google lead id) - makes webhook retries idempotent. */
  externalId?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  zip?: string | null;
  /** Every other answer from the form, label -> value. */
  answers?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface IntakeResult {
  lead: Lead;
  /** created = new lead; duplicate = merged into a recent lead from the same phone; existing = webhook retry. */
  outcome: "created" | "duplicate" | "existing";
  callAt: Date | null;
}

function clean(v: string | null | undefined): string | null {
  const s = (v ?? "").toString().trim();
  return s ? s.slice(0, 500) : null;
}

/**
 * Store a new lead and queue the AI call `callDelaySeconds` later (or when calling hours open).
 * Called by the Facebook, Google Ads and website integrations.
 */
export function ingestLead(deps: Deps, contractor: Contractor, input: IncomingLead): IntakeResult {
  const { repo } = deps;
  const now = deps.clock();
  const s = contractor.settings;

  if (input.externalId) {
    const existing = repo.findLeadByExternalId(contractor.id, input.source, input.externalId);
    if (existing) return { lead: existing, outcome: "existing", callAt: null };
  }

  const name =
    clean(input.name) ?? clean([input.firstName, input.lastName].filter(Boolean).join(" ")) ?? null;
  const phone = normalizePhone(input.phone);
  const answers = Object.fromEntries(
    Object.entries(input.answers ?? {})
      .map(([k, v]) => [k.slice(0, 120), String(v ?? "").slice(0, 2000)] as const)
      .filter(([, v]) => v.trim() !== ""),
  );

  // Same person submitting twice (or on two platforms) - merge instead of calling twice.
  if (phone && s.dedupeMinutes > 0) {
    const since = new Date(now.getTime() - s.dedupeMinutes * 60_000).toISOString();
    const recent = repo.findRecentLeadByPhone(contractor.id, phone, since);
    if (recent) {
      const merged = repo.updateLead(recent.id, {
        formAnswers: { ...recent.formAnswers, ...answers },
        email: recent.email ?? clean(input.email),
        address: recent.address ?? clean(input.address),
        zip: recent.zip ?? clean(input.zip),
        name: recent.name ?? name,
      });
      repo.addEvent({
        contractorId: contractor.id,
        leadId: recent.id,
        type: "duplicate_submission",
        message: `Submitted again via ${input.source}; merged into this lead`,
        data: { answers, metadata: input.metadata },
      });
      return { lead: merged, outcome: "duplicate", callAt: null };
    }
  }

  const callAt = phone
    ? nextOpening(s.callingHours, contractor.timezone, new Date(now.getTime() + s.callDelaySeconds * 1000))
    : null;
  const outsideHours = callAt !== null && callAt.getTime() > now.getTime() + s.callDelaySeconds * 1000 + 1000;

  let lead: Lead;
  try {
    lead = repo.createLead({
      contractorId: contractor.id,
      source: input.source,
      externalId: clean(input.externalId),
      name,
      email: clean(input.email),
      phone,
      phoneRaw: clean(input.phone),
      address: clean(input.address),
      zip: clean(input.zip),
      formAnswers: answers,
      status: !phone ? "invalid_phone" : outsideHours ? "scheduled" : "new",
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    // Two deliveries of the same webhook racing each other: the unique index caught the second one.
    if (input.externalId && err instanceof Error && /UNIQUE/i.test(err.message)) {
      const existing = repo.findLeadByExternalId(contractor.id, input.source, input.externalId);
      if (existing) return { lead: existing, outcome: "existing", callAt: null };
    }
    throw err;
  }

  repo.addEvent({
    contractorId: contractor.id,
    leadId: lead.id,
    type: "lead_received",
    message: `New lead from ${sourceLabel(input.source)}`,
    data: { metadata: input.metadata },
  });
  emitWebhook(deps, contractor, "lead.created", leadPayload(lead));

  if (!phone) {
    repo.addEvent({ contractorId: contractor.id, leadId: lead.id, type: "invalid_phone", message: `Couldn't dial "${input.phone ?? ""}"` });
    alertTeam(deps, contractor, lead, messages.teamFollowUp(deps, lead, `no valid phone number ("${input.phone ?? ""}")`), "invalid_phone");
    return { lead, outcome: "created", callAt: null };
  }

  if (!callAt) {
    repo.addEvent({ contractorId: contractor.id, leadId: lead.id, type: "not_called", message: "Calling hours are empty - no AI call scheduled" });
    alertTeam(deps, contractor, lead, messages.teamFollowUp(deps, lead, "calling hours are empty, so the AI won't call"), "no_hours");
  } else {
    deps.jobs.enqueue("call_lead", { leadId: lead.id }, callAt, `call_lead:${lead.id}`);
    repo.addEvent({
      contractorId: contractor.id,
      leadId: lead.id,
      type: "call_scheduled",
      message: outsideHours ? `Outside calling hours - AI call scheduled for ${callAt.toISOString()}` : `AI call in ${s.callDelaySeconds}s`,
      data: { callAt: callAt.toISOString() },
    });
  }

  if (s.sms.instantReply) {
    queueSms(deps, contractor, phone, messages.instantReply(contractor, lead, outsideHours ? callAt : null), {
      leadId: lead.id,
      kind: "instant_reply",
    });
  }
  alertTeam(deps, contractor, lead, messages.teamNewLead(deps, contractor, lead, outsideHours ? callAt : null), "new_lead");

  return { lead, outcome: "created", callAt };
}

/* ------------------- helpers shared by the source parsers ------------------- */

const NAME_KEYS = ["full_name", "fullname", "name", "your_name", "contact_name"];
const FIRST_KEYS = ["first_name", "firstname", "fname", "given_name"];
const LAST_KEYS = ["last_name", "lastname", "lname", "family_name", "surname"];
const PHONE_KEYS = ["phone_number", "phone", "phonenumber", "mobile", "mobile_phone", "cell", "tel", "telephone", "user_phone"];
const EMAIL_KEYS = ["email", "email_address", "e_mail", "user_email"];
const STREET_KEYS = ["street_address", "address", "street", "address_line_1", "address1", "property_address"];
const CITY_KEYS = ["city", "town"];
const STATE_KEYS = ["state", "province", "region"];
const ZIP_KEYS = ["zip_code", "zip", "zipcode", "postal_code", "post_code", "postcode"];

export function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Pull the standard contact fields out of an arbitrary key/value form submission.
 * Everything that isn't a contact field is kept in `answers` under its original label.
 */
export function extractContactFields(fields: Record<string, string>): Omit<IncomingLead, "source"> {
  const byKey = new Map<string, string>();
  for (const [k, v] of Object.entries(fields)) byKey.set(normalizeKey(k), String(v ?? "").trim());
  const used = new Set<string>();
  const pick = (keys: string[]): string | null => {
    for (const k of keys) {
      const v = byKey.get(k);
      if (v) {
        used.add(k);
        return v;
      }
    }
    return null;
  };

  const name = pick(NAME_KEYS);
  const firstName = pick(FIRST_KEYS);
  const lastName = pick(LAST_KEYS);
  const phone = pick(PHONE_KEYS);
  const email = pick(EMAIL_KEYS);
  const street = pick(STREET_KEYS);
  const city = pick(CITY_KEYS);
  const state = pick(STATE_KEYS);
  const zip = pick(ZIP_KEYS);
  const address = [street, city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null;

  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (used.has(normalizeKey(k)) || !String(v ?? "").trim()) continue;
    answers[k] = String(v);
  }
  return { name, firstName, lastName, phone, email, address, zip, answers };
}
