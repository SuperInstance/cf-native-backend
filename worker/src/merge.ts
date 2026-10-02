/**
 * merge.ts — B3.3 pure merge executor (the resolution half of the thesis).
 *
 * Input:  base + fork + main heads, via the SAME abstract `RepoReader` the
 *         B3.2 diff core speaks (`readTree` / `readBlob` / `readFile` /
 *         `readCommit`). No git, no fs, no bindings, no state.
 * Output: a RESOLVED QUILT as a path → content map, plus the decisions that
 *         produced it — deterministic function of the three refs and the
 *         reviewer's per-unit resolution modes.
 *
 * Pipeline (docs/B3-DESIGN.md §2.4 + §3.3 + §3.4):
 *   1. `diffMerge(reader, fork, main, base)` — the B3.2 semantic diff: per-unit
 *      verdicts (`fork-only | main-only | idempotent | conflict`).
 *   2. resolve every unit:
 *        fork-only  → take the touched (fork) side
 *        main-only  → take the touched (main) side
 *        idempotent → both sides already agree; keep main's bytes
 *        conflict   → the reviewer's mode: `take-fork` | `take-main` |
 *                     `sequentialize` (cells only)
 *      `sequentialize` keeps M's new ops then F's new ops on that cell, in
 *      that order (§2.4) — F's op *text* is appended verbatim after M's; the
 *      order is exposed as `sequentializeOrder` (default `"main-first"`).
 *   3. RE-MINE every affected cell's receipts from the FINAL op list, walking
 *      the fnv1a-64 chain from the basis — the tip is *re-derived from
 *      content*, never carried over (a chain is a pure function of its ops;
 *      re-derivation is legal and deterministic). `cell.json` tips/counts are
 *      rewritten from that walk.
 *   4. apply the resolved edge set onto main's routing: emit `ROUTE_ADD` /
 *      `ROUTE_DEL` for the *difference* vs main (main is the landing base),
 *      then append the `MERGE …` receipt op (§3.4) and re-mine the routing
 *      ledger from the basis. `quilt.json` edges + routing anchor are rewritten.
 *
 * The executor is **additive by construction**: the resolved quilt starts from
 * main's whole tree (main is where we land), so untouched cells are copied
 * byte-for-byte and the only replaced paths are those the resolution decided.
 * `task.json` is classified `ignore` by the diff and therefore never carried
 * (fork-point metadata stays in the fork — §1.2).
 *
 * `ok` is true iff every conflict got a resolution, no resolution referenced a
 * non-conflict unit, and every sequentialize was applicable (cells only, with
 * clean op-extension prefixes on both sides).
 */

import {
  appendReceipt,
  canonical,
  fnv1a64,
  hex16,
  GENESIS_BASIS,
  SCHEME,
} from "./chain.js";
import { diffMerge, isTreeMode, edgeId, type RepoReader } from "./diff.js";

// --- public types ----------------------------------------------------------

export type ResolutionMode = "take-fork" | "take-main" | "sequentialize";
/** §2.4 canonical order is "M's new ops then F's new ops" ⇒ "main-first". */
export type SequentializeOrder = "main-first" | "fork-first";
export type Resolutions = Record<string, ResolutionMode>;

export interface MergeOptions {
  /** Repo/task name for the MERGE receipt (§3.4 `fork=<name>`). */
  forkName?: string;
  /** Token id for the MERGE receipt (`token=<id>`, never the plaintext). */
  tokenId?: string;
  /** Op order for `sequentialize`; §2.4 specifies main-first. */
  sequentializeOrder?: SequentializeOrder;
}

export type UnitVerdict = "fork-only" | "main-only" | "idempotent" | "conflict";

export interface MergeDecision {
  /** `cell:<type>/<name>` or `edge:<from>|<opcode>|<to>`. */
  unit: string;
  unitType: "cell" | "edge";
  verdict: UnitVerdict;
  /** resolution applied ("auto" when the verdict decided it). */
  mode: ResolutionMode | "auto";
  source: "fork" | "main" | "both" | "none";
  reason: string;
  /** cell: final presence in the resolved quilt. */
  present?: boolean;
  /** cell op accounting (lengths of the op segments). */
  baseOps?: number;
  mainOps?: number;
  forkOps?: number;
  finalOps?: number;
  fromMain?: string[];
  fromFork?: string[];
  /** cell chain: tip before resolution (main side) and the re-mined tip. */
  oldTip?: string | null;
  newTip?: string | null;
  count?: number;
  /** true when receipts were re-walked from the final op list. */
  reMined?: boolean;
}

export interface MergeResult {
  ok: boolean;
  base: string;
  fork: string;
  main: string;
  forkName: string;
  /** the resolved quilt: every path → content (bytes, as a git blob would be). */
  files: Map<string, Uint8Array>;
  decisions: MergeDecision[];
  /** conflict units the diff reported. */
  conflicts: string[];
  /** conflicts left without a resolution (⇒ ok=false). */
  unresolved: string[];
  /** resolution keys naming a non-conflict unit (⇒ ok=false). */
  unknownResolutions: string[];
  /** resolved cell addresses, sorted. */
  cells: string[];
  /** resolved canonical edge lines, sorted. */
  edges: string[];
  /** ROUTE_ADD/ROUTE_DEL ops appended relative to main (sorted, deterministic). */
  routingOps: string[];
  /** the exact MERGE receipt op appended to routing.txt (§3.4). */
  mergeOp: string;
  routing: { scheme: string; basis: string; count: number; tip: string };
  cellDigest: string;
  edgeDigest: string;
  summary: {
    forkOnly: number;
    mainOnly: number;
    idempotent: number;
    conflict: number;
    cells: number;
    edges: number;
  };
}

interface QuiltJson {
  quilt?: string;
  scheme?: string;
  basis?: string;
  cells?: string[];
  edges?: string[];
  routing?: { scheme?: string; basis?: string; count?: number; tip?: string };
  [k: string]: unknown;
}

// --- small helpers ---------------------------------------------------------

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Ops of a receipts.txt, verbatim and in order (canonical single-line form). */
export function parseOps(receiptsText: string): string[] {
  const ops: string[] = [];
  for (const line of receiptsText.split("\n")) {
    if (line === "") continue;
    const sp = line.indexOf(" ");
    ops.push(sp < 0 ? line : line.slice(sp + 1));
  }
  return ops;
}

/** True when `prefix` is a (possibly equal-length) prefix of `ops`. */
function isPrefix(prefix: string[], ops: string[]): boolean {
  if (prefix.length > ops.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== ops[i]) return false;
  return true;
}

/**
 * Mine a receipt chain from an op list, anchored at `basis`. The tip is a pure
 * function of (basis, ops) — this IS the "re-derive from final content" step.
 */
export function mineReceipts(
  ops: string[],
  basis: string,
): { text: string; tip: string; count: number } {
  let head = basis;
  const lines: string[] = [];
  for (const op of ops) {
    const c = canonical(op);
    head = appendReceipt(head, c);
    lines.push(`${head} ${c}`);
  }
  return {
    text: lines.length === 0 ? "" : lines.join("\n") + "\n",
    tip: head,
    count: ops.length,
  };
}

async function readTextFile(
  reader: RepoReader,
  ref: string,
  path: string,
): Promise<string | null> {
  const bytes = await reader.readFile(ref, path);
  return bytes === null ? null : decoder.decode(bytes);
}

async function resolveSubtreeHash(
  reader: RepoReader,
  rootTree: string,
  segments: string[],
): Promise<string | null> {
  let cur = rootTree;
  for (const seg of segments) {
    const entries = await reader.readTree(cur);
    const e = entries.find((x) => x.name === seg);
    if (e === undefined || !isTreeMode(e.mode)) return null;
    cur = e.hash;
  }
  return cur;
}

async function listSubtree(
  reader: RepoReader,
  treeHash: string,
  prefix: string,
  out: Map<string, Uint8Array>,
): Promise<void> {
  const entries = await reader.readTree(treeHash);
  for (const e of entries) {
    if (isTreeMode(e.mode)) {
      await listSubtree(reader, e.hash, `${prefix}${e.name}/`, out);
    } else {
      out.set(`${prefix}${e.name}`, await reader.readBlob(e.hash));
    }
  }
}

/** Every file under `cells/<addr>/`, keyed by repo-relative path. */
async function readCellFiles(
  reader: RepoReader,
  rootTree: string,
  addr: string,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const sub = await resolveSubtreeHash(reader, rootTree, ["cells", ...addr.split("/")]);
  if (sub === null) return out;
  await listSubtree(reader, sub, `cells/${addr}/`, out);
  return out;
}

function deleteCellFromMap(files: Map<string, Uint8Array>, addr: string): void {
  const prefix = `cells/${addr}/`;
  for (const p of [...files.keys()]) if (p.startsWith(prefix)) files.delete(p);
}

function edgeMapFromQuilt(q: QuiltJson): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of q.edges ?? []) {
    if (typeof line === "string") m.set(edgeId(line), line);
  }
  return m;
}

function byUnit(a: { unit: string }, b: { unit: string }): number {
  return a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0;
}

/**
 * Rewrite a resolved cell's chain in `files`: receipts.txt is the re-mined
 * proof, cell.json carries the RE-DERIVED tip + count (never a carried tip).
 */
function rewriteCellChain(
  files: Map<string, Uint8Array>,
  addr: string,
  mined: { text: string; tip: string; count: number },
  basis: string,
): void {
  files.set(`cells/${addr}/receipts.txt`, encode(mined.text));
  const manPath = `cells/${addr}/cell.json`;
  const manBytes = files.get(manPath);
  let man: Record<string, unknown> = {};
  if (manBytes !== undefined) {
    try {
      man = JSON.parse(decoder.decode(manBytes)) as Record<string, unknown>;
    } catch {
      man = {};
    }
  }
  man.tip = mined.tip;
  man.count = mined.count;
  if (man.basis === undefined) man.basis = basis;
  files.set(manPath, encode(JSON.stringify(man, null, 2) + "\n"));
}

// --- the executor ----------------------------------------------------------

/**
 * Resolve (fork, main) against base into a landed quilt.
 *
 * Pure function of `reader` + the three refs + `resolutions` + `options`.
 * Never mutates the reader; never trusts a carried tip.
 */
export async function mergeQuilt(
  reader: RepoReader,
  forkRef: string,
  mainRef: string,
  baseRef: string,
  resolutions: Resolutions = {},
  options: MergeOptions = {},
): Promise<MergeResult> {
  const d = await diffMerge(reader, forkRef, mainRef, baseRef);
  const forkName = options.forkName ?? "fork";
  const tokenId = options.tokenId ?? "none";
  const order: SequentializeOrder = options.sequentializeOrder ?? "main-first";

  // main's whole tree is the landing base: untouched paths are copied verbatim.
  const files = new Map<string, Uint8Array>();
  await listSubtree(reader, d.mainCommit.tree, "", files);

  const mainQuiltText = await readTextFile(reader, d.main, "quilt.json");
  if (mainQuiltText === null) throw new Error("merge: main has no quilt.json");
  const mainQuilt = JSON.parse(mainQuiltText) as QuiltJson;
  const basis = mainQuilt.basis ?? GENESIS_BASIS;
  const scheme = mainQuilt.routing?.scheme ?? mainQuilt.scheme ?? SCHEME;
  const mainRtText = (await readTextFile(reader, d.main, "routing.txt")) ?? "";
  const mainOps = parseOps(mainRtText);

  const mainEdges = edgeMapFromQuilt(mainQuilt);
  const forkQuiltText = await readTextFile(reader, d.fork, "quilt.json");
  const forkQuilt: QuiltJson =
    forkQuiltText === null ? { cells: [], edges: [] } : (JSON.parse(forkQuiltText) as QuiltJson);
  const forkEdges = edgeMapFromQuilt(forkQuilt);

  const resolvedCells = new Set<string>(mainQuilt.cells ?? []);
  const resolvedEdges = new Map<string, string>(mainEdges);
  const decisions: MergeDecision[] = [];
  const unresolved: string[] = [];

  // --- cells ---------------------------------------------------------------
  const cellUnits = d.units.filter((u) => u.unitType === "cell").sort(byUnit);
  for (const u of cellUnits) {
    const addr = u.unit.slice("cell:".length);
    const dec: MergeDecision = {
      unit: u.unit,
      unitType: "cell",
      verdict: u.verdict,
      mode: "auto",
      source: "none",
      reason: "",
    };

    const baseOps = parseOps(
      (await readTextFile(reader, d.base, `cells/${addr}/receipts.txt`)) ?? "",
    );
    const mainCellOps = parseOps(
      (await readTextFile(reader, d.main, `cells/${addr}/receipts.txt`)) ?? "",
    );
    const forkCellOps = parseOps(
      (await readTextFile(reader, d.fork, `cells/${addr}/receipts.txt`)) ?? "",
    );

    // 2. resolution mode (auto unless conflicting)
    let mode: ResolutionMode | "auto" = "auto";
    if (u.verdict === "conflict") {
      const r = resolutions[u.unit];
      if (r === undefined) {
        unresolved.push(u.unit);
        dec.reason = "conflict has no resolution";
        decisions.push(dec);
        continue;
      }
      mode = r;
    }
    dec.mode = mode;

    // decide presence + source side
    let present: boolean;
    let source: "fork" | "main";
    let finalOps: string[] = mainCellOps;
    let fromMain: string[] = [];
    let fromFork: string[] = [];

    if (u.verdict === "conflict") {
      if (mode === "take-fork") {
        source = "fork";
        present = u.forkHash !== null;
        finalOps = forkCellOps;
      } else if (mode === "take-main") {
        source = "main";
        present = u.mainHash !== null;
        finalOps = mainCellOps;
      } else {
        // sequentialize: §2.4 — M's new ops then F's new ops; cells only.
        if (u.forkHash === null || u.mainHash === null) {
          unresolved.push(u.unit);
          dec.reason = "sequentialize requires both sides present";
          decisions.push(dec);
          continue;
        }
        source = "main";
        present = true;
        const clean = isPrefix(baseOps, mainCellOps) && isPrefix(baseOps, forkCellOps);
        const mainSeg = clean ? mainCellOps.slice(baseOps.length) : [];
        const forkSeg = clean ? forkCellOps.slice(baseOps.length) : [];
        if (clean) {
          finalOps =
            order === "main-first"
              ? mainCellOps.concat(forkSeg)
              : forkCellOps.concat(mainSeg);
          fromMain = mainSeg;
          fromFork = forkSeg;
          dec.reason = `sequentialize (${order}): ${mainSeg.length} main op(s) + ${forkSeg.length} fork op(s) re-mined`;
        } else {
          // chains are not clean op-extensions of base (e.g. divergent
          // prefixes): fall back to the fork side, explicitly flagged.
          finalOps = forkCellOps;
          fromFork = forkCellOps;
          dec.reason = "sequentialize fallback→take-fork (chains not clean extensions of base)";
        }
      }
    } else if (u.verdict === "fork-only") {
      source = "fork";
      present = u.forkHash !== null;
      finalOps = forkCellOps;
    } else if (u.verdict === "main-only") {
      source = "main";
      present = u.mainHash !== null;
      finalOps = mainCellOps;
    } else {
      // idempotent: both sides agree; keep main's bytes.
      source = u.mainHash !== null ? "main" : "fork";
      present = u.mainHash !== null || u.forkHash !== null;
      finalOps = u.mainHash !== null ? mainCellOps : forkCellOps;
    }

    dec.source = source;
    dec.present = present;
    dec.baseOps = baseOps.length;
    dec.mainOps = mainCellOps.length;
    dec.forkOps = forkCellOps.length;
    dec.fromMain = fromMain;
    dec.fromFork = fromFork;

    if (!present) {
      deleteCellFromMap(files, addr);
      resolvedCells.delete(addr);
      dec.finalOps = 0;
      dec.newTip = null;
      dec.reMined = false;
      if (dec.reason === "") dec.reason = `${u.verdict} → ${source} (absent)`;
      decisions.push(dec);
      continue;
    }

    // 3. materialize the chosen side's cell bytes, then RE-MINE the chain.
    if (source === "fork") {
      deleteCellFromMap(files, addr);
      const fFiles = await readCellFiles(reader, d.forkCommit.tree, addr);
      for (const [p, b] of fFiles) files.set(p, b);
    } // source === "main": main's subtree is already in `files`.

    const mined = mineReceipts(finalOps, basis);
    rewriteCellChain(files, addr, mined, basis);
    resolvedCells.add(addr);

    dec.finalOps = finalOps.length;
    dec.newTip = mined.tip;
    dec.count = mined.count;
    dec.reMined = true;
    if (dec.reason === "") dec.reason = `${u.verdict} → ${source} (re-mined)`;
    decisions.push(dec);
  }

  // --- edges (content = presence; conflicts are impossible, §2.2) -----------
  const edgeUnits = d.units.filter((u) => u.unitType === "edge").sort(byUnit);
  for (const u of edgeUnits) {
    const id = u.unit.slice("edge:".length);
    const dec: MergeDecision = {
      unit: u.unit,
      unitType: "edge",
      verdict: u.verdict,
      mode: "auto",
      source: "none",
      reason: "",
    };

    if (u.verdict === "fork-only") {
      dec.source = "fork";
      if (u.forkHash === null) {
        resolvedEdges.delete(id);
        dec.reason = "fork-only: fork removed the edge ⇒ absent";
      } else {
        const line = forkEdges.get(id);
        if (line !== undefined) resolvedEdges.set(id, line);
        dec.reason = "fork-only: fork added the edge ⇒ present";
      }
    } else if (u.verdict === "main-only") {
      dec.source = "main";
      dec.reason = "main-only: keep main's routing";
    } else if (u.verdict === "idempotent") {
      dec.source = "both";
      if (u.mainHash === null) resolvedEdges.delete(id);
      else {
        const line = mainEdges.get(id);
        if (line !== undefined) resolvedEdges.set(id, line);
      }
      dec.reason = "idempotent: identical presence on both sides";
    } else {
      const r = resolutions[u.unit];
      if (r === undefined) {
        unresolved.push(u.unit);
        dec.reason = "edge conflict has no resolution";
        decisions.push(dec);
        continue;
      }
      dec.mode = r;
      if (r === "take-fork") {
        dec.source = "fork";
        if (u.forkHash === null) resolvedEdges.delete(id);
        else {
          const line = forkEdges.get(id);
          if (line !== undefined) resolvedEdges.set(id, line);
        }
        dec.reason = "edge conflict → take-fork";
      } else if (r === "take-main") {
        dec.source = "main";
        if (u.mainHash === null) resolvedEdges.delete(id);
        else {
          const line = mainEdges.get(id);
          if (line !== undefined) resolvedEdges.set(id, line);
        }
        dec.reason = "edge conflict → take-main";
      } else {
        unresolved.push(u.unit);
        dec.reason = "sequentialize is invalid for edges (§2.4: cells only)";
        decisions.push(dec);
        continue;
      }
    }
    decisions.push(dec);
  }

  // --- routing: ROUTE_* for the difference vs main, then MERGE -------------
  const routingOps: string[] = [];
  for (const [id, line] of [...resolvedEdges.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    if (!mainEdges.has(id)) routingOps.push("ROUTE_ADD " + line.slice("edge ".length));
  }
  for (const id of [...mainEdges.keys()].sort()) {
    if (!resolvedEdges.has(id)) routingOps.push("ROUTE_DEL " + id);
  }

  // digests over the delta set only (§3.4 `cells=… edges=…`).
  const cellDeltaLines = decisions
    .filter((x) => x.unitType === "cell")
    .sort(byUnit)
    .map((x) => `${x.unit}\u0000${x.verdict}\u0000${x.mode}\u0000${x.newTip ?? "-"}`);
  const edgeDeltaLines = decisions
    .filter((x) => x.unitType === "edge")
    .sort(byUnit)
    .map((x) => {
      const id = x.unit.slice("edge:".length);
      return `${x.unit}\u0000${x.verdict}\u0000${x.mode}\u0000${resolvedEdges.has(id) ? "present" : "absent"}`;
    });
  const cellDigest = hex16(fnv1a64(cellDeltaLines.join("\n")));
  const edgeDigest = hex16(fnv1a64(edgeDeltaLines.join("\n")));

  const mergeOp =
    `MERGE fork=${forkName} base=${d.base} cells=${cellDigest}` +
    ` edges=${edgeDigest} token=${tokenId}`;

  const finalRoutingOps = [...mainOps, ...routingOps, mergeOp];
  const minedRouting = mineReceipts(finalRoutingOps, basis);

  // --- rewrite the quilt state ---------------------------------------------
  const quilt = { ...mainQuilt } as QuiltJson;
  quilt.cells = [...resolvedCells].sort();
  quilt.edges = [...resolvedEdges.values()].sort();
  quilt.routing = {
    ...(mainQuilt.routing ?? {}),
    scheme,
    basis,
    count: minedRouting.count,
    tip: minedRouting.tip,
  };
  files.set("quilt.json", encode(JSON.stringify(quilt, null, 2) + "\n"));
  files.set("routing.txt", encode(minedRouting.text));

  // --- validation: resolutions must cover exactly the conflict set ----------
  const conflictSet = new Set(d.conflicts);
  const unknownResolutions = Object.keys(resolutions)
    .filter((k) => !conflictSet.has(k))
    .sort();

  const count = (v: UnitVerdict): number =>
    decisions.filter((x) => x.verdict === v).length;

  return {
    ok: unresolved.length === 0 && unknownResolutions.length === 0,
    base: d.base,
    fork: d.fork,
    main: d.main,
    forkName,
    files,
    decisions: [...decisions].sort(byUnit),
    conflicts: d.conflicts.slice().sort(),
    unresolved: unresolved.slice().sort(),
    unknownResolutions,
    cells: [...resolvedCells].sort(),
    edges: [...resolvedEdges.values()].sort(),
    routingOps,
    mergeOp,
    routing: { scheme, basis, count: minedRouting.count, tip: minedRouting.tip },
    cellDigest,
    edgeDigest,
    summary: {
      forkOnly: count("fork-only"),
      mainOnly: count("main-only"),
      idempotent: count("idempotent"),
      conflict: count("conflict"),
      cells: resolvedCells.size,
      edges: resolvedEdges.size,
    },
  };
}
