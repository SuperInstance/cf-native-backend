# Lattice B1 — Hello Cell

First physics receipt for the **Planetary Agentic Codespaces / Living
Repository Lattice** concept: one minimal *cell*, cold-started on demand,
measured honestly. Physics before poetry.

## What a cell IS

A cell is a **git repo** with a split personality:

- **memory = the receipt chain.** An append-only chain of fnv1a-64 receipts
  (`receipts.txt`, one `<receipt> <op>` per line) anchored at a genesis basis
  (`genesis.json`). Position is an integer index — never a time.
- **working tree = cache.** Anything checked out is reconstructible and
  therefore disposable. A woken cell needs only the memory files.

A dissolved cell is not dead — it is *hibernating*: `hibernate.sh` appends a
doubt-ledger receipt (`stopped_checking` / `because` / `covered_by` /
`revisit_trigger` — all four required) so whoever wakes it next knows why
checking stopped and when to look again. Cold start is `wake.sh`: blobless
sparse clone → verify the chain → replay genesis→tip → print wall time and
positions/sec. Runs under `sh` with only `git` + `python3`.

## The hash scheme (fleet-proven, not invented)

`receipt_i = fnv1a64(prev_head + "|" + canonical(op))`, genesis =
`"%016x" % FNV64_OFFSET`. Canonical form is single-line. This is exactly the
scheme pinned by **SuperInstance/frozen-clock-lab @poc** (`lab/chain.py`,
`tests/pins_clock.py`) — order-not-time semantics included: receipts prove
*order*, not that any clock was honest. Hibernation grammar is pinned by
**SuperInstance/doubt-ledger @poc** (`ledger/entry.py`).

## Files

| file | role |
|---|---|
| `cellgen.py` | mint a scratch cell: genesis anchor + N synthetic positions (`--n` 1k…1M, `--seed`, `--out`, `--no-git`) |
| `hibernate.sh` | dissolve a cell: append 4-field doubt-ledger receipt to `doubt.log` (committed if the cell is a repo) |
| `wake.sh` | cold start: blobless sparse clone → verify → replay → timing report |
| `data/wake-latency.md` | MEASURED wake-latency curve + raw run log |
| `pins/pins-hello.sh` | FAIL-first pins H1–H3 (+ `failfirst.log`, `final.log`) |

Quick run:

```sh
python3 cellgen.py --n 100000 --out /tmp/cell
sh hibernate.sh /tmp/cell
sh wake.sh /tmp/cell        # prints positions, tip, wall times, positions/sec
```

## Measured wake curve (see `data/wake-latency.md`)

| N | total wake median |
|---:|------------------:|
| 1k | 0.387 s |
| 10k | 0.551 s |
| 100k | 2.494 s |
| 1M | 16.151 s |

Replay is linear in N (~15–20 µs/position, pure-Python fnv1a-64 on a 2-core
box); clone stays sub-second locally. Wake cost = reading+hashing the chain.

## Honest limits

1. **Synthetic positions are not a real workload.** Ops are `syn i=N s=seed`
   strings. Real cells carry domain payloads; per-position cost scales with op
   size, so this curve is a floor, not a forecast.
2. **Local measurement excludes real network fetch.** Numbers are local-path
   clones on one box. A remote cell pays LAN/WAN fetch latency on top — for a
   33 MiB chain that can dominate everything else here.
3. **The local git transport ignored our `blob:none` filter** during
   measurement (git 2.43 local upload-pack), so clone numbers reflect a full
   local pack. Blob-skipping is real against filter-honoring remotes
   (GitHub-native); it has not been measured here. INFERRED: blob:none would
   mainly skip *cached* working-tree blobs, which these synthetic cells do not
   carry.
4. **Chain integrity ≠ truth.** The scheme proves order-not-time; it does not
   prove ops were semantically valid when minted.
5. **doubt.log receipts are unauthenticated.** Anyone with write access can
   append a hibernation receipt; nothing signs them yet.

## Next build

**B2 — Membrane Worker**: a wake-on-URL cell membrane (Cloudflare Worker in
`cf-native-backend`) that cold-starts a cell per request, streams replay
progress, and re-hibernates on idle. B1 says the physics is affordable to
~100k positions/request on a Worker; B2 must prove it inside the deadline.
