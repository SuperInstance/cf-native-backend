# QUILT-AS-GIT — Contest Build Plan (deadline 2026-10-14)

## The bet
Cloudflare is asking for "the next Git platform for agents." They shipped two
separate products: **Artifacts** (versioned storage that speaks Git) and
**@cloudflare/computer** (the agent runtime). Nobody is connecting them.

Quilt is the layer that connects them. A repo is not inert files — it is a
**live cell**. Clone it and the app *wakes* as the agent's body
(codespace-as-runtime). An agent operates out of a **wheelhouse** (terminal +
observability pre-built), not a checkout. Cells are typed (data / API / GPIO /
logic) so diffs are **semantic** — two agents changing different cells don't
conflict the way two humans editing one file do.

**The repo IS the runtime.** That is the whole entry.

## The contest bar (verified)
- **50%** originality/quality of the agent-oriented collaboration prototype
- **25%** multi-agent concurrency / coordination / context preservation / review / conflict handling
- **25%** ease of use / UX
- **Hard floor:** Workers + Artifacts, multiple agents working concurrently,
  MIT/Apache/BSD LICENSE, 5–10 min video. US/Canada, one submission per entrant.

## Where we are (B1 + B2 — landed)
B1: one physics receipt — a measured, pinned wake-latency curve proving cold-start
cost is *reading+hashing the receipt chain*, not moving it
(100k positions ≈ 2.5 s, 1M ≈ 16 s on a 2-core box). Honest, pins green.

B2 (landed, PR #4 → merged 1a19518): the receipt-chain is now a **TypeScript
Worker with an Artifacts binding** — `GET /cell/<id>` wakes the cell on URL.
fnv1a-64 chain is 1:1 with B1 Python (parity verified: n=5000 + n=100k, tip
byte-identical, tamper caught @0). Type-check strict PASS. In-worker verify
≈455k pos/s (≈9× B1 Python). Still unverified: no live deploy (no namespace
provisioned yet).

## Gaps → 12-day plan
1. **B2 (days 1–3) — port to the substrate. ✅ LANDED (PR #4 → 1a19518).**
   Reimplemented the cell receipt-chain in TypeScript as a Worker with an
   Artifacts binding. `GET /cell/<id>` wakes the cell on URL. Parity + type-check
   green. TODO: live deploy (provision namespace) + re-run the wake curve on CF.
2. **B3 (days 4–8) — multi-agent concurrency.** Fork-per-task: N agent-sessions
   fork the same quilt, work concurrent chains, then a merge/review surface with
   semantic (cell-level) diffs → no conflicts. This is the 25% and the whole thesis.
3. **B4 (days 9–11) — the surface.** Minimal web UI: timeline, rewind,
   doubt-query ("what trust lets through"). This is the UX 25% + the video.
4. **Days 12+ — video + submission.** 5–10 min narrative. Everything beyond B4
   stays doctrine-only (honest).

## The pitch (video narrative)
"Git made *the change* the unit of collaboration. Quilt makes *the connection*
the unit." Show: clone a cell → the app wakes → two agents fork → concurrent
work → semantic merge with no conflict → rewind to any state. End on the frame:
quilt is the layer between Artifacts and @cloudflare/computer.

## Crew
- **deepseek-v4-pro (keeper):** big-picture synthesis, gear calls, merges.
- **glm-5.3:** deep research + helper.
- **deepseek-flash / cheap models:** task runners (ports, scaffolds, grunt).
- **z.ai bulk:** heavy lifting in parallel.
- **engineer-agent (Casey's):** executes B2/B3/B4 against this spec.

## Notes
- Artifacts billing starts **Oct 15** — the day after the deadline. Building now
  is effectively un-billed.
- LICENSE (MIT) added this commit — removes a hard-floor disqualifier.
