/**
 * nagent-rehearsal.mjs — B3.5 N-agent concurrent merge rig (OFFLINE).
 *
 * The increment's claim (docs/B3-DESIGN.md §2.4 conflict rule + §5 row B3.5,
 * scoped here to the *offline* half): fork-per-task concurrency holds at N>2.
 * Mint ONE genesis quilt, fork it N ways (each a REAL local clone with its own
 * seeded RNG), let every agent edit concurrently with ZERO coordination, then
 * land ALL N forks *sequentially* through the pure merge executor
 * (worker/src/merge.ts over the B3.2 diff core) into one resolved quilt — and
 * prove the result verifies clean with zero data loss.
 *
 * Edit mix per fork i (deterministic, seeded):
 *   - DISJOINT  : a brand-new cell `data/leaf-<i>` (2 ops) — untouched by any
 *                 other fork; plus (i=0) `data/gps`, (i=1) `gpio/rudder`.
 *   - CONFLICT  : `logic/planner` gets 2 fork-distinct ops ⇒ N-way conflict,
 *                 resolved with `sequentialize` (main-first) at each landing.
 *   - IDEMPOTENT: `data/compass` gets the SAME op from every fork ⇒ after the
 *                 first landing the rest are auto-resolved (identical content).
 *   - EDGE ADD  : a distinct new edge `data/leaf-<i> qm_bind logic/planner`
 *                 ⇒ merged edge set is the union; routing stays a view.
 *
 * Asserted (§2.4 + §5):
 *   (a) the final quilt verifies `ok` via quilt.ts AND python `quiltgen.py`;
 *   (b) every disjoint cell write survives (union present, byte-identical);
 *   (c) every conflict is resolved per the policy (sequentialize) and its
 *       receipts are RE-MINED from the final op list (new tip ≠ both carried
 *       tips; equals an independent re-walk);
 *   (d) the merged edge set is the union (base edges ∪ N new edges).
 * Prints a summary table: N, total cells touched, disjoint survived,
 * conflicts resolved, idempotent, edges unioned, final verify.
 *
 * Offline only — no Cloudflare, no deploy (B3.5's live-gate half is separate).
 *
 * Usage: node --experimental-strip-types test/nagent-rehearsal.mjs [N]
 *        NAGENT_N=12 node --experimental-strip-types test/nagent-rehearsal.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const { mergeQuilt } = await import("../src/merge.ts");
const { verifyQuilt } = await import("../src/quilt.ts");
const { LocalGit } = await import("./localgit.mjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const QUILTGEN = path.join(repoRoot, "lattice", "quiltgen.py");

const SCHEME = "fnv1a-64-chain-v1";
const N = Math.max(2, Number(process.env.NAGENT_N ?? process.argv[2] ?? 8) || 8);
const SEED_BASE = 20261001;
const SHARED_COMPASS_OP = "CAL mag=1.200 decl=12.00 by=both#1";

// ---------------------------------------------------------------- git + hash

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

/** Independent re-mine (the test's own walk) — used to check carried tips. */
function mine(ops, basis) {
  let head = basis;
  for (const op of ops) head = appendReceipt(head, op);
  return head;
}

/** Deterministic 32-bit PRNG so each fork gets a distinct, reproducible seed. */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------- quilt editing

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

/** Append ops to an EXISTING cell (updates cell.json tip/count). */
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

/** Create a BRAND-NEW cell (nobody else touches it) + register in quilt.json. */
function createCell(dir, addr, ops, basis, opcodes) {
  const [type, name] = addr.split("/");
  const cdir = path.join(dir, "cells", type, name);
  mkdirSync(path.join(cdir, "body"), { recursive: true });
  let head = basis;
  const add = [];
  for (const op of ops) {
    head = appendReceipt(head, op);
    add.push(`${head} ${canonicalOp(op)}`);
  }
  writeFileSync(path.join(cdir, "receipts.txt"), add.join("\n") + "\n");
  writeFileSync(
    path.join(cdir, "body", `${name}.md`),
    `# ${addr}\n\nFork-created cell (B3.5 N-agent rehearsal).\n`,
  );
  const man = {
    scheme: SCHEME,
    basis,
    id: addr,
    type,
    name,
    opcodes,
    count: add.length,
    tip: head,
  };
  writeFileSync(path.join(cdir, "cell.json"), JSON.stringify(man, null, 2) + "\n");
  const qPath = path.join(dir, "quilt.json");
  const q = JSON.parse(readFileSync(qPath, "utf8"));
  q.cells = [...new Set([...(q.cells || []), addr])].sort();
  writeFileSync(qPath, JSON.stringify(q, null, 2) + "\n");
  return head;
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
        forked_at: "nagent-rehearsal",
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

// ---------------------------------------------------------------- quilt reads

const cellDir = (dir, addr) => path.join(dir, "cells", ...addr.split("/"));
const readCellReceipts = (dir, addr) => readFileSync(path.join(cellDir(dir, addr), "receipts.txt"), "utf8");
const readCellManifest = (dir, addr) => JSON.parse(readFileSync(path.join(cellDir(dir, addr), "cell.json"), "utf8"));
const cellOps = (dir, addr) =>
  readCellReceipts(dir, addr).split("\n").filter((l) => l !== "").map((l) => l.slice(l.indexOf(" ") + 1));
const readQuilt = (dir) => JSON.parse(readFileSync(path.join(dir, "quilt.json"), "utf8"));
const readRouting = (dir) => readFileSync(path.join(dir, "routing.txt"), "utf8");
const routingOps = (dir) =>
  readRouting(dir).split("\n").filter((l) => l !== "").map((l) => l.slice(l.indexOf(" ") + 1));

// ------------------------------------------------------- materialize + verify

function writeMap(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, bytes] of files) {
    const fp = path.join(dir, rel);
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, bytes);
  }
}

function quiltFilesFromDir(dir) {
  const quilt = JSON.parse(readFileSync(path.join(dir, "quilt.json"), "utf8"));
  const cells = {};
  for (const addr of quilt.cells ?? []) {
    cells[addr] = {
      manifestJson: readFileSync(path.join(cellDir(dir, addr), "cell.json"), "utf8"),
      receiptsText: readFileSync(path.join(cellDir(dir, addr), "receipts.txt"), "utf8"),
    };
  }
  return { quiltJson: readFileSync(path.join(dir, "quilt.json"), "utf8"), routingText: readFileSync(path.join(dir, "routing.txt"), "utf8"), cells };
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

// --------------------------------------------------------------- assertions

const failures = [];
function check(cond, label) {
  if (!cond) failures.push(label);
}
const arrEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const setEq = (a, b) => {
  const A = [...a].sort();
  const B = [...b].sort();
  return arrEq(A, B);
};

// ------------------------------------------------------------------- harness

const scratch = mkdtempSync(path.join(tmpdir(), "b3-5-nagent-"));
const genesisDir = path.join(scratch, "genesis");

console.log(`B3.5 N-agent merge rehearsal — N=${N}, offline`);
console.log(`scratch=${scratch}\n`);

// 1. mint ONE genesis quilt (python, B1 scheme), git-committed
execFileSync("python3", [QUILTGEN, "--out", genesisDir], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const baseSha = git(genesisDir, ["rev-parse", "HEAD"]).trim();
const genesisQuilt = readQuilt(genesisDir);
const BASIS = genesisQuilt.basis;
const genesisEdgeLines = [...genesisQuilt.edges].sort();
const basePlannerOps = cellOps(genesisDir, "logic/planner");
const baseCompassOps = cellOps(genesisDir, "data/compass");
console.log(`genesis base commit: ${baseSha}`);
console.log(`basis: ${BASIS}`);
console.log(`genesis cells: ${genesisQuilt.cells.join(", ")}`);
console.log(`genesis edges: ${genesisEdgeLines.length}\n`);

// 2. fork N ways — each its own real local clone with a distinct seeded RNG
const forkDirs = [];
const forkHeads = [];
const forkPlan = [];
for (let i = 0; i < N; i++) {
  const dir = path.join(scratch, `fork-${i}`);
  execFileSync("git", ["clone", "--quiet", genesisDir, dir], { stdio: ["ignore", "pipe", "pipe"] });

  const r = mulberry32(SEED_BASE + i * 1013);
  const conflictOps = [
    `BIND input=data.leaf-${i} -> planner.fix by=fork#${i}`,
    `PLAN wp=${1 + Math.floor(r() * 12)} speed=${(0.2 + r() * 2.3).toFixed(2)} hdg=${Math.floor(r() * 360)} by=fork#${i}`,
  ];
  const leafOps = [
    `FIX lat=${(r() * 180 - 90).toFixed(6)} lon=${(r() * 360 - 180).toFixed(6)} hdop=${(0.6 + r() * 2.4).toFixed(2)} by=leaf#${i}`,
    `PUB topic=nav.leaf${i} seq=${1 + Math.floor(r() * 9999)} by=leaf#${i}`,
  ];

  writeTaskJson(dir, `task-${i}`, `agent-${i}`, baseSha);
  // CONFLICT cell: every fork appends 2 fork-distinct ops to logic/planner.
  editCell(dir, "logic/planner", conflictOps);
  // DISJOINT cell: a brand-new cell nobody else touches.
  createCell(dir, `data/leaf-${i}`, leafOps, BASIS, ["FIX", "PUB"]);
  // IDEMPOTENT cell: every fork appends the SAME op to data/compass.
  editCell(dir, "data/compass", [SHARED_COMPASS_OP]);
  // EDGE ADD: a distinct new edge.
  editEdgeAdd(dir, `data/leaf-${i}`, "qm_bind", "logic/planner");
  // extra DISJOINT writes onto EXISTING cells (single writer each).
  if (i === 0) editCell(dir, "data/gps", [`SMOOTH alpha=0.42 window=7 by=fork#0`]);
  if (i === 1) editCell(dir, "gpio/rudder", [`SET pwm=1725 by=fork#1`]);

  const head = commitAll(dir, `fork-${i}`, `task-${i}: fork edits`);
  forkDirs.push(dir);
  forkHeads.push(head);
  forkPlan.push({ i, conflictOps, leafOps });
}
console.log(`forked ${N} ways (each a real clone): ${forkHeads.map((h) => h.slice(0, 7)).join(" ")}\n`);

// 3. land ALL N forks SEQUENTIALLY through merge.ts (base = genesis for all;
//    main advances after each landing — the fork point never moves).
const landedDirs = [];
const mergeResults = [];
let mainRef = baseSha;
let finalDir = null;

for (let i = 0; i < N; i++) {
  const reader = new LocalGit([genesisDir, ...landedDirs, ...forkDirs]);
  const resolutions = i === 0 ? {} : { "cell:logic/planner": "sequentialize" };
  const res = await mergeQuilt(reader, forkHeads[i], mainRef, baseSha, resolutions, {
    forkName: `task-${i}`,
    tokenId: `tok-local-${i}`,
    sequentializeOrder: "main-first",
  });

  check(res.ok, `merge ${i}: executor ok (unresolved ${JSON.stringify(res.unresolved)})`);
  check(res.unknownResolutions.length === 0, `merge ${i}: no unknown resolutions`);

  const dir = path.join(scratch, `landed-${i}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: ["ignore", "pipe", "pipe"] });
  writeMap(dir, res.files);
  const head = commitAll(dir, "clerk", `land N-agent merge ${i} (task-${i})`);

  landedDirs.push(dir);
  mergeResults.push(res);
  mainRef = head;
  finalDir = dir;

  const conflicts = res.conflicts.length;
  console.log(
    `land ${i}: task-${i} → ${head.slice(0, 7)}  conflicts=${conflicts}` +
      ` forkOnly=${res.summary.forkOnly} mainOnly=${res.summary.mainOnly}` +
      ` idempotent=${res.summary.idempotent} cells=${res.summary.cells} edges=${res.summary.edges}` +
      ` ok=${res.ok}`,
  );
}
console.log();

// ------------------------------------------------------- (a) verify final ok

const vFinal = verifyQuilt(quiltFilesFromDir(finalDir));
check(vFinal.ok, `final: quilt.ts verify ok (problems: ${JSON.stringify(vFinal.problems)})`);
const pyFinal = spawnSync("python3", [QUILTGEN, "--verify", finalDir], { encoding: "utf8" });
check(pyFinal.status === 0, `final: python quiltgen --verify exit ${pyFinal.status}: ${pyFinal.stderr}`);
let pyReport = null;
try {
  pyReport = JSON.parse(pyFinal.stdout);
} catch {
  /* reported via status check */
}
check(pyReport !== null && pyReport.ok === true, `final: python verify ok=${pyReport && pyReport.ok}`);
const finalVerifyOk = vFinal.ok && pyFinal.status === 0 && pyReport?.ok === true;
console.log(`final verify: quilt.ts ok=${vFinal.ok}, python ok=${pyReport?.ok}, exit=${pyFinal.status}`);

// ------------------------------------------------- (b) disjoint writes survive

const disjointExpected = []; // {addr, forkDir}
for (let i = 0; i < N; i++) disjointExpected.push({ addr: `data/leaf-${i}`, forkDir: forkDirs[i] });
disjointExpected.push({ addr: "data/gps", forkDir: forkDirs[0] });
disjointExpected.push({ addr: "gpio/rudder", forkDir: forkDirs[1] });

let disjointSurvived = 0;
const finalCells = readQuilt(finalDir).cells;
for (const { addr, forkDir } of disjointExpected) {
  const present = finalCells.includes(addr);
  const bytesEqual = present && readCellReceipts(finalDir, addr) === readCellReceipts(forkDir, addr);
  if (present && bytesEqual) disjointSurvived++;
  check(present, `disjoint: ${addr} present in final quilt`);
  check(bytesEqual, `disjoint: ${addr} bytes survive byte-identical to its fork`);
}

// ------------------------------------- (c) conflicts resolved + receipts re-mined

let conflictsTotal = 0;
let conflictsResolved = 0;
let idempotentTotal = 0;
let reMinedConflicts = 0;

for (let i = 0; i < N; i++) {
  const res = mergeResults[i];
  conflictsTotal += res.conflicts.length;
  idempotentTotal += res.summary.idempotent;
  for (const u of res.conflicts) {
    const dec = res.decisions.find((d) => d.unit === u);
    if (dec !== undefined && dec.mode !== "auto" && res.unresolved.length === 0) conflictsResolved++;
  }
  for (const dec of res.decisions) {
    if (dec.verdict === "conflict") {
      check(dec.mode === "sequentialize", `merge ${i}: conflict ${dec.unit} resolved by sequentialize (got ${dec.mode})`);
      check(dec.reMined === true, `merge ${i}: conflict ${dec.unit} receipts re-mined`);
      if (dec.reMined === true) reMinedConflicts++;
    }
  }
  // main-first accumulation: landed-i planner ops begin with landed-(i-1)'s ops
  const prev = i === 0 ? genesisDir : landedDirs[i - 1];
  const prevOps = cellOps(prev, "logic/planner");
  const nowOps = cellOps(landedDirs[i], "logic/planner");
  check(
    arrEq(nowOps.slice(0, prevOps.length), prevOps),
    `merge ${i}: main-first accumulation (landed planner ops start with prior main's)`,
  );
}

// the N-way conflict cell: planner = base ++ fork0Δ ++ … ++ fork(N-1)Δ, re-mined
const expectedPlannerOps = [...basePlannerOps];
let plannerDeltaLen = 0;
for (const { conflictOps } of forkPlan) {
  plannerDeltaLen += conflictOps.length;
  expectedPlannerOps.push(...conflictOps);
}
const finalPlannerOps = cellOps(finalDir, "logic/planner");
check(arrEq(finalPlannerOps, expectedPlannerOps), `planner: final ops == base ++ fork0Δ..fork${N - 1}Δ`);
const expectedPlannerTip = mine(expectedPlannerOps, BASIS);
const finalPlannerManifest = readCellManifest(finalDir, "logic/planner");
check(finalPlannerManifest.tip === expectedPlannerTip, `planner: final tip == independent re-walk (${expectedPlannerTip})`);
check(
  finalPlannerManifest.count === basePlannerOps.length + plannerDeltaLen,
  `planner: final count == base + ${plannerDeltaLen} ops`,
);
check(
  finalPlannerManifest.tip !== readCellManifest(genesisDir, "logic/planner").tip,
  "planner: final tip ≠ carried genesis tip (genuinely re-mined)",
);

// (c-idempotent) the shared cell keeps exactly ONE copy of the shared op
const expectedCompassOps = [...baseCompassOps, SHARED_COMPASS_OP];
check(arrEq(cellOps(finalDir, "data/compass"), expectedCompassOps), "compass: idempotent writes collapse to one op");
check(idempotentTotal >= N - 1, `idempotent resolutions >= N-1 (got ${idempotentTotal})`);

// --------------------------------------------- (d) merged edge set == the union

const expectedEdges = [...genesisEdgeLines, ...forkPlan.map(({ i }) => `edge data/leaf-${i} qm_bind logic/planner`)];
const finalEdgeLines = readQuilt(finalDir).edges;
check(setEq(finalEdgeLines, expectedEdges), "edges: final edge set == genesis ∪ N new edges (union)");
const routingText = readRouting(finalDir);
check(routingOps(finalDir).filter((o) => o.startsWith("MERGE")).length === N, `routing: exactly ${N} MERGE ops (one per landing)`);
check(routingText.includes("ROUTE_ADD data/leaf-0 qm_bind logic/planner"), "routing: ROUTE_ADD for a fork edge present");
check(
  mergeResults[N - 1].routing.tip === mine(routingOps(finalDir), BASIS),
  "routing: final tip == independent re-walk of the merged ledger",
);
check(!readdirSync(finalDir).includes("task.json"), "final: task.json (fork metadata) never carried");

// -------------------------------------------- final round-trip over a real wire

const bareDir = path.join(scratch, "final.git");
const rtDir = path.join(scratch, "final-roundtrip");
execFileSync("git", ["init", "--bare", "-q", bareDir], { stdio: ["ignore", "pipe", "pipe"] });
git(finalDir, ["remote", "add", "origin", bareDir]);
git(finalDir, ["push", "-q", "origin", "HEAD:main"]);
execFileSync("git", ["clone", "--quiet", "--branch", "main", bareDir, rtDir], { stdio: ["ignore", "pipe", "pipe"] });
const rtMap = mapDir(rtDir);
const fMap = mapDir(finalDir);
const samePaths = rtMap.size === fMap.size && [...fMap.keys()].every((p) => rtMap.has(p));
const sameBytes =
  samePaths && [...fMap.entries()].every(([p, b]) => Buffer.compare(Buffer.from(b), Buffer.from(rtMap.get(p))) === 0);
check(samePaths, "round-trip: same file set after push/clone");
check(sameBytes, "round-trip: identical bytes after push/clone");
const vRT = verifyQuilt(quiltFilesFromDir(rtDir));
check(vRT.ok, "round-trip: merged quilt verifies ok after the wire");

// ------------------------------------------------------------- touched count

const changedCells = finalCells.filter(
  (a) => !genesisQuilt.cells.includes(a) || readCellReceipts(finalDir, a) !== readCellReceipts(genesisDir, a),
);

// --------------------------------------------------------------- summary table

const rows = [
  ["N (forks)", String(N)],
  ["cells in final quilt", String(finalCells.length)],
  ["total cells touched", String(changedCells.length)],
  ["disjoint survived", `${disjointSurvived}/${disjointExpected.length}`],
  ["conflicts resolved", `${conflictsResolved}/${conflictsTotal} (re-mined ${reMinedConflicts})`],
  ["idempotent auto-resolved", String(idempotentTotal)],
  ["edges unioned", `${finalEdgeLines.length} (base ${genesisEdgeLines.length} + new ${N})`],
  ["final verify (quilt.ts)", vFinal.ok ? "ok" : "FAIL"],
  ["final verify (python)", pyReport?.ok === true ? "ok" : "FAIL"],
];
const w0 = Math.max(...rows.map((r) => r[0].length));
console.log("\n--- summary ---");
for (const [k, v] of rows) console.log(`${k.padEnd(w0)} | ${v}`);

const conflictCell = "cell:logic/planner";
console.log(`\nconflict cell: ${conflictCell} (all ${N} forks, policy=sequentialize main-first)`);
console.log(`resolutions exercised: fork-only (disjoint/new), idempotent (compass), sequentialize (planner)`);
console.log(`merged quilts verified: final (quilt.ts + python), + final round-trip over a local bare remote`);

if (failures.length > 0) {
  console.error(`\nB3.5 N-AGENT REHEARSAL FAIL (${failures.length}):`);
  for (const f of failures.slice(0, 60)) console.error(`  - ${f}`);
  console.error(`scratch kept: ${scratch}`);
  process.exit(1);
}
console.log(`\nB3.5 N-AGENT MERGE REHEARSAL OK — N=${N} forks merged with zero data loss; final quilt verifies`);
rmSync(scratch, { recursive: true, force: true });
