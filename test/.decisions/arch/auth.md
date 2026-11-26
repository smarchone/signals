# Architect · auth

## server-sessions

**What**
Sessions are stored server-side in Postgres (`sessions` table). The browser holds only an
opaque, httpOnly, secure cookie containing the session id. No user data in the cookie or in
client storage.

**Why**
- Instant revocation: SMB admins must be able to remove a user immediately (ceo#audience-smb).
- Postgres is already the only datastore (arch/data#postgres); no new infrastructure.
- Low load (< 1k concurrent users) makes a session lookup per request cheap.

**Why not**
- JWT — revocation needs a denylist, which is a session store anyway, with more moving parts.
- Redis — faster, but a second datastore breaks arch/data#single-datastore and adds cost.
- Hosted auth (Auth0) — ~$240/month breaks ceo#infra-budget.

**Implications**
- Any new client (mobile, CLI) must use cookie or token exchange, not stateless tokens.
- The sessions table grows with users; an expiry policy is needed (undecided).

**Revisit when**
Concurrent users pass 50k, or a mobile app enters scope.

**Serves**   ceo#audience-smb · arch/data#postgres
**Scope**    arch/auth · code: src/auth/**
**By**       agent-proposed · dev-approved · 2026-11-20
**Context**  Session "add login", plan. Dev rejected JWT after a discussion on revocation.
