#!/usr/bin/env python3
"""Finds who decides at a company and writes the pitch. Standard library only.

Claude finds the people from public sources; this keeps them honest on the board. It ranks them
(who signs the check, who owns the budget, who feels the pain), writes the pitch to the right one
from pitch.json, and refuses anything that breaks the rules. It never sends.

  who     who decides at a company, in the order to approach them
  draft   the pitch email for one person
  record  logs a pitch only after it really went out, with the user's yes word for word

    python3 hunter.py who --company north-pier
    python3 hunter.py draft --deal north-pier --demo https://yourproduct.example/demo
    python3 hunter.py record --deal north-pier --subject "You pay $6,400 a month to chase invoices" \
        --text-file /tmp/pitch.txt --approval "yes" --at 2026-10-26T09:04
"""

import argparse
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_PITCHES_A_DAY = 50
ORDER = {"signs": 0, "budget": 1, "pain": 2, None: 3}


def _board():
    path = os.path.join(HERE, "..", "market-researcher", "board.py")
    if not os.path.exists(path):
        sys.exit("The whale-hunter skill needs the market-researcher skill next to it (../market-researcher/board.py).")
    spec = importlib.util.spec_from_file_location("whale_board", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


B = _board()


def load_templates():
    with open(os.path.join(HERE, "pitch.json"), encoding="utf-8") as fh:
        return json.load(fh)


def people_at(data, company_id):
    rows = [p for p in data["people"] if p.get("company_id") == company_id]
    return sorted(rows, key=lambda p: ORDER.get(p.get("decides"), 3))


def who_text(data, company_id):
    c = B.need(data["companies"], company_id, "company")
    rows = people_at(data, company_id)
    if not rows:
        return "Nobody on file at %s yet. Add them with board.py person, each with a public source." % c["name"]
    lines = ["%s: who decides" % c["name"]]
    label = {"signs": "signs the check", "budget": "owns the budget", "pain": "feels the pain daily", None: "role unknown"}
    for i, p in enumerate(rows):
        lines.append("  %s %s, %s: %s%s" % ("->" if i == 0 else "  ", p["name"], p.get("title") or "?", label[p.get("decides")],
                                            "  DO NOT CONTACT" if p.get("do_not_contact") else ""))
    return "\n".join(lines)


def pitched(data, deal_id):
    return [a for a in B.history(data, deal_id) if a["type"] == "pitch"]


def guard(data, deal, person):
    B.company_email_guard(data, person)
    if pitched(data, deal["id"]):
        raise B.BoardError("%s was already pitched. /follow-up takes it from here." % deal["id"])
    if deal.get("stage") in ("lost", "refunded"):
        raise B.BoardError("%s is %s. No pitch." % (deal["id"], deal["stage"]))
    for other in data["deals"]:
        if other["id"] != deal["id"] and other["company_id"] == deal["company_id"] and other.get("stage") in B.OPEN and pitched(data, other["id"]):
            raise B.BoardError("Someone at this company already has a pitch open (%s). One person at a time." % other["id"])


def first_name(name):
    return name.split()[0]


def short_company(name):
    return re.sub(r"\s+(Logistics|Freight|Haul|Inc\.?|LLC|Ltd\.?|Co\.?|Corp\.?|Company)$", "", name, flags=re.I)


def draft(data, deal_id, demo=None, person_id=None):
    deal = B.need(data["deals"], deal_id, "deal")
    company = B.need(data["companies"], deal["company_id"], "company")
    pid = person_id or deal.get("person_id") or (people_at(data, company["id"]) or [{}])[0].get("id")
    if not pid:
        raise B.BoardError("Nobody to pitch at %s yet. Add them with board.py person." % company["name"])
    person = B.need(data["people"], pid, "person")
    guard(data, deal, person)
    problem = B.find(data["problems"], company.get("problem_id") or "") or next((p for p in data["problems"] if p.get("picked")), None)
    if problem is None:
        raise B.BoardError("No picked problem yet. Run /market-researcher first.")
    me = data.get("me", {})
    amount, key = company.get("spend_month"), "their-spend"
    if not amount:
        amount, key = problem.get("pay_month"), "market-spend"
    t = load_templates()[key]
    fields = {"first": first_name(person["name"]), "company": company["name"], "short": short_company(company["name"]),
              "who": problem["who"], "problem": problem["problem"], "amount": B.short_money(amount),
              "phrase": problem.get("phrase") or "[fill: what they pay to do, like chase late invoices]",
              "demo": demo or "[fill: link to the demo]", "me": (me.get("name") or "").split(" ")[0]}
    body = t["body"].format(**fields) + B.footer(me)
    return {"to": person["email"], "person": person["id"], "subject": t["subject"].format(**fields), "body": body,
            "missing": re.findall(r"\[fill: ([^\]]+)\]", body)}


def record(data, deal_id, text, subject, approval, when, person_id=None):
    ok, why = B.parse_yes(approval)
    if not ok:
        raise B.BoardError("Not logged: %s" % why)
    deal = B.need(data["deals"], deal_id, "deal")
    person = B.need(data["people"], person_id or deal.get("person_id"), "person")
    guard(data, deal, person)
    day = when[:10]
    sent_today = [a for a in data["activities"] if a["type"] == "pitch" and a["date"][:10] == day]
    if len(sent_today) >= MAX_PITCHES_A_DAY:
        raise B.BoardError("%d pitches on %s already. This stays one to one, not bulk mail." % (MAX_PITCHES_A_DAY, day))
    B.add_activity(data, date=when, deal_id=deal_id, person_id=person["id"], channel="email", type="pitch", direction="out",
                   subject=subject, text=text, approval=approval)
    deal["stage"] = "pitched"
    deal["person_id"] = person["id"]
    deal["next_step"] = "/follow-up if no reply"
    return deal


def main(argv=None):
    ap = argparse.ArgumentParser(description="Who decides, and the pitch.")
    ap.add_argument("--file", default=B.DEFAULT_FILE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("who")
    p.add_argument("--company", required=True)
    p = sub.add_parser("draft")
    p.add_argument("--deal", required=True)
    p.add_argument("--person")
    p.add_argument("--demo")
    p = sub.add_parser("record")
    p.add_argument("--deal", required=True)
    p.add_argument("--person")
    p.add_argument("--subject", required=True)
    p.add_argument("--text-file", required=True)
    p.add_argument("--approval", required=True)
    p.add_argument("--at", required=True)
    args = ap.parse_args(B.file_first(argv))
    try:
        data = B.load(args.file)
        if args.cmd == "who":
            print(who_text(data, args.company))
        elif args.cmd == "draft":
            d = draft(data, args.deal, args.demo, args.person)
            print("To: %s\nSubject: %s\n\n%s" % (d["to"], d["subject"], d["body"]))
        else:
            with open(args.text_file, encoding="utf-8") as fh:
                text = fh.read()
            record(data, args.deal, text, args.subject, args.approval, args.at, args.person)
            B.save(data, args.file)
            print("Logged. %s is pitched." % args.deal)
        return 0
    except (B.BoardError, OSError, ValueError) as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
