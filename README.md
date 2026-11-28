# signals

An agent skill that keeps the **executive decisions** of a project (CEO, PM, Architect) in markdown files, so they survive across sessions and drive planning, building and steering.

- Role-owned decisions (CEO, PM, Architect) in small partitions
- Agent checks the store before making a choice
- Agent-proposed, human-approved decisions
- Conflicts surfaced, never auto-resolved
- Batch review for plans, interactive review while building

Why: [Steer decisions, not prompts](https://smarchone.github.io/signals/blog.html).

## Install

```sh
npx skills add smarchone/signals -g
```

## Usage

**Ask questions.** The roles answer from stored decisions, with citations, or say Undecided:

```
/signals why server sessions and not JWT?
```

**Make decisions.** State one, or let the agent propose one while it builds:

```
/signals update "sessions expire after 30 days idle"
```

Executive decisions are gated: nothing lands in the store until you approve it, and the agent pauses work that depends on it until you do.

**Update decisions.** The coding agent may have made executive choices of its own while building. Once the build is done, collect them in one review:

```
/signals update
```

You approve, drop or reword each one. If one contradicts a stored decision, it comes back as a conflict for you to resolve.

### All commands - Examples

```
/signals why server sessions and not JWT?
/signals ctx "add Google login"
/signals panel "inviting teammates"
/signals update "sessions expire after 30 days idle"
/signals update
/signals drift arch/auth
/signals explain auth
```

The agent also calls `/signals` on its own while building, whenever it is about to make an executive choice.

## Try it here

Start your agent inside `test/` and follow `test/TEST.md`. The skill is symlinked in, and `test/.signals/` is an example seed — not something to copy into a real project.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Copyright 2026 Saikumar Chintada. See [NOTICE](NOTICE).

You may use, modify and redistribute this skill, including commercially. Redistributions and derivative works must keep the LICENSE and NOTICE files, keep attribution to the original author, and state any significant changes you made. The software is provided "as is", without warranty.
