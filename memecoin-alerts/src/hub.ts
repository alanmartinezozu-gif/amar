import type { AlertSink, CoinAlert } from "./events.js";
import { formatAlert } from "./format.js";
import type { LaunchEvent } from "./launches.js";
import type { Logger } from "./logger.js";
import type { CoinRef, MarketData, MarketSnapshot } from "./market.js";
import type { Notifier } from "./notify.js";
import { checkSafety, type RpcClient, type SafetyReport } from "./rpc.js";
import type { StateStore } from "./state.js";
import type { PostHandler, PostMention } from "./x.js";

export interface CoinTracker {
  track(coin: { mint: string; source: CoinAlert["source"]; name?: string; symbol?: string; priceUsd?: number }): void;
}

export interface HubDeps {
  state: StateStore;
  notifier: Notifier;
  sinks: AlertSink[];
  market: MarketData;
  /** Without it, red-flag checks are skipped. */
  rpc?: RpcClient;
  tracker?: CoinTracker;
  log: Logger;
  clock: () => number;
  /** A coin seconds old can lag on the RPC node; wait this long and check once more. */
  launchRetryMs?: number;
}

interface ResolvedCoin extends CoinRef {
  safety?: SafetyReport;
  market: MarketSnapshot | null;
}

const xSource = (author: string) => `x:${author.toLowerCase()}`;

/** Turns raw sightings (X posts, launches) into deduped, enriched alerts and sends them everywhere. */
export class AlertHub implements PostHandler {
  constructor(private readonly deps: HubDeps) {}

  async handlePost({ mint: address, post, tracked }: PostMention): Promise<void> {
    const { state, clock } = this.deps;
    const author = post.authorUsername ?? post.authorId;
    const source = xSource(author);
    if (state.hasSource(address, source)) return;

    const coin = await this.resolve(address);
    if (!coin) {
      this.deps.log.debug("Ignoring an address that isn't a coin", { address, author });
      return;
    }
    // No awaits between the check and the write, so two posts of one coin can't both be "new".
    if (state.hasSource(coin.mint, source)) return;
    const isNew = !state.isAlerted(coin.mint);
    const firstOnX = !state.sources(coin.mint).some((s) => s.startsWith("x:"));
    state.addSource(coin.mint, source, clock(), coin);
    // After the first X post, more mentions only matter from accounts you trust. The first one always
    // does: it's how you hear that a launch you were alerted on is being talked about.
    if (!isNew && !tracked && !firstOnX) return;

    // A launch is usually posted before DexScreener lists it, so fall back to the name seen at launch.
    const known = state.names(coin.mint);
    const name = coin.name ?? known.name;
    const symbol = coin.symbol ?? known.symbol;
    const alert: CoinAlert = {
      type: isNew ? "new_coin" : "mention",
      id: `x:${post.id}:${coin.mint}`,
      mint: coin.mint,
      source: "x",
      at: new Date(clock()).toISOString(),
      name,
      symbol,
      post: {
        author,
        tracked,
        url: post.authorUsername ? `https://x.com/${post.authorUsername}/status/${post.id}` : `https://x.com/i/status/${post.id}`,
        text: post.text,
        postedAt: post.createdAt,
      },
      mentions: state.sources(coin.mint).filter((s) => s.startsWith("x:")).length,
      safety: coin.safety,
      market: coin.market,
    };
    await this.publish(alert);
    if (isNew) {
      this.deps.tracker?.track({ mint: coin.mint, source: "x", name, symbol, priceUsd: coin.market?.priceUsd });
    }
  }

  async handleLaunch(ev: LaunchEvent, matched: string[]): Promise<void> {
    const { state, clock, rpc } = this.deps;
    if (state.isAlerted(ev.mint)) return;
    state.addSource(ev.mint, "launch", clock(), ev);

    let safety: SafetyReport | undefined;
    if (rpc) {
      safety = await checkSafety(rpc, ev.mint);
      if (!safety.isToken) {
        await new Promise((resolve) => setTimeout(resolve, this.deps.launchRetryMs ?? 2000));
        safety = await checkSafety(rpc, ev.mint);
      }
    }
    await this.publish({
      type: "new_coin",
      id: `launch:${ev.mint}`,
      mint: ev.mint,
      source: "launch",
      at: new Date(clock()).toISOString(),
      name: ev.name,
      symbol: ev.symbol,
      launch: {
        creator: ev.creator,
        devBuySol: ev.devBuySol,
        marketCapSol: ev.marketCapSol,
        bondingCurve: ev.bondingCurve,
        vSolInCurve: ev.vSolInCurve,
        vTokensInCurve: ev.vTokensInCurve,
        matched,
      },
      safety,
    });
    this.deps.tracker?.track({ mint: ev.mint, source: "launch", name: ev.name, symbol: ev.symbol });
  }

  async publish(alert: CoinAlert): Promise<void> {
    const text = formatAlert(alert, this.deps.clock());
    const results = await Promise.allSettled([this.deps.notifier.send(text), ...this.deps.sinks.map((s) => s.publish(alert))]);
    for (const r of results) {
      if (r.status === "rejected") this.deps.log.warn("Alert delivery failed", { err: r.reason, mint: alert.mint });
    }
  }

  /**
   * Works out which coin an address in a post refers to. Posts link to coins, but DexScreener links
   * point at trading pairs, so a pair is swapped for the coin it trades. Returns null for addresses
   * that are definitely not coins (wallets, programs). An unindexed brand-new coin still comes back,
   * flagged by its missing market data.
   */
  private async resolve(address: string): Promise<ResolvedCoin | null> {
    const { rpc } = this.deps;
    let mint = address;
    let ref: CoinRef = { mint };
    let safety = rpc ? await checkSafety(rpc, address) : undefined;
    const definitelyNotCoin = safety !== undefined && !safety.isToken && !safety.error;
    let market = definitelyNotCoin ? null : await this.marketFor(address);

    if (definitelyNotCoin || (!safety?.isToken && !market)) {
      const pairCoin = await this.pairCoin(address);
      if (pairCoin) {
        mint = pairCoin.mint;
        ref = pairCoin;
        safety = rpc ? await checkSafety(rpc, mint) : undefined;
        market = await this.marketFor(mint);
      } else if (definitelyNotCoin) {
        return null;
      }
    }
    return { mint, name: market?.name ?? ref.name, symbol: market?.symbol ?? ref.symbol, safety, market };
  }

  private async marketFor(mint: string): Promise<MarketSnapshot | null> {
    try {
      return await this.deps.market.token(mint);
    } catch (err) {
      this.deps.log.warn("Market lookup failed", { err, mint });
      return null;
    }
  }

  private async pairCoin(address: string): Promise<CoinRef | null> {
    try {
      return await this.deps.market.pairCoin(address);
    } catch (err) {
      this.deps.log.warn("Pair lookup failed", { err, address });
      return null;
    }
  }
}
