# LIVE-MERGE-RECEIPT — full quilt-as-git surface running on Cloudflare Artifacts

Date: 2026-10-02 ~07:15Z. Keeper-executed (mint/fork/push/deploy/curl).

The entire pipeline now runs on the real substrate, end to end:

```
quiltgen.py mint (offline) → git push (Artifacts git protocol)
  → POST /diff  (live semantic diff → conflict set)
  → POST /merge (live resolution + re-mined receipts + P2 push manifest + write token)
```

Worker: https://quilt-b2-membrane.casey-digennaro.workers.dev (build `b2-membrane+b3-6-git-api`).

## Case 1 — disjoint edits (no conflict, fastPath)

- main repo `quilt-demo`: base quilt + `syn main-edit touch=compass` (data/compass).
- fork repo `quilt-demo--task`: base quilt + `syn fork-edit touch=gps` (data/gps).
- base = `c4df23151845ee69d4d6113fd3a7a2f85e5c87a3`.

`POST /diff {base, fork:"main", main:"main"}` →
```
fastPath: true, conflicts: []
forkOnly: ["cell:data/gps"], mainOnly: ["cell:data/compass"]
routing: 4 edges, same digest on base/fork/main
```

`POST /merge {…, resolutions:{}}` →
```
ok, summary {forkOnly:1, mainOnly:1, conflict:0, cells:4, edges:4}
decisions: data/gps → fork (re-mined tip 9d1d1df17c0d67f6), data/compass → main (re-mined 895189039b995139)
mergeOp: MERGE … token=<minted>   push: {manifest, revoke}
```

## Case 2 — same-cell divergent edits (semantic conflict)

- main repo `quilt-conf-main`: base + `syn main-gps A` (data/gps).
- fork repo `quilt-conf-fork`: base + `syn fork-gps B` (data/gps).

`POST /diff {…, repos:{main:"quilt-conf-main", fork:"quilt-conf-fork"}}` →
```
fastPath: false, conflicts: ["cell:data/gps"], forkOnly/mainOnly/idempotent: []
```

`POST /merge {…, resolutions:{"cell:data/gps":"take-main"}}` →
```
ok, summary {conflict:1}, mergeOp + push {manifest, revoke} + minted write token
```

## Reproduce (the keeper recipe)

1. Mint: `python3 lattice/quiltgen.py --out /tmp/qbase --seed 20261001`
2. Fork: `git clone /tmp/qbase /tmp/qfork` + append an op to a cell
   (helper: `/tmp/quilt-edit.py DIR type name op` — appends an fnv1a-64 receipt).
3. Create + push repos:
   `wrangler artifacts repos create <name> --namespace default --default-branch main --json`
   → `git -c http.extraHeader="Authorization: Bearer $TOKEN" push origin HEAD:main`
4. Deploy: `cd worker && wrangler deploy`
5. `POST /diff` / `POST /merge` with `{base, fork:"main", main:"main"}`.

## Tool-use findings (learned by using, not docs)

- `wrangler artifacts namespaces` has no `create`; `repos create` auto-provisions the namespace.
- Repo token format `art_v2_...?expires=<unix>`; Bearer `http.extraHeader` form pushes.
- First request after `wrangler deploy` can hit a cold/stale edge (returned the pre-deploy
  404 once); re-curl a beat later returns the new version. Not a code bug.

## Unverified

- fork() + minted write-token APPLY (P2 executor actually pushing the manifest back) — not
  yet exercised; /merge emits the manifest but nothing has applied one live.
- sequentialize (multi-op) conflict resolution live (only take-main exercised live).
- MERGE_SECRET not provisioned (endpoints open).
- Worker CPU/timeout at 1M positions.
