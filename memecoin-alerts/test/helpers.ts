import bs58 from "bs58";
import type { AlertSink, CoinAlert } from "../src/events.js";
import type { CoinRef, MarketData, MarketSnapshot } from "../src/market.js";
import type { Notifier } from "../src/notify.js";
import type { RpcClient } from "../src/rpc.js";
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../src/solana.js";

/** A valid, deterministic Solana address. */
export function addr(seed: number): string {
  return bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i * 7 + 1) & 255));
}

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

type Account = { owner: string; data: unknown } | null;

/** In-memory Solana RPC with just the methods the safety check uses. */
export class FakeRpc implements RpcClient {
  calls: Array<{ method: string; params: unknown[] }> = [];
  accounts = new Map<string, Account>();
  largest = new Map<string, Array<{ address: string; amount: string }>>();
  failOn = new Map<string, Error>();
  private nextSeed = 10_000;

  async call<T>(method: string, params: unknown[]): Promise<T> {
    this.calls.push({ method, params });
    const failure = this.failOn.get(method);
    if (failure) throw failure;
    switch (method) {
      case "getAccountInfo":
        return { value: this.accounts.get(params[0] as string) ?? null } as T;
      case "getTokenLargestAccounts":
        return { value: this.largest.get(params[0] as string) ?? [] } as T;
      case "getMultipleAccounts":
        return { value: (params[0] as string[]).map((a) => this.accounts.get(a) ?? null) } as T;
      default:
        throw new Error(`FakeRpc: unexpected ${method}`);
    }
  }

  addMint(
    mint: string,
    opts: {
      mintAuthority?: string | null;
      freezeAuthority?: string | null;
      supply?: string;
      token2022?: boolean;
      extensions?: Array<{ extension: string; state?: Record<string, unknown> }>;
    } = {},
  ): void {
    this.accounts.set(mint, {
      owner: opts.token2022 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
      data: {
        program: opts.token2022 ? "spl-token-2022" : "spl-token",
        parsed: {
          type: "mint",
          info: {
            mintAuthority: opts.mintAuthority ?? null,
            freezeAuthority: opts.freezeAuthority ?? null,
            supply: opts.supply ?? "1000000000000000",
            decimals: 6,
            ...(opts.extensions ? { extensions: opts.extensions } : {}),
          },
        },
      },
    });
  }

  addWallet(address: string): void {
    this.accounts.set(address, { owner: SYSTEM_PROGRAM, data: ["", "base64"] });
  }

  /** A holder of `mint`. `kind: "pool"` makes the holder a program account (bonding curve, AMM). */
  addHolder(mint: string, amount: bigint, kind: "wallet" | "pool" = "wallet"): string {
    const holder = addr(this.nextSeed++);
    const tokenAccount = addr(this.nextSeed++);
    if (kind === "wallet") this.addWallet(holder);
    else this.accounts.set(holder, { owner: PUMP_PROGRAM, data: ["AAAA", "base64"] });
    this.accounts.set(tokenAccount, { owner: TOKEN_PROGRAM, data: { parsed: { type: "account", info: { mint, owner: holder } } } });
    const list = this.largest.get(mint) ?? [];
    list.push({ address: tokenAccount, amount: amount.toString() });
    list.sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
    this.largest.set(mint, list);
    return holder;
  }
}

export class FakeMarket implements MarketData {
  tokens = new Map<string, MarketSnapshot>();
  pairs = new Map<string, CoinRef>();
  tokenCalls: string[] = [];
  failTokens = false;

  async token(mint: string): Promise<MarketSnapshot | null> {
    this.tokenCalls.push(mint);
    if (this.failTokens) throw new Error("DexScreener down");
    return this.tokens.get(mint) ?? null;
  }

  async pairCoin(pairAddress: string): Promise<CoinRef | null> {
    return this.pairs.get(pairAddress) ?? null;
  }
}

export function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    pairUrl: "https://dexscreener.com/solana/pair",
    dexId: "pumpfun",
    name: "Test Coin",
    symbol: "TEST",
    priceUsd: 0.001,
    marketCapUsd: 1_000_000,
    liquidityUsd: 50_000,
    volume5mUsd: 12_000,
    ...overrides,
  };
}

export class RecordingNotifier implements Notifier {
  messages: string[] = [];

  async send(text: string): Promise<void> {
    this.messages.push(text);
  }
}

export class RecordingSink implements AlertSink {
  alerts: CoinAlert[] = [];

  async publish(alert: CoinAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

/** A fetch stand-in that records requests and answers from a handler. */
export function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: fn, requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
