import type { Deps } from "../deps.js";
import type { Contractor, Lead } from "../domain/types.js";
import { fetchJson } from "../lib/http.js";
import { formatPhone, normalizePhone } from "../lib/phone.js";
import { shortDateTime } from "../lib/hours.js";
import { PermanentJobError } from "../jobs/queue.js";

export function firstName(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first ? first[0].toUpperCase() + first.slice(1) : "";
}

export function callerIdFor(deps: Deps, contractor: Contractor): string | null {
  return contractor.twilioNumber ?? deps.config.TWILIO_DEFAULT_NUMBER ?? null;
}

export function leadAdminUrl(deps: Deps, leadId: string): string {
  return `${deps.config.PUBLIC_BASE_URL}/admin/leads/${leadId}`;
}

/** Who receives team alert texts: explicit alert phones, else everyone on the transfer list. */
export function teamPhones(contractor: Contractor): string[] {
  const s = contractor.settings;
  const raw = s.alertPhones.length > 0 ? s.alertPhones : s.transferTargets.map((t) => t.phone);
  return [...new Set(raw.map((p) => normalizePhone(p)).filter((p): p is string => Boolean(p)))];
}

const SOURCE_LABEL: Record<string, string> = {
  facebook: "Facebook",
  google: "Google Ads",
  website: "website",
  phone: "phone",
  test: "test",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

/** Queue a text message (sent by the job worker, retried on failure). */
export function queueSms(
  deps: Deps,
  contractor: Contractor,
  to: string,
  body: string,
  meta: { leadId?: string; kind: string },
): void {
  deps.jobs.enqueue("sms", { contractorId: contractor.id, to, body, leadId: meta.leadId ?? null, kind: meta.kind });
}

export function alertTeam(deps: Deps, contractor: Contractor, lead: Lead | null, body: string, kind: string): void {
  if (!contractor.settings.sms.teamAlerts) return;
  for (const to of teamPhones(contractor)) queueSms(deps, contractor, to, body, { leadId: lead?.id, kind: `team_${kind}` });
}

export function emitWebhook(deps: Deps, contractor: Contractor, event: string, data: Record<string, unknown>): void {
  const url = contractor.settings.webhookUrl;
  if (!url) return;
  deps.jobs.enqueue("webhook", { url, event, contractorId: contractor.id, data });
}

export function leadPayload(lead: Lead): Record<string, unknown> {
  return {
    id: lead.id,
    source: lead.source,
    status: lead.status,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    address: lead.address,
    zip: lead.zip,
    formAnswers: lead.formAnswers,
    details: lead.details,
    summary: lead.summary,
    appointmentStart: lead.appointmentStart,
    appointmentEnd: lead.appointmentEnd,
    callAttempts: lead.callAttempts,
    createdAt: lead.createdAt,
  };
}

/* ------------------------------ message copy ------------------------------ */

export const messages = {
  instantReply(contractor: Contractor, lead: Lead, callAt: Date | null): string {
    const hi = firstName(lead.name) ? `Hi ${firstName(lead.name)}! ` : "Hi! ";
    const when = callAt ? `will give you a call ${shortDateTime(callAt, contractor.timezone)}` : "is calling you right now";
    return `${hi}Thanks for reaching out to ${contractor.name}. ${contractor.settings.assistantName} from our team ${when} from this number to get your quote started. Reply STOP to opt out.`;
  },

  missedCall(contractor: Contractor, lead: Lead, callbackNumber: string | null): string {
    const hi = firstName(lead.name) ? `Hi ${firstName(lead.name)}, ` : "Hi, ";
    const back = callbackNumber ? ` or call us back at ${formatPhone(callbackNumber)}` : "";
    return `${hi}it's ${contractor.settings.assistantName} with ${contractor.name}. We just tried calling about your quote request. When's a good time to reach you? Reply here${back}.`;
  },

  bookingConfirmation(contractor: Contractor, lead: Lead, start: Date, address: string | null, confirmed: boolean): string {
    const name = firstName(lead.name);
    const when = shortDateTime(start, contractor.timezone);
    const title = contractor.settings.booking.appointmentTitle.toLowerCase();
    if (!confirmed) {
      return `Thanks${name ? ` ${name}` : ""}! We've requested ${when} for your ${title}. Someone from ${contractor.name} will text you shortly to confirm.`;
    }
    const where = address ? ` at ${address}` : "";
    return `You're all set${name ? `, ${name}` : ""}! ${contractor.name} will see you ${when}${where} for your ${title}. Reply here if you need to reschedule.`;
  },

  teamNewLead(deps: Deps, contractor: Contractor, lead: Lead, callAt: Date | null): string {
    const when = callAt ? `AI will call ${shortDateTime(callAt, contractor.timezone)} (outside calling hours)` : "AI is calling them now";
    return `New ${sourceLabel(lead.source)} lead: ${lead.name ?? "Unknown"} ${formatPhone(lead.phone)}. ${when}. ${leadAdminUrl(deps, lead.id)}`;
  },

  teamBooked(deps: Deps, contractor: Contractor, lead: Lead, start: Date, confirmed: boolean): string {
    const head = confirmed ? "BOOKED" : "APPOINTMENT REQUEST - please confirm with the customer";
    const lines = [
      `${head}: ${shortDateTime(start, contractor.timezone)}`,
      `${lead.name ?? "Unknown"} ${formatPhone(lead.phone)}`,
      lead.address ?? lead.details.property_address ?? "",
      lead.summary ?? "",
      leadAdminUrl(deps, lead.id),
    ];
    return lines.filter(Boolean).join("\n");
  },

  teamFollowUp(deps: Deps, lead: Lead, reason: string): string {
    return [`Follow up needed: ${lead.name ?? "Unknown"} ${formatPhone(lead.phone)} - ${reason}`, lead.summary ?? "", leadAdminUrl(deps, lead.id)]
      .filter(Boolean)
      .join("\n");
  },

  teamCallSummary(deps: Deps, lead: Lead): string {
    return [`Call summary - ${lead.name ?? "Unknown"} ${formatPhone(lead.phone)}`, lead.summary ?? "", leadAdminUrl(deps, lead.id)]
      .filter(Boolean)
      .join("\n");
  },

  teamUnreachable(deps: Deps, lead: Lead): string {
    return `Couldn't reach ${lead.name ?? "a lead"} ${formatPhone(lead.phone)} after ${lead.callAttempts} call attempts. Worth a manual try. ${leadAdminUrl(deps, lead.id)}`;
  },

  teamLeadReplied(deps: Deps, lead: Lead | null, from: string, body: string): string {
    return `Text from ${lead?.name ?? formatPhone(from)} ${lead?.name ? formatPhone(from) : ""}: "${body.slice(0, 300)}"${lead ? ` ${leadAdminUrl(deps, lead.id)}` : ""}`;
  },
};

/* ------------------------------- job handlers ------------------------------ */

export function registerNotificationJobs(deps: Deps): void {
  deps.jobs.register("sms", async (p) => {
    const contractor = deps.repo.getContractor(String(p.contractorId));
    if (!contractor) throw new PermanentJobError("contractor not found");
    const from = callerIdFor(deps, contractor);
    if (!from) throw new PermanentJobError("no Twilio number to send from");
    const { sid } = await deps.telephony.sendSms({ to: String(p.to), from, body: String(p.body) });
    if (p.leadId) {
      deps.repo.addEvent({
        contractorId: contractor.id,
        leadId: String(p.leadId),
        type: "sms_sent",
        message: `Text (${p.kind}) to ${formatPhone(String(p.to))}`,
        data: { sid, body: p.body },
      });
    }
  });

  deps.jobs.register("webhook", async (p) => {
    await fetchJson(String(p.url), {
      method: "POST",
      json: { event: p.event, contractorId: p.contractorId, sentAt: deps.clock().toISOString(), data: p.data },
      timeoutMs: 10_000,
    });
  });
}
