import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signAlert, type CoinAlert } from "../src/events.js";
import { silentLogger } from "../src/logger.js";
import { PaperBook } from "../src/paper/book.js";
import { loadPaperConfig } from "../src/paper/config.js";
import {
  RpcCurveSource,
  decodeBondingCurve,
  mcapSol,
  priceSol,
  solForTokens,
  tokensForSol,
  type CurveSource,
  type CurveState,
} from "../src/paper/curve.js";
import { createAlertServer } from "../src/paper/server.js";
import { PaperTrader, type Strategy } from "../src/paper/trader.js";
import { PUMP_PROGRAM } from "../src/solana.js";
import { FakeMarket, RecordingNotifier, addr, snapshot } from "./helpers.js";

const START = Date.parse("2026-10-21T12:00:00.000Z");
const MIN = 60_000;

/** A curve just after creation with a 2 SOL dev buy, like a real pump.fun launch. */
function freshCurve(overrides: Partial<CurveState> = {}): CurveState {
  return { vSol: 32, vTokens: 1_005_000_000, realTokens: 725_000_000, realSol: 2, totalSupply: 1_000_000_000, complete: false, ...overrides };
}

/** Same curve with the price multiplied by `factor` (keeps vSol × vTokens constant). */
function moved(c: CurveState, factor: number): CurveState {
  const r = Math.sqrt(factor);
  return { ...c, vSol: c.vSol * r, vTokens: c.vTokens / r, realSol: c.realSol + 100 };
}

function encodeCurve(c: CurveState): Buffer {
  const buf = Buffer.alloc(81);
  const u64 = (offset: number, v: number) => buf.writeBigUInt64LE(BigInt(Math.round(v)), offset);
  u64(8, c.vTokens * 1e6);
  u64(16, c.vSol * 1e9);
  u64(24, c.realTokens * 1e6);
  u64(32, c.realSol * 1e9);
  u64(40, c.totalSupply * 1e6);
  buf[48] = c.complete ? 1 : 0;
  return buf;
}

class FakeCurves implements CurveSource {
  states = new Map<string, CurveState>();
  reads = 0;

  async read(keys: string[]): Promise<Map<string, CurveState>> {
    this.reads++;
    return new Map(keys.flatMap((k) => (this.states.has(k) ? [[k, this.states.get(k)!] as const] : [])));
  }
}

const STRATEGY: Strategy = {
  buySol: 0.5,
  sources: ["launch"],
  skipRedFlags: true,
  maxEntryDelaySec: 120,
  maxEntryMcapSol: 60,
  takeProfitPct: 50,
  takeProfitSellPct: 100,
  trailingStopPct: 30,
  stopLossPct: 35,
  maxHoldMinutes: 30,
  maxOpenPositions: 5,
  dailyGoalSol: 0,
  maxDailyLossSol: 0,
  feePct: 1.25,
  txCostSol: 0.003,
  dexSlippagePct: 3,
};

function setup(strategy: Partial<Strategy> = {}) {
  let now = START;
  const curves = new FakeCurves();
  const market = new FakeMarket();
  const notifier = new RecordingNotifier();
  const book = PaperBook.memory(5);
  const ledger: Array<Record<string, unknown>> = [];
  const trader = new PaperTrader({
    book,
    curves,
    market,
    notifier,
    strategy: { ...STRATEGY, ...strategy },
    log: silentLogger,
    clock: () => now,
    ledger: async (e) => void ledger.push(e),
    retryMs: 0,
  });
  let seed = 100;
  const launch = (overrides: Partial<CoinAlert> = {}, curve: CurveState | null = freshCurve()): CoinAlert => {
    const mint = addr(seed++);
    const key = addr(seed++);
    if (curve) curves.states.set(key, curve);
    return {
      type: "new_coin",
      id: `launch:${mint}`,
      mint,
      source: "launch",
      at: new Date(now).toISOString(),
      symbol: "CAT",
      name: "Cat Coin",
      launch: { bondingCurve: key, vSolInCurve: 32, vTokensInCurve: 1_005_000_000, matched: ['"cat"'] },
      safety: { isToken: true, flags: [], warnings: [] },
      ...overrides,
    };
  };
  return { curves, market, notifier, book, ledger, trader, launch, advance: (ms: number) => (now += ms) };
}

describe("bonding curve math", () => {
  it("decodes the on-chain account", () => {
    const c = freshCurve();
    expect(decodeBondingCurve(encodeCurve(c))).toEqual(c);
    expect(decodeBondingCurve(Buffer.alloc(20))).toBeNull();
  });

  it("prices like pump.fun: ~32 SOL market cap at launch", () => {
    const c = freshCurve();
    expect(priceSol(c)).toBeCloseTo(32 / 1_005_000_000);
    expect(mcapSol(c)).toBeCloseTo(31.84, 1);
  });

  it("loses about two fees on an instant round trip, and can't buy more than the curve holds", () => {
    const c = freshCurve();
    const tokens = tokensForSol(c, 1, 1.25);
    const after = { ...c, vSol: c.vSol + 1 * 0.9875, vTokens: c.vTokens - tokens };
    expect(solForTokens(after, tokens, 1.25)).toBeCloseTo(0.9875 * 0.9875, 6);
    expect(tokensForSol({ ...c, realTokens: 10 }, 5, 0)).toBe(10);
  });

  it("reads curves over RPC and ignores accounts the pump.fun program doesn't own", async () => {
    const good = addr(1);
    const fake = addr(2);
    const rpc = {
      call: async <T>(_m: string, params: unknown[]) =>
        ({
          value: (params[0] as string[]).map((k) =>
            k === good ? { owner: PUMP_PROGRAM, data: [encodeCurve(freshCurve()).toString("base64"), "base64"] } : { owner: addr(3), data: ["", "base64"] },
          ),
        }) as T,
    };
    const states = await new RpcCurveSource(rpc).read([good, fake]);
    expect([...states.keys()]).toEqual([good]);
    expect(states.get(good)?.vSol).toBeCloseTo(32);
  });
});

describe("PaperTrader entries", () => {
  it("buys a fresh launch off the live curve and reports it", async () => {
    const { curves, notifier, book, ledger, trader, launch } = setup();
    const alert = launch();
    curves.states.set(alert.launch!.bondingCurve!, moved(freshCurve(), 1.2));
    await trader.onAlert(alert);

    expect(book.data.open).toHaveLength(1);
    const pos = book.data.open[0];
    expect(pos.tokens).toBeCloseTo(tokensForSol(moved(freshCurve(), 1.2), 0.5, 1.25));
    expect(pos.entryVsCreationPct).toBeCloseTo(20);
    expect(book.data.balanceSol).toBeCloseTo(5 - 0.503);
    expect(notifier.messages[0]).toMatch(/^📝 PAPER BUY \$CAT \(Cat Coin\)\n0\.50 SOL → [\d.]+M tokens · mcap 38\.2 SOL · price already \+20\.0% since creation/);
    expect(ledger[0]).toMatchObject({ type: "buy", mint: alert.mint, solIn: 0.5 });
  });

  it("skips what Kimchi would have skipped, and counts why", async () => {
    const { notifier, book, trader, launch, advance } = setup();
    await trader.onAlert(launch({ safety: { isToken: true, flags: ["freeze_authority"], warnings: [] } }));
    const stale = launch();
    advance(3 * MIN);
    await trader.onAlert(stale);
    await trader.onAlert(launch({}, moved(freshCurve(), 3)));
    await trader.onAlert(launch({}, null));
    await trader.onAlert(launch({ source: "x" }));

    expect(book.data.open).toHaveLength(0);
    expect(notifier.messages).toHaveLength(0);
    expect(trader.summary()).toContain(
      "Skipped since last summary: 1 red flags, 1 too late, 1 already pumped, 1 no price, 1 not a source you trade",
    );
    expect(trader.summary()).not.toContain("Skipped");
  });

  it("only trades X alerts from tracked accounts, priced off DexScreener", async () => {
    const { market, book, trader, launch } = setup({ sources: ["x"] });
    const untracked = launch({ source: "x", launch: undefined, post: { author: "rando", tracked: false, url: "", text: "" } });
    const tracked = launch({ source: "x", launch: undefined, post: { author: "kimchi1x", tracked: true, url: "", text: "" } });
    market.tokens.set(tracked.mint, snapshot({ priceSol: 0.000001 }));
    await trader.onAlert(untracked);
    await trader.onAlert(tracked);
    expect(book.data.open.map((p) => [p.mint, p.pricing])).toEqual([[tracked.mint, "dex"]]);
    expect(book.data.open[0].tokens).toBeCloseTo((0.5 * (1 - 0.0425)) / 0.000001);
  });

  it("ignores duplicates and never goes over the position limit, even with alerts arriving together", async () => {
    const { book, trader, launch } = setup({ maxOpenPositions: 2 });
    const first = launch();
    await Promise.all([trader.onAlert(first), trader.onAlert(first), trader.onAlert(launch()), trader.onAlert(launch())]);
    expect(book.data.open).toHaveLength(2);
    expect(trader.summary()).toContain("1 max open positions");
  });

  it("stops when the paper money runs out", async () => {
    const { book, trader, launch } = setup({ buySol: 2.4 });
    for (let i = 0; i < 3; i++) await trader.onAlert(launch());
    expect(book.data.open).toHaveLength(2);
    expect(trader.summary()).toContain("1 out of paper SOL");
  });
});

describe("PaperTrader exits", () => {
  async function opened(strategy: Partial<Strategy> = {}) {
    const s = setup(strategy);
    const alert = s.launch();
    await s.trader.onAlert(alert);
    const key = alert.launch!.bondingCurve!;
    const priceAt = (factor: number) => s.curves.states.set(key, moved(freshCurve(), factor));
    s.notifier.messages.length = 0;
    return { ...s, alert, priceAt };
  }

  it("takes profit at +50% after fees", async () => {
    const { book, notifier, trader, priceAt, advance } = await opened();
    priceAt(1.3);
    await trader.tick();
    expect(book.data.open).toHaveLength(1);

    priceAt(1.8);
    advance(95_000);
    await trader.tick();
    expect(book.data.open).toHaveLength(0);
    const trade = book.data.closed[0];
    expect(trade.reason).toBe("take profit");
    expect(trade.pnlPct).toBeGreaterThan(50);
    expect(trade.txCostSol).toBeCloseTo(0.006);
    expect(book.data.balanceSol).toBeCloseTo(5 + trade.pnlSol);
    expect(notifier.messages[0]).toMatch(/^✅ PAPER SELL \$CAT: take profit\n\+\d+\.\d% \(\+0\.\d+ SOL after fees\) · held 1m 35s/);
  });

  it("cuts losers at the stop loss", async () => {
    const { book, notifier, trader, priceAt } = await opened();
    priceAt(0.6);
    await trader.tick();
    expect(book.data.closed[0]).toMatchObject({ reason: "stop loss" });
    expect(book.data.closed[0].pnlPct).toBeLessThan(-35);
    expect(notifier.messages[0]).toMatch(/^❌ PAPER SELL \$CAT: stop loss/);
  });

  it("gets out at the time limit", async () => {
    const { book, trader, priceAt, advance } = await opened();
    priceAt(1.1);
    advance(29 * MIN);
    await trader.tick();
    expect(book.data.open).toHaveLength(1);
    advance(1 * MIN);
    await trader.tick();
    expect(book.data.closed[0].reason).toBe("time limit");
  });

  it("can sell part at take profit and trail the rest", async () => {
    const { book, notifier, trader, priceAt } = await opened({ takeProfitSellPct: 50, trailingStopPct: 30 });
    priceAt(2);
    await trader.tick();
    expect(book.data.open[0].tookProfit).toBe(true);
    expect(notifier.messages[0]).toMatch(/^📝 PAPER SELL 50% of \$CAT: take profit\ngot [\d.]+ SOL · the rest rides with a 30% trailing stop/);

    priceAt(5);
    await trader.tick();
    priceAt(4); // -20% from the peak: hold
    await trader.tick();
    expect(book.data.open).toHaveLength(1);
    priceAt(3.2); // -36% from the peak: out
    await trader.tick();
    expect(book.data.closed[0]).toMatchObject({ reason: "trailing stop" });
    expect(book.data.closed[0].pnlPct).toBeGreaterThan(100);
  });

  it("switches to DEX prices when the coin graduates", async () => {
    const { book, market, curves, trader, alert } = await opened();
    curves.states.set(alert.launch!.bondingCurve!, { ...freshCurve(), complete: true });
    const entryPrice = 0.5 / book.data.open[0].tokens;
    market.tokens.set(alert.mint, snapshot({ priceSol: entryPrice * 2 }));
    await trader.tick();
    expect(book.data.closed[0]).toMatchObject({ reason: "take profit" });
  });

  it("holds when no price is available instead of guessing", async () => {
    const { book, curves, trader, alert, advance } = await opened();
    curves.states.delete(alert.launch!.bondingCurve!);
    advance(60 * MIN);
    await trader.tick();
    expect(book.data.open).toHaveLength(1);
  });

  it("quits for the day at the goal and starts again tomorrow", async () => {
    const { book, notifier, trader, priceAt, launch, advance } = await opened({ dailyGoalSol: 0.2 });
    priceAt(2);
    await trader.tick();
    expect(book.data.day.stoppedReason).toBe("goal");
    expect(notifier.messages.at(-1)).toMatch(/^🏁 Paper bot hit today's goal \(\+0\.\d+ SOL\)/);

    await trader.onAlert(launch());
    expect(book.data.open).toHaveLength(0);

    advance(24 * 60 * MIN);
    await trader.onAlert(launch());
    expect(book.data.open).toHaveLength(1);
  });

  it("summarizes results", async () => {
    const { trader, priceAt } = await opened();
    priceAt(2);
    await trader.tick();
    const text = trader.summary();
    expect(text).toMatch(/^📊 PAPER RESULTS \(pretend money\)\nToday: 1 trades · 1 won \(100%\) · \+0\.\d+ SOL\nAll time: 1 trades/);
    expect(text).toMatch(/Balance: 5\.\d+ SOL \(started with 5\.00 SOL\) · 0 open/);
  });
});

describe("alert server", () => {
  const secret = "paper-test-secret-123";

  async function withServer(fn: (post: (body: string, sign?: boolean) => Promise<number>, received: CoinAlert[]) => Promise<void>) {
    const received: CoinAlert[] = [];
    const server = createAlertServer(secret, (a) => received.push(a), silentLogger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const post = async (body: string, sign = true) => {
      const ts = String(Date.now());
      const headers: Record<string, string> = sign ? { [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: signAlert(secret, ts, body) } : {};
      return (await fetch(`http://127.0.0.1:${port}/alerts`, { method: "POST", body, headers })).status;
    };
    try {
      await fn(post, received);
    } finally {
      server.close();
    }
  }

  it("accepts signed alerts once and rejects unsigned ones", async () => {
    await withServer(async (post, received) => {
      const body = JSON.stringify({ type: "new_coin", id: "a1", mint: addr(1), source: "launch", at: new Date().toISOString() });
      expect(await post(body)).toBe(204);
      expect(await post(body)).toBe(204);
      expect(await post(body, false)).toBe(401);
      expect(received.map((a) => a.id)).toEqual(["a1"]);
    });
  });
});

describe("loadPaperConfig", () => {
  const base = { ALERT_WEBHOOK_SECRET: "0123456789abcdef", SOLANA_RPC_URL: "https://rpc.test" };

  it("defaults to Kimchi's rules", () => {
    const c = loadPaperConfig(base);
    expect(c).toMatchObject({
      PAPER_SOURCES: ["launch"],
      PAPER_BUY_SOL: 0.5,
      PAPER_TAKE_PROFIT_PCT: 50,
      PAPER_MAX_ENTRY_DELAY_SECONDS: 120,
      PAPER_PORT: 8787,
      PAPER_HOST: "127.0.0.1",
    });
  });

  it("needs the shared secret and an RPC, and checks the rules", () => {
    expect(() => loadPaperConfig({})).toThrow(/ALERT_WEBHOOK_SECRET[\s\S]*SOLANA_RPC_URL/);
    expect(() => loadPaperConfig({ ...base, PAPER_SOURCES: "launch, tiktok" })).toThrow(/PAPER_SOURCES/);
    expect(() => loadPaperConfig({ ...base, PAPER_BUY_SOL: "10" })).toThrow(/can't be more than PAPER_START_SOL/);
    expect(loadPaperConfig({ ...base, PAPER_SOURCES: "Launch,X" }).PAPER_SOURCES).toEqual(["launch", "x"]);
  });
});
