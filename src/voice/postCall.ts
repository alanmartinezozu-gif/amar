import type { Deps } from "../deps.js";
import type { Call, Contractor, Lead } from "../domain/types.js";
import { alertTeam, emitWebhook, leadPayload, messages } from "../notify/notify.js";
import { finalizeCall } from "./outcomes.js";

const SUMMARY_SYSTEM =
  "You write short call notes for a home-services contractor's team. Be factual and specific. Plain text only - no preamble, headings or bullet points.";

async function summarize(deps: Deps, contractor: Contractor, lead: Lead, call: Call): Promise<string | null> {
  const transcript = call.transcript.map((t) => `${t.role === "caller" ? "Caller" : t.role === "assistant" ? "AI" : "System"}: ${t.text}`).join("\n");
  if (!transcript.trim()) return null;
  const details = Object.entries(lead.details)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const prompt = `Company: ${contractor.name}
Lead: ${lead.name ?? "unknown"} (${lead.source})
Call outcome: ${call.outcome ?? "unknown"}
Details collected:
${details || "(none)"}

Transcript:
${transcript}

Write 2-4 sentences for the owner: who this is, what they need and how urgent it is, and what was agreed or what the next step should be.`;
  try {
    const text = await deps.llm.complete(SUMMARY_SYSTEM, prompt);
    return text || null;
  } catch (err) {
    deps.log.warn("Call summary failed", { err, callId: call.id });
    return null;
  }
}

/** After a conversation: write the summary, tell the team what needs doing, notify integrations. */
export function registerPostCallJobs(deps: Deps): void {
  deps.jobs.register("finalize_call", async (p) => {
    const call = deps.repo.getCall(String(p.callId));
    if (call && !call.endedAt) finalizeCall(deps, call.id, "completed", null);
  });

  deps.jobs.register("post_call", async (p) => {
    const call = deps.repo.getCall(String(p.callId));
    if (!call || call.postProcessedAt) return;
    const contractor = deps.repo.getContractor(call.contractorId)!;
    let lead = deps.repo.getLead(call.leadId)!;

    const summary = await summarize(deps, contractor, lead, call);
    if (summary) lead = deps.repo.updateLead(lead.id, { summary });
    deps.repo.updateCall(call.id, { postProcessedAt: deps.clock().toISOString() });

    if (call.outcome === "transferred") {
      alertTeam(deps, contractor, lead, messages.teamCallSummary(deps, lead), "call_summary");
    } else if (lead.status === "needs_followup") {
      const reason =
        call.outcome === "hung_up"
          ? "the call dropped before it was wrapped up"
          : call.outcome === "error"
            ? "the AI assistant had a problem mid-call"
            : "the AI couldn't book or transfer them";
      alertTeam(deps, contractor, lead, messages.teamFollowUp(deps, lead, reason), "follow_up");
    }

    emitWebhook(deps, contractor, "call.completed", {
      call: {
        id: call.id,
        direction: call.direction,
        attempt: call.attempt,
        outcome: call.outcome,
        durationSeconds: call.durationSeconds,
        transcript: call.transcript,
      },
      lead: leadPayload(lead),
    });
  });
}
