/**
 * quilt-parity.mjs — B3.1 cross-language parity receipt for a WHOLE quilt.
 *
 * 1. mint a 4-cell quilt with lattice/quiltgen.py (python, B1 scheme)
 * 2. re-walk it with python (`quiltgen.py --verify`) → the python oracle tips
 * 3. verify the same text with the TS quilt verifier (worker/src/quilt.ts)
 * 4. assert every cell tip AND the routing tip are byte-identical, and that
 *    the edge set (quilt.json) matches the routing ledger
 * 5. tamper one cell's receipts.txt / the routing.txt → must be caught
 *
 * Usage: node --experimental-strip-types test/quilt-parity.mjs
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node's --experimental-strip-types does not rewrite "./x.js" → "./x.ts".
// quilt.ts is written like Worker code (imports "./chain.js"); map that
// specifier back to the .ts source for this test only.
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

const { verifyQuilt } = await import("../src/quilt.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const QUILTGEN = path.join(repoRoot, "lattice", "quiltgen.py");

const failures = [];
function check(cond, label) {
  console.log(`${cond ? "ok  " : "FAIL"}  ${label}`);
  if (!cond) failures.push(label);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`command failed: ${cmd} ${args.join(" ")}`);
    console.error(r.stdout);
    console.error(r.stderr);
    process.exit(1);
  }
  return r.stdout;
}

function readQuilt(dir) {
  const quiltJson = readFileSync(path.join(dir, "quilt.json"), "utf8");
  const quilt = JSON.parse(quiltJson);
  const cells = {};
  for (const addr of quilt.cells) {
    const cdir = path.join(dir, "cells", ...addr.split("/"));
    cells[addr] = {
      manifestJson: readFileSync(path.join(cdir, "cell.json"), "utf8"),
      receiptsText: readFileSync(path.join(cdir, "receipts.txt"), "utf8"),
    };
  }
  return {
    quiltJson,
    quilt,
    routingText: readFileSync(path.join(dir, "routing.txt"), "utf8"),
    cells,
  };
}

const scratch = mkdtempSync(path.join(tmpdir(), "b3-1-quilt-"));
console.log(`scratch: ${scratch}\n`);

// ---- 1. mint with python --------------------------------------------------
console.log(run("python3", [QUILTGEN, "--out", path.join(scratch, "quilt"), "--no-git"]));

// ---- 2. python oracle (independent re-walk of the minted text) ------------
const oracle = JSON.parse(run("python3", [QUILTGEN, "--verify", path.join(scratch, "quilt")]));
check(oracle.ok === true, `python oracle verifies the minted quilt (ok=${oracle.ok})`);

// ---- 3. TS verify the same text ------------------------------------------
const files = readQuilt(path.join(scratch, "quilt"));
const v = verifyQuilt(files, 3);
console.log(`\nTS: ok=${v.ok} cells_ok=${v.cellsOk} routing_ok=${v.routingOk} edge_set_ok=${v.edgeSetOk}`);

// ---- 4. parity: byte-identical tips --------------------------------------
let tipsMatch = true;
for (const c of v.cells) {
  const py = oracle.cells[c.address];
  const same = py && py.tip === c.tip;
  tipsMatch = tipsMatch && same;
  console.log(
    `cell ${c.address.padEnd(14)} py=${py?.tip} ts=${c.tip} ` +
    `count=${c.count} match=${same}`,
  );
}
check(tipsMatch, "all 4 cell tips byte-identical (python ↔ TS)");
check(v.cells.length === 4, `quilt has 4 cells (got ${v.cells.length})`);

const rPy = oracle.routing.tip;
const rTs = v.routing.tip;
console.log(`routing        py=${rPy} ts=${rTs} count=${v.routing.positions}`);
check(rPy === rTs, "routing tip byte-identical (python ↔ TS)");
check(v.routing.tip === files.quilt.routing.tip, "routing tip matches quilt.json anchor");

// tips must also match the python-minted manifests
for (const c of v.cells) {
  check(c.tipMatch === true && c.countMatch === true, `cell ${c.address} tip+count match manifest`);
}

check(v.ok === true, "TS quilt verify: overall ok");
check(v.edgeSetOk === true, "edge set (quilt.json) == routing ledger (ROUTE_ADD ops)");
check(oracle.edge_set_ok === true, "python oracle agrees on the edge set");

// ---- 5. tamper: one cell's receipts.txt ----------------------------------
const t1 = path.join(scratch, "tamper-cell");
cpSync(path.join(scratch, "quilt"), t1, { recursive: true });
const victim = "logic/planner";
const vPath = path.join(t1, "cells", ...victim.split("/"), "receipts.txt");
const vLines = readFileSync(vPath, "utf8").split("\n");
const sp = vLines[0].indexOf(" ");
vLines[0] = vLines[0].slice(0, sp + 1) + vLines[0].slice(sp + 1) + "x";
writeFileSync(vPath, vLines.join("\n"));

const t1v = verifyQuilt(readQuilt(t1), 3);
console.log(`\ntamper cell ${victim}: ok=${t1v.ok} cells_ok=${t1v.cellsOk}`);
check(t1v.ok === false, `tampered cell ${victim} ⇒ quilt not ok`);
check(t1v.cellsOk === false, "tampered cell ⇒ cells_ok false");
const victimResult = t1v.cells.find((c) => c.address === victim);
check(!!victimResult && victimResult.chainOk === false, "tampered cell chain break detected");
check(
  t1v.cells.filter((c) => c.address !== victim).every((c) => c.ok === true),
  "untouched cells still verify after tamper",
);

// ---- 6. tamper: routing.txt ----------------------------------------------
const t2 = path.join(scratch, "tamper-routing");
cpSync(path.join(scratch, "quilt"), t2, { recursive: true });
const rPath = path.join(t2, "routing.txt");
const rLines = readFileSync(rPath, "utf8").split("\n");
const rsp = rLines[0].indexOf(" ");
rLines[0] = rLines[0].slice(0, rsp + 1) + rLines[0].slice(rsp + 1) + "x";
writeFileSync(rPath, rLines.join("\n"));

const t2v = verifyQuilt(readQuilt(t2), 3);
console.log(`\ntamper routing: ok=${t2v.ok} routing_ok=${t2v.routingOk} ` +
  `first_break_at=${t2v.routing.firstBreakAt}`);
check(t2v.ok === false, "tampered routing.txt ⇒ quilt not ok");
check(t2v.routingOk === false, "tampered routing ⇒ routing_ok false");
check(t2v.routing.chainOk === false, "tampered routing chain break detected");

// ---- verdict --------------------------------------------------------------
console.log("");
if (failures.length > 0) {
  console.error(`QUILT PARITY FAIL (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("QUILT PARITY OK: 4 cells + routing byte-identical python↔TS, edge set agrees, tamper caught");
rmSync(scratch, { recursive: true, force: true });
