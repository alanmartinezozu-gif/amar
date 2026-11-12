#!/usr/bin/env python3
"""Answers every objection, and knows a no when it hears one. Standard library only.

Matches what they said against objections.json and fills the answer from your own terms. A
question or a worry gets an answer. A real no gets nothing: it stops the deal, and /follow-up
makes that stick. Every answer is a draft for you to send, and the answers are only ever true.

  match  what to say to what they said
  list   every objection it knows

    python3 objections.py match --text "It looks great, but it's too expensive for us right now."
    python3 objections.py match --deal north-pier --text "What if you never ship it?"
"""

import argparse
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _board():
    path = os.path.join(HERE, "..", "market-researcher", "board.py")
    if not os.path.exists(path):
        sys.exit("The objection-handler skill needs the market-researcher skill next to it (../market-researcher/board.py).")
    spec = importlib.util.spec_from_file_location("whale_board", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


B = _board()


def load_cards():
    with open(os.path.join(HERE, "objections.json"), encoding="utf-8") as fh:
        return json.load(fh)


def fields(data=None, deal_id=None):
    """The values answers are filled from. Anything unknown stays a [fill: ...] to ask about."""
    out = {"value_line": "[fill: one true line about what it pays back]", "ships_in": "[fill: days]", "refund_line": "[fill: your refund terms]",
           "not_built_line": "[fill: that it is not finished yet]", "they_pay": "[fill: what they pay today]", "price": "[fill: price]"}
    if not data:
        return out
    me, o = data.get("me") or {}, data.get("offer") or {}
    if me.get("value_line"):
        out["value_line"] = me["value_line"]
    if o.get("ships_in_days"):
        out["ships_in"] = str(o["ships_in_days"])
    if o.get("refund_line"):
        out["refund_line"] = o["refund_line"]
    if o.get("not_built_line"):
        out["not_built_line"] = o["not_built_line"]
    deal = B.find(data["deals"], deal_id) if deal_id else None
    if deal:
        if deal.get("amount"):
            out["price"] = B.money(deal["amount"])
        c = B.find(data["companies"], deal["company_id"]) or {}
        if c.get("spend_month"):
            out["they_pay"] = "%s a month" % B.short_money(c["spend_month"])
    return out


def match(text, data=None, deal_id=None):
    """Returns one card. A no always wins over any objection in the same sentence."""
    if B.NO_RE.search(text or ""):
        return {"key": "no", "label": "That is a no", "say": None,
                "why": "Don't answer it. Stop, thank them if they wrote kindly, and run: followup.py stop. They hear nothing else from you."}
    cards = load_cards()
    best, hits = None, 0
    for key, card in cards.items():
        n = sum(1 for pat in card["hear"] if re.search(pat, text or "", re.I))
        if n > hits:
            best, hits = key, n
    if best is None:
        return {"key": "none", "label": "No match", "say": None,
                "why": "Not a known objection. Ask one honest question back. Don't guess at an answer, and don't send anything you can't stand behind."}
    card = cards[best]
    say = card["say"].format(**fields(data, deal_id))
    return {"key": best, "label": card["label"], "say": say, "why": card["why"], "missing": re.findall(r"\[fill: ([^\]]+)\]", say)}


def main(argv=None):
    ap = argparse.ArgumentParser(description="What to say to what they said.")
    ap.add_argument("--file", default=B.DEFAULT_FILE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("match")
    p.add_argument("--text", required=True)
    p.add_argument("--deal")
    sub.add_parser("list")
    args = ap.parse_args(B.file_first(argv))
    try:
        if args.cmd == "list":
            for key, card in load_cards().items():
                print("%-12s %s" % (key, card["label"]))
            return 0
        data = B.load(args.file) if os.path.exists(args.file) else None
        card = match(args.text, data, args.deal)
        print(card["label"])
        if card.get("say"):
            print("\nSay: %s" % card["say"])
        print("\nWhy: %s" % card["why"])
        return 0
    except (B.BoardError, ValueError) as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
