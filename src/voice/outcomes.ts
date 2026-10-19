import { DateTime } from "luxon";
import type { Deps } from "../deps.js";
import type { Call, CallOutcome, Contractor, Lead, LeadStatus } from "../domain/types.js";
import { TERMINAL_LEAD_STATUSES } from "../domain/types.js";
import { isWithinHours, nextOpening } from "../lib/hours.js";
import { alertTeam, callerIdFor, emitWebhook, leadPayload, messages, queueSms } from "../notify/notify.js";

const FINAL_TWILIO_STATUSES = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

export function isFinalTwilioStatus(status: string): boolean {
  return FINAL_TWILIO_STATUSES.has(status);
}

/** Can this call be handed to a person right now? */
export function transferAvailability(contractor: Contractor, call: Call, now: Date): { available: boolean; reason?: string } {
  const s = contractor.settings;
  if (s.transferTargets.length === 0) return { available: false, reason: "no team phone numbers are set up" };
  if (call.transferIndex >= 0 || call.phase !== "qualify") return { available: false, reason: "a transfer was already tried on this call" };
  if (!isWithinHours(s.transferHours, contractor.timezone, now)) return { available: false, reason: "it's outside office hours" };
  return { available: true };
}

/** Queue the next dial attempt for a lead who didn't pick up. Returns the time, or null if out of attempts. */
export function scheduleRetry(deps: Deps, contractor: Contractor, lead: Lead): Date | null {
  const delays = contractor.settings.retryDelaysMinutes;
  const retryNumber = lead.callAttempts; // attempts made so far; first retry uses delays[0]
  if (retryNumber > delays.length) return null;
  const earliest = new Date(deps.clock().getTime() + delays[retryNumber - 1] * 60_000);
  const at = nextOpening(contractor.settings.callingHours, contractor.timezone, earliest);
  if (!at) return null;
  deps.jobs.enqueue("call_lead", { leadId: lead.id, reason: "retry" }, at, `call_lead:${lead.id}`);
  return at;
}

function setStatusUnlessFinal(deps: Deps, lead: Lead, status: LeadStatus): Lead {
  // A booking or transfer always wins over whatever happens on the line afterwards.
  if (lead.status === "booked" || lead.status === "transferred") return lead;
  return deps.repo.setLeadStatus(lead.id, status);
}

export interface EndCallInput {
  outcome: string;
  notes?: string;
  callbackTime?: string;
}

/** Record what the AI decided when it hung up (not interested, call back later, ...). */
export function applyEndCall(deps: Deps, contractor: Contractor, call: Call, input: EndCallInput): void {
  const { repo } = deps;
  let lead = repo.getLead(call.leadId)!;
  const tz = contractor.timezone;
  if (input.notes) {
    repo.addEvent({ contractorId: contractor.id, leadId: lead.id, callId: call.id, type: "call_notes", message: input.notes });
    repo.updateLead(lead.id, { metadata: { ...lead.metadata, lastCallNotes: input.notes } });
  }

  let outcome: CallOutcome;
  switch (input.outcome) {
    case "not_interested":
    case "already_hired":
      outcome = input.outcome === "already_hired" ? "already_hired" : "not_interested";
      lead = setStatusUnlessFinal(deps, lead, "not_interested");
      break;
    case "wrong_number":
      outcome = "wrong_number";
      lead = setStatusUnlessFinal(deps, lead, "wrong_number");
      break;
    case "do_not_call":
      outcome = "do_not_call";
      lead = repo.setLeadStatus(lead.id, "do_not_call");
      repo.cancelPendingJobsForLead("call_lead", lead.id);
      repo.addEvent({ contractorId: contractor.id, leadId: lead.id, type: "do_not_call", message: "Caller asked not to be contacted again" });
      break;
    case "call_back_later": {
      outcome = "call_back_later";
      const requested = input.callbackTime ? DateTime.fromISO(input.callbackTime, { zone: tz }) : null;
      const minTime = deps.clock().getTime() + 5 * 60_000;
      const target = requested?.isValid ? Math.max(requested.toMillis(), minTime) : deps.clock().getTime() + 2 * 3_600_000;
      const at = nextOpening(contractor.settings.callingHours, tz, new Date(target));
      if (at && lead.status !== "booked" && lead.status !== "transferred") {
        repo.cancelPendingJobsForLead("call_lead", lead.id);
        deps.jobs.enqueue("call_lead", { leadId: lead.id, reason: "callback" }, at, `call_lead:${lead.id}`);
        lead = repo.setLeadStatus(lead.id, "callback_scheduled");
        repo.addEvent({
          contractorId: contractor.id,
          leadId: lead.id,
          type: "callback_scheduled",
          message: `Asked to be called back - AI will call ${at.toISOString()}`,
          data: { requested: input.callbackTime ?? null },
        });
      }
      break;
    }
    case "voicemail":
      outcome = "voicemail";
      break;
    default:
      outcome = call.outcome === "booked" || call.outcome === "booking_requested" ? call.outcome : "completed";
  }
  if (call.outcome !== "booked" && call.outcome !== "booking_requested") repo.updateCall(call.id, { outcome });
}

/**
 * Twilio reported the call is over. Decide what happens to the lead: re-dial, alert the team, or nothing.
 * Idempotent: Twilio can deliver the final status more than once.
 */
export function finalizeCall(deps: Deps, callId: string, twilioStatus: string, durationSeconds: number | null): void {
  const { repo } = deps;
  let call = repo.getCall(callId);
  if (!call || call.endedAt) return;
  const contractor = repo.getContractor(call.contractorId)!;
  let lead = repo.getLead(call.leadId)!;

  let outcome = call.outcome;
  if (!outcome) {
    if (twilioStatus === "busy" || twilioStatus === "no-answer" || twilioStatus === "canceled") outcome = "no_answer";
    else if (twilioStatus === "failed") outcome = "failed";
    else if (call.answeredBy?.startsWith("machine")) outcome = "voicemail";
    else if (call.phase === "transferring") outcome = "hung_up";
    else outcome = call.transcript.some((t) => t.role === "caller") ? "hung_up" : "no_answer";
  }
  call = repo.updateCall(call.id, {
    status: twilioStatus,
    outcome,
    phase: "ended",
    endedAt: deps.clock().toISOString(),
    durationSeconds,
  });
  repo.addEvent({ contractorId: contractor.id, leadId: lead.id, callId: call.id, type: "call_ended", message: `Call ended: ${outcome}`, data: { twilioStatus, durationSeconds } });

  if (outcome === "no_answer" || outcome === "voicemail" || outcome === "failed") {
    if (TERMINAL_LEAD_STATUSES.has(lead.status) || lead.status === "callback_scheduled") return;
    const retryAt = scheduleRetry(deps, contractor, lead);
    if (retryAt) {
      lead = repo.setLeadStatus(lead.id, "retry_scheduled");
      repo.addEvent({ contractorId: contractor.id, leadId: lead.id, type: "retry_scheduled", message: `No answer - calling again ${retryAt.toISOString()}` });
    } else {
      lead = repo.setLeadStatus(lead.id, "unreachable");
      alertTeam(deps, contractor, lead, messages.teamUnreachable(deps, lead), "unreachable");
      emitWebhook(deps, contractor, "lead.unreachable", leadPayload(lead));
    }
    if (lead.callAttempts === 1 && contractor.settings.sms.missedCall && lead.phone) {
      queueSms(deps, contractor, lead.phone, messages.missedCall(contractor, lead, callerIdFor(deps, contractor)), { leadId: lead.id, kind: "missed_call" });
    }
    return;
  }

  // The lead talked to us. Summarize and notify once the dust settles.
  if (outcome === "hung_up" || outcome === "error") {
    setStatusUnlessFinal(deps, lead, "needs_followup");
  } else if (outcome === "completed" && !TERMINAL_LEAD_STATUSES.has(lead.status) && lead.status !== "callback_scheduled") {
    setStatusUnlessFinal(deps, lead, "needs_followup");
  }
  deps.jobs.enqueue("post_call", { callId: call.id }, deps.clock(), `post_call:${call.id}`);
}
