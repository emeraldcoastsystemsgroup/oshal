# Security Control Evidence - Access Control And SSRF

Maps each app-layer access-control guarantee to the code that enforces it and the test that
proves it, using the release plan vocabulary: **Built**, **Mounted**, **Enforced**, and
**Proven**.

These controls are unit-proven offline via:

```bash
npm run test:unit -- tests/unit/authz-access.spec.ts tests/unit/ssrf-guard.spec.ts tests/unit/guc-pool.spec.ts
```

Database-policy isolation is proven against a live Postgres profile via:

```bash
npm run verify:rls
OSHAL_SCHEMA_BOOTSTRAP=validate-only npm run verify:runtime-schema
```

| Guarantee | Enforced by | Proven by | Status |
|---|---|---|---|
| Object-level authz: a caller reaches a resource only if owner or operator. Legacy unowned access is denied unless `OSHAL_ALLOW_LEGACY_UNOWNED=true` is explicitly set for a backfill window. Cross-user access is denied. | `canAccessResource` / `isOperator` - `src/shared/middleware/authz.ts` | `tests/unit/authz-access.spec.ts` | Enforced; Proven |
| Operator privilege is a fail-closed allowlist; machine routes accept only a constant-time-compared `X-Service-Secret`. | `isOperator`, `requireOperator`, `serviceSecretOr`, `hasValidServiceSecret` - `authz.ts` | `tests/unit/authz-access.spec.ts` | Enforced; Proven |
| SSRF: a user-supplied fetch URL cannot reach private, loopback, link-local, CGNAT, or cloud-metadata addresses by IP literal or DNS resolution. | `assertPublicHttpUrl` / `isPrivateIp` - `src/shared/security/ssrf-guard.ts` | `tests/unit/ssrf-guard.spec.ts` | Enforced; Proven |
| RLS identity stamping: every pooled query carries `oshal.current_sub` / `oshal.is_operator`; background/system work is stamped operator; anonymous request identity is stamped non-operator; valid service-secret requests are explicitly trusted; identity never leaks back to the pool. | `wrapPoolWithGuc` - `src/shared/services/database/guc-pool.ts`; server request-identity middleware | `tests/unit/guc-pool.spec.ts`, `tests/unit/authz-access.spec.ts` | Mounted; on by default; Proven |
| Postgres owner policy isolation: user A sees only user A rows, user B sees only user B rows, operator sees both, anonymous sees neither. | `docs/governance/rls-policies-enforce.sql`; `scripts/governance/provision-rls-app-role.mjs`; `scripts/governance/verify-rls-isolation.mjs` | `npm run verify:rls` against enforced Postgres with a non-superuser/non-`BYPASSRLS` app role; enforced platform-wide by migration `060-platform-rls-tenancy.sql` (ADR-076) | Built; **live enforced** on oshal-local 2026-06-27 (84 tables, runtime on `oshal_app`) |
| Runtime schema role split: app role validates schema readiness and cannot run DDL. | `src/shared/services/database/schema-bootstrap-policy.ts`; `scripts/governance/verify-runtime-schema-validate-only.ts` | `OSHAL_SCHEMA_BOOTSTRAP=validate-only npm run verify:runtime-schema` with the non-superuser app role | Built; local app-role proof passed |

## Notes

- The RLS GUC wrapper is mounted and on by default. `OSHAL_DB_GUC=off` is break-glass rollback only.
- No async request identity still means trusted background/system work. A request identity with `sub=null`
  is different and is stamped non-operator unless the request carries a valid `X-Service-Secret`.
- The Postgres RLS policies are not auto-applied. Use `docs/governance/RLS-RUNBOOK.md` for the
  staged permissive and enforce rollout, then archive the JSON output from `npm run verify:rls`.
- The app runtime must also use a non-superuser/non-`BYPASSRLS` DB role. `npm run provision:rls-role`
  creates that role and grants the public-schema privileges needed for the existing runtime.
- `OSHAL_SCHEMA_BOOTSTRAP=validate-only` is the hosted app-role mode: shared schemas validate
  readiness and the runtime pool blocks DDL. Route-specific app schemas still need migration-owner
  cleanup before public-user hosting.
- `OSHAL_ALLOW_LEGACY_UNOWNED` defaults to `false`; enable it only for a controlled legacy backfill.
- Broader helpers such as CSP, rate limits, and webhook HMAC have coverage under
  `tests/hardening-*.spec.ts`; this file tracks access control and SSRF evidence.
