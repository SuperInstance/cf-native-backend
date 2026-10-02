/**
 * git-api.ts — B3.4: the standalone Worker surface for the merge review.
 *
 * A fetch-handler module (default export) exposing the two read-only compute
 * endpoints of the QUILT-AS-GIT merge surface (docs/B3-DESIGN.md §3.2):
 *
 *   POST /diff   { base, fork, main, repos? }                → the semantic diff
 *   POST /merge  { base, fork, main, resolutions, repos? }   → resolved quilt
 *                                                              + decisions
 *                                                              + push manifest
 *
 * Both endpoints are PURE COMPUTE over the Artifacts binding: they read
 * (tree/blob/file/commit), diff, and resolve. They do **not** push and do
 * **not** mutate repo content. The only side effect is that POST /merge mints
 * the ≤300 s single-use write token the P2 pusher needs (§3.2 step sequence:
 * re-derive → validate → mint → emit manifest). Revocation is the executor's
 * job (`manifest.revoke`) or the merge handler's compensating action.
 *
 * Wiring into index.ts / wrangler routes is DEFERRED — this module is additive
 * and self-contained; nothing existing imports it.
 *
 * Ref handling: because a fork and main are separate repos, the union adapter
 * would be ambiguous for a branch name present in both. This handler therefore
 * resolves each ref to a commit SHA **against its designated repo** before the
 * union diff:
 *   body.main → repos.main ; body.fork → repos.fork ; body.base → repos.fork
 * (the fork repo contains the fork-point objects, §1.1).
 *
 * Merge authority (§3.2): when `MERGE_SECRET` is set in the env, POST /merge
 * requires the `x-merge-secret` header to match. When it is unset the module
 * runs open — dev/offline mode — and says so in the response.
 */

import { ArtifactsRepoReader } from "./artifacts-reader.js";
import { diffMerge } from "./diff.js";
import {
  mergeQuilt,
  type Resolutions,
  type SequentializeOrder,
} from "./merge.js";
import {
  proposePush,
  type CreateTokenFn,
  PUSH_TTL_SECONDS,
  type PushPackage,
} from "./pusher.js";

export interface GitApiEnv {
  ARTIFACTS: Artifacts;
  /** default landing (main) repo name; default "quilt-demo". */
  QUILT_REPO?: string;
  /** default fork repo name; default "<main>--task". */
  FORK_REPO?: string;
  /** shared merge secret (§3.2); unset ⇒ open (dev/offline) mode. */
  MERGE_SECRET?: string;
}

export interface GitApiOptions {
  defaultMainRepo?: string;
  defaultForkRepo?: string;
  /** merge-window token TTL; clamped ≤ 300 s. */
  ttlSeconds?: number;
}

interface RepoRefs {
  main: string;
  fork: string;
}

interface DiffBody {
  base: string;
  fork: string;
  main: string;
  repos?: { main?: string; fork?: string };
  quilt?: string;
  forkName?: string;
}

interface MergeBody extends DiffBody {
  resolutions?: Resolutions;
  tokenTtlSeconds?: number;
  sequentializeOrder?: SequentializeOrder;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function resolveRepos(
  env: GitApiEnv,
  body: DiffBody,
  options: GitApiOptions,
): RepoRefs {
  const main =
    body.repos?.main ??
    body.quilt ??
    options.defaultMainRepo ??
    env.QUILT_REPO ??
    "quilt-demo";
  const fork =
    body.repos?.fork ??
    options.defaultForkRepo ??
    env.FORK_REPO ??
    (body.forkName !== undefined ? `${main}--${body.forkName}` : `${main}--task`);
  return { main, fork };
}

/** Open the union reader and resolve the three refs to SHAs (per repo). */
async function openReader(
  env: GitApiEnv,
  body: DiffBody,
  options: GitApiOptions,
): Promise<{
  reader: ArtifactsRepoReader;
  repos: RepoRefs;
  shas: { base: string; fork: string; main: string };
}> {
  const repos = resolveRepos(env, body, options);
  const reader = new ArtifactsRepoReader(env.ARTIFACTS, [repos.fork, repos.main]);
  const main = await reader.resolveRef(repos.main, body.main);
  const fork = await reader.resolveRef(repos.fork, body.fork);
  const base = await reader.resolveRef(repos.fork, body.base);
  return { reader, repos, shas: { base, fork, main } };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireRefs(body: Record<string, unknown>): DiffBody {
  for (const key of ["base", "fork", "main"] as const) {
    const v = body[key];
    if (typeof v !== "string" || v === "") {
      throw new Error(`missing required ref "${key}"`);
    }
  }
  return body as unknown as DiffBody;
}

async function handleDiff(env: GitApiEnv, body: DiffBody): Promise<Response> {
  const { reader, shas } = await openReader(env, body, {});
  try {
    const d = await diffMerge(reader, shas.fork, shas.main, shas.base);
    return json({
      ok: true,
      base: d.base,
      fork: d.fork,
      main: d.main,
      fastPath: d.fastPath,
      units: d.units,
      conflicts: d.conflicts,
      idempotent: d.idempotent,
      forkOnly: d.forkOnly,
      mainOnly: d.mainOnly,
      routing: d.routing,
      ignoredPaths: d.ignoredPaths,
      unknownPaths: d.unknownPaths,
    });
  } finally {
    reader[Symbol.dispose]();
  }
}

async function handleMerge(
  request: Request,
  env: GitApiEnv,
  raw: Record<string, unknown>,
): Promise<Response> {
  if (env.MERGE_SECRET !== undefined && env.MERGE_SECRET !== "") {
    const got = request.headers.get("x-merge-secret");
    if (got !== env.MERGE_SECRET) {
      return json({ error: "unauthorized", hint: "x-merge-secret required" }, 401);
    }
  }

  const body = requireRefs(raw) as MergeBody;
  const resolutions: Resolutions = body.resolutions ?? {};
  const { reader, repos, shas } = await openReader(env, body, {});
  try {
    // Re-derive; never trust a cached proposal (§3.2).
    const d = await diffMerge(reader, shas.fork, shas.main, shas.base);

    // Validate the resolutions cover exactly the conflict set, before minting.
    const conflictSet = new Set(d.conflicts);
    const unresolved = d.conflicts.filter((u) => resolutions[u] === undefined);
    const unknownResolutions = Object.keys(resolutions)
      .filter((k) => !conflictSet.has(k))
      .sort();
    if (unresolved.length > 0 || unknownResolutions.length > 0) {
      return json(
        {
          error: "unresolved_conflict",
          base: d.base,
          fork: d.fork,
          main: d.main,
          conflicts: d.conflicts,
          unresolved,
          unknownResolutions,
        },
        409,
      );
    }

    // Mint the ≤300 s single-use write token on MAIN (§3.2), then materialize.
    const ttl = body.tokenTtlSeconds ?? PUSH_TTL_SECONDS;
    const mainRepo = await reader.repo(repos.main);
    const token = await mainRepo.createToken("write", ttl);
    const createToken: CreateTokenFn = (scope, t) => mainRepo.createToken(scope, t);

    const resolved = await mergeQuilt(
      reader,
      shas.fork,
      shas.main,
      shas.base,
      resolutions,
      {
        forkName: body.forkName ?? "fork",
        tokenId: token.id,
        sequentializeOrder: body.sequentializeOrder,
      },
    );
    if (!resolved.ok) {
      // Compensating action: the reviewed merge did not resolve ⇒ burn the token.
      try {
        await mainRepo.revokeToken(token.id);
      } catch {
        /* best-effort revoke */
      }
      return json(
        {
          error: "merge_failed",
          unresolved: resolved.unresolved,
          unknownResolutions: resolved.unknownResolutions,
        },
        409,
      );
    }

    const info = await mainRepo.info();
    const push: PushPackage = await proposePush(
      resolved,
      { createToken },
      {
        remote: info.remote,
        refspec: `HEAD:${info.defaultBranch}`,
        branch: info.defaultBranch,
        token,
        tokenTtlSeconds: ttl,
      },
    );

    return json({
      ok: true,
      base: resolved.base,
      fork: resolved.fork,
      main: resolved.main,
      forkName: resolved.forkName,
      summary: resolved.summary,
      decisions: resolved.decisions,
      conflicts: resolved.conflicts,
      cells: resolved.cells,
      edges: resolved.edges,
      routingOps: resolved.routingOps,
      mergeOp: resolved.mergeOp,
      routing: resolved.routing,
      cellDigest: resolved.cellDigest,
      edgeDigest: resolved.edgeDigest,
      push,
    });
  } finally {
    reader[Symbol.dispose]();
  }
}

async function handle(
  request: Request,
  env: GitApiEnv,
  options: GitApiOptions,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return json({
      build: "b3-4-git-api",
      endpoints: ["POST /diff", "POST /merge"],
      auth: env.MERGE_SECRET ? "merge-secret" : "open (dev)",
    });
  }

  if (request.method !== "POST") {
    return json({ error: "not_found", hint: "POST /diff | POST /merge" }, 404);
  }

  let raw: Record<string, unknown>;
  try {
    raw = await readJson(request);
  } catch (err) {
    return json(
      { error: "bad_request", detail: err instanceof Error ? err.message : String(err) },
      400,
    );
  }

  try {
    if (url.pathname === "/diff") {
      return await handleDiff(env, requireRefs(raw));
    }
    if (url.pathname === "/merge") {
      return await handleMerge(request, env, raw);
    }
    return json({ error: "not_found", hint: "POST /diff | POST /merge" }, 404);
  } catch (err) {
    return json(
      { error: "internal_error", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

/** Build a handler with non-default options (tests / future wiring). */
export function makeGitApi(options: GitApiOptions = {}): ExportedHandler<GitApiEnv> {
  return {
    async fetch(request: Request, env: GitApiEnv): Promise<Response> {
      return handle(request, env, options);
    },
  };
}

export default makeGitApi();
