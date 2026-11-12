# Signals

**The human operating plane for building with coding agents.** Iterate on an idea at the product and business
level, make the go / no-go call yourself, and distill it into just enough context to drive the project.

- **Review friendly:** every screen and file is shaped to save your attention.
- **Just enough abstractions** for you to hold in mind and steer by.
- **Good enough signals for agents:** a direction, not instructions. Coding agents are capable LLMs; they
  make local decisions, and you review those at PR time.

Vibe coding starts from an unvetted hunch and a mental model that lives only in your head, so you end up in
prompt fights. Traditional SDLC fixes that with process and micromanagement. Signals sits in between: you work
at the context layer (the *why* and the *shape*), and agents work at the code layer.

```
  meeting ──▶ verdict ──▶ distill, high level first ─────────────────────▶ (bring your own executor)
  panel:      you:        business.md · product.md · model.md
  CEO·PM·     commit      ─ ─ ─ ─ ─ ─ you approve ─ ─ ─ ─ ─ ─
  Architect   or kill     vocab.md · architecture.md          ◀ you approve
```

## How it works

```
 ┌──────────────┐           ┌───────────────────────────┐   jobs    ┌──────────────────────┐
 │   Browser    │ ────────▶ │  Daemon (signals serve)   │ ────────▶ │  Worker, per repo    │
 │  meetings,   │ ◀──────── │  localhost:3461           │ ◀──────── │  /signals skill +    │
 │  verdicts,   │   live    │  repo-a/.signals          │  replies  │  poll.sh (Claude     │
 │  context     │           │  repo-b/.signals          │           │  Code)               │
 └──────────────┘           └───────────────────────────┘           └──────────────────────┘
```

Jobs are derived from each idea's state, one at a time per repo:

| Job | When | The worker… |
|-----|------|-------------|
| `panel` | you spoke last in a meeting | answers as CEO, PM and Architect, ending on the sharpest question |
| `distill` | on commit, or when you approve business, product and model | writes the next files while you watch, then waits for your approval |
| `refine` | you asked for a change on a context file (or a selection in it) | edits the file, and the others if the change ripples |

At each approval you **approve**, **ask for a change** on any selection, or **redo** with guidance.
The files are curated signals, not documentation: `model.md` is the product as composed abstractions, high
level only; `vocab.md` pins 10–15 terms by domain, each domain explained in its own terms; `architecture.md`
explains how those domains compose into the product, then shows it as a hexagonal sketch with its ports and
adapters: an initial direction rather than a decision log.

A repo has one idea, in `<repo>/.signals/`: `idea.json` (transcript, verdict, change requests) and
`context/*.md`. To change distilled context, reopen the meeting (the new turns flow
into the files as edits) or ask for a change on any file; either way only what moved is edited, and highlighted
until you mark it reviewed. To vet a different idea, delete the current one. Commit `.signals/` with your repo; it is the shared
mental model.

## Run it

```bash
node bin/signals.js serve /path/to/repo     # starts the daemon, registers the repo, prints the URL
ln -s "$PWD/.claude/skills/signals" ~/.claude/skills/signals   # make /signals available in every repo
```

Then open Claude Code in that repo and run `/signals`. Open http://127.0.0.1:3461 and start a meeting.

```bash
signals status          # registered repos and whether a worker is listening
signals remove [repo]   # unregister (the .signals/ folder stays); or use × on the repo in the sidebar
signals restart         # pick up a new server.js; repos and listening workers come back on their own
signals stop            # stop the daemon
```

The opinions live in the skill: `references/panel.md` (how the panel speaks) and `references/distill/`
(`common.md` for every file; `brief.md` covers business, product and model, and `design.md` vocabulary and
architecture). Change those to change the house style.

## Not yet

Milestones and PRDs (the plan layer, where constraints and decisions live), handing the context to an
executor, replying to the worker's questions in place, and drift detection.
