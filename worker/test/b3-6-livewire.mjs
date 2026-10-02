/**
 * b3-6-livewire.mjs — B3.6 offline rehearsal: the router dispatch.
 *
 * B3.6's job is a WIRING change: `src/index.ts` (the B2 membrane router) must
 * forward `POST /diff` and `POST /merge` to the B3.4 git-api handler while
 * KEEPING `GET /`, `GET /health` and `GET /cell/<id>` byte-for-byte intact.
 *
 * Because `src/index.ts` uses `using` (explicit resource management), Node 22
 * cannot import it directly. So this rig verifies the artifact that would
 * actually ship: it asks wrangler for a `--dry-run` build (the same esbuild
 * bundle `wrangler deploy` would upload), imports THAT bundle, and drives the
 * router's `fetch` with a stub ARTIFACTS binding.
 *
 * Zero Cloudflare, zero network, zero deploy: `--dry-run` bundles locally and
 * exits before any upload. The stub binding exists only to prove *routing* —
 * the compute itself is proven by test/worker-rehearsal.mjs (B3.4).
 *
 * Asserted:
 *   1. `wrangler deploy --dry-run` builds the wired Worker (exit 0).
 *   2. GET / and GET /health  → 200, B2 fields kept, git_api routes advertised.
 *   3. GET /cell/<id>         → still routed to wakeCell (404 cell_not_found).
 *   4. POST /diff             → routed to git-api (its own error shape, not B2's).
 *   5. POST /merge            → routed to git-api; MERGE_SECRET is honoured
 *                               (401 without the header, open when unset).
 *   6. GET /diff, POST /nope  → still the B2 404 (nothing else was widened).
 *
 * Usage: node --experimental-strip-types test/b3-6-livewire.mjs
 *        B36_BUNDLE=/path/to/index.js node ... test/b3-6-livewire.mjs   # skip build
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(HERE, "..");

const failures = [];
function check(cond, label) {
  if (!cond) failures.push(label);
}
const arrEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// =========================================================================
// (1) build the artifact the keeper would deploy (local bundle only)
// =========================================================================

let scratch = null;
let bundle = process.env.B36_BUNDLE ?? "";
if (bundle === "") {
  scratch = mkdtempSync(path.join(tmpdir(), "b36-livewire-"));
  const build = spawnSync(
    "wrangler",
    ["deploy", "--dry-run", "--outdir", scratch],
    { cwd: WORKER_DIR, encoding: "utf8" },
  );
  check(
    build.status === 0,
    `wrangler deploy --dry-run exit ${build.status}: ${(build.stderr ?? "").slice(0, 400)}`,
  );
  bundle = path.join(scratch, "index.js");
  check(existsSync(bundle), `dry-run bundle exists at ${bundle}`);
  if (build.status === 0) {
    console.log(`(1) wrangler deploy --dry-run → bundled ${bundle}`);
  }
}

const worker = (await import(pathToFileURL(bundle).href)).default;
check(typeof worker?.fetch === "function", "router default export exposes fetch()");

// =========================================================================
// a stub ARTIFACTS binding — enough to watch ROUTING, nothing more
// =========================================================================

let getMode = "throw"; // "throw" | "repo"
const mock = {
  async get(name) {
    if (getMode === "throw") throw new Error(`stub: no repo "${name}" in this test`);
    return {
      async readCommit() {
        throw new Error("stub-repo: readCommit unsupported");
      },
      async log() {
        throw new Error("stub-repo: log unsupported");
      },
      async info() {
        return { remote: "stub://remote", defaultBranch: "main" };
      },
      async createToken(_scope, ttl) {
        return { id: "tok_stub", token: "art_v2_stub", ttlSeconds: ttl };
      },
      async revokeToken() {},
      [Symbol.dispose]() {},
    };
  },
};

const env = { ARTIFACTS: mock };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const hit = (method, p, body, headers = {}, e = env) =>
  worker.fetch(
    new Request(`https://quilt-b2-membrane.test${p}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    e,
    ctx,
  );

// =========================================================================
// (2) the B2 surface is untouched
// =========================================================================

getMode = "throw";

const root = await hit("GET", "/");
const rootJson = await root.json();
check(root.status === 200, `GET / → 200 (got ${root.status})`);
check(
  typeof rootJson.build === "string" && rootJson.build.startsWith("b2-membrane"),
  `GET / keeps the B2 build banner (got ${JSON.stringify(rootJson.build)})`,
);
check(rootJson.wake === "GET /cell/<id>[?tail=1..64]", "GET / keeps the wake route");
check(
  arrEq(rootJson.git_api ?? [], ["POST /diff", "POST /merge"]),
  `GET / advertises the git-api routes (got ${JSON.stringify(rootJson.git_api)})`,
);

const health = await hit("GET", "/health");
const healthJson = await health.json();
check(health.status === 200, `GET /health → 200 (got ${health.status})`);
check(healthJson.wake === rootJson.wake, "GET /health == GET / (same banner)");

// GET /cell/<id> still wakes (the stub has no repo ⇒ the B2 404 shape)
const cell = await hit("GET", "/cell/hello?tail=4");
const cellJson = await cell.json();
check(cell.status === 404, `GET /cell/hello → 404 via the stub (got ${cell.status})`);
check(cellJson.error === "cell_not_found", `GET /cell/hello is the B2 handler (got ${JSON.stringify(cellJson.error)})`);
check(cellJson.repo === "cell-hello", `GET /cell/hello resolved repo cell-hello (got ${JSON.stringify(cellJson.repo)})`);

// =========================================================================
// (3) POST /diff + POST /merge are wired to the git-api
// =========================================================================

// An empty body is not a routing failure: git-api rejects it with its OWN
// error shape. B2's router would have answered {error:"not_found", ...} 404.
const diffEmpty = await hit("POST", "/diff", {});
const diffEmptyJson = await diffEmpty.json();
check(diffEmpty.status !== 404, `POST /diff is NOT the B2 404 (got ${diffEmpty.status})`);
check(
  /missing required ref "base"/.test(diffEmptyJson.detail ?? ""),
  `POST /diff reached the git-api body validator (got ${JSON.stringify(diffEmptyJson)})`,
);

// With real refs the handler enters the compute path — our stub then fails
// inside the adapter, which is exactly the proof that the request travelled
// router → git-api → ArtifactsRepoReader → ARTIFACTS.
getMode = "repo";
const diffReal = await hit("POST", "/diff", {
  base: "0000000000000000000000000000000000000000",
  fork: "HEAD",
  main: "HEAD",
  repos: { main: "quilt-demo", fork: "quilt-demo--task" },
});
const diffRealJson = await diffReal.json();
check(diffReal.status === 500, `POST /diff w/ refs → stub 500 (got ${diffReal.status})`);
check(
  /resolveRef/.test(diffRealJson.detail ?? ""),
  `POST /diff entered the adapter compute path (got ${JSON.stringify(diffRealJson).slice(0, 160)})`,
);

// MERGE_SECRET plumbing: the router's Env is forwarded to the git-api handler.
const secretEnv = { ...env, MERGE_SECRET: "s3cret" };
const mergeNoHeader = await hit("POST", "/merge", {}, {}, secretEnv);
const mergeNoHeaderJson = await mergeNoHeader.json();
check(mergeNoHeader.status === 401, `POST /merge, secret set, no header → 401 (got ${mergeNoHeader.status})`);
check(mergeNoHeaderJson.error === "unauthorized", "POST /merge 401 is the git-api's (MERGE_SECRET was read)");
check(mergeNoHeaderJson.hint === "x-merge-secret required", "POST /merge 401 names the header");

const mergeWithHeader = await hit("POST", "/merge", {}, { "x-merge-secret": "s3cret" }, secretEnv);
check(mergeWithHeader.status !== 401, `POST /merge, secret set + header → passes auth (got ${mergeWithHeader.status})`);

const mergeOpen = await hit("POST", "/merge", {}, {}, env); // MERGE_SECRET unset
const mergeOpenJson = await mergeOpen.json();
check(mergeOpen.status !== 401, `POST /merge, no secret set → open dev mode (got ${mergeOpen.status})`);
check(
  /missing required ref "base"/.test(mergeOpenJson.detail ?? ""),
  `POST /merge open mode reached the body validator (got ${JSON.stringify(mergeOpenJson)})`,
);

// =========================================================================
// (4) nothing else was widened
// =========================================================================

const getDiff = await hit("GET", "/diff");
const getDiffJson = await getDiff.json();
check(getDiff.status === 404, `GET /diff stays B2 404 (got ${getDiff.status})`);
check(getDiffJson.error === "not_found", "GET /diff is the B2 not_found (POST-only dispatch)");

const postNope = await hit("POST", "/nope", {});
const postNopeJson = await postNope.json();
check(postNope.status === 404, `POST /nope → 404 (got ${postNope.status})`);
check(postNopeJson.error === "not_found", "POST /nope is the B2 not_found");

const putCell = await hit("PUT", "/cell/hello");
check(putCell.status === 404, `PUT /cell/hello → 404 (wake stays GET-only, got ${putCell.status})`);

console.log("(2) B2 surface intact — GET / + /health banner, GET /cell/<id> → wakeCell");
console.log("(3) git-api wired — POST /diff → handler, POST /merge → handler (+ MERGE_SECRET 401)");
console.log("(4) no widening — GET /diff 404, POST /nope 404, PUT /cell/<id> 404");

// =========================================================================

if (scratch !== null) rmSync(scratch, { recursive: true, force: true });

console.log("\n--- summary ---");
console.log("router:   src/index.ts dispatches POST /diff + POST /merge → makeGitApi(); B2 routes unchanged");
console.log("artifact: verified against the wrangler --dry-run bundle (esbuild, the deploy artifact)");
console.log("binding:  stub ARTIFACTS (routing proof only — compute is B3.4's worker-rehearsal)");

if (failures.length > 0) {
  console.error(`\nB3.6 LIVEWIRE REHEARSAL FAIL (${failures.length}):`);
  for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nB3.6 LIVEWIRE OK — router dispatches the git-api surface; B2 wake surface untouched");
