import { DateTime } from "luxon";
import type { Repo } from "../db/repo.js";
import type { Contractor, Lead } from "../domain/types.js";
import { rangesOnDay } from "../lib/hours.js";
import { findOpenSlots, type Interval, type Slot } from "./slots.js";

/** A calendar we can read busy times from and write events to (Google Calendar in production). */
export interface CalendarBackend {
  busy(contractorId: string, calendarId: string, from: Date, to: Date): Promise<Interval[]>;
  createEvent(
    contractorId: string,
    calendarId: string,
    event: { summary: string; description: string; location?: string; start: Date; end: Date; timezone: string },
  ): Promise<{ id: string; htmlLink?: string }>;
}

/**
 * "calendar": a real calendar is connected - live availability, events are created.
 * "request":  no calendar - the AI offers times inside booking hours (minus already-booked leads)
 *             and the team confirms the appointment.
 */
export type BookingMode = "calendar" | "request";

export class SlotTakenError extends Error {
  constructor() {
    super("That time was just taken");
    this.name = "SlotTakenError";
  }
}

export class CalendarService {
  constructor(
    private readonly repo: Repo,
    private readonly backend: CalendarBackend,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  mode(contractor: Contractor): BookingMode {
    return this.repo.getCalendarConnection(contractor.id) ? "calendar" : "request";
  }

  private async busy(contractor: Contractor, from: Date, to: Date): Promise<Interval[]> {
    const booked = this.repo
      .listAppointments(contractor.id, from.toISOString(), to.toISOString())
      .map((a) => ({ start: new Date(a.start), end: new Date(a.end) }));
    if (this.mode(contractor) === "request") return booked;
    const external = await this.backend.busy(contractor.id, contractor.settings.booking.calendarId, from, to);
    return [...booked, ...external];
  }

  async findSlots(
    contractor: Contractor,
    opts: { preferredDate?: string; timeOfDay?: "morning" | "afternoon" | "evening" | "any"; limit?: number } = {},
  ): Promise<Slot[]> {
    const b = contractor.settings.booking;
    const now = this.clock();
    const horizon = new Date(now.getTime() + (b.daysAhead + 1) * 86_400_000);
    const busy = await this.busy(contractor, now, horizon);
    return findOpenSlots({
      hours: b.hours,
      timezone: contractor.timezone,
      now,
      durationMinutes: b.durationMinutes,
      bufferMinutes: b.bufferMinutes,
      minNoticeHours: b.minNoticeHours,
      daysAhead: b.daysAhead,
      slotIntervalMinutes: b.slotIntervalMinutes,
      busy,
      preferredDate: opts.preferredDate,
      timeOfDay: opts.timeOfDay,
      limit: opts.limit ?? 4,
    });
  }

  /** Is `start` bookable right now? Guards against stale or invented times from the conversation. */
  async isAvailable(contractor: Contractor, start: Date): Promise<boolean> {
    const b = contractor.settings.booking;
    const now = this.clock();
    const end = new Date(start.getTime() + b.durationMinutes * 60_000);
    if (start.getTime() < now.getTime() + b.minNoticeHours * 3_600_000) return false;
    if (start.getTime() > now.getTime() + (b.daysAhead + 1) * 86_400_000) return false;
    const local = DateTime.fromJSDate(start, { zone: contractor.timezone });
    const inHours = rangesOnDay(b.hours, local).some(([open, close]) => start >= open.toJSDate() && end <= close.toJSDate());
    if (!inHours) return false;
    const buffer = b.bufferMinutes * 60_000;
    const busy = await this.busy(contractor, new Date(start.getTime() - 86_400_000), new Date(end.getTime() + 86_400_000));
    return !busy.some((x) => x.start.getTime() - buffer < end.getTime() && start.getTime() < x.end.getTime() + buffer);
  }

  async book(
    contractor: Contractor,
    lead: Lead,
    start: Date,
    info: { address?: string; notes?: string },
  ): Promise<{ start: Date; end: Date; eventId: string | null; mode: BookingMode }> {
    const end = new Date(start.getTime() + contractor.settings.booking.durationMinutes * 60_000);
    if (!(await this.isAvailable(contractor, start))) throw new SlotTakenError();
    const mode = this.mode(contractor);
    let eventId: string | null = null;
    if (mode === "calendar") {
      const event = await this.backend.createEvent(contractor.id, contractor.settings.booking.calendarId, {
        summary: `${contractor.settings.booking.appointmentTitle}: ${lead.name ?? lead.phone ?? "New lead"}`,
        description: eventDescription(lead, info.notes),
        location: info.address ?? lead.address ?? undefined,
        start,
        end,
        timezone: contractor.timezone,
      });
      eventId = event.id;
    }
    return { start, end, eventId, mode };
  }
}

function eventDescription(lead: Lead, notes?: string): string {
  const lines = [
    `Lead: ${lead.name ?? "Unknown"}`,
    lead.phone ? `Phone: ${lead.phone}` : "",
    lead.email ? `Email: ${lead.email}` : "",
    `Source: ${lead.source}`,
    "",
    ...Object.entries(lead.details).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`),
    notes ? `\nNotes: ${notes}` : "",
    lead.summary ? `\nSummary: ${lead.summary}` : "",
    "",
    "Booked automatically by the AI appointment assistant.",
  ];
  return lines.filter((l, i, arr) => l !== "" || arr[i - 1] !== "").join("\n");
}

/** Used when no calendar is connected: nothing external is busy and events aren't created. */
export const noCalendarBackend: CalendarBackend = {
  busy: async () => [],
  createEvent: async () => {
    throw new Error("No calendar connected");
  },
};
