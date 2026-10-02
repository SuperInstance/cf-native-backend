#!/usr/bin/env python3
"""quiltgen.py — mint a local quilt: typed cells wired by edges.

B3.1 of the quilt-as-git contest build (see docs/B3-DESIGN.md §2.1 + §2.5).
A quilt IS a directory whose memory is a set of fnv1a-64 receipt chains:

    cells/<type>/<name>/cell.json      manifest: id, type, opcodes, count, tip
                                       (+ scheme/basis so the chain is
                                        verifiable without extra files)
    cells/<type>/<name>/receipts.txt   per-cell fnv1a-64 op chain (B1 scheme v1)
    cells/<type>/<name>/body/…         typed payload (content; content hashing
                                       is B3.2's tree-diff, not B3.1)
    quilt.json                         routing STATE: sorted canonical edge set
    routing.txt                        routing LEDGER: fnv1a-64 chain of
                                       ROUTE_ADD ops (one per declared edge)

Hash scheme is the B1/B2 source of truth — DO NOT invent a new scheme
(lattice/hello-cell/cellgen.py, worker/src/chain.ts, frozen-clock-lab @poc):
    receipt_i = fnv1a64(prev_head + "|" + canonical(op))
    genesis   = "%016x" % FNV64_OFFSET     (the empty-string basis)
    canonical = str(op).replace("\n", "\\n")   (single line, unambiguous)
Receipts are stored one per line as: "<receipt> <op>"

Deterministic: same --seed ⇒ byte-identical quilt. Ops per cell are drawn
from the cell's own opcode vocabulary (3–20 ops each).

Usage:
    quiltgen.py --out DIR [--seed N] [--no-git]     mint a quilt
    quiltgen.py --verify DIR                        re-walk + report (JSON)
"""
import argparse
import json
import os
import random
import subprocess
import sys

FNV64_OFFSET = 0xcbf29ce484222325
FNV64_PRIME = 0x100000001b3
MASK64 = 0xFFFFFFFFFFFFFFFF
SCHEME = "fnv1a-64-chain-v1"
BASIS = "%016x" % FNV64_OFFSET
QUILT_NAME = "hello-quilt"

# --- the quilt's cells (B3-DESIGN §2.5 demo quilt) --------------------------
# address = <type>/<name>; opcodes = the op verbs this cell's receipts use.
CELL_SPECS = [
    {
        "type": "data", "name": "gps",
        "opcodes": ["FIX", "SMOOTH", "PUB"],
        "body": ("# data/gps\n\n"
                 "Nav fix source. Publishes smoothed lat/lon fixes on "
                 "`nav.fix`.\n"),
    },
    {
        "type": "data", "name": "compass",
        "opcodes": ["CAL", "HEADING", "PUB"],
        "body": ("# data/compass\n\n"
                 "Magnetic heading source. Publishes declination-corrected "
                 "heading on `nav.heading`.\n"),
    },
    {
        "type": "logic", "name": "planner",
        "opcodes": ["BIND", "PLAN", "RULE", "PUB"],
        "body": ("# logic/planner\n\n"
                 "Binds nav inputs to a waypoint plan; publishes `nav.plan` "
                 "and drives the rudder.\n"),
    },
    {
        "type": "gpio", "name": "rudder",
        "opcodes": ["SET", "LIMIT", "ZERO", "PUB"],
        "body": ("# gpio/rudder\n\n"
                 "Rudder actuator. Applies bounded pwm to the servo; "
                 "publishes `ctl.rudder`.\n"),
    },
]

# --- the quilt's edges (B3-DESIGN §2.2): a few qm_bind/qm_effect wires ------
EDGES = [
    ("data/compass", "qm_bind", "logic/planner"),
    ("data/gps", "qm_bind", "logic/planner"),
    ("logic/planner", "qm_effect", "gpio/rudder"),
    ("logic/planner", "qm_view", "data/gps"),
]


def fnv1a64(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    h = FNV64_OFFSET
    for b in data:
        h ^= b
        h = (h * FNV64_PRIME) & MASK64
    return h


def canonical(op):
    return str(op).replace("\n", "\\n")


def hex16(h):
    return "%016x" % h


def mint_chain(ops, basis=BASIS):
    """Return (receipt_lines, tip) for an op list, anchored at `basis`."""
    head = basis
    lines = []
    for op in ops:
        op = canonical(op)
        head = hex16(fnv1a64(head + "|" + op))
        lines.append(f"{head} {op}")
    return lines, head


def make_op(opcode, rng):
    """One realistic op for a cell's opcode vocabulary (deterministic)."""
    if opcode == "FIX":
        return (f"FIX lat={rng.uniform(-90, 90):.6f} "
                f"lon={rng.uniform(-180, 180):.6f} "
                f"hdop={rng.uniform(0.6, 3.0):.2f}")
    if opcode == "SMOOTH":
        return f"SMOOTH alpha={rng.uniform(0.05, 0.60):.2f} window={rng.randint(2, 9)}"
    if opcode == "PUB":
        return f"PUB topic=nav.fix seq={rng.randint(1, 9999)}"
    if opcode == "CAL":
        return (f"CAL mag={rng.uniform(0.1, 1.9):.3f} "
                f"decl={rng.uniform(-20, 20):.2f}")
    if opcode == "HEADING":
        return f"HEADING deg={rng.uniform(0, 359.9):.1f} src=mag"
    if opcode == "BIND":
        return "BIND input=data.gps -> planner.fix"
    if opcode == "PLAN":
        return (f"PLAN wp={rng.randint(1, 12)} "
                f"speed={rng.uniform(0.2, 2.5):.2f} "
                f"hdg={rng.uniform(0, 359):.0f}")
    if opcode == "RULE":
        return f"RULE name=hold-course when hdop<{rng.uniform(1.0, 2.5):.2f}"
    if opcode == "SET":
        return f"SET pwm={rng.randint(1100, 1900)}"
    if opcode == "LIMIT":
        return f"LIMIT max_deg={rng.uniform(15, 40):.1f}"
    if opcode == "ZERO":
        return f"ZERO id={rng.randint(1, 9)}"
    raise SystemExit(f"quiltgen: no op template for opcode {opcode!r}")


def cell_ops(spec, seed):
    """Deterministic op list (3–20) for one cell, seeded per address."""
    addr = f"{spec['type']}/{spec['name']}"
    rng = random.Random(f"{seed}:{addr}")
    n = rng.randint(3, 20)
    return [make_op(spec["opcodes"][i % len(spec["opcodes"])], rng)
            for i in range(n)]


def edge_line(frm, op, to):
    return f"edge {frm} {op} {to}"


def canonical_edges():
    """Sorted, de-duplicated canonical edge lines (the routing STATE)."""
    return sorted({edge_line(f, o, t) for (f, o, t) in EDGES})


def route_add_op(line):
    return "ROUTE_ADD " + line[len("edge "):]


# ---------------------------------------------------------------------------
def mint(out, seed, do_git):
    if os.path.exists(out) and os.listdir(out):
        sys.exit(f"quiltgen: {out} exists and is not empty")
    os.makedirs(out, exist_ok=True)

    written = []
    for spec in CELL_SPECS:
        addr = f"{spec['type']}/{spec['name']}"
        cdir = os.path.join(out, "cells", spec["type"], spec["name"])
        os.makedirs(os.path.join(cdir, "body"), exist_ok=True)

        ops = cell_ops(spec, seed)
        lines, tip = mint_chain(ops)
        with open(os.path.join(cdir, "receipts.txt"), "w") as f:
            f.write("".join(l + "\n" for l in lines))
        with open(os.path.join(cdir, "body", f"{spec['name']}.md"), "w") as f:
            f.write(spec["body"])
        manifest = {
            "scheme": SCHEME,
            "basis": BASIS,
            "id": addr,
            "type": spec["type"],
            "name": spec["name"],
            "opcodes": spec["opcodes"],
            "count": len(ops),
            "tip": tip,
        }
        with open(os.path.join(cdir, "cell.json"), "w") as f:
            json.dump(manifest, f, indent=2)
            f.write("\n")
        written.append((addr, len(ops), tip))

    # routing LEDGER (routing.txt): one ROUTE_ADD per declared edge, in the
    # canonical (sorted) edge order.
    edges = canonical_edges()
    rlines, rtip = mint_chain([route_add_op(e) for e in edges])
    with open(os.path.join(out, "routing.txt"), "w") as f:
        f.write("".join(l + "\n" for l in rlines))

    quilt = {
        "quilt": QUILT_NAME,
        "scheme": SCHEME,
        "basis": BASIS,
        "cells": sorted(f"{s['type']}/{s['name']}" for s in CELL_SPECS),
        "edges": edges,
        "routing": {"scheme": SCHEME, "basis": BASIS,
                    "count": len(edges), "tip": rtip},
    }
    with open(os.path.join(out, "quilt.json"), "w") as f:
        json.dump(quilt, f, indent=2)
        f.write("\n")

    if do_git:
        subprocess.run(["git", "init", "-q", out], check=True)
        cfg = subprocess.run(["git", "-C", out, "config", "user.email"],
                             capture_output=True, text=True)
        if cfg.returncode != 0 or not cfg.stdout.strip():
            subprocess.run(["git", "-C", out, "config", "user.email",
                            "clerk@superinstance.local"], check=True)
            subprocess.run(["git", "-C", out, "config", "user.name", "Clerk"],
                           check=True)
        subprocess.run(["git", "-C", out, "add", "-A"], check=True)
        subprocess.run(["git", "-C", out, "commit", "-qm",
                        f"quilt genesis: {len(CELL_SPECS)} cells, routing tip {rtip}"],
                       check=True)

    print(f"quilt: {out}")
    print(f"name: {QUILT_NAME}")
    print(f"scheme: {SCHEME} (B1 source of truth)")
    print(f"basis: {BASIS}")
    for addr, n, tip in written:
        print(f"cell {addr}: count={n} tip={tip}")
    print(f"edges: {len(edges)}")
    for e in edges:
        print(f"  {e}")
    print(f"routing: count={len(edges)} tip={rtip}")
    print(f"quilt.json tip: {quilt['routing']['tip']}")


# ---------------------------------------------------------------------------
def read_chain_text(path):
    with open(path) as f:
        return f.read()


def tip_of(receipts_text, basis):
    """Re-walk a receipts.txt from the basis; return (tip, count, ok)."""
    h = basis
    n = 0
    for line in receipts_text.splitlines():
        if not line:
            continue
        sp = line.find(" ")
        if sp < 0:
            return h, n, False
        rec, op = line[:sp], line[sp + 1:]
        if hex16(fnv1a64(h + "|" + canonical(op))) != rec:
            return h, n, False
        h = rec
        n += 1
    return h, n, True


def verify(d):
    quilt = json.load(open(os.path.join(d, "quilt.json")))
    basis = quilt.get("basis", BASIS)
    cells = {}
    all_ok = True
    for addr in quilt.get("cells", []):
        cdir = os.path.join(d, "cells", *addr.split("/"))
        man = json.load(open(os.path.join(cdir, "cell.json")))
        txt = read_chain_text(os.path.join(cdir, "receipts.txt"))
        tip, count, chain_ok = tip_of(txt, man.get("basis", basis))
        man_ok = (man.get("id") == addr and man.get("scheme") == SCHEME
                  and isinstance(man.get("tip"), str)
                  and isinstance(man.get("count"), int)
                  and man.get("tip") == tip and man.get("count") == count)
        ok = chain_ok and man_ok
        all_ok = all_ok and ok
        cells[addr] = {"tip": tip, "count": count, "ok": ok,
                       "chain_ok": chain_ok,
                       "manifest_tip": man.get("tip"), "manifest_ok": man_ok}

    rt = read_chain_text(os.path.join(d, "routing.txt"))
    ranchor = quilt.get("routing", {})
    rtip, rcount, rchain_ok = tip_of(rt, ranchor.get("basis", basis))
    rman_ok = (ranchor.get("tip") == rtip and ranchor.get("count") == rcount)
    routing_ok = rchain_ok and rman_ok
    all_ok = all_ok and routing_ok

    # edge set must equal the set derived from the ledger's ROUTE_ADD ops
    ledger_edges = set()
    for line in rt.splitlines():
        if not line:
            continue
        sp = line.find(" ")
        op = line[sp + 1:] if sp >= 0 else ""
        toks = op.split(" ")
        if len(toks) == 4 and toks[0] == "ROUTE_ADD":
            ledger_edges.add(edge_line(toks[1], toks[2], toks[3]))
    declared = set(quilt.get("edges", []))
    edge_set_ok = ledger_edges == declared
    all_ok = all_ok and edge_set_ok

    out = {
        "ok": all_ok,
        "quilt": quilt.get("quilt"),
        "scheme": quilt.get("scheme"),
        "basis": basis,
        "cells": cells,
        "routing": {"tip": rtip, "count": rcount, "ok": routing_ok,
                    "chain_ok": rchain_ok,
                    "manifest_tip": ranchor.get("tip"),
                    "manifest_ok": rman_ok},
        "edges": sorted(declared),
        "edge_set_ok": edge_set_ok,
    }
    print(json.dumps(out, indent=2))
    return 0 if all_ok else 1


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="mint / verify a local quilt (B3.1)")
    ap.add_argument("--out", help="output quilt dir (created)")
    ap.add_argument("--seed", type=int, default=20261001,
                    help="synthetic op seed (deterministic quilt)")
    ap.add_argument("--no-git", action="store_true", help="skip git init/commit")
    ap.add_argument("--verify", metavar="DIR",
                    help="re-walk an existing quilt and report JSON")
    args = ap.parse_args()

    if args.verify:
        sys.exit(verify(os.path.abspath(args.verify)))
    if not args.out:
        ap.error("--out is required unless --verify is used")
    mint(os.path.abspath(args.out), args.seed, not args.no_git)


if __name__ == "__main__":
    main()
