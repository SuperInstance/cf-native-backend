/**
 * chain.ts — the cell receipt chain, ported from B1 Python to TypeScript.
 *
 * Source of truth (do NOT invent a new scheme):
 *   lattice/hello-cell/cellgen.py  (mint)   — SuperInstance/frozen-clock-lab @poc
 *   lattice/hello-cell/wake.sh     (verify) — same fnv1a-64 walk, genesis→tip
 *
 * Scheme:
 *   receipt_i = fnv1a64(prev_head + "|" + canonical(op))
 *   genesis   = "%016x" % FNV64_OFFSET     (the empty-string basis)
 *   canonical = op with "\n" → "\\n"        (single line, unambiguous)
 * Receipts are stored one per line as: "<receipt> <op>"
 * Position is an integer index — never a time. Order, not clock.
 */

export const SCHEME = "fnv1a-64-chain-v1";

export const FNV64_OFFSET = 0xcbf29ce484222325n;
export const FNV64_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

const encoder = new TextEncoder();

/** FNV-1a 64-bit over UTF-8 bytes (BigInt — the multiply needs 64 bits). */
export function fnv1a64(data: string | Uint8Array): bigint {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  let h = FNV64_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]!);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h;
}

/** Canonical single-line op form (mirrors cellgen.canonical). */
export function canonical(op: string): string {
  return op.replaceAll("\n", "\\n");
}

/** 16-char lowercase hex, like Python "%016x". */
export function hex16(h: bigint): string {
  return h.toString(16).padStart(16, "0");
}

/** The genesis basis — where every chain starts. */
export const GENESIS_BASIS = hex16(FNV64_OFFSET);

/** Append: the next receipt given the current head and an op. */
export function appendReceipt(head: string, op: string): string {
  return hex16(fnv1a64(head + "|" + canonical(op)));
}

export interface Genesis {
  scheme: string;
  basis: string;
  count: number;
  tip: string;
  seed?: number;
  note?: string;
}

export interface ReceiptTailEntry {
  position: number;
  receipt: string;
  op: string;
}

export interface ChainVerify {
  scheme: string;
  basis: string;
  positions: number;
  tip: string;
  chainOk: boolean;
  firstBreakAt: number | null;
  expectedTip: string | null;
  tipMatch: boolean | null; // null when genesis carries no tip
  expectedCount: number | null;
  countMatch: boolean | null; // null when genesis carries no count
  tail: ReceiptTailEntry[];
  ok: boolean;
}

/**
 * Verify a receipts.txt body against its genesis anchor — the wake.sh walk:
 * start at the basis, recompute every receipt, catch the first break,
 * compare tip and count. O(1) memory beyond the tail ring.
 */
export function verifyChain(
  receiptsText: string,
  genesis: Genesis,
  tailKeep = 8,
): ChainVerify {
  const tail: ReceiptTailEntry[] = [];
  let h = genesis.basis || GENESIS_BASIS;
  let n = 0;
  let firstBreakAt: number | null = null;

  for (const line of receiptsText.split("\n")) {
    if (line === "") continue; // Python: rstrip("\n") + `if not line: continue`
    const sp = line.indexOf(" ");
    if (sp < 0) {
      firstBreakAt = n; // malformed line — Python would ValueError; we mark it
      break;
    }
    const rec = line.slice(0, sp);
    const op = line.slice(sp + 1);
    if (appendReceipt(h, op) !== rec) {
      firstBreakAt = n;
      break;
    }
    h = rec;
    tail.push({ position: n, receipt: rec, op });
    if (tail.length > tailKeep) tail.shift();
    n++;
  }

  const chainOk = firstBreakAt === null;
  const tipMatch = genesis.tip != null ? genesis.tip === h : null;
  const countMatch = genesis.count != null ? genesis.count === n : null;
  return {
    scheme: genesis.scheme,
    basis: genesis.basis || GENESIS_BASIS,
    positions: n,
    tip: h,
    chainOk,
    firstBreakAt,
    expectedTip: genesis.tip ?? null,
    tipMatch,
    expectedCount: genesis.count ?? null,
    countMatch,
    tail,
    ok: chainOk && tipMatch !== false && countMatch !== false,
  };
}

/**
 * Hibernation receipt — the doubt-ledger grammar (all four fields required),
 * ported from lattice/hello-cell/hibernate.sh (doubt-ledger @poc entry.py).
 */
export interface HibernationReceipt {
  id: string;
  ts: number;
  stopped_checking: string;
  because: string;
  covered_by: string;
  revisit_trigger: string;
  kind: "event";
  status: "open";
  expr: null;
  discharge_reason: null;
}

export function buildHibernationReceipt(fields: {
  stopped_checking: string;
  because: string;
  covered_by: string;
  revisit_trigger: string;
  id?: string;
  ts?: number;
}): HibernationReceipt {
  const required = [
    "stopped_checking",
    "because",
    "covered_by",
    "revisit_trigger",
  ] as const;
  const missing = required.filter((k) => !fields[k]);
  if (missing.length > 0) {
    throw new Error(
      "hibernation receipt missing required field(s): " + missing.join(", "),
    );
  }
  return {
    id: fields.id ?? crypto.randomUUID().replaceAll("-", "").slice(0, 12),
    ts: fields.ts ?? Math.floor(Date.now() / 1000),
    stopped_checking: fields.stopped_checking,
    because: fields.because,
    covered_by: fields.covered_by,
    revisit_trigger: fields.revisit_trigger,
    kind: "event",
    status: "open",
    expr: null,
    discharge_reason: null,
  };
}
