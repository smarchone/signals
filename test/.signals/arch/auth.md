# Architect · auth
> identity, sessions, credentials, OAuth

## server-sessions
Sessions live server-side in Postgres (`sessions` table). The browser holds only an opaque, httpOnly, secure cookie with the session id; no user data in the cookie or client storage. New clients (mobile, CLI) use cookie or token exchange, never stateless tokens. Session expiry is still open.
- why: instant revocation for SMB admins (ceo/business#audience-smb); Postgres is already the datastore (arch/architecture#single-datastore); <1k concurrent users makes a lookup per request cheap
- not: JWT (revocation needs a denylist, a session store anyway) · Redis (second datastore, breaks arch/architecture#single-datastore) · Auth0 (~$240/month breaks ceo/business#infra-budget)
- revisit: concurrent users pass 50k, or a mobile app enters scope
- serves: ceo/business#audience-smb · arch/architecture#postgres · code: src/auth/** · by: agent · 2026-11-20
