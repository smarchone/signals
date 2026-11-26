# Architect · stack

## typescript-express

**What**
The backend is TypeScript (strict mode) running on Node.js LTS, with Express as the HTTP
framework. All application code lives under `src/**` and compiles from TypeScript; no
plain-JS application modules.

**Why**
- One developer runs the system (ceo#infra-budget): one language across backend and frontend tooling.
- Express and Node are free and run on the smallest hosting tier (ceo#infra-budget).
- Express serves the httpOnly session cookie that arch/auth#server-sessions requires.
- Matches existing code in src/auth/session.ts.

**Why not**
- Python/Django — productive, but likely two languages once the frontend is JS.
- Go — fast and cheap to run, but slower iteration for a solo developer.
- NestJS — more framework structure than a small app needs.

**Implications**
- arch/auth#server-sessions is implemented as Express middleware and cookie handling.
- Postgres access (arch/data#postgres) uses a Node/TypeScript client; the library choice is a detail.
- Frontend language/framework and hosting remain undecided.

**Revisit when**
Request load makes Express a measured bottleneck, or a framework offers something we need
(e.g. built-in schema validation) that Express would require significant work to match.

**Serves**   ceo#infra-budget · arch/data#postgres
**Scope**    arch/stack · code: src/**, package.json, tsconfig.json
**By**       agent-proposed · dev-approved · 2026-11-26
**Context**  Session "tech stack brief", plan. Formalized the TypeScript/Express already used in src/auth/session.ts.
