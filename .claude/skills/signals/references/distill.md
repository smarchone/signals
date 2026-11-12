# Distilling context files

The meeting produced a shared mental model. Distill it into five context files. Coding agents load these before
they implement anything, and humans review them instead of code. Every sentence should remove a guess an agent
would otherwise make.

## Principles

- **Derived, not invented.** Everything traces to the meeting. Where the meeting left a gap that an implementer
  would trip on, make a clear, opinionated default and mark it `(assumed)` so the reviewer sees it.
- **Opinionated.** State decisions, not options. "We do X" rather than "we could do X or Y".
- **Stable IDs.** Vocab terms, domains, abstractions and contracts get IDs (`vocab:Idea`, `domain:meeting`,
  `abs:JobQueue`, `contract:idea.v1`). Files reference each other by ID, never by paraphrase.
- **Scannable.** Short sections, tables and lists. A reviewer should get each file in under a minute.
- **No plans.** No milestones, PRDs, tasks or estimates. Those belong to the plan layer, which builds on these.

Every file starts with the same header:

```
# <Kind>: <Idea title>

> <one-line summary of this file>
```

## product.md: what it is and how it feels

1. **One-liner**: the product in one sentence.
2. **For whom**: the primary user and the pain, concretely.
3. **Core loop**: the key interaction as numbered steps (a small ascii diagram is welcome).
4. **Feel**: three to five principles for how it should feel to use.
5. **The moment**: the single moment where the user feels the payoff.
6. **Non-goals**: what it deliberately is not.
7. **Open questions**: what the meeting left unresolved.

## business.md: why it wins

1. **Problem and alternatives**: what people do today and why it falls short.
2. **Positioning**: one sentence against the nearest alternatives.
3. **Wedge**: how it gets its first users.
4. **Moat**: what compounds with usage. Be honest about what isn't a moat yet.
5. **Risks**: the top three, each with the signal that would show it's real.

## vocab.md: the ubiquitous language

A table, one row per term, alphabetical:

| ID | Term | Meaning | Not to be confused with |
|----|------|---------|-------------------------|
| `vocab:Idea` | Idea | ... | ... |

Then **Banned synonyms**: words agents must not use for these concepts (for example "task" when we mean
"Job"). Code, UI copy and docs use these exact terms.

## architecture.md: the shape of the system

1. **System sketch**: an ascii diagram of the main parts and how data flows.
2. **Domains**: a table of `domain:<name>` IDs, what each owns, and the vocab terms it owns.
3. **Boundaries and adapters**: the outside world (storage, APIs, executors) and the adapter that isolates each.
   Ports and adapters (hexagonal) by default: domains never import adapters.
4. **Hard constraints**: the system realities the Architect raised, as rules.
5. **Decisions**: key choices as `ADR-n: <decision>. Because <reason>.`

## abstractions.md: the contracts implementers code against

The core abstractions, each as:

```
### abs:<Name>  (domain:<owner>)
<one-line purpose>
- Responsibilities: ...
- Invariants: ... (what must always be true)
- Interface: (a short typed sketch, TypeScript-style, signatures only, no bodies)
```

Then **Data contracts**: the shapes crossing boundaries, as `contract:<name>.v1` with fields and types. Keep
these to what the first implementation needs; an abstraction no one would code against this month doesn't
belong.
