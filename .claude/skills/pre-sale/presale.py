#!/usr/bin/env python3
"""Gets customers to pay up front, in the open. Standard library only.

Holds the terms of the pre-sale and refuses a checkout that hides anything: the buyer must see
that it is not finished, the date it ships, and how they get their money back. The money itself
goes through a Stripe-hosted page in the user's own account. This tool never sees a card.

  terms      sets what you are pre-selling
  check      checks the terms
  link       prints what to create in Stripe for one deal
  record     logs a payment once Stripe shows it paid (live mode only)
  validated  paying customers against your target, and money in
  due        every promised ship date, and which ones are in trouble
  notice     the delay email for a deal that will miss its date
  new-date   logs the customer agreeing to a new date, in their words
  deliver    marks a deal shipped
  refund     logs a refund

    python3 presale.py terms --item "Founding customer, 12 months" --ships-in 30
    python3 presale.py link --deal north-pier
    python3 presale.py record --deal north-pier --amount 24000 --ref pi_3Qa1b2 --on 2026-11-03 --live
    python3 presale.py validated --marketing-spent 0
    python3 presale.py due --today 2026-11-05
"""

import argparse
import datetime
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NOT_BUILT = "This product is not finished yet. You are paying now for the version we build to your requirements."
REFUND = "If it has not shipped by the promised date, or we can't build what you asked for, you get every dollar back."
# A pre-sale asks for money after a real conversation, never in a cold email.
CAN_ASK = ("replied", "demo-booked", "offer-sent")
SOON_DAYS = 7
MAX_SHIPS_IN = 90


def _board():
    path = os.path.join(HERE, "..", "market-researcher", "board.py")
    if not os.path.exists(path):
        sys.exit("The pre-sale skill needs the market-researcher skill next to it (../market-researcher/board.py).")
    spec = importlib.util.spec_from_file_location("whale_board", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


B = _board()


def set_terms(data, item, ships_in, refund=None, not_built=None):
    data["offer"] = {"item": item, "ships_in_days": ships_in, "refund_line": refund or REFUND, "not_built_line": not_built or NOT_BUILT}
    return data["offer"]


def check_terms(data):
    """Returns a list of problems with the terms. Empty means a checkout may be created."""
    o, out = data.get("offer") or {}, []
    if not o.get("item"):
        out.append("say what they are buying (--item)")
    days = o.get("ships_in_days")
    if not days or days <= 0:
        out.append("promise a ship date (--ships-in days)")
    elif days > MAX_SHIPS_IN:
        out.append("%d days is a long time to hold someone's money. Promise %d or fewer, or take a deposit." % (days, MAX_SHIPS_IN))
    if not o.get("refund_line"):
        out.append("say how they get their money back")
    if not o.get("not_built_line"):
        out.append("say plainly that it is not finished yet")
    me = data.get("me", {})
    for key in ("name", "company", "email", "address"):
        if not me.get(key):
            out.append("your %s is missing: run board.py init" % key)
    return out


def ships_by(paid_on, days):
    return (datetime.date.fromisoformat(paid_on) + datetime.timedelta(days=days)).isoformat()


def link(data, deal_id, today=None):
    problems = check_terms(data)
    if problems:
        raise B.BoardError("Fix the terms first:\n  " + "\n  ".join(problems))
    deal = B.need(data["deals"], deal_id, "deal")
    if deal.get("stage") not in CAN_ASK:
        raise B.BoardError("%s is at %s. Ask for money only after a real conversation (%s)." % (deal_id, deal.get("stage"), ", ".join(CAN_ASK)))
    if not deal.get("amount"):
        raise B.BoardError("%s has no price yet. Run /pricing first." % deal_id)
    company = B.need(data["companies"], deal["company_id"], "company")
    o = data["offer"]
    days = o["ships_in_days"]
    description = "Ships within %d days of payment, built to your requirements." % days
    disclosure = "%s %s" % (o["not_built_line"], o["refund_line"])
    confirmation = "Thank you. Next we go through your requirements together. " + o["refund_line"]
    if len(disclosure) > 1200 or len(confirmation) > 500:
        raise B.BoardError("Stripe allows 1,200 characters above the pay button and 500 after it. Shorten the terms.")
    return {"seller": data["me"].get("product") or data["me"].get("company"), "buyer": company["name"], "item": o["item"],
            "amount": deal["amount"], "amount_display": B.money(deal["amount"]), "payment_link": {
                "line_items": [{"quantity": 1, "price_data": {"currency": "usd", "unit_amount": int(round(deal["amount"] * 100)),
                                                              "product_data": {"name": o["item"], "description": description}}}],
                "custom_text": {"submit": {"message": disclosure}},
                "restrictions": {"completed_sessions": {"limit": 1}},
                "metadata": {"deal": deal_id, "whale_skill": "pre-sale"},
                "after_completion": {"type": "hosted_confirmation", "hosted_confirmation": {"custom_message": confirmation}}}}


def record(data, deal_id, amount, ref, paid_on, live, deposit=False):
    if not live:
        raise B.BoardError("Only a live payment counts. Stripe test payments (card 4242...) never go on the board.")
    if not ref:
        raise B.BoardError("Give the Stripe reference, from a payment you can see marked paid in your own account.")
    terms = check_terms(data)
    if terms:
        raise B.BoardError("Fix the terms first:\n  " + "\n  ".join(terms))
    deal = B.need(data["deals"], deal_id, "deal")
    if deal.get("stage") in ("lost", "refunded"):
        raise B.BoardError("%s is %s. Sort that out with them before logging money." % (deal_id, deal["stage"]))
    if any(p["ref"] == ref for p in data["payments"]):
        raise B.BoardError("%s is already on the board." % ref)
    so_far = sum(p["amount"] for p in B.live_payments(data, deal_id))
    total = deal.get("amount") or amount
    if so_far + amount > total + 0.005:
        raise B.BoardError("%s was offered at %s. This would take it to %s. Check Stripe." % (deal_id, B.money(total), B.money(so_far + amount)))
    if so_far + amount < total - 0.005 and not deposit:
        raise B.BoardError("%s was offered at %s, this payment leaves %s owing. If a part payment was agreed, add --deposit." % (deal_id, B.money(total), B.money(total - so_far - amount)))
    data["payments"].append({"id": B.next_id(data["payments"], "p"), "deal_id": deal_id, "amount": amount, "date": paid_on, "ref": ref, "refunded_on": None})
    deal["amount"] = total
    if deal.get("stage") != "paid":
        deal.update(stage="paid", paid_on=paid_on, ships_by=ships_by(paid_on, data["offer"]["ships_in_days"]),
                    next_step="/requirements: get what they need, in their words")
    return deal


def validated(data, marketing_spent=None):
    if marketing_spent is not None:
        data["marketing_spent"] = marketing_spent
    target = data["me"].get("target_customers") or 3
    customers = B.paying_customers(data)
    return {"customers": len(customers), "target": target, "money_in": B.money_in(data), "marketing_spent": data.get("marketing_spent"),
            "validated": len(customers) >= target}


def validated_text(v):
    spent = "not recorded" if v["marketing_spent"] is None else B.money(v["marketing_spent"])
    head = "VALIDATED" if v["validated"] else "NOT YET"
    tail = ("%d companies paid before it shipped. That proves they want it. Now you owe them the product." % v["customers"]
            if v["validated"] else "%d more paying customer(s) before you call this validated. Don't build yet." % (v["target"] - v["customers"]))
    return "%s  %d of %d paying customers  |  Money in: %s  |  Marketing spent: %s\n%s" % (head, v["customers"], v["target"], B.money(v["money_in"]), spent, tail)


def due(data, today):
    rows = []
    for d in data["deals"]:
        if d.get("stage") != "paid":
            continue
        left = (datetime.date.fromisoformat(d["ships_by"]) - today).days
        status = "LATE" if left < 0 else "SOON" if left <= SOON_DAYS else "OK"
        rows.append({"deal": d["id"], "ships_by": d["ships_by"], "days_left": left, "status": status})
    return sorted(rows, key=lambda r: r["days_left"])


def due_text(data, today):
    rows = due(data, today)
    if not rows:
        return "No paid deals waiting to ship."
    lines = []
    for r in rows:
        c = B.find(data["companies"], B.find(data["deals"], r["deal"])["company_id"])
        action = {"LATE": "  send the delay notice TODAY: new date, or their money back",
                  "SOON": "  if this will slip, tell them BEFORE the date"}.get(r["status"], "")
        lines.append("%-5s %-28s ships by %s (%d days)%s" % (r["status"], c["name"], r["ships_by"], r["days_left"], action))
    return "\n".join(lines)


def notice(data, deal_id, new_date, reason):
    deal = B.need(data["deals"], deal_id, "deal")
    if deal.get("stage") != "paid":
        raise B.BoardError("%s is at %s, nothing is owed." % (deal_id, deal.get("stage")))
    person = B.need(data["people"], deal.get("person_id"), "person")
    me = data["me"]
    body = ("Hi %s,\n\nWe promised this by %s and we are going to miss it. %s\n\nThe new date is %s. "
            "If that works, reply \"yes\". If it doesn't, or if I don't hear from you, I will refund the full %s, no questions asked.\n\nThanks,\n%s"
            % (person["name"].split()[0], deal["ships_by"], reason, new_date, B.money(deal["amount"]), (me.get("name") or "").split(" ")[0]))
    return {"to": person["email"], "subject": "We are going to miss the date", "body": body}


def new_date(data, deal_id, date, said, when):
    """Only the customer can move the date: they said yes to it, in their words."""
    deal = B.need(data["deals"], deal_id, "deal")
    if deal.get("stage") != "paid":
        raise B.BoardError("%s is at %s, nothing is owed." % (deal_id, deal.get("stage")))
    if B.NO_RE.search(said or "") or not (said or "").strip():
        raise B.BoardError("That is not a yes to the new date. Refund them.")
    datetime.date.fromisoformat(date)
    B.add_activity(data, date=when, deal_id=deal_id, person_id=deal.get("person_id"), channel="email", type="delay", direction="in",
                   text="new date %s (was %s): %s" % (date, deal["ships_by"], said))
    deal["ships_by"] = date
    return deal


def deliver(data, deal_id, on):
    deal = B.need(data["deals"], deal_id, "deal")
    if deal.get("stage") != "paid":
        raise B.BoardError("%s is at %s, not paid and waiting to ship." % (deal_id, deal.get("stage")))
    deal.update(stage="delivered", delivered_on=on, next_step="/case-study, once they have seen results")
    return deal


def refund(data, deal_id, ref, on):
    rows = B.live_payments(data, deal_id)
    if not rows:
        raise B.BoardError("%s has no payment to refund." % deal_id)
    if not ref:
        raise B.BoardError("Give the refund reference from Stripe.")
    for p in rows:
        p.update(refunded_on=on, refund_ref=ref)
    deal = B.need(data["deals"], deal_id, "deal")
    deal.update(stage="refunded", next_step=None)
    B.add_activity(data, date=on, deal_id=deal_id, channel="note", type="refund", text="refunded %s (%s)" % (B.money(sum(p["amount"] for p in rows)), ref))
    return deal


def main(argv=None):
    ap = argparse.ArgumentParser(description="Pre-sell it, in the open.")
    ap.add_argument("--file", default=B.DEFAULT_FILE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("terms")
    p.add_argument("--item", required=True)
    p.add_argument("--ships-in", type=int, required=True)
    p.add_argument("--refund")
    p.add_argument("--not-built")
    sub.add_parser("check")
    p = sub.add_parser("link")
    p.add_argument("--deal", required=True)
    p = sub.add_parser("record")
    p.add_argument("--deal", required=True)
    p.add_argument("--amount", type=float, required=True)
    p.add_argument("--ref", required=True)
    p.add_argument("--on", required=True)
    p.add_argument("--live", action="store_true")
    p.add_argument("--deposit", action="store_true")
    p = sub.add_parser("validated")
    p.add_argument("--marketing-spent", type=float)
    p = sub.add_parser("due")
    p.add_argument("--today")
    p = sub.add_parser("notice")
    p.add_argument("--deal", required=True)
    p.add_argument("--new-date", required=True)
    p.add_argument("--reason", required=True)
    p = sub.add_parser("new-date")
    p.add_argument("--deal", required=True)
    p.add_argument("--date", required=True)
    p.add_argument("--said", required=True)
    p.add_argument("--at", required=True)
    p = sub.add_parser("deliver")
    p.add_argument("--deal", required=True)
    p.add_argument("--on", required=True)
    p = sub.add_parser("refund")
    p.add_argument("--deal", required=True)
    p.add_argument("--ref", required=True)
    p.add_argument("--on", required=True)
    args = ap.parse_args(B.file_first(argv))
    try:
        data = B.load(args.file)
        if args.cmd == "terms":
            set_terms(data, args.item, args.ships_in, args.refund, args.not_built)
            B.save(data, args.file)
            print("Saved the terms.")
        elif args.cmd == "check":
            problems = check_terms(data)
            for line in problems:
                print(line)
            print("OK" if not problems else "%d problem(s)" % len(problems))
            return 1 if problems else 0
        elif args.cmd == "link":
            print(json.dumps(link(data, args.deal), indent=2, ensure_ascii=False))
        elif args.cmd == "record":
            d = record(data, args.deal, args.amount, args.ref, args.on, args.live, args.deposit)
            B.save(data, args.file)
            print("Paid: %s. You promised it by %s." % (B.money(d["amount"]), d["ships_by"]))
        elif args.cmd == "validated":
            v = validated(data, args.marketing_spent)
            if args.marketing_spent is not None:
                B.save(data, args.file)
            print(validated_text(v))
        elif args.cmd == "due":
            print(due_text(data, B.today_arg(args.today)))
        elif args.cmd == "notice":
            n = notice(data, args.deal, args.new_date, args.reason)
            print("To: %s\nSubject: %s\n\n%s" % (n["to"], n["subject"], n["body"]))
        elif args.cmd == "new-date":
            new_date(data, args.deal, args.date, args.said, args.at)
            B.save(data, args.file)
            print("The date is now %s." % args.date)
        elif args.cmd == "deliver":
            deliver(data, args.deal, args.on)
            B.save(data, args.file)
            print("Delivered.")
        elif args.cmd == "refund":
            refund(data, args.deal, args.ref, args.on)
            B.save(data, args.file)
            print("Refund logged. %s no longer counts toward validation." % args.deal)
        return 0
    except (B.BoardError, ValueError) as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
