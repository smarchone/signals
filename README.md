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
| `/org panel <topic>` | discuss; CEO, PM and Architect debate, grounded in the store, and agreed points become drafts |
| `/org update` | batch-review executive decisions from the conversation so far |
| `/org update <decision>` | propose one decision (interactive) |
| `/org drift [partition]` | check decisions against the code |

## Install

1. Copy `skills/org` to wherever your agent loads skills from. For Claude Code, per project (or `~/.claude/skills/` for all projects):
   ```sh
   mkdir -p <your-project>/.claude/skills
   cp -r skills/org <your-project>/.claude/skills/
   ```
   Other agents: point them at `skills/org/SKILL.md` (e.g. reference it from `AGENTS.md`).
2. Create an empty store in your project:
   ```sh
   cd <your-project>
   mkdir -p .decisions/pm .decisions/arch .decisions/session
   printf '# Partition map\n\nCEO sits above PM and Architect. PM and Architect are peers.\n\n| Partition | Role | Owns |\n|---|---|---|\n| `ceo` | CEO | mission, audience, non-goals, budget, big bets |\n' > .decisions/map.md
   printf '# CEO\n' > .decisions/ceo.md
   ```
3. Start Claude Code in the project and run `/org ctx "<your first task>"`. Commit `.decisions/` to git.

## Try it here

Start Claude Code inside `test/` and follow `test/TEST.md`. The skill is symlinked in, and `test/.decisions/` is an example seed — not something to copy into a real project.

## Files

| File | What |
|---|---|
| `skills/org/SKILL.md` | the skill (agent-agnostic) |
| `model.md` | how the system works, with a mock session |
| `principles.md` | why it is designed this way |
| `test/TEST.md` | test script and pass criteria |
| `test/.decisions/` | example decision store |
| `test/src/auth/session.ts` | fixture with a planted drift |
| `test/.claude/skills/org` | symlink → `skills/org` (Claude Code) |
| `test/.agents/skills/org` | symlink → `skills/org` (other agents) |

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Copyright 2026 Saikumar Chintada. See [NOTICE](NOTICE).

You may use, modify and redistribute this skill, including commercially. Redistributions must keep the LICENSE and NOTICE files and state any significant changes you made. The software is provided "as is", without warranty.
