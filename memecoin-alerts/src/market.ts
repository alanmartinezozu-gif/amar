import { z } from "zod";
import { QUOTE_MINTS } from "./solana.js";

export interface MarketSnapshot {
  pairUrl: string;
  dexId: string;
  name?: string;
  symbol?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volume5mUsd?: number;
  volume1hUsd?: number;
  priceChange5mPct?: number;
  priceChange1hPct?: number;
  /** ISO time the trading pair was created. */
  pairCreatedAt?: string;
}

export interface CoinRef {
  mint: string;
  name?: string;
  symbol?: string;
}

export interface MarketData {
  /** Best-liquidity Solana pair for this coin, or null if it isn't trading anywhere DexScreener tracks. */
  token(mint: string): Promise<MarketSnapshot | null>;
  /** Most DexScreener links point at a trading pair, not the coin. Returns the coin that pair trades. */
  pairCoin(pairAddress: string): Promise<CoinRef | null>;
}

// DexScreener sends some numbers as strings and leaves fields out freely.
const maybeNumber = z
  .unknown()
  .transform((v) => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  })
  .optional();

const TokenRef = z.object({ address: z.string(), name: z.string().optional(), symbol: z.string().optional() });

const Pair = z.object({
  chainId: z.string(),
  dexId: z.string().default("unknown"),
  url: z.string(),
  pairAddress: z.string(),
  baseToken: TokenRef,
  quoteToken: TokenRef.optional(),
  priceUsd: maybeNumber,
  marketCap: maybeNumber,
  fdv: maybeNumber,
  liquidity: z.object({ usd: maybeNumber }).optional(),
  volume: z.object({ m5: maybeNumber, h1: maybeNumber }).optional(),
  priceChange: z.object({ m5: maybeNumber, h1: maybeNumber }).optional(),
  pairCreatedAt: maybeNumber,
});
type Pair = z.infer<typeof Pair>;

function toSnapshot(p: Pair): MarketSnapshot {
  return {
    pairUrl: p.url,
    dexId: p.dexId,
    name: p.baseToken.name,
    symbol: p.baseToken.symbol,
    priceUsd: p.priceUsd,
    marketCapUsd: p.marketCap ?? p.fdv,
    liquidityUsd: p.liquidity?.usd,
    volume5mUsd: p.volume?.m5,
    volume1hUsd: p.volume?.h1,
    priceChange5mPct: p.priceChange?.m5,
    priceChange1hPct: p.priceChange?.h1,
    pairCreatedAt: p.pairCreatedAt !== undefined ? new Date(p.pairCreatedAt).toISOString() : undefined,
  };
}

/** DexScreener's free public API (no key). */
export class DexScreener implements MarketData {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async token(mint: string): Promise<MarketSnapshot | null> {
    const pairs = await this.pairs(`/latest/dex/tokens/${mint}`);
    const best = pairs
      .filter((p) => p.chainId === "solana" && p.baseToken.address === mint)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    return best ? toSnapshot(best) : null;
  }

  async pairCoin(pairAddress: string): Promise<CoinRef | null> {
    const pairs = await this.pairs(`/latest/dex/pairs/solana/${pairAddress}`);
    const pair = pairs.find((p) => p.pairAddress === pairAddress) ?? pairs[0];
    if (!pair) return null;
    // Pairs are usually COIN/SOL, but some list SOL first.
    const coin = QUOTE_MINTS.has(pair.baseToken.address) && pair.quoteToken ? pair.quoteToken : pair.baseToken;
    if (QUOTE_MINTS.has(coin.address)) return null;
    return { mint: coin.address, name: coin.name, symbol: coin.symbol };
  }

  private async pairs(path: string): Promise<Pair[]> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`DexScreener ${path} failed: HTTP ${res.status}`);
    const body = (await res.json()) as { pairs?: unknown[] | null; pair?: unknown };
    const raw = [...(body.pairs ?? []), ...(body.pair ? [body.pair] : [])];
    return raw.flatMap((p) => {
      const parsed = Pair.safeParse(p);
      return parsed.success ? [parsed.data] : [];
    });
  }
}
