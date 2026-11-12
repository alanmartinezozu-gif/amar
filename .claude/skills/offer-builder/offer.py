#!/usr/bin/env python3
"""Writes the offer they can say yes to. Standard library only.

One page: the problem in their numbers, what they get, the price, the date, the way out. The lint
refuses an offer that leaves out what the buyer needs to know, or that leans on fake urgency and
promises nobody can keep.

  draft   writes whale/offers/<deal>.md from the board
  lint    checks an offer file
  record  logs an offer only after it really went out, with the user's yes word for word

    python3 offer.py draft --deal north-pier --get "Every late invoice chased automatically" --get "Built to your requirements"
    python3 offer.py lint --offer whale/offers/north-pier.md
    python3 offer.py record --deal north-pier --text-file whale/offers/north-pier.md --approval "yes" --at 2026-11-02T10:15
"""

import argparse
import importlib.util
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join("whale", "offers")
BANNED = [r"\bguarantee[sd]?\b", r"\brisk[- ]free\b", r"\bact now\b", r"\blimited time\b", r"\bonly \d+ (left|spots?|seats?)\b",
          r"\blast chance\b", r"\bexpires? (today|tonight|soon)\b", r"#1\b", r"\bbest in (the )?(class|market|world|industry)\b", r"\bindustry[- ]leading\b",
          r"\bthousands of (customers|companies|users)\b", r"\btrusted by\b"]
BANNED_RE = re.compile("|".join(BANNED), re.I)


def _board():
    path = os.path.join(HERE, "..", "market-researcher", "board.py")
    if not os.path.exists(path):
        sys.exit("The offer-builder skill needs the market-researcher skill next to it (../market-researcher/board.py).")
    spec = importlib.util.spec_from_file_location("whale_board", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


B = _board()


def draft(data, deal_id, gets=None):
    deal = B.need(data["deals"], deal_id, "deal")
    company = B.need(data["companies"], deal["company_id"], "company")
    o, me = data.get("offer") or {}, data.get("me", {})
    if not o:
        raise B.BoardError("No terms yet. Run /pre-sale terms first.")
    if not deal.get("amount"):
        raise B.BoardError("%s has no price yet. Run /pricing first." % deal_id)
    asks = [r for r in data["requirements"] if r["deal_id"] == deal_id]
    today_line = "[fill: what they do about this today, in their words]"
    if company.get("spend_month"):
        today_line = "Today you pay about %s a month for %s (%s a year)." % (
            B.short_money(company["spend_month"]), (company.get("spend_line") or "this").lower(), B.short_money(company["spend_month"] * 12))
    wants = list(gets or []) + [r["feature"] for r in asks]
    gets = ["- %s" % g for g in wants] or ["- [fill: what they get, from what they told you]"]
    lines = ["# %s for %s" % (me.get("product") or "[fill: product]", company["name"]), "",
             today_line, "", "%s." % (me.get("does") or "[fill: what it does]"), "",
             "## What you get", ""] + gets + ["",
             "## The price", "", "%s: %s, paid up front." % (o["item"], B.money(deal["amount"])), "",
             "## When", "", "Ships within %d days of payment, built to your requirements." % o["ships_in_days"], "",
             "## What you should know", "", o["not_built_line"], "", o["refund_line"], "",
             "## Next step", "", "Say yes and I will send you a secure Stripe link. Once you have paid, we go through your requirements together, and that is what we build.", "",
             me.get("name") or "[fill: your name]", me.get("company") or "", me.get("email") or ""]
    return "\n".join(lines).rstrip() + "\n"


def lint(text):
    """Returns a list of problems. Empty means it can be shown to the user."""
    out = []
    low = " ".join(text.lower().split())
    if not re.search(r"\$[\d,]+", text):
        out.append("no price")
    if not re.search(r"ships? (within|by|in|on)\b", low):
        out.append("no ship date")
    if "not finished" not in low and "not built" not in low:
        out.append("does not say plainly that it is not finished yet")
    if "back" not in low and "refund" not in low:
        out.append("does not say how they get their money back")
    for m in BANNED_RE.finditer(text):
        out.append("cut %r: if it isn't provable, it doesn't go in" % m.group(0))
    for m in re.findall(r"\[fill: ([^\]]+)\]", text):
        out.append("fill this in: %s" % m)
    return out


def record(data, deal_id, text, approval, when, subject=None):
    ok, why = B.parse_yes(approval)
    if not ok:
        raise B.BoardError("Not logged: %s" % why)
    problems = lint(text)
    if problems:
        raise B.BoardError("Not logged, the offer does not pass:\n  " + "\n  ".join(problems))
    deal = B.need(data["deals"], deal_id, "deal")
    person = B.need(data["people"], deal.get("person_id"), "person")
    B.company_email_guard(data, person)
    B.add_activity(data, date=when, deal_id=deal_id, person_id=person["id"], channel="email", type="offer", direction="out",
                   subject=subject or "Your offer", text=text, approval=approval)
    deal.update(stage="offer-sent", next_step="/pre-sale when they say yes, /objection-handler if they push back")
    return deal


def main(argv=None):
    ap = argparse.ArgumentParser(description="The offer.")
    ap.add_argument("--file", default=B.DEFAULT_FILE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("draft")
    p.add_argument("--deal", required=True)
    p.add_argument("--get", action="append", help="one thing they get; repeat it")
    p.add_argument("--out")
    p = sub.add_parser("lint")
    p.add_argument("--offer", required=True)
    p = sub.add_parser("record")
    p.add_argument("--deal", required=True)
    p.add_argument("--text-file", required=True)
    p.add_argument("--subject")
    p.add_argument("--approval", required=True)
    p.add_argument("--at", required=True)
    args = ap.parse_args(B.file_first(argv))
    try:
        if args.cmd == "lint":
            with open(args.offer, encoding="utf-8") as fh:
                problems = lint(fh.read())
            for line in problems:
                print(line)
            print("OK" if not problems else "%d problem(s)" % len(problems))
            return 1 if problems else 0
        data = B.load(args.file)
        if args.cmd == "draft":
            text = draft(data, args.deal, args.get)
            out = args.out or os.path.join(OUT_DIR, args.deal + ".md")
            folder = os.path.dirname(out)
            if folder:
                os.makedirs(folder, exist_ok=True)
            with open(out, "w", encoding="utf-8") as fh:
                fh.write(text)
            print(text, end="")
            print("\nWrote %s" % out)
            return 0
        with open(args.text_file, encoding="utf-8") as fh:
            text = fh.read()
        record(data, args.deal, text, args.approval, args.at, args.subject)
        B.save(data, args.file)
        print("Logged. %s is offer-sent." % args.deal)
        return 0
    except (B.BoardError, OSError, ValueError) as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
