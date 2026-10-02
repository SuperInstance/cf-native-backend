#!/bin/sh
# pins-hello.sh — FAIL-first pins for lattice/hello-cell (Lattice B1 "Hello Cell").
# Run before deliverables exist -> RED (pins/failfirst.log).
# Run after  deliverables exist -> GREEN (pins/final.log).
#
# H1: genesis anchor exists and chain verifies (frozen-clock-lab fnv1a-64 scheme)
# H2: hibernation receipt carries all four doubt-ledger fields
# H3: wake.sh reproduces tip hash from a cold clone
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)   # .../lattice/hello-cell/pins
CELLDIR=$(CDPATH= cd -- "$HERE/.." && pwd)          # .../lattice/hello-cell
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pins-hello.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

fails=0
pin() {
  name=$1; ok=$2; detail=$3
  if [ "$ok" = "true" ]; then
    echo "PASS $name — $detail"
  else
    echo "FAIL $name — $detail"
    fails=$((fails + 1))
  fi
}

have() { [ -f "$CELLDIR/$1" ]; }

# --- preflight: deliverables present at all ---
for f in cellgen.py hibernate.sh wake.sh; do
  if ! have "$f"; then
    pin "H0-$f-present" false "missing deliverable $f"
  fi
done

# --- H1: genesis anchor exists and chain verifies ---
if have cellgen.py; then
  if python3 "$CELLDIR/cellgen.py" --n 1000 --seed 7 --out "$WORK/cell" >"$WORK/gen.out" 2>"$WORK/gen.err"; then
    h1=$(python3 - "$WORK/cell" <<'PY'
import json, sys
FNV64_OFFSET = 0xcbf29ce484222325
FNV64_PRIME  = 0x100000001b3
MASK64 = 0xFFFFFFFFFFFFFFFF
def fnv1a64(data):
    if isinstance(data, str): data = data.encode("utf-8")
    h = FNV64_OFFSET
    for b in data:
        h ^= b
        h = (h * FNV64_PRIME) & MASK64
    return h
d = sys.argv[1]
try:
    gen = json.load(open(d + "/genesis.json"))
except Exception as e:
    print(f"unreadable genesis.json: {e}"); sys.exit(1)
basis = gen.get("basis", "")
h = basis
n = 0
bad = None
try:
    with open(d + "/receipts.txt") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line: continue
            rec, op = line.split(" ", 1)
            want = "%016x" % fnv1a64(h + "|" + op)
            if want != rec:
                bad = n; break
            h = rec; n += 1
except Exception as e:
    print(f"replay error: {e}"); sys.exit(1)
ok = (bad is None) and h == gen.get("tip") and n == gen.get("count")
print(f"chain_ok={bad is None} positions={n} tip_match={h == gen.get('tip')} count_match={n == gen.get('count')}")
sys.exit(0 if ok else 1)
PY
)
    if [ $? -eq 0 ]; then pin "H1-genesis-anchor-verifies" true "$h1"; else pin "H1-genesis-anchor-verifies" false "$h1"; fi
  else
    pin "H1-genesis-anchor-verifies" false "cellgen.py failed: $(tail -1 "$WORK/gen.err" 2>/dev/null)"
  fi
else
  pin "H1-genesis-anchor-verifies" false "cellgen.py missing"
fi

# --- H2: hibernation receipt has all four doubt-ledger fields ---
if have hibernate.sh; then
  if sh "$CELLDIR/hibernate.sh" "$WORK/cell" >"$WORK/hib.out" 2>"$WORK/hib.err"; then
    h2=$(python3 - "$WORK/cell" <<'PY'
import json, sys
d = sys.argv[1]
try:
    lines = [l for l in open(d + "/doubt.log") if l.strip()]
    entry = json.loads(lines[-1])
except Exception as e:
    print(f"no readable doubt.log entry: {e}"); sys.exit(1)
FIELDS = ["stopped_checking", "because", "covered_by", "revisit_trigger"]
missing = [k for k in FIELDS if not entry.get(k)]
print("fields_present=%d/4 missing=%s id=%s" % (4 - len(missing), ",".join(missing) or "none", entry.get("id", "?")))
sys.exit(1 if missing else 0)
PY
)
    if [ $? -eq 0 ]; then pin "H2-doubt-grammar-complete" true "$h2"; else pin "H2-doubt-grammar-complete" false "$h2"; fi
  else
    pin "H2-doubt-grammar-complete" false "hibernate.sh failed: $(tail -1 "$WORK/hib.err" 2>/dev/null)"
  fi
else
  pin "H2-doubt-grammar-complete" false "hibernate.sh missing"
fi

# --- H3: wake.sh reproduces tip hash from a cold clone ---
if have wake.sh; then
  if OUT=$(sh "$CELLDIR/wake.sh" "$WORK/cell" 2>"$WORK/wake.err"); then
    TIP_OUT=$(printf '%s\n' "$OUT" | grep '^tip=' | tail -1 | cut -d= -f2)
    TIP_EXP=$(printf '%s\n' "$OUT" | grep '^expected_tip=' | tail -1 | cut -d= -f2)
    MATCH=$(printf '%s\n' "$OUT" | grep '^tip_match=' | tail -1 | cut -d= -f2)
    POS=$(printf '%s\n' "$OUT" | grep '^positions=' | tail -1 | cut -d= -f2)
    if [ "$TIP_OUT" = "$TIP_EXP" ] && [ "$MATCH" = "True" ]; then
      pin "H3-wake-reproduces-tip" true "cold-clone tip=$TIP_OUT positions=$POS tip_match=True"
    else
      pin "H3-wake-reproduces-tip" false "tip_out=$TIP_OUT expected=$TIP_EXP match=$MATCH"
    fi
  else
    pin "H3-wake-reproduces-tip" false "wake.sh exited nonzero: $(tail -2 "$WORK/wake.err" 2>/dev/null | tr '\n' ' ')"
  fi
else
  pin "H3-wake-reproduces-tip" false "wake.sh missing"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "ALL PINS GREEN ($0)"
  exit 0
else
  echo "$fails PIN(S) RED ($0)"
  exit 1
fi
