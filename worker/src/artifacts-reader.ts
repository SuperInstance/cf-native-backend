/**
 * artifacts-reader.ts — B3.4: the Artifacts adapter (design §2.3 "adapter-pure").
 *
 * `ArtifactsRepoReader` implements the EXACT `RepoReader` surface the B3.2 diff
 * core (worker/src/diff.ts) and the B3.3 executor (worker/src/merge.ts) speak:
 *
 *     readTree(hash)   -> TreeEntry[]        (ArtifactsRepo.readTree)
 *     readBlob(hash)   -> Uint8Array         (ArtifactsRepo.readBlob -> Blob)
 *     readFile(ref,p)  -> Uint8Array | null  (ArtifactsRepo.readFile -> Blob)
 *     readCommit(ref)  -> CommitInfo         (ArtifactsRepo.readCommit/log)
 *
 * It is a **drop-in**: diff.ts and merge.ts run unchanged against this adapter,
 * exactly as they run against the in-memory/LocalGit adapters in tests. Nothing
 * here does I/O other than the binding calls; nothing here mutates a repo.
 *
 * ── Union reader ─────────────────────────────────────────────────────────────
 * In the Artifacts design the fork and main are SEPARATE repositories (§1.1),
 * each of which contains the fork-point's objects. Diffing (fork, main, base)
 * therefore needs an object view that spans both — same reason the LocalGit
 * test adapter is a union. Construct with N repo NAMES; each hash/ref is
 * resolved in whichever repo holds it (content-addressed ⇒ unambiguous).
 *
 * ── Refs vs. object ids ──────────────────────────────────────────────────────
 * `readTree`/`readBlob` take object ids. `readCommit(hash)` likewise, but the
 * RepoReader contract passes refs (branch/tag/sha); we try the value as an
 * object id first and fall back to `log({ref})` to resolve a branch/tag.
 * `readFile({ref, path})` accepts a ref directly (docs: branch, tag, or id).
 *
 * NOTE (design §6): callers should resolve refs to commit SHAs up front (see
 * `resolveRef`) before a union diff — a branch name like "main" may exist in
 * BOTH the fork and main repos, and the union would pick the first. git-api.ts
 * does exactly that.
 *
 * The binding is READ-ORIENTED: no write/commit lives here. Writes are the P2
 * pusher's job (worker/src/pusher.ts) over git-push + a minted write token.
 */

import type { CommitInfo, RepoReader, TreeEntry } from "./diff.js";

/**
 * A `RepoReader` over one or more Cloudflare Artifacts repositories, obtained
 * via `env.ARTIFACTS.get(name)`. Handles are memoized and released by
 * `dispose()` / `Symbol.dispose` (use `using reader = new ArtifactsRepoReader(…)`).
 */
export class ArtifactsRepoReader implements RepoReader, Disposable {
  readonly names: string[];

  #artifacts: Artifacts;
  #repos = new Map<string, ArtifactsRepo>();
  #commits = new Map<string, CommitInfo>();
  #refs = new Map<string, string>();
  #trees = new Map<string, TreeEntry[]>();
  #blobs = new Map<string, Uint8Array>();
  #files = new Map<string, Uint8Array | null>();

  constructor(artifacts: Artifacts, names: string | string[]) {
    const list = Array.isArray(names) ? names.slice() : [names];
    if (list.length === 0) {
      throw new Error("ArtifactsRepoReader: need at least one repo name");
    }
    for (const n of list) {
      if (typeof n !== "string" || n === "") {
        throw new Error("ArtifactsRepoReader: empty repo name");
      }
    }
    this.#artifacts = artifacts;
    this.names = list;
  }

  get repoNames(): string[] {
    return this.names.slice();
  }

  /** Memoized `env.ARTIFACTS.get(name)` handle. */
  async #repo(name: string): Promise<ArtifactsRepo> {
    const cached = this.#repos.get(name);
    if (cached !== undefined) return cached;
    const repo = await this.#artifacts.get(name);
    this.#repos.set(name, repo);
    return repo;
  }

  /** Public handle accessor (token minting on a specific repo, e.g. main). */
  async repo(name: string): Promise<ArtifactsRepo> {
    if (!this.names.includes(name)) {
      throw new Error(
        `ArtifactsRepoReader.repo: "${name}" not in [${this.names.join(", ")}]`,
      );
    }
    return this.#repo(name);
  }

  /**
   * Resolve a ref (branch / tag / commit id) to a commit SHA in ONE named repo,
   * then (for convenience) in the rest of the union. Used to disambiguate a
   * union diff when callers pass branch names instead of SHAs.
   */
  async resolveRef(repoName: string, ref: string): Promise<string> {
    const key = `${repoName}\u0000${ref}`;
    const cached = this.#refs.get(key);
    if (cached !== undefined) return cached;

    const order = [repoName, ...this.names.filter((n) => n !== repoName)];
    for (const name of order) {
      const repo = await this.#repo(name);
      const byId = await safe(() => repo.readCommit(ref));
      if (byId !== null && byId !== undefined) {
        this.#refs.set(key, byId.hash);
        return byId.hash;
      }
      const byLog = await safe(() => repo.log({ ref, limit: 1 }));
      if (Array.isArray(byLog) && byLog.length > 0) {
        const hash = byLog[0]!.hash;
        this.#refs.set(key, hash);
        return hash;
      }
    }
    throw new Error(
      `ArtifactsRepoReader.resolveRef: "${ref}" not found in [${this.names.join(", ")}]`,
    );
  }

  async readCommit(ref: string): Promise<CommitInfo> {
    const cached = this.#commits.get(ref);
    if (cached !== undefined) return cached;

    for (const name of this.names) {
      const repo = await this.#repo(name);
      let meta = await safe(() => repo.readCommit(ref));
      if (meta === null || meta === undefined) {
        const byLog = await safe(() => repo.log({ ref, limit: 1 }));
        meta =
          Array.isArray(byLog) && byLog.length > 0 ? (byLog[0] ?? null) : null;
      }
      if (meta !== null && meta !== undefined) {
        const info: CommitInfo = {
          hash: meta.hash,
          tree: meta.treeHash,
          parents: meta.parents,
        };
        this.#commits.set(ref, info);
        this.#commits.set(info.hash, info);
        return info;
      }
    }
    throw new Error(`ArtifactsRepoReader.readCommit: ${ref} not found`);
  }

  async readTree(hash: string): Promise<TreeEntry[]> {
    const cached = this.#trees.get(hash);
    if (cached !== undefined) return cached;

    for (const name of this.names) {
      const repo = await this.#repo(name);
      const entries = await safe(() => repo.readTree(hash));
      if (entries !== null && entries !== undefined) {
        const out: TreeEntry[] = entries.map((e) => ({
          name: e.name,
          mode: e.mode,
          hash: e.hash,
        }));
        this.#trees.set(hash, out);
        return out;
      }
    }
    throw new Error(`ArtifactsRepoReader.readTree: ${hash} not found`);
  }

  async readBlob(hash: string): Promise<Uint8Array> {
    const cached = this.#blobs.get(hash);
    if (cached !== undefined) return cached;

    for (const name of this.names) {
      const repo = await this.#repo(name);
      const blob = await safe(() => repo.readBlob(hash));
      if (blob !== null && blob !== undefined) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        this.#blobs.set(hash, bytes);
        return bytes;
      }
    }
    throw new Error(`ArtifactsRepoReader.readBlob: ${hash} not found`);
  }

  async readFile(ref: string, path: string): Promise<Uint8Array | null> {
    const key = `${ref}\u0000${path}`;
    if (this.#files.has(key)) return this.#files.get(key) ?? null;

    for (const name of this.names) {
      const repo = await this.#repo(name);
      const blob = await safe(() => repo.readFile({ ref, path }));
      if (blob !== null && blob !== undefined) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        this.#files.set(key, bytes);
        return bytes;
      }
    }
    this.#files.set(key, null);
    return null;
  }

  /** Release the memoized repo handles (RPC stubs) before the request ends. */
  [Symbol.dispose](): void {
    for (const repo of this.#repos.values()) {
      try {
        repo[Symbol.dispose]();
      } catch {
        /* handle already released */
      }
    }
    this.#repos.clear();
  }
}

/** Await `fn()`, mapping any throw to `null` (object absent in this repo). */
async function safe<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
