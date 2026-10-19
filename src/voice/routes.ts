import express, { type NextFunction, type Request, type Response } from "express";
import type Anthropic from "@anthropic-ai/sdk";
import { relayUrl } from "../config.js";
import type { Deps } from "../deps.js";
import type { Call, Contractor, Lead } from "../domain/types.js";
import { normalizePhone, speakablePhone } from "../lib/phone.js";
import { alertTeam, callerIdFor, emitWebhook, firstName, leadPayload, messages, sourceLabel } from "../notify/notify.js";
import { voiceUrl } from "./dialer.js";
import { finalizeCall, isFinalTwilioStatus } from "./outcomes.js";
import { bookingResumeGreeting, inboundGreeting } from "./prompt.js";
import {
  bridgeTwiml,
  conversationRelayTwiml,
  dialTeamMemberTwiml,
  emptyMessagingTwiml,
  hangupTwiml,
  voicemailTwiml,
  whisperTwiml,
} from "./twiml.js";

type Params = Record<string, string>;

function params(req: Request): Params {
  return (req.body ?? {}) as Params;
}

function sendTwiml(res: Response, twiml: string): void {
  res.type("text/xml").send(twiml);
}

/** Rejects requests that weren't signed by Twilio with our auth token. */
function twilioSignature(deps: Deps) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!deps.config.TWILIO_VALIDATE_SIGNATURES) return next();
    const signature = req.get("x-twilio-signature");
    const url = deps.config.PUBLIC_BASE_URL + req.originalUrl;
    if (signature && deps.telephony.validateSignature(signature, url, params(req))) return next();
    deps.log.warn("Rejected Twilio webhook with a bad signature", { path: req.path });
    res.sendStatus(403);
  };
}

function relayTwiml(deps: Deps, contractor: Contractor, call: Call, welcomeGreeting?: string): string {
  return conversationRelayTwiml(contractor, {
    relayUrl: relayUrl(deps.config),
    actionUrl: voiceUrl(deps, "handoff", { callId: call.id }),
    callId: call.id,
    welcomeGreeting,
    hints: [contractor.name, contractor.settings.services].filter(Boolean).join(", "),
  });
}

/**
 * Twilio's status callback normally closes out the call. Inbound calls only get one if the number's
 * webhooks were configured (admin > Configure Twilio number), so double-check a couple of minutes later.
 */
function scheduleFinalizeCheck(deps: Deps, call: Call): void {
  deps.jobs.enqueue("finalize_call", { callId: call.id }, new Date(deps.clock().getTime() + 120_000), `finalize_call:${call.id}`);
}

function shouldLeaveVoicemail(contractor: Contractor, call: Call): boolean {
  const policy = contractor.settings.voicemail;
  return policy === "always" || (policy === "first" && call.attempt === 1);
}

function voicemailMessage(deps: Deps, contractor: Contractor, lead: Lead): string {
  const first = firstName(lead.name);
  const number = callerIdFor(deps, contractor);
  return `Hi${first ? ` ${first}` : ""}, this is ${contractor.settings.assistantName} with ${contractor.name}. We got your request for a quote and wanted to get you taken care of. Give us a call back${
    number ? ` at ${speakablePhone(number)}` : ""
  }, or just reply to our text message. Talk soon!`;
}

/** Ring team member `idx`; past the end of the list, the AI comes back to book an appointment. */
function dialTeamMember(deps: Deps, contractor: Contractor, call: Call, idx: number): string {
  const targets = contractor.settings.transferTargets;
  for (let i = idx; i < targets.length; i++) {
    const to = normalizePhone(targets[i].phone);
    if (!to) continue;
    deps.repo.updateCall(call.id, { phase: "transferring", transferIndex: i, transferAcceptedBy: null });
    deps.repo.setLeadStatus(call.leadId, "transferring");
    deps.repo.addEvent({
      contractorId: contractor.id,
      leadId: call.leadId,
      callId: call.id,
      type: "transfer_ringing",
      message: `Ringing ${targets[i].name} (${targets[i].role})`,
    });
    return dialTeamMemberTwiml({
      to,
      callerId: callerIdFor(deps, contractor)!,
      ringSeconds: contractor.settings.transferRingSeconds,
      actionUrl: voiceUrl(deps, "dial-result", { callId: call.id, idx: i }),
      whisperUrl: voiceUrl(deps, "whisper", { callId: call.id, idx: i }),
    });
  }
  return resumeAiForBooking(deps, contractor, call);
}

function resumeAiForBooking(deps: Deps, contractor: Contractor, call: Call): string {
  const greeting = bookingResumeGreeting(contractor);
  const transferUse = [...call.conversation]
    .reverse()
    .find((m) => m.role === "assistant" && Array.isArray(m.content))
    ?.content as Anthropic.Beta.BetaContentBlockParam[] | undefined;
  const toolUse = transferUse?.find(
    (b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use" && b.name === "transfer_to_team",
  );
  const pending = [...call.pendingToolResults];
  if (toolUse && !pending.some((r) => r.tool_use_id === toolUse.id)) {
    pending.push({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: JSON.stringify({
        transferred: false,
        reason: "Nobody on the team picked up.",
        caller_was_told: greeting,
        next: "Help them book an estimate: use check_availability, offer a few times, confirm the address, then book_appointment.",
      }),
    });
  }
  deps.repo.updateCall(call.id, {
    phase: "booking",
    pendingToolResults: pending,
    transcript: [...call.transcript, { role: "assistant", text: greeting, at: deps.clock().toISOString() }],
  });
  deps.repo.setLeadStatus(call.leadId, "in_conversation");
  deps.repo.addEvent({ contractorId: contractor.id, leadId: call.leadId, callId: call.id, type: "transfer_no_answer", message: "No one picked up - AI is booking instead" });
  return relayTwiml(deps, contractor, deps.repo.getCall(call.id)!, greeting);
}

export function twilioRouter(deps: Deps): express.Router {
  const router = express.Router();
  const { repo } = deps;
  router.use("/twilio", twilioSignature(deps));

  const load = (req: Request) => {
    const callId = String(req.query.callId ?? "");
    const call = callId ? repo.getCall(callId) : params(req).CallSid ? repo.getCallBySid(params(req).CallSid) : null;
    const contractor = call ? repo.getContractor(call.contractorId) : null;
    const lead = call ? repo.getLead(call.leadId) : null;
    return call && contractor && lead ? { call, contractor, lead } : null;
  };

  // The lead picked up: connect the AI.
  router.post("/twilio/voice/answer", (req, res) => {
    const ctx = load(req);
    if (!ctx) return sendTwiml(res, hangupTwiml());
    sendTwiml(res, relayTwiml(deps, ctx.contractor, ctx.call));
  });

  router.post("/twilio/voice/status", (req, res) => {
    const ctx = load(req);
    const p = params(req);
    if (ctx) {
      const status = p.CallStatus ?? "";
      if (isFinalTwilioStatus(status)) {
        finalizeCall(deps, ctx.call.id, status, p.CallDuration ? Number(p.CallDuration) : null);
      } else if (status && !ctx.call.endedAt) {
        repo.updateCall(ctx.call.id, {
          status,
          ...(status === "in-progress" && !ctx.call.answeredAt ? { answeredAt: deps.clock().toISOString() } : {}),
        });
      }
    }
    res.sendStatus(204);
  });

  // Async answering-machine detection: a voicemail picked up, not a person.
  router.post("/twilio/voice/amd", async (req, res) => {
    const ctx = load(req);
    const answeredBy = params(req).AnsweredBy ?? "unknown";
    res.sendStatus(204);
    if (!ctx || !ctx.call.twilioCallSid) return;
    repo.updateCall(ctx.call.id, { answeredBy });
    const machine = answeredBy.startsWith("machine_end") || answeredBy === "fax";
    if (!machine) return;
    // If they've already been talking with the AI, it's a person (AMD misfires on short greetings).
    if (ctx.call.transcript.filter((t) => t.role === "caller").length >= 2) return;
    // The AI already recognized the greeting and is leaving the voicemail itself.
    if (ctx.call.outcome === "voicemail") return;
    repo.updateCall(ctx.call.id, { outcome: "voicemail" });
    repo.addEvent({ contractorId: ctx.contractor.id, leadId: ctx.lead.id, callId: ctx.call.id, type: "voicemail_detected", message: `Answering machine (${answeredBy})` });
    try {
      if (answeredBy !== "fax" && shouldLeaveVoicemail(ctx.contractor, ctx.call)) {
        await deps.telephony.updateCallTwiml(ctx.call.twilioCallSid, voicemailTwiml(ctx.contractor, voicemailMessage(deps, ctx.contractor, ctx.lead)));
      } else {
        await deps.telephony.hangup(ctx.call.twilioCallSid);
      }
    } catch (err) {
      deps.log.warn("Couldn't redirect call after machine detection", { err, callId: ctx.call.id });
    }
  });

  // The AI session ended (<Connect action>). HandoffData says why.
  router.post("/twilio/voice/handoff", (req, res) => {
    const ctx = load(req);
    if (!ctx) return sendTwiml(res, hangupTwiml());
    let action = "hangup";
    try {
      action = (JSON.parse(params(req).HandoffData ?? "{}") as { action?: string }).action ?? "hangup";
    } catch {
      /* no/invalid handoff data: the session just ended */
    }
    if (action === "transfer") return sendTwiml(res, dialTeamMember(deps, ctx.contractor, ctx.call, 0));
    scheduleFinalizeCheck(deps, ctx.call);
    if (action === "voicemail" && shouldLeaveVoicemail(ctx.contractor, ctx.call)) {
      return sendTwiml(res, voicemailTwiml(ctx.contractor, voicemailMessage(deps, ctx.contractor, ctx.lead)));
    }
    sendTwiml(res, hangupTwiml());
  });

  // Runs on the team member's phone when they answer, before the lead is connected.
  router.post("/twilio/voice/whisper", (req, res) => {
    const ctx = load(req);
    if (!ctx) return sendTwiml(res, hangupTwiml());
    const { lead, contractor } = ctx;
    const who = lead.name ?? "a new customer";
    const summary = lead.summary ?? Object.values(lead.details).slice(0, 3).join(". ");
    const message = `New ${sourceLabel(lead.source)} lead for ${contractor.name}: ${who}. ${summary}`;
    sendTwiml(res, whisperTwiml(contractor, message, voiceUrl(deps, "whisper-accept", { callId: ctx.call.id, idx: String(req.query.idx ?? "0") })));
  });

  router.post("/twilio/voice/whisper-accept", (req, res) => {
    const ctx = load(req);
    const idx = Number(req.query.idx ?? 0);
    if (!ctx || params(req).Digits !== "1") return sendTwiml(res, hangupTwiml());
    const target = ctx.contractor.settings.transferTargets[idx];
    repo.updateCall(ctx.call.id, { transferAcceptedBy: normalizePhone(target?.phone) ?? target?.phone ?? "unknown" });
    repo.addEvent({ contractorId: ctx.contractor.id, leadId: ctx.lead.id, callId: ctx.call.id, type: "transfer_accepted", message: `${target?.name ?? "Team member"} picked up` });
    sendTwiml(res, bridgeTwiml());
  });

  // The <Dial> to a team member finished: they talked, or nobody (accepted) answered.
  router.post("/twilio/voice/dial-result", (req, res) => {
    const ctx = load(req);
    if (!ctx) return sendTwiml(res, hangupTwiml());
    const p = params(req);
    const idx = Number(req.query.idx ?? 0);
    const accepted = (ctx.call.transferAcceptedBy !== null && ctx.call.transferIndex === idx) || p.DialBridged === "true";
    if (accepted) {
      repo.updateCall(ctx.call.id, { outcome: "transferred" });
      const lead = repo.setLeadStatus(ctx.lead.id, "transferred");
      repo.cancelPendingJobsForLead("call_lead", lead.id);
      repo.addEvent({ contractorId: ctx.contractor.id, leadId: lead.id, callId: ctx.call.id, type: "transferred", message: "Lead talked with the team" });
      emitWebhook(deps, ctx.contractor, "lead.transferred", leadPayload(lead));
      scheduleFinalizeCheck(deps, ctx.call);
      return sendTwiml(res, hangupTwiml());
    }
    if (p.CallStatus === "completed") {
      // The lead hung up while it rang.
      scheduleFinalizeCheck(deps, ctx.call);
      return sendTwiml(res, hangupTwiml());
    }
    sendTwiml(res, dialTeamMember(deps, ctx.contractor, ctx.call, idx + 1));
  });

  // Someone calls the contractor's Twilio number (often a lead calling back): the AI answers.
  router.post("/twilio/voice/inbound", (req, res) => {
    const p = params(req);
    const contractor = repo.getContractorByTwilioNumber(normalizePhone(p.To) ?? p.To ?? "");
    if (!contractor) return sendTwiml(res, hangupTwiml());
    const from = normalizePhone(p.From);
    const since = new Date(deps.clock().getTime() - 90 * 86_400_000).toISOString();
    let lead = from ? repo.findRecentLeadByPhone(contractor.id, from, since) : null;
    if (!lead) {
      lead = repo.createLead({ contractorId: contractor.id, source: "phone", phone: from, phoneRaw: p.From ?? null, status: "in_conversation" });
      repo.addEvent({ contractorId: contractor.id, leadId: lead.id, type: "lead_received", message: "New caller on the business line" });
      emitWebhook(deps, contractor, "lead.created", leadPayload(lead));
    }
    repo.cancelPendingJobsForLead("call_lead", lead.id);
    const existing = p.CallSid ? repo.getCallBySid(p.CallSid) : null;
    if (existing) return sendTwiml(res, relayTwiml(deps, contractor, existing));
    const call = repo.createCall({
      leadId: lead.id,
      contractorId: contractor.id,
      direction: "inbound",
      status: "in-progress",
      twilioCallSid: p.CallSid ?? null,
      reason: "inbound",
      startedAt: deps.clock().toISOString(),
    });
    repo.addEvent({ contractorId: contractor.id, leadId: lead.id, callId: call.id, type: "inbound_call", message: "Called the business line - AI answered" });
    sendTwiml(res, relayTwiml(deps, contractor, call, inboundGreeting(contractor, lead.name ? lead : null)));
  });

  // Texts to the contractor's number: opt-outs and replies to our messages.
  router.post("/twilio/sms/inbound", (req, res) => {
    const p = params(req);
    const contractor = repo.getContractorByTwilioNumber(normalizePhone(p.To) ?? p.To ?? "");
    const from = normalizePhone(p.From);
    if (contractor && from) {
      const since = new Date(deps.clock().getTime() - 180 * 86_400_000).toISOString();
      const lead = repo.findRecentLeadByPhone(contractor.id, from, since);
      const body = (p.Body ?? "").trim();
      if (/^(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout)$/i.test(body)) {
        if (lead) {
          repo.setLeadStatus(lead.id, "do_not_call");
          repo.cancelPendingJobsForLead("call_lead", lead.id);
          repo.addEvent({ contractorId: contractor.id, leadId: lead.id, type: "do_not_call", message: "Texted STOP" });
        }
      } else if (body) {
        if (lead) repo.addEvent({ contractorId: contractor.id, leadId: lead.id, type: "sms_received", message: body.slice(0, 1000) });
        alertTeam(deps, contractor, lead, messages.teamLeadReplied(deps, lead, from, body), "lead_replied");
        emitWebhook(deps, contractor, "sms.received", { from, body, lead: lead ? leadPayload(lead) : null });
      }
    }
    sendTwiml(res, emptyMessagingTwiml());
  });

  return router;
}
