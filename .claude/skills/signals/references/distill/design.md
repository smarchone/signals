# Stage 2 · Design (`design`)

`vocab.md`, then `architecture.md`, which uses its terms. `model.md` is approved: don't touch it or add detail
to its shape. Follow `common.md` too.

## vocab.md: the vocabulary

The exact terms that code, UI copy and docs use: a curated set of 10 to 15, not a dictionary. A term earns a
row only if a reviewer needs to agree on it:

- a core abstraction, or a term `model.md` introduced;
- a word that reaches the user (UI copy);
- a word where the wrong choice would mislead (a Commit is not a Submit).

Leave out what an implementer names on their own (states, sub-variants, fields, minor features); if one
matters, mention it inside the meaning it belongs to ("…open until the Commit, immutable after it").

```
# Vocab: <Idea title>

> The exact terms that code, UI copy and docs use for this product, grouped by the domain that owns them.

## play

> A **Trainee** works a **Case** by drawing **Link**s and **Set-aside**s into an **Attempt**, which the
> **Commit** locks.

| Term | Meaning | Not to be confused with |
|------|---------|-------------------------|
| **Attempt** | One **Trainee**'s play of one **Case**, made of **Link**s, open until the **Commit** and immutable after it. | A session (an Attempt spans visits) |
| … | | |

## <next domain>

…

## Banned synonyms

| Don't say | Say |
|-----------|-----|
| question, puzzle, level | **Case** |
| … | |
```

- **Domains**: two to four `## <domain>` sections (short lowercase names) in core-loop order, each opening
  with one or two sentences that explain the domain using its own terms (in **bold**), then a table
  alphabetical by term. Every term belongs to exactly one domain. This is where domains are defined;
  architecture reuses the names.
- **Meaning**: one sentence, two at most, clear enough that an agent can't misread the term, including the
  rule that matters ("exactly one is true"). Other terms in **bold**.
- **Not to be confused with**: only for a real risk of confusion; otherwise `—`.
- **Banned synonyms**: about ten rows at most, the words people will actually reach for, each mapped to the
  **term** to use. Note a context when the ban is partial ("(in UI copy)").

## architecture.md: the system's shape

An **initial direction** for the implementer, not a decision log: how the product is composed from its
domains, what each owns, and where the seams are. It will evolve with the code. Technical only: product choices are the brief's, and where
the design depends on one the brief left open, keep it open and say so in one line. Name kinds, not mechanics
("browser storage", not how it is keyed). About 300 words, in exactly these sections:

1. **Composition**: two or three sentences explaining the product as its domains composed along the core
   loop, in core vocabulary ("`casebook` serves the `vocab:DailyCase`; `play` holds the `vocab:Attempt` until
   the `vocab:Commit`; `review` turns it into a `vocab:Reveal`"). The reader should get the whole system from
   this paragraph alone.
2. **System sketch**: one hexagonal (ports and adapters) ascii diagram, within about 110 columns, that traces
   the core loop. Inside: the domains with their key state and labelled flows (`commit`), ending in what the
   loop produces. On the edge: ports as `○ Name`. Outside: one adapter per port, named by its kind of
   technology; driving adapters (what calls in, like the UI) on the left, driven adapters (what the app calls
   out to, like storage) on the right. Then one line on the overall shape ("browser-only, no server").

   ```
   driving adapters                            domains                          driven adapters

                              _______________________________________________
                             /                                               \
        [board UI] ──► Play ○     casebook ──daily case──► play               \
                           /      (Cases)                 (Attempt: Links,     ○ CaseSource ──► [bundled JSON files]
                          /          │                     Set-asides, Commit)  \
                         /           │ expert chain            │ commit          \
                         \           └──────────────► review ◄─┘                 /
   [reveal UI] ◄── Reveal ○                         (Diff, Score)               ○ AttemptStore ──► [browser storage]
                           \                                                   /
                            \                                                 /
                             \_______________________________________________/
   ```

3. **Domains**: a Domain | Owns table, with the names and order from `vocab.md`. Owns: one or two sentences
   on what the domain is responsible for and the rule it enforces ("Enforces that a Commit locks the
   Attempt"). Don't list its terms.
4. **Ports and adapters**: an Outside world | Port | Adapter (v1) table. Ports named plainly with their owning
   domain (`CaseSource (casebook)`); adapters by kind of technology, defaults marked `(assumed)`. Then one or
   two sentences: domains never import adapters, and who wires them.

No constraints, decisions or ADRs: those belong to PRDs.
