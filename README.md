# Signals

**The decision plane for building with agents.** Vet an idea before you spend tokens on it, make the go / no-go
call yourself, and distill the meeting into opinionated context files your coding agents build from.

Vibe coding starts from an unvetted hunch and a mental model that lives only in your head, so you end up in
prompt fights. Traditional SDLC fixes that with process and micromanagement. Signals sits in between: you work
at the context layer (the *why* and the *shape*), and agents work at the code layer.

```
  meeting ──▶ verdict ──▶ distill ──▶ context files ──▶ (bring your own executor)
  panel:      you:        worker      product · business · vocab
  CEO·PM·     commit      writes      architecture · abstractions
  Architect   or kill     them live   you review, ask for changes
```

## How it works

```
 ┌──────────────┐           ┌───────────────────────────┐   jobs    ┌──────────────────────┐
 │   Browser    │ ────────▶ │  Daemon (signals serve)   │ ────────▶ │  Worker, per repo    │
 │  meetings,   │ ◀──────── │  localhost:3461           │ ◀──────── │  /signals skill +    │
 │  verdicts,   │   live    │  repo-a/.signals/ideas    │  replies  │  poll.sh (Claude     │
 │  context     │           │  repo-b/.signals/ideas    │           │  Code)               │
 └──────────────┘           └───────────────────────────┘           └──────────────────────┘
```

Jobs are derived from each idea's state, one at a time per repo:

| Job | When | The worker… |
|-----|------|-------------|
| `panel` | you spoke last in a meeting | answers as CEO, PM and Architect, ending on the sharpest question |
| `distill` | you committed the idea | writes the five context files, one by one, while you watch |
| `refine` | you asked for a change on a context file (or a selection in it) | edits the file, and the others if the change ripples |

Each idea lives in `<repo>/.signals/ideas/<idea>/`: `idea.json` (transcript, verdict, change requests) and
`context/*.md`. Commit `.signals/` with your repo; it is the shared mental model.

## Run it

```bash
node bin/signals.js serve /path/to/repo     # starts the daemon, registers the repo, prints the URL
ln -s "$PWD/.claude/skills/signals" ~/.claude/skills/signals   # make /signals available in every repo
```

Then open Claude Code in that repo and run `/signals`. Open http://127.0.0.1:3461 and start a meeting.

```bash
signals status          # registered repos and whether a worker is listening
signals remove [repo]   # unregister (the .signals/ folder stays); or use × next to the repo picker
signals stop            # stop the daemon
```

The opinions live in the skill: `references/panel.md` (how the panel speaks) and `references/distill.md` (what
each context file must contain). Change those to change the house style.

## Not yet

Sketch (a visual feel of the product), milestones and PRDs (the plan layer, which builds on the context files),
execution handoff, and drift detection.
