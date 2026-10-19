import express, { type Request, type Response } from "express";
import type { Deps } from "../deps.js";
import { ContractorSettingsSchema, parseHoursText, type ContractorSettings } from "../domain/settings.js";
import type { Contractor, LeadStatus } from "../domain/types.js";
import { signToken } from "../lib/crypto.js";
import { isValidTimezone } from "../lib/hours.js";
import { normalizePhone } from "../lib/phone.js";
import { ingestLead } from "../leads/intake.js";
import { googleAuthUrl } from "../calendar/google.js";
import { connectFacebookPage, facebookAuthUrl } from "../sources/facebook.js";
import { basicAuth, csrf } from "./auth.js";
import { finishFacebookSelection } from "./oauth.js";
import {
  contractorPage,
  dashboardPage,
  leadPage,
  leadsPage,
  messagePage,
  newContractorPage,
  type PageOptions,
} from "./views.js";

type Body = Record<string, string | string[] | undefined>;

function str(body: Body, key: string): string {
  const v = body[key];
  return (Array.isArray(v) ? v[0] : v ?? "").trim();
}

function pageOpts(req: Request, res: Response): PageOptions {
  const ok = typeof req.query.ok === "string" ? req.query.ok : null;
  const err = typeof req.query.error === "string" ? req.query.error : null;
  return {
    csrf: String(res.locals.csrf ?? ""),
    flash: err ? { kind: "bad", text: err.slice(0, 300) } : ok ? { kind: "ok", text: ok.slice(0, 300) } : null,
  };
}

function back(res: Response, path: string, msg: { ok?: string; error?: string }): void {
  const q = new URLSearchParams(msg as Record<string, string>);
  res.redirect(303, `${path}?${q}`);
}

function lines(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("|").map((p) => p.trim()));
}

function num(body: Body, key: string, fallback: number): number {
  const raw = str(body, key);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}

/** Turn the settings form into a validated settings object. Throws with a readable message. */
export function settingsFromForm(body: Body, current: ContractorSettings): ContractorSettings {
  const transferTargets = lines(str(body, "transferTargets")).map(([name, role, phone], i) => {
    const e164 = normalizePhone(phone ?? role);
    if (!name || !e164) throw new Error(`Transfer line ${i + 1}: use "Name | Role | Phone"`);
    return { name, role: phone ? role || "Team" : "Team", phone: e164 };
  });
  const questions = lines(str(body, "questions")).map(([key, question, req], i) => {
    if (!key || !question) throw new Error(`Question line ${i + 1}: use "key | question | required"`);
    return { key: key.toLowerCase().replace(/[^a-z0-9_]/g, "_"), question, required: /^req/i.test(req ?? "") };
  });
  const alertPhones = str(body, "alertPhones")
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((p) => {
      const e164 = normalizePhone(p);
      if (!e164) throw new Error(`Alert phone "${p}" isn't a valid number`);
      return e164;
    });
  const retryDelaysMinutes = str(body, "retryDelaysMinutes")
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((x) => {
      const n = Number(x);
      if (!Number.isInteger(n) || n < 1) throw new Error("Re-dial delays must be whole minutes");
      return n;
    });
  const optional = (key: string) => str(body, key) || undefined;

  const candidate = {
    ...current,
    assistantName: str(body, "assistantName") || current.assistantName,
    services: str(body, "services"),
    serviceArea: str(body, "serviceArea"),
    customInstructions: str(body, "customInstructions"),
    thankYouMessage: str(body, "thankYouMessage") || current.thankYouMessage,
    callDelaySeconds: num(body, "callDelaySeconds", current.callDelaySeconds),
    callingHours: parseHoursText(str(body, "callingHours")),
    transferHours: parseHoursText(str(body, "transferHours")),
    transferTargets,
    transferRingSeconds: num(body, "transferRingSeconds", current.transferRingSeconds),
    questions: questions.length ? questions : current.questions,
    booking: {
      hours: parseHoursText(str(body, "bookingHours")),
      durationMinutes: num(body, "durationMinutes", current.booking.durationMinutes),
      bufferMinutes: num(body, "bufferMinutes", current.booking.bufferMinutes),
      minNoticeHours: num(body, "minNoticeHours", current.booking.minNoticeHours),
      daysAhead: num(body, "daysAhead", current.booking.daysAhead),
      slotIntervalMinutes: num(body, "slotIntervalMinutes", current.booking.slotIntervalMinutes),
      appointmentTitle: str(body, "appointmentTitle") || current.booking.appointmentTitle,
      calendarId: str(body, "calendarId") || "primary",
    },
    retryDelaysMinutes,
    voicemail: str(body, "voicemail") || current.voicemail,
    sms: {
      instantReply: str(body, "sms_instantReply") === "1",
      missedCall: str(body, "sms_missedCall") === "1",
      bookingConfirmation: str(body, "sms_bookingConfirmation") === "1",
      teamAlerts: str(body, "sms_teamAlerts") === "1",
    },
    alertPhones,
    voice: {
      language: str(body, "voice_language") || "en-US",
      ttsProvider: optional("voice_ttsProvider"),
      voice: optional("voice_voice"),
      transcriptionProvider: optional("voice_transcriptionProvider"),
      speechModel: optional("voice_speechModel"),
      sayVoice: str(body, "voice_sayVoice") || current.voice.sayVoice,
    },
    webhookUrl: str(body, "webhookUrl"),
    dedupeMinutes: num(body, "dedupeMinutes", current.dedupeMinutes),
  };
  const parsed = ContractorSettingsSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

const MANUAL_STATUSES = new Set<LeadStatus>([
  "new",
  "needs_followup",
  "booked",
  "transferred",
  "not_interested",
  "do_not_call",
  "wrong_number",
  "unreachable",
  "invalid_phone",
  "retry_scheduled",
  "callback_scheduled",
  "scheduled",
  "calling",
  "in_conversation",
  "transferring",
]);

export function adminRouter(deps: Deps): express.Router {
  const router = express.Router();
  const { repo } = deps;
  router.use("/admin", basicAuth(deps.config), csrf());

  const contractorOr404 = (req: Request, res: Response): Contractor | null => {
    const c = repo.getContractor(String(req.params.id));
    if (!c) res.status(404).send(messagePage("Not found", "That contractor doesn't exist.", pageOpts(req, res)));
    return c;
  };

  router.get("/admin", (req, res) => {
    const since = new Date(deps.clock().getTime() - 7 * 86_400_000).toISOString();
    res.send(
      dashboardPage(
        {
          contractors: repo.listContractors(),
          leads: repo.listLeads({ limit: 25 }),
          counts: repo.leadStatusCounts(undefined, since),
          medianSeconds: repo.medianSecondsToFirstCall(since),
          now: deps.clock(),
        },
        pageOpts(req, res),
      ),
    );
  });

  router.get("/admin/leads", (req, res) => {
    const filter = {
      contractor: typeof req.query.contractor === "string" && req.query.contractor ? req.query.contractor : undefined,
      status: typeof req.query.status === "string" && req.query.status ? req.query.status : undefined,
    };
    res.send(
      leadsPage(
        {
          leads: repo.listLeads({ contractorId: filter.contractor, status: filter.status, limit: 200 }),
          contractors: repo.listContractors(),
          filter,
          now: deps.clock(),
        },
        pageOpts(req, res),
      ),
    );
  });

  router.get("/admin/contractors/new", (req, res) => {
    res.send(newContractorPage(pageOpts(req, res)));
  });

  router.post("/admin/contractors", (req, res) => {
    const body = req.body as Body;
    const name = str(body, "name");
    const timezone = str(body, "timezone") || "America/Chicago";
    const rawNumber = str(body, "twilioNumber");
    const twilioNumber = rawNumber ? normalizePhone(rawNumber) : null;
    const problem = !name
      ? "Company name is required"
      : !isValidTimezone(timezone)
        ? `Unknown time zone "${timezone}"`
        : rawNumber && !twilioNumber
          ? "That Twilio number isn't valid"
          : twilioNumber && repo.getContractorByTwilioNumber(twilioNumber)
            ? "Another contractor already uses that Twilio number"
            : null;
    if (problem) {
      res.status(400).send(newContractorPage({ ...pageOpts(req, res), flash: { kind: "bad", text: problem } }, { name, timezone, twilioNumber: rawNumber }));
      return;
    }
    const contractor = repo.createContractor({ name, timezone, twilioNumber, settings: { services: "home improvement" } });
    back(res, `/admin/contractors/${contractor.id}`, { ok: "Contractor created. Connect their lead sources below." });
  });

  router.get("/admin/contractors/:id", (req, res) => {
    const contractor = contractorOr404(req, res);
    if (!contractor) return;
    res.send(
      contractorPage(
        {
          contractor,
          pages: repo.listFacebookPages(contractor.id),
          calendar: repo.getCalendarConnection(contractor.id),
          baseUrl: deps.config.PUBLIC_BASE_URL,
          facebookEnabled: Boolean(deps.config.FACEBOOK_APP_ID && deps.config.FACEBOOK_APP_SECRET),
          googleEnabled: Boolean(deps.config.GOOGLE_CLIENT_ID && deps.config.GOOGLE_CLIENT_SECRET),
          defaultNumber: deps.config.TWILIO_DEFAULT_NUMBER ?? null,
          leads: repo.listLeads({ contractorId: contractor.id, limit: 10 }),
          now: deps.clock(),
        },
        pageOpts(req, res),
      ),
    );
  });

  router.post("/admin/contractors/:id/settings", (req, res) => {
    const contractor = contractorOr404(req, res);
    if (!contractor) return;
    const body = req.body as Body;
    const path = `/admin/contractors/${contractor.id}`;
    try {
      const name = str(body, "name");
      const timezone = str(body, "timezone");
      const rawNumber = str(body, "twilioNumber");
      const twilioNumber = rawNumber ? normalizePhone(rawNumber) : null;
      if (!name) throw new Error("Company name is required");
      if (!isValidTimezone(timezone)) throw new Error(`Unknown time zone "${timezone}"`);
      if (rawNumber && !twilioNumber) throw new Error("That Twilio number isn't valid");
      const owner = twilioNumber ? repo.getContractorByTwilioNumber(twilioNumber) : null;
      if (owner && owner.id !== contractor.id) throw new Error(`${owner.name} already uses that Twilio number`);
      const settings = settingsFromForm(body, contractor.settings);
      repo.updateContractor(contractor.id, { name, timezone, twilioNumber, active: str(body, "active") === "1", settings });
      back(res, path, { ok: "Settings saved." });
    } catch (err) {
      back(res, path, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/admin/contractors/:id/test-lead", (req, res) => {
    const contractor = contractorOr404(req, res);
    if (!contractor) return;
    const body = req.body as Body;
    if (!normalizePhone(str(body, "phone"))) {
      back(res, `/admin/contractors/${contractor.id}`, { error: "Enter a valid phone number for the test lead." });
      return;
    }
    const result = ingestLead(deps, contractor, {
      source: "test",
      name: str(body, "name") || "Test Lead",
      phone: str(body, "phone"),
      answers: str(body, "message") ? { "What do you need help with?": str(body, "message") } : {},
      metadata: { test: true },
    });
    if (result.outcome === "duplicate") {
      back(res, `/admin/leads/${result.lead.id}`, { error: "That phone already has a lead in the last few minutes - merged into it instead of calling again." });
      return;
    }
    back(res, `/admin/leads/${result.lead.id}`, {
      ok: result.callAt ? `Test lead created. The AI calls at ${result.callAt.toLocaleTimeString()}.` : "Test lead created.",
    });
  });

  router.post("/admin/contractors/:id/twilio-configure", async (req, res) => {
    const contractor = contractorOr404(req, res);
    if (!contractor) return;
    const path = `/admin/contractors/${contractor.id}`;
    if (!contractor.twilioNumber) return back(res, path, { error: "Set a Twilio number first." });
    try {
      await deps.telephony.configureNumber({
        phoneNumber: contractor.twilioNumber,
        voiceUrl: `${deps.config.PUBLIC_BASE_URL}/twilio/voice/inbound`,
        statusCallbackUrl: `${deps.config.PUBLIC_BASE_URL}/twilio/voice/status`,
        smsUrl: `${deps.config.PUBLIC_BASE_URL}/twilio/sms/inbound`,
      });
      back(res, path, { ok: "Twilio number configured: inbound calls and texts now go to the AI." });
    } catch (err) {
      back(res, path, { error: `Twilio: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  router.post("/admin/contractors/:id/facebook-pages", async (req, res) => {
    const contractor = contractorOr404(req, res);
    if (!contractor) return;
    const body = req.body as Body;
    const path = `/admin/contractors/${contractor.id}`;
    const pageId = str(body, "pageId");
    const token = str(body, "accessToken");
    if (!/^\d+$/.test(pageId) || !token) return back(res, path, { error: "Page ID (numbers only) and page access token are required." });
    try {
      await connectFacebookPage(deps, contractor.id, { id: pageId, name: str(body, "pageName") || pageId, access_token: token });
      back(res, path, { ok: "Facebook page connected and subscribed to lead ads." });
    } catch (err) {
      back(res, path, { error: `Facebook: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  router.post("/admin/contractors/:id/facebook-pages/:pageId/delete", (req, res) => {
    const contractor = contractorOr404(req, res);
    if (!contractor) return;
    const page = repo.getFacebookPage(String(req.params.pageId));
    if (page?.contractorId === contractor.id) repo.deleteFacebookPage(page.pageId);
    back(res, `/admin/contractors/${contractor.id}`, { ok: "Page removed. (Its webhook subscription stays until you remove the app in Facebook.)" });
  });

  router.post("/admin/contractors/:id/calendar/delete", (req, res) => {
    const contractor = contractorOr404(req, res);
    if (!contractor) return;
    repo.deleteCalendarConnection(contractor.id);
    back(res, `/admin/contractors/${contractor.id}`, { ok: "Calendar disconnected." });
  });

  router.get("/admin/contractors/:id/connect/facebook", (req, res) => {
    const contractor = contractorOr404(req, res);
    if (!contractor) return;
    try {
      res.redirect(facebookAuthUrl(deps.config, signToken({ c: contractor.id, p: "facebook" }, deps.config.APP_SECRET, 900)));
    } catch (err) {
      back(res, `/admin/contractors/${contractor.id}`, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/admin/contractors/:id/connect/google", (req, res) => {
    const contractor = contractorOr404(req, res);
    if (!contractor) return;
    try {
      res.redirect(googleAuthUrl(deps.config, signToken({ c: contractor.id, p: "google" }, deps.config.APP_SECRET, 900)));
    } catch (err) {
      back(res, `/admin/contractors/${contractor.id}`, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/admin/leads/:id", (req, res) => {
    const lead = repo.getLead(String(req.params.id));
    if (!lead) {
      res.status(404).send(messagePage("Not found", "That lead doesn't exist.", pageOpts(req, res)));
      return;
    }
    res.send(
      leadPage(
        {
          lead,
          contractor: repo.getContractor(lead.contractorId)!,
          calls: repo.listCallsForLead(lead.id),
          events: repo.listEventsForLead(lead.id),
          pendingJobs: repo.pendingJobsForLead(lead.id),
          now: deps.clock(),
        },
        pageOpts(req, res),
      ),
    );
  });

  router.post("/admin/leads/:id/call-now", (req, res) => {
    const lead = repo.getLead(String(req.params.id));
    if (!lead) return res.sendStatus(404);
    const path = `/admin/leads/${lead.id}`;
    if (!lead.phone) return back(res, path, { error: "This lead has no valid phone number." });
    if (lead.status === "do_not_call") return back(res, path, { error: "This lead asked not to be called." });
    // An explicit "call now" overrides a terminal status like needs_followup.
    repo.cancelPendingJobsForLead("call_lead", lead.id);
    if (lead.status !== "new") repo.setLeadStatus(lead.id, "new");
    deps.jobs.enqueue("call_lead", { leadId: lead.id, reason: lead.callAttempts > 0 ? "retry" : "new" }, deps.clock(), `call_lead:${lead.id}`);
    repo.addEvent({ contractorId: lead.contractorId, leadId: lead.id, type: "manual_call", message: "Call requested from the dashboard" });
    back(res, path, { ok: "Calling now." });
  });

  router.post("/admin/leads/:id/status", (req, res) => {
    const lead = repo.getLead(String(req.params.id));
    if (!lead) return res.sendStatus(404);
    const status = str(req.body as Body, "status") as LeadStatus;
    if (!MANUAL_STATUSES.has(status)) return back(res, `/admin/leads/${lead.id}`, { error: "Unknown status" });
    repo.setLeadStatus(lead.id, status);
    if (status === "do_not_call" || status === "not_interested" || status === "booked" || status === "transferred") {
      repo.cancelPendingJobsForLead("call_lead", lead.id);
    }
    repo.addEvent({ contractorId: lead.contractorId, leadId: lead.id, type: "status_changed", message: `Status set to ${status} from the dashboard` });
    back(res, `/admin/leads/${lead.id}`, { ok: "Status updated." });
  });

  // The Facebook page picker posts back here (an encrypted list of pages + their tokens).
  router.post("/admin/oauth/facebook/select", (req, res) => finishFacebookSelection(deps, req, res));

  return router;
}
