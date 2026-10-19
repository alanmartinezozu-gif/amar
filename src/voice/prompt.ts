import type { BookingMode } from "../calendar/service.js";
import type { CallDirection, CallReason, Contractor, Lead } from "../domain/types.js";
import { formatPhone } from "../lib/phone.js";
import { localNow } from "../lib/hours.js";
import { firstName, sourceLabel } from "../notify/notify.js";
import type { BetaTextBlockParam, BetaTool } from "./llm.js";

export const END_OUTCOMES = [
  "completed",
  "not_interested",
  "already_hired",
  "wrong_number",
  "do_not_call",
  "call_back_later",
  "voicemail",
  "other",
] as const;

/**
 * The system prompt depends only on the contractor's settings, so it stays byte-identical for
 * every turn of a call (and across calls) - which keeps the prompt cache warm. Everything about
 * this particular lead and moment goes in the first user message (buildCallContext).
 */
export function buildSystemPrompt(contractor: Contractor): BetaTextBlockParam[] {
  const s = contractor.settings;
  const company = contractor.name;
  const about = [s.services && `a ${s.services} company`, s.serviceArea && `serving ${s.serviceArea}`].filter(Boolean).join(" ");
  const questions = s.questions
    .map((q) => `- ${q.key}${q.required ? " (required)" : " (optional)"}: ${q.question}`)
    .join("\n");

  const text = `You are ${s.assistantName}, the phone assistant for ${company}${about ? `, ${about}` : ""}. You are an AI, and you are on a live phone call. The people you talk to just asked ${company} for a quote - usually a homeowner dealing with a problem at their property.

# Your goal on every call
1. Make sure you're talking to the right person and that now is an OK time.
2. Learn what they need and what they're dealing with, so the team can prepare the quote. Cover the questions below one at a time, in whatever order feels natural. Save answers with save_job_details as you learn them.
3. Get them to the team:
   - If the call context says live transfer is available: once the required questions are covered (or right away if it's urgent or they ask for a person), call transfer_to_team.
   - Otherwise, or if the transfer doesn't connect: book an estimate. Call check_availability, offer two or three of the times it returns, confirm the property address, then call book_appointment with the slot they choose.
4. Wrap up politely and call end_call.

# Questions to cover
${questions}
Skip anything they already answered on the form or earlier in the call. Required questions matter most; don't push on optional ones if they'd rather not say.

# How to talk
- This is a phone call. Sound like a friendly, competent person from the office: warm, relaxed and brief. Say one or two short sentences, then let them talk. Usually end your turn with a question.
- Use plain spoken English only. No lists, markdown, emoji or symbols. Say numbers, dates and times the way a person would ("Tuesday at nine in the morning").
- Speech recognition makes mistakes, especially with names, addresses and numbers. Repeat addresses and appointment times back to confirm them. If something doesn't make sense, ask them to say it again.
- Acknowledge what they tell you and show a little empathy for their problem, without overdoing it.
- If they ask whether you're a real person, say honestly that you're ${company}'s AI assistant and that a real person from the team will take care of their job.
- Never make up prices, timelines, warranties, availability or facts about ${company}. If they ask about price, explain the estimate is free and the team will give an exact price once they see the job, unless the company notes below say otherwise.
- Answer directly without deliberating - the caller is waiting on the line.

# Special situations
- Danger to people (fire, gas smell, sparking wires, flooding near electrical, injuries): tell them to hang up and call 911 first.
- Not interested, already hired someone, or wrong number: be gracious and call end_call with the matching outcome.
- They ask not to be called again: apologize, tell them they won't be contacted again, and call end_call with outcome do_not_call.
- Bad time to talk: ask when to call back, then call end_call with outcome call_back_later and the callback_time.
- A voicemail greeting or an automated phone menu answers: call end_call with outcome voicemail immediately, without saying anything.
- A question you can't answer: say you'll make sure the team covers it, and put it in the notes.

# Using the tools
- transfer_to_team and end_call speak for you: put what you'd say in say_to_caller or closing_line, and don't say it again in your message.
- Only offer appointment times that check_availability returned, and book with the exact slot_id it gave.
- Times in tool results are already in ${company}'s local time.

# About ${company}
${s.customInstructions.trim() || "No extra company notes."}`;

  return [{ type: "text", text }];
}

export function buildTools(contractor: Contractor): BetaTool[] {
  const detailProps: Record<string, { type: "string"; description: string }> = {};
  for (const q of contractor.settings.questions) detailProps[q.key] = { type: "string", description: q.question };
  detailProps.caller_name = { type: "string", description: "The caller's name, if it differs from the form or they corrected it." };
  detailProps.email = { type: "string", description: "Email address, if they give or correct one." };
  detailProps.notes = { type: "string", description: "Anything else the team should know (access, pets, photos, questions you couldn't answer)." };

  const tools: BetaTool[] = [
    {
      name: "save_job_details",
      description:
        "Save details the caller shared about their project. Call it whenever you learn something new; you can call it many times, and later values replace earlier ones. Only include fields you have new information for.",
      input_schema: { type: "object", properties: detailProps, additionalProperties: false },
    },
    {
      name: "transfer_to_team",
      description:
        "Connect the caller live with the owner or manager. Use it when the required details are covered and the call context says live transfer is available (or when it's urgent or they insist on a person). If nobody picks up, the call comes back to you to book an appointment.",
      input_schema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "One or two sentences the team member hears before picking up, e.g. 'John Smith in Round Rock, roof leak over the kitchen, wants an estimate this week.'",
          },
          say_to_caller: {
            type: "string",
            description: "What to tell the caller while you connect them, e.g. 'Perfect, let me get Mike on the line for you. One sec!'",
          },
        },
        required: ["summary", "say_to_caller"],
        additionalProperties: false,
      },
    },
    {
      name: "check_availability",
      description: "Look up open appointment times for an in-person estimate. Returns a few options in the company's local time.",
      input_schema: {
        type: "object",
        properties: {
          preferred_date: { type: "string", description: "Earliest local date to look from, YYYY-MM-DD. Omit for the soonest openings." },
          time_of_day: { type: "string", enum: ["morning", "afternoon", "evening", "any"] },
        },
        additionalProperties: false,
      },
    },
    {
      name: "book_appointment",
      description: "Book the estimate once the caller picked a time from check_availability and confirmed the address.",
      input_schema: {
        type: "object",
        properties: {
          slot_id: { type: "string", description: "The slot_id exactly as check_availability returned it." },
          address: { type: "string", description: "Full property address, confirmed with the caller." },
          notes: { type: "string", description: "Anything the estimator should know before arriving." },
        },
        required: ["slot_id", "address"],
        additionalProperties: false,
      },
    },
    {
      name: "end_call",
      description: "Say goodbye and hang up. Use it to finish every call, including after booking, transferring isn't possible, or the caller wants to go.",
      input_schema: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: [...END_OUTCOMES] },
          closing_line: {
            type: "string",
            description: "Your goodbye, e.g. 'Thanks John, you'll get a text confirmation shortly. Have a great day!' Use an empty string for voicemail.",
          },
          notes: { type: "string", description: "Anything the team should know about how the call went." },
          callback_time: {
            type: "string",
            description: "For call_back_later: when to call back, local time as YYYY-MM-DDTHH:MM.",
          },
        },
        required: ["outcome", "closing_line"],
        additionalProperties: false,
      },
    },
  ];
  // Stream tool arguments as they're generated; inputs are validated before any tool runs.
  return tools.map((t) => ({ ...t, eager_input_streaming: true }));
}

export interface CallContextInput {
  contractor: Contractor;
  lead: Lead;
  direction: CallDirection;
  now: Date;
  transfer: { available: boolean; reason?: string };
  bookingMode: BookingMode;
  previousAttempts: number;
  reason?: CallReason;
}

export function buildCallContext(c: CallContextInput): string {
  const { contractor, lead } = c;
  const s = contractor.settings;
  const local = localNow(contractor.timezone, c.now).toFormat("cccc, LLLL d, yyyy, h:mm a");
  const how =
    c.direction === "inbound"
      ? `inbound - they called ${contractor.name}'s phone number.`
      : c.reason === "callback"
        ? `outbound - you're calling them back at the time they asked for.`
        : c.previousAttempts > 0
          ? `outbound - a follow-up attempt; they didn't pick up the first ${c.previousAttempts === 1 ? "time" : `${c.previousAttempts} times`}. They asked for a quote ${lead.source === "phone" ? "" : `on ${sourceLabel(lead.source)} `}a little while ago.`
          : `outbound - you're calling them seconds after they submitted a quote request${lead.source === "phone" || lead.source === "test" ? "" : ` on ${sourceLabel(lead.source)}`}.`;

  const team = s.transferTargets.map((t) => `${t.name} (${t.role})`).join(", then ");
  const transfer = c.transfer.available
    ? `available - transfer_to_team rings ${team}.`
    : `NOT available on this call (${c.transfer.reason ?? "unavailable"}). Book an estimate instead.`;
  const booking =
    c.bookingMode === "calendar"
      ? "live calendar - check_availability returns real open times and book_appointment puts it on the calendar."
      : "no calendar connected - check_availability returns times within booking hours; tell the caller the team will text to confirm the exact time.";

  const submitted: string[] = [];
  if (lead.name) submitted.push(`Name: ${lead.name}`);
  if (lead.phone) submitted.push(`Phone: ${formatPhone(lead.phone)}`);
  if (lead.email) submitted.push(`Email: ${lead.email}`);
  if (lead.address) submitted.push(`Address: ${lead.address}`);
  else if (lead.zip) submitted.push(`Zip: ${lead.zip}`);
  for (const [k, v] of Object.entries(lead.formAnswers)) submitted.push(`${k}: ${v}`);
  const collected = Object.entries(lead.details).map(([k, v]) => `${k}: ${v}`);

  return [
    "<call_context>",
    `This call: ${how}`,
    `Local time at ${contractor.name}: ${local} (${contractor.timezone})`,
    `Live transfer: ${transfer}`,
    `Appointments: ${booking}`,
    submitted.length ? `What they submitted:\n- ${submitted.join("\n- ")}` : "What they submitted: nothing besides their phone number.",
    collected.length ? `Already collected on earlier calls:\n- ${collected.join("\n- ")}` : "",
    lead.summary ? `Notes from earlier calls: ${lead.summary}` : "",
    "</call_context>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** First thing the AI says on an outbound call, spoken instantly (no model round-trip). */
export function outboundOpener(contractor: Contractor, lead: Lead, reason?: CallReason): string {
  const s = contractor.settings;
  const first = firstName(lead.name);
  const intro = `Hi, this is ${s.assistantName}, ${contractor.name}'s virtual assistant`;
  if (reason === "callback") {
    return first ? `${intro}, calling you back like you asked. Is this ${first}?` : `${intro}, calling you back like you asked. Is now a better time?`;
  }
  return first ? `${intro}. Am I speaking with ${first}?` : `${intro}, calling about the quote you just requested. Do you have a quick minute?`;
}

export function inboundGreeting(contractor: Contractor, lead: Lead | null): string {
  const s = contractor.settings;
  const first = firstName(lead?.name);
  return first
    ? `Thanks for calling ${contractor.name}! This is ${s.assistantName}, the virtual assistant. Is this ${first}?`
    : `Thanks for calling ${contractor.name}! This is ${s.assistantName}, the virtual assistant. How can I help you today?`;
}

/** Spoken by Twilio when the AI picks the call back up after nobody on the team answered. */
export function bookingResumeGreeting(contractor: Contractor): string {
  const who = contractor.settings.transferTargets[0]?.name ?? "the team";
  const what = contractor.settings.booking.appointmentTitle.toLowerCase();
  return `Thanks for holding! Looks like ${who} is tied up on a job right now, so let's get you on the schedule for a ${what} instead. What day works best for you?`;
}
