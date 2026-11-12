#!/usr/bin/env python3
"""Turns the first customer into proof, with their permission. Standard library only.

A case study is a claim about a real company, so nothing goes in that they did not say or give
you, and it stays marked DRAFT until they have approved that exact text in writing. It only
starts once the product has shipped: proof comes after delivery, never before.

  draft    writes whale/case-studies/<deal>.md
  approve  logs the customer's written approval of the exact text
  check    what is missing before it can be used

    python3 casestudy.py draft --deal north-pier --before "Paid $6,400 a month to chase invoices" \
        --after "Paid invoices up 31% in 60 days" --source "North Pier's AR report, Jan 2027" \
        --quote "We stopped thinking about late invoices." --quote-by "Renee Alvarez, CFO"
    python3 casestudy.py approve --deal north-pier --said "Approved, go ahead." --at 2027-02-10
    python3 casestudy.py check --deal north-pier
"""

import argparse
import hashlib
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join("whale", "case-studies")


def _board():
    path = os.path.join(HERE, "..", "market-researcher", "board.py")
    if not os.path.exists(path):
        sys.exit("The case-study skill needs the market-researcher skill next to it (../market-researcher/board.py).")
    spec = importlib.util.spec_from_file_location("whale_board", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


B = _board()


def study_for(data, deal_id):
    return next((s for s in data["case_studies"] if s["deal_id"] == deal_id), None)


def text_of(data, study):
    deal = B.need(data["deals"], study["deal_id"], "deal")
    company = B.need(data["companies"], deal["company_id"], "company")
    me = data.get("me", {})
    lines = ["# %s and %s" % (company["name"], me.get("product") or "[fill: product]"), "",
             "**Before:** %s" % study["before"], "", "**After:** %s" % study["after"], ""]
    if study.get("quote"):
        lines += ["> \"%s\"" % study["quote"], "> %s" % study.get("quote_by"), ""]
    lines.append("Numbers from: %s" % study["source"])
    return "\n".join(lines) + "\n"


def fingerprint(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def draft(data, deal_id, before, after, source, quote=None, quote_by=None):
    deal = B.need(data["deals"], deal_id, "deal")
    if deal.get("stage") != "delivered":
        raise B.BoardError("%s is at %s. Proof comes after delivery: nothing to write up yet." % (deal_id, deal.get("stage")))
    if not (before and after and source):
        raise B.BoardError("A case study needs before, after and where the numbers came from.")
    if quote and not quote_by:
        raise B.BoardError("A quote needs the name of the person who really said it.")
    study = study_for(data, deal_id)
    if study is None:
        study = {"id": B.next_id(data["case_studies"], "s"), "deal_id": deal_id}
        data["case_studies"].append(study)
    # A changed draft needs a new approval: they approved the words, not the idea.
    study.update(before=before, after=after, source=source, quote=quote, quote_by=quote_by, approval=None, approved_text=None)
    return study


def approve(data, deal_id, said, when):
    study = study_for(data, deal_id)
    if study is None:
        raise B.BoardError("No draft for %s yet." % deal_id)
    if not (said or "").strip() or B.NO_RE.search(said):
        raise B.BoardError("That is not an approval. It stays a draft.")
    study["approval"] = {"said": said, "at": when}
    study["approved_text"] = fingerprint(text_of(data, study))
    return study


def write_file(path, text):
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def problems(data, deal_id):
    study = study_for(data, deal_id)
    if study is None:
        return ["no draft yet"]
    out = []
    if not study.get("approval"):
        out.append("not approved by the customer in writing")
    elif study.get("approved_text") != fingerprint(text_of(data, study)):
        out.append("the text changed after they approved it: ask again")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="The first customer, as proof.")
    ap.add_argument("--file", default=B.DEFAULT_FILE)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("draft")
    p.add_argument("--deal", required=True)
    p.add_argument("--before", required=True)
    p.add_argument("--after", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--quote")
    p.add_argument("--quote-by")
    p.add_argument("--out")
    p = sub.add_parser("approve")
    p.add_argument("--deal", required=True)
    p.add_argument("--said", required=True)
    p.add_argument("--at", required=True)
    p = sub.add_parser("check")
    p.add_argument("--deal", required=True)
    args = ap.parse_args(B.file_first(argv))
    try:
        data = B.load(args.file)
        if args.cmd == "check":
            found = problems(data, args.deal)
            for line in found:
                print(line)
            print("OK to use." if not found else "Not ready: stays a draft.")
            return 1 if found else 0
        if args.cmd == "approve":
            study = approve(data, args.deal, args.said, args.at)
            B.save(data, args.file)
            write_file(os.path.join(OUT_DIR, args.deal + ".md"), text_of(data, study))
            print("Approved, for this exact text.")
            return 0
        study = draft(data, args.deal, args.before, args.after, args.source, args.quote, args.quote_by)
        B.save(data, args.file)
        text = "DRAFT: not approved by the customer. Do not publish.\n\n" + text_of(data, study)
        out = args.out or os.path.join(OUT_DIR, args.deal + ".md")
        write_file(out, text)
        print(text, end="")
        print("\nWrote %s" % out)
        return 0
    except (B.BoardError, OSError, ValueError) as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
