# Architect · architecture

## Brief
- shape:
  ```
  browser ── httpOnly session cookie ── Express (TypeScript) ── Postgres (only datastore)
  ```
  (arch/architecture#typescript-express, arch/architecture#single-datastore)
- hard lines: Postgres is the only datastore (arch/architecture#single-datastore) · no user data in cookies or client storage (arch/auth#server-sessions) · infra ≤ $200/month (ceo/business#infra-budget)

## Decisions

## typescript-express
Backend is TypeScript (strict) on Node.js LTS with Express. All application code lives under `src/**` and compiles from TypeScript; no plain-JS application modules. Frontend framework and hosting are still open.
- why: one language for a solo developer; free and runs on the smallest tier (ceo/business#infra-budget); serves the httpOnly cookie arch/auth#server-sessions needs; matches existing src/auth/session.ts
- not: Python/Django (two languages once the frontend is JS) · Go (slower iteration solo) · NestJS (more structure than a small app needs)
- revisit: Express becomes a measured bottleneck, or a framework offers something costly to match
- serves: ceo/business#infra-budget · arch/architecture#postgres · code: src/**, package.json, tsconfig.json · by: agent · 2026-11-26

## postgres
Managed Postgres, smallest tier (~$15/month), is the system of record for all data: users, workspaces, sessions, domain data. Schema changes go through migrations in the repo.
- why: relational data (users ↔ workspaces ↔ items) with joins and transactions; fits ceo/business#infra-budget
- not: SQLite (single writer, awkward with a second instance) · MongoDB (no need for documents, weaker joins)
- revisit: data passes 100 GB, or a workload needs what Postgres can't do within budget
- serves: ceo/business#infra-budget · code: src/db/**, migrations/** · by: agent · 2026-11-01

## single-datastore
Postgres is the only datastore: no Redis, Elasticsearch or separate queue service. Caching, background jobs and search use Postgres (tables, `LISTEN/NOTIFY`, full-text search). Any new datastore needs this decision changed.
- why: every extra service adds cost (ceo/business#infra-budget); one developer operates the system
- not: Redis for sessions/cache (second service to run and pay for) · hosted queue like SQS (another vendor and failure mode for low volume)
- revisit: a Postgres-based cache, queue or search becomes a measured bottleneck
- serves: ceo/business#infra-budget · arch/architecture#postgres · code: src/** · by: agent · 2026-11-01
