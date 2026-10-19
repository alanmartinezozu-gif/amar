import { z } from "zod";
import { SlotTakenError } from "../calendar/service.js";
import type { Deps } from "../deps.js";
import type { Call, Contractor, Lead } from "../domain/types.js";
import { speakableDateTime } from "../lib/hours.js";
import { alertTeam, emitWebhook, leadPayload, messages, queueSms } from "../notify/notify.js";
import { transferAvailability } from "./outcomes.js";
import { END_OUTCOMES } from "./prompt.js";

export interface ToolContext {
  deps: Deps;
  contractor: Contractor;
  callId: string;
  /** Set when something went wrong that a human should look at after the call. */
  flagFollowUp(reason: string): void;
}

export type Terminal =
  | { kind: "transfer"; summary: string; say: string }
  | { kind: "end"; outcome: (typeof END_OUTCOMES)[number]; closing: string; notes?: string; callbackTime?: string };

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  /** The call leaves the AI after this tool (transfer or hang up). */
  terminal?: Terminal;
}

const TransferInput = z.object({ summary: z.string().min(1), say_to_caller: z.string().default("") });
const AvailabilityInput = z.object({
  preferred_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time_of_day: z.enum(["morning", "afternoon", "evening", "any"]).optional(),
});
const BookInput = z.object({ slot_id: z.string().min(1), address: z.string().min(3), notes: z.string().optional() });
const EndInput = z.object({
  outcome: z.enum(END_OUTCOMES),
  closing_line: z.string().default(""),
  notes: z.string().optional(),
  callback_time: z.string().optional(),
});

function json(value: unknown): string {
  return JSON.stringify(value);
}

function invalid(error: z.ZodError): ToolOutcome {
  return { content: `Invalid input: ${error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, isError: true };
}

function freshCall(ctx: ToolContext): Call {
  return ctx.deps.repo.getCall(ctx.callId)!;
}

function freshLead(ctx: ToolContext, call: Call): Lead {
  return ctx.deps.repo.getLead(call.leadId)!;
}

function missingRequired(contractor: Contractor, lead: Lead): string[] {
  return contractor.settings.questions.filter((q) => q.required && !lead.details[q.key]).map((q) => q.key);
}

export async function executeTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolOutcome> {
  const { deps, contractor } = ctx;
  const call = freshCall(ctx);
  const lead = freshLead(ctx, call);

  switch (name) {
    case "save_job_details": {
      const input = z.record(z.string(), z.unknown()).safeParse(rawInput ?? {});
      if (!input.success) return invalid(input.error);
      const allowed = new Set([...contractor.settings.questions.map((q) => q.key), "caller_name", "email", "notes"]);
      const details = { ...lead.details };
      const patch: Partial<Lead> = {};
      for (const [k, v] of Object.entries(input.data)) {
        if (!allowed.has(k) || typeof v !== "string" || !v.trim()) continue;
        const value = v.trim().slice(0, 1000);
        if (k === "caller_name") patch.name = value;
        else if (k === "email") patch.email = value;
        else details[k] = value;
      }
      if (details.property_address && !lead.address) patch.address = details.property_address;
      const updated = deps.repo.updateLead(lead.id, { ...patch, details });
      const missing = missingRequired(contractor, updated);
      return { content: json({ saved: true, still_needed: missing }) };
    }

    case "transfer_to_team": {
      const input = TransferInput.safeParse(rawInput);
      if (!input.success) return invalid(input.error);
      const availability = transferAvailability(contractor, call, deps.clock());
      if (!availability.available) {
        return {
          content: json({ transferred: false, reason: `Live transfer isn't available: ${availability.reason}. Offer to book an estimate instead.` }),
        };
      }
      deps.repo.updateLead(lead.id, { summary: input.data.summary });
      return {
        content: "",
        terminal: { kind: "transfer", summary: input.data.summary, say: input.data.say_to_caller },
      };
    }

    case "check_availability": {
      const input = AvailabilityInput.safeParse(rawInput ?? {});
      if (!input.success) return invalid(input.error);
      try {
        const slots = await deps.calendar.findSlots(contractor, {
          preferredDate: input.data.preferred_date,
          timeOfDay: input.data.time_of_day,
          limit: 4,
        });
        if (slots.length === 0) {
          return {
            content: json({
              slots: [],
              note: `No openings in the next ${contractor.settings.booking.daysAhead} days for that preference. Try another day or time of day, or let them know the team will call to schedule.`,
            }),
          };
        }
        return {
          content: json({
            mode: deps.calendar.mode(contractor),
            slots: slots.map((s) => ({ slot_id: s.start.toISOString(), when: speakableDateTime(s.start, contractor.timezone) })),
          }),
        };
      } catch (err) {
        deps.log.error("check_availability failed", { err, callId: ctx.callId });
        ctx.flagFollowUp("the calendar couldn't be reached during the call");
        return {
          content: json({
            error: "The calendar can't be reached right now. Ask what day and time works best for them, tell them the team will text to confirm, and put their preference in the end_call notes.",
          }),
          isError: true,
        };
      }
    }

    case "book_appointment": {
      const input = BookInput.safeParse(rawInput);
      if (!input.success) return invalid(input.error);
      const start = new Date(input.data.slot_id);
      if (Number.isNaN(start.getTime())) {
        return { content: "slot_id must be one returned by check_availability.", isError: true };
      }
      try {
        const booking = await deps.calendar.book(contractor, lead, start, { address: input.data.address, notes: input.data.notes });
        const confirmed = booking.mode === "calendar";
        const updated = deps.repo.updateLead(lead.id, {
          status: "booked",
          address: input.data.address,
          appointmentStart: booking.start.toISOString(),
          appointmentEnd: booking.end.toISOString(),
          appointmentEventId: booking.eventId,
          metadata: { ...lead.metadata, appointmentConfirmed: confirmed, appointmentNotes: input.data.notes ?? null },
        });
        deps.repo.updateCall(call.id, { outcome: confirmed ? "booked" : "booking_requested" });
        deps.repo.cancelPendingJobsForLead("call_lead", lead.id);
        deps.repo.addEvent({
          contractorId: contractor.id,
          leadId: lead.id,
          callId: call.id,
          type: "appointment_booked",
          message: `${confirmed ? "Booked" : "Requested"} ${speakableDateTime(booking.start, contractor.timezone)}`,
          data: { start: booking.start.toISOString(), eventId: booking.eventId, mode: booking.mode },
        });
        if (contractor.settings.sms.bookingConfirmation && updated.phone) {
          queueSms(deps, contractor, updated.phone, messages.bookingConfirmation(contractor, updated, booking.start, input.data.address, confirmed), {
            leadId: lead.id,
            kind: "booking_confirmation",
          });
        }
        alertTeam(deps, contractor, updated, messages.teamBooked(deps, contractor, updated, booking.start, confirmed), "booked");
        emitWebhook(deps, contractor, "appointment.booked", leadPayload(updated));
        return {
          content: json({
            booked: true,
            when: speakableDateTime(booking.start, contractor.timezone),
            confirmed_on_calendar: confirmed,
            next: confirmed
              ? "Confirm the day, time and address back to them and mention they'll get a text confirmation. Ask if there's anything else, then end the call."
              : "Tell them you've requested that time and the team will text shortly to confirm. Ask if there's anything else, then end the call.",
          }),
        };
      } catch (err) {
        if (err instanceof SlotTakenError) {
          return { content: json({ booked: false, reason: "That time isn't available anymore. Call check_availability and offer other times." }) };
        }
        deps.log.error("book_appointment failed", { err, callId: ctx.callId });
        ctx.flagFollowUp("booking failed during the call");
        return {
          content: json({
            booked: false,
            error: "The booking didn't go through. Tell them the team will text to lock in the time, and put their preferred time in the end_call notes.",
          }),
          isError: true,
        };
      }
    }

    case "end_call": {
      const input = EndInput.safeParse(rawInput);
      if (!input.success) return invalid(input.error);
      return {
        content: "Call ended.",
        terminal: {
          kind: "end",
          outcome: input.data.outcome,
          closing: input.data.closing_line,
          notes: input.data.notes,
          callbackTime: input.data.callback_time,
        },
      };
    }

    default:
      return { content: `Unknown tool ${name}`, isError: true };
  }
}
