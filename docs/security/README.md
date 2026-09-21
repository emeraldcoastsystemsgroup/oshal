# Security

Security posture, hardening guidance, and control evidence for OSHAL.

- [application-authorization.md](./application-authorization.md) — dynamic application permission catalogs, central administration, registered tools, and current enforcement limits.
- [remote-application-execution.md](./remote-application-execution.md) — signed current-rights checks for hosted remote reasoning, immutable queued initiators and protected result delivery.

- [SECURITY-POSTURE.md](./SECURITY-POSTURE.md) — current security posture; honest about what is
  on-by-default vs opt-in. Start here.
- [SECURITY-HARDENING.md](./SECURITY-HARDENING.md) — hardening guide for the swarm.
- [security-control-evidence.md](./security-control-evidence.md) — access-control and SSRF
  control evidence.
- [local-auth.md](./local-auth.md) — the LOCAL_AUTH invited-user login (ADR-117): setup,
  invite/reset/disable flows, and what it deliberately does not do yet.
- [entra-local-hybrid.md](./entra-local-hybrid.md) — the Entra/local hybrid login and the
  Entra→local identity bridge: an allowlisted Microsoft door onto the same canonical local subs.
- [guest-mode.md](./guest-mode.md) — guest mode (`ENABLE_GUEST_MODE`, default off): the anonymous
  identity rail, the tier lockdown, anchored mutation grants, and the cost posture.
- [http-delegation.md](./http-delegation.md) — Ed25519 controller-to-bot task delegation,
  shared replay protection, role-separated key rollout, and rotation/recovery operations.
- [workload-delegation.md](./workload-delegation.md) — SEC-01 workload-to-API user delegation,
  durable authorization, exact route scopes, migration stages, rotation, and rollback.
- [unguarded-api-mounts-2026-09-14.md](./unguarded-api-mounts-2026-09-14.md) — read-only audit of the
  three `/api` mounts registered without `requiresAuth` (`/api/authorization`,
  `/api/authorization/tenant-memberships`, `/api/user-directory`): per-route exposure, the internal
  guard each one carries, and why both route-auth classifiers report them red.
- [secret-scan-planted-fixture-proof.md](./secret-scan-planted-fixture-proof.md) — the
  `ci-local.sh` `secret-scan` gate proven to go red on a planted synthetic credential and green
  once it is removed, against the real gitleaks image, with the two mutations that were watched
  turning the guard red.
- [secret-scan-unreadable-path-proof.md](./secret-scan-unreadable-path-proof.md) — the same gate
  proven to refuse a PASS when the real gitleaks image skips a path it cannot read and still exits
  0, which is the 2026-09-10 failure, plus the check that the floating `:latest` tag still writes a
  wording `GITLEAKS_UNREAD_PATTERN` matches.

Related:

- [../backlog/hardening.md](../backlog/hardening.md) — open hardening work.
- [../governance/README.md](../governance/README.md) — RLS/RBAC policies and provisioning.
- ../release/README.md — go-public credential rotation and history scrub.
- Repo-root [SECURITY.md](../../SECURITY.md) — vulnerability reporting policy.
