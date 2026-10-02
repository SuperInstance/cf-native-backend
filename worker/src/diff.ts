/**
 * diff.ts — B3.2 adapter-pure semantic diff core.
 *
 * Speaks ONLY the abstract `RepoReader` surface (`readTree` / `readBlob` /
 * `readFile` / `readCommit`). No git, no fs, no bindings, no state: the exact
 * same module runs inside the Worker against an Artifacts adapter and under
 * node against the LocalGit test adapter (worker/test/localgit.mjs).
 *
 * Given (forkRef, mainRef, baseRef) it:
 *   1. lazy tree-diffs base→fork and base→main (B3-DESIGN §2.3 step 2),
 *      pruning identical (name, mode, hash) subtrees — O(changed subtrees);
 *   2. maps each changed path to its unit (§2.3 step 3): `cells/<type>/<name>/**`
 *      → that cell address; `quilt.json`/`routing.txt` → the routing FILE view;
 *      `task.json` → ignored (metadata);
 *   3. refines the routing file view into per-edge units (§2.2: edges are
 *      addressable by `<from>|<opcode>|<to>`, and distinct-id add/remove
 *      commute — so a routing change is NOT itself a conflict unit);
 *   4. emits per-unit deltas {unit, kind, forkHash, mainHash, baseHash};
 *   5. applies the §2.4 conflict rule:
 *
 *        touched(side, U)  := hash(side,U) !== hash(base,U)
 *        conflict          := touched(fork,U) && touched(main,U)
 *                             && hash(fork,U) !== hash(main,U)
 *        idempotent        := touched(fork,U) && touched(main,U)
 *                             && hash(fork,U) === hash(main,U)
 *        fork-only/main-only otherwise (a one-sided change, never a conflict)
 *
 *   fast path := no unit is touched on both sides.
 *
 * Unit content hash REUSES the B1/B2 fnv1a-64 scheme (chain.ts) over a
 * canonical walk of the unit's whole subtree (sorted relative paths, modes,
 * blob hashes) — one hashing scheme in the quilt, no second one. Cells hash
 * their whole directory (cell.json + receipts.txt + body/**), so two agents
 * appending different ops to the SAME cell diverge (⇒ conflict), and two
 * agents making the IDENTICAL edit agree (⇒ idempotent). Edge units hash the
 * canonical edge line; their "content" is presence (present hash / absent null).
 */

import { fnv1a64, hex16 } from "./chain.js";

// --- the abstract repo surface (the ONLY thing this module speaks) ---------

/** One entry of a git tree. `mode` "40000"/"040000" ⇒ tree, else blob. */
export interface TreeEntry {
  name: string;
  mode: string;
  hash: string;
}

/** The minimal commit view the diff needs. */
export interface CommitInfo {
  hash: string;
  /** root tree hash */
  tree: string;
  parents: string[];
}

/**
 * The adapter boundary. Artifacts binding (Worker) and LocalGit (tests) both
 * satisfy this. `hash` is an opaque object id (git sha here); the diff never
 * decodes it. `readFile(ref, path)` returns null when the path is absent.
 */
export interface RepoReader {
  readTree(hash: string): Promise<TreeEntry[]>;
  readBlob(hash: string): Promise<Uint8Array>;
  readFile(ref: string, path: string): Promise<Uint8Array | null>;
  readCommit(ref: string): Promise<CommitInfo>;
}

export function isTreeMode(mode: string): boolean {
  return mode === "40000" || mode === "040000";
}

// --- path → unit (B3 §2.3 step 3) -----------------------------------------

export type PathClass =
  | { kind: "cell"; unit: string; addr: string }
  | { kind: "routing"; unit: string }
  | { kind: "ignore"; unit: null }
  | { kind: "unknown"; unit: null };

/** `cells/<type>/<name>/**` — type and name are lowercase `[a-z0-9-]`. */
const CELL_PATH = /^cells\/([a-z0-9-]+)\/([a-z0-9-]+)(?:\/|$)/;

/**
 * Map a repo-relative path to its diff unit (B3 §2.3 step 3).
 *  - `cells/<type>/<name>/**`        → cell unit `cell:<type>/<name>`
 *  - `quilt.json` / `routing.txt`     → the routing file view (unit `routing`)
 *  - `task.json`                      → ignored (fork-point metadata)
 *  - everything else                  → unknown (reported, never a conflict)
 */
export function classifyPath(path: string): PathClass {
  const m = CELL_PATH.exec(path);
  if (m !== null) {
    const addr = `${m[1]}/${m[2]}`;
    return { kind: "cell", unit: `cell:${addr}`, addr };
  }
  if (path === "quilt.json" || path === "routing.txt") {
    return { kind: "routing", unit: "routing" };
  }
  if (path === "task.json") return { kind: "ignore", unit: null };
  return { kind: "unknown", unit: null };
}

/** Canonical edge line: `edge <from> <opcode> <to>` (B3 §2.2). */
export function edgeLine(from: string, opcode: string, to: string): string {
  return `edge ${from} ${opcode} ${to}`;
}

/** Edge id: `<from>|<opcode>|<to>` (B3 §2.2). */
export function edgeId(line: string): string {
  return line.replace(/^edge /, "").split(" ").join("|");
}

// --- lazy tree diff (base → head) -----------------------------------------

export interface PathChange {
  path: string;
  /** relative to the walk direction: `from` → `to`. */
  change: "created" | "deleted" | "modified";
  fromHash: string | null;
  toHash: string | null;
}

/** Lazy tree-diff of two tree hashes. Prunes identical subtrees. */
export async function diffTrees(
  reader: RepoReader,
  fromTree: string,
  toTree: string,
  prefix = "",
): Promise<PathChange[]> {
  const out: PathChange[] = [];
  await diffTreeInto(reader, fromTree, toTree, prefix, out);
  return out;
}

async function diffTreeInto(
  reader: RepoReader,
  fromTree: string,
  toTree: string,
  prefix: string,
  out: PathChange[],
): Promise<void> {
  if (fromTree === toTree) return; // prune: whole subtree identical
  const [from, to] = await Promise.all([
    reader.readTree(fromTree),
    reader.readTree(toTree),
  ]);
  const fromMap = new Map<string, TreeEntry>(
    from.map((e): [string, TreeEntry] => [e.name, e]),
  );
  const toMap = new Map<string, TreeEntry>(
    to.map((e): [string, TreeEntry] => [e.name, e]),
  );
  const names = new Set<string>([...fromMap.keys(), ...toMap.keys()]);
  for (const name of [...names].sort()) {
    const a = fromMap.get(name);
    const b = toMap.get(name);
    const path = prefix + name;
    if (a !== undefined && b !== undefined) {
      if (a.hash === b.hash && a.mode === b.mode) continue; // unchanged entry
      const aTree = isTreeMode(a.mode);
      const bTree = isTreeMode(b.mode);
      if (aTree && bTree) {
        await diffTreeInto(reader, a.hash, b.hash, path + "/", out);
      } else {
        out.push({ path, change: "modified", fromHash: a.hash, toHash: b.hash });
      }
    } else if (a !== undefined) {
      await collectSubtree(reader, a, path, "deleted", out, true);
    } else if (b !== undefined) {
      await collectSubtree(reader, b, path, "created", out, false);
    }
  }
}

async function collectSubtree(
  reader: RepoReader,
  entry: TreeEntry,
  path: string,
  change: "created" | "deleted",
  out: PathChange[],
  fromSide: boolean,
): Promise<void> {
  if (!isTreeMode(entry.mode)) {
    out.push({
      path,
      change,
      fromHash: fromSide ? entry.hash : null,
      toHash: fromSide ? null : entry.hash,
    });
    return;
  }
  const entries = await reader.readTree(entry.hash);
  for (const e of entries) {
    await collectSubtree(reader, e, `${path}/${e.name}`, change, out, fromSide);
  }
}

// --- unit content digests (fnv1a-64 over the whole unit subtree) -----------

async function treeDigest(reader: RepoReader, treeHash: string): Promise<string> {
  const lines: string[] = [];
  await collectDigest(reader, treeHash, "", lines);
  lines.sort();
  return hex16(fnv1a64(lines.join("\n")));
}

async function collectDigest(
  reader: RepoReader,
  treeHash: string,
  prefix: string,
  lines: string[],
): Promise<void> {
  const entries = await reader.readTree(treeHash);
  for (const e of entries) {
    if (isTreeMode(e.mode)) {
      await collectDigest(reader, e.hash, `${prefix}${e.name}/`, lines);
    } else {
      lines.push(`${prefix}${e.name}\u0000${e.mode}\u0000${e.hash}`);
    }
  }
}

/** Walk `segments` down from a root tree; null when any segment is absent. */
async function resolveTree(
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

async function cellDigest(
  reader: RepoReader,
  rootTree: string,
  addr: string,
): Promise<string | null> {
  const subtree = await resolveTree(reader, rootTree, ["cells", ...addr.split("/")]);
  if (subtree === null) return null;
  return treeDigest(reader, subtree);
}

// --- edges + routing file view --------------------------------------------

interface EdgeState {
  line: string;
  id: string;
  hash: string;
}

async function readEdgeSet(
  reader: RepoReader,
  ref: string,
): Promise<Map<string, EdgeState>> {
  const map = new Map<string, EdgeState>();
  const bytes = await reader.readFile(ref, "quilt.json");
  if (bytes === null) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return map;
  }
  const edgesField = (parsed as { edges?: unknown }).edges;
  if (!Array.isArray(edgesField)) return map;
  for (const raw of edgesField) {
    if (typeof raw !== "string") continue;
    const id = edgeId(raw);
    map.set(id, { line: raw, id, hash: hex16(fnv1a64(raw)) });
  }
  return map;
}

/** fnv1a-64 over quilt.json + routing.txt blob entries (file-level view). */
async function routingDigest(
  reader: RepoReader,
  rootTree: string,
): Promise<string | null> {
  const entries = await reader.readTree(rootTree);
  const lines: string[] = [];
  for (const e of entries) {
    if (e.name === "quilt.json" || e.name === "routing.txt") {
      lines.push(`${e.name}\u0000${e.mode}\u0000${e.hash}`);
    }
  }
  if (lines.length === 0) return null;
  lines.sort();
  return hex16(fnv1a64(lines.join("\n")));
}

export interface RoutingView {
  baseDigest: string | null;
  forkDigest: string | null;
  mainDigest: string | null;
  baseEdges: string[];
  forkEdges: string[];
  mainEdges: string[];
  /** main's edge set — the "before" of the proposal. */
  before: string[];
  /** fork's edge set — the "after" the task proposes. */
  after: string[];
}

// --- unit deltas + the merge verdict --------------------------------------

export type UnitVerdict = "fork-only" | "main-only" | "idempotent" | "conflict";

export interface UnitDelta {
  /** `cell:<type>/<name>` or `edge:<from>|<opcode>|<to>`. */
  unit: string;
  unitType: "cell" | "edge";
  /** change of the defining side vs base (fork when fork touched, else main). */
  kind: "created" | "deleted" | "modified";
  forkHash: string | null;
  mainHash: string | null;
  baseHash: string | null;
  verdict: UnitVerdict;
}

export interface MergeDiff {
  base: string;
  fork: string;
  main: string;
  baseCommit: CommitInfo;
  forkCommit: CommitInfo;
  mainCommit: CommitInfo;
  /** changed paths base→fork / base→main (lazy tree diff). */
  forkChanges: PathChange[];
  mainChanges: PathChange[];
  /** every unit changed on either side, with its verdict. */
  units: UnitDelta[];
  conflicts: string[];
  idempotent: string[];
  forkOnly: string[];
  mainOnly: string[];
  fastPath: boolean;
  routing: RoutingView;
  ignoredPaths: string[];
  unknownPaths: string[];
}

function changeKind(
  base: string | null,
  side: string | null,
): "created" | "deleted" | "modified" {
  if (base === null && side !== null) return "created";
  if (base !== null && side === null) return "deleted";
  return "modified";
}

function verdictOf(
  base: string | null,
  fork: string | null,
  main: string | null,
): UnitVerdict | null {
  const forkChanged = fork !== base;
  const mainChanged = main !== base;
  if (forkChanged && mainChanged) return fork === main ? "idempotent" : "conflict";
  if (forkChanged) return "fork-only";
  if (mainChanged) return "main-only";
  return null; // untouched on both sides
}

/**
 * Compute the semantic merge diff of (forkRef, mainRef) against baseRef.
 * Pure function of the reader + the three refs (B3 §2.3 + §2.4).
 */
export async function diffMerge(
  reader: RepoReader,
  forkRef: string,
  mainRef: string,
  baseRef: string,
): Promise<MergeDiff> {
  const [forkCommit, mainCommit, baseCommit] = await Promise.all([
    reader.readCommit(forkRef),
    reader.readCommit(mainRef),
    reader.readCommit(baseRef),
  ]);

  const [forkChanges, mainChanges] = await Promise.all([
    diffTrees(reader, baseCommit.tree, forkCommit.tree),
    diffTrees(reader, baseCommit.tree, mainCommit.tree),
  ]);

  const ignored = new Set<string>();
  const unknown = new Set<string>();
  const touchedCells = (changes: PathChange[]): Set<string> => {
    const s = new Set<string>();
    for (const c of changes) {
      const cls = classifyPath(c.path);
      if (cls.kind === "cell") s.add(cls.addr);
      else if (cls.kind === "ignore") ignored.add(c.path);
      else if (cls.kind === "unknown") unknown.add(c.path);
    }
    return s;
  };
  const forkCells = touchedCells(forkChanges);
  const mainCells = touchedCells(mainChanges);

  const [baseEdges, forkEdges, mainEdges] = await Promise.all([
    readEdgeSet(reader, baseRef),
    readEdgeSet(reader, forkRef),
    readEdgeSet(reader, mainRef),
  ]);

  const units: UnitDelta[] = [];

  // --- cells --------------------------------------------------------------
  const cellAddrs = new Set<string>([...forkCells, ...mainCells]);
  for (const addr of [...cellAddrs].sort()) {
    const baseHash = await cellDigest(reader, baseCommit.tree, addr);
    const forkHash = await cellDigest(reader, forkCommit.tree, addr);
    const mainHash = await cellDigest(reader, mainCommit.tree, addr);
    const verdict = verdictOf(baseHash, forkHash, mainHash);
    if (verdict === null) continue;
    const side = forkHash !== baseHash ? forkHash : mainHash;
    units.push({
      unit: `cell:${addr}`,
      unitType: "cell",
      kind: changeKind(baseHash, side),
      forkHash,
      mainHash,
      baseHash,
      verdict,
    });
  }

  // --- edges (unit content = presence; hash = the edge line) --------------
  const edgeIds = new Set<string>([
    ...baseEdges.keys(),
    ...forkEdges.keys(),
    ...mainEdges.keys(),
  ]);
  for (const id of [...edgeIds].sort()) {
    const baseHash = baseEdges.get(id)?.hash ?? null;
    const forkHash = forkEdges.get(id)?.hash ?? null;
    const mainHash = mainEdges.get(id)?.hash ?? null;
    const verdict = verdictOf(baseHash, forkHash, mainHash);
    if (verdict === null) continue;
    const side = forkHash !== baseHash ? forkHash : mainHash;
    units.push({
      unit: `edge:${id}`,
      unitType: "edge",
      kind: changeKind(baseHash, side),
      forkHash,
      mainHash,
      baseHash,
      verdict,
    });
  }

  const pick = (v: UnitVerdict): string[] =>
    units.filter((u) => u.verdict === v).map((u) => u.unit).sort();

  const conflicts = pick("conflict");
  const idempotent = pick("idempotent");
  const forkOnly = pick("fork-only");
  const mainOnly = pick("main-only");

  const [baseRd, forkRd, mainRd] = await Promise.all([
    routingDigest(reader, baseCommit.tree),
    routingDigest(reader, forkCommit.tree),
    routingDigest(reader, mainCommit.tree),
  ]);
  const edgeLines = (m: Map<string, EdgeState>): string[] =>
    [...m.values()].map((e) => e.line).sort();

  return {
    base: baseCommit.hash,
    fork: forkCommit.hash,
    main: mainCommit.hash,
    baseCommit,
    forkCommit,
    mainCommit,
    forkChanges,
    mainChanges,
    units,
    conflicts,
    idempotent,
    forkOnly,
    mainOnly,
    fastPath: conflicts.length === 0 && idempotent.length === 0,
    routing: {
      baseDigest: baseRd,
      forkDigest: forkRd,
      mainDigest: mainRd,
      baseEdges: edgeLines(baseEdges),
      forkEdges: edgeLines(forkEdges),
      mainEdges: edgeLines(mainEdges),
      before: edgeLines(mainEdges),
      after: edgeLines(forkEdges),
    },
    ignoredPaths: [...ignored].sort(),
    unknownPaths: [...unknown].sort(),
  };
}
