#!/usr/bin/env python3
"""Plans the launch once it is paid for. Standard library only.

The plan runs backwards from the earliest date you promised a paying customer. The public launch
comes last and has a gate: it does not open until someone has the product in their hands, nobody
is late, and every paying customer has been looked after.

  plan    the dated plan, written to whale/launch-plan.md
  status  what is done, what is next, what is late
  gate    may this launch in public yet?

    python3 launch.py plan --today 2026-11-05
    python3 launch.py status --today 2026-11-20
    python3 launch.py gate --today 2026-12-20
"""

import argparse
import datetime
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join("whale", "launch-plan.md")
# days before the first promised date, and the step that lands then
STEPS = ((-25, "Confirm the requirements with every paying customer (/requirements confirm)"),
         (-10, "Feature complete: everything on the build list"),
         (-7, "Each customer tests it on their own data, with you watching"),
         (-2, "Fix what they found. Anything that will slip: tell them now (/pre-sale notice)"),
         (0, "Ship to the first customer"))
PUBLIC_AFTER_DAYS = 14


def _board():
    path = os.path.join(HERE, "..", "market-researcher", "board.py")
    if not os.path.exists(path):
        sys.exit("The launch-planner skill needs the market-researcher skill next to it (../market-researcher/board.py).")
    spec = importlib.util.spec_from_file_location("whale_board", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


B = _board()


def promised(data):
    deals = [d for d in data["deals"] if d.get("stage") == "paid" and d.get("ships_by")]
    return sorted(deals, key=lambda d: d["ships_by"])


def plan(data, today):
    deals = promised(data)
    if not deals and any(d.get("stage") == "delivered" for d in data["deals"]):
        raise B.BoardError("Everyone who paid has the product. Check launch.py gate.")
    if not deals:
        raise B.BoardError("Nobody has paid yet, so there is nothing to plan. Run /pre-sale first: the plan starts when the money does.")
    first = datetime.date.fromisoformat(deals[0]["ships_by"])
    rows = []
    for offset, step in STEPS:
        on = first + datetime.timedelta(days=offset)
        rows.append({"on": on, "step": step, "past": on < today})
    for d in deals[1:]:
        c = B.find(data["companies"], d["company_id"]) or {}
        rows.append({"on": datetime.date.fromisoformat(d["ships_by"]), "step": "Ship to %s" % (c.get("name") or d["id"]), "past": False})
    last = datetime.date.fromisoformat(deals[-1]["ships_by"])
    rows.append({"on": last + datetime.timedelta(days=PUBLIC_AFTER_DAYS), "step": "Public launch, if the gate is open (launch.py gate)", "past": False})
    return sorted(rows, key=lambda r: r["on"])


def plan_text(data, today):
    rows = plan(data, today)
    lines = ["# Launch plan", "", "Worked backwards from the first date you promised. %d paying customer(s), %s in." % (
        len(B.paying_customers(data)), B.money(B.money_in(data))), ""]
    for r in rows:
        lines.append("- %s  %s%s" % (r["on"].isoformat(), r["step"], "  (date already passed: do this first)" if r["past"] else ""))
    return "\n".join(lines) + "\n"


def gate(data, today):
    """Returns (open, reasons). Every reason has to be gone before a public launch."""
    reasons = []
    delivered = [d for d in data["deals"] if d.get("stage") == "delivered"]
    if not delivered:
        reasons.append("No customer has the product yet.")
    for d in promised(data):
        if datetime.date.fromisoformat(d["ships_by"]) < today:
            c = B.find(data["companies"], d["company_id"]) or {}
            reasons.append("%s is late. Deliver, agree a new date, or refund them first." % (c.get("name") or d["id"]))
    undone = sorted({r["feature"] for r in data["requirements"] if not r.get("done") and r["deal_id"] in B.paying_customers(data)})
    if undone:
        reasons.append("Still owed to paying customers: %s." % ", ".join(undone))
    return not reasons, reasons


def status_text(data, today):
    rows = plan(data, today)
    done = {r["feature"] for r in data["requirements"] if r.get("done")}
    todo = {r["feature"] for r in data["requirements"]} - done
    lines = ["Features: %d of %d built" % (len(done), len(done) + len(todo))]
    upcoming = [r for r in rows if r["on"] >= today]
    if upcoming:
        lines.append("Next: %s  %s" % (upcoming[0]["on"].isoformat(), upcoming[0]["step"]))
    for d in promised(data):
        left = (datetime.date.fromisoformat(d["ships_by"]) - today).days
        c = B.find(data["companies"], d["company_id"]) or {}
        lines.append("  %-28s ships by %s (%s)" % (c.get("name") or d["id"], d["ships_by"], "LATE" if left < 0 else "%d days" % left))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="The launch, once it is paid for.")
    ap.add_argument("--file", default=B.DEFAULT_FILE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("plan", "status", "gate"):
        p = sub.add_parser(name)
        p.add_argument("--today")
        if name == "plan":
            p.add_argument("--out", default=OUT)
    args = ap.parse_args(B.file_first(argv))
    try:
        data = B.load(args.file)
        today = B.today_arg(args.today)
        if args.cmd == "plan":
            text = plan_text(data, today)
            folder = os.path.dirname(args.out)
            if folder:
                os.makedirs(folder, exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(text)
            print(text, end="")
        elif args.cmd == "status":
            print(status_text(data, today))
        else:
            ok, reasons = gate(data, today)
            print("OPEN: nothing stands in the way of a public launch." if ok else "CLOSED")
            for r in reasons:
                print("  %s" % r)
            return 0 if ok else 1
        return 0
    except (B.BoardError, OSError, ValueError) as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
