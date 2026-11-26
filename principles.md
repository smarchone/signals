# Org — design principles

The ideas the Org model is built on, and why each one is there.
The mechanics are in `model.md`.

---

## 1. Simulate how orgs decide

Real orgs have already solved ownership, routing, escalation, and overrides. Copy the structure, not the overhead.
- Limited to three executives: **CEO, PM, Architect**.
- The human is the **board**. Every executive decision and every conflict is finalized by the human.

## 2. Separation of labour: bucket and route

Every decision has exactly one owner.
- CEO owns **why / who / constraints**, PM owns **what**, Architect owns **how**.
- Collecting decisions = **bucketing and routing** them to their owner.
- Owners partition further (PM by product area, Architect by technical area).
- Most decisions stay inside one small, contextual partition. That keeps loading, conflict checks, and reviews local.

## 3. Org tree (domain partitions)

```
CEO
├── PM:        onboarding · billing · …
└── Architect: auth · data · payments · …
```
- The store is a tree of partitions, each partition is a file.
- The tree itself (`map.md`) is a decision. Changing a boundary is reviewed like any other decision.
- **No stale marking.** An upstream change never silently marks downstream decisions stale. It triggers a discussion (see 6).

## 4. Hierarchy: CEO above, PM ↔ Architect as peers

- CEO sits above PM and Architect.
- The PM–Architect relationship is **not fixed**. They are peers: either can constrain the other, and their conflicts go to a panel.
- An Architect decision can serve a CEO constraint directly, without a PM step (cost → db choice).
- **The higher role does not win automatically.** Hierarchy decides who frames a conflict, not who wins it.

## 5. Layer contract

Each layer publishes constraints downward. The layer below chooses freely inside them.
- CEO: budget, audience, non-goals. PM: user-facing rules. Architect: interfaces between partitions.
- A lower decision must fit everything above it. That is what makes the hierarchy real.
- Each decision records what it **serves** (upward links) and its **implications** (what it constrains below).
- A lower layer can push back upward, e.g. "not feasible within this budget". That is an escalation, not a violation.

## 6. Escalation chain

Decisions and conflicts go up to the **lowest owner that covers everything they touch**.
- Inside one partition → that partition.
- Across partitions → their common owner.
- Across roles → a panel of the roles involved.
- Mechanical routing: no "where does this go?" judgment.

## 7. Overrides need a discussion

A high-level decision that overrides downstream ones (a pivot, a cost-driven db change) **always needs a discussion session**. This step cannot be removed.
- `serves:` links find every affected decision below it.
- Each affected role states what changes. The human decides each item.
- **All or nothing:** the override and its downstream edits commit together, or not at all. The store never holds a half-applied change.

## 8. Never a conflict in the store

- Every conflict needs human review. No auto-resolution, no "higher role wins".
- A conflict is a forced choice: keep the existing decision or replace it.
- Conflicts are always shown first.

## 9. Roles are lenses, not agents

- No CEO/PM/Architect agents and no orchestration (for now). A role = loading that role's partitions in the current session.
- **The store is the memory.** Roles answer **only from stored decisions, with citations**, or say **undecided**. Never improvise. Improvising would create the same unwritten tribal knowledge this system exists to remove.
- Consensus between model personas proves nothing; the human review is where consensus happens.
- Role play has one use: in a discussion, it surfaces trade-offs quickly (intuition-panel style).
- Upgrade path: subagents per role only if partitions grow too large for one context window.

## 10. One interface: the panel

- `/org` is the single entry point to ask, propose, surface conflicts, and update.
- Ask anything. Only the roles that own the topic answer, 1–2 lines each.
- A meeting is just the panel with more voices.
- The same process runs for planning, after the build, for steering, and for drift. Only the opener differs.

## 11. Batch for plans, interactive for build and steer

- Planning decisions wait for one batch review (`/org update`).
- During build and steer, an executive decision **blocks** until reviewed (`/org update <x>`). The agent should not build on an unapproved decision.
- Non-executive decisions are **left alone**: not stored, the agent continues.
- The coding agent invokes `org` on its own during build and steer. A closing `/org update` scan is the backstop.

## 12. Executive bar

Collecting every decision is costly and noisy.
- Store a decision only if rebuilding from the decisions would get it wrong without it, or a role would need to re-decide it.
- Everything below the bar is left to the agent.
- **Rebuild bar:** the store should be enough to rebuild ~90% of the codebase.

## 13. Attention is the scarce resource

Too many reviews → the human approves blindly.
- Partitions keep conflicts rare and local.
- Reviews are per decision, grouped by partition, conflicts first, one keystroke where possible.
- An override is one focused session, not 40 scattered approvals.
- Drafts never expire silently. Unreviewed drafts resurface at the next session.

## 14. Decisions carry real information

Decisions drive later decisions and the project's evolution, so each field must be substantive:
- **What:** precise enough to rebuild from and to check against code.
- **Why:** the forces behind it, linked to the decisions it serves.
- **Why not:** alternatives with reasons, so they aren't re-argued.
- **Implications** and **Revisit when:** what it constrains, and what should reopen it.
- **Context:** where and how it was decided.

## 15. Readable references

- `partition#slug`, where the slug is the markdown heading. No numeric IDs.
- Readable without lookup, no number collisions across branches, no renumbering.

## 16. Drift is a fallback, run through the same loop

- `/org drift` checks decisions against the code.
- Each mismatch is a choice: fix the code (build → steer) or amend the decision (review).

## 17. Steer with decisions, not prompts

- Prompts as the primitive → stuck micromanaging procedures.
- **Decisions and goals as the primitive**, with agents handling procedures → the human can steer longer, with executive decisions alone.
- Skills only, no CLI, store = markdown files.
