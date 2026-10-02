/**
 * parity.mjs — cross-language parity receipt for the B2 port.
 *
 * Verifies a cell minted by B1 Python (cellgen.py) using the B2 TypeScript
 * chain. Byte-identical tip = the port is faithful. Also tampers one op and
 * proves the TS verifier catches the break.
 *
 * Usage: node --experimental-strip-types test/parity.mjs <cellgen-output-dir>
 */
import { readFileSync } from "node:fs";
import {
  verifyChain,
  appendReceipt,
  GENESIS_BASIS,
} from "../src/chain.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: parity.mjs <cell-dir>");
  process.exit(2);
}

const genesis = JSON.parse(readFileSync(`${dir}/genesis.json`, "utf8"));
const receipts = readFileSync(`${dir}/receipts.txt`, "utf8");

const v = verifyChain(receipts, genesis, 3);
console.log(`scheme=${v.scheme} (python cellgen scheme=${genesis.scheme})`);
console.log(`basis=${v.basis} (expected ${GENESIS_BASIS})`);
console.log(
  `positions=${v.positions} expected=${v.expectedCount} match=${v.countMatch}`,
);
console.log(`tip=${v.tip} expected=${v.expectedTip} match=${v.tipMatch}`);
console.log(`chain_ok=${v.chainOk} first_break_at=${v.firstBreakAt}`);
console.log(`ok=${v.ok}`);

if (!v.ok) {
  console.error("PARITY FAIL: ts verify did not accept the python-minted chain");
  process.exit(1);
}

// Tamper proof: change one op — the verifier must catch it at position 0.
const lines = receipts.split("\n");
const first = lines[0] ?? "";
const sp = first.indexOf(" ");
lines[0] = first.slice(0, sp) + " " + first.slice(sp + 1) + "x";
const tv = verifyChain(lines.join("\n"), genesis, 3);
console.log(`tamper_detected=${!tv.chainOk} first_break_at=${tv.firstBreakAt}`);
if (tv.chainOk) {
  console.error("PARITY FAIL: tampered chain was accepted");
  process.exit(1);
}

// Append sanity: same op twice from same head → same receipt.
const a = appendReceipt(v.tip, "syn i=0 s=42");
const b = appendReceipt(v.tip, "syn i=0 s=42");
console.log(`append_deterministic=${a === b} (${a})`);
if (a !== b) process.exit(1);

console.log(
  "PARITY OK: ts chain accepts python-minted cell, detects tamper, appends deterministically",
);
