# Architect · data

## postgres

**What**
Postgres (managed, smallest tier) is the system of record for all application data:
users, workspaces, sessions, and domain data.

**Why**
- Relational data (users ↔ workspaces ↔ items) with joins and transactions.
- Managed small tier fits ceo#infra-budget (~$15/month).

**Why not**
- SQLite — single writer; awkward once a second app instance runs.
- MongoDB — no strong need for documents; weaker joins.

**Implications**
- Schema changes go through migrations in the repo.
- Search, queues and caches must use Postgres features first (→ #single-datastore).

**Revisit when**
Data passes 100 GB, or a workload needs something Postgres can't do within budget.

**Serves**   ceo#infra-budget
**Scope**    arch/data · code: src/db/**, migrations/**
**By**       agent-proposed · dev-approved · 2026-11-01
**Context**  Session "project kickoff", plan.

## single-datastore

**What**
Postgres is the only datastore. No Redis, Elasticsearch, or separate queue service. Caching,
background jobs, and search use Postgres (tables, `LISTEN/NOTIFY`, full-text search).

**Why**
- ceo#infra-budget: every extra service adds cost.
- One developer operates the system; fewer moving parts.

**Why not**
- Redis for sessions/cache — faster, but a second service to run and pay for.
- Hosted queue (SQS etc.) — another vendor and failure mode for low job volume.

**Implications**
- arch/auth#server-sessions stores sessions in Postgres.
- Adding any new datastore needs this decision to change.

**Revisit when**
A Postgres-based cache, queue or search becomes a measured bottleneck.

**Serves**   ceo#infra-budget · arch/data#postgres
**Scope**    arch/data · code: src/**
**By**       agent-proposed · dev-approved · 2026-11-01
**Context**  Session "project kickoff", plan.
