# The Planetary Computer — scale-out doctrine for the Living Repository Lattice

*Build B0: doctrine before physics. B1 (Hello Cell, branch `lattice-b1`) is
measuring wake physics while this doc states what the numbers will mean.
Every claim here either cites a fleet artifact or is labeled INFERRED /
DESIGN-ONLY. Nothing is measured twice.*

---

## 1. Why scale-out is a doctrine question, not a DevOps question

Cheap boxes fail, saturate, and get replaced. If the lattice's correctness
depended on any node's persistence, scaling out would scale out *fragility*.
So the design constraint is stated first, before any hardware talk:

> **A mesh node must be disposable; the chain must be the only state that
> matters; recovery must be a protocol, not an incident.**

Everything below follows from that constraint. It is the cell doctrine
("the working tree is a cache") applied one level up: just as a repo's
checkout is disposable in front of its receipt chain, a mesh *node* is
disposable in front of the cells it serves.

## 2. The isomorphism — one doctrine, three substrates

The fleet has been building the same object at three scales, and today all
three moved:

| substrate | unit of memory | verifier | journal / signal |
|---|---|---|---|
| **cell** (repo) | genesis-anchored fnv1a-64 receipt chain (`frozen-clock-lab @poc`, `lab/chain.py`; `doubt-ledger @poc`, `ledger/entry.py`) | pins — offline, re-runnable | the chain itself |
| **course** (git-mechanics-301, AI-Writings PR #75 merged / #76 open) | tiles = positions | pin.sh per tile | LEDGER.md — the diffusion journal |
| **mesh** (this lattice) | cells with non-linear names | wake protocol + membrane | gossip receipts (DESIGN-ONLY) |

One heartbeat runs through all three: **anchor → pin → attest → heal.**

- *anchor*: a genesis basis nothing earlier is assumed (`GENESIS = "0"*16`,
  doubt-ledger export layer, poc@549c395).
- *pin*: a falsifiable check anyone can re-run (frozen-clock P1–P8; 301's
  `program/run verify`, 12/12 as of PR #76).
- *attest*: a claim about coverage that can be queried, not merely believed
  (quilt-in-git PR #9, merged 2026-10-02 — `trusted-but-unaudited`,
  `coverage`, `divergence`, `attest`).
- *heal*: replay from anchor, re-derive the tip, resume (frozen-clock P7/P8
  replay-from-anchor; 301's t08 draft-RED → merge → pinned flip).

INFERRED: the equivalence "cell cold start ≡ course diffusion event ≡ mesh
node wake" holds at n=1 by construction; that it survives n>1 is the burden
of Section 5.

## 3. The node wake protocol — the heart

A hibernated Lattice node, waking cold, runs exactly four steps. Each is
already fleet-proven at a smaller scale:

```
verify   check the chain from genesis anchor to stored tip
         (frozen-clock pins; doubt-ledger verify_export names the tampered line)
replay   re-derive the tip by replaying genesis→tip
         (frozen-clock P7/P8; Hello Cell wake.sh — MEASURED, see lattice-b1)
pin      confirm the working reconstruction against the pinned expectation
         (301 program/run verify — 12/12 PASS at PR #76)
teach    announce what is now covered, and what is still unaudited
         (quilt-in-git query layer: coverage + trusted-but-unaudited;
          301 LEDGER.md diffusion entries)
```

This is t08's flip protocol wearing node clothes: the course was *born
unverified on purpose* and pinned itself on the merge receipt; a mesh node
is *born dissolved on purpose* and pins itself on the wake receipt. The
protocol is identical because the problem is identical: **resume from
distrust, and make the resumption auditable.**

A wake is not complete until it emits its own hibernation grammar — the
doubt-ledger four fields (`stopped_checking` / `because` / `covered_by` /
`revisit_trigger`) are how a node dissolves *honestly*: it records why
checking stopped and when to look again. A silent node is a broken node.

## 4. Dissemination budgets — 201's poetry, measured or marked

git-mechanics-201 Module 4 describes push/receive as *molecular events of a
planetary computer*. That is a vocabulary, not a measurement. The budget
table converts each claim into either a number or a named gap:

| claim (201 Module 4 / Lattice ideation) | status | measurement that pins it |
|---|---|---|
| A woken cell is affordable per request | **MEASURED (B1)** | wake-latency curve, N=1k–1M positions: clone sub-second; replay ~15–20 µs/position pure-Python fnv1a-64; 100k ≈ 2.5 s, 1M ≈ 16 s median on a 2-core box. Physics: wake cost is reading+hashing the chain, not moving it. |
| Chain transfer dominates at distance | UNBENCHMARKED | wake-latency vs remote fetch (LAN/WAN) for a 33 MiB chain (B1's local transport ignored `blob:none`; the real remote number is INFERRED, likely dominant) |
| Every node can recompute the whole | UNBENCHMARKED at n>1 | convergence time vs N nodes at fixed receipt rate; expected O(chain) replay per node, but stampede behavior unknown (Section 5.4) |
| Gossip keeps caches coherent | DESIGN-ONLY | no fleet artifact gossips yet; first build = synapse receipts between two cells (edge-watch frontier watch) |
| Dissemination is the molecular event | DESIGN-ONLY | define the unit (one receipt? one anchor? one witness set?) and its budget before any claim |

Rule: a claim enters this table exactly once — as a number with a log, or
as a named gap. No third state.

## 5. Failure modes at n = 2 → n = 1000

**5.1 Partition.** Two cells, one anchor, divergent replay. Detection is
solved — chain roots differ, and quilt-in-git's `divergence` subcommand
names it. *Resolution is not solved.* The mesh needs an adjudication rule
that is not "last write wins"; receipts provide the evidence, not the
verdict. DESIGN-ONLY; the rule must be decided before the mesh has anything
worth partitioning over.

**5.2 Name collision under gossip.** A name that is a linear function of
content/order fragments the moment a peer cherry-picks and re-names. The
mesh's identity layer is already doctrine: version names must be non-linear
functions of change hashes, while the receipt chain stays order-sensitive
by design (301 t11; 9c memo, quilt-in-git PR #10). A lattice position
advertised to a peer must be a *hash-of-introducing-change* style name, or
recontextualization is identity loss.

**5.3 Byzantine attestations.** At n=1, format-level trust is an honest
limit (quilt-in-git's attest is unsigned, and says so). At n>1, unsigned
attestations are fabricatable by any node, so the limit stops being honest
and starts being a hole. The seam exists: doubt-ledger's optional Ed25519
root signing (wave-2, poc@549c395) — but t10's boundary travels with it:
*an export proves the included entries are byte-intact; completeness is the
verifier's question.* Signing a root does not sign a filter. The mesh
attestation format must declare what is covered, or it is laundering a
hole at scale.

**5.4 Healing storms.** N nodes wake from the same anchor and each pays
O(chain) replay against the source — an N× stampede on one cell's I/O, plus
N concurrent heals that each look locally correct. Mitigation seed:
*incremental anchors* — frozen-clock already replays from a mid-chain
anchor (P7/P8 anchor at op 150); anchor more often, replay less.
INFERRED: anchor frequency vs healing latency is the tuning knob; no
measurement exists yet. Hello Cell's curve says a 100k-position chain
replays in ~2 s; a mesh of 50 such nodes healing hourly is trivial, one
healing every second is a design question.

**5.5 Dissolve races.** Sparse-checkout dissolve overlaps concurrent
replay: a third observer can read a torn working tree. The doctrine
answers it — *the working tree is a cache; never trust the cache* — but a
torn read must **fail loudly**, not silently. Needs a cache-epoch marker
checked before any cached read is believed. DESIGN-ONLY; smallest first
build is a one-evening seam over sparse-checkout.

## 6. Honest limits

1. **This doc is doctrine, not measurement.** Only Hello Cell (lattice-b1)
   has produced numbers, and its curve is synthetic-op floor, not workload
   forecast (its own limit #1).
2. **The isomorphism is proven at n=1.** Cell and course scales have live
   receipts; mesh-scale equivalence is INFERRED until two cells gossip.
3. **The adjudication rule for partitions does not exist yet** (5.1).
   Building gossip before the rule would bake in last-write-wins by default.
4. **Attestation semantics are unsigned at the query layer** (5.3); the
   signing seam exists in doubt-ledger but has never been exercised
   cross-repo.
5. **The competition deadline (2026-10-14) means design lands before
   physics.** B1's numbers adjudicate the wake claims; 5.1/5.3/5.5 remain
   design-only at entry time, and this doc must not be quoted as if they
   were otherwise.

## 7. What the next builds adjudicate

| build | branch | adjudicates |
|---|---|---|
| B1 Hello Cell *(in flight / merged)* | `lattice-b1` | §4 rows 1–2: wake latency, chain transfer |
| B2 Membrane Worker | next | wake-per-request economics on Cloudflare infra; streams replay progress; re-hibernation on idle |
| B3 two-cell synapse | after B2 | §5.1 detection (not resolution); §5.4 healing-storm measurement at n=2 |
| B4 adjudication rule | design-first | §5.1 — decide before B3's evidence tempts a default |

*Build B0 — doctrine. 2026-10-02.*
