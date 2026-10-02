#!/bin/sh
# wake.sh — cold-start a lattice cell.
#   memory       = receipt chain (receipts.txt + genesis.json)
#   working tree = cache (may be fat; wake must not need it)
#
# Path: blobless sparse clone -> verify receipt chain -> replay genesis->tip
#       -> print wall time + positions/sec.
# Runs clean under sh with only git + python3. Exits nonzero on chain break
# or tip mismatch.
set -eu

[ $# -ge 1 ] || { echo "usage: wake.sh <cell-repo-path-or-url>" >&2; exit 2; }
SRC=$1
WORK=$(mktemp -d "${TMPDIR:-/tmp}/wake.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

T0=$(python3 -c 'import time; print(time.perf_counter())')

# 1. blobless sparse clone. blob:none is honored by git-native remotes; the
#    local transport may ignore it (see README limits) — the clone still works.
if ! git clone --quiet --filter=blob:none --sparse "$SRC" "$WORK/cell" 2>"$WORK/clone.err"; then
    git clone --quiet "$SRC" "$WORK/cell"
fi
cd "$WORK/cell"

# restrict the working tree to memory files; a cell may carry fat cached blobs
git sparse-checkout set --no-cone /receipts.txt /genesis.json >/dev/null 2>&1 || true
# guarantee memory files exist regardless of sparse/filter transport quirks
[ -f receipts.txt ] || git checkout HEAD -- receipts.txt
[ -f genesis.json ] || git show HEAD:genesis.json > genesis.json

T1=$(python3 -c 'import time; print(time.perf_counter())')

# 2+3. verify chain and replay genesis->tip (timed)
python3 - <<'PY'
import json, sys, time

t0 = time.perf_counter()

FNV64_OFFSET = 0xcbf29ce484222325
FNV64_PRIME  = 0x100000001b3
MASK64 = 0xFFFFFFFFFFFFFFFF

def fnv1a64(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    h = FNV64_OFFSET
    for b in data:
        h ^= b
        h = (h * FNV64_PRIME) & MASK64
    return h

gen = json.load(open("genesis.json"))
h = gen.get("basis") or ("%016x" % FNV64_OFFSET)
n = 0
bad = None
with open("receipts.txt") as f:
    for line in f:
        line = line.rstrip("\n")
        if not line:
            continue
        rec, op = line.split(" ", 1)
        want = "%016x" % fnv1a64(h + "|" + op)
        if want != rec:
            bad = n
            break
        h = rec
        n += 1

dt = time.perf_counter() - t0
tip = gen.get("tip")
chain_ok = bad is None
tip_match = (tip is None) or (tip == h)
count_match = n == gen.get("count", n)

print("positions=%d" % n)
print("tip=%s" % h)
print("expected_tip=%s" % tip)
print("chain_ok=%s" % chain_ok)
if bad is not None:
    print("first_break_at=%d" % bad)
print("tip_match=%s" % tip_match)
print("count_match=%s" % count_match)
print("verify_replay_wall_s=%.4f" % dt)
print("positions_per_sec=%.1f" % (n / dt if dt > 0 else float("inf")))

sys.exit(0 if (chain_ok and tip_match and count_match) else 1)
PY

T2=$(python3 -c 'import time; print(time.perf_counter())')
python3 -c "print('clone_wall_s=%.4f' % ($T1 - $T0)); print('total_wake_wall_s=%.4f' % ($T2 - $T0))"
