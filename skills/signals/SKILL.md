---
name: signals
description: Executive decision store for this project, run as a 3-role org (CEO, PM, Architect) over markdown files in .signals/. Use when the user runs /signals (ctx, a question, panel, update, drift, explain). ALSO use it on your own, without being asked, during build and steering, whenever (a) you are about to make a choice a CEO, PM or Architect would own (product scope, user-facing rules, budget, stack, data model, boundaries, security posture), (b) the user steers you in a way that sets or changes such a choice, or (c) your build deviates from a stored decision. Ask the store before choosing; propose with /signals update before relying on a new executive decision.
---

# signals

The project is run like a small org. Three executives own decisions: **CEO, PM, Architect**. The human is the **board** and finalizes every executive decision and every conflict. You (the agent) never write an executive decision to the store without the human's explicit approval in this conversation.

Principles and the full model with a worked session live in the signals repo (`principles.md`, `model.md`); they are not needed at runtime.

## Store

```
.signals/
  map.md                     # every file in the store, one line each: what it owns
  vocab.md                   # shared terms; every role and every decision follows them
  ceo/business.md            # CEO main: brief + decisions
  pm/product.md              # PM main: brief + decisions
  pm/ui.md                   # PM partition, default: surfaces clutter product.md fast
  arch/architecture.md       # Architect main: brief + decisions
  <role>/<area>.md           # more partitions, added through review
  session/<date>-<task>.md   # drafts awaiting review (written by /signals update only)
```

These are good defaults, not a fixed layout: any file can be added, renamed or merged through review.

- **Reference** a decision as `partition#slug`, where `partition` is the file path under `.signals/` without `.md` and `slug` is its `##` heading. Example: `arch/architecture#server-sessions`. A term is `vocab#<term>`.
- **Hierarchy:** CEO is above PM and Architect. PM and Architect are peers. Lower decisions must fit the constraints of the decisions they serve. Everything follows `vocab.md`.
- **Invariant:** the store never contains a conflict. No two live decisions contradict each other, and no brief contradicts a decision.
- **Empty store:** if `.signals/` or `map.md` is missing, say the store is empty and carry on. The first review creates the default files alongside the first decisions (file formats under **Store files** below).

## Roles

| Role | Owns |
|---|---|
| CEO | why the product exists, who it is for, non-goals, budget, big bets |
| PM | what is built: feature scope, user-facing rules and behavior |
| Architect | how it is built: stack, data, boundaries, invariants, security posture |

Roles are lenses, not agents. "PM answers" means: you read the PM files and answer as their owner.

**Grounding rule:** a role answers only from stored decisions and cites them (`pm/onboarding#email-signup-v1`). If nothing covers it, the role says **Undecided** and names the nearest decision. Never invent a position and present it as decided. A role may *suggest* an option, labeled as a suggestion.

## Executive test

A decision is executive (store it) if either is true:
1. Rebuilding the project from `.signals/` alone would get this wrong without it.
2. Changing it later would require the CEO, PM or Architect to decide again.

Otherwise it is a **detail** (library choice inside agreed stack, naming, file layout, retries, test tooling): never stored, you just proceed.

## Routing

Each role has a **main** file, always loaded, and **partitions**, loaded only when a task touches them.

> Main holds what every task in that role must know. A partition holds what only some tasks need.

- A decision that binds most of the role's work → its main file. One area → that area's partition; if the area has none yet, main until a split is worth it (below), unless the human asks for the partition.
- **Any role can add partitions** (`ceo/<area>`, `pm/<area>`, `arch/<area>`), always through review: a `map.md` line plus the file.
- Spans PM and Architect → split into a linked pair (one decision in each, each `serves` the other) or put the driving decision in the owner's file. Show both in one review.
- **Splitting:** no size limit. When main holds a cluster (~3) of decisions about one area that most tasks don't need, propose moving them to a new partition in the next review: a `map.md` line plus the moves, references updated in the same commit.
- A new term, or a decision that uses a term differently from `vocab.md`, adds or changes the term in the same review. Renaming a term is an override.

## Commands

### `/signals ctx <task>`
1. Read `map.md`, pick the partitions the task touches.
2. Load `vocab.md` + the three main files + those partitions + files they `serve`.
3. List any files in `session/` with unreviewed drafts.
4. Output:
```
signals: Partitions: pm/onboarding, arch/auth · loaded 6 decisions
     ceo/business#audience-smb · ceo/business#infra-budget · pm/onboarding#email-signup-v1 · …
     ⚠ task touches pm/onboarding#email-signup-v1  (one line per decision the task may change)
     📝 3 unreviewed drafts from "google login" (2026-11-26) — review now?
```
Then treat loaded decisions as binding constraints for planning and building.

### `/signals <question>`
Answer as a panel. Only roles that own the topic speak, 1–2 lines each, with citations or **Undecided**.
Format as markdown (not a code block): role name in bold, followed by a colon, and one empty line between roles.

Example output:

**PM:** Undecided. `pm/onboarding#email-signup-v1` covered v1 only. Fits `ceo/business#audience-smb`.

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
- Every stance either cites a decision (`ceo/business#audience-smb`) or is marked *Suggestion:*. Never present a suggestion as decided.
- Flag a conflict with a stored decision as soon as it comes up: `⚠ would break <partition#slug>`.
- When the user agrees to something executive, it becomes a draft. Track drafts in the conversation only: no file writes, no `/signals update <decision>` calls, no per-decision review during the panel.
- Detail level is the decision level: enough to fill what / why / why-not. Not implementation.
- An optional small ASCII diagram, only if it shows something new.

Output exactly this, as markdown (not a code block), then stop and wait for the user:

**CEO:** <stance, 2–4 lines>

**PM:** <user impact with a concrete example, 2–4 lines>

**Architect:** <mechanism, number or hard limit, 2–4 lines; optional diagram>

**Your move:** <2–3 concrete directions> · 📝 <n> drafts (**handle**, …)

No headings, numbering, or other speaker names. The panel ends when the user runs `/signals update`, says the discussion is done, or moves on to building. Only then run the batch update once: write all drafts to `session/` and show one review.

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

You call this on your own during build and steering. A user steer that sets or changes an executive choice → call it right away, before acting on the steer. **Not during a panel:** there, steers become drafts for the closing batch update.

### `/signals drift [partition]`
1. For each decision in scope (all partitions if none given), check the code under its `Scope` against its **What**.
2. Report ✓ / ✗ per decision, with `file:line` evidence for ✗.
3. For each ✗ offer: `a) fix code` (becomes a build task; continue with build/steer) or `b) amend decision` (goes through `/signals update <decision>`).

### `/signals explain [area]` — experimental
Explain why the project (or one area) is the way it is, for a human being onboarded or taking over. Read-only, terminal output. Read `explain.md` in this skill's folder and follow it.

## Conflicts

Before proposing any decision, check it against:
- decisions in the same partition,
- every decision it `serves` and every decision above it (CEO always),
- peer decisions it touches (PM ↔ Architect).

A conflict is a forced choice for the human: replace the stored decision(s), drop the new one, replace some and narrow the new one, or their own version. Never resolve a conflict yourself. Never let the higher role win automatically. Show conflicts first in any review.

### Overrides
When a decision would override or invalidate decisions below it (any change to a CEO decision, or a decision others `Serve`):
1. Find every decision whose `serves` points at it, transitively.
2. Run a `/signals panel` turn on the override: each role states what changes for its affected decisions.
3. Show one review listing the override and every affected decision with options.
4. **All or nothing:** commit the override and all downstream edits together, or none. If the human cancels, nothing changes.

## Review format

Two groups, empty groups omitted. Show content, not identifiers: no slugs, file paths or full records. The human asks for those, or for what rests on a decision, when they want them.

- **needs you:** numbered, conflicts first. Every conflict, and every decision you proposed (`by: agent`). Nothing here lands unanswered.
- **already approved:** decisions the human stated or agreed to in chat. Their words are the approval; the line catches a misread. Silence = stands.

```
Review · 3 decisions · 1 conflict

needs you:
1. ⚠ **Keep Google tokens** · PM · conflicts with 3
   new, PM:       "Sync Google contacts; keep a refresh token to do it."
   a. Architect:  "Never keep OAuth tokens; store the provider user id only."
   b. Architect:  "No third-party data at rest beyond profile basics."
   c. CEO:        "No data a breach would make us disclose."
   4 more decisions rest on a–c
   → replace a–c · drop the new one · replace a, b but keep c · or say your version

2. **30-day idle sessions** · Architect · agent
   SMB users hate re-login; 7 days adds friction
   → approve · drop · or say your version

already approved:
- **Google signup alongside email** · PM · you, chat

reply in your own words, e.g. "replace all for 1, approve 2"
```

- **Handle:** bold, ≤6 words, names the decision for a human. The slug is chosen at commit.
- **Role** beside the handle, never a file path. Held items end with `agent` or `you, chat`.
- **Conflict:** one entry per new decision, every stored decision it contradicts quoted under it as `a.`, `b.`, … with its role. Conflicts can cross any roles. Quote at most 3; say `+ <n> more` for the rest.
- **Knock-on:** decisions that `serve` a replaced one are counted (`4 more decisions rest on a–c`), not quoted. On replace, recheck them; any that no longer fit come back as their own items before anything commits (see **Overrides**).
- **Choices** sit on each held item after `→`, phrased as outcomes. A partial choice (`replace a, b but keep c`) narrows the new decision until nothing contradicts; show the narrowed wording for approval.
- **Reply** is plain language. Map it to items; if a reply is unclear, ask about that item only. One held item needs no number.
- A why line (≤12 words) for agent decisions only.

Review shows a summary. The committed record uses the template below.

## Decision record

Compact: every line is read on every load, so it carries only what later reasoning needs.

```md
## <slug>
<What: precise enough to rebuild from and check code against. 1–3 lines, numbers and limits included.>
- why: <forces, `;`-separated, linking what it serves>
- not: <alternative> (<why it lost>) · …
- revisit: <concrete trigger>            # optional
- serves: <partition#slug> · … | — · code: <globs> · by: <dev | agent> · <YYYY-MM-DD>
```

Example:

```md
## no-accounts-static
v1: no accounts, login or server-side visitor state. Seen-dreams live in localStorage. Static site on a CDN, no backend.
- why: zero friction (ceo/business#feel-not-do); no personal data to leak; ~$0 to run
- not: accounts (friction, data liability) · backend for visitor state (nothing needs it)
- revisit: visitors want cross-device favorites, or a feature needs server state
- serves: pm/ui#browse-or-surprise · ceo/business#feel-not-do · code: all · by: dev+agent · 2026-11-26
```

- No implications, context or history fields. Downstream effects are found by following `serves` backwards; a hard constraint on others belongs in the What.
- Every word earns its place: no restating the slug, no prose transitions.
- `by: agent` means agent-proposed; every stored decision is dev-approved by definition.

Changing a decision: edit it in place, update the date, and append the old position to `not:` as `<old> (replaced <date>: <reason>)`. Renaming a slug: update every reference in the same commit.

## Store files

**Main files** open with a brief: the project in ~10 lines from that role's view. Each line points at the decision behind it; a brief never adds a rule of its own. Any commit that changes a decision updates the brief lines that cite it. Omit a brief section until a decision fills it.

```md
# CEO · business
## Brief
- problem: <current pain> (ceo/business#slug)
- for whom: <first user>
- why this wins: <edge>
## Decisions
## <slug>
…
```

| File | Brief sections |
|---|---|
| `ceo/business.md` | problem · for whom · why this wins · non-goals |
| `pm/product.md` | core loop · the moment · non-goals |
| `pm/ui.md` | surfaces · feel |
| `arch/architecture.md` | shape (domains in the middle, adapters at the edge) · hard lines |

Partitions have no brief: `# <Role> · <area>`, a `> <what it owns>` line, then decisions.

`vocab.md` is a table, not decision records:

```md
# Vocab
| Term | What it is | Why it must exist |
|---|---|---|
| **Dream** | one curated world evoking one feeling | the unit of the catalog |
```

`map.md` lists every file, one line each:

```md
# Map
- `vocab`: shared terms
- `ceo/business`: why it exists, who for, non-goals, quality bar, budget
- `pm/product`: behavior, rules, core loop
- `pm/ui`: surfaces, feel, user-facing wording
- `arch/architecture`: stack, data, boundaries, budgets, hard lines
```

## Response rules
- Answers: per role, only owning roles, 1–2 lines. **Bold role name**, empty line between roles.
- Panel: all three roles, CEO → PM → Architect, 2–4 lines each, then **Your move:**. No store writes until the panel ends.
- Reviews: `needs you` (numbered, conflicts first) then `already approved`; content, not identifiers.
- Non-executive update: one line, then continue.
- Never write to partition files without explicit approval in this conversation.
