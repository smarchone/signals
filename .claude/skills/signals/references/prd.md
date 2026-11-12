# PRDs: the plan layer (`prd`)

The context says *why* and *what shape*. PRDs say *what to build next*: the context cut into units of work,
each one PR's worth, in build order, that the human hands to a coding agent (the executor) one at a time.
They are the only place constraints and decisions live. Follow `distill/common.md` (purpose, content, attention
budget) too, except its "No plans" rule: this is the plan layer.

## The breakdown

- **Three to seven PRDs**, numbered in build order: `01-<slug>.md`, `02-<slug>.md`, … (short kebab-case slug).
- **01 is the walking skeleton**: the thinnest slice that runs the core loop from `product.md` end to end,
  across every domain in `architecture.md`, with stand-ins where needed. Every later PRD deepens a working
  product; none is a horizontal layer ("all the storage") that can't be seen working alone.
- **One reviewable PR each.** Small enough to review in one sitting, big enough to show a visible change.
- **Cut by outcome, not by file or domain.** A PRD may touch several domains; name them.
- **Cover the product, not the backlog.** Stop where `product.md`'s moment is delivered and the risks in
  `business.md` can be tested. Later work is the human's next call, not yours.

## Each PRD

```
# PRD 01: <name, a few words>

> <one line: what the user can do after this ships, and why it comes now>

**Depends on:** none | PRD 01, … · **Touches:** `domain:play`, `domain:review`

## Outcome
Two or three sentences in the vocabulary: what is true when this ships, as the user experiences it.

## Scope
- **In:** what this PRD delivers (bullets).
- **Out:** what it deliberately leaves, and which PRD picks it up.

## Constraints
The rules the implementation must respect, each with its source (the meeting, `architecture.md`, a
`vocab:` rule). Only what a capable agent would otherwise get wrong.

## Decisions
Choices already made, one line each with the why: "Decided: X, because Y." Only those that are costly to
reverse or that the context left open and this PRD now closes (mark those `(assumed)`).

## Acceptance
Three to six checks, each observable from outside the code ("A committed Attempt can't be edited after a
reload"). Together they are the definition of done for the PR.

## Leave to the executor
One or two lines naming what the executor decides locally (and the human reviews at PR time).
```

## Rules

- **Self-contained for the executor.** It reads this PRD and `.signals/context/`, nothing else. Point to
  context ("see `architecture.md`, Ports") rather than restate it; restate nothing.
- **Use the vocabulary exactly**, marked `vocab:Term` as in `common.md`; domains as `domain:<name>`.
- **Guide, don't instruct.** Outcomes, boundaries and checks; never file layouts, schemas or algorithms.
- **Derived, not invented.** Constraints and decisions trace to the meeting and the context. A decision the
  context left open is yours to close only where the executor would otherwise stall; mark it `(assumed)`.
- **Under 350 words each.** Lists of at most five or six, ranked.

## Updating

In `mode: "update"`, the PRDs exist and the human has reviewed them. Change only what `guidance` or the
context calls for (`context_changed: true` means a context file changed since the PRDs were written), with
Edit. Add a PRD (next free number) or delete one that no longer applies. Keep numbers and file names stable,
and leave every PRD the change doesn't touch exactly as it is: the human re-reviews only what moved.

- **A PRD asked for in the human's own words:** turn the request into an outcome, draw scope, constraints and
  decisions from the context, keep its **Out** honest about what the other PRDs cover, and set **Depends on**
  from the PRDs it builds on. The breakdown rules (walking skeleton, three to seven) apply to a first pass,
  not to an addition.
- **Handed off:** never edit a PRD in `handed_off`: an executor is building it. If it needs to change, add a
  follow-up PRD that depends on it, and say so in your summary.
