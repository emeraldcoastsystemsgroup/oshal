# Enterprise Governance - Phases 1-4 Handoff

This closes the enterprise-governance gap called out against Microsoft, Salesforce, ServiceNow,
IBM, and UiPath: RBAC, tenant/broker policy, DLP, audit export, compliance posture, LLM budgets,
and DB-enforced RLS.

Most controls remain additive and off by default. RLS is the exception: the GUC-aware pool
wrapper is on by default, and as of 2026-06-27 (ADR-076) RLS DDL/enforcement is LIVE on the
`oshal-local` stack — platform-wide on 84 tables with the runtime on the non-superuser
`oshal_app` role (migration `060-platform-rls-tenancy.sql`). For a fresh deploy the rollout is
still operator-run via `docs/governance/RLS-RUNBOOK.md` + `app-role-provisioning.sql`.

## Verification

- `npm run typecheck` passes in the main tree.
- Governance and access-control unit tests cover the deny paths.
- Live RLS enforcement still requires the rollout in `docs/governance/RLS-RUNBOOK.md`
  and a passing `npm run verify:rls` result from the active Postgres profile.

## What Shipped

| Phase | What | Key files | Runtime posture |
|---|---|---|---|
| 0 | Audit export, posture, eval-wall, LLM-governance routes, per-ticket access audit | `server.ts`, `audit-export-routes.ts`, ticket chokepoint | `OSHAL_ACCESS_AUDIT` off |
| 1 | RLS identity stamping, app DB role provisioning, staged DDL applier, and two-user verifier | `shared/services/database/{guc-pool,request-identity}.ts`, `optional-postgres-pool.ts`, `scripts/governance/{provision-rls-app-role,apply-rls,backfill-owner-sub,verify-rls-isolation}.mjs` | GUC wrapper on; DDL gated; verifier built |
| 2 | RBAC from IdP claims plus `/whoami` and admin console | `rbac/claims.ts`, `rbac/policy.ts`, `/admin` page | `OSHAL_RBAC_ENFORCE` off |
| 3 | PDP, DLP, SIEM forwarding | `policy/decision.ts`, `dlp/redactor.ts`, `audit/forwarder.ts` | `OSHAL_POLICY_ENFORCE`, `OSHAL_DLP_MODE`, `OSHAL_AUDIT_FORWARD_URL` off |
| 4 | LLM gateway budgets and posture | governance routes, budget/gate services | `OSHAL_LLM_BUDGETS` off |

## Turning It On

```bash
OSHAL_ACCESS_AUDIT=on
OSHAL_AUDIT_FORWARD_URL=...
OSHAL_RBAC_ENFORCE=true
OSHAL_DLP_MODE=mask
OSHAL_POLICY_ENFORCE=true
OSHAL_LLM_BUDGETS=on
```

RLS order:

```bash
OSHAL_DB_ROLE_APPLY=apply OSHAL_APP_DB_ROLE=oshal_app OSHAL_APP_DB_PASSWORD='<strong-password>' npm run provision:rls-role
node scripts/governance/backfill-owner-sub.mjs
OSHAL_OWNER_BACKFILL=apply node scripts/governance/backfill-owner-sub.mjs
OSHAL_RLS_APPLY=apply-permissive node scripts/governance/apply-rls.mjs
OSHAL_RLS_VERIFY_STAGE=permissive npm run verify:rls
OSHAL_RLS_APPLY=apply-enforce node scripts/governance/apply-rls.mjs
npm run verify:rls
```

`OSHAL_DB_GUC` should stay unset/truthy. Set `OSHAL_DB_GUC=off` only as rollback after disabling
restrictive RLS.

## Follow-Ups

- RLS enforcement: apply and soak with real users; archive the enforced `verify:rls` JSON output.
- PDP wiring: thread `evaluatePolicy()` into the remaining broker chokepoints.
- Admin role assignment: still handled in Keycloak; the console reads effective roles.
- Playwright governance specs: run against the deployed authenticated surface.
