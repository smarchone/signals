# Distilling: rules for every file

## Purpose

Signals is the human's operating plane for building with coding agents. Every file serves it:

- **Review friendly.** The human reviews and steers; their attention is the scarce resource.
- **Just enough abstractions** for the human to keep in mind and drive the project with.
- **Product and business first.** The idea is iterated at that level before anything technical.
- **Good enough signal for the coding agent.** Point a direction; don't elaborate. The agent is a capable
  LLM with the autonomy to make local decisions, and those are reviewed at PR time.

Distill the meeting into context files, high level first: the human confirms the shape before anything builds
on it.

| Stage (`step`) | Writes, in order | The human reviews… |
|----------------|------------------|--------------------|
| 1 · Brief (`brief`) | `business.md`, `product.md`, `model.md` | why it wins, what it is, the core abstractions |
| 2 · Design (`design`) | `vocab.md`, `architecture.md` | the exact terms, and the system's shape |

Each stage has its own spec (`brief.md`, `design.md`) and ends at one review gate. Build on the `approved`
files and never contradict them. If `guidance` is set, follow it.

## Content

- **Derived, not invented.** Everything traces to the meeting and the approved files. Fill a gap only where
  a wrong guess would be costly to undo, and mark that default `(assumed)` where it applies; leave other gaps
  to the implementer's judgement.
- **Curate, don't enumerate.** Include what the reviewer or the coding agent would get wrong or have to guess
  without it. Leave out what an implementer derives on their own (states, fields, sub-variants, obvious
  steps). Being elaborate is noise too.
- **Guide, don't instruct.** The implementer is a capable LLM: give intent, boundaries and reasons, not
  mechanisms. Say what must be true ("the same Daily case for everyone, no server"), never the formula, key,
  file layout, schema or algorithm.
- **Opinionated.** State choices, not options.
- **No plans.** Milestones, tasks, constraints and decision logs belong to the PRDs (`../prd.md`), cut from
  this context once it is approved.

## Attention budget

Every sentence costs the reviewer attention and must earn it. A cluttered file has failed, however correct.

- **Say it once.** No file restates another; point to it instead.
- **Few items, ranked.** At most five or six per list, most important first.
- **Short.** Bullets of one or two lines; table cells are phrases.
- **Lengths.** Business and product under 400 words, model under 600, architecture about 300, vocab only its
  tables.
- **Vocabulary terms.** The brief introduces terms in **bold**. `vocab.md` defines them in **bold**, with no
  markers. Files after it mark terms as `vocab:` plus the term in PascalCase (Expert chain is
  `vocab:ExpertChain`, Set-aside is `vocab:SetAside`), except under a column header that already says the cell
  is vocabulary. `domain:` and `abs:` labels belong only in tables and diagrams.

Every file starts with:

```
# <Kind>: <Idea title>

> <one-line summary of this file>
```
