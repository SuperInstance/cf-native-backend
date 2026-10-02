#!/usr/bin/env python3
"""cellgen.py — generate a scratch lattice cell.

A cell IS: a git repo whose memory is an append-only fnv1a-64 receipt chain
(genesis anchor at the FNV basis, one receipt per position) and whose working
tree is a cache. This generator writes synthetic positions so wake physics can
be measured without a real workload.

Hash scheme is the fleet-proven one from SuperInstance/frozen-clock-lab @poc
lab/chain.py — DO NOT invent a new scheme:
    receipt_i = fnv1a64(prev_head + "|" + canonical(op))
    genesis   = "%016x" % FNV64_OFFSET        (the empty-string basis)
    canonical = str(op).replace("\n", "\\n")   (single line, unambiguous)
Receipts are stored one per line as: "<receipt> <op>"
"""
import argparse
import json
import os
import subprocess
import sys

FNV64_OFFSET = 0xcbf29ce484222325
FNV64_PRIME = 0x100000001b3
MASK64 = 0xFFFFFFFFFFFFFFFF
SCHEME = "fnv1a-64-chain-v1"


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


def main():
    ap = argparse.ArgumentParser(description="generate a scratch lattice cell")
    ap.add_argument("--n", type=int, default=1000,
                    help="positions to mint (1k/10k/100k/1M supported)")
    ap.add_argument("--seed", type=int, default=42, help="synthetic op seed")
    ap.add_argument("--out", default="./cell", help="output dir (created)")
    ap.add_argument("--no-git", action="store_true", help="skip git init/commit")
    args = ap.parse_args()

    if args.n < 1:
        sys.exit("cellgen: --n must be >= 1")
    out = os.path.abspath(args.out)
    if os.path.exists(out) and os.listdir(out):
        sys.exit(f"cellgen: {out} exists and is not empty")
    os.makedirs(out, exist_ok=True)

    basis = "%016x" % FNV64_OFFSET
    head = basis
    receipts = os.path.join(out, "receipts.txt")
    with open(receipts, "w") as f:
        for i in range(args.n):
            op = canonical(f"syn i={i} s={args.seed}")
            head = "%016x" % fnv1a64(head + "|" + op)
            f.write(f"{head} {op}\n")

    genesis = {
        "scheme": SCHEME,
        "basis": basis,
        "count": args.n,
        "tip": head,
        "seed": args.seed,
        "note": "memory = receipt chain; working tree = cache",
    }
    with open(os.path.join(out, "genesis.json"), "w") as f:
        json.dump(genesis, f, indent=2)
        f.write("\n")

    if not args.no_git:
        subprocess.run(["git", "init", "-q", out], check=True)
        cfg = subprocess.run(
            ["git", "-C", out, "config", "user.email"],
            capture_output=True, text=True)
        if cfg.returncode != 0 or not cfg.stdout.strip():
            subprocess.run(["git", "-C", out, "config", "user.email", "clerk@superinstance.local"], check=True)
            subprocess.run(["git", "-C", out, "config", "user.name", "Clerk"], check=True)
        # let local wakes exercise the blobless path (native on git remotes)
        subprocess.run(["git", "-C", out, "config", "uploadpack.allowFilter", "true"], check=True)
        subprocess.run(["git", "-C", out, "add", "-A"], check=True)
        subprocess.run(["git", "-C", out, "commit", "-qm",
                        f"genesis: {args.n} positions, tip {head}"], check=True)

    print(f"cell: {out}")
    print(f"scheme: {SCHEME} (frozen-clock-lab @poc)")
    print(f"positions: {args.n}")
    print(f"basis: {basis}")
    print(f"tip: {head}")


if __name__ == "__main__":
    main()
