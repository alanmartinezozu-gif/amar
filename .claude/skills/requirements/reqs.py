#!/usr/bin/env python3
"""Turns what paying customers asked for into the build list. Standard library only.

Every line on the build list traces back to who asked, in their words, and how much money is
behind it. What a paying customer asked for gets built first; a nice idea from someone who has
not paid waits.

  add      one ask, with the feature it becomes
  list     every ask, by customer
  build    the build list, written to whale/requirements.md
  confirm  logs the customer confirming the list in their own words
  done     marks a feature built, for everyone who asked for it

    python3 reqs.py add --deal north-pier --ask "Sync with QuickBooks" --feature "QuickBooks sync"
    python3 reqs.py build
    python3 reqs.py confirm --deal north-pier --said "Yes, that's what we need." --at 2026-11-04
    python3 reqs.py done --feature "QuickBooks sync" --at 2026-11-20
"""

import argparse
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join("whale", "requirements.md")


def _board():
    path = os.path.join(HERE, "..", "market-researcher", "board.py")
    if not os.path.exists(path):
        sys.exit("The requirements skill needs the market-researcher skill next to it (../market-researcher/board.py).")
    spec = importlib.util.spec_from_file_location("whale_board", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


B = _board()


def add(data, deal_id, ask, feature, said=None):
    deal = B.need(data["deals"], deal_id, "deal")
    if not ask.strip() or not feature.strip():
        raise B.BoardError("An ask needs their words and the feature it becomes.")
    for r in data["requirements"]:
        if r["deal_id"] == deal_id and r["ask"] == ask.strip():
            r["feature"] = feature.strip()
            return r
    row = {"id": B.next_id(data["requirements"], "r"), "deal_id": deal_id, "ask": ask.strip(), "feature": feature.strip(), "said": said,
           "done": False, "confirmed": None}
    data["requirements"].append(row)
    if deal.get("stage") == "paid":
        deal["next_step"] = "/requirements: confirm the list with them"
    return row


def company_name(data, deal_id):
    d = B.find(data["deals"], deal_id) or {}
    return (B.find(data["companies"], d.get("company_id")) or {}).get("name") or deal_id


def build_list(data):
    """Features merged across customers: paid money first, then how many asked."""
    paying = set(B.paying_customers(data))
    merged = {}
    for r in data["requirements"]:
        key = B.slug(r["feature"])
        f = merged.setdefault(key, {"feature": r["feature"], "asks": [], "paying": [], "other": [], "money": 0, "done": True})
        f["asks"].append({"who": company_name(data, r["deal_id"]), "ask": r["ask"]})
        f["done"] = f["done"] and bool(r.get("done"))
        if r["deal_id"] in paying:
            if r["deal_id"] not in f["paying"]:
                f["paying"].append(r["deal_id"])
                f["money"] += sum(p["amount"] for p in B.live_payments(data, r["deal_id"]))
        elif r["deal_id"] not in f["other"]:
            f["other"].append(r["deal_id"])
    rows = sorted(merged.values(), key=lambda f: (not f["paying"], -f["money"], -len(f["paying"]), f["feature"]))
    return {"build": [f for f in rows if f["paying"]], "later": [f for f in rows if not f["paying"]]}


def build_text(data):
    lists = build_list(data)
    if not lists["build"] and not lists["later"]:
        return "# Build list\n\nNothing yet. Ask each paying customer what they need, then run reqs.py add.\n"
    lines = ["# Build list", "", "Only what a paying customer asked for. Nothing here is a guess.", ""]
    for f in lists["build"]:
        lines.append("- [%s] **%s** (%d paying, %s behind it)" % ("x" if f["done"] else " ", f["feature"], len(f["paying"]), B.short_money(f["money"])))
        for a in f["asks"]:
            lines.append("    - %s: \"%s\"" % (a["who"], a["ask"]))
    if lists["later"]:
        lines += ["", "## Later: asked for by someone who has not paid", ""]
        for f in lists["later"]:
            lines.append("- %s (%s)" % (f["feature"], ", ".join(a["who"] for a in f["asks"])))
    unconfirmed = sorted({company_name(data, r["deal_id"]) for r in data["requirements"] if not r.get("confirmed") and r["deal_id"] in B.paying_customers(data)})
    if unconfirmed:
        lines += ["", "Not confirmed by the customer yet: " + ", ".join(unconfirmed)]
    return "\n".join(lines) + "\n"


def confirm(data, deal_id, said, when):
    if B.NO_RE.search(said or "") or not (said or "").strip():
        raise B.BoardError("That is not a confirmation. Log only what they really said yes to.")
    rows = [r for r in data["requirements"] if r["deal_id"] == deal_id]
    if not rows:
        raise B.BoardError("%s has no requirements yet." % deal_id)
    for r in rows:
        r["confirmed"] = {"said": said, "at": when}
    B.need(data["deals"], deal_id, "deal")["next_step"] = "Build it. /launch-planner keeps the dates"
    B.add_activity(data, date=when, deal_id=deal_id, channel="note", type="note", text="requirements confirmed: " + said)
    return rows


def done(data, feature, when):
    key = B.slug(feature)
    rows = [r for r in data["requirements"] if B.slug(r["feature"]) == key]
    if not rows:
        raise B.BoardError("No feature called %r." % feature)
    for r in rows:
        r.update(done=True, done_on=when)
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description="The build list, from what customers asked for.")
    ap.add_argument("--file", default=B.DEFAULT_FILE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("add")
    p.add_argument("--deal", required=True)
    p.add_argument("--ask", required=True)
    p.add_argument("--feature", required=True)
    p.add_argument("--said")
    p = sub.add_parser("list")
    p.add_argument("--deal")
    p = sub.add_parser("build")
    p.add_argument("--out", default=OUT)
    p = sub.add_parser("confirm")
    p.add_argument("--deal", required=True)
    p.add_argument("--said", required=True)
    p.add_argument("--at", required=True)
    p = sub.add_parser("done")
    p.add_argument("--feature", required=True)
    p.add_argument("--at", required=True)
    args = ap.parse_args(B.file_first(argv))
    try:
        data = B.load(args.file)
        if args.cmd == "list":
            for r in data["requirements"]:
                if not args.deal or r["deal_id"] == args.deal:
                    print("%-24s %-42s -> %s%s" % (company_name(data, r["deal_id"]), r["ask"], r["feature"], "  [done]" if r.get("done") else ""))
            return 0
        if args.cmd == "build":
            text = build_text(data)
            folder = os.path.dirname(args.out)
            if folder:
                os.makedirs(folder, exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(text)
            print(text, end="")
            return 0
        if args.cmd == "add":
            add(data, args.deal, args.ask, args.feature, args.said)
        elif args.cmd == "confirm":
            confirm(data, args.deal, args.said, args.at)
        else:
            done(data, args.feature, args.at)
        B.save(data, args.file)
        print("Saved.")
        return 0
    except (B.BoardError, OSError, ValueError) as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
