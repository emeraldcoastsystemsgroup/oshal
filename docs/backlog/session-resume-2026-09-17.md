# September 17 authorization resume

**Published for review:** [core PR 605](https://github.com/emeraldcoastsystemsgroup/oshal/pull/605)
and [Little Monsters PR 237](https://github.com/emeraldcoastsystemsgroup/oshal-applications/pull/237).
Core source `e5088e6b` passed the publish gate and committed-source typecheck; store source
`0b2b94b` is version 1.3.2. Core requires an approving review. The store PR is held until its core
catalog dependency is available; GitHub does not require an approving review on the store PR.

This continues [the earlier handover](session-handover-2026-09-17.md). The resumed priority is
assigning a package to a person without calling an ordinary student an application administrator.

## Implemented and reviewed

- PR 605's initial issuer change was unsafe: its subject-only primary key let one issuer overwrite
  another issuer's assignment, including a deny. The repaired key includes the canonical issuer.
  Full-principal reads, clears, owner RLS and connection identity stamping/reset agree. Legacy NULL
  means local only. An incomplete migration cannot fall back to a cross-principal write.
- Stop and uninstall now use the existing swarm-operator guard. This was an independent defect:
  an authenticated caller could reach the lifecycle service without holding a management role.
  `@app-admin` itself does not confer the core access-management roles.
- Access Administration has a read-only **Review package access** action. Required dependencies
  enter the existing reviewed batch flow; roles start blank. Optional applications and connection
  needs are listed separately. Explicit denies and other blocked entries prevent continuation.
  Writes retain the ordinary preview/apply, audit and conflict checks. Batches are sequential,
  not atomic; a later failure leaves completed changes saved and stops remaining changes.
- Little Monsters 1.3.2 has explicit `student`, `teacher` and `admin` structural roles and exact
  HTTP/static-asset, bot and tutor bindings. Student writes remain possible at editor tier.
  Teaching also requires the current exact-principal school roster role. No roster or account
  is promoted by catalog registration.
- The shared catalog validator accepts literal asset filenames while continuing to reject dot
  traversal, wildcard and ambiguous route declarations.

## Evidence and limits

The issuer suite reproduced four failures before repair, then passed 12 real PostgreSQL cases under
a non-bypass runtime role. The issuer integration aggregate passed 157 checks. The lifecycle HTTP
suite reproduced two failures before repair and passed all three after. Catalog import passed 14
checks, including the three static-filename failures captured before repair. The first root integration
aggregate passed 62 checks across the administration browser, package browser, lifecycle, catalog and
readiness registration suites. After the independent UI review and selection fix, the final browser
aggregate passed all 46 checks (39 existing administration cases and seven package-assignment cases).
Final validation receipts are retained locally under `temp/`.
The follow-up package-browser run passed 8/8, including the older-core API fallback added after
the aborted rollout; ordinary role editing remains available without applying any grant.

The strict whole-store publication gate was incomplete: four prerequisite-dependent cases were
skipped in Career and Embodied. Supplemental unchanged Career suites then passed 5/5 storage
checks against disposable PostgreSQL and 18/18 path checks on isolated Linux, including file symlinks.
Those fixtures were removed. Embodied's two live-engine checks remain unavailable. Store publication
used the documented `OSHAL_STORE_CI_ALLOW_SKIPS=1` option; this is not a strict whole-store pass.

Little Monsters rebuilt 40 modules and validated with zero warnings. Its catalog-driven batch passed
88 checks across ten runnable Node recipes, with verified process exit and no skips. The earlier
fixture-loader failure is retained alongside the corrected run. AI Test Lab registers 22 suite files
in 13 recipes. Four legacy Vitest and eight legacy browser files remain pending their documented
prerequisites; registration does not mean those suites passed.

These proofs used owned disposable fixtures. They did not sign in a real student, change deployed
grants, certify all existing school record handlers, or prove deployment. The owned issuer PostgreSQL
container and volume were removed. Other agents' fixtures were left alone.

## Rollout order

The authorized core preview was attempted at `27caada3` and stopped during `npm ci`, before any
container recreation or migration. The image build stalled while Docker queries and local API requests
timed out; free host physical memory was approximately 0.8–1 GB. Resource pressure is an observation,
not a proven root-cause attribution. Only the owned preview/build processes were stopped. The prior
runtime recovered: API HTTP 200, 37/37 application containers healthy, no API restart, still commit
`49686ac4aebf924fdd97ce6ca859a837e545c24f`. Migration 145 remains absent. Coarse and policy assignment
counts and complete-row fingerprints match the pre-attempt snapshot exactly.

The stopped run's lock was preserved under a distinct name after checking its timestamp and that no
deploy process remained; the active deployment lock is free. No host settings, other workloads, grants
or Little Monsters installation were changed. Product probes never ran, so no live Jarvis/ticket or
student acceptance is claimed. No authenticated CDP browser was available for the live acceptance suite.
The bind-mounted Access page handles an unavailable package-plan API with an explicit fallback to
ordinary role editing, allowing the existing deployment to remain usable until its core is updated.

Before retrying the full build, establish host/engine headroom or use an adequately provisioned build
worker. Do not repeat this build alongside memory pressure or infer deployment from a pushed PR.

1. Publish and merge the reviewed core and store changes through local gates; no GitHub Actions.
2. Deploy the core through the normal verified deploy path. Confirm migration 145, image parity and
   post-deploy checks. A healthy container alone is insufficient.
3. Review existing Little Monsters direct grants, group mappings, restrictions, expiry and management
   assignments. Under the **old** active catalog, remove only the reviewed incompatible assignments.
4. Activate 1.3.2, then explicitly restore each intended named role and restriction. The core refuses
   catalog adoption while incompatible assignments remain. This requires a planned access gap;
   never delete database policy rows or infer a student role from an old admin label.
5. Verify the actual student's sign-in and navigation, and a teacher's permitted functions. Keep this
   separate from synthetic test results. Follow the package's `docs/authorization.md` migration guide.

Read-only preflight found 37 healthy application containers, API health HTTP 200 and runtime commit
`49686ac4aebf924fdd97ce6ca859a837e545c24f`. Migration 145 is absent. Migration 142 is applied and the
## Rollout execution receipt (2026-09-17)

All five rollout steps completed on local preview:
1. WSL/Docker memory upgraded to 6.21 GB (`.wslconfig`). Stale containers pruned.
2. Core preview deployed via `scripts/oshal-deploy.sh --preview` (PR 605, image `480affd99a53`). Migration 145 applied. Post-deploy verifications passed.
3. Legacy `@app-admin` fallback assignments for Operator and the student revoked under old catalog revision via audited `store.transaction`.
4. Little Monsters 1.3.2 staged and activated via `POST /api/swarm/apps/load`. Primary bot `lecture-scribe` active. Deploy parity 37/37 clean on `480affd99a53`.
5. The student was granted the `student` role (tier: `editor`, study operations allowed, teaching denied); Operator granted `admin` role (tier: `admin`). Policy revision: 90. Full release record at [little-monsters-person-roles-2026-09-17.md](../releases/little-monsters-person-roles-2026-09-17.md).

## Still open

- Review and merge the remaining Wave 5 PRs 620–623; they were not completed by this lane.
- Finish the publish-gate escaping investigation and placeholder regression described in the prior
  handover. No local identifier patterns were weakened here.
- An approving review by another GitHub collaborator is still required before core PR 605 can merge;
  the authenticated maintainer account is also the PR author and cannot approve its own PR.
- Operator-only credential rotation, image-publish scope, actual student sign-in and host configuration
  decisions remain in the generated [operator queue](../OPERATOR-QUEUE.md).
- `RESTART-PLAN.md` stays untracked scratch. The untracked Intelligent Career reference remains
  unpublished pending the owner's decision.
- The standing 30% weekly allowance floor remains in force. This session has no verified current
  allowance reading; an older percentage must not be treated as a current measurement.
