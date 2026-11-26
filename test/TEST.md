# Testing the signals skill

Start your agent inside `test/`. `test/.claude/skills/signals` (Claude Code) and `test/.agents/skills/signals` (other agents) are symlinks to `../skills/signals`, so edits to the skill are picked up directly. Run the steps in order.

## Seed state

8 decisions in the compact format: `ceo/business#audience-smb`, `ceo/business#infra-budget`,
`pm/onboarding#email-signup-v1`, `pm/onboarding#signup-2-screens`, `arch/auth#server-sessions`,
`arch/architecture#typescript-express`, `arch/architecture#postgres`, `arch/architecture#single-datastore`.
Default files: `vocab`, `ceo/business`, `pm/product`, `pm/ui`, `arch/architecture` (main files open with a brief).
Partitions beyond the defaults: `pm/onboarding`, `arch/auth`.
`src/auth/session.ts` contains one planted drift: a client-readable cookie holding user data.

## Script

| # | Type | Expect |
|---|---|---|
| 1 | `/signals ctx "add Google login"` | loads vocab + the three main files + pm/onboarding + arch/auth; flags `email-signup-v1` |
| 2 | `/signals can we add Google login?` | PM says **Undecided** citing `email-signup-v1`; Arch cites `server-sessions`. No CEO line unless budget comes up |
| 3 | `/signals why not Auth0?` | CEO or Arch cites `ceo/business#infra-budget`; offers raise budget vs self-host |
| 4 | say "self-host", then `/signals update` | batch review: `pm/onboarding#google-signup`, an arch/auth OAuth decision; compact records written after approval; brief lines that cite changed decisions updated |
| 5 | "build it" (or pretend), agent decides session expiry | agent calls `/signals update` on its own; 🔒 one-item review; work waits |
| 6 | `/signals update "use passport.js for OAuth"` | `Not executive (...). Not stored, continue.` |
| 7 | `/signals update "cache sessions in Redis"` | ⚠ conflict with `arch/architecture#single-datastore` (and `ceo/business#infra-budget`); forced a/b choice |
| 8 | steer: "if a Google email matches an existing account, link them" | agent calls `/signals update` before acting; PM decision + linked arch/auth decision |
| 9 | `/signals update` | nothing missed, or only items not yet reviewed |
| 10 | `/signals go upmarket: target mid-size companies with SSO` | override panel: lists decisions that serve `ceo/business#audience-smb`, plus brief lines citing it; one all-or-nothing review |
| 11 | cancel the override | no file changes |
| 12 | `/signals drift arch/auth` | ✗ `server-sessions` with `src/auth/session.ts:10`; offers fix code / amend |
| 13 | `/signals panel "inviting teammates"`, agree to 2 executive points over 2–3 turns | no files written and no per-decision review during the panel; **Your move** shows the 📝 draft count |
| 14 | "done with the panel" | one batch review of both drafts; written to `session/` then committed on approval; a new term (e.g. **Invite**) proposed for `vocab.md` |

## Pass criteria

1. Every role claim cites a decision or says **Undecided**.
2. Nothing is written to partition files without explicit approval.
3. Details are dropped, never stored.
4. Conflicts block and need a choice.
5. The override commits all or nothing.
6. Drift finds the planted mismatch with `file:line`.
7. Committed records use the compact template (what · why · not · revisit? · serves/code/by line) with real content.
8. Panels write nothing until they end; then one batch review.
9. Every brief line cites a decision; no brief contradicts one.

Reset: `git checkout -- .signals src && git clean -fd .signals` (from `test/`).
