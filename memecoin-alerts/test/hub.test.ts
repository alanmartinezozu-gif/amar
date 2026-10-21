import { describe, expect, it } from "vitest";
import { formatAlert, formatDigest } from "../src/format.js";
import { AlertHub, type CoinTracker } from "../src/hub.js";
import { silentLogger } from "../src/logger.js";
import { StateStore } from "../src/state.js";
import type { XPost } from "../src/x.js";
import { FakeMarket, FakeRpc, RecordingNotifier, RecordingSink, addr, snapshot } from "./helpers.js";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");

function setup(opts: { rpc?: boolean } = { rpc: true }) {
  const rpc = new FakeRpc();
  const market = new FakeMarket();
  const notifier = new RecordingNotifier();
  const sink = new RecordingSink();
  const tracked: Array<Parameters<CoinTracker["track"]>[0]> = [];
  const state = StateStore.memory();
  const hub = new AlertHub({
    state,
    notifier,
    sinks: [sink],
    market,
    rpc: opts.rpc === false ? undefined : rpc,
    tracker: { track: (c) => void tracked.push(c) },
    log: silentLogger,
    clock: () => NOW,
    launchRetryMs: 0,
  });
  return { rpc, market, notifier, sink, tracked, state, hub };
}

function post(id: string, author: string, text = "new coin"): XPost {
  return { id, text, authorId: `id-${author}`, authorUsername: author, createdAt: new Date(NOW - 60_000).toISOString(), urls: [] };
}

describe("AlertHub.handlePost", () => {
  it("alerts once on a new coin from a tracked account, with checks and market data", async () => {
    const { rpc, market, notifier, sink, tracked, hub } = setup();
    const mint = addr(1);
    rpc.addMint(mint);
    market.tokens.set(mint, snapshot({ priceUsd: 0.002 }));

    await hub.handlePost({ mint, post: post("10", "kimchi1x"), tracked: true });
    await hub.handlePost({ mint, post: post("11", "kimchi1x"), tracked: true });

    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({
      type: "new_coin",
      id: `x:10:${mint}`,
      mint,
      source: "x",
      symbol: "TEST",
      mentions: 1,
      post: { author: "kimchi1x", tracked: true, url: "https://x.com/kimchi1x/status/10" },
      safety: { isToken: true, warnings: [] },
      market: { priceUsd: 0.002 },
    });
    expect(notifier.messages[0]).toContain(`CA: ${mint}`);
    expect(notifier.messages[0]).toContain("an account you track");
    expect(tracked).toEqual([{ mint, source: "x", name: "Test Coin", symbol: "TEST", priceUsd: 0.002 }]);
  });

  it("sends a short mention when another tracked account posts it, and stays quiet for untracked ones", async () => {
    const { rpc, sink, tracked, state, hub } = setup();
    const mint = addr(2);
    rpc.addMint(mint);

    await hub.handlePost({ mint, post: post("20", "first"), tracked: true });
    await hub.handlePost({ mint, post: post("21", "second"), tracked: true });
    await hub.handlePost({ mint, post: post("22", "rando"), tracked: false });

    expect(sink.alerts.map((a) => [a.type, a.mentions])).toEqual([
      ["new_coin", 1],
      ["mention", 2],
    ]);
    expect(state.sources(mint)).toEqual(["x:first", "x:second", "x:rando"]);
    expect(tracked).toHaveLength(1);
  });

  it("swaps a DexScreener pair address for the coin it trades", async () => {
    const { rpc, market, sink, hub } = setup();
    const pair = addr(3);
    const mint = addr(4);
    rpc.accounts.set(pair, { owner: addr(99), data: ["AAAA", "base64"] });
    rpc.addMint(mint);
    market.pairs.set(pair, { mint, name: "Real Coin", symbol: "REAL" });

    await hub.handlePost({ mint: pair, post: post("30", "kimchi1x", `https://dexscreener.com/solana/${pair}`), tracked: true });

    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({ mint, name: "Real Coin", symbol: "REAL", market: null });
  });

  it("ignores addresses that aren't coins", async () => {
    const { rpc, sink, hub } = setup();
    const wallet = addr(5);
    rpc.addWallet(wallet);
    await hub.handlePost({ mint: wallet, post: post("40", "kimchi1x", `send to ${wallet}`), tracked: true });
    expect(sink.alerts).toHaveLength(0);
  });

  it("still alerts without an RPC, marked as unchecked", async () => {
    const { sink, notifier, hub } = setup({ rpc: false });
    const mint = addr(6);
    await hub.handlePost({ mint, post: post("50", "rando"), tracked: false });
    expect(sink.alerts[0]).toMatchObject({ type: "new_coin", mint, market: null });
    expect(sink.alerts[0].safety).toBeUndefined();
    expect(notifier.messages[0]).toContain("Safety: not checked");
    expect(notifier.messages[0]).toContain("impersonators post fake contract addresses");
  });

  it("keeps alerting when one delivery channel fails", async () => {
    const { rpc, sink, hub } = setup();
    const failing = new AlertHub({
      state: StateStore.memory(),
      notifier: { send: async () => Promise.reject(new Error("Telegram down")) },
      sinks: [sink],
      market: new FakeMarket(),
      rpc,
      log: silentLogger,
      clock: () => NOW,
    });
    const mint = addr(7);
    rpc.addMint(mint);
    await failing.handlePost({ mint, post: post("60", "kimchi1x"), tracked: true });
    expect(sink.alerts).toHaveLength(1);
    void hub;
  });
});

describe("AlertHub.handleLaunch", () => {
  it("alerts on a matching launch once, with the launch details", async () => {
    const { rpc, sink, notifier, tracked, hub } = setup();
    const mint = addr(8);
    const creator = addr(9);
    rpc.addMint(mint, { freezeAuthority: addr(98) });

    const ev = { mint, name: "Moon Cat", symbol: "MCAT", creator, devBuySol: 2.5, marketCapSol: 32 };
    await hub.handleLaunch(ev, ['"cat"']);
    await hub.handleLaunch(ev, ['"cat"']);

    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({
      type: "new_coin",
      id: `launch:${mint}`,
      source: "launch",
      launch: { creator, devBuySol: 2.5, marketCapSol: 32, matched: ['"cat"'] },
      safety: { flags: ["freeze_authority"] },
    });
    expect(sink.alerts[0].market).toBeUndefined();
    const text = notifier.messages[0];
    expect(text).toContain('NEW LAUNCH on pump.fun: matched "cat"');
    expect(text).toContain("dev bought 2.50 SOL");
    expect(text).toContain("⚠️ The creator can freeze wallets");
    expect(tracked).toEqual([{ mint, source: "launch", name: "Moon Cat", symbol: "MCAT" }]);
  });

  it("checks a brand-new coin again if the RPC hasn't caught up yet", async () => {
    const { rpc, sink, hub } = setup();
    const mint = addr(12);
    let lookups = 0;
    const original = rpc.call.bind(rpc);
    rpc.call = async <T>(method: string, params: unknown[]): Promise<T> => {
      if (method === "getAccountInfo" && lookups++ === 0) return { value: null } as T;
      return original<T>(method, params);
    };
    rpc.addMint(mint);
    await hub.handleLaunch({ mint }, ["a creator you follow"]);
    expect(lookups).toBe(2);
    expect(sink.alerts[0].safety?.isToken).toBe(true);
  });
});

describe("formatAlert", () => {
  it("formats a follow-up with the change since the alert", () => {
    const text = formatAlert(
      {
        type: "update",
        id: "u",
        mint: addr(13),
        source: "x",
        at: new Date(NOW).toISOString(),
        symbol: "TEST",
        market: snapshot({ priceUsd: 0.0025, pairCreatedAt: new Date(NOW - 20 * 60_000).toISOString() }),
        update: { minutesSinceAlert: 15, priceChangeSinceAlertPct: 150 },
      },
      NOW,
    );
    expect(text).toMatch(/^📈 UPDATE \$TEST: 15 min after the alert\nPrice since alert: \+150%\n/);
    expect(text).toContain("Market: $0.00250 · mcap $1.00M · liquidity $50.0K · 5m volume $12.0K · trading for 20m");
  });

  it("formats the launch summary", () => {
    const mint = addr(14);
    const text = formatDigest({ minutes: 15, total: 1204, matched: 3, biggestDevBuys: [{ mint, symbol: "BIG", name: "Big Dev", devBuySol: 12 }] });
    expect(text).toBe(
      [
        "🧾 pump.fun, last 15 min: 1,204 new coins, 3 matched your filters.",
        "Biggest creator buys (often a sign of a planned dump, not a good coin):",
        `1. $BIG (Big Dev): 12.00 SOL · https://pump.fun/coin/${mint}`,
      ].join("\n"),
    );
  });
});
