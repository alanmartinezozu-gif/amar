# Meme coin alert bot

Watches for new Solana meme coins and messages you about them. **It only alerts.** It has no
wallet, holds no keys and never buys or sells anything.

What you get, on Telegram and/or Discord:

- **🆕 New coin posted on X:** a contract address (CA) posted by an account you track, or by
  anyone matching your keywords (those are marked unverified, since impersonators post fake CAs).
- **🔁 Mention:** another tracked account posted the same coin. Several accounts posting one coin
  is a signal worth knowing about.
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
| Solana RPC URL (Helius, QuickNode, …) | Optional, turns on red-flag checks | Free tiers work |
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
  `X_KEYWORDS` like `pump.fun` read a lot of posts. Raising `X_POLL_SECONDS` lowers the cost
  but makes alerts slower.
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
