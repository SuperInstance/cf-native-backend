# B4-RECEIPT — the web surface (timeline / rewind / doubt-query)

Branch `b4-web` (from `main` @ a0448b3). Add-only: two new modules + three new
routes. Nothing existing was deleted or changed in behavior; the B2 wake route,
the B3.6 `POST /diff` / `POST /merge` routes, `GET /` and `GET /health` are
byte-compatible (the banner only gained additive `ui` / `quilt` fields).

## What was built

A minimal but REAL browser surface for the quilt — the UX 25% and the demo
surface for the contest video (docs/BUILD-PLAN.md §3, docs/QUILT-AS-GIT.md
"flow-state"). Vanilla JS, inline, **no build step, no framework, no CDN**.

### 1. `worker/src/webui.ts` — the page (`GET /ui`)
A self-contained HTML+JS document (zero runtime imports — that is deliberate and
is itself under test). It renders, from a live Artifacts quilt repo:

- **Routing view** — every cell (address, tip, count, opcode set, chain verdict)
  and every edge (`<from> qm_* <to>`), i.e. the tensor.
- **Timeline / rewind** — the first-parent commit log; click any commit to view
  that commit's quilt state; "rewind to HEAD" returns. The commit id *is* the
  rewind address — no separate storage.
- **Doubt-query** — a box that searches the receipt/routing ledger for a cell,
  opcode, tip or edge and reports, per hit, whether the chain **proves** it or
  names where it breaks ("what trust lets through"). Empty query ⇒ whole-quilt
  verdict; no match ⇒ explicit "(absence is not proof; it is doubt.)".
- Graceful degradation: the HTML is static. If `/quilt/<repo>` 404s/500s (no
  live Artifacts, empty repo), the page still renders and shows the error in a
  banner — it never needs live data to load.

### 2. `worker/src/quilt-api.ts` — the read feed (`GET /quilt/<repo>`)
One read-only endpoint that returns everything the UI needs in one round-trip:
`log` (timeline), `cells` (manifest + chain verdict + receipt tail), `edges`
(state vs. ledger), `routing` (ROUTE_ADD/DEL/MERGE ops + chain verdict), and
`quilt` (the whole-quilt verdict from `verifyQuilt`, B3.1). Uses the same
`ArtifactsRepoReader` the B3 diff core speaks — **read-only, holds no state**
(design invariant I1). `?ref=<sha|branch>` renders any commit's state (rewind);
`?limit=N`, `?tail=N` bound the response.

### 3. `worker/src/index.ts` — wiring (add-only)
- `GET /ui` (and `/ui/`) → `webui.ts`
- `GET /quilt/<repo>` → `quilt-api.ts`
- `GET /` banner gained additive `ui` and `quilt` fields + build tag
  `b2-membrane+b3-6-git-api+b4-web`.

## How to reach the UI

- Deployed (after the keeper deploys): `https://<worker>/ui` and
  `https://<worker>/ui?repo=<quilt-repo>`.
- Data: `GET https://<worker>/quilt/<repo>` ·
  `GET https://<worker>/quilt/<repo>?ref=<sha>` (rewind) · `?limit=N&tail=N`.
- The UI fetches `/quilt/<repo>` relative to its own origin, so `?repo=` on the
  page selects which quilt to wake.

## Reproduce / verify

```bash
cd worker
npm run typecheck      # tsc --noEmit, strict — exit 0
npm run smoke:web      # node --experimental-strip-types test/b4-web-smoke.mjs
# → B4 WEB SMOKE: PASS   (UI_HTML 13265 bytes · GET /ui 200 · GET /ui/ 200 · 404s held)

# full-router build (no deploy, no upload):
wrangler deploy --dry-run --outdir /tmp/b4-dryrun   # exit 0, 71.4 KiB
```

Offline router drive (ad-hoc, stub ARTIFACTS; verified during this build):

| request | result |
|---|---|
| `GET /` | 200 JSON, build `…+b4-web`, `ui`/`quilt` advertised |
| `GET /ui` | 200, `text/html; charset=utf-8`, 13265 bytes |
| `GET /ui/` | 200, same page |
| `GET /quilt/quilt-demo` | 404 JSON `repo_not_found` (graceful — no live repo; UI renders the error) |
| `GET /nope` | 404 (B2 shape kept) |
| `GET /cell/z` | 404 `cell_not_found` (B2 wake route intact) |
| `POST /diff` | routed to git-api (its own error shape) |

## What was verified vs. unverified

**Verified (local):** `npm run typecheck` exit 0 (strict); `npm run smoke:web`
PASS (handler returns 200 + the HTML string, trailing-slash and 404 behavior
held); `wrangler deploy --dry-run` builds the wired Worker; the dry-run bundle
drives `/ui` and `/quilt/<repo>` correctly with a stub binding, and every B2 /
B3.6 route is unchanged.

**Unverified (needs live Cloudflare / real data):**
1. The page against a **real** Artifacts quilt repo — the JSON shape is coded to
   `verifyQuilt` + `ArtifactsCommitMetadata` (from the generated types), so the
   field names are typed, but no live repo has rendered the page end-to-end yet.
2. `readFile`-per-cell fan-out cost at scale (one RPC per cell manifest + tail);
   fine for the 4-cell demo quilt, unmeasured for large quilts.
3. Browser rendering/UX in a real browser at a real worker URL (the JS is
   vanilla and the DOM ids are asserted structurally, but it has not been
   clicked by a human yet).
4. No deploy was performed from this branch — **the keeper deploys**.

## Notes for the demo (video)

The three surfaces map to the narrative beats: **routing view** = "the
connection is the unit"; **rewind** = "rewind to any state"; **doubt-query** =
"what trust lets through" (the receipt chain as the thing that answers). The
merge itself stays on `POST /diff` + `POST /merge` (B3.6) — the UI views, it
does not write; that is the honest seam and it keeps the read surface free to
hand out.
