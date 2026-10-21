import type { CoinAlert } from "./events.js";
import type { DigestSummary } from "./launches.js";
import type { MarketSnapshot } from "./market.js";
import type { SafetyReport } from "./rpc.js";
import { coinLinks, shortAddress } from "./solana.js";

export function formatUsd(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
}

export function formatPct(n: number): string {
  const digits = Math.abs(n) >= 100 ? 0 : 1;
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

function title(alert: Pick<CoinAlert, "name" | "symbol">): string {
  if (alert.symbol && alert.name) return `$${alert.symbol} (${alert.name})`;
  if (alert.symbol) return `$${alert.symbol}`;
  return alert.name ?? "Unnamed coin";
}

function safetyLines(s: SafetyReport | undefined): string[] {
  if (!s) return ["Safety: not checked (set SOLANA_RPC_URL to turn on checks)"];
  if (!s.isToken) return [`Safety: couldn't confirm this is a coin${s.error ? ` (${s.error})` : ""}`];
  const holders = s.top10HolderPct !== undefined ? ` · top 10 wallets hold ${s.top10HolderPct.toFixed(1)}%` : "";
  const lines = s.warnings.length === 0 ? [`Safety: ✅ no red flags${holders}`] : ["Safety:", ...s.warnings.map((w) => `⚠️ ${w}`)];
  if (s.error) lines.push(`(partial check: ${s.error})`);
  return lines;
}

function marketLine(m: MarketSnapshot | null | undefined, now: number): string | undefined {
  if (m === undefined) return undefined;
  if (m === null) return "Market: not trading on any DEX yet";
  const age = m.pairCreatedAt ? ` · trading for ${formatAge(now - Date.parse(m.pairCreatedAt))}` : "";
  return (
    `Market: ${formatUsd(m.priceUsd)} · mcap ${formatUsd(m.marketCapUsd)} · liquidity ${formatUsd(m.liquidityUsd)}` +
    ` · 5m volume ${formatUsd(m.volume5mUsd)}${age}`
  );
}

function linkLines(mint: string, market: MarketSnapshot | null | undefined): string[] {
  const links = coinLinks(mint);
  return [market?.pairUrl ?? links.dexscreener, links.pumpfun];
}

function quote(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return `"${oneLine.length > 280 ? oneLine.slice(0, 279) + "…" : oneLine}"`;
}

/** The Telegram/Discord message for one alert. Plain text, so nothing needs escaping. */
export function formatAlert(alert: CoinAlert, now: number): string {
  const lines: string[] = [];
  const push = (...l: Array<string | undefined>) => lines.push(...l.filter((x): x is string => x !== undefined));

  if (alert.type === "update") {
    const u = alert.update;
    const change = u?.priceChangeSinceAlertPct;
    const icon = change === undefined ? "🕒" : change >= 0 ? "📈" : "📉";
    push(`${icon} UPDATE ${title(alert)}: ${u?.minutesSinceAlert ?? "?"} min after the alert`);
    if (change !== undefined) push(`Price since alert: ${formatPct(change)}`);
    push(marketLine(alert.market, now), `CA: ${alert.mint}`, alert.market?.pairUrl ?? coinLinks(alert.mint).dexscreener);
    return lines.join("\n");
  }

  if (alert.type === "mention" && alert.post) {
    const who = alert.post.tracked ? "an account you track" : "not an account you track";
    const count = alert.mentions && alert.mentions > 1 ? ` · ${alert.mentions} X accounts have posted it` : "";
    push(
      `🔁 ${title(alert)} posted on X by @${alert.post.author} (${who})${count}`,
      `CA: ${alert.mint}`,
      quote(alert.post.text),
      alert.post.url,
      marketLine(alert.market, now),
    );
    return lines.join("\n");
  }

  if (alert.source === "x" && alert.post) {
    const who = alert.post.tracked
      ? `@${alert.post.author} (an account you track)`
      : `@${alert.post.author}\n⚠️ Not an account you track: impersonators post fake contract addresses`;
    push(`🆕 NEW COIN posted by ${who}`, title(alert), `CA: ${alert.mint}`, "", quote(alert.post.text), alert.post.url, "");
  } else {
    const l = alert.launch;
    push(`🚀 NEW LAUNCH on pump.fun${l?.matched.length ? `: matched ${l.matched.join(", ")}` : ""}`, title(alert), `CA: ${alert.mint}`);
    const details = [
      l?.creator ? `creator ${shortAddress(l.creator)}` : undefined,
      l?.devBuySol !== undefined ? `dev bought ${l.devBuySol.toFixed(2)} SOL` : undefined,
      l?.marketCapSol !== undefined ? `mcap ${l.marketCapSol.toFixed(1)} SOL` : undefined,
    ].filter(Boolean);
    if (details.length) push(details.join(" · "));
    push("");
  }

  push(...safetyLines(alert.safety), marketLine(alert.market, now), ...linkLines(alert.mint, alert.market));
  push("Not financial advice. Check the CA yourself before buying.");
  return lines.join("\n");
}

export function formatDigest(d: DigestSummary): string {
  const lines = [
    `🧾 pump.fun, last ${d.minutes} min: ${d.total.toLocaleString("en-US")} new coins, ${d.matched} matched your filters.`,
  ];
  if (d.biggestDevBuys.length) {
    lines.push("Biggest creator buys (often a sign of a planned dump, not a good coin):");
    d.biggestDevBuys.forEach((ev, i) => {
      lines.push(`${i + 1}. ${title(ev)}: ${ev.devBuySol?.toFixed(2)} SOL · ${coinLinks(ev.mint).pumpfun}`);
    });
  }
  return lines.join("\n");
}
