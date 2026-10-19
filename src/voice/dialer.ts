import type { Deps } from "../deps.js";
import { TERMINAL_LEAD_STATUSES, type CallReason } from "../domain/types.js";
import { isWithinHours, nextOpening } from "../lib/hours.js";
import { PermanentJobError } from "../jobs/queue.js";
import { alertTeam, callerIdFor, messages } from "../notify/notify.js";

export function voiceUrl(deps: Deps, path: string, params: Record<string, string | number>): string {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]));
  return `${deps.config.PUBLIC_BASE_URL}/twilio/voice/${path}?${q}`;
}

/** Twilio rejected the call request itself (bad number, unverified trial number, geo permissions). */
function isPermanentCarrierError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

/** The `call_lead` job: dial the lead and point Twilio at our AI. */
export async function placeLeadCall(deps: Deps, leadId: string, reason: CallReason): Promise<void> {
  const { repo } = deps;
  const lead = repo.getLead(leadId);
  if (!lead) throw new PermanentJobError(`lead ${leadId} not found`);
  const contractor = repo.getContractor(lead.contractorId);
  const log = deps.log.child({ leadId });
  if (!contractor?.active) return;
  if (!lead.phone || TERMINAL_LEAD_STATUSES.has(lead.status)) {
    log.info("Skipping call", { status: lead.status });
    return;
  }
  if (repo.findActiveCallForLead(lead.id)) {
    log.info("Lead is already on a call; skipping");
    return;
  }

  const now = deps.clock();
  const s = contractor.settings;
  if (!isWithinHours(s.callingHours, contractor.timezone, now)) {
    const at = nextOpening(s.callingHours, contractor.timezone, now);
    if (at) {
      deps.jobs.enqueue("call_lead", { leadId, reason }, at, `call_lead:${leadId}`);
      repo.setLeadStatus(lead.id, "scheduled");
      repo.addEvent({ contractorId: contractor.id, leadId, type: "call_deferred", message: `Outside calling hours - moved to ${at.toISOString()}` });
    }
    return;
  }

  const from = callerIdFor(deps, contractor);
  if (!from) throw new PermanentJobError("No Twilio number: set one on the contractor or TWILIO_DEFAULT_NUMBER");

  const attempt = lead.callAttempts + 1;
  const call = repo.createCall({
    leadId,
    contractorId: contractor.id,
    direction: "outbound",
    status: "queued",
    attempt,
    reason,
    startedAt: now.toISOString(),
  });
  repo.updateLead(lead.id, { callAttempts: attempt, status: "calling" });

  try {
    const { sid } = await deps.telephony.placeCall({
      to: lead.phone,
      from,
      answerUrl: voiceUrl(deps, "answer", { callId: call.id }),
      statusCallbackUrl: voiceUrl(deps, "status", { callId: call.id }),
      amdCallbackUrl: voiceUrl(deps, "amd", { callId: call.id }),
      ringTimeoutSeconds: 25,
    });
    repo.updateCall(call.id, { twilioCallSid: sid });
    repo.addEvent({
      contractorId: contractor.id,
      leadId,
      callId: call.id,
      type: "call_placed",
      message: `AI calling (attempt ${attempt})`,
      data: { sid, secondsSinceLead: Math.round((now.getTime() - new Date(lead.createdAt).getTime()) / 1000) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    repo.updateCall(call.id, { status: "failed", outcome: "failed", phase: "ended", endedAt: deps.clock().toISOString() });
    repo.addEvent({ contractorId: contractor.id, leadId, callId: call.id, type: "call_failed", message });
    if (isPermanentCarrierError(err)) {
      const updated = repo.setLeadStatus(lead.id, "needs_followup");
      alertTeam(deps, contractor, updated, messages.teamFollowUp(deps, updated, `the AI couldn't place the call (${message})`), "call_failed");
      return;
    }
    // Transient (network, 5xx): undo the attempt and let the job queue retry shortly.
    repo.updateLead(lead.id, { callAttempts: lead.callAttempts, status: lead.status });
    throw err;
  }
}

export function registerDialerJobs(deps: Deps): void {
  deps.jobs.register("call_lead", async (p) => {
    const reason = p.reason === "retry" || p.reason === "callback" ? p.reason : "new";
    await placeLeadCall(deps, String(p.leadId), reason);
  });
}
