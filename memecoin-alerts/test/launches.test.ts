import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LaunchDigest,
  LaunchFeed,
  hasLaunchFilters,
  matchLaunch,
  parseLaunchMessage,
  type LaunchEvent,
  type SocketLike,
} from "../src/launches.js";
import { silentLogger } from "../src/logger.js";
import { addr } from "./helpers.js";

const mint = addr(1);
const creator = addr(2);

describe("parseLaunchMessage", () => {
  it("reads a PumpPortal create message", () => {
    const raw = JSON.stringify({
      signature: "sig",
      mint,
      traderPublicKey: creator,
      txType: "create",
      solAmount: 1.5,
      marketCapSol: 31.2,
      name: " Moon Cat ",
      symbol: "MCAT",
      pool: "pump",
      bondingCurveKey: addr(3),
      vSolInBondingCurve: 31.5,
      vTokensInBondingCurve: 1021891891.89,
    });
    expect(parseLaunchMessage(raw)).toEqual({
      mint,
      name: "Moon Cat",
      symbol: "MCAT",
      creator,
      devBuySol: 1.5,
      marketCapSol: 31.2,
      bondingCurve: addr(3),
      vSolInCurve: 31.5,
      vTokensInCurve: 1021891891.89,
    });
  });

  it("skips acks, trades and junk", () => {
    expect(parseLaunchMessage(JSON.stringify({ message: "Successfully subscribed to token creation events." }))).toBeNull();
    expect(parseLaunchMessage(JSON.stringify({ mint, txType: "buy" }))).toBeNull();
    expect(parseLaunchMessage(JSON.stringify({ mint: "nope", txType: "create" }))).toBeNull();
    expect(parseLaunchMessage("{not json")).toBeNull();
  });

  it("tolerates odd field types instead of dropping the launch", () => {
    expect(parseLaunchMessage(JSON.stringify({ mint, txType: "create", solAmount: "lots", name: 42 }))).toEqual({
      mint,
      name: undefined,
      symbol: undefined,
      creator: undefined,
      devBuySol: undefined,
      marketCapSol: undefined,
    });
  });
});

describe("matchLaunch", () => {
  const ev: LaunchEvent = { mint, name: "Kimchi Coin", symbol: "KIM", creator, devBuySol: 3 };
  const none = { keywords: [], creators: [], bigDevBuySol: 0 };

  it("matches keywords in the name or ticker, ignoring case", () => {
    expect(matchLaunch(ev, { ...none, keywords: ["kimchi", "dog"] })).toEqual(['"kimchi"']);
    expect(matchLaunch(ev, { ...none, keywords: ["kim"] })).toEqual(['"kim"']);
  });

  it("matches followed creators and big creator buys", () => {
    expect(matchLaunch(ev, { ...none, creators: [creator] })).toEqual(["a creator you follow"]);
    expect(matchLaunch(ev, { ...none, bigDevBuySol: 2 })).toEqual(["creator bought 3 SOL"]);
    expect(matchLaunch(ev, { ...none, bigDevBuySol: 5 })).toBeNull();
  });

  it("matches nothing without filters", () => {
    expect(hasLaunchFilters(none)).toBe(false);
    expect(matchLaunch(ev, none)).toBeNull();
  });
});

describe("LaunchDigest", () => {
  it("counts launches and keeps the biggest creator buys", () => {
    const digest = new LaunchDigest(2);
    digest.record({ mint: addr(10), devBuySol: 1 }, false);
    digest.record({ mint: addr(11), devBuySol: 9 }, true);
    digest.record({ mint: addr(12) }, false);
    digest.record({ mint: addr(13), devBuySol: 4 }, false);

    const summary = digest.flush(15);
    expect(summary).toMatchObject({ minutes: 15, total: 4, matched: 1 });
    expect(summary?.biggestDevBuys.map((e) => e.devBuySol)).toEqual([9, 4]);
    expect(digest.flush(15)).toBeNull();
  });
});

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  closed = false;
  terminated = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  terminate(): void {
    this.terminated = true;
    this.emit("close");
  }
}

describe("LaunchFeed", () => {
  let sockets: FakeSocket[];
  let launches: LaunchEvent[];
  let feed: LaunchFeed;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    launches = [];
    feed = new LaunchFeed(
      "wss://feed.test",
      (ev) => launches.push(ev),
      silentLogger,
      () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      { silenceMs: 60_000, maxBackoffMs: 4_000 },
    );
  });

  afterEach(() => {
    feed.stop();
    vi.useRealTimers();
  });

  it("subscribes on connect and passes launches through", () => {
    feed.start();
    sockets[0].emit("open");
    expect(sockets[0].sent).toEqual([JSON.stringify({ method: "subscribeNewToken" })]);

    sockets[0].emit("message", Buffer.from(JSON.stringify({ mint, txType: "create", name: "A" })));
    sockets[0].emit("message", Buffer.from(JSON.stringify({ message: "ack" })));
    expect(launches.map((l) => l.mint)).toEqual([mint]);
  });

  it("reconnects with growing delays, capped, and resets after a good connection", () => {
    feed.start();
    sockets[0].emit("close");
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1].emit("close");
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(3);
    sockets[2].emit("close");
    vi.advanceTimersByTime(4_000);
    expect(sockets).toHaveLength(4);
    sockets[3].emit("close");
    vi.advanceTimersByTime(4_000); // capped at maxBackoffMs
    expect(sockets).toHaveLength(5);

    sockets[4].emit("open");
    sockets[4].emit("close");
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(6);
  });

  it("drops a connection that goes quiet", () => {
    feed.start();
    sockets[0].emit("open");
    vi.advanceTimersByTime(75_000);
    expect(sockets[0].terminated).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
  });

  it("stays down after stop", () => {
    feed.start();
    feed.stop();
    expect(sockets[0].closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});
