import { z } from "zod";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  /** Public HTTPS origin this server is reachable at, e.g. https://leads.example.com (no trailing slash). */
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .transform((v) => v.replace(/\/+$/, "")),
  DATABASE_PATH: z.string().default("./data/speed-to-lead.db"),
  /** Used to encrypt OAuth tokens at rest and sign OAuth state. Keep it secret and stable. */
  APP_SECRET: z.string().min(16, "APP_SECRET must be at least 16 characters"),
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD must be at least 8 characters"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  /** Fallback caller ID when a contractor has no dedicated Twilio number. */
  TWILIO_DEFAULT_NUMBER: optionalString,
  TWILIO_VALIDATE_SIGNATURES: bool.default(true),

  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  /** "default" enables Anthropic's server-side refusal fallback; "off" disables it. */
  ANTHROPIC_FALLBACKS: z.enum(["default", "off"]).default("default"),

  FACEBOOK_APP_ID: optionalString,
  FACEBOOK_APP_SECRET: optionalString,
  FACEBOOK_VERIFY_TOKEN: optionalString,
  FACEBOOK_GRAPH_VERSION: z.string().default("v24.0"),

  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,

  /** Milliseconds between job-queue polls. */
  WORKER_POLL_MS: z.coerce.number().int().positive().default(500),
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

/** wss:// URL Twilio ConversationRelay connects to. */
export function relayUrl(config: Config): string {
  return config.PUBLIC_BASE_URL.replace(/^http/, "ws") + "/twilio/relay";
}
