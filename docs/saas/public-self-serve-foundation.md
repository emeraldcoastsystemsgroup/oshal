# Public Self-Serve SaaS Foundation

Prepared: 2026-06-23

Status: first implementation foundation. Public signup, billing checkout, hosted managed operations, and onboarding email lifecycle remain open.

## What Exists Now

| Capability | Evidence | Status |
|---|---|---|
| Plan catalog | `src/features/saas/plans.ts` | Built and unit-tested. |
| Quota decision helper | `evaluatePlanLimits` | Built and unit-tested. |
| Tenant bootstrap API | `src/app/routes/tenant-routes.ts` | Authenticated user can create a tenant/space and become admin. |
| First-run proof | `docs/evidence/first-run-clean-account-2026-06-23.md` | Live proof exists. |
| Hosted design-partner path | `docs/evidence/hosted-enough-2026-06-22.md` | Design-partner proof exists, not public SaaS scale. |

## Plan Catalog

The first catalog includes:

- Free
- Home AI Pro
- Team
- Enterprise Pilot

Each plan defines:

- seats
- connector limit
- monthly task limit
- monthly token budget
- hosted/support posture

## Public Signup Still Required

The product still needs:

- public account creation through the IdP
- email verification
- tenant bootstrap after first login
- first admin setup
- invite flow
- passwordless or SSO choice depending on deployment

## Billing Still Required

The product still needs:

- Stripe or invoice checkout
- subscription status
- payment failure handling
- plan upgrade/downgrade
- hosted quota enforcement
- admin-visible usage and budget alerts

## Managed Hosting Still Required

The product still needs:

- managed Postgres profile
- Redis/queue managed profile
- worker scaling/capacity profile
- migration and rollback proof
- production monitoring and alerting
- public status communication

## Procurement Answer

OSHAL now has a tested plan/quota foundation and authenticated tenant bootstrap API. It is still not public self-serve SaaS until signup, billing, managed hosting, monitoring, and lifecycle messaging are productized.
