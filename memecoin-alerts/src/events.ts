import { createHmac, timingSafeEqual } from "node:crypto";
import { appendJsonLine } from "./jsonfile.js";
import type { MarketSnapshot } from "./market.js";
import type { SafetyReport } from "./rpc.js";

/**
 * One alert, as structured data. This is the contract your trading bot builds on: it arrives as
 * the body of a signed webhook POST and as one line of data/alerts.jsonl.
 */
export interface CoinAlert {
  /** new_coin: first time we've seen it. mention: another tracked account posted it. update: follow-up. */
  type: "new_coin" | "mention" | "update";
  /** Unique per alert; use it to ignore duplicate deliveries. */
  id: string;
  mint: string;
  source: "x" | "launch";
  /** ISO time the alert was produced. */
  at: string;
  name?: string;
  symbol?: string;
  post?: {
    author: string;
    /** True when the author is in X_ACCOUNTS. Untracked authors may be impersonators. */
    tracked: boolean;
    url: string;
    text: string;
    postedAt?: string;
  };
  /** How many different X accounts have posted this coin so far. */
  mentions?: number;
  launch?: {
    creator?: string;
    devBuySol?: number;
    marketCapSol?: number;
    /** The coin's pump.fun bonding curve account: read it for the live price. */
    bondingCurve?: string;
    /** Curve reserves right after creation, in SOL and whole tokens. Price = vSolInCurve / vTokensInCurve. */
    vSolInCurve?: number;
    vTokensInCurve?: number;
    /** Why it matched your filters. */
    matched: string[];
  };
  safety?: SafetyReport;
  /** null = looked up, not trading yet. Absent = not looked up. */
  market?: MarketSnapshot | null;
  update?: {
    minutesSinceAlert: number;
    /** Relative to the first price seen. Absent until two prices exist. */
    priceChangeSinceAlertPct?: number;
  };
}

export interface AlertSink {
  publish(alert: CoinAlert): Promise<void>;
}

export const SIGNATURE_HEADER = "x-alert-signature";
export const TIMESTAMP_HEADER = "x-alert-timestamp";

/** Hex HMAC-SHA256 of "<timestamp>.<body>". */
export function signAlert(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** For the receiving side: checks the signature and rejects replays older than `toleranceMs`. */
export function verifyAlertSignature(
  secret: string,
  timestamp: string | undefined,
  body: string,
  signature: string | undefined,
  now = Date.now(),
  toleranceMs = 5 * 60_000,
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > toleranceMs) return false;
  const expected = Buffer.from(signAlert(secret, timestamp, body), "hex");
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** POSTs each alert as signed JSON. */
export class WebhookSink implements AlertSink {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  async publish(alert: CoinAlert): Promise<void> {
    const body = JSON.stringify(alert);
    const timestamp = String(this.clock());
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signAlert(this.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Alert webhook failed: HTTP ${res.status}`);
  }
}

/** Appends each alert as one JSON line. Handy for backtesting a trading bot later. */
export class JsonlSink implements AlertSink {
  constructor(private readonly path: string) {}

  publish(alert: CoinAlert): Promise<void> {
    return appendJsonLine(this.path, alert);
  }
}
