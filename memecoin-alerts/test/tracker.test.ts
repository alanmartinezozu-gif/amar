import { describe, expect, it } from "vitest";
import type { CoinAlert } from "../src/events.js";
import { silentLogger } from "../src/logger.js";
import { FollowUpTracker } from "../src/tracker.js";
import { FakeMarket, addr, snapshot } from "./helpers.js";

const START = Date.parse("2026-10-21T12:00:00.000Z");
const MIN = 60_000;

function setup(minutes = [5, 15, 60], maxTracked = 10) {
  let now = START;
  const market = new FakeMarket();
  const sent: CoinAlert[] = [];
  const tracker = new FollowUpTracker(market, async (a) => void sent.push(a), { minutes, maxTracked }, silentLogger, () => now);
  return { market, sent, tracker, at: (m: number) => (now = START + m * MIN) };
}

describe("FollowUpTracker", () => {
  it("sends an update at each checkpoint with the change since the alert, then forgets the coin", async () => {
    const { market, sent, tracker, at } = setup();
    const mint = addr(1);
    tracker.track({ mint, source: "x", symbol: "TEST", priceUsd: 0.001 });

    at(4);
    await tracker.tick();
    expect(sent).toHaveLength(0);

    market.tokens.set(mint, snapshot({ priceUsd: 0.003 }));
    at(5);
    await tracker.tick();
    market.tokens.set(mint, snapshot({ priceUsd: 0.0005 }));
    at(15);
    await tracker.tick();
    at(60);
    await tracker.tick();

    expect(sent.map((a) => [a.type, a.update?.minutesSinceAlert, Math.round(a.update?.priceChangeSinceAlertPct ?? NaN)])).toEqual([
      ["update", 5, 200],
      ["update", 15, -50],
      ["update", 60, -50],
    ]);
    expect(sent[0].id).toBe(`update:${mint}:5`);
    expect(tracker.size).toBe(0);
  });

  it("uses the first price it sees when the coin wasn't trading at alert time", async () => {
    const { market, sent, tracker, at } = setup();
    const mint = addr(2);
    tracker.track({ mint, source: "launch" });

    at(5);
    await tracker.tick();
    market.tokens.set(mint, snapshot({ priceUsd: 0.001, symbol: "NEW" }));
    at(15);
    await tracker.tick();
    market.tokens.set(mint, snapshot({ priceUsd: 0.002 }));
    at(60);
    await tracker.tick();

    expect(sent.map((a) => a.update?.priceChangeSinceAlertPct)).toEqual([undefined, undefined, 100]);
    expect(sent[0].market).toBeNull();
    expect(sent[2].symbol).toBe("NEW");
  });

  it("sends only the latest checkpoint after a long pause", async () => {
    const { sent, tracker, at } = setup();
    tracker.track({ mint: addr(3), source: "x" });
    at(20);
    await tracker.tick();
    expect(sent.map((a) => a.update?.minutesSinceAlert)).toEqual([15]);
  });

  it("does nothing when follow-ups are off, and drops the oldest coin when full", () => {
    const off = setup([]);
    off.tracker.track({ mint: addr(4), source: "x" });
    expect(off.tracker.size).toBe(0);

    const full = setup([5], 2);
    full.tracker.track({ mint: addr(5), source: "x" });
    full.tracker.track({ mint: addr(6), source: "x" });
    full.tracker.track({ mint: addr(7), source: "x" });
    expect(full.tracker.size).toBe(2);
  });

  it("skips a checkpoint if the market lookup fails", async () => {
    const { market, sent, tracker, at } = setup([5]);
    tracker.track({ mint: addr(8), source: "x" });
    market.failTokens = true;
    at(5);
    await tracker.tick();
    expect(sent).toHaveLength(0);
    expect(tracker.size).toBe(0);
  });
});
