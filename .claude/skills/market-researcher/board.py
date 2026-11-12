#!/usr/bin/env python3
"""The one board every Whale skill reads and writes. Standard library only.

Owns the schema of whale/whale.json: the problems you researched, the companies you are going
after, the people who decide, the deals, who has paid, what they asked for, and who must never
be contacted again.

  init       creates whale/whale.json with your details
  company    adds or updates a company
  person     adds or updates a decision maker
  deal       adds or updates a deal
  move       moves a deal to a new stage (lost asks for a reason)
  board      everything at a glance: every deal by stage, money in, what is due
  show       one deal with its company, people, history and requirements
  validate   checks the file against the schema; every skill runs it after writing

    python3 board.py init --name "You" --company "Your Company" --email hello@yourcompany.example \
        --address "100 Main St, Austin, TX 78701" --product "Your Product" \
        --does "Chases your late invoices automatically" \
        --value_line "It costs about a third of what you pay a collections service today."
    python3 board.py company --id north-pier --name "North Pier Logistics" --website https://northpierlogistics.com
    python3 board.py person --id renee-alvarez --company north-pier --name "Renee Alvarez" --title CFO \
        --decides signs --email renee@northpierlogistics.com --email_source https://northpierlogistics.com/team
    python3 board.py deal --id north-pier --company north-pier --person renee-alvarez --title "Founding customer"
    python3 board.py move --deal north-pier --stage lost --reason "bought a competitor last month"
    python3 board.py board --today 2026-11-05
"""

import argparse
import datetime
import json
import os
import re
import sys

DEFAULT_FILE = os.path.join("whale", "whale.json")
VERSION = 1

STAGES = ("found", "pitched", "replied", "demo-booked", "offer-sent", "paid", "delivered", "lost", "refunded")
OPEN = STAGES[:5]
MONEY_IN = ("paid", "delivered")
DECIDES = ("signs", "budget", "pain", None)
CHANNELS = ("email", "call", "meeting", "note")
TYPES = ("pitch", "followup", "reply", "call", "meeting", "note", "offer", "stage", "delay", "refund")
DIRECTIONS = ("out", "in", None)

ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)

# A "no" or any sign of disinterest. One match stops every message to that person.
NO_PATTERNS = [r"\bnot interested\b", r"\bno,? thanks?\b", r"\bno thank you\b", r"\bunsubscribe\b",
               r"\bremove me\b", r"\btake me off\b", r"\bstop (emailing|messaging|contacting|reaching out)\b",
               r"\bdo ?n[o']?t (contact|email|message|call|reach out)\b", r"\bplease stop\b",
               r"\bleave me alone\b", r"\bnot a (good )?fit\b", r"\bwe('re| are) all set\b",
               r"\bwent with (someone|another|a different)\b", r"\bno longer (interested|needed)\b",
               r"\bpass on this\b", r"\bnot for us\b", r"\bwrong person\b", r"\bspam\b"]
NO_RE = re.compile("|".join(NO_PATTERNS), re.I)
UNSUB_RE = re.compile(r"\bunsubscribe\b|\bremove me\b|\btake me off\b|\bstop (emailing|messaging|contacting)\b"
                      r"|\bdo ?n[o']?t (contact|email|message|call)\b|\bplease stop\b|\bleave me alone\b|\bspam\b", re.I)

BATCH_WORDS = {"all", "every", "everyone", "everybody", "everything", "rest", "remaining", "them", "both",
               "bulk", "batch", "each", "others", "these", "those"}
DOUBT_WORDS = {"no", "not", "dont", "don't", "wait", "cancel", "stop", "but", "maybe", "later", "hold",
               "unless", "if", "tomorrow", "after", "before", "change", "edit"}


class BoardError(Exception):
    pass


def parse_yes(reply):
    """An explicit yes for ONE message: 'yes' or 'yes, send it'. Never 'ok', 'sure' or 'yes to all'.
    Returns (ok, why)."""
    text = (reply or "").strip().lower()
    if not text:
        return False, "no reply"
    if text.endswith("?"):
        return False, "that is a question, not a yes"
    words = re.findall(r"[a-z']+", text)
    if not words or words[0] not in ("yes", "y"):
        return False, "only an explicit 'yes' sends anything (got %r)" % reply
    if BATCH_WORDS & set(words):
        return False, "one yes per message: say yes to each one on its own"
    if DOUBT_WORDS & set(words[1:]):
        return False, "that yes has a condition in it; ask again"
    return True, "yes"


def file_first(argv):
    """Lets --file go anywhere on the command line."""
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--file" in argv:
        i = argv.index("--file")
        argv[:0] = argv[i:i + 2]
        del argv[i + 2:i + 4]
    return argv


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def today_arg(value):
    return datetime.date.fromisoformat(value) if value else datetime.date.today()


def money(value):
    return "${:,.2f}".format(value or 0)


def short_money(value):
    return "${:,.0f}".format(value or 0)


def empty(me=None):
    return {"version": VERSION, "me": me or {}, "problems": [], "companies": [], "people": [], "deals": [],
            "activities": [], "offer": {}, "payments": [], "requirements": [], "case_studies": [],
            "marketing_spent": None, "suppression": []}


def load(path=DEFAULT_FILE):
    if not os.path.exists(path):
        raise BoardError("No %s yet. Run: board.py init" % path)
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save(data, path=DEFAULT_FILE):
    errors, _ = validate(data)
    if errors:
        raise BoardError("Not saved, the board would be invalid:\n  " + "\n  ".join(errors))
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


def find(items, item_id):
    for it in items:
        if it.get("id") == item_id:
            return it
    return None


def need(items, item_id, what):
    it = find(items, item_id)
    if it is None:
        raise BoardError("No %s %s" % (what, item_id))
    return it


def suppressed(data, email):
    email = (email or "").strip().lower()
    return bool(email) and email in [s.lower() for s in data.get("suppression", [])]


def live_payments(data, deal_id=None):
    """Payments that still count: refunded money is not validation."""
    return [p for p in data["payments"] if not p.get("refunded_on") and (deal_id is None or p["deal_id"] == deal_id)]


def money_in(data):
    return sum(p["amount"] for p in live_payments(data))


def paying_customers(data):
    return sorted({p["deal_id"] for p in live_payments(data)})


def history(data, deal_id):
    rows = [a for a in data["activities"] if a.get("deal_id") == deal_id]
    return sorted(rows, key=lambda a: a["date"])


def footer(me):
    """The legal lines on every outgoing cold email (CAN-SPAM): who, where, and how to stop."""
    who = " | ".join(x for x in (me.get("company"), me.get("address")) if x) or "[fill: company and postal address]"
    return "\n\n--\n%s\nNot useful? Reply \"stop\" and I won't write again." % who


def company_email_guard(data, person):
    """Raises unless this person can be emailed at all. Every sending skill calls it."""
    if person.get("do_not_contact") or suppressed(data, person.get("email")):
        raise BoardError("%s is do not contact. No email." % person["name"])
    if not person.get("email"):
        raise BoardError("%s has no email address. Find one they publish for work, or call." % person["name"])


def validate(data):
    """Returns (errors, warnings). Errors block a save."""
    errors, warnings = [], []
    for key in ("me", "problems", "companies", "people", "deals", "activities", "offer", "payments",
                "requirements", "case_studies", "suppression"):
        if key not in data:
            errors.append("missing top-level key: %s" % key)
    if errors:
        return errors, warnings

    def ids(items, what):
        seen = set()
        for it in items:
            i = it.get("id", "")
            if not ID_RE.match(i):
                errors.append("%s id %r must be lowercase-with-hyphens" % (what, i))
            if i in seen:
                errors.append("duplicate %s id %s" % (what, i))
            seen.add(i)
        return seen

    problem_ids = ids(data["problems"], "problem")
    company_ids = ids(data["companies"], "company")
    person_ids = ids(data["people"], "person")
    deal_ids = ids(data["deals"], "deal")

    for p in data["problems"]:
        if not p.get("source") and not (p.get("estimate") and p.get("basis")):
            errors.append("problem %s says what they pay with no source and no marked estimate" % p.get("id"))
    for c in data["companies"]:
        if c.get("problem_id") and c["problem_id"] not in problem_ids:
            errors.append("company %s points at unknown problem %r" % (c["id"], c["problem_id"]))
        if c.get("spend_month") and not c.get("spend_source"):
            errors.append("company %s has a spend figure with no source" % c["id"])
    for p in data["people"]:
        if p.get("company_id") not in company_ids:
            errors.append("person %s points at unknown company %r" % (p.get("id"), p.get("company_id")))
        if p.get("decides") not in DECIDES:
            errors.append("person %s decides must be signs, budget or pain" % p.get("id"))
        if p.get("email"):
            if not EMAIL_RE.match(p["email"]):
                errors.append("person %s email %r does not look like an email" % (p["id"], p["email"]))
            if not p.get("email_source"):
                errors.append("person %s has an email with no source: never guess an address" % p["id"])
    paid = {p["deal_id"] for p in data["payments"]}
    for d in data["deals"]:
        did = d.get("id")
        if d.get("company_id") not in company_ids:
            errors.append("deal %s points at unknown company %r" % (did, d.get("company_id")))
        if d.get("person_id") and d["person_id"] not in person_ids:
            errors.append("deal %s points at unknown person %r" % (did, d["person_id"]))
        if d.get("stage") not in STAGES:
            errors.append("deal %s stage %r is not one of %s" % (did, d.get("stage"), ", ".join(STAGES)))
        if not isinstance(d.get("amount", 0), (int, float)) or d.get("amount", 0) < 0:
            errors.append("deal %s amount must be a number >= 0" % did)
        for k in ("created", "paid_on", "ships_by", "delivered_on"):
            if d.get(k) and not DATE_RE.match(d[k]):
                errors.append("deal %s %s %r must be YYYY-MM-DD" % (did, k, d[k]))
        if d.get("stage") == "lost" and not d.get("lost_reason"):
            errors.append("deal %s is lost with no lost_reason" % did)
        if d.get("stage") in MONEY_IN:
            if did not in paid:
                errors.append("deal %s says %s with no payment on record" % (did, d["stage"]))
            if not d.get("ships_by"):
                errors.append("deal %s took money with no promised ship date" % did)
        if d.get("stage") in OPEN and not d.get("next_step"):
            warnings.append("deal %s has no next step" % did)
    seen = set()
    for a in data["activities"]:
        aid = a.get("id", "")
        if not aid or aid in seen:
            errors.append("activity id %r is missing or duplicated" % aid)
        seen.add(aid)
        if not STAMP_RE.match(a.get("date") or ""):
            errors.append("activity %s date %r must be YYYY-MM-DD or YYYY-MM-DDTHH:MM" % (aid, a.get("date")))
        if a.get("deal_id") not in deal_ids:
            errors.append("activity %s points at unknown deal %r" % (aid, a.get("deal_id")))
        if a.get("channel") not in CHANNELS:
            errors.append("activity %s channel %r is not one of %s" % (aid, a.get("channel"), ", ".join(CHANNELS)))
        if a.get("type") not in TYPES:
            errors.append("activity %s type %r is not one of %s" % (aid, a.get("type"), ", ".join(TYPES)))
        if a.get("direction") not in DIRECTIONS:
            errors.append("activity %s direction must be out, in or null" % aid)
        if a.get("direction") == "out" and a.get("channel") == "email" and not a.get("approval"):
            errors.append("activity %s went out with no recorded approval" % aid)
    for p in data["payments"]:
        if p.get("deal_id") not in deal_ids:
            errors.append("payment %s points at unknown deal %r" % (p.get("id"), p.get("deal_id")))
        if not p.get("ref"):
            errors.append("payment %s has no processor reference" % p.get("id"))
        if not isinstance(p.get("amount"), (int, float)) or p["amount"] <= 0:
            errors.append("payment %s amount must be above zero" % p.get("id"))
    for r in data["requirements"]:
        if r.get("deal_id") not in deal_ids:
            errors.append("requirement %s points at unknown deal %r" % (r.get("id"), r.get("deal_id")))
        if not r.get("ask") or not r.get("feature"):
            errors.append("requirement %s needs both the ask and the feature" % r.get("id"))
    for s in data["case_studies"]:
        if s.get("deal_id") not in deal_ids:
            errors.append("case study %s points at unknown deal %r" % (s.get("id"), s.get("deal_id")))
    return errors, warnings


def next_id(items, prefix):
    n = 0
    for it in items:
        m = re.match(r"^%s(\d+)$" % prefix, it.get("id", ""))
        if m:
            n = max(n, int(m.group(1)))
    return "%s%d" % (prefix, n + 1)


def add_activity(data, **fields):
    act = {"id": next_id(data["activities"], "a"), "date": None, "deal_id": None, "person_id": None, "channel": None,
           "type": None, "direction": None, "subject": None, "text": ""}
    act.update(fields)
    data["activities"].append(act)
    return act


def upsert(items, item_id, fields, defaults):
    it = find(items, item_id)
    if it is None:
        it = dict(defaults, id=item_id)
        items.append(it)
    it.update({k: v for k, v in fields.items() if v is not None})
    return it


def move(data, deal_id, stage, reason=None, when=None):
    if stage not in STAGES:
        raise BoardError("Stage %r is not one of %s" % (stage, ", ".join(STAGES)))
    d = need(data["deals"], deal_id, "deal")
    if stage in MONEY_IN and not live_payments(data, deal_id):
        raise BoardError("%s has no payment on record. Use /pre-sale record once Stripe shows it paid." % deal_id)
    if stage == "lost" and not reason:
        raise BoardError("A lost deal needs a reason.")
    d["stage"] = stage
    if reason:
        d["lost_reason"] = reason
    if stage in ("lost", "refunded"):
        d["next_step"] = None
    add_activity(data, date=when or datetime.date.today().isoformat(), deal_id=deal_id, channel="note", type="stage",
                 text="moved to %s%s" % (stage, ": " + reason if reason else ""))
    return d


def board_text(data, today=None):
    today = today or datetime.date.today()
    me = data.get("me", {})
    lines = ["WHALE BOARD  %s  %s" % (me.get("product") or "(no product yet)", today.isoformat())]
    target = me.get("target_customers") or 3
    spent = data.get("marketing_spent")
    lines.append("Paying customers: %d of %d  |  Money in: %s  |  Marketing spent: %s" % (
        len(paying_customers(data)), target, money(money_in(data)), "not recorded" if spent is None else money(spent)))
    picked = [p for p in data["problems"] if p.get("picked")]
    if picked:
        lines.append("Problem: %s (%s, about %s/mo)" % (picked[0]["problem"], picked[0]["who"], short_money(picked[0].get("pay_month"))))
    for stage in STAGES:
        deals = [d for d in data["deals"] if d.get("stage") == stage]
        if not deals:
            continue
        total = sum(d.get("amount") or 0 for d in deals)
        lines.append("")
        lines.append("%s (%d, %s)" % (stage.upper(), len(deals), short_money(total)))
        for d in sorted(deals, key=lambda x: -(x.get("amount") or 0)):
            c = find(data["companies"], d["company_id"]) or {}
            bits = ["  %s" % (c.get("name") or d["company_id"]), short_money(d.get("amount"))]
            if d.get("ships_by") and stage == "paid":
                bits.append("ships by %s" % d["ships_by"])
            if d.get("next_step"):
                bits.append("next: %s" % d["next_step"])
            if d.get("lost_reason"):
                bits.append("why: %s" % d["lost_reason"])
            hist = history(data, d["id"])
            if hist and stage in OPEN:
                last = datetime.date.fromisoformat(hist[-1]["date"][:10])
                quiet = (today - last).days
                if quiet >= 5:
                    bits.append("[quiet %d days]" % quiet)
            lines.append("  ".join(bits))
    return "\n".join(lines)


def show_text(data, deal_id):
    d = need(data["deals"], deal_id, "deal")
    c = find(data["companies"], d["company_id"]) or {}
    lines = ["%s  %s  %s  %s" % (c.get("name"), d.get("title") or "", d.get("stage"), short_money(d.get("amount")))]
    if c.get("spend_month"):
        lines.append("They pay today: %s/mo for %s (source: %s)" % (short_money(c["spend_month"]), c.get("spend_line") or "this", c.get("spend_source")))
    for p in data["people"]:
        if p["company_id"] == d["company_id"]:
            lines.append("  %s, %s (%s) %s%s" % (p["name"], p.get("title") or "", p.get("decides") or "?", p.get("email") or "no email",
                                                "  DO NOT CONTACT" if p.get("do_not_contact") else ""))
    for a in history(data, deal_id):
        lines.append("  %s  %-8s %-3s %s" % (a["date"], a["type"], a.get("direction") or "", (a.get("subject") or a.get("text") or "").split("\n")[0]))
    for p in data["payments"]:
        if p["deal_id"] == deal_id:
            lines.append("  %s  PAID %s (%s)%s" % (p["date"], money(p["amount"]), p["ref"], "  REFUNDED " + p["refunded_on"] if p.get("refunded_on") else ""))
    for r in data["requirements"]:
        if r["deal_id"] == deal_id:
            lines.append("  ask: %s -> %s%s" % (r["ask"], r["feature"], "  [done]" if r.get("done") else ""))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="The Whale board.")
    ap.add_argument("--file", default=DEFAULT_FILE)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init")
    for k in ("name", "company", "email", "address", "product", "does", "value_line"):
        p.add_argument("--" + k, required=k in ("name", "company", "email", "address"))
    p.add_argument("--target_customers", type=int, default=3)

    p = sub.add_parser("company")
    p.add_argument("--id", required=True)
    for k in ("name", "website", "what", "problem", "spend_line", "spend_source", "notes"):
        p.add_argument("--" + k)
    p.add_argument("--spend_month", type=float)

    p = sub.add_parser("person")
    p.add_argument("--id", required=True)
    for k in ("company", "name", "title", "email", "email_source", "note"):
        p.add_argument("--" + k)
    p.add_argument("--decides", choices=("signs", "budget", "pain"))

    p = sub.add_parser("deal")
    p.add_argument("--id", required=True)
    for k in ("company", "person", "title", "next_step", "created"):
        p.add_argument("--" + k)
    p.add_argument("--amount", type=float)

    p = sub.add_parser("move")
    p.add_argument("--deal", required=True)
    p.add_argument("--stage", required=True)
    p.add_argument("--reason")
    p.add_argument("--at")

    p = sub.add_parser("board")
    p.add_argument("--today")

    p = sub.add_parser("show")
    p.add_argument("--deal", required=True)

    sub.add_parser("validate")

    args = ap.parse_args(file_first(argv))
    try:
        if args.cmd == "init":
            if os.path.exists(args.file):
                raise BoardError("%s already exists. Nothing changed." % args.file)
            me = {k: getattr(args, k) for k in ("name", "company", "email", "address", "product", "does", "value_line", "target_customers")}
            save(empty(me), args.file)
            print("Created %s" % args.file)
            return 0
        data = load(args.file)
        if args.cmd == "company":
            upsert(data["companies"], args.id, {"name": args.name, "website": args.website, "what": args.what, "problem_id": args.problem,
                                                "spend_line": args.spend_line, "spend_month": args.spend_month,
                                                "spend_source": args.spend_source, "notes": args.notes},
                   {"name": args.id, "website": None, "what": None, "problem_id": None, "spend_line": None, "spend_month": None,
                    "spend_source": None, "notes": None})
        elif args.cmd == "person":
            upsert(data["people"], args.id, {"company_id": args.company, "name": args.name, "title": args.title, "decides": args.decides,
                                             "email": args.email, "email_source": args.email_source, "note": args.note},
                   {"company_id": None, "name": args.id, "title": None, "decides": None, "email": None, "email_source": None,
                    "note": None, "do_not_contact": False})
        elif args.cmd == "deal":
            upsert(data["deals"], args.id, {"company_id": args.company, "person_id": args.person, "title": args.title, "amount": args.amount,
                                            "next_step": args.next_step, "created": args.created},
                   {"company_id": None, "person_id": None, "title": None, "stage": "found", "amount": 0, "next_step": None,
                    "created": datetime.date.today().isoformat(), "ships_by": None, "paid_on": None, "lost_reason": None})
        elif args.cmd == "move":
            move(data, args.deal, args.stage, args.reason, args.at)
        elif args.cmd == "board":
            print(board_text(data, today_arg(args.today)))
            return 0
        elif args.cmd == "show":
            print(show_text(data, args.deal))
            return 0
        elif args.cmd == "validate":
            errors, warnings = validate(data)
            for w in warnings:
                print("warning: %s" % w)
            for e in errors:
                print("error: %s" % e)
            print("OK" if not errors else "%d error(s)" % len(errors))
            return 1 if errors else 0
        save(data, args.file)
        print("Saved %s" % args.file)
        return 0
    except (BoardError, ValueError) as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
