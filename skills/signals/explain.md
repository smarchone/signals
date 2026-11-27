# `/signals explain [area]` — experimental

> Experimental: the shape and behavior of this command may change.

Bring a human who is new to the project (onboarding, handover) up to speed on **why** it is the way it is. Scope is the whole project, or one area if given (`auth`, `billing`, a path).

Read-only: never writes to the store, never saves the report. Output goes to the terminal.

## Goal

After reading, the human can answer the "why X, why not Y?" questions for the scope without opening the code. That is the only test of a good report.

## Sources

- `.signals/`: stored decisions, their `why`, `not` and `serves`
- `git log`: when decisions and code landed, and in what order
- the codebase: what the decisions actually shaped

## What is yours to figure out

Which decisions are the roots, how decisions cause each other across roles and partitions, how deep to go, how to group and order. Use judgment. Different runs may tell the story differently; that is fine as long as each passes the goal.

## What is fixed

**Layered for attention.** Three layers. A reader can stop after any one and still have something true:

1. **Pitch:** one line. What the project (or area) is, for whom, under what constraint.
2. **Highlights:** the 2–4 root decisions everything else follows from. One bullet each, bold handle plus what it leads to.
3. **Report:** short prose, a paragraph per area or root. What was decided, why, what it led to and what lost. Close with what is **not decided yet** and a **Sources** line.

For a narrow area, Pitch and Highlights may shrink to a line each; the Report does the work.

Rules for all layers:
- **An explanation, not a tree.** Plain words, the way a teammate would explain it. No graphs, arrows, slugs or role tables outside the Sources line.
- **Concise.** About one screen in total. Leave out what a newcomer does not need yet, and say so in one line.
- **Honest about causes.** When a link is your reading and not something the sources state, say so in words ("probably because…", "looks like…"). Never present a guess as recorded.
- **Checkable, but out of the way.** Sources lists the decision refs, commits or `file:line` the explanation rests on. The human asks for more when they want it.
- **Gaps are named.** The places a newcomer might step in where no decision exists.

Sample (from `test/.signals/`), not a template:

```
Pitch
A self-serve team tool for small teams with no IT department, run by one
developer on $200 a month or less.

Highlights
- Self-serve or nothing: no sales call, no admin setup. Shapes all of onboarding.
- $200 a month or less until $5k MRR: one language, one datastore.
- Server-side sessions in Postgres: where the two meet. Instant revocation, no
  extra vendor.

Report
Onboarding. Email and password only; Google and SSO wait until after v1. At
most two screens from landing to a working workspace. Verification runs in the
background and never blocks. Any new step must replace an existing one.

Stack. Strict TypeScript on Express, so a solo developer works in one language.
Managed Postgres costs about $15 a month and is the only datastore. No Redis,
queue or search service; Postgres covers all three.

Auth. The browser holds only an opaque cookie; sessions live in Postgres. JWT
lost because revoking those tokens would need a session store anyway. Auth0
(about $240 a month) would break the budget.

Not decided yet: frontend framework, hosting, how long sessions last.

Sources: ceo/business#audience-smb · ceo/business#infra-budget ·
pm/onboarding#email-signup-v1 · pm/onboarding#signup-2-screens ·
arch/architecture#typescript-express · arch/architecture#postgres ·
arch/architecture#single-datastore · arch/auth#server-sessions
```
