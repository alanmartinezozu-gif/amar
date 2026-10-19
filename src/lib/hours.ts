import { DateTime } from "luxon";
import { DAYS, type Day, type WeeklyHours } from "../domain/settings.js";

export function dayKey(dt: DateTime): Day {
  return DAYS[dt.weekday - 1];
}

/** Wall-clock time on a local day (DST-safe: 08:00 stays 08:00 on transition days). */
function atLocalTime(day: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(":").map(Number);
  if (h === 24) return day.startOf("day").plus({ days: 1 });
  return day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

/** Ranges for one local calendar day as [start, end) DateTimes. */
export function rangesOnDay(hours: WeeklyHours, day: DateTime): Array<[DateTime, DateTime]> {
  return hours[dayKey(day)].map(([a, b]) => [atLocalTime(day, a), atLocalTime(day, b)]);
}

export function isWithinHours(hours: WeeklyHours, timezone: string, at: Date): boolean {
  const local = DateTime.fromJSDate(at, { zone: timezone });
  return rangesOnDay(hours, local).some(([a, b]) => local >= a && local < b);
}

/** `from` if it's within hours, otherwise the next moment the hours open (searches 14 days). Null if never open. */
export function nextOpening(hours: WeeklyHours, timezone: string, from: Date): Date | null {
  const local = DateTime.fromJSDate(from, { zone: timezone });
  for (let i = 0; i < 14; i++) {
    const day = local.plus({ days: i });
    for (const [a, b] of rangesOnDay(hours, day)) {
      if (local < b) return (local > a ? local : a).toJSDate();
    }
  }
  return null;
}

export function localNow(timezone: string, at: Date): DateTime {
  return DateTime.fromJSDate(at, { zone: timezone });
}

/** "Tuesday, October 21 at 9:00 AM" */
export function speakableDateTime(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).toFormat("cccc, LLLL d 'at' h:mm a");
}

/** "Tue Oct 21, 9:00 AM" */
export function shortDateTime(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).toFormat("ccc LLL d, h:mm a");
}

export function isValidTimezone(tz: string): boolean {
  return DateTime.now().setZone(tz).isValid;
}
