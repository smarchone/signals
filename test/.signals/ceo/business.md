# CEO · business

## Brief
- problem: team tools assume an IT department that small teams don't have (ceo/business#audience-smb)
- for whom: small teams of 2–20 with no dedicated IT staff (ceo/business#audience-smb)
- why this wins: fully self-serve, no sales call, no admin setup (ceo/business#audience-smb)
- non-goals: enterprise SSO/compliance; spending past $200/month before $5k MRR (ceo/business#audience-smb, ceo/business#infra-budget)

## Decisions

## audience-smb
For small teams (2–20) without dedicated IT staff. They sign up and start on their own: no sales call, no admin setup. Admin features stay minimal; no SAML/SCIM for now.
- why: underserved, existing tools target enterprises with IT; self-serve grows without a sales force
- not: enterprise (long sales cycles, SSO/compliance we can't staff) · consumers (low willingness to pay for team tools)
- revisit: >30% of signups from companies over 50 people, or an enterprise deal is on the table
- serves: — · code: — · by: dev · 2026-11-01

## infra-budget
Total infrastructure and third-party cost ≤ $200/month until revenue passes $5k MRR. Prefer self-hosted or free tiers over paid SaaS; any paid vendor above ~$50/month needs a CEO decision.
- why: bootstrapped, infra is paid from revenue; forces an architecture one developer can run
- not: spend freely to move faster (runway risk with no revenue yet)
- revisit: MRR passes $5k, or one vendor would save more than a week of work per month
- serves: — · code: — · by: dev · 2026-11-01
