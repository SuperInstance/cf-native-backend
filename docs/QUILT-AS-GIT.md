# Quilt-as-Git — The Paradigm (full expansion)

> Git won by making **the change** the unit of collaboration — commits, branches,
> merges — instead of the file. Quilt makes **the connection** the unit. The DAG
> is not commits-over-files; it is a **tensor of cells** wired by edges. A commit
> is a rewiring. A merge is two quilts agreeing on a routing.

## The one sentence
The next Git is not a place to store code — it is a substrate where a repository
**is** a live agent runtime, and collaboration is the routing of connections
between typed cells.

## Why now
Cloudflare's own words: "a distributed, versioned filesystem built for agents
first" — "a repository for every agent, session, task, or user." They have
already stated the paradigm. What they have NOT built is the layer that *wakes*
a repository into a running agent body, and the layer that lets many agents
*reroute* the same substrate without conflict. That is quilt.

## The layer map (bottom-up)
1. **Cells** — the atoms. Typed primitives: data, API, GPIO, addressable object,
   logic. Each cell is versioned, addressable, and carries a receipt (what changed
   + why). Cells are the last-mile layer to anything — a sensor, a table, a
   function, a peripheral.
2. **Wheelhouses** — cells with their runtime attached. A wheelhouse repo ships a
   terminal + observability + function pre-built, so an agent *operates out of it*
   (a cockpit) rather than reading it (a checkout). An engineer-agent lives in the
   maintenance wheelhouse; an org drops in a frontend agent and it is *fitted* —
   the way you drop a UI onto an API.
3. **Codespace-as-runtime** — the body. Clone an app that is part of a quilt, and
   its codespace *is* what's triggered: env, deps, terminals, observability — the
   vessel the agent steps into. First-person perspective on how the agent operates.
   "Running the app" and "being the agent" are the same event.
4. **The tensor** — the quilt itself. The spreadsheet-of-connections that ports
   the three decoupled layers (below) and rewires them per (user, application,
   hardware).
5. **Agentic compilers** — the motion. Optimize code → language → review → heal as
   limits are pushed and alternative routing is needed. They are the build step of
   the substrate, and they run continuously.
6. **Flow-state** — the product. The user↔agent feedback loop sharpens until the
   agent anticipates the user the way a translator who has worked for a diplomat
   long enough anticipates him. The diplomat's crew — human and agentic — becomes
   a superintelligence he guides like a captain with specialist crew who know more
   than him in every domain.

## The deep core: three-way decoupling
Chips, logic, and frontend are three SEPARATE layers. Today they are coupled
(application logic assumes a runtime; a frontend assumes an API; an optimization
assumes a chip). Quilt decouples them and re-ports them through the tensor:

- **Chips** — proof of concepts (cudaclaw, gpu-native agents) show compute is a
  layer apart from logic.
- **Logic** — the application, device-agnostic.
- **Frontend** — the user surface, application-agnostic.

Decoupled, all three gain independently:
- one application becomes durable across a wider range of hardware + userbase;
- one user, having learned their frontend, applies it across a broader array of
  applications;
- hardware optimization becomes **general-purpose but device-specific** — the
  quilt building-block-assembles the optimal path for however user + application
  + hardware are trying to be.

## The LLM is four things at once
1. **Decomposer** — one call breaks the job's required logic into the cogs of the
   system.
2. **Tool-builder** — when it repeats a job, it builds a tool to do the
   calculation, so the next similar prompt is a tool call, not a re-derivation.
3. **Simulator** — when it fully understands and can perform the job, it *runs* it.
4. **The test** — mock-inputs passed through the working LLM become BOTH the
   chain-of-thought data for decomposing the job into smaller tasks AND the test
   for whether the repo is "as good as just a model call to an expensive iterator."

Point 4 is the greenhorn ladder: decompose until the local thing is as good as the
cloud thing, and let the mock-inputs be the evidence.

## What this maps onto that we have already built
- **superinstance-api** (tiles/rooms; meaning via Vectorize; reflex via pinch;
  field; growth) — already the cell-registry skeleton.
- **The fleet opcodes** (qm_bind / qm_link / qm_effect / qm_view / qm_tick) — the
  cell fabric; the same five opcodes on every boat.
- **C2 "buy the right sensor once"** — the wheelhouse doctrine (one right tool,
  not a router over many wrong ones).
- **anti-GAN "preferred when, not best"** — the routing law for the tensor.
- **GREENHORN** — the decomposer/tool-builder/simulator/test loop, made explicit.
- **cf-native-backend B1** — the first physics receipt (cold-start cost is reading
  the receipt chain, not moving it). The first cell of the tensor.

## How this wins the contest
Most entries will build ON Cloudflare — a faster CI, a vector store, an MCP
server. Quilt's bet is bolder and correct: the substrate is not a backend, it is
the **composition layer**. We build ON Artifacts (the storage that speaks Git) and
we QUILT it to @cloudflare/computer (the agent runtime) — the connection nobody
else is making. The differentiator is not "better storage" or "better runtime";
it is that **a repository is a live body, and a merge is a routing decision.**

## Open questions (what we let boil)
- Does wake-on-URL (clone → app runs) survive on Workers+Artifacts cold-start
  budget? (B2 measures this.)
- Does cell-level (semantic) diffing actually eliminate merge conflicts, or just
  relocate them? (B3 measures this.)
- Is "a repository for every agent" the same as "one cell per agent," or does an
  agent need a *quilt* of cells to itself? (design, not code)
- Where does the receipt chain end and the agent runtime begin? (the seam)

## The pot
This repo is the shared idea pot for all SuperInstance agents. Add-only. Nothing
is deleted — ideas are added and the ones that don't survive the build "boil
away." The goal is to add until something that looks like what we are describing
is *working*.
