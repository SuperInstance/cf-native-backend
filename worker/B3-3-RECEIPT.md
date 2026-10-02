# B3.3 — Pure merge executor + local merge rehearsal

Third increment of B3 (docs/B3-DESIGN.md §5, row B3.3), branch `b3-3-merge`.
Builds the **resolution half of the thesis**: the executor that consumes B3.2's
per-unit diff and turns it into a *resolved quilt*, re-mining every affected
receipt chain on the new head, plus the `MERGE …` routing-ledger op — and proves
it end-to-end with a **local fork/merge rehearsal** over two real git repos.

ADD-ONLY: this branch **adds three files and changes nothing that already
existed** (no edit to `diff.ts`, `quilt.ts`, `chain.ts`, `quiltgen.py`,
`package.json`, `tsconfig.json`, or anything else). No deletions, no merge, no
force-push.

## What was built

| file | role |
|---|---|
| `worker/src/merge.ts` | the pure merge executor: `diffMerge` → per-unit resolution → resolved quilt (path → content) + decisions, with receipts re-mined and the `MERGE` op emitted. Speaks **only** `RepoReader`. |
| `worker/test/merge-rehearsal.mjs` | end-to-end rehearsal: mint → fork ×2 → concurrent edits (disjoint + conflicting + identical) → merge with each resolution mode → verify the landed quilt with `quilt.ts` **and** python, and round-trip through a local bare remote. |
| `worker/B3-3-RECEIPT.md` | this file |

### The executor contract

```ts
mergeQuilt(reader, forkRef, mainRef, baseRef, resolutions, options): Promise<MergeResult>
```

- **Input** = base + fork + main heads through the same abstract `RepoReader`
  (`readTree` / `readBlob` / `readFile` / `readCommit`) the diff core speaks. No
  git, no fs, no bindings, no state — the identical module runs in the Worker
  (Artifacts adapter) and under node (`LocalGit`).
- **Output** = `files: Map<path, Uint8Array>` (the whole resolved quilt, exactly
  as a git tree would hold it), `decisions[]`, `routingOps`, `mergeOp`,
  `routing { scheme, basis, count, tip }`, `cells`, `edges`, digests, `ok`.

It is **additive by construction**: the result starts as main's *entire* tree
(main is the landing base), so untouched cells are copied byte-for-byte and the
only replaced paths are the ones a resolution decided. `task.json` is classified
`ignore` by the diff and never carried into the landed quilt.

### Resolution (§2.4), as implemented

| unit verdict | resolution | source |
|---|---|---|
| `fork-only` | auto | fork (the touched side) |
| `main-only` | auto | main (the touched side) |
| `idempotent` | auto | both agree ⇒ keep main's bytes |
| `conflict` | `take-fork` | fork's cell bytes |
| `conflict` | `take-main` | main's cell bytes |
| `conflict` | `sequentialize` | **cells only**: keep M's new ops then F's new ops, re-mine |

`sequentialize` (design §2.4, verbatim): the fork's new op *text* is appended
after main's new op text — `finalOps = basePrefix ++ mainΔ ++ forkΔ` — and the
receipts for that cell are **re-mined on the new head**. The order is exposed as
`options.sequentializeOrder` (`"main-first" | "fork-first"`, default
`"main-first"`, i.e. §2.4's canonical order); the rehearsal exercises both.

The op segments (`mainΔ`, `forkΔ`) are the tails of each side's `receipts.txt`
*beyond* the base prefix, and sequentialize only applies when both sides'
chains are **clean extensions of base** (prefix check). Otherwise it falls back
to `take-fork` and says so in the decision (`reason`), rather than silently
concatenating unrelated histories.

### Re-mining receipts (the "never trust a carried tip" rule)

Every affected cell is rewritten from its **final op list**:

```
tip = fnv1a64( … fnv1a64(fnv1a64(basis | op₀) | op₁) … )      # the B1 walk
```

This calls `chain.ts`'s `appendReceipt` / `canonical` — the quilt keeps exactly
**one** hashing scheme. The `cell.json` `tip`/`count` are written from that walk,
so a tip is *derived from content*, never copied from a side's manifest. For
`take-fork`/`take-main`/one-sided units the re-mined tip happens to equal the
chosen side's tip (idempotent), which the rehearsal checks; for
`sequentialize` it is a genuinely new tip (checked to differ from *both* carried
tips and to equal an independent re-walk in the test).

### Routing: the merge is two quilts agreeing on a routing

The resolved edge set is applied onto **main's** edge set, so only the difference
needs ledger ops: `ROUTE_ADD` for resolved edges not in main, `ROUTE_DEL` for
main edges not resolved (both sorted by edge id — deterministic). Then the
`MERGE` op (§3.4) is appended and the whole routing ledger is re-mined from the
basis:

```
MERGE fork=<forkName> base=<base_commit> cells=<digest> edges=<digest> token=<token id>
```

`cells=`/`edges=` are fnv1a-64 digests over the sorted per-unit delta lines
(`unit\0verdict\0mode\0resolvedTip|presence`). `token` is a token *id*, never a
plaintext credential; the local rehearsal passes `tok-local-N` / `none`.
`quilt.json` (`cells`, `edges`, `routing.count`, `routing.tip`) is rewritten from
the same values, so the quilt still verifies under `verifyQuilt`.

### Guard rails

`ok` is true iff every conflict got a resolution, no resolution named a
non-conflict unit (`unknownResolutions`), and no conflict was left unresolved
(`unresolved`). The rehearsal asserts both failure shapes return `ok=false`.

## Reproduce (exact commands)

```bash
# typecheck (strict) — must stay green
cd worker && npm run typecheck

# the end-to-end rehearsal
node --experimental-strip-types test/merge-rehearsal.mjs
```

`package.json` was left untouched (ADD-ONLY), so the test runs with the direct
`node` invocation. Like `test/diff-property.mjs`, the test registers an inline
`registerHooks` resolver to map the Worker-style `import "./chain.js"` back to
`./chain.ts` under `--experimental-strip-types`.

## Rehearsal result — MEASURED (this build, this box)

Scenario: mint a quilt with `lattice/quiltgen.py` (python, B1 scheme); `git
clone` it twice into two **separate** repos (fork-per-task, §1.1); edit
concurrently — fork: `data/gps` (+2 ops), `logic/planner` (+2 ops), `data/compass`
(identical op), new edge `data/gps qm_bind gpio/rudder`, plus a `task.json`; main:
`gpio/rudder` (+1 op), `logic/planner` (+2 ops, divergent), the same `data/compass`
op, new edge `logic/planner qm_tick data/compass`.

The diff classified exactly the intended units:

```
conflicts:  ["cell:logic/planner"]
fork-only:  ["cell:data/gps", "edge:data/gps|qm_bind|gpio/rudder"]
main-only:  ["cell:gpio/rudder", "edge:logic/planner|qm_tick|data/compass"]
idempotent: ["cell:data/compass"]
```

Four merges (all land and verify):

```
RUN A  (sequentialize, main-first) → quilt.ts ok=true, python ok=yes
RUN A2 (sequentialize, fork-first) → quilt.ts ok=true, order flipped
RUN B  (take-fork)                 → fork's logic/planner bytes win; ok=true
RUN C  (take-main)                 → main's logic/planner bytes win; ok=true
round-trip → pushed to a local bare remote, cloned back (14 files), verify ok=true

B3.3 MERGE REHEARSAL OK — resolved quilt verifies; all resolution rules hold
```

Stable per-run artifacts (independent of the random commit shas):

```
mergeOp (RUN A): MERGE fork=task-1 base=<base_sha> cells=cc301069d5d8b8f9 edges=bbe5883e5e583f0f token=tok-local-1
```

Rules asserted, all passing:

- **sequentialize preserves both op sets in canonical order** —
  `finalOps == base ++ mainΔ ++ forkΔ`; both op texts present; main's new ops
  precede fork's; `count == base + 4`.
- **the tip is re-mined, not carried** — the landed `logic/planner` tip equals an
  **independent** re-walk of `finalOps` in the test's own fnv implementation, and
  differs from *both* the fork's and main's carried tips.
- **take-fork / take-main win when specified** — the landed cell's
  `receipts.txt` is byte-identical to the chosen side's, its tip equals that
  side's, and the other side's ops are dropped.
- **disjoint cells both survive** — `data/gps` (fork-only) and `gpio/rudder`
  (main-only) land byte-identical to their side; `data/compass` (idempotent) is
  preserved.
- **both edges land** — `quilt.json` carries the fork's *and* main's new edges,
  and the routing ledger carries both `ROUTE_ADD` ops plus exactly one `MERGE`.
- **routing is re-derived** — the merged routing tip equals an independent
  re-walk of the merged ledger; `count` equals the ledger op count.
- **guard rails** — an unresolved conflict and a resolution on a non-conflict
  unit both return `ok=false` (`unresolved` / `unknownResolutions`).
- **wake-verify** — every landed quilt passes `quilt.ts`'s `verifyQuilt`
  (cells + routing + edge-set), cross-checked against python
  `quiltgen.py --verify`, and the RUN A quilt still verifies after a real
  push→clone through a local bare remote (the Artifacts stand-in, §4).

Type-check: `npm run typecheck` (tsc, strict) — **PASS, exit 0**.

## What is NOT verified (do not quote as proven)

1. **No Cloudflare.** Everything ran over **local git**; the push is a local
   bare remote standing in for an Artifacts repo. The real binding adapter,
   `createToken("write")` enforcement, `FORK_IN_PROGRESS`, and merge-window
   token minting/revocation (design §3.1–3.2) are **B3.4/B3.5** — untouched.
2. **The executor does not push.** It produces the resolved quilt (path →
   content) + a `mergeOp`; the P2 *pusher* (single-use manifest → commit →
   push → revoke, §3.1) is not in this increment. The rehearsal only proves the
   bytes round-trip through git, not the token flow that would move them on CF.
3. **`sequentialize` order: §2.4 vs the task brief.** Design §2.4 specifies
   *"keep M's new ops then F's new ops"* — implemented as the default
   (`sequentializeOrder: "main-first"`). The task brief's phrase "fork ops then
   main ops" is a **paraphrase of the same mode**; the `"fork-first"` option
   (RUN A2, also verified) implements that reading exactly. Flagged, not hidden —
   the spec value is the default and the alternative is one option away.
4. **`sequentialize` resolves *op chains*, not bodies.** If two sides change
   only a cell's `body/**` (no op divergence), the mode keeps main's body (the
   fork segment is empty); it does not textual-merge payloads. Body-internal
   textual merging is out of scope by §2.1 (body diffs are presentation only).
5. **Non-clean histories fall back.** If a side's chain is not a clean
   op-extension of base (e.g. a truncated/divergent prefix), `sequentialize`
   falls back to `take-fork` and records it in the decision `reason`. This path
   is not exercised by the rehearsal (all edits are appends) — it is defensive.
6. **Unknown/ignored paths are not carried.** The result is built from main's
   tree, so a fork's `unknown/**` and `task.json` are dropped. `task.json` is
   correct by design (§1.2); unknown paths are silently dropped (no unit owns
   them) — acceptable, but a real review surface should surface them (§2.3 marks
   them `unknown`).
7. **Edge conflicts are impossible, not handled by luck.** B3.2 proved edge
   units never conflict (presence semantics). The executor still has a defensive
   `conflict` branch for edges (rejecting `sequentialize` on them per §2.4
   "cells only"); it is dead code until a future edge model changes that.
8. **`MERGE` digest contents are ours, not the spec's.** §3.4 says "fnv1a64
   digest of cell/edge deltas" without fixing the serialization; we hash sorted
   `unit\0verdict\0mode\0resolvedTip|presence` lines. Deterministic and reviewable,
   but the exact byte layout is an implementation choice (documented here).
9. **One box, deterministic scenario.** WSL2 + git 2.53 + node 22.23.3,
   python 3. `LocalGit` memoizes by object hash; correctness does not depend on
   the cache. Commit shas vary run-to-run (committer time); the digests and the
   rule assertions do not.
10. **No live deploy has ever happened on this repo** (B3 §6.7, B2 §VI) — every
    substrate claim here traces to local git only.

## Repo rules honored

ADD-ONLY: this PR adds exactly `worker/src/merge.ts`,
`worker/test/merge-rehearsal.mjs`, and `worker/B3-3-RECEIPT.md`. It branches
from the **latest `main`** (post-B3.2, `1936f89`), not from a prior PR branch.
Nothing existing was modified or deleted. No merge, no force-push.
