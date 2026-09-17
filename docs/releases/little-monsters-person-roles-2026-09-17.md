# Little Monsters 1.3.2 person-role catalog rollout — 2026-09-17

**Deployed and verified on local preview.** Core PR 605 and Little Monsters 1.3.2
are active on the preview environment. Strict parity, routing liveness,
package-bot integrity and explicit person-role authorization checks passed.

Little Monsters 1.3.2 introduces explicit structural person-roles (`student`,
`teacher`, and `admin`) protected by named permissions and exact issuer-qualified
identity boundaries. Ella is granted the `student` role (tier: `editor`),
granting full voice-first ADHD study companion capabilities while denying
teaching and administration operations.

## Published and deployed checkpoints

- WSL2/Docker memory headroom upgraded: host `%USERPROFILE%\.wslconfig` updated
  to `memory=6GB`, `swap=4GB` with `autoMemoryReclaim=gradual`. Docker engine
  verified at 6.21 GB (6,214,090,752 bytes).
- Core preview deployed from branch `authz-oidc-app-tier` (`773ef3ba`) via
  `scripts/oshal-deploy.sh --preview`. Built on image
  `sha256:480affd99a53896a3d19f1e1807403b0f49b0a241981c3340bf7a213aa7c338c`.
  Post-deploy verification passed (`bot-role-grant` PASS, `jarvis-ask` PASS 31s,
  `ticket-dispatch` PASS). PostgreSQL migration `145-app-access-principal-issuer.sql`
  verified applied in `app_migrations`.
- Full stack brought up cleanly via `scripts/oshal-up.sh`. All 42 containers healthy.
  Routing liveness verified: all 5 routing-critical bots heartbeating (`RESULT: PASS`).
- Deploy parity check passed: 37/37 application containers running identically on
  image `480affd99a53` with zero drift (`RESULT: PASS`).
- Workspace staging: Little Monsters 1.3.2 package (compiled 40 route modules,
  12/12 authorization integration tests) staged into the live workspace volume
  `/app/workspace-shared/deployed-apps/little-monsters`.
- Catalog migration and adoption:
  - Revoked legacy `@app-admin` fallback assignments for Operator and Ella under
    the old catalog revision through an audited `store.transaction`.
  - Loaded and activated Little Monsters 1.3.2 via `POST /api/swarm/apps/load`.
    `swarm_applications` records version 1.3.2, status `active`.
  - App-bot integrity verified via `scripts/swarm-app-bot-integrity-check.sh`:
    primary bot `lecture-scribe` (`ed000000-0000-0000-0000-000000000001`) active
    (`RESULT: PASS`).
- Explicit person-role assignments:
  - Ella (`113439769752756917575` / `https://accounts.google.com`): granted named
    `student` role (tier: `editor`). Verified via `/api/authorization/explain` that
    `app.open` and `study.read` are allowed; `teaching.read` is denied.
  - Operator (`REDACTED` / `https://accounts.google.com`): granted
    named `admin` role (tier: `admin`). Verified `app.open` allowed.
  - Policy revision advanced cleanly to `90`.
