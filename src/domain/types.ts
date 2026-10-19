import type Anthropic from "@anthropic-ai/sdk";
import type { ContractorSettings } from "./settings.js";

export type LeadSource = "facebook" | "google" | "website" | "phone" | "test";

export type LeadStatus =
  | "new" // just arrived, AI call queued
  | "scheduled" // arrived outside calling hours; call queued for when hours open
  | "calling" // phone is ringing
  | "in_conversation" // talking with the AI
  | "transferring" // ringing the owner/manager
  | "transferred" // lead spoke with a team member
  | "booked" // estimate on the calendar
  | "retry_scheduled" // didn't answer; another attempt queued
  | "callback_scheduled" // asked us to call back at a set time
  | "needs_followup" // a human should follow up (hung up mid-call, request-only booking, errors)
  | "not_interested"
  | "do_not_call"
  | "wrong_number"
  | "unreachable" // all attempts used up
  | "invalid_phone";

/** Statuses where the system stops dialing the lead automatically. */
export const TERMINAL_LEAD_STATUSES: ReadonlySet<LeadStatus> = new Set([
  "transferred",
  "booked",
  "needs_followup",
  "not_interested",
  "do_not_call",
  "wrong_number",
  "unreachable",
  "invalid_phone",
]);

export interface Contractor {
  id: string;
  name: string;
  timezone: string;
  twilioNumber: string | null;
  publicKey: string;
  googleAdsKey: string;
  settings: ContractorSettings;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Lead {
  id: string;
  contractorId: string;
  source: LeadSource;
  externalId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  phoneRaw: string | null;
  address: string | null;
  zip: string | null;
  /** Answers exactly as submitted on the form. */
  formAnswers: Record<string, string>;
  /** Details the AI collected on the phone (keys = contractor question keys). */
  details: Record<string, string>;
  summary: string | null;
  status: LeadStatus;
  callAttempts: number;
  appointmentStart: string | null;
  appointmentEnd: string | null;
  appointmentEventId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type CallDirection = "outbound" | "inbound";
export type CallPhase = "qualify" | "transferring" | "booking" | "ended";
/** Why the call happened: first call, a re-dial, a requested callback, or the lead calling in. */
export type CallReason = "new" | "retry" | "callback" | "inbound";

export type CallOutcome =
  | "transferred"
  | "booked"
  | "booking_requested"
  | "voicemail"
  | "no_answer"
  | "failed"
  | "hung_up"
  | "not_interested"
  | "do_not_call"
  | "wrong_number"
  | "already_hired"
  | "call_back_later"
  | "completed"
  | "error";

export interface TranscriptEntry {
  role: "assistant" | "caller" | "system";
  text: string;
  at: string;
}

export interface Call {
  id: string;
  leadId: string;
  contractorId: string;
  direction: CallDirection;
  attempt: number;
  reason: CallReason | null;
  twilioCallSid: string | null;
  /** Twilio call status: queued | ringing | in-progress | completed | busy | no-answer | failed | canceled */
  status: string;
  answeredBy: string | null;
  phase: CallPhase;
  outcome: CallOutcome | null;
  transferIndex: number;
  transferAcceptedBy: string | null;
  /** Claude conversation history, replayed verbatim when the AI reconnects after a failed transfer. */
  conversation: Anthropic.Beta.BetaMessageParam[];
  /** Tool results held back until the AI session resumes (the transfer tool's result is its outcome). */
  pendingToolResults: Anthropic.Beta.BetaToolResultBlockParam[];
  transcript: TranscriptEntry[];
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  postProcessedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FacebookPage {
  pageId: string;
  contractorId: string;
  pageName: string | null;
  /** Encrypted page access token. */
  accessToken: string;
  createdAt: string;
}

export interface CalendarConnection {
  contractorId: string;
  provider: "google";
  accountEmail: string | null;
  /** Encrypted. */
  refreshToken: string;
  /** Encrypted. */
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  runAt: string;
  status: "pending" | "running" | "done" | "failed" | "canceled";
  attempts: number;
  lastError: string | null;
  dedupeKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadEvent {
  id: number;
  contractorId: string | null;
  leadId: string | null;
  callId: string | null;
  type: string;
  message: string | null;
  data: Record<string, unknown> | null;
  createdAt: string;
}
