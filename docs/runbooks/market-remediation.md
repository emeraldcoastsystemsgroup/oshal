# Market Remediation Runbook

Operational companion to the remediation plan
and the market re-assessment. How to deploy,
verify, roll back, and reboot the Phase-0 remediation changes safely.

Last updated: 2026-07-04.

## Current state

| Item | What it does | State |
|---|---|---|
| A2.2 append-only audit (migration 061) | `access_audit_log` is INSERT-only; UPDATE/DELETE/TRUNCATE blocked by trigger | LIVE on prod DB |
| A1.1 RLS posture coverage | `/api/governance/posture` enumerates ALL RLS tables (was a 4-table sample) + `coverage` block | LIVE (api recreated onto current image 2026-07-05; route verified auth-gated 401) |
| A2.1 connector audit | enable/disable/remove write an `access_audit_log` row | LIVE (same recreate) |
| M1 nightly refresh | `npm run evidence:nightly` keeps the scoreboard fresh | SCHEDULED 2026-07-04: Windows task `OSHAL-Evidence-Nightly`, daily 03:30, wakes the PC |
| A1.2 committed DB-default cutover | make `oshal_app` the committed default so a fresh checkout enforces RLS | **DONE 2026-07-04** (commits ace8d338, 070c35fe) — see "A1.2: as-built" |

Commits on `origin/main`: `a790a419` (Phase-0 batch), `050fcd0b` (A2.1).
Rollback image: `oshal-bot:prev`.

## Reboot / recreate procedure

The TS changes (A1.1, A2.1) are baked into `oshal-bot:latest`. They go live when the api
container is recreated onto the new image. The migration (061) is already live regardless —
it auto-applied (see "How migrations deploy").

CRITICAL: the running api gets `DATABASE_URL=postgresql://oshal_app:...` from the operator
`.env`. A bare `docker compose up` WITHOUT that env falls back to the committed default
`postgresql://oshal:oshalpass@oshal-db:5432/oshal` (the `oshal` SUPERUSER), which Postgres
exempts from RLS — silently turning tenant isolation OFF. Always recreate through the normal
flow that loads the operator `.env` and the five `--profile` flags (see
[reboot recovery](#) / the operator `.env`). After recreate, confirm the role (below).

Steps:
1. Recreate the api (and bots) via the normal profile + `.env` flow.
2. Verify the api connected as `oshal_app`, NOT the superuser:
   `docker exec oshal-local-api printenv DATABASE_URL` — must show `oshal_app@`.
   `docker exec oshal-local-db psql -U oshal -d oshal -tc "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='oshal_app';"` — both `f`.
3. Health-check `:35457` and the cockpit.

## Rollback

`oshal-bot:prev` is the image from before this batch. To roll back: retag and recreate.
```
docker tag oshal-bot:prev oshal-bot:latest
# recreate api via the normal flow
```
The migration is additive and append-only-safe; it does not need rolling back. If it ever
must be removed: `DROP TRIGGER audit_append_only ON access_audit_log; DROP TRIGGER
audit_no_truncate ON access_audit_log;` as the `oshal` superuser.

## How migrations deploy (important gotcha)

`scripts/migrations` is BIND-MOUNTED into `oshal-local-api`. On api restart the boot command
runs `DatabaseBootstrapService.applyMigrations()` (unless `OSHAL_SCHEMA_BOOTSTRAP=validate-only`
or `OSHAL_SKIP_RUNTIME_MIGRATIONS=true`), applying any new `*.sql` file and recording it in
`app_migrations(filename)`. So a new migration file goes LIVE on the next api restart WITHOUT
an image rebuild. That is how 061 deployed. TS code is NOT bind-mounted — it needs an image
rebuild + recreate.

## Verifying each change

Append-only audit (A2.2):
```
docker exec oshal-local-db psql -U oshal -d oshal -c \
  "BEGIN; DO \$\$ BEGIN UPDATE access_audit_log SET action=action; EXCEPTION WHEN others THEN RAISE NOTICE 'blocked: %', SQLERRM; END \$\$; ROLLBACK;"
# expect: NOTICE blocked: access_audit_log is append-only; UPDATE is not permitted
```

Posture coverage (A1.1) — after reboot, GET `/api/governance/posture` (admin) returns a
`coverage` object with `rlsEnabledTables`, `notForced`, `noPolicy`, and any not-FORCEd /
no-policy table names appear in `blockers`.

Connector audit (A2.1) — enable/disable a connector, then query the audit log:
```
docker exec oshal-local-db psql -U oshal -d oshal -c \
  "SELECT action,resource_id,created_at FROM access_audit_log WHERE action LIKE 'connector.%' ORDER BY created_at DESC LIMIT 5;"
```

## Building the image

Canonical: `docker build -f Dockerfile.oshal -t oshal-bot:latest .` (builds from the working
tree, so it bakes in whatever is uncommitted too). Tag `oshal-bot:prev` first for rollback.
Build only re-tags `:latest` on success, so a non-compiling tree leaves the old image intact.

## Routine

- DONE (2026-07-04): `npm run evidence:nightly` is scheduled as Windows task
  `OSHAL-Evidence-Nightly` (daily 03:30, WakeToRun + StartWhenAvailable, registered via
  `scripts/register-evidence-nightly.ps1`). The wrapper `scripts/run-evidence-nightly.ps1`
  sets `COMPETITIVE_EVIDENCE_MAX_LIVE_AGE_HOURS=26` and logs to
  `logs/evidence-nightly/<date>.log` (gitignored, last 14 kept). Verified end-to-end through
  Task Scheduler on 2026-07-04. Re-register after a repo move; remove with
  `Unregister-ScheduledTask -TaskName 'OSHAL-Evidence-Nightly' -Confirm:$false`.
- Weekly, re-run the market re-assessment (the four-cluster verification) and regenerate
  `docs/competitive-market-reassessment-<date>.md`.

## A1.2: as-built (DONE 2026-07-04)

The cutover shipped in commits `ace8d338` + `070c35fe` and was proven by a flag-ON
fresh-boot smoke of the ACTUAL api container (image built from committed HEAD, fresh
pg16, isolated network): one boot, zero operator steps → healthy, 64/64 migrations,
core-4 tables FORCE-RLS'd with policies, audit append-only triggers installed,
SECURITY DEFINER helper superuser-owned, and `verify:rls` two-user isolation PASSED
inside the container as `oshal_app`. Evidence:
`docs/evidence/app-role-fresh-boot-cutover-2026-07-04.md`.

Committed defaults now: `OSHAL_APP_ROLE_BOOTSTRAP=true` + api-service
`DATABASE_URL` → `oshal_app` (dev password; operator `.env` overrides in prod —
rendered config verified unchanged for the live api). Boot order on the flag path:
migrate (superuser) → `apply-rls` enforce (non-fatal; succeeds boot ≥2, chokepoint
covers boot 1) → provision → server as `oshal_app`. Fresh-boot fixes: 052 creates
workspaces + its policy; 060 creates the tenancy tables + skips lazy app tables;
061 creates the audit table + policies; `buildOwnerRlsPolicyStatements()` applies
owner policies at the ticket/workspace/conversation lazy-DDL chokepoint.

Rollback: set `OSHAL_APP_ROLE_BOOTSTRAP=false` in `.env` (restores the legacy
single-role boot verbatim); image rollback via `oshal-bot:prev` as usual.

Still open (not blockers for the cutover): per-bot GUC wiring (ADR-076 Phase 2) and
tier-1 policies for the ~8 lazy app-store tables (BACKLOG).

RESOLVED (2026-07-05) — the posture-gate `validate-only` tension: the gate
(`buildRlsPostureSnapshot` in `src/app/routes/audit-export-routes.ts`) now accepts the
owner-role+auto posture as compliant IFF the connected role is verifiably
least-privilege (non-superuser AND non-BYPASSRLS) — the ADR-076 as-built model, where
`oshal_app` OWNS the tables so FORCE RLS scopes the owner and idempotent startup DDL is
safe. In that posture it emits an informational `advisories` entry ("validate-only is
the hardened target") instead of a blocker, so a correctly-isolated deployment can
report `releaseReady=true`. A superuser/BYPASSRLS role that is not validate-only
remains a release blocker exactly as before.

## Historical context: the original pending plan (superseded 2026-07-04)

Goal: make `oshal_app` the committed default in every compose file (currently they default to
the `oshal` superuser), so a FRESH checkout enforces RLS instead of only the operator box.

Why it is delicate (do NOT just flip the default):
- `OSHAL_SCHEMA_BOOTSTRAP=validate-only` CRASH-LOOPED before (startup does idempotent DDL).
  The working live config is `auto` with `oshal_app` OWNING all tables, so FORCE RLS still
  scopes the owner. The posture gate flagged `not validate-only` as a blocker — that tension
  was resolved 2026-07-05: the gate accepts owner+auto for a least-privilege role (see above).
- A fresh checkout needs `oshal_app` provisioned with a default dev password and the policies
  applied; today the password lives only in the operator `.env`.
- The per-bot `DATABASE_URL` connections (email/home/etc. reading connector tokens) need
  per-user GUC wiring before they can move off the superuser; out of scope for the first slice.

Progress (2026-06-30): the provisioning is now a one-command, idempotent, validated step:

```
OSHAL_APP_DB_PASSWORD=<pw> BOOTSTRAP_DATABASE_URL=<superuser-url> npm run provision:app-role
```

It wraps `docs/governance/app-role-provisioning.sql` (creates `oshal_app` NOSUPERUSER/NOBYPASSRLS,
grants DML, reassigns table/sequence/view ownership to it while the tenant helper stays owned by
the superuser). Validated end-to-end on a throwaway Postgres 16: after provisioning, querying AS
`oshal_app` under `SET oshal.current_sub=...` returns only the caller's rows (userA=2, userB=1,
no-context=0), and `oshal_app` is confirmed NOBYPASSRLS. So the cutover is reproducible, not a
by-hand artifact.

Automatic bootstrap (2026-06-30): the two-role boot now ships as an OFF-by-default flag,
`OSHAL_APP_ROLE_BOOTSTRAP`. When unset/false the api boot command is byte-identical to before
(verified via `docker compose config`), so the LIVE stack is unaffected. On a FRESH deploy set:

```
OSHAL_APP_ROLE_BOOTSTRAP=true
BOOTSTRAP_DATABASE_URL=postgresql://oshal:<superpw>@oshal-db:5432/oshal   # superuser, for migrate+provision
DATABASE_URL=postgresql://oshal_app:<apppw>@oshal-db:5432/oshal          # least-privilege runtime
```

The boot then migrates + provisions `oshal_app` as the superuser, reads the app password FROM
`DATABASE_URL` (so `oshal_app`'s password always matches what the app connects with — no reset /
lockout), and runs the server as `oshal_app`. Requires a rebuilt image (the Dockerfile now COPYs
`scripts/governance/` + `docs/governance/`). Validated on a throwaway pg16: password extracted from
the URL -> provisioned -> connected AS `oshal_app` with that password -> RLS enforced per-user.

Remaining before making it the default-on posture: one full flag-ON fresh-boot smoke of the actual
api container (not just the DB pieces), then optionally flip the committed `DATABASE_URL` default to
`oshal_app` for the api service. Until then it is opt-in; the live stack keeps the superuser default.

See also: the RLS design in ADR-076 and the operator `.env` for the live `oshal_app` password.
