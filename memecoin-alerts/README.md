# Meme coin alert bot + paper sniper

Two bots that work together. Neither has a wallet or keys, and neither can buy or sell anything.

1. **Alert bot** (`npm start`): watches for new Solana meme coins and messages you about them.
2. **Paper sniper** (`npm run paper`): receives the alert bot's alerts and practice-trades them
   with pretend money, using Kimchi's documented style and live on-chain prices. See
   [Paper sniper](#paper-sniper-practice-trading-kimchi-style) below.

What the alert bot sends you, on Telegram and/or Discord:

- **🆕 New coin posted on X:** a contract address (CA) posted by an account you track, or by
  anyone matching your keywords (those are marked unverified, since impersonators post fake CAs).
- **🔁 Mention:** a coin you were already alerted on was posted on X. You hear about the first X
  post from anyone, so you know a pump.fun launch is being talked about, and then about every
  tracked account that posts it. Several accounts posting one coin is a signal worth knowing about.
- **🚀 New launch on pump.fun:** coins being created right now that match your filters: a word in
  the name, a creator wallet you follow, or a creator who bought a lot of their own coin.
- **🧾 Launch summary:** every 15 minutes, how many coins launched and which creators bought the
  most of their own.
- **📈📉 Follow-ups:** price, market cap and liquidity 5, 15 and 60 minutes after each alert, so you
  can see which alerts ran and which died.

Every alert includes red-flag checks (when you give it a Solana RPC URL):

- can the creator still mint more tokens?
- can they freeze your wallet so you can't sell?
- are there sneaky token features (transfer fees, a permanent delegate)?
- how much of the supply do the top 10 wallets hold?

## Example alerts

```
🆕 NEW COIN posted by @kimchi1x (an account you track)
$POST (Posted Coin)
CA: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU

"new one, CA: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
https://x.com/kimchi1x/status/1900000000000000001

Safety: ✅ no red flags · top 10 wallets hold 12.0%
Market: $0.000412 · mcap $412.0K · liquidity $61.0K · 5m volume $15.3K · trading for 7m
https://dexscreener.com/solana/...
https://pump.fun/coin/7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
Not financial advice. Check the CA yourself before buying.
```

```
🚀 NEW LAUNCH on pump.fun: matched "cat"
$SCAT (Space Cat)
CA: 4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R
creator 9WzD…AWWM · dev bought 3.20 SOL · mcap 33.5 SOL

Safety:
⚠️ The creator can freeze wallets (you might not be able to sell)
```

## What you need

| | Needed? | Cost |
|---|---|---|
| A computer that stays on, or a small cloud server | Yes, it only alerts while running | A basic server is a few dollars a month |
| [Node.js 22+](https://nodejs.org) | Yes | Free |
| Telegram bot or Discord webhook | One of them (otherwise alerts only print to the screen) | Free |
| Solana RPC URL (Helius, QuickNode, …) | Optional for alerts (turns on red-flag checks), required for the paper sniper | Free tiers work |
| X API bearer token ([developer.x.com](https://developer.x.com)) | Optional, for X alerts | X charges per post read |

pump.fun launch alerts and market data are free and need no key: they come from PumpPortal and
DexScreener.

## Setup

```bash
cd memecoin-alerts
npm install
cp .env.example .env     # then open .env and fill it in; every setting is explained there
npm start
```

You'll get a "✅ Meme coin alert bot is running" message listing what it's watching. Stop it
with Ctrl+C. It remembers what it already alerted on (in `data/`), so restarting doesn't repeat
alerts.

**Telegram in two minutes:** message [@BotFather](https://t.me/BotFather), send `/newbot`, and
copy the token into `TELEGRAM_BOT_TOKEN`. Send your new bot any message, then open
`https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. The `"chat":{"id":...}` number
is your `TELEGRAM_CHAT_ID`.

## Tuning

- **Launch alerts are off until you set a filter.** Hundreds of coins launch every hour, so
  set `LAUNCH_KEYWORDS` (for example `cat,trump,ai`), `LAUNCH_CREATORS` and/or
  `LAUNCH_BIG_DEV_BUY_SOL`. Without filters you get only the summaries.
- **X costs money per post read.** `X_ACCOUNTS` with a handful of accounts is cheap. Broad
  `X_KEYWORDS` read a lot of posts, so each check reads at most 100 of them and they stop for
  the UTC day at `X_KEYWORD_POSTS_PER_DAY` (default 1,000). Your tracked accounts keep being
  watched after that. Raising `X_POLL_SECONDS` lowers the cost but makes alerts slower. Also set
  a spending limit in the X developer console.

## Watching X and pump.fun together

One bot (`npm start`) watches both:

- **pump.fun:** every coin as it's created, alerting on the ones that match your `LAUNCH_*`
  filters.
- **X:** every `X_POLL_SECONDS`, posts that contain a contract address, from:
  - **`X_ACCOUNTS`:** accounts you trust to announce new coins (callers, traders you follow).
    These are the most valuable and are never capped.
  - **`X_KEYWORDS`:** searches for coins announced by anyone. `url:"pump.fun"` catches every post
    linking to a pump.fun coin. It's very busy, so it's capped by `X_KEYWORD_POSTS_PER_DAY`, and
    those posts are marked unverified.

When a launch you were alerted on gets posted on X, you get a 🔁 alert. Coins announced on X
that you hadn't seen yet arrive as 🆕 alerts. The paper sniper can trade them too, from tracked
accounts only: set `PAPER_SOURCES=launch,x`.

To turn on X: sign up at [developer.x.com](https://developer.x.com), create an app, and copy its
**Bearer Token** into `X_BEARER_TOKEN`. X bills per post read, so add credit and set a spending
limit there.
- **Too many follow-ups?** Set `FOLLOWUP_MINUTES=15` for one update, or leave it empty for none.

## Building your trading bot on top of it

Every alert is also data your bot can use:

1. **Live:** set `ALERT_WEBHOOK_URL` and `ALERT_WEBHOOK_SECRET`. Each alert is POSTed as JSON
   with two headers, `x-alert-timestamp` and `x-alert-signature`: a hex HMAC-SHA256 of
   `"<timestamp>.<body>"`. Checking the signature proves the alert came from your alert bot and
   not from someone who found your bot's URL.
2. **History:** every alert is appended to `data/alerts.jsonl`, one JSON object per line. Once
   it has run for a while, you can test trading rules against real alerts and their follow-ups
   before risking money.

`examples/receiver.ts` is a working starting point. It receives the webhook, checks the
signature, drops duplicate deliveries, and prints each alert:

```bash
ALERT_WEBHOOK_SECRET=same-secret-as-the-alert-bot npm run example:receiver
# and in the alert bot's .env: ALERT_WEBHOOK_URL=http://localhost:8787/alerts
```

The alert format is the `CoinAlert` type in `src/events.ts`. The fields that matter most:

| Field | Meaning |
|---|---|
| `type` | `new_coin`, `mention` (another tracked account posted it) or `update` (follow-up) |
| `id` | Unique per alert. Deliveries can repeat, so ignore ids you've seen |
| `mint` | The coin's contract address |
| `source` | `x` or `launch` |
| `post.tracked` | `false` means the poster isn't in `X_ACCOUNTS`: possibly an impersonator |
| `safety.flags` | Red flags as codes: `mint_authority`, `freeze_authority`, `concentrated`, `transfer_fee`, `permanent_delegate`, `transfer_hook`, `pausable`, `non_transferable`, `default_frozen` |
| `safety.isToken` / `safety.error` | Whether the checks ran at all. No `safety` means checks are off |
| `market` | DexScreener price, market cap, liquidity, volume. `null` = not trading yet |
| `update.priceChangeSinceAlertPct` | For follow-ups: the move since the first price seen |
| `launch.bondingCurve`, `launch.vSolInCurve`, `launch.vTokensInCurve` | The coin's pump.fun price account and its starting reserves (price = vSol ÷ vTokens) |

The paper sniper (`src/paper/`) is a full worked example of a bot built on this feed.

## Paper sniper: practice trading, Kimchi style

The paper sniper answers one question before you risk money: **would sniping new launches the
way Kimchi did actually make money right now?** The alert bot sends it each new coin. It decides
like a sniper would, "fills" the trade at the coin's real price at that moment, manages the exit,
and reports every trade and a running score to your Telegram:

```
📝 PAPER BUY $SCAT (Space Cat)
0.50 SOL → 13.7M tokens · mcap 35.5 SOL · price already +11.4% since creation
Paper balance: 4.50 SOL

✅ PAPER SELL $SCAT: take profit
+59.7% (+0.30 SOL after fees) · held 4s
Paper balance: 5.30 SOL

📊 PAPER RESULTS (pretend money)
Today: 14 trades · 5 won (36%) · -0.42 SOL
Balance: 4.58 SOL (started with 5.00 SOL) · 2 open
Skipped since last summary: 9 red flags, 3 too late, 2 already pumped
```

### The rules (all adjustable in `.env`)

| Kimchi's pattern | Setting | Default |
|---|---|---|
| Bought within 0–2 minutes of a coin's creation | `PAPER_MAX_ENTRY_DELAY_SECONDS` | 120 |
| Small bets on brand-new coins (his were 3–5 SOL) | `PAPER_BUY_SOL`, `PAPER_START_SOL` | 0.5, 5 |
| Skip coins that already ran | `PAPER_MAX_ENTRY_MCAP_SOL` | 60 SOL (launch is ~32) |
| His stated rule: take ~50% and get out the same day | `PAPER_TAKE_PROFIT_PCT`, `PAPER_MAX_HOLD_MINUTES` | 50, 30 |
| His best trades rode much further (20–130x) | `PAPER_TAKE_PROFIT_SELL_PCT` below 100 sells only part at take profit and trails the rest by `PAPER_TRAILING_STOP_PCT` | 100 (sell all), 30 |
| Losses on coins that dumped | `PAPER_STOP_LOSS_PCT` (his isn't known; this is a guess) | 35 |
| Said he'd quit once he hit his target | `PAPER_DAILY_GOAL_SOL`, `PAPER_MAX_DAILY_LOSS_SOL` | off |
| Which alerts to trade | `PAPER_SOURCES`: `launch` and/or `x` (tracked accounts only) | `launch` |

**The coins it considers are the ones the alert bot sends**, so `LAUNCH_KEYWORDS`,
`LAUNCH_CREATORS` and `LAUNCH_BIG_DEV_BUY_SOL` decide what gets sniped. With
`PAPER_SKIP_RED_FLAGS=true` it also skips anything the safety checks flagged.

Not included, on purpose: Kimchi's bundled launches, where many wallets secretly buy the same
coin so it looks like real demand. That defrauds the people who buy after.

### How realistic the paper fills are

- **Price:** at the moment an alert arrives, the bot reads the coin's pump.fun price account
  straight from the Solana chain. Every delay a real bot would have (alert, red-flag check,
  network) is baked into the entry price; the buy message tells you how far the price had
  already moved since creation.
- **Size and fees:** fills use pump.fun's actual pricing formula, so bigger bets get worse
  prices, as they would for real. Each buy and sell pays a 1.25% trading fee (`PAPER_FEE_PCT`)
  plus 0.003 SOL for the transaction (`PAPER_TX_COST_SOL`, what fast bots pay to land quickly).
- **After a coin graduates** from pump.fun to a regular pool, it switches to DexScreener's price
  minus the fee and 3% slippage (`PAPER_DEX_SLIPPAGE_PCT`).

What paper trading can't capture, all of which makes real results **worse** than paper:

- **Failed and late transactions.** Real transactions fail or land late in busy moments,
  especially sells during a crash.
- **Competition.** Faster bots buy in the same second the coin is created, ahead of you.
- **No real price impact.** Your pretend buys don't move the real price, so nobody reacts to them.

Treat good paper results as "maybe", and bad ones as "definitely not".

### Running it

1. In `.env`, set `ALERT_WEBHOOK_URL=http://127.0.0.1:8787/alerts`, an `ALERT_WEBHOOK_SECRET`
   (any long random string) and `SOLANA_RPC_URL` (needed for prices). Set some `LAUNCH_KEYWORDS`.
2. Start both, in two terminals, sniper first:
   ```bash
   npm run paper
   npm start
   ```
3. Let it run for days, not minutes. One lucky trade proves nothing; the summary's win rate and
   total over hundreds of trades is the real answer.

Files: `data/paper-state.json` is the pretend account (delete it to start over with
`PAPER_START_SOL`), and `data/paper-trades.jsonl` logs every simulated buy and sell.

## Limits, plainly

- **Speed.** X is checked once a minute by default. Launch alerts arrive within seconds, but the
  fastest bots buy in the same second a coin is created. Use these alerts to find and research
  coins, not to beat snipers.
- **Red-flag checks catch common traps, not every scam.** A coin can pass every check and still
  be dumped by its creator, and coordinated wallets can look like separate holders.
- **Outside services can change.** PumpPortal and DexScreener are free third-party feeds. If
  their data format changes, the bot logs warnings and keeps running with less detail.
- Nothing here is financial advice.

## Development

```bash
npm test          # unit tests; they use fakes and touch no network
npm run typecheck
```
