/**
 * quilt-api.ts — B4: the read-only data endpoint behind the web surface.
 *
 *   GET /quilt/<repo>[?ref=<sha|branch>][?limit=N][?tail=N]
 *
 * Reads a LIVE Artifacts quilt repo through the binding (the same
 * `ArtifactsRepoReader` the B3 diff core speaks — read-only, I1) and returns
 * everything the UI needs in one round-trip:
 *
 *   - `log`    — the first-parent commit history (the timeline / rewind axis);
 *   - `cells`  — per-cell manifest + receipt-chain verdict + chain tail;
 *   - `edges`  — the routing STATE (quilt.json) vs MEMORY (routing.txt) diff;
 *   - `routing`— the routing ledger (ROUTE_ADD/DEL/MERGE ops) + chain verdict;
 *   - `quilt`  — the whole-quilt verdict from verifyQuilt (B3.1).
 *
 * With no `?ref`, the repo's default branch is read. With `?ref=<sha>` the
 * SAME shape is returned for that commit — that is the "rewind to any state"
 * primitive; no separate storage, the commit id *is* the address.
 *
 * This module never writes and holds no state (design invariant I1). It is
 * separate from git-api.ts (POST /diff, POST /merge) on purpose: the surface
 * reads here and writes there, so the read path can be handed out freely.
 */

import { ArtifactsRepoReader } from "./artifacts-reader.js";
import { verifyChain, type Genesis } from "./chain.js";
import {
  parseRoutingOps,
  verifyQuilt,
  type CellManifest,
  type QuiltCellInput,
  type QuiltFiles,
} from "./quilt.js";

export interface QuiltApiEnv {
  ARTIFACTS: Artifacts;
  /** default repo when a bare GET /quilt is hit; also the UI's default. */
  QUILT_REPO?: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function clampInt(
  raw: string | null,
  lo: number,
  hi: number,
  dflt: number,
): number {
  const n = Number(raw ?? "");
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/** Decode an optional file blob to text (null when the path is absent). */
async function readText(
  reader: ArtifactsRepoReader,
  ref: string,
  path: string,
): Promise<string | null> {
  const bytes = await reader.readFile(ref, path);
  if (bytes === null) return null;
  return new TextDecoder().decode(bytes);
}

interface CommitView {
  hash: string;
  treeHash: string;
  message: string;
  author: string;
  parents: string[];
  authoredAt: number;
  committedAt: number;
}

async function handle(
  request: Request,
  env: QuiltApiEnv,
  repoOverride?: string,
): Promise<Response> {
  const url = new URL(request.url);
  const m = /^\/quilt\/([a-z0-9][a-z0-9-]{0,62})$/.exec(url.pathname);
  const repo = repoOverride ?? (m ? m[1]! : env.QUILT_REPO ?? "");
  if (repo === "") {
    return json(
      { ok: false, error: "need_repo", hint: "GET /quilt/<repo>" },
      400,
    );
  }

  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 50);
  const tailKeep = clampInt(url.searchParams.get("tail"), 1, 64, 4);
  const requestedRef = (url.searchParams.get("ref") ?? "").trim();

  const reader = new ArtifactsRepoReader(env.ARTIFACTS, [repo]);
  try {
    const head = await reader.repo(repo);
    const info = await head.info();
    const branch = info.defaultBranch || "main";
    const ref = requestedRef === "" ? branch : requestedRef;

    // Resolve to a commit SHA (the rewind address) and read its metadata.
    const commit = await reader.readCommit(ref);
    const sha = commit.hash;

    // Timeline: first-parent log of the default branch (never the rewind ref,
    // so the list stays the truth even while you are viewing an old commit).
    let logRaw: ArtifactsCommitMetadata[] = [];
    try {
      logRaw = await head.log({ ref: branch, limit });
    } catch {
      logRaw = [];
    }
    const log: CommitView[] = logRaw.map((c) => ({
      hash: c.hash,
      treeHash: c.treeHash,
      message: c.message,
      author: c.author?.name ?? "",
      parents: c.parents,
      authoredAt: c.authoredAt,
      committedAt: c.committedAt,
    }));

    // Quilt state at the resolved commit.
    const quiltJson = await readText(reader, sha, "quilt.json");
    const routingText = (await readText(reader, sha, "routing.txt")) ?? "";
    if (quiltJson === null) {
      return json(
        {
          ok: false,
          error: "no_quilt",
          repo,
          ref: sha,
          log,
          detail: `quilt.json not found at ${sha.slice(0, 10)} on "${branch}"`,
        },
        404,
      );
    }

    let addresses: string[] = [];
    try {
      const parsed = JSON.parse(quiltJson) as { cells?: string[] };
      addresses = [...(parsed.cells ?? [])].sort();
    } catch {
      addresses = [];
    }

    const cells: Record<string, QuiltCellInput> = {};
    const manifests = new Map<string, CellManifest | null>();
    for (const addr of addresses) {
      const manifestJson = await readText(reader, sha, `cells/${addr}/cell.json`);
      const receiptsText =
        (await readText(reader, sha, `cells/${addr}/receipts.txt`)) ?? "";
      cells[addr] = {
        manifestJson: manifestJson ?? "",
        receiptsText,
      };
      let man: CellManifest | null = null;
      if (manifestJson !== null) {
        try {
          man = JSON.parse(manifestJson) as CellManifest;
        } catch {
          man = null;
        }
      }
      manifests.set(addr, man);
    }

    const files: QuiltFiles = { quiltJson, routingText, cells };
    const v = verifyQuilt(files, tailKeep);

    // Re-run the chain walk per cell to attach the receipt TAIL (the doubt
    // ledger the UI queries). verifyQuilt drops per-cell tails; we keep them.
    const cellViews = v.cells.map((c) => {
      const man = manifests.get(c.address) ?? null;
      const input = cells[c.address];
      let tail: { position: number; receipt: string; op: string }[] = [];
      if (man !== null && input) {
        const chain = verifyChain(input.receiptsText, man as Genesis, tailKeep);
        tail = chain.tail;
      }
      return { ...c, tail };
    });

    const ledger = parseRoutingOps(routingText);
    const routing = {
      positions: v.routing.positions,
      tip: v.routing.tip,
      chainOk: v.routing.chainOk,
      tipMatch: v.routing.tipMatch,
      countMatch: v.routing.countMatch,
      ok: v.routing.ok,
      tail: v.routing.tail,
      adds: ledger.adds,
      dels: ledger.dels,
      merges: ledger.merges,
      unknown: ledger.unknown,
    };

    return json({
      ok: true,
      repo,
      ref: sha,
      requestedRef: requestedRef === "" ? branch : requestedRef,
      defaultBranch: branch,
      remote: info.remote,
      commit: { hash: sha, treeHash: commit.tree, parents: commit.parents },
      log,
      quilt: {
        name: v.quilt,
        scheme: v.scheme,
        basis: v.basis,
        ok: v.ok,
        cellsOk: v.cellsOk,
        routingOk: v.routingOk,
        edgeSetOk: v.edgeSetOk,
        problems: v.problems,
      },
      cells: cellViews,
      edges: v.edges,
      routing,
      stats: {
        cells: cellViews.length,
        edges: v.edges.declared.length,
        commits: log.length,
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code;
    const status = code === "NOT_FOUND" ? 404 : 500;
    return json(
      { ok: false, error: status === 404 ? "repo_not_found" : "internal_error", repo, detail },
      status,
    );
  } finally {
    reader[Symbol.dispose]();
  }
}

/** Build the B4 quilt data handler. */
export function makeQuiltApi(
  options: { repo?: string } = {},
): { fetch(request: Request, env: QuiltApiEnv): Promise<Response> } {
  return {
    fetch(request: Request, env: QuiltApiEnv): Promise<Response> {
      return handle(request, env, options.repo);
    },
  };
}

export default makeQuiltApi();
