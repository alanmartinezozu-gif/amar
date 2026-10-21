import type { CoinAlert } from "./events.js";
import type { CoinTracker } from "./hub.js";
import type { Logger } from "./logger.js";
import type { MarketData } from "./market.js";

interface Tracked {
  mint: string;
  source: CoinAlert["source"];
  name?: string;
  symbol?: string;
  alertedAt: number;
  /** First price seen; brand-new launches often have none at alert time. */
  baselinePriceUsd?: number;
  /** Checkpoints (minutes after the alert) not sent yet. */
  remaining: number[];
}

export interface FollowUpOptions {
  minutes: number[];
  maxTracked: number;
}

/** Sends price updates at fixed times after each alert, so you see which alerts ran and which died. */
export class FollowUpTracker implements CoinTracker {
  private readonly coins = new Map<string, Tracked>();
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly market: MarketData,
    private readonly emit: (alert: CoinAlert) => Promise<void>,
    private readonly opts: FollowUpOptions,
    private readonly log: Logger,
    private readonly clock: () => number = Date.now,
  ) {}

  get size(): number {
    return this.coins.size;
  }

  track(coin: { mint: string; source: CoinAlert["source"]; name?: string; symbol?: string; priceUsd?: number }): void {
    if (this.opts.minutes.length === 0 || this.coins.has(coin.mint)) return;
    if (this.coins.size >= this.opts.maxTracked) {
      const oldest = this.coins.keys().next().value;
      if (oldest !== undefined) this.coins.delete(oldest);
    }
    this.coins.set(coin.mint, {
      mint: coin.mint,
      source: coin.source,
      name: coin.name,
      symbol: coin.symbol,
      alertedAt: this.clock(),
      baselinePriceUsd: coin.priceUsd,
      remaining: [...this.opts.minutes],
    });
  }

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.clock();
      for (const coin of [...this.coins.values()]) {
        const due = coin.remaining.filter((m) => now >= coin.alertedAt + m * 60_000);
        if (due.length === 0) continue;
        coin.remaining = coin.remaining.filter((m) => !due.includes(m));
        // If the bot was asleep past several checkpoints, send only the latest.
        await this.update(coin, due[due.length - 1]);
        if (coin.remaining.length === 0) this.coins.delete(coin.mint);
      }
    } finally {
      this.running = false;
    }
  }

  private async update(coin: Tracked, minutes: number): Promise<void> {
    let market;
    try {
      market = await this.market.token(coin.mint);
    } catch (err) {
      this.log.warn("Follow-up market lookup failed", { err, mint: coin.mint });
      return;
    }
    let change: number | undefined;
    if (market?.priceUsd !== undefined) {
      if (coin.baselinePriceUsd === undefined) coin.baselinePriceUsd = market.priceUsd;
      else change = (market.priceUsd / coin.baselinePriceUsd - 1) * 100;
    }
    coin.name ??= market?.name;
    coin.symbol ??= market?.symbol;
    await this.emit({
      type: "update",
      id: `update:${coin.mint}:${minutes}`,
      mint: coin.mint,
      source: coin.source,
      at: new Date(this.clock()).toISOString(),
      name: coin.name,
      symbol: coin.symbol,
      market,
      update: { minutesSinceAlert: minutes, priceChangeSinceAlertPct: change },
    });
  }
}
