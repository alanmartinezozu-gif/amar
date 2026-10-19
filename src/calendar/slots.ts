import { DateTime } from "luxon";
import type { WeeklyHours } from "../domain/settings.js";
import { rangesOnDay } from "../lib/hours.js";

export interface Interval {
  start: Date;
  end: Date;
}

export interface Slot {
  start: Date;
  end: Date;
}

export interface SlotQuery {
  hours: WeeklyHours;
  timezone: string;
  now: Date;
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  daysAhead: number;
  slotIntervalMinutes: number;
  busy: Interval[];
  /** Local date "YYYY-MM-DD" to start searching from. */
  preferredDate?: string;
  timeOfDay?: "morning" | "afternoon" | "evening" | "any";
  limit?: number;
  /** Spread suggestions across days instead of offering one day's whole schedule. */
  maxPerDay?: number;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

function matchesTimeOfDay(start: DateTime, tod: SlotQuery["timeOfDay"]): boolean {
  if (!tod || tod === "any") return true;
  if (tod === "morning") return start.hour < 12;
  if (tod === "afternoon") return start.hour >= 12 && start.hour < 17;
  return start.hour >= 17;
}

/** Open appointment slots, honoring hours, notice, buffers and existing busy time. */
export function findOpenSlots(q: SlotQuery): Slot[] {
  const limit = q.limit ?? 4;
  const maxPerDay = q.maxPerDay ?? 2;
  const now = DateTime.fromJSDate(q.now, { zone: q.timezone });
  const earliest = now.plus({ hours: q.minNoticeHours });
  const lastDay = now.startOf("day").plus({ days: q.daysAhead });
  const buffer = q.bufferMinutes * 60_000;
  const busy = q.busy.map((b) => ({ start: new Date(b.start.getTime() - buffer), end: new Date(b.end.getTime() + buffer) }));

  let day = now.startOf("day");
  if (q.preferredDate) {
    const preferred = DateTime.fromISO(q.preferredDate, { zone: q.timezone });
    if (preferred.isValid && preferred > day) day = preferred.startOf("day");
  }

  const slots: Slot[] = [];
  for (; day <= lastDay && slots.length < limit; day = day.plus({ days: 1 })) {
    let perDay = 0;
    for (const [open, close] of rangesOnDay(q.hours, day)) {
      for (
        let start = open;
        start.plus({ minutes: q.durationMinutes }) <= close && perDay < maxPerDay && slots.length < limit;
        start = start.plus({ minutes: q.slotIntervalMinutes })
      ) {
        if (start < earliest || !matchesTimeOfDay(start, q.timeOfDay)) continue;
        const slot = { start: start.toJSDate(), end: start.plus({ minutes: q.durationMinutes }).toJSDate() };
        if (busy.some((b) => overlaps(slot, b))) continue;
        slots.push(slot);
        perDay++;
        // Space same-day suggestions apart (e.g. 9am and 1pm, not 9am and 10am).
        start = start.plus({ minutes: Math.max(0, 180 - q.slotIntervalMinutes) });
      }
    }
  }
  return slots;
}
