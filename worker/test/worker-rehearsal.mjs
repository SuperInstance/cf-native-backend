/**
 * worker-rehearsal.mjs — B3.4 offline rehearsal (Artifacts adapter + P2 pusher).
 *
 * The increment's receipt (docs/B3-DESIGN.md §5 row B3.4): bind the B3.2 diff
 * core + B3.3 merge executor to the **Artifacts adapter** (a MOCK of the
 * binding over local bare repos), drive the **P2 external-pusher protocol**
 * (mint a single-use write token + a push manifest), and prove that applying
 * that manifest with a dumb executor to a local bare remote yields the exact
 * reviewed quilt — verified `ok` by quilt.ts. Plus the two git-api endpoints.
 *
 * Zero Cloudflare: nothing here deploys, provisions a namespace, or talks to
 * the network. The "Artifacts binding" is a local shim that returns REAL
 * Artifacts-shaped values (Blob returns, `treeHash` commit metadata,
 * `type`-tagged tree entries) over real git objects.
 *
 * Asserted:
 *   1. ArtifactsRepoReader is a drop-in for RepoReader — the diff through the
 *      adapter is byte-identical to the diff through LocalGit.
 *   2. merge.ts runs unchanged through the adapter (sequentialize + re-mine).
 *   3. The token clamp is ≤300 s and the mint is scope "write".
 *   4. The push manifest round-trips: digest recomputes, entries canonical,
 *      no `task.json`, MERGE-receipt token id == minted token id (fail-closed).
 *   5. A dumb executor (prune + write + commit + push) lands the quilt on a
 *      bare remote; the clone-back verifies ok via quilt.ts.
 *   6. POST /diff and POST /merge return the expected payloads over the mock
 *      env; unresolved ⇒ 409; MERGE_SECRET ⇒ 401.
 *
 * Usage: node --experimental-strip-types test/worker-rehearsal.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node's --experimental-strip-types does not rewrite "./x.js" → "./x.ts".
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL?.endsWith(".ts")
    ) {
      return next(specifier.slice(0, -3) + ".ts", context);
    }
    return next(specifier, context);
  },
});

const { diffMerge } = await import("../src/diff.ts");
const { mergeQuilt } = await import("../src/merge.ts");
const { verifyQuilt } = await import("../src/quilt.ts");
const { ArtifactsRepoReader } = await import("../src/artifacts-reader.ts");
const { LocalGit } = await import("./localgit.mjs");
const {
  proposePush,
  mintPushToken,
  buildPushManifest,
  verifyManifest,
  materializePush,
  mergeTokenId,
  PUSH_TTL_SECONDS,
} = await import("../src/pusher.ts");
const gitApi = (await import("../src/git-api.ts")).default;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const QUILTGEN = path.join(repoRoot, "lattice", "quiltgen.py");

const MAIN_REPO = "quilt-demo";
const FORK_REPO = "quilt-demo--task-1";

// --------------------------------------------------------------------- git io

function git(dir, args, opts = {}) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

const OFF = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = (1n << 64n) - 1n;
function fnv(str) {
  const bytes = new TextEncoder().encode(str);
  let h = OFF;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, "0");
}
const canonicalOp = (op) => String(op).replaceAll("\n", "\\n");
const appendReceipt = (head, op) => fnv(`${head}|${canonicalOp(op)}`);
function mine(ops, basis) {
  let head = basis;
  for (const op of ops) head = appendReceipt(head, op);
  return head;
}

// ---------------------------------------------------------- quilt editing (B3.3)

function appendChain(file, ops, basis) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n").filter((l) => l !== "");
  let head = basis;
  if (lines.length > 0) {
    const last = lines[lines.length - 1];
    head = last.slice(0, last.indexOf(" "));
  }
  const add = [];
  for (const op of ops) {
    head = appendReceipt(head, op);
    add.push(`${head} ${canonicalOp(op)}`);
  }
  writeFileSync(file, lines.concat(add).join("\n") + "\n");
  return { head, count: lines.length + add.length };
}

function editCell(dir, addr, ops) {
  const [type, name] = addr.split("/");
  const cdir = path.join(dir, "cells", type, name);
  const manPath = path.join(cdir, "cell.json");
  const man = JSON.parse(readFileSync(manPath, "utf8"));
  const { head, count } = appendChain(path.join(cdir, "receipts.txt"), ops, man.basis);
  man.tip = head;
  man.count = count;
  writeFileSync(manPath, JSON.stringify(man, null, 2) + "\n");
}

function editEdgeAdd(dir, from, op, to) {
  const qPath = path.join(dir, "quilt.json");
  const q = JSON.parse(readFileSync(qPath, "utf8"));
  const line = `edge ${from} ${op} ${to}`;
  q.edges = [...new Set([...(q.edges || []), line])].sort();
  const { head, count } = appendChain(
    path.join(dir, "routing.txt"),
    [`ROUTE_ADD ${from} ${op} ${to}`],
    q.routing.basis,
  );
  q.routing = { ...q.routing, count, tip: head };
  writeFileSync(qPath, JSON.stringify(q, null, 2) + "\n");
}

function writeTaskJson(dir, task, agent, baseCommit) {
  writeFileSync(
    path.join(dir, "task.json"),
    JSON.stringify(
      {
        task,
        agent,
        base_commit: baseCommit,
        base_routing_tip: null,
        base_cell_tips: {},
        forked_at: "rehearsal",
      },
      null,
      2,
    ) + "\n",
  );
}

function commitAll(dir, role, msg) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: role,
    GIT_AUTHOR_EMAIL: `${role}@local`,
    GIT_COMMITTER_NAME: role,
    GIT_COMMITTER_EMAIL: `${role}@local`,
  };
  git(dir, ["add", "-A"]);
  git(
    dir,
    ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "--allow-empty", "-m", msg],
    { env },
  );
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

// ---------------------------------------------------------------- mock binding

/**
 * MockArtifacts — an in-process stand-in for the `ARTIFACTS` binding, wrapping
 * REAL local git repos via LocalGit and returning values shaped exactly like
 * the generated Artifacts types (Blob, `treeHash`, `type`, `createToken`).
 */
class MockArtifacts {
  constructor(dirs) {
    this.dirs = dirs; // { repoName: dir }
    this.mints = [];
    this.revokes = [];
    this._repos = new Map();
  }

  async get(name) {
    const dir = this.dirs[name];
    if (dir === undefined) {
      const err = new Error(`MockArtifacts: repository "${name}" does not exist`);
      err.code = "NOT_FOUND";
      throw err;
    }
    let repo = this._repos.get(name);
    if (repo === undefined) {
      repo = new MockRepo(name, dir, this);
      this._repos.set(name, repo);
    }
    return repo;
  }

  async create() {
    throw new Error("MockArtifacts.create: not implemented (read-only rehearsal)");
  }
  async list() {
    return { repos: [...this._repos.keys()].map((n) => ({ name: n })), total: this._repos.size };
  }
  async delete() {
    throw new Error("MockArtifacts.delete: never called by design (§6.10)");
  }
  async import() {
    throw new Error("MockArtifacts.import: not implemented");
  }
}

class MockRepo {
  constructor(name, dir, ns) {
    this.name = name;
    this.dir = dir;
    this.ns = ns;
    this.lg = new LocalGit([dir]);
  }

  // ── reads (Artifacts shapes) ──────────────────────────────────────────────
  async readCommit(hashOrRef) {
    let c;
    try {
      c = await this.lg.readCommit(hashOrRef);
    } catch {
      return null;
    }
    return {
      hash: c.hash,
      treeHash: c.tree,
      message: "",
      author: { name: "rehearsal", email: "rehearsal@local" },
      committer: { name: "rehearsal", email: "rehearsal@local" },
      parents: c.parents,
      authoredAt: 0,
      committedAt: 0,
    };
  }

  async readTree(hash) {
    let entries;
    try {
      entries = await this.lg.readTree(hash);
    } catch {
      return null;
    }
    return entries.map((e) => ({
      name: e.name,
      mode: e.mode,
      hash: e.hash,
      type: e.mode === "40000" || e.mode === "040000" ? "tree" : "blob",
    }));
  }

  async readBlob(hash) {
    let bytes;
    try {
      bytes = await this.lg.readBlob(hash);
    } catch {
      return null;
    }
    return new Blob([bytes]);
  }

  async readFile({ ref, path: p }) {
    const bytes = await this.lg.readFile(ref, p);
    return bytes === null ? null : new Blob([bytes]);
  }

  async log() {
    return [];
  }

  async info() {
    return {
      id: `mock-${this.name}`,
      name: this.name,
      description: null,
      defaultBranch: "main",
      createdAt: "1970-01-01T00:00:00Z",
      updatedAt: "1970-01-01T00:00:00Z",
      lastPushAt: null,
      source: null,
      readOnly: false,
      remote: this.dir,
    };
  }

  // ── tokens (the P2 mint) ──────────────────────────────────────────────────
  async createToken(scope = "write", ttl = 86400) {
    const id = `tok-${this.name}-${this.ns.mints.length + 1}`;
    const rec = {
      repo: this.name,
      scope,
      ttl,
      id,
      plaintext: `plaintext-${id}`,
      expiresAt: new Date(1_700_000_000_000 + ttl * 1000).toISOString(),
    };
    this.ns.mints.push(rec);
    return { id, plaintext: rec.plaintext, scope, expiresAt: rec.expiresAt };
  }

  async listTokens() {
    return { tokens: [], total: 0 };
  }

  async revokeToken(tokenOrId) {
    this.ns.revokes.push({ repo: this.name, tokenOrId });
    return true;
  }

  async fork() {
    throw new Error("MockRepo.fork: not implemented (this rehearsal forks with git)");
  }

  [Symbol.dispose]() {}
}

// ------------------------------------------------------- fs map + verify helpers

function writeMap(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, bytes] of files) {
    const fp = path.join(dir, rel);
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, bytes);
  }
}

function mapDir(dir) {
  const out = new Map();
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const ent of readdirSync(abs)) {
      if (rel === "" && ent === ".git") continue;
      const child = rel === "" ? ent : `${rel}/${ent}`;
      if (statSync(path.join(dir, child)).isDirectory()) walk(child);
      else out.set(child, readFileSync(path.join(dir, child)));
    }
  };
  walk("");
  return out;
}

function quiltFilesFromDir(dir) {
  const quiltJson = readFileSync(path.join(dir, "quilt.json"), "utf8");
  const quilt = JSON.parse(quiltJson);
  const cells = {};
  for (const addr of quilt.cells ?? []) {
    const cdir = path.join(dir, "cells", ...addr.split("/"));
    cells[addr] = {
      manifestJson: readFileSync(path.join(cdir, "cell.json"), "utf8"),
      receiptsText: readFileSync(path.join(cdir, "receipts.txt"), "utf8"),
    };
  }
  return { quiltJson, routingText: readFileSync(path.join(dir, "routing.txt"), "utf8"), cells };
}

const cellDir = (dir, addr) => path.join(dir, "cells", ...addr.split("/"));
const readCellReceipts = (dir, addr) => readFileSync(path.join(cellDir(dir, addr), "receipts.txt"), "utf8");
const readCellManifest = (dir, addr) => JSON.parse(readFileSync(path.join(cellDir(dir, addr), "cell.json"), "utf8"));
const cellOps = (dir, addr) =>
  readCellReceipts(dir, addr).split("\n").filter((l) => l !== "").map((l) => l.slice(l.indexOf(" ") + 1));
const routingOps = (dir) =>
  readFileSync(path.join(dir, "routing.txt"), "utf8").split("\n").filter((l) => l !== "").map((l) => l.slice(l.indexOf(" ") + 1));

// --------------------------------------------------------------- assertions

const failures = [];
function check(cond, label) {
  if (!cond) failures.push(label);
}
const arrEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const sameMap = (a, b) => {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w === undefined || !sameBytes(v, w)) return false;
  }
  return true;
};

/**
 * The dumb executor's only repo logic: make `dir` hold EXACTLY the manifest's
 * tree — prune every tracked file the manifest omits, then write every entry.
 * (The manifest is the complete final tree; the executor has no discretion.)
 */
function applyManifestToDir(dir, manifest) {
  const want = new Set(manifest.entries.map((e) => e.path));
  const have = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const ent of readdirSync(abs)) {
      if (rel === "" && ent === ".git") continue;
      const child = rel === "" ? ent : `${rel}/${ent}`;
      if (statSync(path.join(dir, child)).isDirectory()) walk(child);
      else have.push(child);
    }
  };
  walk("");
  for (const p of have) if (!want.has(p)) unlinkSync(path.join(dir, p));
  for (const e of manifest.entries) {
    if (e.op === "delete") {
      try {
        unlinkSync(path.join(dir, e.path));
      } catch {
        /* already gone */
      }
      continue;
    }
    const bytes = Buffer.from(e.content, "base64");
    const fp = path.join(dir, e.path);
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, bytes);
  }
}

// ------------------------------------------------------------------ scenario

const SHARED_COMPASS_OP = "CAL mag=1.200 decl=12.00 by=both#1";
const FORK_GPS_OPS = [
  "FIX lat=45.100000 lon=-122.300000 hdop=0.90 by=fork#1",
  "SMOOTH alpha=0.35 window=6 by=fork#2",
];
const FORK_PLANNER_OPS = [
  "BIND input=data.gps -> planner.fix by=fork#1",
  "PLAN wp=3 speed=1.40 hdg=270 by=fork#2",
];
const MAIN_PLANNER_OPS = [
  "RULE name=hold-course when hdop<1.50 by=main#1",
  "PLAN wp=5 speed=0.90 hdg=90 by=main#2",
];
const MAIN_RUDDER_OPS = ["SET pwm=1600 by=main#1"];
const FORK_EDGE = "edge data/gps qm_bind gpio/rudder";
const MAIN_EDGE = "edge logic/planner qm_tick data/compass";

const scratch = mkdtempSync(path.join(tmpdir(), "b3-4-worker-"));
const genesisDir = path.join(scratch, "quilt-demo-genesis");
const forkDir = path.join(scratch, FORK_REPO);
const mainDir = path.join(scratch, MAIN_REPO);
const bareDir = path.join(scratch, "quilt-demo.git");

console.log("B3.4 worker rehearsal — Artifacts adapter + P2 pusher (offline)");
console.log(`scratch=${scratch}\n`);

// 1. mint the genesis quilt (python, B1 scheme), git-committed
execFileSync("python3", [QUILTGEN, "--out", genesisDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const baseSha = git(genesisDir, ["rev-parse", "HEAD"]).trim();
const BASIS = JSON.parse(readFileSync(path.join(genesisDir, "quilt.json"), "utf8")).basis;
console.log(`genesis base commit: ${baseSha}`);
console.log(`basis: ${BASIS}`);

// the bare remote stands in for the real Artifacts git remote (P2 pushes here)
execFileSync("git", ["init", "--bare", "-q", bareDir], { stdio: ["ignore", "pipe", "pipe"] });
git(genesisDir, ["push", "-q", bareDir, "HEAD:main"]);

// 2. two repos: main (the landing repo) + fork (a real fork), each with base objects
execFileSync("git", ["clone", "--quiet", genesisDir, mainDir], { stdio: ["ignore", "pipe", "pipe"] });
execFileSync("git", ["clone", "--quiet", genesisDir, forkDir], { stdio: ["ignore", "pipe", "pipe"] });

// 3. concurrent edits — disjoint + conflicting + identical + one edge each
writeTaskJson(forkDir, "task-1", "agent-F", baseSha);
editCell(forkDir, "data/gps", FORK_GPS_OPS);
editCell(forkDir, "logic/planner", FORK_PLANNER_OPS);
editCell(forkDir, "data/compass", [SHARED_COMPASS_OP]);
editEdgeAdd(forkDir, "data/gps", "qm_bind", "gpio/rudder");

editCell(mainDir, "gpio/rudder", MAIN_RUDDER_OPS);
editCell(mainDir, "logic/planner", MAIN_PLANNER_OPS);
editCell(mainDir, "data/compass", [SHARED_COMPASS_OP]);
editEdgeAdd(mainDir, "logic/planner", "qm_tick", "data/compass");

const forkHead = commitAll(forkDir, "fork", "task-1: fork edits");
const mainHead = commitAll(mainDir, "main", "main: concurrent edits");
console.log(`fork head: ${forkHead}`);
console.log(`main head: ${mainHead}\n`);

// the mock binding: repo names → real dirs (returning Artifacts-shaped values)
const mock = new MockArtifacts({ [MAIN_REPO]: mainDir, [FORK_REPO]: forkDir });

// =========================================================================
// (1) ArtifactsRepoReader is a drop-in for RepoReader
// =========================================================================

const adapter = new ArtifactsRepoReader(mock, [FORK_REPO, MAIN_REPO]);
const local = new LocalGit([genesisDir, forkDir, mainDir]);

// ref resolution through the adapter (main→main repo, fork→fork repo, base→fork repo)
const rMain = await adapter.resolveRef(MAIN_REPO, "HEAD");
const rFork = await adapter.resolveRef(FORK_REPO, "HEAD");
const rBase = await adapter.resolveRef(FORK_REPO, baseSha);
check(rMain === mainHead, `resolveRef(main repo, HEAD) == main head (got ${rMain})`);
check(rFork === forkHead, `resolveRef(fork repo, HEAD) == fork head (got ${rFork})`);
check(rBase === baseSha, `resolveRef(fork repo, base sha) == base (got ${rBase})`);

const dAdapter = await diffMerge(adapter, forkHead, mainHead, baseSha);
const dLocal = await diffMerge(local, forkHead, mainHead, baseSha);
const project = (d) =>
  JSON.stringify({
    units: d.units,
    conflicts: d.conflicts,
    idempotent: d.idempotent,
    forkOnly: d.forkOnly,
    mainOnly: d.mainOnly,
    fastPath: d.fastPath,
    routing: d.routing,
    ignored: d.ignoredPaths,
    unknown: d.unknownPaths,
    baseCommit: d.baseCommit,
    forkCommit: d.forkCommit,
    mainCommit: d.mainCommit,
  });
check(project(dAdapter) === project(dLocal), "ArtifactsRepoReader diff == LocalGit diff (drop-in)");
check(arrEq(dAdapter.conflicts.slice().sort(), ["cell:logic/planner"]), `adapter conflicts == {cell:logic/planner} (got ${JSON.stringify(dAdapter.conflicts)})`);
check(dAdapter.forkOnly.includes("cell:data/gps"), "adapter: data/gps is fork-only");
check(dAdapter.mainOnly.includes("cell:gpio/rudder"), "adapter: gpio/rudder is main-only");
check(dAdapter.idempotent.includes("cell:data/compass"), "adapter: data/compass is idempotent");
check(dAdapter.ignoredPaths.includes("task.json"), "adapter: task.json is ignored");
console.log("(1) ArtifactsRepoReader — 4/4 RepoReader methods drive diff.ts unchanged; diff identical to LocalGit");
console.log(`    conflicts=${JSON.stringify(dAdapter.conflicts)} forkOnly=${dAdapter.forkOnly.length} mainOnly=${dAdapter.mainOnly.length} idempotent=${dAdapter.idempotent.length}`);

// =========================================================================
// (2) Token mint (≤300 s, scope write) + (4) the push manifest
// =========================================================================

const mainStub = await mock.get(MAIN_REPO);
const deps = { createToken: (scope, ttl) => mainStub.createToken(scope, ttl) };

const clampedBig = await mintPushToken(deps, 3600);
check(mock.mints.at(-1).ttl === PUSH_TTL_SECONDS, `mint clamp: 3600 → ${PUSH_TTL_SECONDS} (got ${mock.mints.at(-1).ttl})`);
const clampedSmall = await mintPushToken(deps, 30);
check(mock.mints.at(-1).ttl === 60, `mint clamp: 30 → 60 (got ${mock.mints.at(-1).ttl})`);
check(clampedBig.scope === "write" && clampedSmall.scope === "write", "minted tokens are scope write");

// the real mint for this merge — mint BEFORE merging so the MERGE receipt id matches
const token = await mintPushToken(deps, PUSH_TTL_SECONDS);
check(token.id === mock.mints.at(-1).id, "minted token id recorded");
console.log(`(2) mint — scope=${token.scope} ttl=${mock.mints.at(-1).ttl}s (clamp: 3600→300, 30→60) id=${token.id}`);

// =========================================================================
// (2) merge.ts through the adapter (sequentialize + re-mine)
// =========================================================================

const resolved = await mergeQuilt(
  adapter,
  forkHead,
  mainHead,
  baseSha,
  { "cell:logic/planner": "sequentialize" },
  { forkName: "task-1", tokenId: token.id, sequentializeOrder: "main-first" },
);
check(resolved.ok, `merge through adapter ok (unresolved ${JSON.stringify(resolved.unresolved)})`);
check(resolved.unknownResolutions.length === 0, "merge: no unknown resolutions");
check(mergeTokenId(resolved.mergeOp) === token.id, "mergeOp token id == minted token id");

const expectedPlannerOps = cellOps(mainDir, "logic/planner").concat(FORK_PLANNER_OPS);
const expectedPlannerTip = mine(expectedPlannerOps, BASIS);
const resolverMap = resolved.files;
const plannerReceipts = new TextDecoder().decode(resolverMap.get("cells/logic/planner/receipts.txt"));
check(
  JSON.stringify(plannerReceipts.split("\n").filter((l) => l !== "").map((l) => l.slice(l.indexOf(" ") + 1))) === JSON.stringify(expectedPlannerOps),
  "merge: sequentialize ops == mainΔ ++ forkΔ",
);
const plannerMan = JSON.parse(new TextDecoder().decode(resolverMap.get("cells/logic/planner/cell.json")));
check(plannerMan.tip === expectedPlannerTip, `merge: re-mined tip == independent re-walk (${expectedPlannerTip})`);
check(plannerMan.tip !== readCellManifest(forkDir, "logic/planner").tip, "merge: tip re-mined (≠ fork tip)");
check(!resolverMap.has("task.json"), "merge: task.json not carried into the resolved quilt");
check(resolverMap.has("cells/data/gps/receipts.txt") && resolverMap.has("cells/gpio/rudder/receipts.txt"), "merge: disjoint cells survive");
console.log("(3) mergeQuilt via adapter — sequentialize re-mined, disjoint+idempotent preserved, ok=true");

// =========================================================================
// (2) P2 push manifest
// =========================================================================

const pkg = await proposePush(resolved, deps, {
  remote: bareDir,
  token,
  tokenTtlSeconds: PUSH_TTL_SECONDS,
  refspec: "HEAD:main",
  branch: "main",
});
const { manifest, revoke } = pkg;

const v = verifyManifest(manifest);
check(v.ok, `manifest verifies (problems: ${JSON.stringify(v.problems)})`);
check(manifest.proposalDigest === v.expected, "manifest digest recomputes");
check(manifest.entries.length === resolved.files.size, "manifest covers the whole resolved tree");
check(!manifest.entries.some((e) => e.path === "task.json"), "manifest carries no task.json");
check(
  arrEq(manifest.entries.map((e) => e.path), [...manifest.entries.map((e) => e.path)].sort()),
  "manifest entries are in canonical path order",
);
check(manifest.token.id === token.id && manifest.token.scope === "write", "manifest token ref == minted write token");
check(manifest.token.ttlSeconds === PUSH_TTL_SECONDS, `manifest token ttl ≤ 300 (got ${manifest.token.ttlSeconds})`);
check(manifest.merge.mergeOp === resolved.mergeOp, "manifest embeds the exact MERGE receipt");
check(revoke.tokenId === token.id && revoke.singleUse === true, "revoke instruction names the minted token");

// tamper detection: a single byte flipped in any entry breaks the digest
const tampered = JSON.parse(JSON.stringify(manifest));
const idx = tampered.entries.findIndex((e) => e.path === "quilt.json");
tampered.entries[idx].content = tampered.entries[idx].content.replace(/^./, "A");
const tv = verifyManifest(tampered);
check(!tv.ok, "tampering with an entry breaks verifyManifest");

// fail-closed: a token whose id ≠ the MERGE receipt's id is refused
let mismatchThrew = false;
try {
  buildPushManifest(resolved, { ...token, id: "tok-not-the-one" }, { remote: bareDir });
} catch {
  mismatchThrew = true;
}
check(mismatchThrew, "buildPushManifest fail-closed on token-id mismatch");

// fail-closed: an unresolved merge cannot be pushed
let unresolvedThrew = false;
try {
  const bad = await mergeQuilt(adapter, forkHead, mainHead, baseSha, {}, { forkName: "task-1" });
  await proposePush(bad, deps, { remote: bareDir });
} catch {
  unresolvedThrew = true;
}
check(unresolvedThrew, "proposePush refuses an unresolved merge");

console.log(`(4) P2 manifest — protocol=${manifest.protocol} v${manifest.version} entries=${manifest.entries.length} digest=${manifest.proposalDigest}`);
console.log(`    token=${manifest.token.id} once · revoke-after-push · tamper + mismatch + unresolved all refused`);

// =========================================================================
// (5) dumb executor → bare remote → clone back → verifyQuilt
// =========================================================================

const execDir = path.join(scratch, "executor");
execFileSync("git", ["clone", "--quiet", "--branch", "main", bareDir, execDir], { stdio: ["ignore", "pipe", "pipe"] });
check(git(execDir, ["rev-parse", "HEAD"]).trim() === baseSha, "executor cloned main at the base (Artifacts stand-in)");

// the executor's first act: verify the manifest has not been altered
applyManifestToDir(execDir, manifest);
const expectTree = materializePush(manifest);

// the working tree now holds exactly the manifest's tree
const applied = mapDir(execDir);
check(sameMap(applied, expectTree), "applied dir == materialized manifest (prune + write)");

// commit with the manifest's deterministic message, then push the refspec
commitAll(execDir, "pusher", manifest.commitMessage);
git(execDir, ["push", "-q", "origin", manifest.refspec]);
const pushedFiles = git(execDir, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n").filter((l) => l !== "");
check(
  arrEq(pushedFiles.slice().sort(), manifest.entries.map((e) => e.path).sort()),
  "pushed tree file set == manifest entries",
);
check(git(execDir, ["log", "-1", "--pretty=%s"]).trim() === manifest.commitMessage, "commit message == manifest.commitMessage (deterministic)");

// revoke the single-use token
await mainStub.revokeToken(revoke.ref);
check(mock.revokes.at(-1).tokenOrId === token.id, "token revoked by id after push");

// clone back and WAKE-VERIFY
const rtDir = path.join(scratch, "clone-back");
execFileSync("git", ["clone", "--quiet", "--branch", "main", bareDir, rtDir], { stdio: ["ignore", "pipe", "pipe"] });
const vQ = verifyQuilt(quiltFilesFromDir(rtDir));
check(vQ.ok, `clone-back quilt verifies ok (problems: ${JSON.stringify(vQ.problems)})`);
check(!readdirSync(rtDir).includes("task.json"), "clone-back carries no task.json");
const py = spawnSync("python3", [QUILTGEN, "--verify", rtDir], { encoding: "utf8" });
check(py.status === 0, `clone-back python quiltgen --verify exit ${py.status}: ${py.stderr}`);
const rtMap = mapDir(rtDir);
check(sameMap(rtMap, expectTree), "clone-back bytes == manifest tree (round-trip)");

console.log(`(5) executor → ${manifest.refspec} → clone-back: ${manifest.entries.length} files, commit ${git(rtDir, ["rev-parse", "--short", "HEAD"]).trim()}`);
console.log(`    quilt.ts ok=${vQ.ok} · python ok=${py.status === 0} · token revoked · round-trip byte-identical`);

// =========================================================================
// (6) the git-api endpoints, offline, over the mock env
// =========================================================================

const env = { ARTIFACTS: mock, QUILT_REPO: MAIN_REPO, FORK_REPO: FORK_REPO };
const mkReq = (p, body, headers = {}) =>
  new Request(`https://quilt.test${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const health = await gitApi.fetch(new Request("https://quilt.test/health"), env);
check(health.status === 200, "GET /health → 200");

const diffRes = await gitApi.fetch(
  mkReq("/diff", { base: baseSha, fork: "HEAD", main: "HEAD", repos: { main: MAIN_REPO, fork: FORK_REPO } }),
  env,
);
const diffJson = await diffRes.json();
check(diffRes.status === 200, `POST /diff → 200 (got ${diffRes.status})`);
check(arrEq(diffJson.conflicts.slice().sort(), ["cell:logic/planner"]), `POST /diff conflicts (got ${JSON.stringify(diffJson.conflicts)})`);
check(diffJson.fastPath === false, "POST /diff fastPath=false");
check(Array.isArray(diffJson.units) && diffJson.units.length > 0, "POST /diff returns unit deltas");
check(diffJson.main === mainHead && diffJson.fork === forkHead, "POST /diff resolved refs to heads");

const mergeRes = await gitApi.fetch(
  mkReq("/merge", {
    base: baseSha,
    fork: "HEAD",
    main: "HEAD",
    repos: { main: MAIN_REPO, fork: FORK_REPO },
    forkName: "task-1",
    resolutions: { "cell:logic/planner": "take-fork" },
  }),
  env,
);
const mergeJson = await mergeRes.json();
check(mergeRes.status === 200, `POST /merge → 200 (got ${mergeRes.status}: ${JSON.stringify(mergeJson).slice(0, 200)})`);
check(mergeJson.ok === true, "POST /merge ok=true");
check(mergeJson.push?.manifest?.entries?.length > 0, "POST /merge returns a push manifest");
check(verifyManifest(mergeJson.push.manifest).ok, "POST /merge manifest verifies");
check(mergeJson.push.revoke.tokenId === mergeJson.push.manifest.token.id, "POST /merge revoke matches minted token");
const decPlanner = mergeJson.decisions.find((x) => x.unit === "cell:logic/planner");
check(decPlanner?.mode === "take-fork" && decPlanner?.source === "fork", "POST /merge decision: take-fork planner");
check(mergeJson.conflicts.length === 1 && mergeJson.unresolved === undefined, "POST /merge conflict coverage");

// unresolved ⇒ 409
const unresolvedRes = await gitApi.fetch(
  mkReq("/merge", { base: baseSha, fork: "HEAD", main: "HEAD", repos: { main: MAIN_REPO, fork: FORK_REPO }, resolutions: {} }),
  env,
);
const unresolvedJson = await unresolvedRes.json();
check(unresolvedRes.status === 409, `POST /merge unresolved → 409 (got ${unresolvedRes.status})`);
check(arrEq(unresolvedJson.unresolved ?? [], ["cell:logic/planner"]), "POST /merge 409 lists the unresolved unit");

// MERGE_SECRET ⇒ 401 without the header, 200 with it
const secretEnv = { ...env, MERGE_SECRET: "s3cret" };
const noAuth = await gitApi.fetch(
  mkReq("/merge", { base: baseSha, fork: "HEAD", main: "HEAD", repos: { main: MAIN_REPO, fork: FORK_REPO }, resolutions: { "cell:logic/planner": "take-main" } }),
  secretEnv,
);
check(noAuth.status === 401, `POST /merge without secret → 401 (got ${noAuth.status})`);
const withAuth = await gitApi.fetch(
  mkReq(
    "/merge",
    { base: baseSha, fork: "HEAD", main: "HEAD", repos: { main: MAIN_REPO, fork: FORK_REPO }, resolutions: { "cell:logic/planner": "take-main" } },
    { "x-merge-secret": "s3cret" },
  ),
  secretEnv,
);
check(withAuth.status === 200, `POST /merge with secret → 200 (got ${withAuth.status})`);

console.log("(6) git-api — POST /diff 200 (conflicts=1) · POST /merge 200 (manifest) · unresolved 409 · secret 401/200");

// =========================================================================

adapter[Symbol.dispose]();

console.log("\n--- summary ---");
console.log("adapter: ArtifactsRepoReader implements readTree/readBlob/readFile/readCommit over mock ARTIFACTS");
console.log("pusher:  mintPushToken (≤300 s, write) + buildPushManifest (canonical, base64) + verifyManifest + materializePush");
console.log("endpoints: POST /diff, POST /merge (git-api.ts default handler)");
console.log(`manifest: ${manifest.entries.length} entries, digest ${manifest.proposalDigest}`);

if (failures.length > 0) {
  console.error(`\nB3.4 REHEARSAL FAIL (${failures.length}):`);
  for (const f of failures.slice(0, 60)) console.error(`  - ${f}`);
  console.error(`scratch kept: ${scratch}`);
  process.exit(1);
}
console.log("\nB3.4 WORKER REHEARSAL OK — adapter drop-in, P2 manifest round-trips, merged quilt verifies");
rmSync(scratch, { recursive: true, force: true });
