import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { defaultSettings, formatHoursText, parseHoursText } from "../src/domain/settings.js";
import { isWithinHours, nextOpening } from "../src/lib/hours.js";
import { findOpenSlots } from "../src/calendar/slots.js";
import { normalizePhone, speakablePhone } from "../src/lib/phone.js";

const TZ = "America/Chicago";
const local = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate();
const fmt = (d: Date | null) => (d ? DateTime.fromJSDate(d, { zone: TZ }).toFormat("ccc yyyy-LL-dd HH:mm") : null);

describe("hours text", () => {
  it("parses ranges, day spans and aliases", () => {
    const h = parseHoursText("mon-fri 8-18; sat 09:00-12:00 13:00-15:00");
    expect(h.mon).toEqual([["08:00", "18:00"]]);
    expect(h.fri).toEqual([["08:00", "18:00"]]);
    expect(h.sat).toEqual([
      ["09:00", "12:00"],
      ["13:00", "15:00"],
    ]);
    expect(h.sun).toEqual([]);
    expect(parseHoursText("daily 08:00-21:00").sun).toEqual([["08:00", "21:00"]]);
    expect(parseHoursText("fri-mon 10:00-11:00").sun).toEqual([["10:00", "11:00"]]);
  });

  it("round-trips through the display format", () => {
    const text = "mon-fri 08:00-18:00; sat 09:00-14:00";
    expect(formatHoursText(parseHoursText(text))).toBe(text);
    expect(formatHoursText(defaultSettings().callingHours)).toBe("mon-sun 08:00-21:00");
  });

  it("rejects nonsense with a readable error", () => {
    expect(() => parseHoursText("someday 8-5")).toThrow(/Unknown day/);
    expect(() => parseHoursText("mon 18:00-08:00")).toThrow(/before it ends/);
  });
});

describe("calling hours", () => {
  const hours = parseHoursText("mon-sat 08:00-21:00");

  it("knows when it's open", () => {
    expect(isWithinHours(hours, TZ, local("2026-10-20T10:00"))).toBe(true);
    expect(isWithinHours(hours, TZ, local("2026-10-20T21:00"))).toBe(false);
    expect(isWithinHours(hours, TZ, local("2026-10-25T10:00"))).toBe(false); // Sunday
  });

  it("finds the next opening", () => {
    expect(fmt(nextOpening(hours, TZ, local("2026-10-20T10:00")))).toBe("Tue 2026-10-20 10:00");
    expect(fmt(nextOpening(hours, TZ, local("2026-10-20T23:30")))).toBe("Wed 2026-10-21 08:00");
    expect(fmt(nextOpening(hours, TZ, local("2026-10-24T22:00")))).toBe("Mon 2026-10-26 08:00");
    expect(nextOpening(parseHoursText(""), TZ, local("2026-10-20T10:00"))).toBeNull();
  });

  it("keeps wall-clock times across DST changes", () => {
    // US DST ends Sunday 2026-11-01. Monday's opening is still 08:00 local.
    expect(fmt(nextOpening(hours, TZ, local("2026-10-31T22:00")))).toBe("Mon 2026-11-02 08:00");
  });
});

describe("appointment slots", () => {
  const base = {
    hours: parseHoursText("mon-fri 08:00-17:00"),
    timezone: TZ,
    durationMinutes: 60,
    bufferMinutes: 30,
    minNoticeHours: 2,
    daysAhead: 7,
    slotIntervalMinutes: 60,
    busy: [],
  };

  it("respects minimum notice and spreads options across days", () => {
    const slots = findOpenSlots({ ...base, now: local("2026-10-20T10:20") });
    expect(slots.map((s) => fmt(s.start))).toEqual([
      "Tue 2026-10-20 13:00",
      "Tue 2026-10-20 16:00",
      "Wed 2026-10-21 08:00",
      "Wed 2026-10-21 11:00",
    ]);
  });

  it("skips busy time plus buffer", () => {
    const slots = findOpenSlots({
      ...base,
      now: local("2026-10-20T06:00"),
      busy: [{ start: local("2026-10-20T08:00"), end: local("2026-10-20T10:00") }],
      limit: 2,
    });
    // 10:00 would butt up against the busy block; the 30 minute buffer pushes it to 11:00.
    expect(slots.map((s) => fmt(s.start))).toEqual(["Tue 2026-10-20 11:00", "Tue 2026-10-20 14:00"]);
  });

  it("honors a preferred day and time of day", () => {
    const slots = findOpenSlots({ ...base, now: local("2026-10-20T06:00"), preferredDate: "2026-10-22", timeOfDay: "afternoon", limit: 2 });
    expect(slots.map((s) => fmt(s.start))).toEqual(["Thu 2026-10-22 12:00", "Thu 2026-10-22 15:00"]);
  });
});

describe("phone numbers", () => {
  it("normalizes to E.164", () => {
    expect(normalizePhone("(512) 867-5309")).toBe("+15128675309");
    expect(normalizePhone("512.867.5309")).toBe("+15128675309");
    expect(normalizePhone("+1 512 867 5309")).toBe("+15128675309");
    expect(normalizePhone("867-5309")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("reads digit by digit", () => {
    expect(speakablePhone("+15128675309")).toBe("5 1 2, 8 6 7, 5 3 0 9");
  });
});
