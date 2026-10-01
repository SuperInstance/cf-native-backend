# cf-native-backend

**The next GitHub is a backend question — asked from the user's side.**

Cloudflare's competition (deadline **2026-10-14**) asks for the next
generation of software-collaboration infrastructure. This repo is the
fleet's design + substrate surface for that question. Core mandate (from
the user, 2026-10-01): *the backend must emerge from the user perspective —
"we should be able to reason about what that would even look like."*

## The thesis in one paragraph

Agents made the **production** side of software native; the **consumption**
side is unchanged — a human still faces a file tree, a git CLI, and a PR
page. The winning backend is the one where the unit of work is not a
branch but an *intent*, where history is a **witness log with a rewind
handle** (receipt chain over positions, any sealed receipt a replay
anchor), where verification is a first-class queryable object (pins), and
where a stranger can ask "what is trust letting through here?" and get an
answer from the substrate itself.

## Asset inventory (what the fleet already has, verified)

| asset | repo | what it contributes |
|---|---|---|
| receipt chain + replay anchor | SuperInstance/frozen-clock-lab | fnv1a-64 chain over positions; P5 genesis-anchor replays forward from any receipt |
| witness-log repo instance | SuperInstance/quilt-in-git | tick commits + receipts + cascade; sparse/air-gap/bundle transports |
| relocated-trust surface | SuperInstance/doubt-ledger | "what stopped being checked, why, what covers it" queryable |
| contested-claims case | quilt-tools#32/#33 fixture | line-level merge impossibility, receipts over claims |
| claim verification | fleet-resolver Worker (Mavis lane) | path:line resolution + numeric claim recomputation |
| evaluation reservoir | wardroom sideboard doctrine | held-out tasks; harvest-protocol-as-ruler awareness |

## Coordination status

- **Mavis / projection-doctrine lane** is building the competition entry
  (thesis: witness log + rewind handle). This repo supports that entry
  first; a competing second entry is a later question, not a now question.
- Sibling-lane feeds logged in `memory/snowball-queue.md`.

## Open design questions

1. D1/R2/Workers/Queues mapping for the witness log at 477-repo scale —
   or is per-repo-native (git notes/refs, as quilt-in-git does) the
   actual answer and CF primitives only the *discovery* layer?
2. Where does the rewind handle live for a non-technical user — CLI?
   web? a `rewind.yaml` you commit?
3. Verification as query: pins currently answer *yes/no* per property.
   What does "show me everything currently trusted-but-unaudited" look
   like as an API? (doubt-ledger is the seed.)

*Receipts culture applies here with full force: every design claim in
this repo gets a pin or gets labeled speculation.*
