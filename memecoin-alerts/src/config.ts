import { z } from "zod";
import { isSolanaAddress } from "./solana.js";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

/** "a, b ,c" -> ["a", "b", "c"]. Commas only, so keywords can contain spaces. */
const csv = z
  .string()
  .optional()
  .transform((v) => [...new Set((v ?? "").split(",").map((s) => s.trim()).filter(Boolean))]);

/** X handles without the @, lowercased. */
const handles = csv.transform((list) => [...new Set(list.map((h) => h.replace(/^@/, "").toLowerCase()))]);

/** "5,15,60" -> [5, 15, 60]. Empty turns follow-ups off. */
const minutes = z
  .string()
  .default("5,15,60")
  .transform((v, ctx) => {
    const nums = v.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n <= 0)) {
      ctx.addIssue({ code: "custom", message: "must be a comma-separated list of minutes, e.g. 5,15,60" });
      return z.NEVER;
    }
    return [...new Set(nums)].sort((a, b) => a - b);
  });

const EnvSchema = z
  .object({
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    /** Where seen coins and the alert log are kept. */
    DATA_DIR: z.string().default("./data"),

    TELEGRAM_BOT_TOKEN: optionalString,
    TELEGRAM_CHAT_ID: optionalString,
    DISCORD_WEBHOOK_URL: optionalString,

    /** Optional: every alert is also POSTed here as signed JSON, for your own trading bot. */
    ALERT_WEBHOOK_URL: optionalString,
    ALERT_WEBHOOK_SECRET: optionalString,

    X_BEARER_TOKEN: optionalString,
    /** Accounts whose posted contract addresses you trust. */
    X_ACCOUNTS: handles,
    /** Extra search terms. Hits from accounts not in X_ACCOUNTS are flagged as unverified. */
    X_KEYWORDS: csv,
    X_POLL_SECONDS: z.coerce.number().int().min(15).default(60),
    /** Posts older than this are ignored (stops a restart from replaying old coins). */
    X_MAX_POST_AGE_MINUTES: z.coerce.number().positive().default(30),
    /** X caps search query length; 512 on most plans. */
    X_QUERY_MAX_LENGTH: z.coerce.number().int().min(64).default(512),
    X_API_URL: z
      .string()
      .url()
      .default("https://api.x.com/2")
      .transform((v) => v.replace(/\/+$/, "")),

    LAUNCH_ALERTS: bool.default(true),
    PUMPPORTAL_WS_URL: z.string().default("wss://pumpportal.fun/api/data"),
    /** Alert on a new coin whose name or ticker contains one of these. */
    LAUNCH_KEYWORDS: csv,
    /** Alert on any coin created by one of these wallets. */
    LAUNCH_CREATORS: csv,
    /** Alert on any coin whose creator bought at least this much SOL at launch. 0 = off. */
    LAUNCH_BIG_DEV_BUY_SOL: z.coerce.number().min(0).default(0),
    /** Summary of all launches every N minutes. 0 = off. */
    LAUNCH_DIGEST_MINUTES: z.coerce.number().min(0).default(15),

    /** Enables red-flag checks (mint/freeze authority, holder concentration). */
    SOLANA_RPC_URL: optionalString,
    DEXSCREENER_API_URL: z
      .string()
      .url()
      .default("https://api.dexscreener.com")
      .transform((v) => v.replace(/\/+$/, "")),
    /** Price updates this many minutes after each alert. Empty = off. */
    FOLLOWUP_MINUTES: minutes,
    MAX_TRACKED_COINS: z.coerce.number().int().positive().default(200),
  })
  .superRefine((c, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (c.TELEGRAM_BOT_TOKEN && !c.TELEGRAM_CHAT_ID) issue("TELEGRAM_CHAT_ID", "required when TELEGRAM_BOT_TOKEN is set");
    if (c.TELEGRAM_CHAT_ID && !c.TELEGRAM_BOT_TOKEN) issue("TELEGRAM_BOT_TOKEN", "required when TELEGRAM_CHAT_ID is set");
    if (c.ALERT_WEBHOOK_URL && (c.ALERT_WEBHOOK_SECRET ?? "").length < 16) {
      issue("ALERT_WEBHOOK_SECRET", "must be at least 16 characters when ALERT_WEBHOOK_URL is set");
    }
    if (c.X_BEARER_TOKEN && c.X_ACCOUNTS.length === 0 && c.X_KEYWORDS.length === 0) {
      issue("X_ACCOUNTS", "list at least one account (or X_KEYWORDS) to watch");
    }
    for (const h of c.X_ACCOUNTS) {
      if (!/^[a-z0-9_]{1,15}$/.test(h)) issue("X_ACCOUNTS", `"${h}" isn't a valid X handle`);
    }
    for (const a of c.LAUNCH_CREATORS) {
      if (!isSolanaAddress(a)) issue("LAUNCH_CREATORS", `"${a}" isn't a Solana wallet address`);
    }
    if (!c.X_BEARER_TOKEN && !c.LAUNCH_ALERTS) issue("LAUNCH_ALERTS", "nothing to watch: set X_BEARER_TOKEN or LAUNCH_ALERTS=true");
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration. Check your .env file:\n${problems}`);
  }
  return parsed.data;
}
