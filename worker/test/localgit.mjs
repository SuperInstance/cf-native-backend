/**
 * localgit.mjs — a `RepoReader` (B3.2, worker/src/diff.ts) over one or more
 * REAL local git repositories.
 *
 * The diff core is adapter-pure: in production it speaks the Artifacts
 * binding; here it speaks `git` through `node:child_process`. Every call is
 * **array-args only** (`execFileSync("git", ["-C", repo, ...])`) — never a
 * shell string, never `shell: true`. (Workspace red line: shell re-parsing is
 * a banned bug class.)
 *
 * Why a *union* reader: in the Artifacts design the fork and main are separate
 * repositories (B3-DESIGN §1.1), each of which contains the fork-point's
 * objects. Diffing (fork, main, base) therefore needs an object view that
 * spans both. Construction accepts N repo paths and resolves each hash/ref in
 * whichever repo holds it — content-addressed, so the answer is unambiguous.
 *
 * All results are memoized by object hash / ref, because the quilt's unchanged
 * subtrees keep their hash across the whole randomized property run — the cache
 * turns thousands of `git` spawns into dozens.
 */

import { execFileSync } from "node:child_process";

const MAXBUF = 64 * 1024 * 1024;

export class LocalGit {
  /** @param {string | string[]} repos one path, or a union of paths */
  constructor(repos) {
    const list = Array.isArray(repos) ? repos.slice() : [repos];
    if (list.length === 0) throw new Error("LocalGit: need at least one repo path");
    /** @type {string[]} */
    this.repos = list;
    /** @type {Map<string, object>} */
    this._commits = new Map();
    /** @type {Map<string, object[]>} */
    this._trees = new Map();
    /** @type {Map<string, Uint8Array>} */
    this._blobs = new Map();
  }

  static union(repos) {
    return new LocalGit(repos);
  }

  /** Raw git helper: array args only. `encoding` utf8 ⇒ string, else Buffer. */
  _git(repo, args, encoding) {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding,
      maxBuffer: MAXBUF,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** Try each repo in turn; first defined/non-null result wins. */
  _try(fn) {
    for (const repo of this.repos) {
      try {
        const r = fn(repo);
        if (r !== undefined && r !== null) return r;
      } catch {
        /* object absent in this repo — try the next */
      }
    }
    return undefined;
  }

  async readCommit(ref) {
    const cached = this._commits.get(ref);
    if (cached !== undefined) return cached;
    const info = this._try((repo) => {
      const sha = this._git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], "utf8").trim();
      if (sha === "") return null;
      const tree = this._git(repo, ["rev-parse", "--verify", `${sha}^{tree}`], "utf8").trim();
      const parents = this._git(repo, ["rev-list", "--parents", "-n", "1", sha], "utf8")
        .trim()
        .split(/\s+/)
        .slice(1);
      return { hash: sha, tree, parents };
    });
    if (info === undefined) {
      throw new Error(`LocalGit.readCommit: ${ref} not found in ${this.repos.length} repo(s)`);
    }
    this._commits.set(ref, info);
    this._commits.set(info.hash, info);
    return info;
  }

  async readTree(hash) {
    const cached = this._trees.get(hash);
    if (cached !== undefined) return cached;
    const entries = this._try((repo) => {
      const out = this._git(repo, ["ls-tree", hash], "utf8");
      return out
        .split("\n")
        .filter((l) => l !== "")
        .map(parseTreeLine);
    });
    if (entries === undefined) throw new Error(`LocalGit.readTree: ${hash} not found`);
    this._trees.set(hash, entries);
    return entries;
  }

  async readBlob(hash) {
    const cached = this._blobs.get(hash);
    if (cached !== undefined) return cached;
    const bytes = this._try((repo) => {
      const buf = this._git(repo, ["cat-file", "blob", hash], undefined);
      return Uint8Array.from(buf);
    });
    if (bytes === undefined) throw new Error(`LocalGit.readBlob: ${hash} not found`);
    this._blobs.set(hash, bytes);
    return bytes;
  }

  async readFile(ref, path) {
    const bytes = this._try((repo) => {
      const sha = this._git(repo, ["rev-parse", "--verify", "--quiet", `${ref}:${path}`], "utf8").trim();
      if (sha === "") return null;
      // a directory resolves to a tree sha, and `cat-file blob` then fails,
      // which _try catches -> null. readFile is for files.
      return Uint8Array.from(this._git(repo, ["cat-file", "blob", sha], undefined));
    });
    return bytes === undefined ? null : bytes;
  }

  /** Extra (non-interface) helper: resolve a ref to a full commit sha. */
  rev(ref) {
    const sha = this._try((repo) =>
      this._git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], "utf8").trim() || null,
    );
    if (sha === undefined) throw new Error(`LocalGit.rev: ${ref} not found`);
    return sha;
  }
}

function parseTreeLine(line) {
  const tab = line.indexOf("\t");
  const meta = line.slice(0, tab).split(" ");
  return {
    mode: meta[0],
    type: meta[1],
    hash: meta[2],
    name: line.slice(tab + 1),
  };
}
