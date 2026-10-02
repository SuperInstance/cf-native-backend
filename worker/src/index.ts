/**
 * index.ts — the Membrane Worker router.
 *
 * B2 surface (wake-on-URL for a lattice cell):
 *   GET /cell/<id>
 *     → open the cell's Artifacts repo (binding ARTIFACTS)
 *     → read memory files (receipts.txt + genesis.json) via readFile
 *     → verify the fnv1a-64 chain genesis→tip (chain.ts — the B1 physics)
 *     → return cell state + receipt tail + wake timings
 *   GET / (and GET /health)
 *     → build banner + the surface's route list
 *
 * B3.6 surface (the git-api, wired live here):
 *   POST /diff   { base, fork, main, repos? }               → semantic diff
 *   POST /merge  { base, fork, main, resolutions, repos? }  → resolved quilt
 *                                                             + push manifest
 *   (worker/src/git-api.ts, B3.4 — read-only compute over ARTIFACTS; the only
 *   side effect is POST /merge minting the ≤300 s single-use write token.)
 *
 * This file is a ROUTER only: it dispatches to `wakeCell` (B2) or to the
 * git-api handler (B3.6) and holds no cell state of its own.
 *
 * The repo IS the runtime: the Worker holds no cell state; a cell exists
 * only as its Artifacts repo, and wakes when its URL is hit.
 *
 * B4 surface (the browser surface + its read endpoint), wired here add-only:
 *   GET  /ui                      → the quilt web UI (worker/src/webui.ts)
 *   GET  /quilt/<repo>[?ref=…]    → read-only quilt state JSON for the UI
 *                                   (worker/src/quilt-api.ts)
 *
 * Deliberately NOT here (B4+): concurrency orchestration, forking, auth.
 */

import {
  SCHEME,
  verifyChain,
  type Genesis,
} from "./chain.js";
import { makeGitApi, type GitApiEnv } from "./git-api.js";
import { makeQuiltApi, type QuiltApiEnv } from "./quilt-api.js";
import { makeWebUi } from "./webui.js";

/**
 * Worker bindings + vars. Extends the git-api env (B3.4) so one `Env` serves
 * both surfaces: `ARTIFACTS` (binding) plus the OPTIONAL git-api vars
 * `QUILT_REPO` / `FORK_REPO` / `MERGE_SECRET` (unset ⇒ documented defaults;
 * unset MERGE_SECRET ⇒ open dev/offline mode).
 */
export interface Env extends GitApiEnv {}

/**
 * One git-api handler instance per isolate (B3.6). It is stateless — a pure
 * dispatcher over the request + env — so reuse is safe and avoids re-allocating
 * the closure per request.
 */
const gitApi: ExportedHandler<GitApiEnv> = makeGitApi();

/**
 * B4 handlers, one instance per isolate, same statelessness argument as gitApi:
 * the read-only quilt data endpoint (GET /quilt/<repo>) and the UI page
 * (GET /ui). Both hold no cell state.
 */
const quiltApi = makeQuiltApi();
const webUi = makeWebUi();

const REPO_PREFIX = "cell-";
const DEFAULT_BRANCH = "main"; // cell repos are minted with setDefaultBranch "main"

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export default {
  // `request` is left to contextual typing from `satisfies ExportedHandler`
  // (its CF-properties type is narrower than the lib's default `Request`).
  async fetch(request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      return json({
        build: "b2-membrane+b3-6-git-api+b4-web",
        scheme: SCHEME,
        wake: "GET /cell/<id>[?tail=1..64]",
        git_api: ["POST /diff", "POST /merge"],
        ui: "GET /ui",
        quilt: "GET /quilt/<repo>[?ref=<sha|branch>][?limit=N][?tail=N]",
      });
    }

    // B4 — the browser surface (static HTML page) and its read-only data feed.
    // Add-only: nothing above changes; GET /ui and GET /quilt/<repo> are new.
    if (
      request.method === "GET" &&
      (url.pathname === "/ui" || url.pathname === "/ui/")
    ) {
      return webUi.fetch(request);
    }
    if (
      request.method === "GET" &&
      /^\/quilt\/[a-z0-9][a-z0-9-]{0,62}$/.test(url.pathname)
    ) {
      return quiltApi.fetch(request, env as QuiltApiEnv);
    }

    // B3.6 — dispatch the git-api surface (B3.4). Only these two POST routes
    // are forwarded; every GET (and everything else) falls through to the B2
    // wake surface below, unchanged.
    if (
      request.method === "POST" &&
      (url.pathname === "/diff" || url.pathname === "/merge")
    ) {
      return gitApi.fetch!(request, env, ctx);
    }

    const m = /^\/cell\/([a-z0-9][a-z0-9-]{0,62})$/.exec(url.pathname);
    if (request.method === "GET" && m) {
      return wakeCell(env, m[1]!, url);
    }

    return json({ error: "not_found", hint: "GET /cell/<id>" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function wakeCell(env: Env, id: string, url: URL): Promise<Response> {
  const t0 = performance.now();
  const repoName = REPO_PREFIX + id;

  let tailKeep = Number(url.searchParams.get("tail") ?? "8");
  if (!Number.isFinite(tailKeep)) tailKeep = 8;
  tailKeep = Math.min(64, Math.max(1, Math.trunc(tailKeep)));

  let repo: ArtifactsRepo;
  try {
    repo = await env.ARTIFACTS.get(repoName);
  } catch (err) {
    return json(
      {
        error: "cell_not_found",
        repo: repoName,
        detail: err instanceof Error ? err.message : String(err),
      },
      404,
    );
  }
  using cell = repo; // disposable handle — released before the request ends

  const receiptsBlob = await cell.readFile({
    ref: DEFAULT_BRANCH,
    path: "receipts.txt",
  });
  const genesisBlob = await cell.readFile({
    ref: DEFAULT_BRANCH,
    path: "genesis.json",
  });
  if (receiptsBlob === null || genesisBlob === null) {
    return json(
      {
        error: "cell_not_found",
        repo: repoName,
        detail: `expected receipts.txt + genesis.json on branch "${DEFAULT_BRANCH}"`,
      },
      404,
    );
  }
  const tFetch = performance.now();

  const [receiptsText, genesisRaw] = await Promise.all([
    receiptsBlob.text(),
    genesisBlob.text(),
  ]);
  const genesis = JSON.parse(genesisRaw) as Genesis;
  if (genesis.scheme !== SCHEME) {
    return json(
      {
        error: "scheme_mismatch",
        expected: SCHEME,
        got: genesis.scheme,
        repo: repoName,
      },
      422,
    );
  }

  const tDecode = performance.now();
  const v = verifyChain(receiptsText, genesis, tailKeep);
  const tVerify = performance.now();

  const verifyMs = tVerify - tDecode;
  return json(
    {
      cell: id,
      repo: repoName,
      awake: v.ok,
      scheme: v.scheme,
      chain: {
        positions: v.positions,
        tip: v.tip,
        expectedTip: v.expectedTip,
        tipMatch: v.tipMatch,
        expectedCount: v.expectedCount,
        countMatch: v.countMatch,
        chainOk: v.chainOk,
        firstBreakAt: v.firstBreakAt,
      },
      receipt_tail: v.tail,
      wake: {
        fetch_ms: +(tFetch - t0).toFixed(1),
        decode_ms: +(tDecode - tFetch).toFixed(1),
        verify_replay_ms: +verifyMs.toFixed(1),
        total_ms: +(tVerify - t0).toFixed(1),
        positions_per_sec:
          verifyMs > 0 ? Math.round(v.positions / (verifyMs / 1000)) : null,
      },
    },
    v.ok ? 200 : 500,
  );
}
