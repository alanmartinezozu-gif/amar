import { z } from "zod";
import { csv, optionalString, bool } from "../config.js";

const pct = (def: number) => z.coerce.number().min(0).max(1000).default(def);
const sol = (def: number) => z.coerce.number().min(0).default(def);

const PaperSchema = z
  .object({
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    DATA_DIR: z.string().default("./data"),
    TELEGRAM_BOT_TOKEN: optionalString,
    TELEGRAM_CHAT_ID: optionalString,
    DISCORD_WEBHOOK_URL: optionalString,

    /** Same secret the alert bot signs with. */
    ALERT_WEBHOOK_SECRET: z.string().min(16, "must be at least 16 characters (use the same value as the alert bot)"),
    PAPER_HOST: z.string().default("127.0.0.1"),
    PAPER_PORT: z.coerce.number().int().positive().default(8787),
    /** Needed to read pump.fun prices straight from the chain. */
    SOLANA_RPC_URL: z.string().url("needed to read live prices: set it to your Solana RPC URL"),
    DEXSCREENER_API_URL: z
      .string()
      .url()
      .default("https://api.dexscreener.com")
      .transform((v) => v.replace(/\/+$/, "")),

    PAPER_START_SOL: z.coerce.number().positive().default(5),
    PAPER_BUY_SOL: z.coerce.number().positive().default(0.5),
    /** Which alerts to trade: launch (new pump.fun coins) and/or x (coins posted by accounts you track). */
    PAPER_SOURCES: csv
      .transform((list) => list.map((s) => s.toLowerCase()))
      .pipe(z.array(z.enum(["launch", "x"])).min(1, "list at least one of: launch, x"))
      .default(["launch"]),
    PAPER_SKIP_RED_FLAGS: bool.default(true),
    PAPER_MAX_ENTRY_DELAY_SECONDS: z.coerce.number().positive().default(120),
    PAPER_MAX_ENTRY_MCAP_SOL: z.coerce.number().positive().default(60),
    PAPER_TAKE_PROFIT_PCT: pct(50),
    PAPER_TAKE_PROFIT_SELL_PCT: z.coerce.number().gt(0).max(100).default(100),
    PAPER_TRAILING_STOP_PCT: z.coerce.number().min(0).max(100).default(30),
    PAPER_STOP_LOSS_PCT: z.coerce.number().gt(0).max(100).default(35),
    PAPER_MAX_HOLD_MINUTES: z.coerce.number().positive().default(30),
    PAPER_MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(5),
    PAPER_DAILY_GOAL_SOL: sol(0),
    PAPER_MAX_DAILY_LOSS_SOL: sol(0),
    PAPER_FEE_PCT: z.coerce.number().min(0).max(20).default(1.25),
    PAPER_TX_COST_SOL: sol(0.003),
    PAPER_DEX_SLIPPAGE_PCT: z.coerce.number().min(0).max(50).default(3),
    PAPER_PRICE_CHECK_SECONDS: z.coerce.number().min(1).default(3),
    PAPER_SUMMARY_MINUTES: z.coerce.number().min(0).default(60),
  })
  .superRefine((c, ctx) => {
    if (c.PAPER_BUY_SOL > c.PAPER_START_SOL) {
      ctx.addIssue({ code: "custom", path: ["PAPER_BUY_SOL"], message: "can't be more than PAPER_START_SOL" });
    }
    if (Boolean(c.TELEGRAM_BOT_TOKEN) !== Boolean(c.TELEGRAM_CHAT_ID)) {
      ctx.addIssue({ code: "custom", path: ["TELEGRAM_CHAT_ID"], message: "set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" });
    }
  });

export type PaperConfig = z.infer<typeof PaperSchema>;

export function loadPaperConfig(env: NodeJS.ProcessEnv = process.env): PaperConfig {
  const parsed = PaperSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid paper sniper configuration. Check your .env file:\n${problems}`);
  }
  return parsed.data;
}
