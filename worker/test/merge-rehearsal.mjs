/**
 * merge-rehearsal.mjs — B3.3 end-to-end local merge rehearsal.
 *
 * The increment's receipt (docs/B3-DESIGN.md §5 row B3.3): mint a quilt, fork
 * it twice (two REAL local repos), let both sides edit concurrently — one
 * disjoint cell each, one conflicting cell, one identical cell, and one new
 * edge each — then run the pure merge executor (worker/src/merge.ts) over the
 * B3.2 diff core (worker/src/diff.ts) with each resolution mode, materialize
 * the resolved quilt, and WAKE-VERIFY it with quilt.ts (must be `ok`).
 *
 * Asserted resolution rules (§2.4):
 *   - take-fork / take-main land exactly the chosen side's cell bytes;
 *   - sequentialize keeps BOTH op sets (main's new ops then fork's new ops) and
 *     RE-MINES the receipts on the new head (new tip ≠ either carried tip);
 *   - disjoint cells both survive; identical (idempotent) cells stay put;
 *   - the merged routing ledger carries both ROUTE_ADD ops and the MERGE op.
 *
 * Also cross-checks the landed quilt with python `quiltgen.py --verify` and
 * round-trips it through a real local bare remote (Artifacts stand-in), so the
 * proof covers the wire, not just the in-memory map.
 *
 * Usage: node --experimental-strip-types test/merge-rehearsal.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node's --experimental-strip-types does not rewrite "./x.js" → "./x.ts".
// merge.ts / diff.ts / quilt.ts are Worker-style (import "./chain.js").
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
const { diffMerge } = await import("../src/diff.ts");
const { verifyQuilt } = await import("../src/quilt.ts");
const { LocalGit } = await import("./localgit.mjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const QUILTGEN = path.join(repoRoot, "lattice", "quiltgen.py");

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

/** Independent re-mine (the test's own walk) — used to check tips. */
function mine(ops, basis) {
  let head = basis;
  for (const op of ops) head = appendReceipt(head, op);
  return head;
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
      { task, agent, base_commit: baseCommit, base_routing_tip: null, base_cell_tips: {}, forked_at: "rehearsal" },
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
const cellOps = (dir, addr) => readCellReceipts(dir, addr).split("\n").filter((l) => l !== "").map((l) => l.slice(l.indexOf(" ") + 1));
const readQuilt = (dir) => JSON.parse(readFileSync(path.join(dir, "quilt.json"), "utf8"));
const readRouting = (dir) => readFileSync(path.join(dir, "routing.txt"), "utf8");
const routingOps = (dir) => readRouting(dir).split("\n").filter((l) => l !== "").map((l) => l.slice(l.indexOf(" ") + 1));

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
  const quiltJson = readFileSync(path.join(dir, "quilt.json"), "utf8");
  const quilt = JSON.parse(quiltJson);
  const cells = {};
  for (const addr of quilt.cells ?? []) {
    cells[addr] = {
      manifestJson: readFileSync(path.join(cellDir(dir, addr), "cell.json"), "utf8"),
      receiptsText: readFileSync(path.join(cellDir(dir, addr), "receipts.txt"), "utf8"),
    };
  }
  return { quiltJson, routingText: readFileSync(path.join(dir, "routing.txt"), "utf8"), cells };
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

// ------------------------------------------------------------------- harness

const scratch = mkdtempSync(path.join(tmpdir(), "b3-3-merge-"));
const genesisDir = path.join(scratch, "genesis");
const forkDir = path.join(scratch, "fork");
const mainDir = path.join(scratch, "main");

console.log("B3.3 merge rehearsal — local fork/merge end-to-end");
console.log(`scratch=${scratch}\n`);

// 1. mint the genesis quilt (python, B1 scheme), git-committed
execFileSync("python3", [QUILTGEN, "--out", genesisDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const baseSha = git(genesisDir, ["rev-parse", "HEAD"]).trim();
const genesisQuilt = readQuilt(genesisDir);
const BASIS = genesisQuilt.basis;
console.log(`genesis base commit: ${baseSha}`);
console.log(`basis: ${BASIS}`);

// 2. two real forks (separate repos, each holding the base objects)
execFileSync("git", ["clone", "--quiet", genesisDir, forkDir], { stdio: ["ignore", "pipe", "pipe"] });
execFileSync("git", ["clone", "--quiet", genesisDir, mainDir], { stdio: ["ignore", "pipe", "pipe"] });

// 3. concurrent edits — disjoint + conflicting + identical
writeTaskJson(forkDir, "task-1", "agent-F", baseSha);
editCell(forkDir, "data/gps", FORK_GPS_OPS); //         fork-only cell
editCell(forkDir, "logic/planner", FORK_PLANNER_OPS); // conflict cell (fork side)
editCell(forkDir, "data/compass", [SHARED_COMPASS_OP]); // identical both sides
editEdgeAdd(forkDir, "data/gps", "qm_bind", "gpio/rudder"); // fork-only edge

editCell(mainDir, "gpio/rudder", MAIN_RUDDER_OPS); //     main-only cell
editCell(mainDir, "logic/planner", MAIN_PLANNER_OPS); // conflict cell (main side)
editCell(mainDir, "data/compass", [SHARED_COMPASS_OP]); // identical both sides
editEdgeAdd(mainDir, "logic/planner", "qm_tick", "data/compass"); // main-only edge

const forkHead = commitAll(forkDir, "fork", "task-1: fork edits");
const mainHead = commitAll(mainDir, "main", "main: concurrent edits");
console.log(`fork head: ${forkHead}`);
console.log(`main head: ${mainHead}\n`);

// 4. the union reader (fork + main + genesis all hold the shared base objects)
const reader = new LocalGit([genesisDir, forkDir, mainDir]);

// 5. the diff (input to the executor) — check the scenario is what we intend
const d = await diffMerge(reader, forkHead, mainHead, baseSha);
check(arrEq(d.conflicts.slice().sort(), ["cell:logic/planner"]), `diff conflicts == {cell:logic/planner} (got ${JSON.stringify(d.conflicts)})`);
check(d.forkOnly.includes("cell:data/gps"), "diff: data/gps is fork-only");
check(d.forkOnly.includes("edge:data/gps|qm_bind|gpio/rudder"), "diff: fork edge is fork-only");
check(d.mainOnly.includes("cell:gpio/rudder"), "diff: gpio/rudder is main-only");
check(d.mainOnly.includes("edge:logic/planner|qm_tick|data/compass"), "diff: main edge is main-only");
check(d.idempotent.includes("cell:data/compass"), "diff: data/compass is idempotent");
check(d.ignoredPaths.includes("task.json"), "diff: task.json is ignored metadata");
console.log(`conflicts: ${JSON.stringify(d.conflicts)}`);
console.log(`fork-only: ${JSON.stringify(d.forkOnly)}`);
console.log(`main-only: ${JSON.stringify(d.mainOnly)}`);
console.log(`idempotent: ${JSON.stringify(d.idempotent)}\n`);

// base-side reference values
const basePlannerOps = cellOps(genesisDir, "logic/planner");
const forkPlannerOps = cellOps(forkDir, "logic/planner");
const mainPlannerOps = cellOps(mainDir, "logic/planner");
const forkPlannerTip = readCellManifest(forkDir, "logic/planner").tip;
const mainPlannerTip = readCellManifest(mainDir, "logic/planner").tip;
const forkGpsTip = readCellManifest(forkDir, "data/gps").tip;
const mainRudderTip = readCellManifest(mainDir, "gpio/rudder").tip;
const forkEdgeSet = readQuilt(forkDir).edges;
const mainEdgeSet = readQuilt(mainDir).edges;

/** Verify a resolved quilt with quilt.ts + python, via a materialized dir. */
function verifyLanded(label, result, dir) {
  writeMap(dir, result.files);
  const v = verifyQuilt(quiltFilesFromDir(dir));
  check(v.ok, `${label}: quilt.ts verify ok (problems: ${JSON.stringify(v.problems)})`);
  const py = spawnSync("python3", [QUILTGEN, "--verify", dir], { encoding: "utf8" });
  check(py.status === 0, `${label}: python quiltgen --verify exit ${py.status}: ${py.stderr}`);
  let rep = null;
  try {
    rep = JSON.parse(py.stdout);
  } catch {
    /* reported via status check */
  }
  check(rep !== null && rep.ok === true, `${label}: python verify ok=${rep && rep.ok}`);
  return v;
}

// ---------------------------------------------------- RUN A: sequentialize

const resA = await mergeQuilt(
  reader,
  forkHead,
  mainHead,
  baseSha,
  { "cell:logic/planner": "sequentialize" },
  { forkName: "task-1", tokenId: "tok-local-1", sequentializeOrder: "main-first" },
);
check(resA.ok, `A: executor ok (unresolved ${JSON.stringify(resA.unresolved)})`);
check(resA.unknownResolutions.length === 0, "A: no unknown resolutions");

const dirA = path.join(scratch, "landed-A");
const vA = verifyLanded("A", resA, dirA);

// sequentialize: main's new ops then fork's new ops, re-mined
const expectedA = mainPlannerOps.concat(FORK_PLANNER_OPS);
const gotAOps = cellOps(dirA, "logic/planner");
check(arrEq(gotAOps, expectedA), `A: sequentialize ops == mainΔ ++ forkΔ (got ${gotAOps.length}, want ${expectedA.length})`);
check(
  expectedA.includes(FORK_PLANNER_OPS[0]) && expectedA.includes(MAIN_PLANNER_OPS[0]),
  "A: both op sets present",
);
check(
  gotAOps.indexOf(MAIN_PLANNER_OPS[0]) < gotAOps.indexOf(FORK_PLANNER_OPS[0]),
  "A: canonical order ⇒ main's new ops precede fork's new ops",
);
const expectedTip = mine(expectedA, BASIS);
const gotTip = readCellManifest(dirA, "logic/planner").tip;
check(gotTip === expectedTip, `A: re-mined tip == independent re-walk ${expectedTip} (got ${gotTip})`);
check(gotTip !== forkPlannerTip && gotTip !== mainPlannerTip, "A: new tip is re-mined (≠ both carried tips)");
check(readCellManifest(dirA, "logic/planner").count === basePlannerOps.length + 4, "A: count == base + 4 ops");
const decPlanner = resA.decisions.find((x) => x.unit === "cell:logic/planner");
check(decPlanner !== undefined && decPlanner.mode === "sequentialize" && decPlanner.reMined === true, "A: decision records sequentialize + reMined");
check(decPlanner !== undefined && decPlanner.fromMain.length === 2 && decPlanner.fromFork.length === 2, "A: decision op-segment accounting (2 main + 2 fork)");

// disjoint cells both survive
check(readCellReceipts(dirA, "data/gps") === readCellReceipts(forkDir, "data/gps"), "A: fork-only data/gps survives byte-identical");
check(readCellManifest(dirA, "data/gps").tip === forkGpsTip, "A: data/gps tip == fork's");
check(readCellReceipts(dirA, "gpio/rudder") === readCellReceipts(mainDir, "gpio/rudder"), "A: main-only gpio/rudder survives byte-identical");
check(readCellManifest(dirA, "gpio/rudder").tip === mainRudderTip, "A: gpio/rudder tip == main's");

// identical cell stays put
check(readCellReceipts(dirA, "data/compass") === readCellReceipts(forkDir, "data/compass"), "A: idempotent data/compass preserved");

// edges: both new wires land
const edgesA = readQuilt(dirA).edges;
check(edgesA.includes(FORK_EDGE), "A: fork's new edge present");
check(edgesA.includes(MAIN_EDGE), "A: main's new edge present");
check(edgesA.every((e) => forkEdgeSet.includes(e) || mainEdgeSet.includes(e)), "A: resolved edge set ⊆ fork ∪ main");

// routing ledger: both ROUTE_ADDs + the MERGE op, re-mined
const rtA = readRouting(dirA);
check(rtA.includes("ROUTE_ADD data/gps qm_bind gpio/rudder"), "A: ROUTE_ADD for fork edge");
check(rtA.includes("ROUTE_ADD logic/planner qm_tick data/compass"), "A: ROUTE_ADD for main edge");
check(routingOps(dirA).filter((o) => o.startsWith("MERGE")).length === 1, "A: exactly one MERGE op");
check(/^MERGE fork=task-1 base=[0-9a-f]+ cells=[0-9a-f]{16} edges=[0-9a-f]{16} token=tok-local-1$/.test(resA.mergeOp), `A: MERGE op shape (§3.4): ${resA.mergeOp}`);
check(resA.routing.tip === mine(routingOps(dirA), BASIS), "A: routing tip == independent re-walk of the merged ledger");
check(resA.routing.count === routingOps(dirA).length, "A: routing count == ledger op count");

// task.json (fork metadata) is never carried into the landed quilt
check(!readdirSync(dirA).includes("task.json"), "A: task.json not carried into the merged quilt");

console.log(`RUN A (sequentialize) → quilt.ts ok=${vA.ok}, python ok=yes`);
console.log(`  mergeOp: ${resA.mergeOp}`);

// ------------------------------ RUN A2: sequentialize, fork-first (option)

const resA2 = await mergeQuilt(
  reader,
  forkHead,
  mainHead,
  baseSha,
  { "cell:logic/planner": "sequentialize" },
  { forkName: "task-1", tokenId: "tok-local-2", sequentializeOrder: "fork-first" },
);
check(resA2.ok, "A2: executor ok");
const dirA2 = path.join(scratch, "landed-A2");
verifyLanded("A2", resA2, dirA2);
check(
  arrEq(cellOps(dirA2, "logic/planner"), basePlannerOps.concat(FORK_PLANNER_OPS, MAIN_PLANNER_OPS)),
  "A2: fork-first order = base ++ forkΔ ++ mainΔ",
);
console.log(`RUN A2 (sequentialize fork-first) → quilt.ts ok, order flipped`);

// --------------------------------------------------------- RUN B: take-fork

const resB = await mergeQuilt(
  reader,
  forkHead,
  mainHead,
  baseSha,
  { "cell:logic/planner": "take-fork" },
  { forkName: "task-1", tokenId: "tok-local-3" },
);
check(resB.ok, "B: executor ok");
const dirB = path.join(scratch, "landed-B");
verifyLanded("B", resB, dirB);
check(readCellReceipts(dirB, "logic/planner") === readCellReceipts(forkDir, "logic/planner"), "B: take-fork lands fork's planner bytes exactly");
check(readCellManifest(dirB, "logic/planner").tip === forkPlannerTip, "B: take-fork tip == fork tip");
check(arrEq(cellOps(dirB, "logic/planner"), forkPlannerOps), "B: take-fork drops main's planner ops");
check(readCellReceipts(dirB, "gpio/rudder") === readCellReceipts(mainDir, "gpio/rudder"), "B: disjoint main cell still survives");
console.log(`RUN B (take-fork) → fork's logic/planner wins; quilt.ts ok`);

// --------------------------------------------------------- RUN C: take-main

const resC = await mergeQuilt(
  reader,
  forkHead,
  mainHead,
  baseSha,
  { "cell:logic/planner": "take-main" },
  { forkName: "task-1", tokenId: "tok-local-4" },
);
check(resC.ok, "C: executor ok");
const dirC = path.join(scratch, "landed-C");
verifyLanded("C", resC, dirC);
check(readCellReceipts(dirC, "logic/planner") === readCellReceipts(mainDir, "logic/planner"), "C: take-main lands main's planner bytes exactly");
check(readCellManifest(dirC, "logic/planner").tip === mainPlannerTip, "C: take-main tip == main tip");
check(arrEq(cellOps(dirC, "logic/planner"), mainPlannerOps), "C: take-main drops fork's planner ops");
check(readCellReceipts(dirC, "data/gps") === readCellReceipts(forkDir, "data/gps"), "C: disjoint fork cell still survives");
console.log(`RUN C (take-main) → main's logic/planner wins; quilt.ts ok`);

// -------------------------------------- RUN D/E: guard rails (must not be ok)

const resD = await mergeQuilt(reader, forkHead, mainHead, baseSha, {}, { forkName: "task-1" });
check(resD.ok === false && resD.unresolved.includes("cell:logic/planner"), "D: unresolved conflict ⇒ ok=false");

const resE = await mergeQuilt(
  reader,
  forkHead,
  mainHead,
  baseSha,
  { "cell:data/gps": "take-fork" },
  { forkName: "task-1" },
);
check(resE.ok === false && resE.unknownResolutions.includes("cell:data/gps"), "E: resolution on a non-conflict unit ⇒ ok=false");

// ------------------------------- RUN A round-trip through a local bare remote

const bareDir = path.join(scratch, "landed.git");
const rtDir = path.join(scratch, "landed-A-roundtrip");
execFileSync("git", ["init", "-q", dirA], { stdio: ["ignore", "pipe", "pipe"] });
git(dirA, ["add", "-A"]);
git(dirA, ["-c", "commit.gpgsign=false", "-c", "user.email=clerk@local", "-c", "user.name=Clerk", "commit", "-q", "-m", "land B3.3 merge (sequentialize)"]);
execFileSync("git", ["init", "--bare", "-q", bareDir], { stdio: ["ignore", "pipe", "pipe"] });
git(dirA, ["remote", "add", "origin", bareDir]);
git(dirA, ["push", "-q", "origin", "HEAD:main"]);
execFileSync("git", ["clone", "--quiet", "--branch", "main", bareDir, rtDir], { stdio: ["ignore", "pipe", "pipe"] });

const rtMap = mapDir(rtDir);
const aMap = mapDir(dirA);
const samePaths =
  rtMap.size === aMap.size && [...aMap.keys()].every((p) => rtMap.has(p));
const sameBytes = samePaths && [...aMap.entries()].every(([p, b]) => Buffer.compare(Buffer.from(b), Buffer.from(rtMap.get(p))) === 0);
check(samePaths, "round-trip: same file set after push/clone");
check(sameBytes, "round-trip: identical bytes after push/clone");
const vRT = verifyQuilt(quiltFilesFromDir(rtDir));
check(vRT.ok, "round-trip: merged quilt verifies ok after the wire");
console.log(`\nround-trip → pushed to local bare, cloned back, ${rtMap.size} files, verify ok=${vRT.ok}`);

// ------------------------------------------------------------------- report

console.log("\n--- summary ---");
console.log(`resolutions exercised: sequentialize (main-first, fork-first), take-fork, take-main`);
console.log(`merged quilts verified ok: A, A2, B, C (+ A round-trip) — TS quilt.ts and python quiltgen.py`);
console.log(`unresolved/unknown guard rails: ok=false as expected`);

if (failures.length > 0) {
  console.error(`\nB3.3 REHEARSAL FAIL (${failures.length}):`);
  for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
  console.error(`scratch kept: ${scratch}`);
  process.exit(1);
}
console.log("\nB3.3 MERGE REHEARSAL OK — resolved quilt verifies; all resolution rules hold");
rmSync(scratch, { recursive: true, force: true });
