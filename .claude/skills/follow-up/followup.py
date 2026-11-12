#!/usr/bin/env python3
"""Keeps the deal moving without pestering anyone. Standard library only.

Works out who is due, drafts the next note from templates.json, and refuses anything that breaks
a stop rule. It works from the last pitch or offer: up to 3 follow-ups, nothing after 30 days,
and a reply always stops the clock. It never sends.

  due     who to follow up with today, and who is waiting on you
  draft   the next follow-up for one deal
  record  logs a follow-up only after it really went out, with the user's yes word for word
  reply   logs their reply: a no stops everything, for good
  stop    stops one deal, in their words

    python3 followup.py due --today 2026-10-28
    python3 followup.py draft --deal north-pier --today 2026-10-28
    python3 followup.py record --deal north-pier --text-file /tmp/f.txt --approval "yes" --at 2026-10-28T09:00
    python3 followup.py reply --deal north-pier --text "Interesting. Can you show me Thursday?" --at 2026-10-29T14:20
"""

import argparse
import datetime
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GAPS = (2, 2, 4)
MAX_FOLLOWUPS = len(GAPS)
MAX_DAYS = 30
ACTIVE = ("pitched", "offer-sent")


def _board():
    path = os.path.join(HERE, "..", "market-researcher", "board.py")
    if not os.path.exists(path):
        sys.exit("The follow-up skill needs the market-researcher skill next to it (../market-researcher/board.py).")
    spec = importlib.util.spec_from_file_location("whale_board", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


B = _board()


def load_templates():
    with open(os.path.join(HERE, "templates.json"), encoding="utf-8") as fh:
        return json.load(fh)


def to_date(stamp):
    return datetime.date.fromisoformat(stamp[:10])


def next_workday(day):
    while day.weekday() >= 5:
        day += datetime.timedelta(days=1)
    return day


def state(data, deal, today):
    """One of DUE, WAITING, YOUR TURN, STOPPED or BOOKED, with why and when."""
    stage = deal.get("stage")
    if stage in ("demo-booked", "paid", "delivered"):
        return {"status": "BOOKED", "why": "at %s, no follow-ups" % stage}
    if stage in ("lost", "refunded"):
        return {"status": "STOPPED", "why": deal.get("lost_reason") or stage}
    person = B.find(data["people"], deal.get("person_id") or "") or {}
    if person.get("do_not_contact") or B.suppressed(data, person.get("email")):
        return {"status": "STOPPED", "why": "do not contact"}
    hist = B.history(data, deal["id"])
    anchors = [a for a in hist if a["type"] in ("pitch", "offer") and a.get("direction") == "out"]
    if not anchors:
        return {"status": "WAITING", "why": "nothing sent yet"}
    anchor = anchors[-1]
    after = [a for a in hist if a["date"] > anchor["date"]]
    if any(a.get("direction") == "in" for a in after):
        return {"status": "YOUR TURN", "why": "they replied"}
    sent = [a for a in after if a["type"] == "followup" and a.get("direction") == "out"]
    if len(sent) >= MAX_FOLLOWUPS:
        return {"status": "STOPPED", "why": "%d follow-ups sent, that was the last" % MAX_FOLLOWUPS}
    start = to_date(anchor["date"])
    if (today - start).days > MAX_DAYS:
        return {"status": "STOPPED", "why": "%d days since the %s" % (MAX_DAYS, anchor["type"])}
    last = to_date(sent[-1]["date"]) if sent else start
    on = next_workday(last + datetime.timedelta(days=GAPS[len(sent)]))
    n = len(sent) + 1
    if today >= on:
        return {"status": "DUE", "why": "follow-up %d" % n, "number": n, "on": on.isoformat(), "kind": anchor["type"]}
    return {"status": "WAITING", "why": "follow-up %d on %s" % (n, on.isoformat()), "number": n, "on": on.isoformat(), "kind": anchor["type"]}


def due_text(data, today):
    groups = {"DUE": [], "YOUR TURN": [], "WAITING": [], "BOOKED": [], "STOPPED": []}
    for d in data["deals"]:
        c = B.find(data["companies"], d["company_id"]) or {}
        s = state(data, d, today)
        groups[s["status"]].append("  %-28s %s" % (c.get("name") or d["id"], s["why"]))
    lines = []
    for label, head in (("DUE", "DUE NOW"), ("YOUR TURN", "YOUR TURN"), ("WAITING", "WAITING"), ("BOOKED", "BOOKED"), ("STOPPED", "STOPPED")):
        if groups[label]:
            lines.append(head)
            lines.extend(groups[label])
    return "\n".join(lines) or "No deals yet."


def draft(data, deal_id, today, hook=None):
    deal = B.need(data["deals"], deal_id, "deal")
    s = state(data, deal, today)
    if s["status"] != "DUE":
        raise B.BoardError("No follow-up for %s: %s (%s)." % (deal_id, s["status"], s["why"]))
    person = B.need(data["people"], deal.get("person_id"), "person")
    B.company_email_guard(data, person)
    t = load_templates()[str(s["number"])]
    if t.get("needs_hook") and not hook:
        raise B.BoardError("Follow-up 2 has to give them something new and true. Pass --hook, or skip it.")
    me = data.get("me", {})
    thing = "the offer" if s["kind"] == "offer" else "the demo"
    body = t["body"].format(first=person["name"].split()[0], thing=thing, hook=hook or "", me=(me.get("name") or "").split(" ")[0]) + B.footer(me)
    return {"to": person["email"], "thread": "the same thread as the %s" % s["kind"], "body": body, "number": s["number"]}


def record(data, deal_id, text, approval, when):
    ok, why = B.parse_yes(approval)
    if not ok:
        raise B.BoardError("Not logged: %s" % why)
    deal = B.need(data["deals"], deal_id, "deal")
    s = state(data, deal, to_date(when))
    if s["status"] != "DUE":
        raise B.BoardError("Not logged: no follow-up was due for %s (%s, %s)." % (deal_id, s["status"], s["why"]))
    return B.add_activity(data, date=when, deal_id=deal_id, person_id=deal.get("person_id"), channel="email", type="followup",
                          direction="out", subject="Follow-up %d" % s["number"], text=text, approval=approval)


def stop(data, deal_id, said, when):
    deal = B.need(data["deals"], deal_id, "deal")
    person = B.find(data["people"], deal.get("person_id") or "") or {}
    if B.UNSUB_RE.search(said or ""):
        person["do_not_contact"] = True
        if person.get("email") and not B.suppressed(data, person["email"]):
            data["suppression"].append(person["email"])
    if deal.get("stage") not in ("paid", "delivered", "refunded"):
        B.move(data, deal_id, "lost", said or "they said no", when)
    return deal


def reply(data, deal_id, text, when):
    deal = B.need(data["deals"], deal_id, "deal")
    B.add_activity(data, date=when, deal_id=deal_id, person_id=deal.get("person_id"), channel="email", type="reply", direction="in", text=text)
    if B.NO_RE.search(text or ""):
        stop(data, deal_id, text, when)
        return "stopped"
    if deal.get("stage") == "pitched":
        deal["stage"] = "replied"
    deal["next_step"] = "answer them: /objection-handler if they pushed back, book the demo if they asked"
    return "your turn"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Keep the deal moving.")
    ap.add_argument("--file", default=B.DEFAULT_FILE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("due")
    p.add_argument("--today")
    p = sub.add_parser("draft")
    p.add_argument("--deal", required=True)
    p.add_argument("--today")
    p.add_argument("--hook")
    p = sub.add_parser("record")
    p.add_argument("--deal", required=True)
    p.add_argument("--text-file", required=True)
    p.add_argument("--approval", required=True)
    p.add_argument("--at", required=True)
    p = sub.add_parser("reply")
    p.add_argument("--deal", required=True)
    p.add_argument("--text", required=True)
    p.add_argument("--at", required=True)
    p = sub.add_parser("stop")
    p.add_argument("--deal", required=True)
    p.add_argument("--said", required=True)
    p.add_argument("--at", required=True)
    args = ap.parse_args(B.file_first(argv))
    try:
        data = B.load(args.file)
        if args.cmd == "due":
            print(due_text(data, B.today_arg(args.today)))
            return 0
        if args.cmd == "draft":
            d = draft(data, args.deal, B.today_arg(args.today), args.hook)
            print("To: %s (in %s)\n\n%s" % (d["to"], d["thread"], d["body"]))
            return 0
        if args.cmd == "record":
            with open(args.text_file, encoding="utf-8") as fh:
                text = fh.read()
            record(data, args.deal, text, args.approval, args.at)
            print("Logged.")
        elif args.cmd == "reply":
            print(reply(data, args.deal, args.text, args.at))
        else:
            stop(data, args.deal, args.said, args.at)
            print("Stopped, for good.")
        B.save(data, args.file)
        return 0
    except (B.BoardError, OSError, ValueError) as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
