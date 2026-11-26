# Testing the org skill

Start your agent inside `test/`. `test/.claude/skills/org` (Claude Code) and `test/.agents/skills/org` (other agents) are symlinks to `../skills/org`, so edits to the skill are picked up directly. Run the steps in order.

## Seed state

7 decisions: `ceo#audience-smb`, `ceo#infra-budget`, `pm/onboarding#email-signup-v1`,
`pm/onboarding#signup-2-screens`, `arch/auth#server-sessions`, `arch/data#postgres`,
`arch/data#single-datastore`.
`src/auth/session.ts` contains one planted drift: a client-readable cookie holding user data.

## Script

| # | Type | Expect |
|---|---|---|
| 1 | `/org ctx "add Google login"` | loads ceo + pm/onboarding + arch/auth (+ arch/data); flags `email-signup-v1` |
| 2 | `/org can we add Google login?` | PM says **Undecided** citing `email-signup-v1`; Arch cites `server-sessions`. No CEO line unless budget comes up |
| 3 | `/org why not Auth0?` | CEO or Arch cites `ceo#infra-budget`; offers raise budget vs self-host |
| 4 | say "self-host", then `/org update` | batch review: `pm/onboarding#google-signup`, an arch/auth OAuth decision; full records written after approval |
| 5 | "build it" (or pretend), agent decides session expiry | agent calls `/org update` on its own; 🔒 one-item review; work waits |
| 6 | `/org update "use passport.js for OAuth"` | `Not executive (...). Not stored, continue.` |
| 7 | `/org update "cache sessions in Redis"` | ⚠ conflict with `arch/data#single-datastore` (and `ceo#infra-budget`); forced a/b choice |
| 8 | steer: "if a Google email matches an existing account, link them" | agent calls `/org update` before acting; PM decision + linked arch/auth decision |
| 9 | `/org update` | nothing missed, or only items not yet reviewed |
| 10 | `/org go upmarket: target mid-size companies with SSO` | override panel: lists decisions that serve `ceo#audience-smb`; one all-or-nothing review |
| 11 | cancel the override | no file changes |
| 12 | `/org drift arch/auth` | ✗ `server-sessions` with `src/auth/session.ts:10`; offers fix code / amend |

## Pass criteria

1. Every role claim cites a decision or says **Undecided**.
2. Nothing is written to partition files without explicit approval.
3. Details are dropped, never stored.
4. Conflicts block and need a choice.
5. The override commits all or nothing.
6. Drift finds the planted mismatch with `file:line`.
7. Committed records fill every template field with real content.

Reset: `git checkout -- .decisions src && git clean -fd .decisions` (from `test/`).
