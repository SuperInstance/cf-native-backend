# B3 — Multi-Agent Concurrency + Semantic Merge Surface (DESIGN, not yet built)

> A merge is two quilts agreeing on a routing. This doc designs how N agents
> fork the same quilt, work concurrent receipt chains with **zero
> coordination**, and land their work through a reviewable, cell-level
> (semantic) merge. This is the contest's 25% and the thesis itself.
>
> Scope: design only. No Worker code in B3 until this doc survives review.

## 0. Ground truth this design is built on

From `worker/B2-RECEIPT.md` + the generated binding types
(`worker/worker-configuration.d.ts`, wrangler 4.x, 2026-10-01) — the only
authorities we cite:

1. **The Artifacts Workers binding is read-oriented for content.** It can
   `create` / `fork` / `import` / `delete` repos, read git objects
   (`readFile` / `readBlob` / `readTree` / `readCommit` / `log`), and mint /
   revoke tokens — but there is **no write-file/commit method**. Content
   writes go over the **git protocol** (HTTPS push to `repo.remote`) using a
   token from `create()` / `fork()` / `createToken()`.
2. `repo.createToken(scope, ttl)` — scope `"write" | "read"`, ttl **min 60 s,
   max 31536000 s** (default 86400). Plaintext returned once.
   `revokeToken(tokenOrId)` exists.
3. `repo.fork(name, {description, readOnly, defaultBranchOnly})` — server-side
   fork, returns repo metadata **including an initial token**. Throws
   `FORK_IN_PROGRESS` if a fork is still running.
4. `log({ref, limit, offset})` walks the **first-parent chain only** — no
   merge-base primitive. Our design must record fork points explicitly.
5. The Worker (B2 membrane) holds **zero cell state**. It wakes cells by
   reading + verifying the fnv1a-64 receipt chain. B3 must keep that property.

Design invariants (constraints we promised):
- **I1** — Worker holds no cell state; all state lives in Artifacts repos.
- **I2** — Writes to any quilt repo happen only via git push authenticated by
  a Worker-minted, short-TTL, revocable write token.
- **I3** — ADD-ONLY repo etiquette: forks and merged task repos are kept as
  audit trail, never deleted (our `delete` calls: zero).

---

## 1. The concurrency model — fork-per-task, chains never share a head

### 1.1 The unit split: quilt repo vs. task fork

One **quilt** = one Artifacts repo (e.g. `quilt-demo`). Its layout
(§2.1) holds typed cells + routing. One **task** = one **server-side fork**
of that repo (e.g. `quilt-demo--task-<taskid>`), obtained by the Worker:

```
using main = await env.ARTIFACTS.get("quilt-demo");
const fork = await main.fork(`quilt-demo--task-${taskId}`,
                             { defaultBranchOnly: true,
                               description: `task ${taskId} agent=${agent}` });
```

**Why fork-per-task, not branch-per-task:**
- **Fork is the binding's native primitive** and returns its own credential —
  the agent gets a private repo name + token with **no shared write surface**.
  Branch-per-task would mean N agents pushing refs into the *same* repo:
  shared blast radius, ref-name collisions, and every agent needing a write
  token on the crown-jewel repo. Fork-per-task means **nobody but the merge
  path ever holds a write token on main** (I2).
- **Isolation is structural, not algorithmic.** Each fork is a separate git
  repo with its own `receipts` chains. Two agents cannot race on a chain head
  because no two agents share a head. No locks, no CAS, no compare-and-swap,
  no OCC — the concurrency control is *the repo boundary*. (Cloudflare's own
  framing — "a repository for every agent, session, task, or user" — taken
  literally.)
- **Failure containment.** A bad task = a bad fork. It is quarantined by
  refusal to merge (and renamed aside if naming hygiene ever demands it);
  main is untouched. Deleting is forbidden (I3) — forks are the audit trail.

Cost honesty: N tasks ⇒ N server-side copies of the quilt. Receipts are tiny
text (B1 physics: cost is reading+hashing, not storing); forks are
server-side (no data movement to the agent); and billing starts Oct 15, the
day after the deadline. The copy cost is real but bounded and deliberate.

### 1.2 Receipt-chain independence, made mergeable

Each fork records its **fork point** in `task.json` at the repo root
(written by the agent's first push, or pre-seeded by the task mint):

```json
{
  "task": "<taskid>", "agent": "<agent-name>",
  "base_commit": "<sha of main at fork time>",
  "base_routing_tip": "<tip of routing.txt chain at fork time>",
  "base_cell_tips": { "<cell addr>": "<chain tip>", ... },
  "forked_at": "<iso8601>"
}
```

- **Independence**: during work, an agent appends ops to *its fork's* chains
  (per-cell `receipts.txt`, quilt-level `routing.txt`) via plain `git push`
  to `fork.remote` with its task token. Nothing it does is visible to any
  other agent or to main. Chains diverge freely; that is the point.
- **Mergeability**: because the fork point (common ancestor) is recorded
  explicitly — commit sha **and** per-chain tips — every later merge is a
  two-way diff against a *known* anchor, not a merge-base search (the
  binding's `log` is first-parent-only; we never need the missing primitive).
  The base tips also let the common case merge as a pure chain *extension*
  (§2.4).

### 1.3 Task token hygiene

```
fork() returns an initial token (scope/TTL undocumented — see §6 assumptions)
  → Worker immediately mints the task token it actually hands out:
      using f = await env.ARTIFACTS.get(forkName);
      const t = await f.createToken("write", 3600);   // 1h task window
  → Worker returns { remote, token: t.plaintext } to the agent session ONCE.
  → Optional early kill: f.revokeToken(t.plaintext) when the task aborts.
```

Task tokens authorize writes **to the fork only**. Main stays read-only for
agents forever; the only write token ever minted for main is the merge-window
token of §3, TTL ≤ 300 s, revoked on completion.

### 1.4 The lifecycle (one task, end to end)

```
mint     Worker forks quilt-demo → quilt-demo--task-42, mints 1h write token
work     agent pushes ops to its fork (any pace, any order, no coordination)
propose  agent hits POST /merge — Worker diffs fork↔main at CELL level (§2)
review   proposal rendered: per-cell verdicts + routing before→after (§3.2)
land     reviewer approves (+ resolutions for any conflicts)
         Worker re-derives diff, mints ≤300s write token on MAIN,
         push executes the reviewed merge, merge receipt appended,
         token revoked; fork kept forever (audit), task done
wake     GET /quilt/demo verifies routing chain + touched cell chains
```

---

## 2. The semantic (cell-level) merge surface

### 2.1 Cell addressing scheme (the diff quantum)

A quilt repo is a **tensor of typed cells wired by edges**. Canonical layout:

```
quilt.json                    routing STATE: sorted edge set (see 2.2)
routing.txt                   routing LEDGER: fnv1a-64 chain of ROUTE_*/MERGE ops
task.json                     (forks only) fork-point anchor, §1.2
cells/<type>/<name>/cell.json     manifest: id, type, opcodes, tip, count
cells/<type>/<name>/receipts.txt  per-cell fnv1a-64 op chain (B2 scheme, v1)
cells/<type>/<name>/body/…        typed payload (the cell's content proper)
```

- **Cell type** ∈ `data | api | gpio | obj | logic` (the five typed
  primitives of QUILT-AS-GIT §layer-1; `obj` = addressable object).
- **Cell address** = the path fragment `cells/<type>/<name>`, canonical short
  form `<type>/<name>` (e.g. `logic/route-planner`). Addresses are lowercase
  `[a-z0-9-]`, stable across edits — **the address is identity, the commit is
  revision**. Renames are out of B3 scope (flagged §6).
- **Cell content hash** = fnv1a-64 over the canonical serialization of
  `cell.json` + `body/**` (deterministic walk: sorted paths, modes, blob
  hashes — reuses the tree-diff of §2.3, so no second hashing scheme).
- **Diff granularity rule:** the cell is the *atomic unit of change*. Two
  change sets are compared as sets of per-cell (and per-edge, §2.2) deltas;
  body-internal textual diffs are presentation for review, **never** merge
  semantics. Two agents editing different files *inside the same cell* still
  count as same-cell (conflict) — the cell is the quantum, deliberately
  coarser than lines and finer than files.

### 2.2 The routing (edges) — addressable too

`quilt.json` holds the edge set as canonical sorted lines, one edge per line:

```
edge data/gps qm_bind logic/route-planner
edge logic/route-planner qm_effect gpio/rudder
```

- **Edge id** = `<from>|<opcode>|<to>` (the fleet opcodes `qm_bind qm_link
  qm_effect qm_view qm_tick` are the sanctioned opcode set; others pass with
  a review-time warning).
- Edges form a **set**, stored sorted; adds/removes of distinct ids commute.
- Every routing change is *also* an op in the `routing.txt` chain:
  `ROUTE_ADD <from> <opcode> <to>` / `ROUTE_DEL <edgeid>` / `MERGE …` (§3.4),
  so the routing has both state (json) and memory (chain), like cells.

### 2.3 Computing the diff (reads only — the binding's own surface)

Diff(fork, main) runs entirely on read primitives:

1. Read fork's `task.json` → `base_commit`.
2. **Lazy tree-diff** from the two root trees (root tree hash from
   `readCommit(head)`): recursive `readTree`, pruning identical
   `(name, mode, hash)` subtrees. Cost O(changed-subtree RPCs) × O(depth);
   quilt layout is shallow (≤4 levels) so this is tens of calls.
3. Map every changed path to its unit: `cells/<type>/<name>/**` → that cell;
   `quilt.json`/`routing.txt` → routing; `task.json` → ignored (metadata).
4. Per unit emit a delta: `created | deleted | modified` + old/new content
   hashes + (for cells) old/new chain tips and the appended op segment
   (ops after the fork's `base_cell_tips[addr]` — chain verification proves
   the segment, §2.4).

The diff engine is written **adapter-pure**: it speaks only
`readTree / readBlob / readFile / readCommit`, so the identical module runs
against (a) the Artifacts binding in the Worker and (b) a local-git adapter
in tests (§4). No logic exists that cannot be exercised locally.

### 2.4 The conflict rule (precise)

Let **B** = fork point (base commit + base tips), **F** = fork head now,
**M** = main head now. Compute Δ(F,B) and Δ(M,B) as unit-level deltas
(cells by address, edges by id, plus `quilt.json` as edge-set):

> **Rule (fast path).** If for every unit touched by F, Δ(M,B) reports the
> unit unchanged (M's content hash == B's), the merge is **conflict-free**:
> apply F's deltas onto M verbatim. Per touched cell whose main-side chain
> head still equals `base_cell_tips[addr]`, F's appended receipts attach
> **unchanged** — a pure chain extension, no rehashing. Same for
> `routing.txt` when main's routing tip is still `base_routing_tip`.

> **Rule (conflict).** A conflict exists iff some unit is touched on both
> sides **with divergent resulting content hash** (or divergent edge
> presence/absence). Units touched on both sides with **identical** resulting
> content are idempotent — auto-resolved, noted in the merge receipt.

> **Rule (resolution modes).** Per conflicting unit the reviewer picks:
> `take-fork` | `take-main` | `sequentialize` (cells only) | (B4: manual).
> **Sequentialize** = keep M's new ops then F's new ops on that cell, in that
> order: F's op *text* is appended verbatim after M's, and F's receipts for
> that segment are **re-mined** on the new head (receipt = fnv1a64(prev‖op),
> a pure function — re-derivation is legal and deterministic; the op log is
> the source of truth, receipts are its proof). Untouched cells: byte-identical,
> zero diff noise.

**Thesis answer (the QUILT-AS-GIT open question "does semantic diffing
eliminate conflicts or relocate them?"):** it relocates them — to exactly
*(cell address ∪ edge id)* identity. The conflict set becomes finite,
nameable, and reviewable ("agents A and B both rewired `logic/planner`"),
instead of textual and incidental. Disjoint work never interacts, and
*that* is the eliminable 95%; the rest is honest, surfaced disagreement
about the same connection — which is precisely what review is for.

### 2.5 Worked example (the contest demo, verbatim)

Quilt: `data/gps`, `data/compass`, `logic/planner`, `gpio/rudder`.
- Agent A forks, appends ops to `data/gps` (new fix-smoothing op), adds edge
  `data/compass qm_bind logic/planner`.
- Agent B forks concurrently, appends ops to `logic/planner`, rewires edge
  `logic/planner qm_effect gpio/rudder` → targets `gpio/trim-tab`.
- Merge A: fast path — two cells extended, one edge added. No conflict.
- Merge B: `logic/planner` untouched on main since B's base ⇒ still fast path;
  the *rewired* edge `…→rudder` vs `…→trim-tab` conflicts only if A had also
  touched that same edge id. It didn't. Both land; chains extend; the routing
  ledger carries both ROUTE ops. **Nobody waited for anybody.**

---

## 3. Write-token flow + the review surface

### 3.1 The push problem, stated honestly

The Worker cannot run `git`. Pushing from inside a Worker means either:

- **(P1) git-over-fetch inside the Worker** — bundle `isomorphic-git` (pure
  JS, smart-HTTP over `fetch`) and push a thin pack. Credible, but unproven
  in a Worker (bundle size, runtime limits) — **flagged as B3's #1 technical
  risk; needs a 1-day spike, not an assumption.**
- **(P2) external pusher** — the Worker mints the token and returns a
  **single-use push manifest** `{remote, refspec, token(plaintext, once),
  proposalDigest}`; a dumb executor (node script, agent-side, or CI) clones
  main, materializes the reviewed merge *exactly as the proposal JSON
  dictates*, commits with a deterministic message, pushes, revokes.

**Design decision:** B3 lands **P2 first** (mechanically certain, fully
testable locally), with P1 as the upgrade that makes merges Worker-autonomous.
Both preserve the invariants: the *authority* to write main is decided only
in the Worker (token mint after validation, TTL ≤ 300 s, revoke-on-done);
P2 merely delegates moving bytes. The pusher's every input is in the signed
proposal digest — it has no discretion.

### 3.2 The review surface (merge = agreeing on a routing)

- `GET /quilt/<name>/proposals/<fork>` — Worker derives the diff live
  (§2.3), classifies per §2.4, returns the proposal JSON:
  fork/base/head, per-unit verdicts (`fast-path | conflict | idempotent`),
  appended op segments, **routing before→after** as edge-set diff (this is
  the human-readable heart: "agent B proposes rerouting planner output from
  rudder to trim-tab"). Proposals are *derived views* — deterministic
  functions of (fork@head, main@head) — so they need no storage and cannot
  go stale silently; they are re-derived at merge time regardless.
- `POST /quilt/<name>/merge` — body `{fork, resolutions: {unit: mode}}`.
  Worker: re-derives (never trusts a cached proposal) → validates
  resolutions cover exactly the conflict set → mint ≤300 s write token on
  main → execute push (P2 manifest now; P1 later) → verify the pushed state
  by re-reading main and re-running wake verification → revoke token →
  200 with the merge receipt.
- Reviewer identity: B3 ships keeper-agent-or-human-via-curl (the POST is
  authenticated by a merge-secret env var). Real auth is B4 scope — flagged.

### 3.3 What the merge pushes

One commit on main containing, for every touched unit: the resolved cell
content (or extended `receipts.txt`), updated `cell.json` tips/counts, the
new `quilt.json` edge set, the sequentialized/re-mined receipts where
resolution demanded it, and the appended `routing.txt` segment.

### 3.4 The merge receipt (routing ledger entry)

Same fnv1a-64 chain, appended to `routing.txt`:

```
MERGE fork=<forkname> base=<base_commit> cells=<fnv1a64 digest of cell deltas>
      edges=<fnv1a64 digest of edge deltas> token=<token id, never plaintext>
```

So the quilt's top-level memory is a **chain of routings** — literally "a
merge is two quilts agreeing on a routing," hashed. Wake (`GET /quilt/<id>`)
verifies the routing chain and the touched cell chains with the B2 walker —
the B1/B2 physics carries over unmodified (cost = read+hash the chains).

---

## 4. Testable now (local) vs. needs live Cloudflare

**Local now (git + python + node, no CF account) — the bulk of B3:**
- Quilt layout writer/reader (extend `cellgen.py` → `quiltgen.py`; per-cell
  chains + `quilt.json` + `routing.txt`). Pure port of proven code.
- Per-cell chain append/extend/re-mine (`chain.ts` primitives already
  parity-proven python↔TS, B2 receipt §V2).
- **The adapter-pure diff core**: run the exact Worker module against local
  git repos via the LocalGit adapter (child-process `git ls-tree` etc.).
- Conflict-rule property tests: randomized fork pairs — disjoint edits ⇒
  conflict set ∅, always; injected same-cell/same-edge edits ⇒ conflict set
  exactly those units, never more.
- Proposal determinism: same (fork, main) heads ⇒ byte-identical proposal.
- **Full end-to-end local merge rehearsal**: local bare remotes as
  "Artifacts stand-ins," two real forks, concurrent pushes, P2 pusher
  executing a reviewed merge, wake-verify the result. Real git, real pushes,
  zero Cloudflare.
- Token-flow *shape* only (mint→use→expire/revoke state machine against a
  fake token table).

**Needs live Cloudflare (gated last, per B2's no-deploy-yet status):**
- Binding behaviors we have only from docs/types: `fork()` semantics +
  initial-token scope/TTL, `createToken("write")` enforcement, `revokeToken`
  latency, `FORK_IN_PROGRESS` async path, namespace `default` existence
  (B2 unknowns carried forward, not resolved).
- The real git remote URL + token-over-HTTPS handshake.
- isomorphic-git-in-Worker viability (P1 spike).
- Wake-on-URL against a merged quilt on the real runtime (CPU budget at
  chain scale — B2 extrapolation still unmeasured).

---

## 5. B3 build order (smallest honest increment first)

| # | Increment | Receipt it must produce |
|---|-----------|------------------------|
| **B3.1** | Quilt layout + per-cell chains: `quiltgen.py` mints a 4-cell quilt (`data/gps`, `data/compass`, `logic/planner`, `gpio/rudder`) with per-cell receipts, `quilt.json` edge set, `routing.txt`; `chain.ts` gains per-cell verify | parity test green: python-minted quilt ↔ TS verify, tips byte-identical |
| **B3.2** | Adapter-pure semantic diff core (TS): tree-diff → unit deltas; LocalGit adapter | property test: 1k random fork pairs, conflict set == expected exactly; disjoint ⇒ ∅ |
| **B3.3** | Local fork/merge rehearsal: two local forks, concurrent edits, proposal JSON, P2 pusher lands the reviewed merge over a local bare remote; sequentialize + re-mine case; merge receipt into `routing.txt` | end-to-end log: both merges landed, wake-verify passes on merged quilt |
| **B3.4** | Worker surface: `GET /quilt/<id>` wake-verify; `GET …/proposals/<fork>`; `POST …/merge` (P2 manifest) — diff core bound to the Artifacts adapter; mocked-binding tests | type-check + mocked-binding test suite green; deploy gate explicit (needs CF account) |
| **B3.5** | Live gate + N-agent rig: real fork + real write-token push on CF; script spawning N agent sessions doing mint→work→propose→merge, with one injected conflict resolved via review | measured receipts on the real substrate; the 25% demo footage |

Order rationale: each step's receipt is checkable before the next begins;
nothing touches a CF account until B3.5; B3.1–B3.3 are pure local truth and
de-risk the entire semantic layer before the substrate risk is paid.

---

## 6. Honest assumptions & unknowns (do not quote as proven)

1. **fork()'s initial token scope/TTL is undocumented.** We mint our own
   task tokens regardless (§1.3) and treat the initial token as a bootstrap
   credential to be left unused-or-revoked. Behavior to verify live (B3.5).
2. **P1 (isomorphic-git in a Worker) is unproven** — bundle size, smart-HTTP
   over Workers `fetch`, pack upload limits. That is why P2 lands first.
   The design does not depend on P1 succeeding.
3. **`log` is first-parent-only** (generated types) — our fork-point anchoring
   (§1.2) exists precisely because no merge-base primitive is assumed.
4. **Proposal auth is a shared secret in B3** (merge POST). Real identity/
   per-agent auth is B4. Flagged, not hidden.
5. **Renames (cell or edge-id) are out of scope** — a rename looks like
   delete+create at two addresses. Acceptable for the contest; documented.
6. **fnv1a-64 is not cryptographic** — it's tamper-*evidence* (chain walk
   catches mutation, as B2's tamper test showed), not adversary-proof
   signing. Consistent with B1/B2; stated so nobody oversells it.
7. **No live deploy has ever happened on this repo** (B2 receipt §VI) — every
   binding-behavior claim here traces to official docs or the generated
   wrangler types, both local artifacts, not served requests.
8. **Quilt repos on `main` need `setDefaultBranch: "main"`** at mint (B2
   unknown #3, inherited).
9. Worker CPU limits at large chains remain extrapolated (B2 unknown #4).
10. `delete()` exists on the binding; our design calls it **never** (I3).

## 7. What this buys the entry

The video's center section (BUILD-PLAN pitch) is exactly §2.5: two agents,
two forks, zero waiting, a merge that is *a routing decision* — "git made
the change the unit of collaboration; quilt makes the connection the unit."
B3.1–B3.3 prove it locally with receipts before a single Cloudflare minute
is spent, and every assumption that survives only on docs is named in §6.
