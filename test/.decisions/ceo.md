# CEO

## audience-smb

**What**
The product is for small teams (2–20 people) without dedicated IT staff. They sign up and
start on their own, with no sales call and no admin setup.

**Why**
- Underserved segment: existing tools target enterprises with IT departments.
- Short sales cycle: self-serve lets a two-person team grow without a sales force.

**Why not**
- Enterprise — long sales cycles, SSO/compliance demands we can't staff yet.
- Consumers — low willingness to pay for team tools.

**Implications**
- Onboarding must be self-serve and fast (→ pm/onboarding#signup-2-screens).
- Admin features stay minimal; no SAML/SCIM for now.

**Revisit when**
More than 30% of signups come from companies over 50 people, or an enterprise deal is on the table.

**Serves**   —
**Scope**    ceo · code: —
**By**       dev · dev-approved · 2026-11-01
**Context**  Session "project kickoff", plan. Chosen over enterprise after a discussion on sales capacity.

## infra-budget

**What**
Total infrastructure and third-party service cost stays at or under $200/month until revenue
passes $5k MRR.

**Why**
- Bootstrapped: no funding, infra is paid from revenue.
- Forces simple architecture that one developer can run.

**Why not**
- Spend freely to move faster — runway risk with no revenue yet.

**Implications**
- Prefer self-hosted or free-tier services over paid SaaS (→ arch/data#single-datastore).
- Any paid vendor above ~$50/month needs a CEO decision.

**Revisit when**
MRR passes $5k, or a single vendor would save more than a week of work per month.

**Serves**   —
**Scope**    ceo · code: —
**By**       dev · dev-approved · 2026-11-01
**Context**  Session "project kickoff", plan.
