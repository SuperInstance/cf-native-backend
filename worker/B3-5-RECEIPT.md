# B3.5 — N-agent concurrent merge rig (offline)

Fifth increment of B3 (docs/B3-DESIGN.md §2.4 conflict rule + §5 row B3.5),
branch `b3-5-nagent`. B3.5 as designed is *live gate + N-agent rig*; the live
half needs a Cloudflare account and is explicitly out of scope here. This
increment delivers the **offline half**: proof that fork-per-task multi-agent
concurrency holds at **N > 2**, with all N forks landing through the existing
merge executor and the final quilt verifying clean with zero data loss.

ADD-ONLY: this branch **adds two files and changes nothing that already existed**
(no edit to `diff.ts`, `merge.ts`, `quilt.ts`, `chain.ts`, `quiltgen.py`,
`package.json`, `tsconfig.json`, or anything else). No deletions, no merge, no
force-push, no deploy.

## What was built

| file | role |
|---|---|
| `worker/test/nagent-rehearsal.mjs` | the N-way rig: mint one genesis quilt, fork it N ways (real local clones, distinct seeded RNGs), apply a mixed-seeded edit set, then land **all N forks sequentially** through `merge.ts` into one resolved quilt; verify with `quilt.ts` **and** python, assert zero data loss, print a summary table. |
| `worker/B3-5-RECEIPT.md` | this file |

No production code changed: the rig exercises the B3.2 diff core
(`worker/src/diff.ts`) and the B3.3 executor (`worker/src/merge.ts`) exactly as
they are, over the `LocalGit` union reader (`worker/test/localgit.mjs`) — the
same technique B3.3's rehearsal uses, extended to N.

## The scenario (default N = 8, configurable)

One genesis quilt (`lattice/quiltgen.py`, B1 scheme) → N forks, each a real
`git clone` with its own seeded RNG (`mulberry32(SEED_BASE + i*1013)`). Per fork
`i`:

| edit kind | cell / edge | count | expected verdict at landing |
|---|---|---|---|
| **disjoint (new)** | brand-new cell `data/leaf-<i>` (2 ops) | N | `fork-only` → survives byte-identical |
| **disjoint (existing)** | `data/gps` (fork 0), `gpio/rudder` (fork 1) | 2 | `fork-only` → survives byte-identical |
| **conflict** | `logic/planner`, 2 fork-distinct ops each | N × 2 ops | `conflict` → `sequentialize` (main-first), re-mined |
| **idempotent** | `data/compass`, the SAME op from every fork | 1 op each | first `fork-only`, rest `idempotent` (auto) |
| **edge add** | `edge data/leaf-<i> qm_bind logic/planner` | N | edges union (presence-only unit) |

Landing order = fork index 0…N-1. Base is **always the genesis commit** (each
fork's actual fork point never moves); `main` advances after each landing. So
merge `i` is `mergeQuilt(reader, fork_i, main_{i-1}, genesis, resolutions)` with
`resolutions = { "cell:logic/planner": "sequentialize" }` for every `i ≥ 1`
(fork 0 sees `main == base`, so nothing conflicts). To land result `i` as the
new main, the executor's `files` map is materialized into a fresh committed repo
and unioned into the `LocalGit` reader for landing `i+1`.

## Results (N = 8, reproduced below)

```
--- summary ---
N (forks)                | 8
cells in final quilt     | 12
total cells touched      | 12
disjoint survived        | 10/10
conflicts resolved       | 7/7 (re-mined 7)
idempotent auto-resolved | 7
edges unioned            | 12 (base 4 + new 8)
final verify (quilt.ts)  | ok
final verify (python)    | ok
```

Per-landing trace:

```
land 0: task-0 → conflicts=0 forkOnly=5 mainOnly=0 idempotent=0 cells=5  edges=5  ok=true
land 1: task-1 → conflicts=1 forkOnly=3 mainOnly=3 idempotent=1 cells=6  edges=6  ok=true
land 2: task-2 → conflicts=1 forkOnly=2 mainOnly=6 idempotent=1 cells=7  edges=7  ok=true
...
land 7: task-7 → conflicts=1 forkOnly=2 mainOnly=16 idempotent=1 cells=12 edges=12 ok=true
```

`mainOnly` grows by 2 per landing: earlier landings' cells (`data/gps`,
`gpio/rudder`, and each new `data/leaf-*`) read as `main-only` relative to a
later fork that never touched them (the later fork's side equals base). That is
the expected asymmetry: a cell changed only on `main` since base is `main-only`
for every subsequent fork. It never rejects a merge and never loses data.

### Assertions (all hold)

- **(a) final quilt verifies `ok`** — `quilt.ts` (`ok=true`, zero problems) AND
  python `quiltgen.py --verify` (`ok=true`, exit 0); re-checked after a
  push/clone round-trip through a local bare remote (14 files, byte-identical).
- **(b) every disjoint write survives (union present)** — all N new
  `data/leaf-<i>` cells plus `data/gps` (fork 0) and `gpio/rudder` (fork 1) are
  present in the final quilt and byte-identical to the writing fork's
  `receipts.txt` (`disjoint survived 10/10` at N=8).
- **(c) each conflict resolved per policy + receipts re-mined** — the one
  conflict unit per landing (`cell:logic/planner`) resolves as `sequentialize`
  main-first; `reMined=true`; the final planner ops equal
  `base ++ fork0Δ ++ … ++ fork(N-1)Δ` exactly; the final tip is a **new** walk
  (≠ the carried genesis tip) and equals an independent re-walk. The shared
  `data/compass` op lands exactly **once** (N−1 idempotent auto-resolutions).
- **(d) merged edge set is the union** — final edges == genesis edges ∪ N new
  edges; the routing ledger carries N `ROUTE_ADD`s + N `MERGE` ops and its tip
  re-walks from basis.

### Generality (N sweep, same rig, asserted)

| N | final cells | disjoint survived | conflicts resolved | idempotent | edges unioned | verify |
|---|---|---|---|---|---|---|
| 3  | 7  | 5/5   | 2/2 (re-mined 2)   | 2  | 7  (4+3)  | ok |
| 5  | 9  | 7/7   | 4/4 (re-mined 4)   | 4  | 9  (4+5)  | ok |
| 8  | 12 | 10/10 | 7/7 (re-mined 7)   | 7  | 12 (4+8)  | ok |
| 12 | 16 | 14/14 | 11/11 (re-mined 11) | 11 | 16 (4+12) | ok |

## Reproduce

```bash
cd worker
npm run typecheck                                   # strict green
node --experimental-strip-types test/nagent-rehearsal.mjs        # N=8 (default)
NAGENT_N=12 node --experimental-strip-types test/nagent-rehearsal.mjs
# regression: the B3.3 two-fork rehearsal still passes
node --experimental-strip-types test/merge-rehearsal.mjs
```

`typecheck`: `tsc --noEmit` exit 0. `nagent-rehearsal.mjs`: all assertions pass,
summary table printed, final quilt verifies ok (quilt.ts + python), round-trip
ok. `merge-rehearsal.mjs` (B3.3) unchanged and still green.

## Unverified / honest limits

1. **Offline only.** These are real local git repos via `LocalGit`; **no
   Cloudflare, no Artifacts binding, no write-token push** was exercised. The
   B3.5 "live gate" half (real `fork()` + token push on CF) remains unrun and
   deploys nothing.
2. **Sequential landing, not concurrent `main` writes.** The forks are created
   and edited *without coordination*, but the rig lands them one at a time (as
   the review surface does). True parallel pushes to `main` are B4/shared-remote
   territory, not claimed here.
3. **Resolution is scripted** (`sequentialize` for the one conflict unit), not
   human-reviewed. The rig proves the mechanism + determinism, not a review UX.
4. **`sequentialize` requires clean op-extensions of base.** Here every fork's
   `logic/planner` chain is `base ++ forkΔ`, so it applies; the divergent-prefix
   fallback path (§2.4, flagged `take-fork`) is exercised by B3.3, not here.
5. **Scale.** N ≤ 12 tested; larger N is extrapolated (each landing is a full
   tree union, O(N) merges × O(tree) materialization). No claim beyond 12.
6. **`main-only` growth** (see above) is real and expected, not a leak: it is
   the diff correctly reporting cells changed on main-since-base for later
   forks. It costs resolution work, not correctness.
7. Everything from B3-DESIGN §6 still stands (fnv1a-64 is tamper-*evidence*, not
   signing; no live deploy has ever run on this repo).
