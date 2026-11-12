#!/usr/bin/env python3
"""Finds problems businesses already pay thousands to solve. Standard library only.

Keeps the research on the board. A problem only counts if you can say who pays, how much they
pay today, and where that number came from. A number with no source has to be marked as an
estimate with its working shown, and it ranks below every sourced one.

  add    adds a problem (with --source, or --estimate and --basis)
  rank   the table: problem, who pays, what they pay today
  pick   picks the one problem to go after

    python3 problems.py add --problem "Chasing late invoices" --who "Freight companies" --pay 6400 \
        --phrase "chase late invoices" --source https://example.com/collections-pricing
    python3 problems.py add --problem "Scheduling field crews" --who "Landscapers" --pay 2900 \
        --estimate --basis "one office admin, half time, at the local median wage"
    python3 problems.py rank
    python3 problems.py pick --id chasing-late-invoices
"""

import argparse
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("whale_board", os.path.join(HERE, "board.py"))
B = importlib.util.module_from_spec(spec)
spec.loader.exec_module(B)

# Under this a month it is rarely worth a decision maker's time, or a founding price.
MIN_PAY = 1000


def add(data, problem, who, pay, source=None, estimate=False, basis=None, notes=None, phrase=None):
    if pay is None or pay <= 0:
        raise B.BoardError("Say what they pay today, per month. If nobody pays for it, it is not this kind of problem.")
    if not source and not (estimate and basis):
        raise B.BoardError("Where does %s/mo come from? Give --source, or --estimate with --basis showing the working." % B.short_money(pay))
    pid = B.slug(problem)
    return B.upsert(data["problems"], pid, {"problem": problem, "who": who, "pay_month": pay, "source": source,
                                            "estimate": bool(estimate), "basis": basis, "notes": notes, "phrase": phrase},
                    {"problem": problem, "who": who, "pay_month": pay, "source": None, "estimate": False, "basis": None,
                     "notes": None, "phrase": None, "picked": False})


def ranked(data):
    """Sourced before estimated, then biggest first."""
    return sorted(data["problems"], key=lambda p: (bool(p.get("estimate")), -(p.get("pay_month") or 0)))


def rank_text(data):
    rows = ranked(data)
    if not rows:
        return "No problems yet. Add them with: problems.py add"
    lines = ["%-36s %-24s %s" % ("Problem", "Who pays", "They pay today")]
    for p in rows:
        flags = []
        if p.get("picked"):
            flags.append("PICKED")
        if p.get("estimate"):
            flags.append("estimate: " + p["basis"])
        if (p.get("pay_month") or 0) < MIN_PAY:
            flags.append("under %s/mo, probably not a whale" % B.short_money(MIN_PAY))
        lines.append("%-36s %-24s %s/mo%s" % (p["problem"], p["who"], B.short_money(p["pay_month"]),
                                              "  [" + "; ".join(flags) + "]" if flags else ""))
    return "\n".join(lines)


def pick(data, problem_id):
    chosen = B.need(data["problems"], problem_id, "problem")
    for p in data["problems"]:
        p["picked"] = False
    chosen["picked"] = True
    return chosen


def main(argv=None):
    ap = argparse.ArgumentParser(description="Problems businesses already pay to solve.")
    ap.add_argument("--file", default=B.DEFAULT_FILE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("add")
    p.add_argument("--problem", required=True)
    p.add_argument("--who", required=True)
    p.add_argument("--pay", type=float, required=True)
    p.add_argument("--source")
    p.add_argument("--estimate", action="store_true")
    p.add_argument("--basis")
    p.add_argument("--notes")
    p.add_argument("--phrase", help="how it reads after 'pay about $X a month to ...', like 'chase late invoices'")
    sub.add_parser("rank")
    p = sub.add_parser("pick")
    p.add_argument("--id", required=True)
    args = ap.parse_args(B.file_first(argv))
    try:
        data = B.load(args.file)
        if args.cmd == "rank":
            print(rank_text(data))
            return 0
        if args.cmd == "add":
            row = add(data, args.problem, args.who, args.pay, args.source, args.estimate, args.basis, args.notes, args.phrase)
            print("Added %s" % row["id"])
        else:
            row = pick(data, args.id)
            print("Going after: %s (%s)" % (row["problem"], row["who"]))
        B.save(data, args.file)
        return 0
    except (B.BoardError, ValueError) as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
