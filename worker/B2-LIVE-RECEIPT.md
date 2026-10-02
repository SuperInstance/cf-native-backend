# B2 LIVE — wake-on-URL on real Cloudflare Artifacts (first live deploy)

Date: 2026-10-02 ~07:04Z (AKDT 2026-10-01 late evening). Keeper-executed.

The Membrane Worker now runs against a REAL Artifacts namespace + a REAL
cell repo. This closes B2's "no live deploy" gap and opens the live gate
for B3.5. `repo IS the runtime` is now live, not a mock.

## Live result

```
GET https://quilt-b2-membrane.casey-digennaro.workers.dev/cell/hello
→ awake: true
  tip 95bc10291ee1b4ed == expected (tipMatch true), 1000 positions (countMatch true)
  chainOk: true, firstBreakAt: null
  wake total_ms: 178 (fetch 178, verify replay ~0 at 1000 positions)
GET / → {"build":"b2-membrane","scheme":"fnv1a-64-chain-v1","wake":"GET /cell/<id>[?tail=1..64]"}
```

## Exact recipe (tool-use findings — read this before touching Artifacts)

1. **Namespace auto-provisions on `repos create`.** `wrangler artifacts
   namespaces` has NO `create` subcommand (checked 4.118.0 AND 4.146.0 via
   npx). Creating the first repo auto-creates the namespace. Do NOT try to
   POST `/artifacts/namespaces` with the key.txt CF_API_TOKEN — that token is
   not Artifacts-scoped (auth error), and it is unnecessary anyway.

2. **Create repo:**
   ```
   wrangler artifacts repos create cell-hello --namespace default --default-branch main --json
   # → { id, remote, token }; token = "art_v2_...?expires=<unix_seconds>"
   ```

3. **Push (Bearer form, keeps token out of the URL):**
   ```
   git -c http.extraHeader="Authorization: Bearer $TOKEN" push origin HEAD:main
   ```
   The FULL token string (including `?expires=`) goes in the Bearer header.
   The Basic-auth URL form uses only the secret (token minus `?expires=`).

4. **Deploy:** `cd worker && wrangler deploy` — 4.118.0 handles the artifacts
   binding fine. (The ≥4.145.0 note in B2-RECEIPT was about generated types /
   local-dev remote-binding Blob methods, not about `deploy`.)

## Still unverified

- 1M-position CPU limits (this run: 1000 positions; verify replay ~0 ms).
- B3.4 `/diff` + `/merge` endpoints (`worker/src/git-api.ts`) are NOT yet wired
  into `index.ts` — still standalone; wiring them into a route is the next
  live step toward the full quilt-as-git surface.
- Repo token TTL enforcement / revoke in practice (vs the `?expires=` claim).
- `fork()` + minted write-token flow (B3 write path) not yet exercised live.
