import "dotenv/config";
import { join } from "node:path";
import { appendJsonLine } from "../jsonfile.js";
import { createLogger } from "../logger.js";
import { DexScreener } from "../market.js";
import { ConsoleNotifier, DiscordNotifier, MultiNotifier, TelegramNotifier, type Notifier } from "../notify.js";
import { HttpRpcClient } from "../rpc.js";
import { PaperBook } from "./book.js";
import { loadPaperConfig } from "./config.js";
import { RpcCurveSource } from "./curve.js";
import { formatSol } from "./messages.js";
import { createAlertServer } from "./server.js";
import { PaperTrader, type Strategy } from "./trader.js";

const config = loadPaperConfig();
const log = createLogger(config.LOG_LEVEL, { bot: "paper" });
const book = await PaperBook.open(join(config.DATA_DIR, "paper-state.json"), config.PAPER_START_SOL, (err) =>
  log.error("Couldn't save the paper account", { err }),
);

const channels: Notifier[] = [new ConsoleNotifier(log)];
if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) channels.push(new TelegramNotifier(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID));
if (config.DISCORD_WEBHOOK_URL) channels.push(new DiscordNotifier(config.DISCORD_WEBHOOK_URL));
const notifier = new MultiNotifier(channels, log);

const strategy: Strategy = {
  buySol: config.PAPER_BUY_SOL,
  sources: config.PAPER_SOURCES,
  skipRedFlags: config.PAPER_SKIP_RED_FLAGS,
  maxEntryDelaySec: config.PAPER_MAX_ENTRY_DELAY_SECONDS,
  maxEntryMcapSol: config.PAPER_MAX_ENTRY_MCAP_SOL,
  takeProfitPct: config.PAPER_TAKE_PROFIT_PCT,
  takeProfitSellPct: config.PAPER_TAKE_PROFIT_SELL_PCT,
  trailingStopPct: config.PAPER_TRAILING_STOP_PCT,
  stopLossPct: config.PAPER_STOP_LOSS_PCT,
  maxHoldMinutes: config.PAPER_MAX_HOLD_MINUTES,
  maxOpenPositions: config.PAPER_MAX_OPEN_POSITIONS,
  dailyGoalSol: config.PAPER_DAILY_GOAL_SOL,
  maxDailyLossSol: config.PAPER_MAX_DAILY_LOSS_SOL,
  feePct: config.PAPER_FEE_PCT,
  txCostSol: config.PAPER_TX_COST_SOL,
  dexSlippagePct: config.PAPER_DEX_SLIPPAGE_PCT,
};

const ledgerPath = join(config.DATA_DIR, "paper-trades.jsonl");
const trader = new PaperTrader({
  book,
  curves: new RpcCurveSource(new HttpRpcClient(config.SOLANA_RPC_URL)),
  market: new DexScreener(config.DEXSCREENER_API_URL),
  notifier,
  strategy,
  log,
  clock: () => Date.now(),
  ledger: (event) => appendJsonLine(ledgerPath, event),
});

const server = createAlertServer(
  config.ALERT_WEBHOOK_SECRET,
  (alert) => void trader.onAlert(alert).catch((err) => log.error("Paper trade failed", { err, mint: alert.mint })),
  log,
);
const url = `http://${config.PAPER_HOST}:${config.PAPER_PORT}/alerts`;
server.listen(config.PAPER_PORT, config.PAPER_HOST, () => log.info("Waiting for alerts", { url }));

const priceTimer = setInterval(() => void trader.tick(), config.PAPER_PRICE_CHECK_SECONDS * 1000);
const summaryTimer =
  config.PAPER_SUMMARY_MINUTES > 0 ? setInterval(() => void notifier.send(trader.summary()), config.PAPER_SUMMARY_MINUTES * 60_000) : undefined;

const tp =
  strategy.takeProfitSellPct >= 100
    ? `take profit at +${strategy.takeProfitPct}%`
    : `sell ${strategy.takeProfitSellPct}% at +${strategy.takeProfitPct}%, trail the rest by ${strategy.trailingStopPct}%`;
const rules = [
  `buy ${formatSol(strategy.buySol)} of ${strategy.sources.join(" + ")} alerts within ${strategy.maxEntryDelaySec}s`,
  `skip coins already over ${strategy.maxEntryMcapSol} SOL mcap${strategy.skipRedFlags ? " or with red flags" : ""}`,
  tp,
  `stop loss -${strategy.stopLossPct}%`,
  `out after ${strategy.maxHoldMinutes} min`,
];
if (strategy.dailyGoalSol > 0) rules.push(`stop for the day at ${formatSol(strategy.dailyGoalSol, true)}`);
if (strategy.maxDailyLossSol > 0) rules.push(`or at ${formatSol(-strategy.maxDailyLossSol, true)}`);
void notifier.send(
  [
    "📝 Paper sniper is running: pretend money only, it has no wallet and can't trade.",
    `Rules: ${rules.join(" · ")}`,
    `Paper balance: ${formatSol(book.data.balanceSol)} · ${book.data.open.length} open`,
    `Point the alert bot at it: ALERT_WEBHOOK_URL=${url}`,
  ].join("\n"),
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("Shutting down", { signal });
  server.close();
  clearInterval(priceTimer);
  clearInterval(summaryTimer);
  await book.flush();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
