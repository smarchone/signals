---
name: signals
description: Executive decision store for this project, run as a 3-role org (CEO, PM, Architect) over markdown files in .decisions/. Use when the user runs /signals (ctx, a question, panel, update, drift). ALSO use it on your own, without being asked, during build and steering, whenever (a) you are about to make a choice a CEO, PM or Architect would own (product scope, user-facing rules, budget, stack, data model, boundaries, security posture), (b) the user steers you in a way that sets or changes such a choice, or (c) your build deviates from a stored decision. Ask the store before choosing; propose with /signals update before relying on a new executive decision.
---

# signals

The project is run like a small org. Three executives own decisions: **CEO, PM, Architect**. The human is the **board** and finalizes every executive decision and every conflict. You (the agent) never write an executive decision to the store without the human's explicit approval in this conversation.

Principles and the full model with a worked session live in the signals repo (`principles.md`, `model.md`); they are not needed at runtime.

## Store

```
.decisions/
  map.md                     # partition tree + what each partition owns (itself a decision)
  ceo.md                     # CEO, single partition
  pm/<area>.md               # PM partitions (product areas)
  arch/<area>.md             # Architect partitions (technical areas)
  session/<date>-<task>.md   # drafts awaiting review
```

- **Reference** a decision as `partition#slug`, where `partition` is the file path under `.decisions/` without `.md` (`ceo`, `pm/onboarding`, `arch/auth`) and `slug` is its `##` heading. Example: `arch/auth#server-sessions`.
- **Hierarchy:** CEO is above PM and Architect. PM and Architect are peers. Lower decisions must fit the constraints of the decisions they serve.
- **Invariant:** the store never contains a conflict. No two live decisions contradict each other.
- **Empty store:** if `.decisions/` or `map.md` is missing, say the store is empty and carry on. The first review proposes a starter `map.md` (partitions `ceo`, `pm/*`, `arch/*`) and `ceo.md` alongside the first decisions; create the folders when writing.

## Roles

| Role | Owns |
|---|---|
| CEO | why the product exists, who it is for, non-goals, budget, big bets |
| PM | what is built: feature scope, user-facing rules and behavior |
| Architect | how it is built: stack, data, boundaries, invariants, security posture |

Roles are lenses, not agents. "PM answers" means: you read the PM partitions and answer as their owner.

**Grounding rule:** a role answers only from stored decisions and cites them (`pm/onboarding#email-signup-v1`). If nothing covers it, the role says **Undecided** and names the nearest decision. Never invent a position and present it as decided. A role may *suggest* an option, labeled as a suggestion.

## Executive test

A decision is executive (store it) if either is true:
1. Rebuilding the project from `.decisions/` alone would get this wrong without it.
2. Changing it later would require the CEO, PM or Architect to decide again.

Otherwise it is a **detail** (library choice inside agreed stack, naming, file layout, retries, test tooling): never stored, you just proceed.

## Routing

Put a decision in the **lowest partition that covers everything it touches**.
- One area → that partition file.
- Several areas of one role → that role's most general partition (add it to `map.md` if missing, as a reviewed decision).
- Spans PM and Architect → split into a linked pair (one decision in each, each `Serves` the other) or put the driving decision in the owner's partition. Show both in one review.
- If no partition fits, propose a new partition in `map.md` in the same review.

## Commands

### `/signals ctx <task>`
1. Read `map.md`, pick the partitions the task touches.
2. Load `ceo.md` + those partitions + partitions they `Serve`.
3. List any files in `session/` with unreviewed drafts.
4. Output:
```
signals: Partitions: pm/onboarding, arch/auth · loaded 6 decisions
     ceo#audience-smb · ceo#infra-budget · pm/onboarding#email-signup-v1 · …
     ⚠ task touches pm/onboarding#email-signup-v1  (one line per decision the task may change)
     📝 3 unreviewed drafts from "google login" (2026-11-26) — review now?
```
Then treat loaded decisions as binding constraints for planning and building.

### `/signals <question>`
Answer as a panel. Only roles that own the topic speak, 1–2 lines each, with citations or **Undecided**.
Format as markdown (not a code block): role name in bold, followed by a colon, and one empty line between roles.

Example output:

**PM:** Undecided. `pm/onboarding#email-signup-v1` covered v1 only. Fits `ceo#audience-smb`.

**Architect:** `arch/auth#server-sessions` holds — store provider id only.
If the question reveals a conflict, say so in the relevant role's line and offer the choice. Use the panel freely during planning; during build, ask it **before** making any executive choice.

### `/signals panel <topic>` — discussion
A rapid-fire discussion between all three roles, grounded in the store. Use it to explore an open question, a trade-off, or an override before deciding.

Each turn, all three speak, in this order:
- **CEO** takes a stance or reframes: direction, audience, budget, non-goals.
- **PM** says what it means for the user, with a concrete example.
- **Architect** states how it works or the hard limit it hits, with a mechanism or a number.

Rules:
- 2–4 lines per role. Strong stances, never vague. A role may ask the user one sharp question.
- Every stance either cites a decision (`ceo#audience-smb`) or is marked *Suggestion:*. Never present a suggestion as decided.
- Flag a conflict with a stored decision as soon as it comes up: `⚠ would break <partition#slug>`.
- When the user agrees to something executive, it becomes a draft. Track drafts across turns.
- Detail level is the decision level: enough to fill what / why / why-not. Not implementation.
- An optional small ASCII diagram, only if it shows something new.

Output exactly this, as markdown (not a code block), then stop and wait for the user:

**CEO:** <stance, 2–4 lines>

**PM:** <user impact with a concrete example, 2–4 lines>

**Architect:** <mechanism, number or hard limit, 2–4 lines; optional diagram>

**Your move:** <2–3 concrete directions> · 📝 <n> drafts (`partition#slug`, …)

No headings, numbering, or other speaker names. The panel ends when the user runs `/signals update` (batch review of the drafts) or moves on; drafts are written to `session/` so they are not lost.

### `/signals update` (no argument) — batch
1. Scan the conversation since the last update for executive decisions: agreed in discussion, implied by the plan, given as steers, or made by you.
2. Skip anything already committed or rejected this session. Drop details.
3. Write the drafts to `session/<date>-<task>.md`.
4. Show the review (format below). Wait for the human.
5. Commit approved items to their partitions, remove them from the session file. Rejected items are deleted. Unanswered items stay in the session file.

Use this after planning, and once at the end of build/steer as a backstop.

### `/signals update <decision>` — interactive
1. Run the executive test. If it is a detail, reply exactly: `Not executive (<reason>). Not stored, continue.` and continue working.
2. Ask the store first: is it already decided? If yes, cite it and stop.
3. Route it, check conflicts (below), draft the full record.
4. Show a one-item review with 🔒 and **stop working on anything that depends on it** until the human answers.
5. On approval, commit immediately.

You call this on your own during build and steering. A user steer that sets or changes an executive choice → call it right away, before acting on the steer.

### `/signals drift [partition]`
1. For each decision in scope (all partitions if none given), check the code under its `Scope` against its **What**.
2. Report ✓ / ✗ per decision, with `file:line` evidence for ✗.
3. For each ✗ offer: `a) fix code` (becomes a build task; continue with build/steer) or `b) amend decision` (goes through `/signals update <decision>`).

## Conflicts

Before proposing any decision, check it against:
- decisions in the same partition,
- every decision it `Serves` and every decision above it (CEO always),
- peer decisions it touches (PM ↔ Architect).

A conflict is a forced choice for the human: `a) keep existing, change approach` / `b) replace existing`. Never resolve a conflict yourself. Never let the higher role win automatically. Show conflicts first in any review.

### Overrides
When a decision would override or invalidate decisions below it (any change to a CEO decision, or a decision others `Serve`):
1. Find every decision whose `Serves` points at it, transitively.
2. Run a `/signals panel` turn on the override: each role states what changes for its affected decisions.
3. Show one review listing the override and every affected decision with options.
4. **All or nothing:** commit the override and all downstream edits together, or none. If the human cancels, nothing changes.

## Review format

Per decision, grouped by partition, conflicts first.
```
Plan review (3) · 1 conflict

⚠ arch/auth#oauth-no-token-storage — conflict
   Plan stores a refresh token. Decision says no tokens kept.
   a) keep decision, change approach   b) replace decision

pm/onboarding · NEW #google-signup
   Google signup alongside email. serves ceo#audience-smb
   why: SMB users live in Google Workspace · why-not: Microsoft (low demand)

arch/auth · NEW #session-expiry-30d
   Sessions expire after 30 days idle. serves ceo#audience-smb
   why: SMB users hate re-login · why-not: 7d (friction)

answer: approve all / pick / edit <slug> / reject <slug> · conflicts need a choice
```
Review shows a summary. The committed record is the full template below.

## Decision record

Every field carries real information. Decisions drive later decisions.

```md
## <slug>

**What**
Precise enough to rebuild from and to check against code. 2–4 lines.

**Why**
- The forces behind it, each linked to decisions it serves where possible.

**Why not**
- <alternative> — reason it lost.

**Implications**
- What this constrains downstream, with links to affected decisions.

**Revisit when**
Concrete trigger that should reopen it.

**Serves**   <partition#slug> · …
**Scope**    <partition> · code: <globs>
**By**       <dev | agent-proposed> · dev-approved · <YYYY-MM-DD>
**Context**  Session "<task>", <plan | build | steer | drift>. One line on how it was decided.
```

Changing a decision: edit it in place, update **By**/**Context**, and add the old position to **Why not** (`<old position> — replaced <date>: <reason>`). Renaming a slug: update every reference in the same commit.

## Response rules
- Answers: per role, only owning roles, 1–2 lines. **Bold role name**, empty line between roles.
- Panel: all three roles, CEO → PM → Architect, 2–4 lines each, then **Your move:**.
- Reviews: per decision, grouped by partition, conflicts first.
- Non-executive update: one line, then continue.
- Never write to partition files without explicit approval in this conversation.
