/**
 * pusher.ts — B3.4: the P2 external-pusher protocol (design §3.1 decision).
 *
 * The Worker cannot run `git`. P1 (isomorphic-git inside the Worker) is B3's
 * flaggest #1 risk (§6.2) and is deliberately NOT taken here. P2 delegates
 * *moving bytes* to a dumb executor, while keeping the **authority** to write
 * main inside the Worker:
 *
 *     re-derive + validate  →  mint ≤300 s write token  →  emit manifest
 *     (Worker)                 (Worker, TTL ≤ 300 s)       (Worker)
 *     → executor materializes EXACTLY the manifest, commits with the
 *       deterministic message, pushes the refspec, then revokes the token.
 *
 * The pusher's every input is in the manifest's `proposalDigest`: the executor
 * has **no discretion** — it cannot add, drop, reorder, or reword anything
 * without the digest check failing (pusher-side: `verifyManifest`).
 *
 * Everything here is a **pure function of the resolved quilt + the injected
 * token callback**, so the whole protocol is exercisable offline against a
 * local bare remote (worker/test/worker-rehearsal.mjs) with zero Cloudflare.
 *
 *   proposePush(resolved, { createToken }, opts) -> { manifest, revoke }
 *     mintPushToken({ createToken }, ttl)         -> TokenMint
 *     buildPushManifest(resolved, token, opts)    -> PushManifest   (pure)
 *     verifyManifest(manifest)                    -> { ok, expected, got, … }
 *     materializePush(manifest)                   -> Map<path, Uint8Array>
 *
 * Manifest shape (base64 content; canonical path order):
 *   { protocol, version, remote, refspec, branch, commitMessage,
 *     proposalDigest, singleUse, entries[], token{…plaintext, once},
 *     merge{ forkName, base, fork, main, cellDigest, edgeDigest, mergeOp, … } }
 */

import { fnv1a64, hex16 } from "./chain.js";
import type { MergeResult } from "./merge.js";

export const PUSH_PROTOCOL = "quilt-push-p2";
export const PUSH_PROTOCOL_VERSION = 1;

/** §3.2: merge-window write token TTL is ≤ 300 s. */
export const PUSH_TTL_SECONDS = 300;
/** createToken's own floor (binding docs: min 60). */
export const PUSH_TTL_MIN_SECONDS = 60;

export const PUSH_BRANCH_DEFAULT = "main";
export const PUSH_REFSPEC_DEFAULT = "HEAD:main";
/** Regular-file mode, as git stores it. */
export const FILE_MODE = "100644";

/** The token the executor will use once, over HTTPS. */
export interface TokenMint {
  id: string;
  plaintext: string;
  scope: "read" | "write";
  expiresAt: string;
}

/** Injected token factory (the repo handle's `createToken`, or a fake). */
export type CreateTokenFn = (
  scope: "read" | "write",
  ttlSeconds: number,
) => Promise<TokenMint>;

export interface PushEntry {
  op: "write" | "delete";
  /** repo-relative path (git tree path). */
  path: string;
  mode: string;
  /** fnv1a-64 hex-16 of the content — the manifest's own integrity check. */
  blob: string;
  bytes: number;
  /** base64 of the content (the executor's only materialization input). */
  content: string;
}

export interface PushManifest {
  protocol: typeof PUSH_PROTOCOL;
  version: typeof PUSH_PROTOCOL_VERSION;
  remote: string;
  refspec: string;
  branch: string;
  commitMessage: string;
  /** fnv1a-64 hex-16 over the canonical body (everything but the plaintext). */
  proposalDigest: string;
  /** the token is minted for exactly one push (§3.2). */
  singleUse: boolean;
  entries: PushEntry[];
  token: {
    id: string;
    scope: "write";
    ttlSeconds: number;
    expiresAt: string;
    plaintext: string;
  };
  merge: {
    forkName: string;
    base: string;
    fork: string;
    main: string;
    cellDigest: string;
    edgeDigest: string;
    mergeOp: string;
    cells: number;
    edges: number;
    routingCount: number;
    routingTip: string;
  };
}

export interface PushRevoke {
  tokenId: string;
  ref: string;
  singleUse: true;
  note: string;
}

export interface PushPackage {
  manifest: PushManifest;
  revoke: PushRevoke;
}

export interface PushOptions {
  /** HTTPS git remote URL of the landing repo (main). */
  remote: string;
  refspec?: string;
  branch?: string;
  /** Defaults to a deterministic message derived from the MERGE op. */
  commitMessage?: string;
  tokenTtlSeconds?: number;
  /** Pre-minted token (recommended: mint before merge so the MERGE receipt's
   *  token id matches — see git-api.ts / §1.4 lifecycle). */
  token?: TokenMint;
  /** Escape hatch; default false (fail-closed on a token-id mismatch). */
  allowTokenIdMismatch?: boolean;
}

// ── base64 (pure; no btoa/atob, identical in workerd and node) ───────────────

const B64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_REV: Record<string, number> = Object.fromEntries(
  [...B64].map((c, i) => [c, i]),
);

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1]! : 0;
    const b2 = has2 ? bytes[i + 2]! : 0;
    out += B64[b0 >> 2]!;
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += has1 ? B64[((b1 & 0x0f) << 2) | (b2 >> 6)]! : "=";
    out += has2 ? B64[b2 & 0x3f]! : "=";
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8) + 1);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const ch of clean) {
    const v = B64_REV[ch];
    if (v === undefined) throw new Error(`fromBase64: invalid character "${ch}"`);
    acc = ((acc << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

// ── the token ────────────────────────────────────────────────────────────────

/** Clamp to [60, 300] — createToken's floor, §3.2's write-window ceiling. */
export function clampTtl(ttlSeconds: number): number {
  const n = Number.isFinite(ttlSeconds) ? Math.trunc(ttlSeconds) : PUSH_TTL_SECONDS;
  return Math.min(PUSH_TTL_SECONDS, Math.max(PUSH_TTL_MIN_SECONDS, n));
}

/** Mint the single-use write token through the injected callback. */
export async function mintPushToken(
  deps: { createToken: CreateTokenFn },
  ttlSeconds: number = PUSH_TTL_SECONDS,
): Promise<TokenMint> {
  const ttl = clampTtl(ttlSeconds);
  const token = await deps.createToken("write", ttl);
  if (token.scope !== "write") {
    throw new Error(
      `pusher: createToken returned scope "${token.scope}", expected "write"`,
    );
  }
  return token;
}

// ── the manifest ─────────────────────────────────────────────────────────────

/** The token id the MERGE receipt names (`token=<id>`; "none" if unset). */
export function mergeTokenId(mergeOp: string): string {
  const m = /(?:^| )token=(\S+)/.exec(mergeOp);
  return m === null ? "none" : m[1]!;
}

function entryFor(path: string, bytes: Uint8Array): PushEntry {
  return {
    op: "write",
    path,
    mode: FILE_MODE,
    blob: hex16(fnv1a64(bytes)),
    bytes: bytes.length,
    content: toBase64(bytes),
  };
}

function canonicalEntryLine(e: PushEntry): string {
  return `${e.op}\u0000${e.mode}\u0000${e.path}\u0000${e.blob}\u0000${e.bytes}`;
}

interface DigestInput {
  remote: string;
  refspec: string;
  branch: string;
  commitMessage: string;
  mergeOp: string;
  tokenId: string;
  entries: PushEntry[];
}

/** fnv1a-64 over the canonical proposal body — the executor's contract. */
export function proposalDigest(input: DigestInput): string {
  const lines = [
    PUSH_PROTOCOL,
    String(PUSH_PROTOCOL_VERSION),
    input.remote,
    input.refspec,
    input.branch,
    input.commitMessage,
    input.mergeOp,
    input.tokenId,
    ...input.entries.map(canonicalEntryLine),
  ];
  return hex16(fnv1a64(lines.join("\n")));
}

/** Default deterministic commit message: the MERGE receipt, verbatim. */
export function defaultCommitMessage(resolved: MergeResult): string {
  return `quilt-merge: ${resolved.mergeOp}`;
}

/**
 * Pure: resolve a merged quilt + a token into the push manifest. Refuses a
 * manifest for an unresolved merge, and (fail-closed) refuses a token whose id
 * differs from the one the MERGE receipt names.
 */
export function buildPushManifest(
  resolved: MergeResult,
  token: TokenMint,
  opts: PushOptions,
): PushManifest {
  if (!resolved.ok) {
    throw new Error(
      `pusher: refusing to build a manifest for an unresolved merge ` +
        `(unresolved=${resolved.unresolved.join(",") || "-"}, ` +
        `unknown=${resolved.unknownResolutions.join(",") || "-"})`,
    );
  }
  if (token.scope !== "write") {
    throw new Error(`pusher: token scope "${token.scope}" is not "write"`);
  }

  const refspec = opts.refspec ?? PUSH_REFSPEC_DEFAULT;
  const branch = opts.branch ?? PUSH_BRANCH_DEFAULT;
  const commitMessage = opts.commitMessage ?? defaultCommitMessage(resolved);

  const receiptTokenId = mergeTokenId(resolved.mergeOp);
  if (
    opts.allowTokenIdMismatch !== true &&
    receiptTokenId !== "none" &&
    receiptTokenId !== token.id
  ) {
    throw new Error(
      `pusher: MERGE receipt names token "${receiptTokenId}" but the minted ` +
        `token is "${token.id}" — mint the token before merging (§1.4)`,
    );
  }

  // Canonical order: repository-relative paths, byte order.
  const entries = [...resolved.files.entries()]
    .map(([path, bytes]) => entryFor(path, bytes))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const proposalDigestValue = proposalDigest({
    remote: opts.remote,
    refspec,
    branch,
    commitMessage,
    mergeOp: resolved.mergeOp,
    tokenId: token.id,
    entries,
  });

  return {
    protocol: PUSH_PROTOCOL,
    version: PUSH_PROTOCOL_VERSION,
    remote: opts.remote,
    refspec,
    branch,
    commitMessage,
    proposalDigest: proposalDigestValue,
    singleUse: true,
    entries,
    token: {
      id: token.id,
      scope: "write",
      ttlSeconds: clampTtl(opts.tokenTtlSeconds ?? PUSH_TTL_SECONDS),
      expiresAt: token.expiresAt,
      plaintext: token.plaintext,
    },
    merge: {
      forkName: resolved.forkName,
      base: resolved.base,
      fork: resolved.fork,
      main: resolved.main,
      cellDigest: resolved.cellDigest,
      edgeDigest: resolved.edgeDigest,
      mergeOp: resolved.mergeOp,
      cells: resolved.cells.length,
      edges: resolved.edges.length,
      routingCount: resolved.routing.count,
      routingTip: resolved.routing.tip,
    },
  };
}

/**
 * The Worker entry point: mint (or reuse) the single-use token, then emit the
 * manifest + the revoke instruction. Pure modulo the injected token callback.
 */
export async function proposePush(
  resolved: MergeResult,
  deps: { createToken: CreateTokenFn },
  opts: PushOptions,
): Promise<PushPackage> {
  if (!resolved.ok) {
    throw new Error("pusher: refusing to propose a push for an unresolved merge");
  }
  const token =
    opts.token ?? (await mintPushToken(deps, opts.tokenTtlSeconds ?? PUSH_TTL_SECONDS));
  const manifest = buildPushManifest(resolved, token, opts);
  return {
    manifest,
    revoke: {
      tokenId: token.id,
      ref: token.id,
      singleUse: true,
      note: "revoke with repo.revokeToken(id) after the push completes (or on any error)",
    },
  };
}

// ── the dumb executor's (pure) side ──────────────────────────────────────────

export interface ManifestCheck {
  ok: boolean;
  expected: string;
  got: string;
  problems: string[];
}

/** Recompute the digest + per-entry integrity. The executor's first act. */
export function verifyManifest(manifest: PushManifest): ManifestCheck {
  const problems: string[] = [];

  const expected = proposalDigest({
    remote: manifest.remote,
    refspec: manifest.refspec,
    branch: manifest.branch,
    commitMessage: manifest.commitMessage,
    mergeOp: manifest.merge.mergeOp,
    tokenId: manifest.token.id,
    entries: manifest.entries,
  });
  if (expected !== manifest.proposalDigest) {
    problems.push(
      `proposalDigest mismatch (expected ${expected}, got ${manifest.proposalDigest})`,
    );
  }

  let prev: string | null = null;
  for (const e of manifest.entries) {
    if (prev !== null && !(prev < e.path)) {
      problems.push(`entries not in canonical (sorted, unique) path order at "${e.path}"`);
    }
    prev = e.path;
    if (e.op === "write") {
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(e.content);
      } catch (err) {
        problems.push(`entry "${e.path}": bad base64 (${String(err)})`);
        continue;
      }
      if (bytes.length !== e.bytes) {
        problems.push(`entry "${e.path}": length ${bytes.length} != ${e.bytes}`);
      }
      if (hex16(fnv1a64(bytes)) !== e.blob) {
        problems.push(`entry "${e.path}": content hash != ${e.blob}`);
      }
    }
  }

  return { ok: problems.length === 0, expected, got: manifest.proposalDigest, problems };
}

/**
 * The dumb executor's ONLY logic, in pure form: verify the manifest, then turn
 * its entries into the complete final tree (path → bytes). No fs, no git — the
 * rehearsal wraps this over a real local repo + push.
 */
export function materializePush(manifest: PushManifest): Map<string, Uint8Array> {
  const check = verifyManifest(manifest);
  if (!check.ok) {
    throw new Error(`materializePush: manifest failed verification: ${check.problems.join("; ")}`);
  }
  const files = new Map<string, Uint8Array>();
  for (const e of manifest.entries) {
    if (e.op === "delete") {
      files.delete(e.path);
    } else {
      const bytes = fromBase64(e.content);
      if (bytes.length !== e.bytes || hex16(fnv1a64(bytes)) !== e.blob) {
        throw new Error(`materializePush: entry "${e.path}" content/digest mismatch`);
      }
      files.set(e.path, bytes);
    }
  }
  return files;
}
