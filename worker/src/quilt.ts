/**
 * quilt.ts — verify a whole quilt (B3.1): every cell's receipt chain plus the
 * quilt-level routing ledger, from raw text only.
 *
 * A quilt (docs/B3-DESIGN.md §2.1) is a tensor of typed cells wired by edges:
 *
 *   cells/<type>/<name>/cell.json   manifest: id, type, opcodes, count, tip
 *                                   (+ scheme/basis = the cell chain anchor)
 *   cells/<type>/<name>/receipts.txt  per-cell fnv1a-64 op chain (B1 scheme v1)
 *   quilt.json                      routing STATE: sorted canonical edge set
 *                                   + the routing chain anchor (basis/tip/count)
 *   routing.txt                     routing LEDGER: fnv1a-64 chain of ROUTE_*
 *                                   ops, one per declared edge (B3 §2.2)
 *
 * Everything here is a **pure function of input text** — no fs, no bindings,
 * no state — so the same module runs under the Worker (reading blobs from an
 * Artifacts repo) and under plain node (reading files in a test). The B2
 * membrane property is kept: verification is a replay, not a lookup.
 *
 * The chain walk itself is NOT re-implemented: it is chain.ts's verifyChain
 * (the B1 physics), applied once per cell and once to the routing ledger.
 */

import {
  SCHEME,
  GENESIS_BASIS,
  verifyChain,
  type ChainVerify,
  type Genesis,
} from "./chain.js";

/** One cell's manifest (cell.json). Extends the chain anchor (Genesis). */
export interface CellManifest extends Genesis {
  id: string;
  type: string;
  name?: string;
  opcodes: string[];
}

/** The quilt manifest (quilt.json). */
export interface QuiltManifest {
  quilt: string;
  scheme: string;
  basis?: string;
  cells: string[];
  /** Canonical edge lines: "edge <from> <opcode> <to>" (B3 §2.2). */
  edges: string[];
  routing?: {
    scheme?: string;
    basis?: string;
    count?: number;
    tip?: string;
  };
}

/** Raw per-cell text (manifest + receipts chain). */
export interface QuiltCellInput {
  manifestJson: string;
  receiptsText: string;
}

/** Raw quilt text as read from a repo — the verifier's only input. */
export interface QuiltFiles {
  quiltJson: string;
  routingText: string;
  /** Keyed by canonical cell address, e.g. "logic/planner". */
  cells: Record<string, QuiltCellInput>;
}

export interface QuiltCellVerify {
  address: string;
  id: string | null;
  type: string | null;
  opcodes: string[];
  count: number | null;
  tip: string;
  expectedTip: string | null;
  tipMatch: boolean | null;
  countMatch: boolean | null;
  chainOk: boolean;
  firstBreakAt: number | null;
  /** manifest present, well-formed, addressed right, and agrees with the walk */
  manifestOk: boolean;
  ok: boolean;
}

export interface RoutingLedger {
  /** Canonical edge lines added by ROUTE_ADD ops, in ledger order. */
  adds: string[];
  /** Edge ids removed by ROUTE_DEL ops ("<from>|<opcode>|<to>"). */
  dels: string[];
  merges: number;
  /** Ops that are neither ROUTE_ADD/DEL nor MERGE (warning, not failure). */
  unknown: string[];
}

export interface QuiltVerify {
  quilt: string;
  scheme: string;
  basis: string;
  ok: boolean;
  cellsOk: boolean;
  routingOk: boolean;
  edgeSetOk: boolean;
  cells: QuiltCellVerify[];
  routing: ChainVerify;
  edges: {
    declared: string[];
    fromLedger: string[];
    missing: string[];
    extra: string[];
  };
  problems: string[];
}

/** "edge <from> <opcode> <to>" — the canonical edge line (B3 §2.2). */
export function edgeLine(from: string, opcode: string, to: string): string {
  return `edge ${from} ${opcode} ${to}`;
}

/** Edge id = "<from>|<opcode>|<to>". */
export function edgeId(line: string): string {
  return line.replace(/^edge /, "").split(" ").join("|");
}

/** Parse routing.txt lines into their op verbs (B3 §2.2 opcode set). */
export function parseRoutingOps(routingText: string): RoutingLedger {
  const adds: string[] = [];
  const dels: string[] = [];
  const unknown: string[] = [];
  let merges = 0;
  for (const line of routingText.split("\n")) {
    if (line === "") continue;
    const sp = line.indexOf(" ");
    if (sp < 0) {
      unknown.push(line);
      continue;
    }
    const op = line.slice(sp + 1);
    const t = op.split(" ");
    if (t[0] === "ROUTE_ADD" && t.length === 4) {
      adds.push(edgeLine(t[1]!, t[2]!, t[3]!));
    } else if (t[0] === "ROUTE_DEL" && t.length === 2) {
      dels.push(t[1]!);
    } else if (t[0] === "MERGE") {
      merges++;
    } else {
      unknown.push(op);
    }
  }
  return { adds, dels, merges, unknown };
}

/** Replay the ledger's edge ops into a sorted edge-line set (set semantics). */
export function deriveEdgeSet(ledger: RoutingLedger): string[] {
  const ids = new Set(ledger.adds.map(edgeId));
  for (const d of ledger.dels) ids.delete(d);
  return [...ids].map((id) => {
    const [from, opcode, to] = id.split("|");
    return edgeLine(from!, opcode!, to!);
  }).sort();
}

function isCanonicalEdge(line: string): boolean {
  return /^edge [a-z0-9-]+\/[a-z0-9-]+ qm_[a-z]+ [a-z0-9-]+\/[a-z0-9-]+$/.test(line);
}

function anchor(q: QuiltManifest): Genesis {
  const r = q.routing ?? {};
  // count/tip absent ⇒ -1 / "" ⇒ verifyChain reports countMatch/tipMatch
  // false, so a missing anchor fails loudly instead of passing silently.
  return {
    scheme: r.scheme ?? q.scheme ?? SCHEME,
    basis: r.basis ?? q.basis ?? GENESIS_BASIS,
    count: r.count ?? -1,
    tip: r.tip ?? "",
  };
}

function emptyChain(basis: string, scheme: string): ChainVerify {
  return {
    scheme,
    basis,
    positions: 0,
    tip: basis,
    chainOk: false,
    firstBreakAt: 0,
    expectedTip: null,
    tipMatch: null,
    expectedCount: null,
    countMatch: null,
    tail: [],
    ok: false,
  };
}

/**
 * Verify a whole quilt from raw text. Walks every cell's receipts.txt and the
 * routing.txt chain, checks each cell manifest against its walk, and checks
 * that the routing STATE (quilt.json edges) equals the routing MEMORY
 * (the ROUTE_ADD ops in routing.txt). Returns per-cell tips + overall ok.
 */
export function verifyQuilt(files: QuiltFiles, tailKeep = 4): QuiltVerify {
  const problems: string[] = [];

  let quilt: QuiltManifest;
  try {
    quilt = JSON.parse(files.quiltJson) as QuiltManifest;
  } catch (err) {
    const basis = GENESIS_BASIS;
    return {
      quilt: "",
      scheme: SCHEME,
      basis,
      ok: false,
      cellsOk: false,
      routingOk: false,
      edgeSetOk: false,
      cells: [],
      routing: emptyChain(basis, SCHEME),
      edges: { declared: [], fromLedger: [], missing: [], extra: [] },
      problems: ["quilt.json is not JSON: " +
        (err instanceof Error ? err.message : String(err))],
    };
  }

  const basis = quilt.basis ?? GENESIS_BASIS;
  const scheme = quilt.scheme ?? SCHEME;
  if (scheme !== SCHEME) {
    problems.push(`quilt scheme ${scheme} != ${SCHEME}`);
  }

  // --- routing ledger (memory) ------------------------------------------ 
  const ledger = parseRoutingOps(files.routingText);
  if (ledger.unknown.length > 0) {
    problems.push(`routing.txt has ${ledger.unknown.length} unrecognized op(s)`);
  }
  const routing = verifyChain(files.routingText, anchor(quilt), tailKeep);
  const routingOk = routing.ok && ledger.unknown.length === 0;
  if (!routing.chainOk) {
    problems.push(`routing chain breaks at position ${routing.firstBreakAt}`);
  }
  if (routing.tipMatch === false) {
    problems.push(`routing tip mismatch: ${routing.tip} != ${routing.expectedTip}`);
  }
  if (routing.countMatch === false) {
    problems.push(`routing count mismatch: ${routing.positions} != ${routing.expectedCount}`);
  }

  // --- routing state (quilt.json edges) vs memory ------------------------
  const declared = [...(quilt.edges ?? [])].sort();
  for (const line of declared) {
    if (!isCanonicalEdge(line)) problems.push(`non-canonical edge line: ${line}`);
  }
  const fromLedger = deriveEdgeSet(ledger);
  const missing = declared.filter((e) => !fromLedger.includes(e));
  const extra = fromLedger.filter((e) => !declared.includes(e));
  const edgeSetOk = missing.length === 0 && extra.length === 0;
  if (!edgeSetOk) {
    problems.push(`edge set mismatch (missing ${missing.length}, extra ${extra.length})`);
  }

  // --- per-cell chains ----------------------------------------------------
  const addresses = [...(quilt.cells ?? [])].sort();
  const results: QuiltCellVerify[] = [];
  for (const addr of addresses) {
    const input = files.cells[addr];
    if (!input) {
      problems.push(`missing cell input: ${addr}`);
      results.push({
        address: addr,
        id: null,
        type: null,
        opcodes: [],
        count: null,
        tip: "",
        expectedTip: null,
        tipMatch: null,
        countMatch: null,
        chainOk: false,
        firstBreakAt: null,
        manifestOk: false,
        ok: false,
      });
      continue;
    }

    let man: CellManifest | null = null;
    try {
      man = JSON.parse(input.manifestJson) as CellManifest;
    } catch {
      problems.push(`cell ${addr}: cell.json is not JSON`);
    }

    if (man === null) {
      results.push({
        address: addr, id: null, type: null, opcodes: [], count: null,
        tip: "", expectedTip: null, tipMatch: null, countMatch: null,
        chainOk: false, firstBreakAt: null, manifestOk: false, ok: false,
      });
      continue;
    }

    const v = verifyChain(input.receiptsText, man, tailKeep);
    const manifestOk =
      man.id === addr &&
      man.scheme === SCHEME &&
      (man.basis ?? basis) === basis &&
      typeof man.tip === "string" &&
      typeof man.count === "number";
    if (!manifestOk) problems.push(`cell ${addr}: manifest malformed or mis-addressed`);
    if (!v.chainOk) problems.push(`cell ${addr}: chain breaks at position ${v.firstBreakAt}`);
    if (v.tipMatch === false) problems.push(`cell ${addr}: tip mismatch`);

    results.push({
      address: addr,
      id: man.id ?? null,
      type: man.type ?? null,
      opcodes: man.opcodes ?? [],
      count: man.count ?? null,
      tip: v.tip,
      expectedTip: v.expectedTip,
      tipMatch: v.tipMatch,
      countMatch: v.countMatch,
      chainOk: v.chainOk,
      firstBreakAt: v.firstBreakAt,
      manifestOk,
      ok: v.ok && manifestOk,
    });
  }

  const cellsOk =
    results.length > 0 &&
    results.length === addresses.length &&
    results.every((c) => c.ok);
  if (!cellsOk) problems.push("one or more cells failed verification");

  const ok = cellsOk && routingOk && edgeSetOk && problems.length === 0;

  return {
    quilt: quilt.quilt ?? "",
    scheme,
    basis,
    ok,
    cellsOk,
    routingOk,
    edgeSetOk,
    cells: results,
    routing,
    edges: { declared, fromLedger, missing, extra },
    problems,
  };
}
