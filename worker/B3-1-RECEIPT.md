# B3.1 — Quilt layout + per-cell chains (python↔TS parity on a whole quilt)

First increment of B3 (docs/B3-DESIGN.md §5, row B3.1), branch `b3-1-quiltgen`.
Mints a real 4-cell quilt locally with **per-cell receipt chains**, an edge set
(`quilt.json`), and a routing ledger (`routing.txt`), then proves the B2
TypeScript chain verifies the **whole quilt** byte-identically against the B1
Python scheme.

ADD-ONLY: this branch adds four files and **changes nothing that already
existed** (including `worker/package.json` — no npm script was added). No
deletions, no merge, no force-push.

## What was built

| file | role |
|---|---|
| `lattice/quiltgen.py` | mints a quilt (layout below) *and* re-walks it (`--verify DIR`, JSON) as the python oracle |
| `worker/src/quilt.ts` | the quilt verifier: per-cell chains + routing ledger, **pure functions of input text** (no fs/binding/state) |
| `worker/test/quilt-parity.mjs` | the parity receipt: python mint → python oracle + TS verify → tips byte-compared → tamper tests |
| `worker/B3-1-RECEIPT.md` | this file |

`quilt.ts` does **not** re-implement the hash: it imports `verifyChain` from
`chain.ts` (the B1/B2 single source of truth) and applies it once per cell plus
once to `routing.txt`. The B2 membrane property holds — the verifier is a pure
replay of text, so the same module runs in the Worker (reading Artifacts blobs)
and in node (reading files).

## Quilt layout produced (B3-DESIGN §2.1)

```
<quilt>/
  quilt.json                          routing STATE: sorted canonical edge set
                                      + routing chain anchor {scheme,basis,count,tip}
  routing.txt                         routing LEDGER: fnv1a-64 chain of ROUTE_ADD ops
  cells/<type>/<name>/cell.json       manifest: id,type,opcodes,count,tip (+scheme,basis)
  cells/<type>/<name>/receipts.txt    per-cell fnv1a-64 op chain (B1 scheme v1)
  cells/<type>/<name>/body/<name>.md  typed payload (content; hashing is B3.2)
```

The demo quilt `hello-quilt` (§2.5): cells `data/gps`, `data/compass`,
`logic/planner`, `gpio/rudder`; four edges
(`data/compass qm_bind logic/planner`, `data/gps qm_bind logic/planner`,
`logic/planner qm_effect gpio/rudder`, `logic/planner qm_view data/gps`), one
`ROUTE_ADD` op each in `routing.txt`. Ops per cell are drawn deterministically
(seed 20261001) from that cell's own opcode vocabulary, 3–20 ops each.

## Reproduce (exact commands)

```bash
# mint + inspect
python3 lattice/quiltgen.py --out /tmp/b3quilt --no-git      # or omit --no-git to git-commit it
python3 lattice/quiltgen.py --verify /tmp/b3quilt            # python oracle (JSON)

# typecheck + the parity receipt
cd worker
npm run typecheck
node --experimental-strip-types test/quilt-parity.mjs
```

> `worker/package.json` was left untouched (ADD-ONLY), so the parity test is run
> with the direct `node` invocation above; `worker/package.json` has no
> `quilt-parity` script by design. The test file registers an inline
> `module.registerHooks` resolver that maps `quilt.ts`'s Worker-style
> `import "./chain.js"` back to `./chain.ts`, because node's
> `--experimental-strip-types` does not do that `.js`→`.ts` rewrite
> (the existing `parity.mjs` sidesteps this by importing a leaf module).

## Parity result — MEASURED (this build, this box)

Mint is deterministic: two mints (with git) are byte-identical across all
tracked files. The python oracle re-walks the minted text independently of the
manifests; TS walks the same text via `chain.ts`.

| unit | count | python tip | TS tip | match |
|---|---|---|---|---|
| `data/gps` | 9 | `a6b7d5130edbd644` | `a6b7d5130edbd644` | yes |
| `data/compass` | 17 | `b7881bec5b4414e1` | `b7881bec5b4414e1` | yes |
| `logic/planner` | 18 | `aef4836fb6f09777` | `aef4836fb6f09777` | yes |
| `gpio/rudder` | 12 | `f03f2ff82919d5ca` | `f03f2ff82919d5ca` | yes |
| **routing** | 4 | `00e01a9f8b517491` | `00e01a9f8b517491` | yes |

```
TS: ok=true cells_ok=true routing_ok=true edge_set_ok=true
ok    all 4 cell tips byte-identical (python ↔ TS)
ok    routing tip byte-identical (python ↔ TS)
ok    edge set (quilt.json) == routing ledger (ROUTE_ADD ops)
ok    TS quilt verify: overall ok
tamper cell logic/planner: ok=false cells_ok=false  → chain break at position 0;
      the other three cells still verify
tamper routing: ok=false routing_ok=false first_break_at=0
QUILT PARITY OK: 4 cells + routing byte-identical python↔TS, edge set agrees, tamper caught
```

Type-check: `npm run typecheck` (tsc, strict) — **PASS, exit 0**.

Extra invariant checked (and passing): the routing **state** in `quilt.json`
equals the routing **memory** derived from the `ROUTE_ADD` ops in `routing.txt`
(B3 §2.2, "state and memory, like cells").

## What is NOT verified (do not quote as proven)

1. **No git remote / no Cloudflare.** B3.1 is local mint + verify. No Artifacts
   namespace, no fork, no push, no wake-on-URL was exercised here — that is
   B3.3/B3.5. `quiltgen.py` can `git init`+commit a quilt (default), but nothing
   is pushed anywhere.
2. **The cell `body/**` content is not hashed yet.** B3-DESIGN §2.1 defines a
   cell content hash via the §2.3 tree-diff; B3.1 writes the payloads but
   deliberately does not hash them. That is B3.2's diff core.
3. **`content_hash` / cell-content equality is therefore untested** — B3.1 only
   proves chain-tip parity, not body parity.
4. **`ROUTE_DEL` / `MERGE` ops are parsed but not minted or exercised.** The
   ledger replay handles them (set semantics: adds then dels; `MERGE` counted,
   ignored for the edge set); only all-`ROUTE_ADD` ledgers are tested.
5. **`registerHooks` is node ≥22.15** (used only by the test harness); the
   verifier itself is plain TS with no version-specific API. Worker runtime
   behavior of `quilt.ts` (importing blobs) is untested — it is pure text, but
   it has never run inside a Worker.
6. **fnv1a-64 is tamper-evidence, not cryptographic** (B3 §6.6) — unchanged
   from B1/B2.
7. **`hello-quilt` is not yet a repo name on `main`** — B3 §6.8
   (`setDefaultBranch: "main"`) applies only when a quilt repo is minted on
   Cloudflare, which has not happened.

## Repo rules honored

ADD-ONLY: this PR only adds `lattice/quiltgen.py` and `worker/{src/quilt.ts,
test/quilt-parity.mjs, B3-1-RECEIPT.md}`. No existing file was modified or
deleted. No merge, no force-push.
