# B3.2 — Adapter-pure semantic diff core + the conflict-rule property test

Second increment of B3 (docs/B3-DESIGN.md §5, row B3.2), branch `b3-2-diff`.
Builds the **algorithmic heart of the thesis**: the lazy tree-diff that turns two
forks into a finite, nameable set of unit deltas, plus the §2.4 conflict rule —
and proves the rule against **1 200 randomized fork pairs** over **real local
git repositories**.

ADD-ONLY: this branch adds four files and **changes nothing that already
existed** (no edit to `chain.ts`, `quilt.ts`, `package.json`, `tsconfig.json`,
or anything else). No deletions, no merge, no force-push.

## What was built

| file | role |
|---|---|
| `worker/src/diff.ts` | the adapter-pure diff engine: lazy tree-diff → per-unit deltas + the §2.4 conflict rule. Speaks **only** `RepoReader`. |
| `worker/test/localgit.mjs` | `LocalGit` — a `RepoReader` over real local git repos, **array-args `execFileSync` only** (no shell string, no `shell:true`) |
| `worker/test/diff-property.mjs` | the receipt: 1 200 random fork pairs, disjoint vs same-cell/same-edge, assertions + summary |
| `worker/B3-2-RECEIPT.md` | this file |

### The `RepoReader` boundary (the only thing `diff.ts` speaks)

```ts
interface RepoReader {
  readTree(hash: string): Promise<TreeEntry[]>;        // one level: {name, mode, hash}
  readBlob(hash: string): Promise<Uint8Array>;
  readFile(ref: string, path: string): Promise<Uint8Array | null>;
  readCommit(ref: string): Promise<{ hash; tree; parents }>;
}
```

No git, no fs, no bindings, no state — the identical module runs in the Worker
(Artifacts adapter) and in node (`LocalGit`). The one import is `fnv1a64`/`hex16`
from `chain.ts`: the quilt keeps **exactly one hashing scheme** (B1/B2), so a
unit's content hash is a fnv1a-64 digest over a canonical walk of its whole
subtree (sorted relative paths, modes, blob hashes) — no second scheme.

### Path → unit (B3 §2.3 step 3), as implemented

`classifyPath`:
- `cells/<type>/<name>/**` → cell unit `cell:<type>/<name>`
- `quilt.json` / `routing.txt` → the routing file view
- `task.json` → ignored (fork-point metadata)
- anything else → `unknown` (reported, never a conflict)

**Edges are refined into their own units.** B3 §2.2 makes edges addressable
(`<from>|<opcode>|<to>`) and says *"adds/removes of distinct ids commute"*, and
§2.5 shows two agents rewiring different edges landing with no wait. So the
routing files are treated as the **storage view** of per-`edge:<id>` units, not
as a single conflict unit — otherwise every concurrent routing change would
"conflict" and break the disjoint case. `MergeDiff.routing` still carries the
edge-set before→after (the human-readable proposal heart, §3.2).

### The conflict rule, encoded exactly (B3 §2.4)

```
touched(side, U) := hash(side,U) !== hash(base,U)

conflict   ⇔ touched(fork,U) && touched(main,U) && hash(fork,U) !== hash(main,U)
idempotent ⇔ touched(fork,U) && touched(main,U) && hash(fork,U) === hash(main,U)
fork-only  ⇔ only the fork touched U
main-only  ⇔ only main touched U
fastPath   ⇔ no unit is touched on both sides
```

Unit content hash: cells hash their **whole directory** (`cell.json` +
`receipts.txt` + `body/**`), so two agents appending *different* ops to the same
cell diverge (⇒ conflict) while two agents making the *identical* edit agree
(⇒ idempotent). Edge content is **presence** (canonical line hash, else `null`).

## Reproduce (exact commands)

```bash
# typecheck (strict) — must stay green
cd worker && npm run typecheck

# the property receipt (1200 pairs; pass an arg to change N, e.g. 40 for a smoke run)
node --experimental-strip-types test/diff-property.mjs 1200
```

`package.json` was left untouched (ADD-ONLY), so the test is run with the direct
`node` invocation. The test file registers the same inline `registerHooks`
resolver used by `test/quilt-parity.mjs`, to map `diff.ts`'s Worker-style
`import "./chain.js"` back to `./chain.ts` under `--experimental-strip-types`.

## Property-test result — MEASURED (this build, this box)

Seed `20261001`. Genesis quilt minted by `lattice/quiltgen.py` (python, B1
scheme); **two real local forks** (`git clone` of the genesis repo, so each is a
separate repository holding the shared base objects — modelling §1.1
fork-per-task); one union `LocalGit` reader over `[genesis, fork, main]`.

```
B3.2 property test — seed=20261001 pairs=1200
genesis base commit: 07a7835e7fa18c8ad3a06e0107cb4db8fa873a5e

pairs: 1200 (135.9s)
disjoint edits ⇒ conflict set ∅ (always):        493/493  100.0%
same-unit divergent ⇒ EXACTLY that unit:         359/359  100.0%
identical same-unit ⇒ idempotent, no conflict:   348/348  100.0%
conflict set == expected (all cases):            1200/1200  100.0%
edge units touched: 868; edge-unit conflicts: 0 (presence semantics ⇒ impossible)
cell-unit conflicts observed: 359

B3.2 DIFF PROPERTY OK — conflict rule holds across all random fork pairs
```

Every case asserts the conflict set **equals the expected set exactly** — so
"never more" is enforced, not just "never fewer". The scenario mix (weighted,
per pair, fresh seed `SEED ^ (i*2654435761)`):

- `disjoint`, `disjoint+edges` — fork and main edit **different** cells and/or
  **distinct** edge ids ⇒ must be conflict-free (all units one-sided or idempotent).
- `same-cell` — both edit the same cell with divergent ops ⇒ conflicts exactly `{cell:<addr>}`.
- `mixed` — a shared divergent cell **plus** disjoint cells each side ⇒ conflicts
  exactly `{cell:<shared>}`, and nothing extra (the "never more" case).
- `same-cell-identical` — both apply the same op ⇒ idempotent, conflicts ∅.
- `edge-add-same` / `edge-del-same` — both add the same edge / both delete the
  same edge ⇒ idempotent, conflicts ∅.
- `edge-rewire` — both rewire the same base edge to **different** targets
  (§2.5): old edge id idempotent (deleted on both), the two new ids disjoint ⇒
  conflicts ∅.

### Theorem surfaced by the test: edge units never conflict

An edge id's content is its presence (the canonical line determines the id), so
if both sides touched an id then both added it (identical ⇒ idempotent) or both
removed it (identical ⇒ idempotent); the "one added, other removed" case is
impossible because the absent side would then have been untouched. Hence
`edge-unit conflicts: 0 / 868 touched` is not luck — it is **provable**, and
edge changes decompose into *disjoint* or *idempotent* only. This is exactly
§2.2's *"distinct ids commute"* taken to its conclusion.

Type-check: `npm run typecheck` (tsc, strict) — **PASS, exit 0**.

## What is NOT verified (do not quote as proven)

1. **No Cloudflare.** The engine was exercised against **local git** only. The
   Artifacts binding adapter does not exist yet (that is B3.4); this receipt
   proves the *algorithm*, not the substrate. Fork tokens, `FORK_IN_PROGRESS`,
   live `readTree/readFile` latency — all still unknown (B3 §6, B2 receipt §VI).
2. **Unit content hash vs §2.1 wording.** §2.1 defines the *cell content hash*
   over `cell.json + body/**`; for conflict purposes this engine hashes the
   **whole unit directory including `receipts.txt`**, because a cell's state is
   its chain too and two agents appending divergent ops to one cell must
   conflict. Flagged, not hidden; trivially switchable by narrowing the walk.
3. **`routing` is not a conflict unit** — edges are (see above). If a future
   review needs a routing-level verdict, `MergeDiff.routing` (edge sets +
   digests) is there, but the conflict set is deliberately edge-addressed.
4. **The merge/apply path is NOT here.** This is diff + conflict *detection*
   only. Resolution modes (`take-fork | take-main | sequentialize`), re-mining
   receipts on the new head, the push, and the `MERGE …` ledger entry are B3.3.
5. **Renames are out of scope** (B3 §6.5): a rename shows up as
   `deleted` at the old cell address + `created` at the new one, i.e. two units.
6. **`task.json` is only classified, never written or diffed.** Fork-point
   anchoring (§1.2) is B3.3; here a `task.json` change is correctly *ignored*.
7. **Body payloads are hashed, not diffed textually.** §2.1 says body-internal
   textual diffs are presentation only; this engine never renders them.
8. **Deterministic seed, one box.** 1 200 pairs, seed `20261001`, WSL2 + git
   2.53 + node 22.23.3; `LocalGit` memoizes by object hash so the run is fast,
   but the *correctness* assertions do not depend on the cache.

## Scale / cost honesty

The tree-diff prunes identical `(name, mode, hash)` subtrees, so per pair it
reads only changed subtrees. `LocalGit` adds a memo keyed by object hash; the
1200-pair run took **135.9 s wall** (≈113 ms/pair) including two `git reset`,
two commits, and the full diff — the diff itself is a few dozen reads on the
shallow (≤4 level) quilt layout, matching §2.3's "tens of calls" estimate.

## Repo rules honored

ADD-ONLY: this PR only adds `worker/{src/diff.ts, test/localgit.mjs,
test/diff-property.mjs, B3-2-RECEIPT.md}`. It **stacks on `b3-1-quiltgen`**
(the test needs `lattice/quiltgen.py`, which B3.1 introduces), so the PR to
`main` also carries B3.1's additions until B3.1 lands. Nothing existing was
modified or deleted. No merge, no force-push.
