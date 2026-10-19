import { z } from "zod";

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use 24h HH:MM");
const TimeRange = z.tuple([hhmm, hhmm]).refine(([a, b]) => a < b, "Range start must be before end");

export const WeeklyHoursSchema = z.object({
  mon: z.array(TimeRange).default([]),
  tue: z.array(TimeRange).default([]),
  wed: z.array(TimeRange).default([]),
  thu: z.array(TimeRange).default([]),
  fri: z.array(TimeRange).default([]),
  sat: z.array(TimeRange).default([]),
  sun: z.array(TimeRange).default([]),
});
export type WeeklyHours = z.infer<typeof WeeklyHoursSchema>;

function everyDay(start: string, end: string, days: readonly Day[] = DAYS): WeeklyHours {
  const hours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } as WeeklyHours;
  for (const d of days) hours[d] = [[start, end]];
  return hours;
}

export const TransferTargetSchema = z.object({
  name: z.string().min(1),
  role: z.string().default("Owner"),
  phone: z.string().min(7),
});
export type TransferTarget = z.infer<typeof TransferTargetSchema>;

export const QuestionSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,40}$/, "Question keys are lowercase snake_case"),
  question: z.string().min(3),
  required: z.boolean().default(false),
});
export type Question = z.infer<typeof QuestionSchema>;

export const DEFAULT_QUESTIONS: Question[] = [
  { key: "service_needed", question: "What service are they looking for?", required: true },
  { key: "problem_details", question: "What's going on - what are they dealing with, and how bad is it?", required: true },
  { key: "property_address", question: "What's the address of the property (street, city, zip)?", required: true },
  { key: "timeline", question: "How soon do they need it done (emergency, this week, this month, just planning)?", required: true },
  { key: "is_owner", question: "Are they the property owner (or a decision maker)?", required: false },
  { key: "budget", question: "Do they have a budget range in mind?", required: false },
];

export const ContractorSettingsSchema = z.object({
  /** Name the AI introduces itself with. */
  assistantName: z.string().default("Ava"),
  /** What the contractor does, e.g. "roofing, gutters and siding". */
  services: z.string().default("home improvement"),
  serviceArea: z.string().default(""),
  /** Extra facts / rules for the AI: pricing policy, warranties, things never to say. */
  customInstructions: z.string().default(""),
  /** Shown on the website form after submit (FB/Google: set the same text in the ad's lead form). */
  thankYouMessage: z.string().default("Thank you! Someone from our team will call you in just a moment."),

  /** How long after the form is submitted the AI calls. */
  callDelaySeconds: z.number().int().min(0).max(3600).default(10),
  /** When the AI is allowed to call leads (TCPA quiet hours: 8am-9pm called party's local time). */
  callingHours: WeeklyHoursSchema.default(everyDay("08:00", "21:00")),
  /** When a live transfer to the team is attempted. Outside these hours the AI books instead. */
  transferHours: WeeklyHoursSchema.default(everyDay("08:00", "18:00", ["mon", "tue", "wed", "thu", "fri", "sat"])),
  /** People to transfer to, tried in order (owner first, then manager...). */
  transferTargets: z.array(TransferTargetSchema).default([]),
  transferRingSeconds: z.number().int().min(5).max(60).default(18),

  questions: z.array(QuestionSchema).default(DEFAULT_QUESTIONS),

  booking: z
    .object({
      /** Hours estimates can be booked in. */
      hours: WeeklyHoursSchema.default(everyDay("08:00", "17:00", ["mon", "tue", "wed", "thu", "fri", "sat"])),
      durationMinutes: z.number().int().min(15).max(480).default(60),
      bufferMinutes: z.number().int().min(0).max(240).default(30),
      minNoticeHours: z.number().min(0).max(168).default(2),
      daysAhead: z.number().int().min(1).max(60).default(10),
      slotIntervalMinutes: z.number().int().min(15).max(240).default(60),
      appointmentTitle: z.string().default("Free estimate"),
      /** Google Calendar id when a calendar is connected (default: the account's primary calendar). */
      calendarId: z.string().default("primary"),
    })
    .prefault({}),

  /** Minutes to wait before each re-dial when the lead doesn't pick up. Length = number of retries. */
  retryDelaysMinutes: z.array(z.number().int().min(1).max(10080)).max(10).default([2, 20, 240]),
  /** Leave a voicemail on the first missed attempt only, every attempt, or never. */
  voicemail: z.enum(["first", "always", "never"]).default("first"),

  sms: z
    .object({
      /** Text the lead right away ("we're calling you now"). */
      instantReply: z.boolean().default(true),
      /** Text the lead after the first missed call. */
      missedCall: z.boolean().default(true),
      /** Text the lead their appointment confirmation. */
      bookingConfirmation: z.boolean().default(true),
      /** Text the team about new leads, bookings and follow-ups. */
      teamAlerts: z.boolean().default(true),
    })
    .prefault({}),
  /** Who gets team alert texts. Empty = all transfer targets. */
  alertPhones: z.array(z.string()).default([]),

  voice: z
    .object({
      language: z.string().default("en-US"),
      /** ConversationRelay TTS provider: ElevenLabs (default), Google or Amazon. */
      ttsProvider: z.string().optional(),
      voice: z.string().optional(),
      transcriptionProvider: z.string().optional(),
      speechModel: z.string().optional(),
      /** <Say> voice used for voicemail drops and the transfer whisper. */
      sayVoice: z.string().default("Polly.Joanna-Neural"),
    })
    .prefault({}),

  /** Optional URL that receives JSON events (lead.created, call.completed, ...) - Zapier, CRM, etc. */
  webhookUrl: z.union([z.string().url(), z.literal("")]).default(""),
  /** A second form from the same phone inside this window is merged instead of called again. */
  dedupeMinutes: z.number().int().min(0).max(10080).default(30),
});

export type ContractorSettings = z.infer<typeof ContractorSettingsSchema>;

export function parseSettings(raw: unknown): ContractorSettings {
  return ContractorSettingsSchema.parse(raw ?? {});
}

export function defaultSettings(): ContractorSettings {
  return ContractorSettingsSchema.parse({});
}

/* ---------- human-friendly hours syntax for the admin UI ----------
 *   "mon-fri 08:00-18:00; sat 09:00-14:00"
 *   "daily 08:00-21:00"
 *   "mon 08:00-12:00 13:00-17:00"
 */

const DAY_ALIASES: Record<string, Day[]> = {
  daily: [...DAYS],
  everyday: [...DAYS],
  weekdays: ["mon", "tue", "wed", "thu", "fri"],
  weekends: ["sat", "sun"],
};

function expandDays(token: string): Day[] {
  const t = token.toLowerCase().slice(0, 3) as Day;
  const full = token.toLowerCase();
  if (DAY_ALIASES[full]) return DAY_ALIASES[full];
  if (full.includes("-")) {
    const [a, b] = full.split("-").map((p) => p.slice(0, 3) as Day);
    const ia = DAYS.indexOf(a);
    const ib = DAYS.indexOf(b);
    if (ia < 0 || ib < 0) throw new Error(`Unknown day range "${token}"`);
    const out: Day[] = [];
    for (let i = ia; ; i = (i + 1) % 7) {
      out.push(DAYS[i]);
      if (i === ib) break;
    }
    return out;
  }
  if (!DAYS.includes(t)) throw new Error(`Unknown day "${token}"`);
  return [t];
}

function normTime(t: string): string {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t);
  if (!m) throw new Error(`Bad time "${t}" (use HH:MM)`);
  return `${m[1].padStart(2, "0")}:${m[2] ?? "00"}`;
}

export function parseHoursText(text: string): WeeklyHours {
  const hours: WeeklyHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  const clauses = text
    .split(/[;\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const [dayToken, ...ranges] = clause.split(/[\s,]+/).filter(Boolean);
    if (!dayToken || ranges.length === 0) throw new Error(`Can't read "${clause}" (example: mon-fri 08:00-18:00)`);
    const days = expandDays(dayToken);
    for (const r of ranges) {
      if (r.toLowerCase() === "closed") continue;
      const [a, b] = r.split("-");
      if (!a || !b) throw new Error(`Bad time range "${r}" (example: 08:00-18:00)`);
      const range: [string, string] = [normTime(a), normTime(b)];
      if (range[0] >= range[1]) throw new Error(`Range "${r}" must start before it ends`);
      for (const d of days) hours[d].push(range);
    }
  }
  return WeeklyHoursSchema.parse(hours);
}

export function formatHoursText(hours: WeeklyHours): string {
  // Group consecutive days with identical ranges: "mon-fri 08:00-18:00; sat 09:00-14:00"
  const key = (d: Day) => hours[d].map(([a, b]) => `${a}-${b}`).join(" ");
  const parts: string[] = [];
  let i = 0;
  while (i < DAYS.length) {
    const k = key(DAYS[i]);
    let j = i;
    while (j + 1 < DAYS.length && key(DAYS[j + 1]) === k) j++;
    if (k) parts.push(`${i === j ? DAYS[i] : `${DAYS[i]}-${DAYS[j]}`} ${k}`);
    i = j + 1;
  }
  return parts.join("; ");
}
