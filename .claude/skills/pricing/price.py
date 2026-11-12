#!/usr/bin/env python3
"""Sets the price from what they pay today. Standard library only.

The anchor is the money already leaving their account for this problem, not your costs and not a
competitor's page. It shows the year they pay now, what your price is as a share of it, and what
they keep. The working is printed every time, so the number can be argued with.

  options  three prices from what they pay today
  check    what one price means for them
  set      puts a price on a deal

    python3 price.py options --pay-month 6400
    python3 price.py check --pay-month 6400 --price 24000
    python3 price.py set --deal north-pier --price 24000
"""

import argparse
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SHARES = ((0.25, "Easy yes"), (1 / 3.0, "Founding price"), (0.5, "Full value"))


def _board():
    path = os.path.join(HERE, "..", "market-researcher", "board.py")
    if not os.path.exists(path):
        sys.exit("The pricing skill needs the market-researcher skill next to it (../market-researcher/board.py).")
    spec = importlib.util.spec_from_file_location("whale_board", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


B = _board()


def round_price(value):
    """Nearest $1,000 once it is in the thousands, nearest $100 below that."""
    step = 1000 if value >= 5000 else 100
    return int(round(value / float(step)) * step)


def yearly(pay_month, months=12):
    if not pay_month or pay_month <= 0:
        raise B.BoardError("What do they pay today, per month? Run /market-researcher: no number, no price.")
    return pay_month * months


def options(pay_month, months=12):
    year = yearly(pay_month, months)
    out = []
    for share, label in SHARES:
        price = round_price(year * share)
        out.append({"label": label, "price": price, "share": price / float(year), "keep": year - price})
    return out


def check(pay_month, price, months=12):
    year = yearly(pay_month, months)
    share = price / float(year)
    if share >= 1:
        verdict = "This costs as much as what they pay today. There is no reason to switch to something unfinished."
    elif share > 0.6:
        verdict = "High for something unfinished. They keep little for the risk they are taking."
    elif share < 0.1:
        verdict = "Very low. A price this small can read as a toy, and you may be leaving a lot on the table."
    else:
        verdict = "A fair place to start: a real saving for them, real money for you."
    return {"year": year, "price": price, "share": share, "keep": year - price, "months": months, "verdict": verdict}


def check_text(c):
    return ("They pay today:  %s for %d months\nYour price:      %s (%d%% of that)\nThey keep:       %s\n%s"
            % (B.short_money(c["year"]), c["months"], B.short_money(c["price"]), round(c["share"] * 100), B.short_money(c["keep"]), c["verdict"]))


def set_price(data, deal_id, price):
    if price <= 0:
        raise B.BoardError("A price has to be above zero.")
    deal = B.need(data["deals"], deal_id, "deal")
    if B.live_payments(data, deal_id):
        raise B.BoardError("%s already paid. A paid price does not change." % deal_id)
    deal["amount"] = price
    return deal


def main(argv=None):
    ap = argparse.ArgumentParser(description="Price from what they pay today.")
    ap.add_argument("--file", default=B.DEFAULT_FILE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("options")
    p.add_argument("--pay-month", type=float, required=True)
    p.add_argument("--months", type=int, default=12)
    p = sub.add_parser("check")
    p.add_argument("--pay-month", type=float, required=True)
    p.add_argument("--price", type=float, required=True)
    p.add_argument("--months", type=int, default=12)
    p = sub.add_parser("set")
    p.add_argument("--deal", required=True)
    p.add_argument("--price", type=float, required=True)
    args = ap.parse_args(B.file_first(argv))
    try:
        if args.cmd == "options":
            print("They pay today: %s for %d months" % (B.short_money(yearly(args.pay_month, args.months)), args.months))
            for o in options(args.pay_month, args.months):
                print("  %-15s %s  (%d%%, they keep %s)" % (o["label"], B.short_money(o["price"]), round(o["share"] * 100), B.short_money(o["keep"])))
            return 0
        if args.cmd == "check":
            print(check_text(check(args.pay_month, args.price, args.months)))
            return 0
        data = B.load(args.file)
        set_price(data, args.deal, args.price)
        B.save(data, args.file)
        print("%s is priced at %s." % (args.deal, B.money(args.price)))
        return 0
    except (B.BoardError, ValueError) as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
