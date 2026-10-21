import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  JsonlSink,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WebhookSink,
  signAlert,
  verifyAlertSignature,
  type CoinAlert,
} from "../src/events.js";
import { silentLogger } from "../src/logger.js";
import { DexScreener } from "../src/market.js";
import { MultiNotifier, TelegramNotifier } from "../src/notify.js";
import { StateStore } from "../src/state.js";
import { addr, fakeFetch, json } from "./helpers.js";

const alert: CoinAlert = { type: "new_coin", id: "launch:x", mint: addr(1), source: "launch", at: "2026-10-21T12:00:00.000Z" };

describe("alert signatures", () => {
  const secret = "0123456789abcdef-secret";
  const now = 1_800_000_000_000;

  it("verifies a signed body and rejects tampering, wrong secrets and replays", () => {
    const body = JSON.stringify(alert);
    const ts = String(now);
    const sig = signAlert(secret, ts, body);
    expect(verifyAlertSignature(secret, ts, body, sig, now)).toBe(true);
    expect(verifyAlertSignature(secret, ts, body.replace("launch", "x"), sig, now)).toBe(false);
    expect(verifyAlertSignature("another-secret-value", ts, body, sig, now)).toBe(false);
    expect(verifyAlertSignature(secret, ts, body, sig, now + 6 * 60_000)).toBe(false);
    expect(verifyAlertSignature(secret, undefined, body, sig, now)).toBe(false);
    expect(verifyAlertSignature(secret, ts, body, "zz", now)).toBe(false);
  });

  it("WebhookSink posts JSON your bot can verify", async () => {
    const { fetch, requests } = fakeFetch(() => new Response(null, { status: 204 }));
    await new WebhookSink("http://bot.test/alerts", secret, fetch, () => now).publish(alert);

    const { init } = requests[0];
    const headers = init?.headers as Record<string, string>;
    expect(JSON.parse(init?.body as string)).toEqual(alert);
    expect(verifyAlertSignature(secret, headers[TIMESTAMP_HEADER], init?.body as string, headers[SIGNATURE_HEADER], now)).toBe(true);
  });

  it("WebhookSink surfaces failures", async () => {
    const { fetch } = fakeFetch(() => new Response("nope", { status: 500 }));
    await expect(new WebhookSink("http://bot.test/alerts", secret, fetch).publish(alert)).rejects.toThrow(/HTTP 500/);
  });
});

describe("files", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("JsonlSink appends one alert per line", async () => {
    dir = await mkdtemp(join(tmpdir(), "alerts-"));
    const sink = new JsonlSink(join(dir, "nested", "alerts.jsonl"));
    await sink.publish(alert);
    await sink.publish({ ...alert, id: "second" });
    const lines = (await readFile(join(dir, "nested", "alerts.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(["launch:x", "second"]);
  });

  it("StateStore survives a restart and caps how many coins it remembers", async () => {
    dir = await mkdtemp(join(tmpdir(), "state-"));
    const path = join(dir, "state.json");
    const state = await StateStore.open(path, undefined, 2);
    state.addSource(addr(1), "launch", 1);
    state.addSource(addr(2), "x:a", 2);
    state.addSource(addr(3), "launch", 3, { name: "Space Cat", symbol: "SCAT" });
    state.addSource(addr(3), "x:b", 4, { symbol: "OTHER" });
    state.setSinceId("q", "42");
    state.addKeywordReads("2026-10-21", 120);
    await state.flush();

    const reopened = await StateStore.open(path);
    expect(reopened.isAlerted(addr(1))).toBe(false);
    expect(reopened.sources(addr(3))).toEqual(["launch", "x:b"]);
    expect(reopened.names(addr(3))).toEqual({ name: "Space Cat", symbol: "SCAT" });
    expect(reopened.sinceId("q")).toBe("42");
    // The X keyword allowance must not reset when the bot restarts.
    expect(reopened.keywordReads("2026-10-21")).toBe(120);
    expect(reopened.keywordReads("2026-10-22")).toBe(0);
  });
});

describe("TelegramNotifier", () => {
  it("retries after Telegram's rate limit and never leaks the token in errors", async () => {
    let calls = 0;
    const { fetch, requests } = fakeFetch(() => {
      calls++;
      if (calls === 1) return json({ ok: false, parameters: { retry_after: 3 } }, 429);
      if (calls === 2) return json({ ok: true });
      return json({ ok: false, description: "chat not found" }, 400);
    });
    const sleeps: number[] = [];
    const telegram = new TelegramNotifier("123:SECRET", "-100", fetch, async (ms) => void sleeps.push(ms), 0);

    await telegram.send("hello");
    expect(requests[0].url).toBe("https://api.telegram.org/bot123:SECRET/sendMessage");
    expect(JSON.parse(requests[1].init?.body as string)).toMatchObject({ chat_id: "-100", text: "hello" });
    expect(sleeps).toContain(3000);

    const err = await telegram.send("again").catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 400/);
    expect(String(err)).not.toContain("SECRET");
  });

  it("MultiNotifier delivers to the healthy channel when another fails", async () => {
    const delivered: string[] = [];
    const multi = new MultiNotifier(
      [{ send: async () => Promise.reject(new Error("down")) }, { send: async (t) => void delivered.push(t) }],
      silentLogger,
    );
    await multi.send("hi");
    expect(delivered).toEqual(["hi"]);
  });
});

describe("DexScreener", () => {
  it("picks the deepest Solana pair for a coin", async () => {
    const mint = addr(1);
    const pair = (address: string, liquidity: number, chainId = "solana") => ({
      chainId,
      dexId: "raydium",
      url: `https://dexscreener.com/solana/${address}`,
      pairAddress: address,
      baseToken: { address: mint, name: "Coin", symbol: "C" },
      priceUsd: "0.0123",
      marketCap: 1234567,
      liquidity: { usd: liquidity },
      volume: { m5: 100, h1: 1000 },
      priceChange: { m5: 1.5, h1: -3 },
      pairCreatedAt: 1_800_000_000_000,
    });
    const { fetch, requests } = fakeFetch(() => json({ pairs: [pair("p1", 10), pair("p2", 500), pair("p3", 9999, "ethereum"), { junk: true }] }));
    const snap = await new DexScreener("https://dex.test", fetch).token(mint);
    expect(requests[0].url).toBe(`https://dex.test/latest/dex/tokens/${mint}`);
    expect(snap).toEqual({
      pairUrl: "https://dexscreener.com/solana/p2",
      dexId: "raydium",
      name: "Coin",
      symbol: "C",
      priceUsd: 0.0123,
      marketCapUsd: 1234567,
      liquidityUsd: 500,
      volume5mUsd: 100,
      volume1hUsd: 1000,
      priceChange5mPct: 1.5,
      priceChange1hPct: -3,
      pairCreatedAt: new Date(1_800_000_000_000).toISOString(),
    });
  });

  it("finds the coin behind a pair, even when SOL is listed first", async () => {
    const mint = addr(2);
    const sol = "So11111111111111111111111111111111111111112";
    const { fetch } = fakeFetch(() =>
      json({
        pairs: [
          {
            chainId: "solana",
            url: "u",
            pairAddress: "pairX",
            baseToken: { address: sol, symbol: "SOL" },
            quoteToken: { address: mint, name: "Coin", symbol: "C" },
          },
        ],
      }),
    );
    expect(await new DexScreener("https://dex.test", fetch).pairCoin("pairX")).toEqual({ mint, name: "Coin", symbol: "C" });
  });

  it("returns null when nothing trades yet", async () => {
    const { fetch } = fakeFetch(() => json({ pairs: null }));
    expect(await new DexScreener("https://dex.test", fetch).token(addr(3))).toBeNull();
  });
});
