# signals — decisions owned by a 3-executive org

> The project is run like a small org with three executives — **CEO, PM, Architect** — each owning a partitioned slice of the decisions.
> `/signals` is the one interface: dev and coding agent ask, propose, and resolve through it; the human approves everything executive.

**Bar:** the decision store alone should be enough to rebuild ~90% of the codebase.

---

## 1. Store

```
.signals/
  map.md                     # partition tree (itself a decision)
  ceo.md                     # CEO — single partition
  pm/<area>.md               # PM, partitioned by product area (onboarding, billing…)
  arch/<area>.md             # Architect, partitioned by technical area (auth, data…)
  session/<date>-<task>.md   # drafts awaiting review
```

- **Hierarchy:** CEO sits above PM and Architect. PM ↔ Architect are **peers**.
- **Routing:** a decision lands in the **lowest partition covering everything it touches**. Cross-partition decisions go up to the common owner.
- **References:** `partition#slug` (slug = the markdown heading). No numeric IDs. Renames update all references during review.
- **Invariant:** the store never contains a conflict.
- Moving a decision between partitions, or changing `map.md`, is itself a decision and is reviewed.

## 2. Decision record

Each field must carry real information — decisions drive later decisions and the project's evolution.

```md
## server-sessions

**What**
Sessions are stored server-side in Postgres (`sessions` table). Browser holds only an
opaque, httpOnly, secure cookie. No user data in the cookie or in client storage.

**Why**
- Instant revocation is required: SMB admins must be able to kick users immediately (ceo#audience-smb).
- Postgres is already the only datastore (arch/data#postgres) — no new infra.
- Low load (< 1k concurrent users) makes per-request session lookup cheap.

**Why not**
- JWT — revocation needs a denylist, which is a session store anyway, with more moving parts.
- Redis — faster, but a second datastore breaks arch/data#single-datastore and adds cost.
- Hosted auth (Auth0) — ~$240/mo breaks ceo#infra-budget.

**Implications**
- Any new client (mobile, CLI) must use cookie or token exchange, not stateless tokens.
- Session table grows with users → needs an expiry policy (→ arch/auth#session-expiry-30d).

**Revisit when**
Concurrent users > 50k, or a mobile app enters scope.

**Serves**   ceo#audience-smb · arch/data#postgres
**Scope**    arch/auth · code: src/auth/**
**By**       agent-proposed · dev-approved · 2026-11-20
**Context**  session "add login", plan step 2. Dev rejected JWT after a revocation discussion.
```

| Field | What it lets later work do |
|---|---|
| What | precise enough to rebuild from and to check against code |
| Why | the forces behind it, linked to the decisions it serves |
| Why not | alternatives with reasons, so they aren't re-argued |
| Implications | downstream decisions can find what this one constrains |
| Revisit when | the trigger that reopens it, so it doesn't go stale silently |
| Serves | hierarchy links: used for cascade and conflict detection |
| Context | where and how it was decided (tribal knowledge, written down) |

## 3. Roles

| Role | Owns |
|---|---|
| CEO | why the product exists, who it's for, non-goals, budget, big bets |
| PM | what is built: feature scope, rules users see |
| Architect | how it's built: stack, boundaries, invariants, data |

- Roles are **lenses** over their partitions, not agents.
- A role answers **only from stored decisions, with citations**, or says **undecided**. Never improvises.

## 4. Interface — the `signals` skill

| Command | Does | Review |
|---|---|---|
| `/signals ctx <task>` | loads relevant decisions along the partition path; surfaces unreviewed drafts | — |
| `/signals <question>` | relevant roles answer, per role, 1–2 lines each | — |
| `/signals panel <topic>` | all three roles discuss (CEO → PM → Architect, 2–4 lines each), grounded in the store; agreed points become drafts | via `/signals update` |
| `/signals update` | scans the conversation so far for executive decisions not yet recorded | batch |
| `/signals update <decision>` | proposes one decision | interactive, immediate |
| `/signals drift [partition]` | checks decisions against the code | each mismatch → `/signals update` |

- **Dev invokes** for planning, questions, panels, drift. Use intuition-panel for raw ideas before a store exists; `/signals panel` once it does.
- **Agent invokes on its own** during build and steer, triggered by the skill description. The closing `/signals update` scan is the backstop for misses.
- The agent must `/signals <question>` before `/signals update <x>`, so it doesn't propose what's already decided.

**Response format**
- Answers → **per role**, only roles that own the topic speak.
- Reviews → **per decision**, grouped by partition, conflicts first.
- Non-executive update → one line: "not stored, continue".

**Executive test:** would rebuilding from the decisions get this wrong without it, or would a role need to re-decide it? If no → detail, left to the agent, never stored.

## 5. Flow

```
plan   → /signals ctx · discuss with /signals <q> · /signals update        → batch review
build  → agent: /signals <q> before choosing · /signals update <x>     → blocks, dev answers
steer  → dev steer is executive → /signals update <x>              → interactive
end    → /signals update                                           → catches misses
drift  → /signals drift → fix code (build/steer) or amend decision (review)
```

- Planning is **batch**. Build and steer are **interactive**.
- Unreviewed drafts persist in `session/` and resurface at the next `/signals ctx`. They never expire quietly.

## 6. Conflicts and overrides

- **Every conflict needs human review.** Routed to the common owner, framed by the roles involved.
- **Peer conflicts (PM ↔ Architect):** a panel, with CEO constraints as context.
- **Higher decision overriding lower ones:** a panel discussion. `serves:` links find the affected decisions below, each role states what changes, dev decides each item. **All applied together or none.**

---

## 7. Mock session — "add Google login"

**Plan (batch)**
```
dev: /signals ctx "add Google login"
signals: Partitions: pm/onboarding, arch/auth · loaded 6 decisions
     ⚠ task touches pm/onboarding#email-signup-v1

dev: /signals can we add Google login?
PM:   Undecided. pm/onboarding#email-signup-v1 covered v1 only. Fits ceo#audience-smb.
Arch: arch/auth#server-sessions holds — store provider id only. Auth0 breaks ceo#infra-budget.

dev: /signals why not Auth0? it's faster
CEO:  ceo#infra-budget caps infra at $200/mo; Auth0 ≈ $240/mo. Raise budget or self-host?
dev:  self-host

dev: /signals update
signals: Plan review (2)
  pm/onboarding · NEW #google-signup           serves ceo#audience-smb
  arch/auth     · NEW #oauth-no-token-storage  serves arch/auth#server-sessions
  approve all / pick / edit
dev: all
```

**Build (interactive)**
```
agent: /signals how long do sessions last?
signals: Arch: Undecided. Nearest: arch/auth#server-sessions (no expiry).

agent: /signals update "sessions expire after 30 days"
signals: 🔒 arch/auth · NEW #session-expiry-30d · serves ceo#audience-smb · no conflicts
       approve / edit / reject
dev:   approve

agent: /signals update "use passport.js for OAuth"
signals: Not executive (library choice). Not stored, continue.

agent: /signals update "store Google refresh token"
signals: 🔒 ⚠ Conflicts with arch/auth#oauth-no-token-storage
       a) keep decision, agent changes approach   b) amend decision
dev:   a
```

**Steer (interactive)**
```
dev: if a Google email matches an existing account, link them

agent: /signals update "link accounts by verified email"
signals: 🔒 pm/onboarding · NEW #link-accounts-by-email · serves #google-signup
          PM ↔ Arch: needs arch/auth#user-key-verified-email (linked pair)
       approve both / edit / reject
dev:   approve both
```

**End**
```
agent: /signals update
signals: Nothing missed. Session committed 5 decisions.
```

**Override — later session**
```
dev: /signals go upmarket: target mid-size companies, SSO required
CEO:  ceo#audience-smb → #audience-midmarket. Affects 3 decisions below.
PM:   #signup-2-screens no longer matters — admins invite users. Keep #google-signup for small orgs?
Arch: Self-hosted SAML is heavy; ceo#infra-budget blocks hosted vendors (~$400/mo).

dev: /signals update
signals: Override review — all or nothing
  1. ceo#audience-midmarket                 accept / edit / cancel all
  2. ceo#infra-budget → $500/mo             a) raise  b) keep, self-host SAML
  3. pm/onboarding#signup-2-screens         a) retire  b) keep
  4. pm/onboarding#google-signup            a) keep  b) retire
dev: accept · 2a · 3a · 4a
signals: Committed 4 edits as one change.
```

**Drift**
```
dev: /signals drift arch/auth
signals: ✓ #server-sessions  ✓ #session-expiry-30d
     ✗ #oauth-no-token-storage — src/auth/google.ts:41 saves accessToken
       a) fix code (build/steer)   b) amend decision (review)
dev: a
```

---

## 8. Non-goals (for now)

- No role agents, no multi-agent orchestration.
- No CLI, no hooks.
- No stale marking — an override always means a discussion.

## 9. Simplest form to test

- One skill `signals/SKILL.md`: the 5 commands, the executive test, routing rules, decision template, response formats.
- Seed `.signals/` with `map.md`, `ceo.md`, `pm/onboarding.md`, `arch/auth.md`, `arch/data.md` (~6 decisions).
- Test: replay the mock session above. Check:
  1. answers cite decisions or say undecided
  2. non-executive updates are dropped
  3. a conflict blocks
  4. the override applies all or nothing
  5. drift catches a planted mismatch
