# B3.4 — Worker surface: Artifacts adapter + P2 external-pusher protocol

Fourth increment of B3 (docs/B3-DESIGN.md §5, row B3.4), branch `b3-4-worker`.
Binds the B3.2 diff core and the B3.3 merge executor to the **Artifacts
adapter**, and lands the **P2 external-pusher protocol** (§3.1 design decision:
P2 first, because P1 — isomorphic-git inside a Worker — is B3's flagged #1
technical risk and is *not* taken here).

Everything is proven **offline**: no deploy, no namespace provisioning, no
network. The "Artifacts binding" in the rehearsal is a local mock that returns
*real* Artifacts-shaped values over real git objects.

ADD-ONLY: this branch **adds four files and one receipt and changes nothing
that already existed** (no edit to `index.ts`, `wrangler.jsonc`, `package.json`,
`tsconfig.json`, `diff.ts`, `merge.ts`, `quilt.ts`, `chain.ts`, or `quiltgen.py`).
No deletions, no merge, no force-push, no `wrangler deploy`.

## What was built

| file | role |
|---|---|
| `worker/src/artifacts-reader.ts` | `ArtifactsRepoReader` — a `RepoReader` over `env.ARTIFACTS` (`readTree` / `readBlob` / `readFile` / `readCommit`). Union of N repos; drop-in for `diff.ts` + `merge.ts`. |
| `worker/src/pusher.ts` | the P2 protocol: mint a single-use ≤300 s write token (injected `createToken`) → build a push manifest (exact paths/blobs, canonical order, digest); plus `verifyManifest` + `materializePush` (the dumb executor's pure half). |
| `worker/src/git-api.ts` | a standalone fetch-handler module (`export default`) exposing `POST /diff` and `POST /merge`. Read-only compute; no push, no repo mutation. Wiring into `index.ts`/`wrangler` routes is **deferred**. |
| `worker/test/worker-rehearsal.mjs` | offline rehearsal: mock Artifacts binding over local git → diff+merge through the adapter → P2 manifest → applied by a dumb executor to a local bare remote → clone-back verifies `ok`. Plus the two endpoints. |
| `worker/B3-4-RECEIPT.md` | this file |

## RepoReader methods implemented (the adapter boundary)

`worker/src/artifacts-reader.ts` implements exactly the four methods of the
B3.2 `RepoReader` interface (`worker/src/diff.ts`):

| method | Artifacts call | shape mapping |
|---|---|---|
| `readTree(hash) → TreeEntry[]` | `repo.readTree(hash)` | `ArtifactsTreeEntry[]` → `{name, mode, hash}` (drops `type`) |
| `readBlob(hash) → Uint8Array` | `repo.readBlob(hash)` | `Blob` → `new Uint8Array(await b.arrayBuffer())` |
| `readFile(ref, path) → Uint8Array \| null` | `repo.readFile({ref, path})` | `Blob \| null` → bytes / `null` |
| `readCommit(ref) → CommitInfo` | `repo.readCommit(hash)`, falling back to `repo.log({ref, limit:1})` | `treeHash` → `tree`; refs (branch/tag) resolved via `log` |

Extras (not part of the interface): `repo(name)` (handle access, for token
minting on main), `resolveRef(repoName, ref)` (ref → SHA against one repo),
and `Symbol.dispose` (releases the memoized RPC stubs).

Two honest design notes:

- **Union reader.** A fork and main are separate repos (§1.1), each holding the
  fork-point objects; the reader takes N repo *names* and resolves each
  hash/ref in whichever repo holds it — identical in spirit to the `LocalGit`
  test adapter. Callers should resolve refs to SHAs first, because a branch name
  like `main` may exist in **both** repos; `git-api.ts` does exactly that
  (`body.main`→main repo, `body.fork`/`body.base`→fork repo).
- **`log` is first-parent-only** (generated types, §6.3). It is used *only* to
  resolve a branch/tag to a commit; the diff itself never walks history.

## P2 push-manifest shape

Produced by `proposePush(resolved, { createToken }, opts)` (or the pure
`buildPushManifest(resolved, token, opts)`):

```
{
  protocol: "quilt-push-p2", version: 1,
  remote, refspec: "HEAD:main", branch: "main",
  commitMessage: "quilt-merge: <the MERGE op>",        // deterministic
  proposalDigest: "<fnv1a-64 hex16>",                  // over the canonical body
  singleUse: true,
  entries: [ { op: "write", path, mode: "100644",
               blob: "<fnv1a-64 hex16 of content>", bytes, content: "<base64>" }, … ],
  token: { id, scope: "write", ttlSeconds: 300, expiresAt, plaintext }, // once
  merge: { forkName, base, fork, main, cellDigest, edgeDigest, mergeOp,
           cells, edges, routingCount, routingTip }
}
```

- `entries` is the **complete** resolved tree in canonical path order (base64
  content). The executor has **no discretion**: it verifies `proposalDigest`
  (and each entry's `blob`/`bytes`), then makes the repo hold exactly those
  paths — prune what the manifest omits, write what it lists. No deletes needed
  (the manifest is total); a `delete` op is reserved and handled.
- `proposalDigest = fnv1a64(protocol ⧺ version ⧺ remote ⧺ refspec ⧺ branch ⧺
  commitMessage ⧺ mergeOp ⧺ tokenId ⧺ ∥ entries as `op\0mode\0path\0blob\0bytes`)`.
  The **plaintext is deliberately outside** the digest (it is a credential).
- Fail-closed invariants: no manifest for an unresolved merge; a token whose id
  differs from the MERGE receipt's `token=<id>` is refused (mint before merge,
  §1.4); scope must be `write`; TTL is clamped to `[60, 300]`.
- Revoke: `pkg.revoke = { tokenId, ref: tokenId, singleUse: true, … }` — the
  executor calls `repo.revokeToken(id)` after the push (or on any error).

## The two endpoints (`worker/src/git-api.ts`)

Read-only compute over the Artifacts binding. No push; the only side effect is
the `POST /merge` token mint (the ≤300 s write token P2 needs).

- **`POST /diff`** `{ base, fork, main, repos? }` → the semantic diff:
  `units[]` (per-unit verdicts), `conflicts`, `idempotent`, `forkOnly`,
  `mainOnly`, `fastPath`, `routing` (before→after), `ignoredPaths`,
  `unknownPaths`. Refs are resolved to SHAs against their designated repos.
- **`POST /merge`** `{ base, fork, main, resolutions, repos?, forkName?,
  tokenTtlSeconds?, sequentializeOrder? }` → re-derives (never trusts a cached
  proposal), validates that `resolutions` cover **exactly** the conflict set,
  mints the write token on main, resolves the quilt, and returns
  `{ ok, summary, decisions[], cells, edges, routingOps, mergeOp, routing,
  cellDigest, edgeDigest, push: { manifest, revoke } }`.
  `409 unresolved_conflict` before minting; `409 merge_failed` (with token
  revoked) if the executor cannot resolve.

Auth (§3.2): if `MERGE_SECRET` is set in the env, `POST /merge` requires the
`x-merge-secret` header; unset ⇒ open (dev/offline) mode. Real per-agent
identity is B4.

`repos` resolution: `repos.main` ?? `quilt` ?? `QUILT_REPO` ?? `"quilt-demo"`;
`repos.fork` ?? `FORK_REPO` ?? `"<main>--<forkName|task>"`. `wrangler.jsonc`
already has the `ARTIFACTS` binding on `namespace: "default"`; no config change
is needed or made.

## Reproduce

```
cd worker
npm run typecheck                                        # strict green
node --experimental-strip-types test/worker-rehearsal.mjs
node --experimental-strip-types test/merge-rehearsal.mjs  # B3.3, still green
```

## Results (2026-10-01, offline, WSL2)

- `npm run typecheck` → **exit 0** (strict, `--noEmit`).
- `node --experimental-strip-types test/worker-rehearsal.mjs` → **exit 0**:
  - **(1)** adapter is a drop-in: the diff through `ArtifactsRepoReader` is
    **byte-identical** to the diff through `LocalGit`; conflicts
    `["cell:logic/planner"]`, 2 fork-only, 2 main-only, 1 idempotent; `task.json`
    ignored; `resolveRef` maps `HEAD`/SHA to the right heads per repo.
  - **(2)** token: `scope=write`, TTL clamp `3600 → 300`, `30 → 60`.
  - **(3)** `mergeQuilt` via the adapter: sequentialize re-mined
    (`tip == independent re-walk`), disjoint + idempotent preserved, `ok=true`.
  - **(4)** manifest: 14 entries, canonical order, digest recomputes, no
    `task.json`, MERGE-receipt token id == minted id; tamper, token-id mismatch,
    and unresolved-merge are all **refused**.
  - **(5)** dumb executor → `HEAD:main` on a local bare remote → clone-back:
    14 files, commit message == `manifest.commitMessage`, token revoked,
    `quilt.ts ok=true`, python `quiltgen.py --verify` exit 0, bytes identical.
  - **(6)** endpoints: `POST /diff` 200 (1 conflict), `POST /merge` 200
    (returns `decisions[]` + a verifying manifest), unresolved → **409**,
    `MERGE_SECRET` → **401** without header / **200** with.
- `node --experimental-strip-types test/merge-rehearsal.mjs` (B3.3) → exit 0
  (regression: nothing existing changed).

## Unverified (do not quote as proven)

1. **No live Cloudflare.** Nothing was deployed; no namespace was provisioned;
   `env.ARTIFACTS` was never contacted. All binding behaviour above comes from
   the generated types (`worker/worker-configuration.d.ts`) and a **mock**, not
   served requests — the B2 §VI / B3 §6.7 gap is unchanged.
2. **`readBlob`/`readFile` Blob semantics.** Real binding returns a typed
   `Blob`; the mock returns `new Blob([bytes])`. `MEMORY_LIMIT` on large blobs
   is unexercised.
3. **`log` first-parent-only** and ref-resolution via `log` are assumed; the
   real `readCommit(hash)`-vs-ref behaviour and `INTERNAL_ERROR` paths are not
   exercised. `resolveRef` disambiguates by repo, not by the binding.
4. **Token enforcement.** `createToken("write", 300)` TTL enforcement, expiry
   clock, `revokeToken` latency, and the "single-use" property are protocol
   *shapes* here — enforced only by the mock. Real enforcement is B3.5.
5. **P2 manifest size.** The manifest carries the complete resolved tree as
   base64. For large quilts this may exceed binding/HTTP limits; the real
   transport (and any delta/pack optimisation) is unmeasured — **P1 or a
   delta-manifest would change this**, and neither is built.
6. **git-api wiring.** The module is standalone; routing it into `index.ts` /
   `wrangler.jsonc`, CORS, request-size limits, and the real merge-secret UX
   are deferred. The endpoints are exercised only in-process.
7. **Auth.** `MERGE_SECRET` is a shared secret (§6.4); per-agent identity is B4.
8. **`delete` op** in the manifest is implemented but never produced by the
   current pusher (the manifest is a total tree); untested on the wire.
9. **Determinism of JS string sort** for canonical path order matches git's
   path-byte order for ASCII paths only; non-ASCII paths are untested.

## Not done (out of scope, by instruction)

- No `wrangler deploy`, no namespace provisioning, no live push — a separate
  gated step (B3.5).
- No edit to `index.ts` / `wrangler.jsonc` / `package.json` (wiring deferred).
- No merge to `main`; PR open only.
