# Signals

**You brainstorm. Signals derives the context. Agents write the code.**

A control plane for building context (signals): ideate, decide, and inject context files into any repo.

**Not another spec-driven flow.** You never write a spec. You argue the idea with a panel and make the call.
Signals distills the context and keeps it current; you only approve what changed.

**Not another agent orchestrator.** Signals stops at the PRD. Build it with Claude Code or whatever agent and
workflow you already use.

```
 meeting ─────────▶ context ──────────────▶ PRDs ──────────▶ execute
 CEO · PM ·         business · product ·     3–7, in          one PRD per PR,
 Architect          model · vocab · arch     build order      Claude Code or your agent
```

## What you get

Signals is a local daemon that runs the step before the code.

- **Ideate in one place.** A central server at `localhost:3461` hosts every repo's meetings, decisions and
  context in a single browser UI.
- **Inject context signals.** Each repo keeps one living context: a few short files in `.signals/context/` that
  any agent can read.
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
3. Click **Execute** on a PRD, review the result, and move to the next.

You steer the *why* and the *shape*; agents handle the rest.

**Site:** https://smarchone.github.io/signals/
