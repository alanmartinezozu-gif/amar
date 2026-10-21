import type { CoinAlert } from "../events.js";
import type { Logger } from "../logger.js";
import type { MarketData } from "../market.js";
import type { Notifier } from "../notify.js";
import type { ClosedTrade, PaperBook, Position } from "./book.js";
import { mcapSol, priceSol, solForTokens, tokensForSol, type CurveSource, type CurveState } from "./curve.js";
import { buyMessage, partialSellMessage, sellMessage, stopMessage, summaryMessage, tradeStats } from "./messages.js";

/**
 * The rules, defaulting to Kimchi's documented pattern: buy within ~2 minutes of a coin's creation,
 * take profit at +50% the same session, and quit for the day at a target.
 */
export interface Strategy {
  buySol: number;
  sources: Array<CoinAlert["source"]>;
  skipRedFlags: boolean;
  /** Skip alerts older than this: the edge is being early. */
  maxEntryDelaySec: number;
  /** Skip coins that have already run past this market cap by the time we'd get in. */
  maxEntryMcapSol: number;
  takeProfitPct: number;
  /** Share of the position to sell at take profit. The rest is managed by the trailing stop. */
  takeProfitSellPct: number;
  trailingStopPct: number;
  stopLossPct: number;
  maxHoldMinutes: number;
  maxOpenPositions: number;
  /** Stop opening trades for the day after making this much. 0 = off. */
  dailyGoalSol: number;
  /** Stop opening trades for the day after losing this much. 0 = off. */
  maxDailyLossSol: number;
  /** pump.fun's trading fee, charged on every buy and sell. */
  feePct: number;
  /** Priority fee + tip a real sniper pays per transaction to land fast. */
  txCostSol: number;
  /** Extra haircut on DEX prices, which don't include our own price impact. */
  dexSlippagePct: number;
}

export interface TraderDeps {
  book: PaperBook;
  curves: CurveSource;
  market: MarketData;
  notifier: Notifier;
  strategy: Strategy;
  log: Logger;
  clock: () => number;
  /** Every simulated buy and sell, for analysis later. */
  ledger?: (event: Record<string, unknown>) => Promise<void>;
  /** Wait before re-reading a curve the RPC hasn't caught up on. */
  retryMs?: number;
}

/** SOL that selling this many tokens would get right now. */
type SellQuote = (tokens: number) => number;

interface Entry {
  pricing: Position["pricing"];
  tokens: number;
  entryMcapSol?: number;
  entryVsCreationPct?: number;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Paper trading only: buys and sells are simulated against live on-chain prices and nothing is
 * ever sent to the blockchain. There is no wallet.
 */
export class PaperTrader {
  private readonly skips = new Map<string, number>();
  private readonly pending = new Set<string>();
  private ticking = false;

  constructor(private readonly deps: TraderDeps) {}

  async onAlert(alert: CoinAlert): Promise<void> {
    if (alert.type !== "new_coin") return;
    const { book } = this.deps;
    if (book.hasSeen(alert.mint) || this.pending.has(alert.mint)) return;
    book.markSeen(alert.mint);
    this.rollDay();

    const blocked = this.entryBlocker(alert, false);
    if (blocked) return this.skip(alert, blocked);

    this.pending.add(alert.mint);
    try {
      const entry = await this.priceEntry(alert);
      if (typeof entry === "string") return this.skip(alert, entry);
      // Other alerts may have taken the last slot or the balance while this one was being priced.
      const late = this.entryBlocker(alert, true);
      if (late) return this.skip(alert, late);
      this.pending.delete(alert.mint); // counted as an open position from here on
      await this.open(alert, entry);
    } finally {
      this.pending.delete(alert.mint);
    }
  }

  /** Re-prices every open position and applies the exit rules. Run every few seconds. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.rollDay();
      const open = [...this.deps.book.data.open];
      if (open.length === 0) return;
      const keys = open.filter((p) => p.pricing === "curve" && p.bondingCurve).map((p) => p.bondingCurve!);
      let curves = new Map<string, CurveState>();
      if (keys.length > 0) {
        try {
          curves = await this.deps.curves.read(keys);
        } catch (err) {
          this.deps.log.warn("Couldn't read bonding curves", { err });
        }
      }
      for (const pos of open) {
        const quote = await this.sellQuote(pos, curves);
        if (quote) await this.manage(pos, quote);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Results message. Resets the skip counts it reports. */
  summary(): string {
    const { book, clock } = this.deps;
    const today = utcDay(clock());
    const text = summaryMessage({
      today: tradeStats(book.data.closed.filter((t) => utcDay(t.closedAt) === today)),
      allTime: tradeStats(book.data.closed),
      balanceSol: book.data.balanceSol,
      startSol: book.data.startSol,
      open: book.data.open.length,
      skips: Object.fromEntries(this.skips),
    });
    this.skips.clear();
    return text;
  }

  private entryBlocker(alert: CoinAlert, afterPricing: boolean): string | undefined {
    const { book, strategy: s, clock } = this.deps;
    if (!s.sources.includes(alert.source)) return "not a source you trade";
    if (alert.source === "x" && !alert.post?.tracked) return "posted by an untracked account";
    if (s.skipRedFlags && alert.safety?.flags.length) return "red flags";
    if (clock() - Date.parse(alert.at) > s.maxEntryDelaySec * 1000) return "too late";
    if (book.data.day.stoppedReason) return "stopped for the day";
    const slotsUsed = book.data.open.length + this.pending.size - (afterPricing ? 1 : 0);
    if (slotsUsed >= s.maxOpenPositions) return "max open positions";
    if (book.data.balanceSol < s.buySol + s.txCostSol) return "out of paper SOL";
    return undefined;
  }

  private async priceEntry(alert: CoinAlert): Promise<Entry | string> {
    const s = this.deps.strategy;
    const key = alert.launch?.bondingCurve;
    if (key) {
      const curve = await this.readCurve(key);
      if (!curve) return "no price";
      if (!curve.complete) {
        const mcap = mcapSol(curve);
        if (mcap > s.maxEntryMcapSol) return "already pumped";
        const tokens = tokensForSol(curve, s.buySol, s.feePct);
        if (tokens <= 0) return "no price";
        const { vSolInCurve, vTokensInCurve } = alert.launch ?? {};
        const created = vSolInCurve && vTokensInCurve ? priceSol({ vSol: vSolInCurve, vTokens: vTokensInCurve }) : undefined;
        return {
          pricing: "curve",
          tokens,
          entryMcapSol: mcap,
          entryVsCreationPct: created ? (priceSol(curve) / created - 1) * 100 : undefined,
        };
      }
    }
    const price = await this.dexPrice(alert.mint);
    if (price === undefined) return "no price";
    return { pricing: "dex", tokens: (s.buySol * (1 - (s.feePct + s.dexSlippagePct) / 100)) / price };
  }

  private async open(alert: CoinAlert, entry: Entry): Promise<void> {
    const { book, strategy: s, clock } = this.deps;
    const pos: Position = {
      mint: alert.mint,
      symbol: alert.symbol,
      name: alert.name,
      source: alert.source,
      pricing: entry.pricing,
      bondingCurve: alert.launch?.bondingCurve,
      openedAt: clock(),
      boughtTokens: entry.tokens,
      tokens: entry.tokens,
      costSol: s.buySol,
      proceedsSol: 0,
      txCostSol: s.txCostSol,
      entryMcapSol: entry.entryMcapSol,
      entryVsCreationPct: entry.entryVsCreationPct,
      peakValueSol: 0,
      tookProfit: false,
    };
    book.data.open.push(pos);
    book.data.balanceSol -= s.buySol + s.txCostSol;
    book.changed();
    this.record({ type: "buy", at: new Date(pos.openedAt).toISOString(), mint: pos.mint, symbol: pos.symbol, solIn: s.buySol, tokens: pos.tokens, pricing: pos.pricing, entryMcapSol: pos.entryMcapSol });
    await this.say(buyMessage(pos, book.data.balanceSol));
  }

  private async manage(pos: Position, quote: SellQuote): Promise<void> {
    const { book, strategy: s, clock } = this.deps;
    const value = quote(pos.tokens);
    const remainingCost = pos.costSol * (pos.tokens / pos.boughtTokens);
    const pnlPct = (value / remainingCost - 1) * 100;
    pos.peakValueSol = Math.max(pos.peakValueSol, value);

    if (!pos.tookProfit && pnlPct >= s.takeProfitPct) {
      if (s.takeProfitSellPct >= 100) return this.sell(pos, pos.tokens, quote, "take profit");
      await this.sell(pos, pos.tokens * (s.takeProfitSellPct / 100), quote, "take profit");
      pos.tookProfit = true;
      pos.peakValueSol = quote(pos.tokens);
      book.changed();
      return;
    }
    if (pos.tookProfit && s.trailingStopPct > 0 && value <= pos.peakValueSol * (1 - s.trailingStopPct / 100)) {
      return this.sell(pos, pos.tokens, quote, "trailing stop");
    }
    if (!pos.tookProfit && pnlPct <= -s.stopLossPct) return this.sell(pos, pos.tokens, quote, "stop loss");
    if (clock() - pos.openedAt >= s.maxHoldMinutes * 60_000) return this.sell(pos, pos.tokens, quote, "time limit");
    book.changed();
  }

  private async sell(pos: Position, tokens: number, quote: SellQuote, reason: string): Promise<void> {
    const { book, strategy: s, clock } = this.deps;
    const proceeds = quote(tokens);
    pos.tokens = Math.max(0, pos.tokens - tokens);
    pos.proceedsSol += proceeds;
    pos.txCostSol += s.txCostSol;
    book.data.balanceSol += proceeds - s.txCostSol;
    this.record({ type: "sell", at: new Date(clock()).toISOString(), mint: pos.mint, symbol: pos.symbol, tokens, solOut: proceeds, reason });

    if (pos.tokens > pos.boughtTokens * 1e-9) {
      book.changed();
      await this.say(partialSellMessage(pos, tokens / (tokens + pos.tokens), proceeds, s.trailingStopPct, book.data.balanceSol));
      return;
    }

    book.data.open = book.data.open.filter((p) => p !== pos);
    const pnlSol = pos.proceedsSol - pos.costSol - pos.txCostSol;
    const trade: ClosedTrade = {
      mint: pos.mint,
      symbol: pos.symbol,
      source: pos.source,
      openedAt: pos.openedAt,
      closedAt: clock(),
      costSol: pos.costSol,
      proceedsSol: pos.proceedsSol,
      txCostSol: pos.txCostSol,
      pnlSol,
      pnlPct: (pnlSol / pos.costSol) * 100,
      reason,
    };
    book.data.closed.push(trade);
    book.data.day.realizedSol += pnlSol;
    book.changed();
    await this.say(sellMessage(trade, book.data.balanceSol));
    await this.checkDailyLimits();
  }

  private async sellQuote(pos: Position, curves: Map<string, CurveState>): Promise<SellQuote | undefined> {
    const s = this.deps.strategy;
    if (pos.pricing === "curve" && pos.bondingCurve) {
      const curve = curves.get(pos.bondingCurve);
      if (!curve) return undefined;
      if (!curve.complete) return (t) => solForTokens(curve, t, s.feePct);
      pos.pricing = "dex"; // graduated: it trades on a regular pool now
      this.deps.log.info("Coin graduated from pump.fun, switching to DEX prices", { mint: pos.mint });
    }
    const price = await this.dexPrice(pos.mint);
    if (price === undefined) return undefined;
    return (t) => t * price * (1 - (s.feePct + s.dexSlippagePct) / 100);
  }

  private async readCurve(key: string): Promise<CurveState | undefined> {
    const read = async () => (await this.deps.curves.read([key])).get(key);
    try {
      const curve = await read();
      if (curve) return curve;
      await new Promise((resolve) => setTimeout(resolve, this.deps.retryMs ?? 1000));
      return await read();
    } catch (err) {
      this.deps.log.warn("Couldn't read bonding curve", { err, key });
      return undefined;
    }
  }

  private async dexPrice(mint: string): Promise<number | undefined> {
    try {
      return (await this.deps.market.token(mint))?.priceSol;
    } catch (err) {
      this.deps.log.warn("DEX price lookup failed", { err, mint });
      return undefined;
    }
  }

  private async checkDailyLimits(): Promise<void> {
    const { book, strategy: s } = this.deps;
    const day = book.data.day;
    if (day.stoppedReason) return;
    if (s.dailyGoalSol > 0 && day.realizedSol >= s.dailyGoalSol) day.stoppedReason = "goal";
    else if (s.maxDailyLossSol > 0 && day.realizedSol <= -s.maxDailyLossSol) day.stoppedReason = "loss limit";
    else return;
    book.changed();
    await this.say(stopMessage(day.stoppedReason, day.realizedSol));
  }

  private rollDay(): void {
    const { book, clock } = this.deps;
    const today = utcDay(clock());
    if (book.data.day.date === today) return;
    book.data.day = { date: today, realizedSol: 0 };
    book.changed();
  }

  private skip(alert: CoinAlert, reason: string): void {
    this.skips.set(reason, (this.skips.get(reason) ?? 0) + 1);
    this.deps.log.info("Paper trade skipped", { mint: alert.mint, symbol: alert.symbol, reason });
  }

  private record(event: Record<string, unknown>): void {
    this.deps.ledger?.(event).catch((err) => this.deps.log.warn("Couldn't write the trade log", { err }));
  }

  private async say(text: string): Promise<void> {
    try {
      await this.deps.notifier.send(text);
    } catch (err) {
      this.deps.log.warn("Notification failed", { err });
    }
  }
}
