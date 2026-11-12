#!/usr/bin/env python3
"""Builds a clickable demo of your product solving the problem. Standard library only.

Turns a small JSON spec into one HTML file that runs anywhere with no server and no network:
a list of sample records, one button, and every row moving through its statuses while a total
counts up. A banner on every view says it is a demo with sample data. It cannot be removed from
the spec, because a demo that looks like a shipped product is a false promise.

  check   checks a spec
  build   writes the demo

    python3 demo.py check --spec demo-builder/demo.example.json
    python3 demo.py build --spec demo-builder/demo.example.json --out whale/demo/index.html
"""

import argparse
import html
import json
import os
import re
import sys

BANNER = "Demo with sample data. This shows how it will work, not a finished product."
AMOUNT_RE = re.compile(r"^\$[\d,]+(\.\d{2})?$")


class DemoError(Exception):
    pass


def load_spec(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def amount_value(text):
    return float(text.replace("$", "").replace(",", ""))


def check(spec):
    """Returns a list of problems. An empty list means it can be built."""
    problems = []
    for key in ("title", "subtitle", "button", "total_label"):
        if not spec.get(key):
            problems.append("spec needs %s" % key)
    if spec.get("sample_data") is not True:
        problems.append("set sample_data to true: a demo never shows a real customer's records")
    rows = spec.get("rows") or []
    if not 3 <= len(rows) <= 12:
        problems.append("use 3 to 12 rows so the whole list fits on one screen (got %d)" % len(rows))
    for i, row in enumerate(rows):
        if not row.get("name"):
            problems.append("row %d needs a name" % (i + 1))
        if not AMOUNT_RE.match(row.get("amount") or ""):
            problems.append("row %d amount %r must look like $1,234.00" % (i + 1, row.get("amount")))
    if spec.get("accent") and not re.match(r"^#[0-9a-fA-F]{6}$", spec["accent"]):
        problems.append("accent must be a color like #D97757")
    statuses = spec.get("statuses") or []
    if not 1 <= len(statuses) <= 4:
        problems.append("use 1 to 4 statuses, in the order each row moves through them")
    return problems


def total(spec):
    return sum(amount_value(r["amount"]) for r in spec["rows"])


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} demo</title>
<style>
:root {{ --ink:#1a1a18; --soft:#6b6a65; --line:#e6e4dd; --bg:#faf9f5; --accent:{accent}; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--ink); font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }}
.banner {{ background:#fff4d6; border-bottom:1px solid #ecd9a0; padding:10px 16px; text-align:center; font-size:14px; }}
main {{ max-width:760px; margin:0 auto; padding:24px 16px 48px; }}
header {{ display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:20px; }}
.mark {{ width:40px; height:40px; border-radius:10px; background:var(--accent); color:#fff; display:grid; place-items:center; font-weight:700; }}
h1 {{ font-size:20px; margin:0; }} .sub {{ color:var(--soft); font-size:14px; }}
button {{ margin-left:auto; background:var(--accent); color:#fff; border:0; border-radius:8px; padding:10px 18px; font:inherit; font-weight:600; cursor:pointer; }}
button:disabled {{ opacity:.55; cursor:default; }}
table {{ width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; }}
td {{ padding:12px 14px; border-top:1px solid var(--line); }} tr:first-child td {{ border-top:0; }}
td.amount {{ text-align:right; font-variant-numeric:tabular-nums; }} td.note {{ color:var(--soft); font-size:14px; }}
td.status {{ text-align:right; font-size:14px; color:var(--soft); min-width:120px; }} td.status.done {{ color:#0a7d4f; font-weight:600; }}
.total {{ margin-top:16px; display:flex; justify-content:space-between; font-size:18px; font-weight:600; }}
.total span:last-child {{ font-variant-numeric:tabular-nums; }}
@media (max-width:560px) {{ td.note {{ display:none; }} button {{ margin-left:0; width:100%; }} }}
</style>
</head>
<body>
<div class="banner" role="note">{banner}</div>
<main>
<header>
<div class="mark" aria-hidden="true">{letter}</div>
<div><h1>{title}</h1><div class="sub">{subtitle}</div></div>
<button id="go" type="button">{button}</button>
</header>
<table><tbody id="rows">{rows}</tbody></table>
<div class="total"><span>{total_label}</span><span id="total">$0.00</span></div>
</main>
<script>
var AMOUNTS = {amounts}, STATUSES = {statuses};
var rows = document.querySelectorAll("#rows tr"), tot = document.getElementById("total"), go = document.getElementById("go");
function fmt(n) {{ return "$" + n.toLocaleString("en-US", {{minimumFractionDigits:2, maximumFractionDigits:2}}); }}
go.addEventListener("click", function () {{
  go.disabled = true;
  var sum = 0;
  Array.prototype.forEach.call(rows, function (row, i) {{
    var cell = row.querySelector(".status");
    STATUSES.forEach(function (status, s) {{
      setTimeout(function () {{
        cell.textContent = status;
        if (s === STATUSES.length - 1) {{ cell.classList.add("done"); sum += AMOUNTS[i]; tot.textContent = fmt(sum); }}
      }}, 350 * i + 700 * s + 200);
    }});
  }});
}});
</script>
</body>
</html>
"""


def build(spec):
    problems = check(spec)
    if problems:
        raise DemoError("The spec is not ready:\n  " + "\n  ".join(problems))
    e = lambda s: html.escape(str(s), quote=True)
    rows = "".join('<tr><td>%s</td><td class="note">%s</td><td class="amount">%s</td><td class="status"></td></tr>'
                   % (e(r["name"]), e(r.get("note") or ""), e(r["amount"])) for r in spec["rows"])
    # json.dumps inside a <script>: nothing in a string may open or close a tag
    js = lambda v: json.dumps(v).replace("<", "\\u003c")
    return PAGE.format(title=e(spec["title"]), subtitle=e(spec["subtitle"]), button=e(spec["button"]), total_label=e(spec["total_label"]),
                       banner=e(BANNER), letter=e(spec["title"][0].upper()), accent=e(spec.get("accent") or "#D97757"), rows=rows,
                       amounts=js([amount_value(r["amount"]) for r in spec["rows"]]), statuses=js(spec["statuses"]))


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build a clickable demo from a spec.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("check")
    p.add_argument("--spec", required=True)
    p = sub.add_parser("build")
    p.add_argument("--spec", required=True)
    p.add_argument("--out", default=os.path.join("whale", "demo", "index.html"))
    args = ap.parse_args(argv)
    try:
        spec = load_spec(args.spec)
        if args.cmd == "check":
            problems = check(spec)
            for line in problems:
                print(line)
            print("OK: %d rows, total %s" % (len(spec["rows"]), "${:,.2f}".format(total(spec))) if not problems else "%d problem(s)" % len(problems))
            return 1 if problems else 0
        page = build(spec)
        folder = os.path.dirname(args.out)
        if folder:
            os.makedirs(folder, exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(page)
        print("Wrote %s" % args.out)
        return 0
    except (DemoError, OSError, ValueError) as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
