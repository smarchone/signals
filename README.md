# Signals

**A control plane for human decisions, not agent orchestration.**

Coding agents write code fast, but they build whatever half-formed idea you hand them. Signals is a local
daemon that runs the step before the code, from ideation to context, PRDs and execution:

- **Meetings:** brainstorm with a founding panel (CEO, PM, Architect) that pressure-tests the idea. **You** make
  the go / no-go call, so only vetted ideas get built.
- **Context layer:** the meeting is distilled into a few short files (business, product, model, vocab,
  architecture) that give your agents a direction, not instructions.
- **PRDs to code:** the context is cut into PRDs in build order. Curate them, then execute one PRD per PR
  with Claude Code or your own agent.
- **Attention-friendly UX:** every stage stops for your approval, files are short, and changes stay highlighted
  until you mark them reviewed.

You steer at the *why* and the *shape*; agents make the local decisions, and you review them at PR time.

```
 meeting ──▶ verdict ──▶ context ─────────────────────▶ PRDs ──────────▶ build
 CEO·PM·     you commit  business · product · model     3–7 PRs, in      one PRD per PR,
 Architect   or kill     vocab · architecture           build order      Claude Code or your agent
                         ◀ you approve                  ◀ you approve
```

## Start in 1 minute

Needs Node 22+ and [Claude Code](https://claude.com/claude-code).

From a checkout of this repo:

```bash
npm link                         # install the signals CLI
npx skills add . -g              # install the /signals skill globally
signals serve /path/to/repo      # start the daemon, register your repo
```

1. Open Claude Code in your repo and run `/signals` (this starts the worker).
2. Open **http://127.0.0.1:3461** and pitch your idea to the panel.
3. Commit or kill it. If you commit, review the context, then the PRDs.
4. Click **Execute** on a PRD (or **Copy prompt** for your own agent). Test, commit, **Mark complete**, next.
5. Next feature? Start a **new meeting**. The panel works from the context and the meetings log, and
   committing amends the context. Same feature, thinking moved on? **Resume** the latest meeting instead.

## Meetings

A repo has one living context and a series of meetings (M1, M2, …). M1 sets the context up; each later one
proposes a change to it, like a PR for the mental model. The panel reads only the context, the meetings log
(`.signals/meetings.md`) and the meeting it is in: never older transcripts, and a PRD only when you name one.
Every call is logged: a kill at once, with your reason, and a commit when you approve its context. One meeting
is active at a time, and only the latest can be resumed; older ones are read only. PRDs are grouped by the
meeting whose change they build.

## How it works

```
 Browser  ◀──▶  Daemon (localhost:3461)  ◀── jobs / replies ──▶  Worker per repo (/signals in Claude Code)
```

The daemon derives one job at a time per repo from the idea's state: **panel** (you spoke last), **distill**
(you committed or approved), **prd** (you asked for PRDs), **refine** (you asked for a change). **Execute** runs
the PRD in a background Claude Code session on your checkout (`claude --bg`; steer it with `claude attach <id>`),
and its final reply is saved to the PRD as an **Execution summary**.

```bash
signals status          # registered repos, and whether a worker is listening
signals remove [repo]   # unregister (.signals/ stays)
signals restart         # reload server.js; repos and workers reconnect
signals stop            # stop the daemon
```

**Make it yours:** the house style lives in the skill. Edit `references/panel.md` (how the panel talks),
`references/distill/` (how context is written) and `references/prd.md` (how work is cut).

## Not yet

Driving executors directly (GitHub issues, PR watching), answering the worker's questions in place, and drift
detection.
