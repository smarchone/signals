# signals

An agent skill that keeps the **executive decisions** of a project (CEO, PM, Architect) in markdown files, so they survive across sessions and drive planning, building and steering.

- Role-owned decisions (CEO, PM, Architect) in small partitions
- Agent checks the store before making a choice
- Agent-proposed, human-approved decisions
- Conflicts surfaced, never auto-resolved
- Batch review for plans, interactive review while building

## Usage

Say you're adding password reset. Before you start, get the decisions it touches:

```
/signals ctx "add password reset"
```

Midway, you wonder why login works the way it does:

```
/signals why server sessions and not JWT?
```

While building, you decide something the store should keep:

```
/signals update "sessions expire after 30 days idle"
```

When the plan or session is done, review everything it settled in one batch:

```
/signals update
```

## Install

```sh
npx skills add smarchone/signals -g
```

## Try it here

Start your agent inside `test/` and follow `test/TEST.md`. The skill is symlinked in, and `test/.decisions/` is an example seed — not something to copy into a real project.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Copyright 2026 Saikumar Chintada. See [NOTICE](NOTICE).

You may use, modify and redistribute this skill, including commercially. Redistributions and derivative works must keep the LICENSE and NOTICE files, keep attribution to the original author, and state any significant changes you made. The software is provided "as is", without warranty.
