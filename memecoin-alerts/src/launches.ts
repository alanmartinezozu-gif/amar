import WebSocket from "ws";
import { z } from "zod";
import type { Logger } from "./logger.js";
import { isSolanaAddress } from "./solana.js";

export interface LaunchEvent {
  mint: string;
  name?: string;
  symbol?: string;
  /** Wallet that created the coin. */
  creator?: string;
  /** SOL the creator spent buying their own coin at launch. */
  devBuySol?: number;
  marketCapSol?: number;
}

const finite = z.number().finite().optional().catch(undefined);
const text = z.string().optional().catch(undefined);

// PumpPortal's new-token message. Only `mint` is required; everything else is best effort.
const CreateMessage = z.object({
  mint: z.string(),
  txType: text,
  name: text,
  symbol: text,
  traderPublicKey: text,
  solAmount: finite,
  marketCapSol: finite,
});

/** Returns null for subscription acks, non-create messages and anything malformed. */
export function parseLaunchMessage(raw: string): LaunchEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = CreateMessage.safeParse(json);
  if (!parsed.success) return null;
  const m = parsed.data;
  if ((m.txType && m.txType !== "create") || !isSolanaAddress(m.mint)) return null;
  return {
    mint: m.mint,
    name: m.name?.trim() || undefined,
    symbol: m.symbol?.trim() || undefined,
    creator: m.traderPublicKey && isSolanaAddress(m.traderPublicKey) ? m.traderPublicKey : undefined,
    devBuySol: m.solAmount,
    marketCapSol: m.marketCapSol,
  };
}

export interface LaunchFilters {
  keywords: string[];
  creators: string[];
  /** 0 = off. */
  bigDevBuySol: number;
}

export function hasLaunchFilters(f: LaunchFilters): boolean {
  return f.keywords.length > 0 || f.creators.length > 0 || f.bigDevBuySol > 0;
}

/** Reasons this launch matched (any one is enough), or null to skip it. */
export function matchLaunch(ev: LaunchEvent, f: LaunchFilters): string[] | null {
  const reasons: string[] = [];
  if (ev.creator && f.creators.includes(ev.creator)) reasons.push("a creator you follow");
  const haystack = `${ev.name ?? ""} ${ev.symbol ?? ""}`.toLowerCase();
  for (const kw of f.keywords) {
    if (haystack.includes(kw.toLowerCase())) reasons.push(`"${kw}"`);
  }
  if (f.bigDevBuySol > 0 && (ev.devBuySol ?? 0) >= f.bigDevBuySol) reasons.push(`creator bought ${ev.devBuySol} SOL`);
  return reasons.length ? reasons : null;
}

export interface DigestSummary {
  minutes: number;
  total: number;
  matched: number;
  biggestDevBuys: LaunchEvent[];
}

/** Counts every launch between summaries, so you get a feel for the flow without 1,000 messages. */
export class LaunchDigest {
  private total = 0;
  private matched = 0;
  private biggest: LaunchEvent[] = [];

  constructor(private readonly topN = 5) {}

  record(ev: LaunchEvent, matched: boolean): void {
    this.total++;
    if (matched) this.matched++;
    if (!ev.devBuySol) return;
    this.biggest.push(ev);
    this.biggest.sort((a, b) => (b.devBuySol ?? 0) - (a.devBuySol ?? 0));
    this.biggest.length = Math.min(this.biggest.length, this.topN);
  }

  /** Summary since the last flush, or null if nothing launched. Resets the counts. */
  flush(minutes: number): DigestSummary | null {
    if (this.total === 0) return null;
    const summary = { minutes, total: this.total, matched: this.matched, biggestDevBuys: this.biggest };
    this.total = 0;
    this.matched = 0;
    this.biggest = [];
    return summary;
  }
}

/** The bits of a `ws` WebSocket this feed uses, so tests can pass a fake. */
export interface SocketLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate?(): void;
}

export interface LaunchFeedOptions {
  /** pump.fun launches constantly; this long with no message means the connection is dead. */
  silenceMs: number;
  maxBackoffMs: number;
}

/** Streams every new pump.fun coin from PumpPortal, reconnecting on its own. */
export class LaunchFeed {
  private socket?: SocketLike;
  private reconnectTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private attempts = 0;
  private lastMessageAt = 0;
  private stopped = true;

  constructor(
    private readonly url: string,
    private readonly onLaunch: (ev: LaunchEvent) => void,
    private readonly log: Logger,
    private readonly connect: (url: string) => SocketLike = (u) => new WebSocket(u),
    private readonly opts: LaunchFeedOptions = { silenceMs: 120_000, maxBackoffMs: 30_000 },
  ) {}

  start(): void {
    this.stopped = false;
    this.open();
    this.watchdog = setInterval(() => this.checkSilence(), Math.min(15_000, this.opts.silenceMs));
    this.watchdog.unref();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdog);
    this.socket?.close();
    this.socket = undefined;
  }

  private open(): void {
    const socket = this.connect(this.url);
    this.socket = socket;
    this.lastMessageAt = Date.now();
    socket.on("open", () => {
      this.attempts = 0;
      // PumpPortal asks for a single connection; one subscription covers every new coin.
      socket.send(JSON.stringify({ method: "subscribeNewToken" }));
      this.log.info("Connected to the pump.fun launch feed");
    });
    socket.on("message", (data: unknown) => {
      this.lastMessageAt = Date.now();
      const ev = parseLaunchMessage(String(data));
      if (!ev) return;
      try {
        this.onLaunch(ev);
      } catch (err) {
        this.log.error("Launch handler failed", { err, mint: ev.mint });
      }
    });
    socket.on("error", (err: Error) => this.log.warn("Launch feed error", { err }));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const delayMs = Math.min(1000 * 2 ** this.attempts, this.opts.maxBackoffMs);
    this.attempts++;
    this.log.warn("Launch feed disconnected, reconnecting", { delayMs });
    this.reconnectTimer = setTimeout(() => this.open(), delayMs);
  }

  private checkSilence(): void {
    const socket = this.socket;
    if (!socket || Date.now() - this.lastMessageAt <= this.opts.silenceMs) return;
    this.log.warn("Launch feed went quiet, reconnecting");
    if (socket.terminate) socket.terminate();
    else socket.close();
  }
}
