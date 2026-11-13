# Signals

**You decide. Signals derives the context. Agents write the code.**

The decision layer for coding agents. You talk each idea through with an AI panel (CEO, PM, Architect) and
decide the why and the shape. Signals distills those decisions into one shared abstraction of your project:
direction, not instructions. Agents build autonomously within it, and your attention goes only to the calls
that are yours.

```
 meeting ─────────▶ context ──────────────▶ PRDs ──────────▶ build
 CEO · PM ·         business · product ·     units of work,   one PRD per PR,
 Architect          model · vocab · arch     in build order   Claude Code or your agent
```

## The idea

**Attention is scarce. Abstraction is the solution.**

You can't read every line an agent writes, and you shouldn't decide every detail it needs. What you can do
is decide at the level that steers the project, and let the agent work from that.

```
   human  ───────────▶  shared abstraction  ◀───────────  agent
   decides the why       business · product ·             owns the details,
   and the shape         model · vocab · arch             steers by it
```

That middle layer is the right altitude: high enough that you only spend attention on calls that are yours,
concrete enough that an agent can build from it. Humans and agents operate on the same abstraction, so
neither has to re-brief the other. Signals builds that layer, and keeps it current as you decide.

The context it derives is **direction, not instruction**: what you decided and why, never a task list.

Signals doesn't build context per task. It builds **one living context that drives the project**: you set
the direction, and agents get the autonomy to work out the details within it. PRDs are just the handoff cut
from it.

| | Direction | Autonomy |
|---|---|---|
| Micromanagement | ✓ | ✗ you own every call |
| Vibes | ✗ | ✓ with nothing to steer by |
| **Signals** | **✓** | **✓ within what you decided** |

## The problem

- **Context anxiety.** You fear the next session will forget, so you dump notes into `NOTES.md`,
  `plan-v2.md`, `context-final.md`. Sessions scatter and decisions fragment across them.
- **Specs aim at code, not understanding.** A spec is "complete enough to generate the right code." The
  decisions behind it get missed or spread across specs.
- **Vibes or micromanagement.** Either you bash prompts into an LLM with no shared abstractions to steer by,
  or you own low-level calls an LLM is better placed to make.

Each is a missing shared abstraction: nothing sits between what you decided and what the agent reads, so
every session starts from zero.

## What it isn't

- **Not a spec-driven flow.** You never write a spec. You argue the idea with a panel and make the call.
  Signals distills the context and keeps it current; you only approve what changed.
- **Not an agent orchestrator.** Signals stops at the handoff. Execution is pluggable: build each PRD with
  Claude Code or whatever agent and workflow you already use.
- **Not an agent memory layer.** Memory layers record what the *agent* did. Signals records what *you*
  decided, and what you ruled out.

| | Captures | Scope | Who decides |
|---|---|---|---|
| Spec tools (Kiro, Spec Kit, OpenSpec) | instructions: requirements → tasks | one feature | you write it, the agent expands it |
| Agent memory layers | what the agent did | sessions | the agent, automatically |
| ADRs | single decisions | ad hoc | anyone, in any format |
| **Signals** | **direction: the why and the shape** | **the whole project** | **you, in a meeting; reviewed before it lands** |

## Who it's for

Solo builders and small teams on small-to-medium repos, already working with coding agents. Large projects
that need heavier guardrails aren't a fit yet.

## What you get

Signals is a local daemon that runs the step before the code.

- **Decide in one place.** A central server at `localhost:3461` hosts every repo's meetings and calls in a
  single browser UI. You argue the idea with a panel, then commit or kill it.
- **Every decision on record.** `.signals/meetings.md` logs each call: what was decided, what was ruled out,
  and why. The next meeting starts from it, so settled questions stay settled.
- **Decisions become direction.** Each repo keeps a few short Markdown files in `.signals/context/`:
  direction for agents to steer by, not instructions to follow. Later meetings amend the same context; you review only what moved.
- **Any agent can read it.** No SDK, no lock-in. Point your agent at `.signals/context/` (from `CLAUDE.md`,
  `AGENTS.md`, or a prompt) and it starts from what you decided.
- **Bring your own orchestrator.** Signals hands off PRDs in build order. Execute them with Claude Code, or
  copy the prompt into whatever agent or workflow you already use.

## Architecture

```
 ┌──────────────┐   ideas    ┌───────────────────────────┐   jobs    ┌──────────────────────┐
 │  Signals UI  │ ─────────▶ │   Daemon (signals serve)  │ ────────▶ │  Claude Code         │
 │  meetings ·  │ ◀───────── │   localhost:3461          │ ◀──────── │  /signals, per repo  │
 │  context ·   │ approvals  │                           │  results  │                      │
 │  PRDs        │            │  repo-a/.signals          │           │  polls the daemon    │
 └──────────────┘            │  repo-b/.signals          │           │  for jobs            │
                             └───────────────────────────┘           └──────────────────────┘
```

One daemon serves all your registered repos. Each repo's Claude Code session runs `/signals` and waits for
jobs: it speaks as the panel, distills the context, and cuts it into PRDs.

## Quick start

Needs Node 22+ and [Claude Code](https://claude.com/claude-code).

```bash
git clone https://github.com/smarchone/signals && cd signals
npm link                         # install the signals CLI
npx skills add . -g              # install the /signals skill
```

Then, in your repo:

```bash
claude
> /signals                       # starts the daemon and registers this repo
```

To register another repo: `signals serve /path/to/repo`.

1. Open **http://127.0.0.1:3461** and pitch your idea.
2. Commit or kill it. If you commit, review the context, then the PRDs.
3. Click **Build** on a PRD, review the result, and move to the next.

You steer the *why* and the *shape*; agents handle the rest.

**Site:** https://smarchone.github.io/signals/
