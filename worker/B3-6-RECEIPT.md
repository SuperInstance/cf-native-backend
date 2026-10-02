# B3.6 — live wiring: the git-api surface reaches the deployed Worker

Sixth increment of B3 (docs/B3-DESIGN.md §5, row B3.6), branch `b3-6-livewire`.
B3.4 built the git-api surface (`worker/src/git-api.ts`) and deliberately left it
**standalone**; B3.5's receipt listed "git-api wiring … deferred" as an open gap.
This increment closes it: `POST /diff` and `POST /merge` now dispatch through the
one deployed Worker, alongside the B2 wake-on-URL surface.

**MODIFY-EXISTING (this is a router change, not an add-only one).** Three files
changed: `worker/src/index.ts` (the router), `worker/wrangler.jsonc` (vars +
docs), and this receipt; one file added: `worker/test/b3-6-livewire.mjs`.
Nothing was deleted: `GET /cell/<id>` and `GET /` (and `GET /health`) behave
exactly as before, and `git-api.ts` itself is untouched. No `wrangler deploy`
(the keeper deploys), no merge, no force-push.

## What was wired (the diff, in full)

`src/index.ts` — two additions and one extension:

1. **import + one handler instance**
   ```ts
   import { makeGitApi, type GitApiEnv } from "./git-api.js";

   // one stateless handler per isolate (it holds no state; reuse is safe)
   const gitApi: ExportedHandler<GitApiEnv> = makeGitApi();
   ```
2. **the route dispatch**, placed after the `GET /` banner and before the
   `/cell/<id>` match — method-gated, so no GET can reach it:
   ```ts
   if (
     request.method === "POST" &&
     (url.pathname === "/diff" || url.pathname === "/merge")
   ) {
     return gitApi.fetch!(request, env, ctx);
   }
   ```
3. **`Env` extended with the git-api vars** (all optional):
   ```ts
   export interface Env extends GitApiEnv {}
   // ⇒ ARTIFACTS (binding) + QUILT_REPO? + FORK_REPO? + MERGE_SECRET?
   ```
   `GitApiEnv` (B3.4) already declares exactly those four; inheriting it means
   one `Env` serves both surfaces and a future git-api var cannot be forgotten
   at the router. (The `fetch` signature gained the `ctx: ExecutionContext`
   third parameter — it is only forwarded, never used; `request` is left to
   contextual typing from `satisfies ExportedHandler` because the CF-properties
   request type is narrower than the lib's default `Request`.)

The `GET /` banner gained one field (the existing fields are unchanged):
`build: "b2-membrane+b3-6-git-api"`, plus `git_api: ["POST /diff", "POST /merge"]`.

## The surface now live (request shapes that route)

On the deployed Worker `https://quilt-b2-membrane.casey-digennaro.workers.dev`:

| route | body | → |
|---|---|---|
| `POST /diff` | `{ base, fork, main, repos?, quilt?, forkName? }` | B3.4 `handleDiff` — the semantic diff (`units`, `conflicts`, `idempotent`, `forkOnly`, `mainOnly`, `fastPath`, `routing`, `ignoredPaths`, `unknownPaths`) |
| `POST /merge` | `{ base, fork, main, resolutions, repos?, forkName?, tokenTtlSeconds?, sequentializeOrder? }` | B3.4 `handleMerge` — re-derive → validate coverage → mint the ≤300 s single-use write token → `{ ok, decisions[], cells, edges, mergeOp, cellDigest, edgeDigest, push: { manifest, revoke } }` |
| `GET /cell/<id>[?tail=1..64]` | — | B2 `wakeCell` (unchanged) |
| `GET /` · `GET /health` | — | B2 banner (unchanged, + `git_api`) |

Both POSTs are **pure compute** over the `ARTIFACTS` binding (no push, no repo
mutation); the only side effect is `POST /merge`'s token mint. Statuses are the
B3.4 ones: `409 unresolved_conflict` before minting, `409 merge_failed` (token
revoked) after, `401 unauthorized` when `MERGE_SECRET` is set and the
`x-merge-secret` header is missing or wrong. Refs are resolved per repo
(`base`/`fork` → fork repo, `main` → main repo), so branch names may repeat
across repos.

Repo resolution: `repos.main` ?? `quilt` ?? `QUILT_REPO` ?? `"quilt-demo"`;
`repos.fork` ?? `FORK_REPO` ?? `"<main>--<forkName|task>"`.

## `wrangler.jsonc`

One new `"vars"` block plus the documentation for all three vars:

```jsonc
"vars": { "QUILT_REPO": "quilt-demo" }
```

- `QUILT_REPO` is set to the code default (`"quilt-demo"`) so the live landing
  repo is visible and changeable in config without a code change — no behaviour
  difference from unset. **The keeper should set it to the real quilt repo name
  at deploy time.**
- `FORK_REPO` is deliberately **not** set: an empty string is not "unset" under
  nullish-coalescing, so `""` would become a repo name. Unset ⇒ the documented
  default `"<main>--task"`.
- `MERGE_SECRET` is documented but **not committed** — it belongs in
  `wrangler secret put MERGE_SECRET`. Unset/empty ⇒ open dev mode.

## Reproduce

```bash
cd worker
npm run typecheck                                          # strict, exit 0
wrangler deploy --dry-run --outdir=/tmp/b36-build          # bundles the wired Worker (no upload)
node --experimental-strip-types test/b3-6-livewire.mjs      # the B3.6 rig (builds + drives the bundle)
# regressions — nothing existing changed
node --experimental-strip-types test/worker-rehearsal.mjs   # B3.4
node --experimental-strip-types test/merge-rehearsal.mjs    # B3.3
node --experimental-strip-types test/nagent-rehearsal.mjs   # B3.5
```

`B36_BUNDLE=/path/to/index.js` lets the rig skip its own build.

## Results (2026-10-01/02, WSL2, offline)

- `npm run typecheck` (`tsc --noEmit`, strict) → **exit 0**.
- `wrangler deploy --dry-run` → **exit 0**: `Total Upload: 45.81 KiB / gzip:
  11.81 KiB`, binding list shows `env.ARTIFACTS (default) · Artifacts`.
- `node --experimental-strip-types test/b3-6-livewire.mjs` → **exit 0**, all
  assertions hold. Because `src/index.ts` uses `using`, Node 22 cannot import
  it; the rig therefore verifies the artifact that would actually ship — the
  esbuild bundle from `--dry-run` — and drives its `fetch` with a stub
  `ARTIFACTS`:
  - **(2) B2 intact** — `GET /` 200 (banner keeps `wake`, gains `git_api`),
    `GET /health` 200, `GET /cell/hello?tail=4` → the B2 `404 cell_not_found`
    with `repo: "cell-hello"`.
  - **(3) git-api wired** — `POST /diff {}` → the git-api's own validator
    (`missing required ref "base"`), **not** the B2 404; `POST /diff` with all
    three refs enters the adapter compute path (stub fails inside
    `ArtifactsRepoReader.resolveRef`, surfacing as the handler's 500);
    `POST /merge` with `MERGE_SECRET` set → **401 unauthorized** without the
    header and non-401 with it (env plumbing through the router proven);
    `MERGE_SECRET` unset → open dev mode reaching the body validator.
  - **(4) no widening** — `GET /diff` → B2 404, `POST /nope` → B2 404,
    `PUT /cell/hello` → 404 (wake stays GET-only).
- Regression `test/worker-rehearsal.mjs` (B3.4) → **exit 0** — adapter drop-in,
  14-entry P2 manifest, executor round-trip, `POST /diff` 200 / `POST /merge`
  200 / unresolved 409 / secret 401-200 all unchanged.

## Unverified (do not quote as proven)

1. **No deploy.** Nothing was uploaded; the keeper deploys. The route table above
   is proven against the *dry-run bundle*, not against a served request — the
   B2 §VI / B3 §6.7 "no live proof" gap stands for the git-api surface.
2. **Live `/diff` + `/merge` compute.** The rig proves *routing* with a stub
   binding; a real `POST /diff` against real Artifacts objects is still
   unexercised live. No live call has ever run for these two routes.
3. **`env.QUILT_REPO = "quilt-demo"` is a placeholder.** No repo named
   `quilt-demo` exists in the namespace yet (only `cell-hello` does, per
   B2-LIVE-RECEIPT); the keeper must point it at the real quilt/fork repos or
   pass `repos` explicitly per request, otherwise `/diff` will 500 on
   `resolveRef`.
4. **`MERGE_SECRET` UX.** The 401 path is proven in-process; the live secret is
   not provisioned and no real per-agent identity exists (that is B4).
5. **CORS / request-size / timeouts.** The wired surface sets no CORS headers and
   the P2 manifest carries the whole resolved tree as base64 — browser callers
   and large quilts are untested (B3.4 §Unverified 5).
6. **`ctx` forwarding.** `ctx` is passed to the git-api handler and never used
   there; `waitUntil`-based background work is not exercised.
7. Everything from B3-DESIGN §6 still stands (fnv1a-64 is tamper-*evidence*, not
   signing).

## Not done (out of scope, by instruction)

- No `wrangler deploy` (keeper deploys), no namespace change, no secret
  provisioning.
- No edit to `git-api.ts`, `artifacts-reader.ts`, `diff.ts`, `merge.ts`,
  `pusher.ts`, `quilt.ts`, `chain.ts`, `package.json`, or `tsconfig.json`.
- No merge to `main`; PR open only.
