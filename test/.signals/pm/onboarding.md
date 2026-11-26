# PM · onboarding
> signup, login, invites, first-run experience

## email-signup-v1
v1: sign up and log in with email and password only. No social or SSO login in v1; social login is a separate post-v1 decision.
- why: ships fast, no third-party app review; every SMB user has an email (ceo/business#audience-smb)
- not: Google login in v1 (OAuth verification delay, extra flows to test) · magic links only (needs email deliverability we haven't set up)
- revisit: v1 ships, or >20% of signup drop-off is at the password step
- serves: ceo/business#audience-smb · code: src/auth/**, src/pages/signup* · by: agent · 2026-11-10

## signup-2-screens
At most 2 screens from landing to a usable workspace: (1) email + password, (2) workspace name. Email verification is async after login and never blocks reaching the workspace. A new signup step must replace an existing one.
- why: self-serve users without IT abandon long signups (ceo/business#audience-smb)
- not: team size / role during signup (no sales team to use it) · blocking verification (extra screen, inbox context switch)
- revisit: sales needs qualification data, or unverified-account abuse appears
- serves: ceo/business#audience-smb · code: src/pages/signup* · by: dev · 2026-11-10
