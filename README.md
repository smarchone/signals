# org

A Claude Code skill that keeps the **executive decisions** of a project (CEO, PM, Architect) in markdown files, so they survive across sessions and drive planning, building and steering.

- Each decision is owned by one role and lives in one small partition (`pm/onboarding`, `arch/auth`, …).
- The coding agent asks the store before choosing and proposes new executive decisions while it works.
- You approve every executive decision and resolve every conflict. Details are left to the agent and never stored.
- Plans are reviewed in a batch; build and steer decisions are reviewed interactively.

## Commands

| Command | Does |
|---|---|
| `/org ctx <task>` | load the decisions relevant to a task |
| `/org <question>` | ask; the owning roles answer from the store |
| `/org update` | batch-review executive decisions from the conversation so far |
| `/org update <decision>` | propose one decision (interactive) |
| `/org drift [partition]` | check decisions against the code |

## Install

1. Copy the skill into your project (or into `~/.claude/skills/` for all projects):
   ```sh
   mkdir -p <your-project>/.claude/skills
   cp -r .claude/skills/org <your-project>/.claude/skills/
   ```
2. Create an empty store in your project:
   ```sh
   cd <your-project>
   mkdir -p .decisions/pm .decisions/arch .decisions/session
   printf '# Partition map\n\nCEO sits above PM and Architect. PM and Architect are peers.\n\n| Partition | Role | Owns |\n|---|---|---|\n| `ceo` | CEO | mission, audience, non-goals, budget, big bets |\n' > .decisions/map.md
   printf '# CEO\n' > .decisions/ceo.md
   ```
3. Start Claude Code in the project and run `/org ctx "<your first task>"`. Commit `.decisions/` to git.

The `.decisions/` folder in this repo is an example seed for testing, not something to copy into a real project.

## Try it here

Start Claude Code inside this folder and follow `TEST.md`. To reset between runs, first run `git init && git add -A && git commit -m seed`, then restore `.decisions/` from git.

## Files

| File | What |
|---|---|
| `.claude/skills/org/SKILL.md` | the skill |
| `.decisions/` | example decision store |
| `src/auth/session.ts` | fixture with a planted drift |
| `model.md` | how the system works, with a mock session |
| `principles.md` | why it is designed this way |
| `TEST.md` | test script and pass criteria |
