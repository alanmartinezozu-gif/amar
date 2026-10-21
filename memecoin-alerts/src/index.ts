import "dotenv/config";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { JsonlSink, WebhookSink, type AlertSink } from "./events.js";
import { formatDigest } from "./format.js";
import { AlertHub } from "./hub.js";
import { LaunchDigest, LaunchFeed, hasLaunchFilters, matchLaunch } from "./launches.js";
import { createLogger } from "./logger.js";
import { DexScreener } from "./market.js";
import { ConsoleNotifier, DiscordNotifier, MultiNotifier, TelegramNotifier, type Notifier } from "./notify.js";
import { HttpRpcClient } from "./rpc.js";
import { StateStore } from "./state.js";
import { FollowUpTracker } from "./tracker.js";
import { HttpXApi, XWatcher } from "./x.js";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const clock = () => Date.now();
const state = await StateStore.open(join(config.DATA_DIR, "state.json"), (err) => log.error("Couldn't save state", { err }));

const channels: Notifier[] = [new ConsoleNotifier(log)];
if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) channels.push(new TelegramNotifier(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID));
if (config.DISCORD_WEBHOOK_URL) channels.push(new DiscordNotifier(config.DISCORD_WEBHOOK_URL));
const notifier = new MultiNotifier(channels, log);

const sinks: AlertSink[] = [new JsonlSink(join(config.DATA_DIR, "alerts.jsonl"))];
if (config.ALERT_WEBHOOK_URL && config.ALERT_WEBHOOK_SECRET) sinks.push(new WebhookSink(config.ALERT_WEBHOOK_URL, config.ALERT_WEBHOOK_SECRET));

const market = new DexScreener(config.DEXSCREENER_API_URL);
const rpc = config.SOLANA_RPC_URL ? new HttpRpcClient(config.SOLANA_RPC_URL) : undefined;
const tracker: FollowUpTracker = new FollowUpTracker(
  market,
  (alert): Promise<void> => hub.publish(alert),
  { minutes: config.FOLLOWUP_MINUTES, maxTracked: config.MAX_TRACKED_COINS },
  log.child({ component: "followups" }),
  clock,
);
const hub: AlertHub = new AlertHub({ state, notifier, sinks, market, rpc, tracker, log: log.child({ component: "hub" }), clock });

const status: string[] = [];

let xWatcher: XWatcher | undefined;
if (config.X_BEARER_TOKEN) {
  xWatcher = new XWatcher(
    new HttpXApi(config.X_BEARER_TOKEN, config.X_API_URL),
    hub,
    state,
    {
      accounts: config.X_ACCOUNTS,
      keywords: config.X_KEYWORDS,
      maxQueryLength: config.X_QUERY_MAX_LENGTH,
      maxPostAgeMs: config.X_MAX_POST_AGE_MINUTES * 60_000,
    },
    log.child({ component: "x" }),
    clock,
  );
  xWatcher.start(config.X_POLL_SECONDS * 1000);
  status.push(
    `X: ${config.X_ACCOUNTS.length} accounts` +
      (config.X_KEYWORDS.length ? `, ${config.X_KEYWORDS.length} keywords` : "") +
      `, checked every ${config.X_POLL_SECONDS}s`,
  );
}

let launchFeed: LaunchFeed | undefined;
let digestTimer: NodeJS.Timeout | undefined;
if (config.LAUNCH_ALERTS) {
  const filters = { keywords: config.LAUNCH_KEYWORDS, creators: config.LAUNCH_CREATORS, bigDevBuySol: config.LAUNCH_BIG_DEV_BUY_SOL };
  const digest = new LaunchDigest();
  launchFeed = new LaunchFeed(
    config.PUMPPORTAL_WS_URL,
    (ev) => {
      const matched = matchLaunch(ev, filters);
      digest.record(ev, matched !== null);
      if (matched) hub.handleLaunch(ev, matched).catch((err) => log.error("Launch alert failed", { err, mint: ev.mint }));
    },
    log.child({ component: "launches" }),
  );
  launchFeed.start();
  if (config.LAUNCH_DIGEST_MINUTES > 0) {
    digestTimer = setInterval(() => {
      const summary = digest.flush(config.LAUNCH_DIGEST_MINUTES);
      if (summary) void notifier.send(formatDigest(summary));
    }, config.LAUNCH_DIGEST_MINUTES * 60_000);
  }
  if (hasLaunchFilters(filters)) status.push("pump.fun launches: alerts for coins matching your filters");
  else if (config.LAUNCH_DIGEST_MINUTES > 0) {
    status.push("pump.fun launches: no filters set, so summaries only (set LAUNCH_KEYWORDS, LAUNCH_CREATORS or LAUNCH_BIG_DEV_BUY_SOL)");
  } else {
    log.warn("Launch alerts are on but have no filters and no summary, so they will never send anything");
  }
}

tracker.start();
if (config.FOLLOWUP_MINUTES.length) status.push(`Follow-ups at ${config.FOLLOWUP_MINUTES.join(", ")} min`);
status.push(rpc ? "Red-flag checks: on" : "Red-flag checks: off (set SOLANA_RPC_URL)");
if (channels.length === 1) log.warn("No Telegram or Discord set up: alerts only go to this console");
void notifier.send(["✅ Meme coin alert bot is running (alerts only, it never trades)", ...status].join("\n"));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("Shutting down", { signal });
  xWatcher?.stop();
  launchFeed?.stop();
  clearInterval(digestTimer);
  tracker.stop();
  await state.flush();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
