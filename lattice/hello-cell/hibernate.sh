#!/bin/sh
# hibernate.sh — dissolve a cell to cold storage.
# Appends a hibernation receipt in doubt-ledger grammar so the cell can resume:
#   stopped_checking / because / covered_by / revisit_trigger
# (spec: SuperInstance/doubt-ledger @poc ledger/entry.py — all four are required)
set -eu

CELL="${1:-.}"
[ -f "$CELL/genesis.json" ] || { echo "hibernate: $CELL/genesis.json not found" >&2; exit 1; }
[ -f "$CELL/receipts.txt" ] || { echo "hibernate: $CELL/receipts.txt not found" >&2; exit 1; }

python3 - "$CELL" <<'PY'
import json, sys, time, uuid

celldir = sys.argv[1]
gen = json.load(open(celldir + "/genesis.json"))

entry = {
    "id": uuid.uuid4().hex[:12],
    "ts": int(time.time()),
    "stopped_checking": "the live cell process",
    "because": "cell dissolved to cold storage; memory is the receipt chain, not a running process",
    "covered_by": "receipts.txt fnv1a-64 chain basis=%s tip=%s + wake.sh replay" % (gen["basis"], gen["tip"]),
    "revisit_trigger": "next wake.sh cold start, or any tip-hash mismatch on wake",
    "kind": "event",
    "status": "open",
    "expr": None,
    "discharge_reason": None,
}

FIELDS = ["stopped_checking", "because", "covered_by", "revisit_trigger"]
missing = [k for k in FIELDS if not entry.get(k)]
if missing:
    sys.exit("hibernate receipt missing required field(s): " + ", ".join(missing))

with open(celldir + "/doubt.log", "a") as f:
    f.write(json.dumps(entry) + "\n")
print("hibernation receipt %s appended to %s/doubt.log" % (entry["id"], celldir))
PY

# if the cell is a git repo, persist the hibernation receipt into memory
if git -C "$CELL" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$CELL" add doubt.log
    git -C "$CELL" commit -qm "hibernate: doubt receipt $(date -u +%Y%m%dT%H%M%SZ)" || true
fi
