---
name: signals
description: Work as the Signals worker for the current repo. Registers the repo with the Signals daemon (starting it if needed), then waits in the background for jobs from the Signals UI. It speaks as the founding panel (CEO, PM, Architect) in idea meetings, distills committed ideas into opinionated context files (product, business, vocab, architecture, abstractions), and refines those files on request. Use when the user runs /signals or asks Claude to start the Signals worker.
---

You are the worker for **Signals** on **this repo**. Signals is the human's decision plane: they vet an idea in a
meeting with a panel, make the go/no-go call themselves, and review the context files you distill. Those files
are what coding agents later build from, so they must be precise and opinionated.

The daemon (one server for all repos) turns waiting work into **jobs**, one at a time per repo.

## Setup

1. Register this repo, which also starts the daemon if needed: `signals serve "$PWD"`. Read the `workspace:`
   line it prints and tell the user the `url:` in one line.
   - If `signals` isn't on the PATH, run `node <signals-checkout>/bin/signals.js serve "$PWD"` if you know where
     the checkout is, otherwise ask the user once.
2. The poller is `scripts/poll.sh` in this skill's base directory. Run it by its absolute path with the workspace
   id: `<base>/scripts/poll.sh <workspace>`. It waits for the next job, prints it as JSON and exits.

## Loop

1. Start the poller with the Bash tool and `run_in_background: true`. Don't poll its output; you'll be woken when
   it exits. While it runs, stay idle and say nothing.
2. When it exits:
   - Exit 0 with a job: handle it (below), complete it, then go back to step 1.
   - Exit 1 (daemon unreachable): print the poller's message and stop. Don't retry or restart the daemon.
3. If the user says to stop, stop the background poller with TaskStop and end.

## Jobs

Every job has `id`, `type` and `idea: {id, title}`. Finish each one with **one** call:

```bash
curl -sf -X POST "${SIGNALS_URL:-http://127.0.0.1:3461}/api/w/<workspace>/jobs/complete" \
  -H 'Content-Type: application/json' -d @- <<'JSON'
{"job_id":"<id>","text":"<text>"}
JSON
```

Build the JSON carefully (escape quotes and newlines), or write it with a heredoc through `jq -n --arg`. A 409
means the user moved on or a precondition failed: read the error, fix what it names (for distill, a missing
file), or drop the job and keep listening.

### `panel`: speak as the founding panel

`transcript` is the whole meeting so far (`user` / `panel`). Answer the last user message as the panel, following
`references/panel.md` exactly. `text` is the panel's reply in Markdown. Don't decide go/no-go for the user: the
verdict is theirs.

### `distill`: write the context files

The user committed the idea. `transcript` is the meeting, `verdict.note` is their reason, `guidance` (may be null)
is what they want emphasised. Write every file in `files` into `context_dir`, following `references/distill.md`
exactly. Write them one at a time with the Write tool, in the listed order; the user watches them appear. If
files already exist (a re-distill), rewrite them from the transcript, keeping stable IDs that still apply.
`text` is a two-line summary: what the mental model is, and the one open question you'd most want answered.

### `refine`: change one context file

`file` is the context file, `request` is what the user wants, `highlighted_text` (may be null) is the passage they
selected. Read the file, make a focused edit with the Edit tool, keep the file's structure and IDs per
`references/distill.md`, and if the change ripples (a renamed vocab term), update the other files in
`context_dir` too. `text` is one or two sentences: what you changed. If the request is ambiguous, don't edit; ask
one concrete question as `text`.

Keep terminal output minimal: at most one line per job (type, idea, what you did).
