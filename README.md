# Signals

**A control plane for human decisions and context; not agent orchestration.**

Agents ship code fast. They just don't know *why* they're building it, so they build the wrong thing, fast.

## What you get

**One place to ideate and inject context signals into your repo. Bring your own orchestrator.**

Signals is a local daemon that runs the step before the code:

- **Ideate in one place.** A central server at `localhost:3461` hosts every repo's meetings, decisions and
  context in a single browser UI.
- **Inject context signals.** Each repo keeps one living context: a few short files in `.signals/context/` that
  any agent can read.
- **Bring your own orchestrator.** Signals hands off PRDs in build order. Execute them with Claude Code or
  copy the prompt into whatever agent or workflow you already use.

```
 meeting ─────────▶ context ──────────────▶ PRDs ──────────▶ execute
 CEO · PM ·         business · product ·     3–7, in          one PRD per PR,
 Architect          model · vocab · arch     build order      Claude Code or your agent
```

## Why it works

- **Only vetted ideas get built.** A CEO, PM and Architect pressure-test the idea; you make the call.
- **Agents get direction, not instructions.** Each idea becomes a few short context files your agents build from.
- **Work arrives in build order.** The context is cut into PRDs, one per PR.
- **You stay in control.** Every stage waits for your approval, and changes stay highlighted until you've reviewed them.

You steer the *why* and the *shape*; agents handle the rest.

## Quick start

Needs Node 22+ and [Claude Code](https://claude.com/claude-code). From a checkout of this repo:

```bash
npm link                         # install the signals CLI
npx skills add . -g              # install the /signals skill
signals serve /path/to/repo      # start Signals for your repo
```

1. In Claude Code, open your repo and run `/signals`.
2. Open **http://127.0.0.1:3461** and pitch your idea.
3. Commit or kill it. If you commit, review the context, then the PRDs.
4. Click **Execute** on a PRD, review the result, and move to the next.
