# PM · onboarding

## email-signup-v1

**What**
For v1, users sign up and log in with email and password only. No social or SSO login in v1.

**Why**
- Ship v1 fast: email+password needs no third-party app review.
- Fits ceo#audience-smb: every user has an email address.

**Why not**
- Google login in v1 — OAuth app verification delay, extra flows to test.
- Magic links only — depends on email deliverability we haven't set up.

**Implications**
- arch/auth must hash and store passwords (→ arch/auth#server-sessions handles login state).
- Social login is a post-v1 decision; this decision does not cover it.

**Revisit when**
v1 ships, or more than 20% of signup drop-off is at the password step.

**Serves**   ceo#audience-smb
**Scope**    pm/onboarding · code: src/auth/**, src/pages/signup*
**By**       agent-proposed · dev-approved · 2026-11-10
**Context**  Session "v1 scope", plan. Google login deferred to keep v1 to one week.

## signup-2-screens

**What**
Signup takes at most 2 screens from landing page to a usable workspace: (1) email + password,
(2) workspace name. Email verification must not block reaching the workspace.

**Why**
- ceo#audience-smb: self-serve users without IT abandon long signups.

**Why not**
- Collect team size / role during signup — useful for sales, but we have no sales team.
- Block on email verification — adds a screen and a context switch to the inbox.

**Implications**
- Email verification happens asynchronously after login.
- Any new signup step needs to replace an existing one or change this decision.

**Revisit when**
We need qualification data for sales, or abuse from unverified accounts becomes a problem.

**Serves**   ceo#audience-smb
**Scope**    pm/onboarding · code: src/pages/signup*
**By**       dev · dev-approved · 2026-11-10
**Context**  Session "v1 scope", plan.
