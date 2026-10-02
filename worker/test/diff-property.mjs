/**
 * diff-property.mjs — B3.2 property receipt: the conflict rule, randomized.
 *
 * 1. mint a quilt with lattice/quiltgen.py (python, B1 scheme) as the genesis
 *    repo → that commit is the common BASE;
 * 2. clone it twice → two REAL local forks (fork repo, main repo);
 * 3. for each of N (>= 1000 by default) random fork pairs: reset both to
 *    base, apply randomized edits, commit, then run the adapter-pure diff
 *    core (worker/src/diff.ts) through the LocalGit adapter and assert:
 *      - disjoint edits (different cells / different edge ids) ⇒ conflict ∅
 *      - same-cell edits with divergent content ⇒ conflict set EXACTLY {that
 *        cell}, never more
 *      - identical-content same-unit edits ⇒ idempotent, no conflict
 *    and, as a theorem-checked extra, that edge units never conflict (an edge
 *    id's content is its presence, so both-sides ⟹ identical).
 *
 * Usage: node --experimental-strip-types test/diff-property.mjs [pairs]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node's --experimental-strip-types does not rewrite "./x.js" → "./x.ts".
// diff.ts is Worker-style (imports "./chain.js"); map it back to source here.
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

const { diffMerge, classifyPath, edgeLine, edgeId } = await import("../src/diff.ts");
const { LocalGit } = await import("./localgit.mjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const QUILTGEN = path.join(repoRoot, "lattice", "quiltgen.py");

const PAIRS = Number(process.argv[2] ?? 1200);
const SEED = 20261001;

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

/** Append ops to a receipt chain file; return the new tip + total count. */
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

// ------------------------------------------------------------- quilt editing

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
  const line = edgeLine(from, op, to);
  q.edges = [...new Set([...(q.edges || []), line])].sort();
  const { head, count } = appendChain(
    path.join(dir, "routing.txt"),
    [`ROUTE_ADD ${from} ${op} ${to}`],
    q.routing.basis,
  );
  q.routing = { ...q.routing, count, tip: head };
  writeFileSync(qPath, JSON.stringify(q, null, 2) + "\n");
}

function editEdgeDel(dir, line) {
  const qPath = path.join(dir, "quilt.json");
  const q = JSON.parse(readFileSync(qPath, "utf8"));
  const id = edgeId(line);
  q.edges = (q.edges || []).filter((e) => edgeId(e) !== id).sort();
  const { head, count } = appendChain(
    path.join(dir, "routing.txt"),
    [`ROUTE_DEL ${id}`],
    q.routing.basis,
  );
  q.routing = { ...q.routing, count, tip: head };
  writeFileSync(qPath, JSON.stringify(q, null, 2) + "\n");
}

function applySpec(dir, spec) {
  for (const [addr, ops] of spec.cells) editCell(dir, addr, ops);
  for (const [from, op, to] of spec.edgeAdds) editEdgeAdd(dir, from, op, to);
  for (const line of spec.edgeDels) editEdgeDel(dir, line);
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

// ------------------------------------------------------------- random source

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pickOne = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function shuffled(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------------------------------------------------------------- the quilt domain

const CELLS = ["data/gps", "data/compass", "logic/planner", "gpio/rudder"];
const BASE_EDGES = [
  "data/compass qm_bind logic/planner",
  "data/gps qm_bind logic/planner",
  "logic/planner qm_effect gpio/rudder",
  "logic/planner qm_view data/gps",
];
const NEW_EDGES = [
  ["data/gps", "qm_bind", "gpio/rudder"],
  ["logic/planner", "qm_tick", "data/compass"],
  ["gpio/rudder", "qm_view", "data/gps"],
  ["data/compass", "qm_view", "data/gps"],
  ["logic/planner", "qm_effect", "gpio/trim-tab"],
  ["data/gps", "qm_view", "data/compass"],
  ["gpio/rudder", "qm_bind", "data/compass"],
];
const OPS = {
  "data/gps": ["FIX lat=1.0 lon=2.0 hdop=1.0", "SMOOTH alpha=0.2 window=4", "PUB topic=nav.fix seq=7"],
  "data/compass": ["CAL mag=1.0 decl=2.0", "HEADING deg=90 src=mag", "PUB topic=nav.heading seq=3"],
  "logic/planner": ["BIND input=data.gps -> planner.fix", "PLAN wp=2 speed=1.0", "RULE name=hold", "PUB topic=nav.plan seq=5"],
  "gpio/rudder": ["SET pwm=1500", "LIMIT max_deg=30", "ZERO id=1", "PUB topic=ctl.rudder seq=2"],
};

let OPSEQ = 0;
function mkOp(addr, who, tag) {
  const v = OPS[addr];
  const base = v[OPSEQ % v.length];
  OPSEQ += 1;
  return `${base} by=${who} ref=${tag}#${OPSEQ}`;
}
function mkOps(addr, who, tag, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(mkOp(addr, who, tag));
  return out;
}

const WEIGHTS = [
  ["disjoint", 3],
  ["disjoint+edges", 2],
  ["same-cell", 3],
  ["mixed", 2],
  ["same-cell-identical", 2],
  ["edge-add-same", 2],
  ["edge-del-same", 1],
  ["edge-rewire", 2],
];
const WEIGHT_TOTAL = WEIGHTS.reduce((s, w) => s + w[1], 0);

function pickType(rng) {
  let r = rng() * WEIGHT_TOTAL;
  for (const [t, w] of WEIGHTS) {
    r -= w;
    if (r < 0) return t;
  }
  return WEIGHTS[0][0];
}

/**
 * Build one random scenario: per-side edit specs + the EXACT expected conflict
 * set. `kind` drives which invariant the case is counted under.
 */
function buildScenario(rng, iter) {
  const token = `i${iter}`;
  const type = pickType(rng);
  const fork = { cells: [], edgeAdds: [], edgeDels: [] };
  const main = { cells: [], edgeAdds: [], edgeDels: [] };
  let expectConflicts = [];
  let expectIdempotent = [];
  let kind = "disjoint";

  switch (type) {
    case "disjoint": {
      const cs = shuffled(rng, CELLS);
      const nf = Math.min(randInt(rng, 1, 2), 3);
      const nm = Math.min(randInt(rng, 1, 2), 4 - nf);
      for (const a of cs.slice(0, nf)) fork.cells.push([a, mkOps(a, "F", token, randInt(rng, 1, 3))]);
      for (const a of cs.slice(nf, nf + nm)) main.cells.push([a, mkOps(a, "M", token, randInt(rng, 1, 3))]);
      kind = "disjoint";
      break;
    }
    case "disjoint+edges": {
      const cs = shuffled(rng, CELLS);
      const nf = Math.min(randInt(rng, 1, 2), 2);
      const nm = Math.min(randInt(rng, 1, 2), 4 - nf);
      for (const a of cs.slice(0, nf)) fork.cells.push([a, mkOps(a, "F", token, randInt(rng, 1, 2))]);
      for (const a of cs.slice(nf, nf + nm)) main.cells.push([a, mkOps(a, "M", token, randInt(rng, 1, 2))]);
      const es = shuffled(rng, NEW_EDGES);
      fork.edgeAdds.push(es[0]);
      main.edgeAdds.push(es[1]);
      kind = "disjoint";
      break;
    }
    case "same-cell": {
      const addr = pickOne(rng, CELLS);
      fork.cells.push([addr, mkOps(addr, "F", token, randInt(rng, 1, 3))]);
      main.cells.push([addr, mkOps(addr, "M", token, randInt(rng, 1, 3))]);
      expectConflicts = [`cell:${addr}`];
      kind = "divergent";
      break;
    }
    case "mixed": {
      const cs = shuffled(rng, CELLS);
      const shared = cs[0];
      fork.cells.push([shared, mkOps(shared, "F", token, randInt(rng, 1, 2))]);
      fork.cells.push([cs[1], mkOps(cs[1], "F", token, 1)]);
      main.cells.push([shared, mkOps(shared, "M", token, randInt(rng, 1, 2))]);
      main.cells.push([cs[2], mkOps(cs[2], "M", token, 1)]);
      expectConflicts = [`cell:${shared}`];
      kind = "divergent";
      break;
    }
    case "same-cell-identical": {
      const addr = pickOne(rng, CELLS);
      const op = mkOp(addr, "both", token);
      fork.cells.push([addr, [op]]);
      main.cells.push([addr, [op]]);
      expectIdempotent = [`cell:${addr}`];
      kind = "identical";
      break;
    }
    case "edge-add-same": {
      const [from, op, to] = pickOne(rng, NEW_EDGES);
      fork.edgeAdds.push([from, op, to]);
      main.edgeAdds.push([from, op, to]);
      expectIdempotent = [`edge:${from}|${op}|${to}`];
      kind = "identical";
      break;
    }
    case "edge-del-same": {
      const line = pickOne(rng, BASE_EDGES);
      fork.edgeDels.push(line);
      main.edgeDels.push(line);
      expectIdempotent = [`edge:${edgeId(line)}`];
      kind = "identical";
      break;
    }
    case "edge-rewire": {
      // both rewire the same base edge to DIFFERENT targets (B3 §2.5): the old
      // id is deleted on both sides (idempotent); the two NEW ids are disjoint.
      const old = "logic/planner qm_effect gpio/rudder";
      fork.edgeDels.push(old);
      main.edgeDels.push(old);
      fork.edgeAdds.push(["logic/planner", "qm_effect", "gpio/trim-tab"]);
      main.edgeAdds.push(["logic/planner", "qm_effect", "gpio/flap"]);
      expectIdempotent = [`edge:${edgeId(old)}`];
      kind = "commute";
      break;
    }
    default:
      throw new Error(`unknown scenario ${type}`);
  }
  return { type, fork, main, expectConflicts, expectIdempotent, kind };
}

// ------------------------------------------------------------------- harness

const failures = [];
function check(cond, label) {
  if (!cond) failures.push(label);
}
const arrEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const scratch = mkdtempSync(path.join(tmpdir(), "b3-2-diff-"));
const genesisDir = path.join(scratch, "genesis");
const forkDir = path.join(scratch, "fork");
const mainDir = path.join(scratch, "main");

console.log(`B3.2 property test — seed=${SEED} pairs=${PAIRS}`);
console.log(`scratch=${scratch}\n`);

// 1. mint the genesis quilt with python (B1 scheme) — git-committed
execFileSync("python3", [QUILTGEN, "--out", genesisDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const baseSha = git(genesisDir, ["rev-parse", "HEAD"]).trim();
console.log(`genesis base commit: ${baseSha}`);

// 2. two real local forks (separate repositories, each holding the base objects)
execFileSync("git", ["clone", "--quiet", genesisDir, forkDir], { stdio: ["ignore", "pipe", "pipe"] });
execFileSync("git", ["clone", "--quiet", genesisDir, mainDir], { stdio: ["ignore", "pipe", "pipe"] });

// one union reader for the whole run (memoized by object hash — unchanged
// quilt subtrees keep their hash, so the cache absorbs the repeated reads)
const reader = new LocalGit([genesisDir, forkDir, mainDir]);

// 3. sanity: the path→unit mapping (B3 §2.3 step 3)
check(classifyPath("cells/logic/planner/receipts.txt").unit === "cell:logic/planner", "classifyPath cell");
check(classifyPath("cells/logic/planner/body/planner.md").unit === "cell:logic/planner", "classifyPath cell body");
check(classifyPath("quilt.json").kind === "routing", "classifyPath quilt.json → routing");
check(classifyPath("routing.txt").kind === "routing", "classifyPath routing.txt → routing");
check(classifyPath("task.json").kind === "ignore", "classifyPath task.json → ignore");

// 4. the randomized property loop
let disjointTotal = 0, disjointOk = 0;
let divergentTotal = 0, divergentOk = 0;
let identicalTotal = 0, identicalOk = 0;
let cellConflicts = 0, edgeConflicts = 0, edgeUnitsTouched = 0;
let exactUnionCases = 0, exactUnionOk = 0;

const t0 = Date.now();
for (let i = 0; i < PAIRS; i++) {
  const rng = mulberry32(SEED ^ (i * 2654435761));
  const s = buildScenario(rng, i);

  git(forkDir, ["reset", "--hard", "-q", baseSha]);
  git(mainDir, ["reset", "--hard", "-q", baseSha]);
  applySpec(forkDir, s.fork);
  applySpec(mainDir, s.main);
  const forkHead = commitAll(forkDir, "fork", `fork ${s.type} ${i}`);
  const mainHead = commitAll(mainDir, "main", `main ${s.type} ${i}`);

  const d = await diffMerge(reader, forkHead, mainHead, baseSha);
  const conflicts = d.conflicts.slice().sort();
  const expected = s.expectConflicts.slice().sort();

  cellConflicts += d.units.filter((u) => u.unitType === "cell" && u.verdict === "conflict").length;
  edgeConflicts += d.units.filter((u) => u.unitType === "edge" && u.verdict === "conflict").length;
  edgeUnitsTouched += d.units.filter((u) => u.unitType === "edge").length;

  // universal invariant: conflict set is exactly the expected set
  check(arrEq(conflicts, expected), `#${i} ${s.type}: conflicts ${JSON.stringify(conflicts)} != ${JSON.stringify(expected)}`);
  exactUnionCases++;
  if (arrEq(conflicts, expected)) exactUnionOk++;

  if (s.kind === "disjoint" || s.kind === "commute") {
    disjointTotal++;
    const clean =
      conflicts.length === 0 &&
      d.units.every((u) => u.verdict === "fork-only" || u.verdict === "main-only" || u.verdict === "idempotent");
    if (clean) disjointOk++;
    check(clean, `#${i} ${s.type}: disjoint ⇒ conflict ∅, all units one-sided/idempotent`);
  }
  if (s.kind === "divergent") {
    divergentTotal++;
    const exact = expected.length > 0 && arrEq(conflicts, expected);
    if (exact) divergentOk++;
    check(exact, `#${i} ${s.type}: divergent same-unit ⇒ conflicts exactly ${JSON.stringify(expected)}`);
    const unit = d.units.find((u) => u.unit === expected[0]);
    check(unit !== undefined && unit.verdict === "conflict", `#${i} ${s.type}: unit marked conflict`);
  }
  if (s.kind === "identical") {
    identicalTotal++;
    const ok =
      conflicts.length === 0 && s.expectIdempotent.every((u) => d.idempotent.includes(u));
    if (ok) identicalOk++;
    check(ok, `#${i} ${s.type}: identical ⇒ idempotent ${JSON.stringify(s.expectIdempotent)}, no conflict`);
  }
  if (s.kind === "commute") {
    check(
      s.expectIdempotent.every((u) => d.idempotent.includes(u)),
      `#${i} edge-rewire: old edge id is idempotent (both deleted)`,
    );
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// --------------------------------------------------------------- the receipt

const pct = (ok, total) => (total === 0 ? "n/a" : `${((100 * ok) / total).toFixed(1)}%`);

console.log(`\npairs: ${PAIRS} (${elapsed}s)`);
console.log(`disjoint edits ⇒ conflict set ∅ (always):        ${disjointOk}/${disjointTotal}  ${pct(disjointOk, disjointTotal)}`);
console.log(`same-unit divergent ⇒ EXACTLY that unit:         ${divergentOk}/${divergentTotal}  ${pct(divergentOk, divergentTotal)}`);
console.log(`identical same-unit ⇒ idempotent, no conflict:   ${identicalOk}/${identicalTotal}  ${pct(identicalOk, identicalTotal)}`);
console.log(`conflict set == expected (all cases):            ${exactUnionOk}/${exactUnionCases}  ${pct(exactUnionOk, exactUnionCases)}`);
console.log(`edge units touched: ${edgeUnitsTouched}; edge-unit conflicts: ${edgeConflicts} (presence semantics ⇒ impossible)`);
console.log(`cell-unit conflicts observed: ${cellConflicts}`);

if (failures.length > 0) {
  console.error(`\nB3.2 PROPERTY FAIL (${failures.length}):`);
  for (const f of failures.slice(0, 20)) console.error(`  - ${f}`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}
console.log("\nB3.2 DIFF PROPERTY OK — conflict rule holds across all random fork pairs");
rmSync(scratch, { recursive: true, force: true });
