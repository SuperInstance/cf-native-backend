/**
 * index.ts — B2 Membrane Worker: wake-on-URL for a lattice cell.
 *
 * GET /cell/<id>
 *   → open the cell's Artifacts repo (binding ARTIFACTS)
 *   → read memory files (receipts.txt + genesis.json) via readFile
 *   → verify the fnv1a-64 chain genesis→tip (chain.ts — the B1 physics)
 *   → return cell state + receipt tail + wake timings
 *
 * The repo IS the runtime: the Worker holds no cell state; a cell exists
 * only as its Artifacts repo, and wakes when its URL is hit.
 *
 * Deliberately NOT here (B3/B4): concurrency, forking, merge surface, UI.
 */

import {
  SCHEME,
  verifyChain,
  type Genesis,
} from "./chain.js";

export interface Env {
  ARTIFACTS: Artifacts;
}

const REPO_PREFIX = "cell-";
const DEFAULT_BRANCH = "main"; // cell repos are minted with setDefaultBranch "main"

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      return json({
        build: "b2-membrane",
        scheme: SCHEME,
        wake: "GET /cell/<id>[?tail=1..64]",
      });
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
