import { formatPct } from "../format.js";
import { coinLinks, shortAddress } from "../solana.js";
import type { ClosedTrade, Position } from "./book.js";

const label = (t: { symbol?: string; name?: string; mint: string }) => (t.symbol ? `$${t.symbol}` : (t.name ?? shortAddress(t.mint)));

export function formatSol(n: number, signed = false): string {
  const digits = n !== 0 && Math.abs(n) < 0.1 ? 4 : 2;
  return `${signed && n >= 0 ? "+" : ""}${n.toFixed(digits)} SOL`;
}

export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function formatHeld(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function buyMessage(p: Position, balanceSol: number): string {
  const details = [`${formatSol(p.costSol)} → ${formatCount(p.boughtTokens)} tokens`];
  if (p.entryMcapSol !== undefined) details.push(`mcap ${p.entryMcapSol.toFixed(1)} SOL`);
  if (p.entryVsCreationPct !== undefined) details.push(`price already ${formatPct(p.entryVsCreationPct)} since creation`);
  return [
    `📝 PAPER BUY ${label(p)}${p.name && p.symbol ? ` (${p.name})` : ""}`,
    details.join(" · "),
    coinLinks(p.mint).pumpfun,
    `Paper balance: ${formatSol(balanceSol)}`,
  ].join("\n");
}

export function partialSellMessage(p: Position, fraction: number, proceedsSol: number, trailingStopPct: number, balanceSol: number): string {
  const rest = trailingStopPct > 0 ? `the rest rides with a ${trailingStopPct}% trailing stop` : "the rest rides until the time limit";
  return [
    `📝 PAPER SELL ${Math.round(fraction * 100)}% of ${label(p)}: take profit`,
    `got ${formatSol(proceedsSol)} · ${rest}`,
    `Paper balance: ${formatSol(balanceSol)}`,
  ].join("\n");
}

export function sellMessage(t: ClosedTrade, balanceSol: number): string {
  return [
    `${t.pnlSol >= 0 ? "✅" : "❌"} PAPER SELL ${label(t)}: ${t.reason}`,
    `${formatPct(t.pnlPct)} (${formatSol(t.pnlSol, true)} after fees) · held ${formatHeld(t.closedAt - t.openedAt)}`,
    `Paper balance: ${formatSol(balanceSol)}`,
  ].join("\n");
}

export function stopMessage(reason: string, realizedSol: number): string {
  return reason === "goal"
    ? `🏁 Paper bot hit today's goal (${formatSol(realizedSol, true)}) and stops opening trades until tomorrow (UTC), the way Kimchi said he'd quit at his target.`
    : `🛑 Paper bot hit today's loss limit (${formatSol(realizedSol, true)}) and stops opening trades until tomorrow (UTC).`;
}

export interface TradeStats {
  count: number;
  wins: number;
  pnlSol: number;
  best?: ClosedTrade;
  worst?: ClosedTrade;
}

export function tradeStats(trades: ClosedTrade[]): TradeStats {
  const stats: TradeStats = { count: trades.length, wins: 0, pnlSol: 0 };
  for (const t of trades) {
    if (t.pnlSol > 0) stats.wins++;
    stats.pnlSol += t.pnlSol;
    if (!stats.best || t.pnlPct > stats.best.pnlPct) stats.best = t;
    if (!stats.worst || t.pnlPct < stats.worst.pnlPct) stats.worst = t;
  }
  return stats;
}

function statsLine(name: string, s: TradeStats): string {
  if (s.count === 0) return `${name}: no closed trades`;
  const winRate = Math.round((s.wins / s.count) * 100);
  return `${name}: ${s.count} trades · ${s.wins} won (${winRate}%) · ${formatSol(s.pnlSol, true)}`;
}

export function summaryMessage(s: {
  today: TradeStats;
  allTime: TradeStats;
  balanceSol: number;
  startSol: number;
  open: number;
  skips: Record<string, number>;
}): string {
  const lines = [
    "📊 PAPER RESULTS (pretend money)",
    statsLine("Today", s.today),
    statsLine("All time", s.allTime),
    `Balance: ${formatSol(s.balanceSol)} (started with ${formatSol(s.startSol)}) · ${s.open} open`,
  ];
  const { best, worst } = s.allTime;
  if (best && worst && best !== worst) lines.push(`Best: ${label(best)} ${formatPct(best.pnlPct)} · Worst: ${label(worst)} ${formatPct(worst.pnlPct)}`);
  const skipped = Object.entries(s.skips).sort((a, b) => b[1] - a[1]);
  if (skipped.length) lines.push(`Skipped since last summary: ${skipped.map(([reason, n]) => `${n} ${reason}`).join(", ")}`);
  return lines.join("\n");
}
