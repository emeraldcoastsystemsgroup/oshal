# Security

Security posture, hardening guidance, and control evidence for OSHAL.

- [application-authorization.md](./application-authorization.md) — dynamic application permission catalogs, central administration, registered tools, and current enforcement limits.

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

Related:

- [../backlog/hardening.md](../backlog/hardening.md) — open hardening work.
- [../governance/README.md](../governance/README.md) — RLS/RBAC policies and provisioning.
- ../release/README.md — go-public credential rotation and history scrub.
- Repo-root [SECURITY.md](../../SECURITY.md) — vulnerability reporting policy.
