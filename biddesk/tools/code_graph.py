"""Build a code graph of this project: python tools/code_graph.py
Writes graphify-out/graph.json, graph.html (self-contained viewer) and GRAPH_REPORT.md."""
from __future__ import annotations

import ast
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "graphify-out"
FILES = sorted(p for p in ROOT.rglob("*.py") if not {"tests", "tools", ".venv", "graphify-out"} & set(p.relative_to(ROOT).parts))


def modname(p: Path) -> str:
    parts = list(p.relative_to(ROOT).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


nodes: dict[str, dict] = {}
edges: set[tuple[str, str, str]] = set()
trees = {modname(p): (p, ast.parse(p.read_text())) for p in FILES if p.read_text().strip()}


def add(id_, kind, module, path, line, doc=""):
    nodes[id_] = {"id": id_, "label": id_.split(".")[-1] if kind != "module" else id_, "kind": kind,
                  "module": module, "file": str(path.relative_to(ROOT)), "line": line,
                  "doc": (doc or "").strip().split("\n")[0][:160]}


# pass 1: definitions
for mod, (path, tree) in trees.items():
    add(mod, "module", mod, path, 1, ast.get_docstring(tree))
    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            add(f"{mod}.{n.name}", "function", mod, path, n.lineno, ast.get_docstring(n))
            edges.add((mod, f"{mod}.{n.name}", "contains"))
        elif isinstance(n, ast.ClassDef):
            cid = f"{mod}.{n.name}"
            add(cid, "class", mod, path, n.lineno, ast.get_docstring(n))
            edges.add((mod, cid, "contains"))
            for m in n.body:
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    add(f"{cid}.{m.name}", "function", mod, path, m.lineno, ast.get_docstring(m))
                    edges.add((cid, f"{cid}.{m.name}", "contains"))


def resolve_import(mod: str, node: ast.ImportFrom) -> str:
    base = mod.split(".")
    is_pkg = trees[mod][0].name == "__init__.py"
    if node.level:
        base = base[: len(base) - node.level + (1 if is_pkg else 0)]
        return ".".join(base + ([node.module] if node.module else []))
    return node.module or ""


# pass 2: imports and calls
for mod, (path, tree) in trees.items():
    alias: dict[str, str] = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom):
            src = resolve_import(mod, n)
            for a in n.names:
                target = f"{src}.{a.name}" if src else a.name
                if target in nodes:
                    alias[a.asname or a.name] = target
                    edges.add((mod, target if nodes[target]["kind"] == "module" else nodes[target]["module"], "imports"))
        elif isinstance(n, ast.Import):
            for a in n.names:
                if a.name in nodes:
                    alias[a.asname or a.name] = a.name
                    edges.add((mod, a.name, "imports"))

    def scan(owner: str, body, cls: str | None):
        for n in ast.walk(body):
            if not isinstance(n, ast.Call):
                continue
            f, target = n.func, None
            if isinstance(f, ast.Name):
                target = alias.get(f.id) or (f"{mod}.{f.id}" if f"{mod}.{f.id}" in nodes else None)
            elif isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name):
                if f.value.id == "self" and cls and f"{cls}.{f.attr}" in nodes:
                    target = f"{cls}.{f.attr}"
                elif f.value.id in alias and f"{alias[f.value.id]}.{f.attr}" in nodes:
                    target = f"{alias[f.value.id]}.{f.attr}"
            if target and target != owner and nodes[target]["kind"] != "module":
                edges.add((owner, target, "calls"))

    for n in tree.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            scan(f"{mod}.{n.name}", n, None)
        elif isinstance(n, ast.ClassDef):
            for m in n.body:
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    scan(f"{mod}.{n.name}.{m.name}", m, f"{mod}.{n.name}")
        else:
            scan(mod, n, None)  # top-level script code (run_daily, app)

edges = {e for e in edges if e[0] != e[1]}
deg = Counter()
for s, t, k in edges:
    if k != "contains":
        deg[s] += 1
        deg[t] += 1
for n in nodes.values():
    n["degree"] = deg[n["id"]]

graph = {"nodes": list(nodes.values()), "edges": [{"source": s, "target": t, "kind": k} for s, t, k in sorted(edges)]}
OUT.mkdir(exist_ok=True)
(OUT / "graph.json").write_text(json.dumps(graph, indent=1))
(OUT / "graph.html").write_text((Path(__file__).parent / "graph_template.html").read_text().replace("/*GRAPH*/null", json.dumps(graph)))

# report
calls_in, calls_out = Counter(), Counter()
mod_links = defaultdict(set)
for s, t, k in edges:
    if k == "calls":
        calls_in[t] += 1
        calls_out[s] += 1
    if k in ("calls", "imports") and nodes[s]["module"] != nodes[t]["module"]:
        mod_links[nodes[s]["module"]].add(nodes[t]["module"])
kinds = Counter(n["kind"] for n in nodes.values())
ek = Counter(k for _, _, k in edges)
L = ["# Bid Desk code graph", "",
     f"{kinds['module']} modules, {kinds['class']} classes, {kinds['function']} functions. "
     f"{ek['calls']} call links, {ek['imports']} import links.", "",
     "Built from the Python syntax tree only. Calls made through objects (database rows, the Anthropic "
     "client, dynamically imported scrapers) are not resolved, so real coupling is somewhat higher.", "",
     "## Most depended-on functions (called from the most places)", ""]
L += [f"- `{i}` - {c} callers ({nodes[i]['file']}:{nodes[i]['line']})" for i, c in calls_in.most_common(10)]
L += ["", "## Functions that orchestrate the most (call the most others)", ""]
L += [f"- `{i}` - calls {c} ({nodes[i]['file']}:{nodes[i]['line']})" for i, c in calls_out.most_common(8)]
L += ["", "## Module dependencies", ""]
L += [f"- `{m}` -> " + ", ".join(f"`{x}`" for x in sorted(v)) for m, v in sorted(mod_links.items())]
unused = sorted(i for i, n in nodes.items() if n["kind"] == "function" and not calls_in[i] and "." in i
                and not n["label"].startswith("_") and n["module"] not in ("app", "run_daily"))
L += ["", "## Functions with no resolved caller", "",
      "Entry points, scraper `scrape`/`parse` functions loaded by name, methods called on objects, or unused code.", ""]
L += [f"- `{i}`" for i in unused]
(OUT / "GRAPH_REPORT.md").write_text("\n".join(L) + "\n")
print(f"{len(nodes)} nodes, {len(edges)} edges -> {OUT}")
