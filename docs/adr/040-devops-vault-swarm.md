# ADR-040 — DevOps / Vault Swarm: the controlled privileged-runtime credential broker

- **Status:** Broker BUILT for single-admin/single-tenant (2026-06-21). Vault installed (`oshal-vault`).
  `vault-bot` is a live inline bot that not only manages KV (`vault_status`/`read`/`write`/`list`) but
  **brokers credentials**: `vault_policy` (set least-priv scope) → `vault_issue` (mint a short-TTL child
  token bound to that scope, OR a dynamic secret from a configured engine via `{engine, role}`) →
  `vault_lookup` → `vault_revoke`. The issue→scope→expire→revoke loop is VERIFIED: a minted token reads
  its scoped path (200) but is denied out-of-scope (403), and is provably dead after revoke (403). The
  master token lives in the controller env (`VAULT_TOKEN`), never a bot prompt. The **dynamic secrets
  engine path is now PROVEN too**: `vault_setup_db` mounts Vault's postgresql database engine against the
  app DB and `vault_issue {engine:"database", role:"app-readonly"}` hands out a REAL short-TTL Postgres
  login — VERIFIED the issued login connects, then is dead (role dropped) after `vault_revoke`
  (revocation uses `DROP OWNED BY` before `DROP ROLE` to avoid the SQLSTATE 2BP01 dependency error).
  The issued role is least-privilege: read-only across `public`, `NOSUPERUSER/NOCREATEDB/NOCREATEROLE/
  NOREPLICATION` + a connection cap (verified `rolsuper=f … rolconnlimit=5`).
  REMAINING (only matters MULTI-USER, deferred — not a single-admin blocker): the ephemeral per-session
  runtime isolation (tmpfs, cross-user blast radius), auto-injection of an issued cred into a privileged
  tool's task workspace (`.oshal-cred-*`) + auto-teardown, and the remaining cloud engines (AWS STS / kube
  — same `{engine, role}` path, they light up once mounted like the database engine did).
  Local dev uses an in-memory Vault + dev root token; PRODUCTION needs real init/unseal, TLS, and AppRole
  auth (NOT a root token), plus the multi-user runtime isolation + a security review before multi-tenant.
- **Date:** 2026-06-16 (design); 2026-06-21 (Vault server + KV + token broker); 2026-06-22 (dynamic database secrets engine proven)
- **Supersedes/extends:** [ADR-038 (swarms bundled by type)](038-swarms-bundled-by-type.md),
  the token-broker work, and the per-user DEK envelope crypto
- **Related backlog:** "DevOps swarm — build the privileged runtime FIRST ⭐"

## Context

OSHAL's social and communications swarms act on a user's *low-privilege* accounts
(LinkedIn, Gmail, X) with short-lived OAuth tokens. The next, highest-value bundle is
**DevOps**: bots that touch *infrastructure* — Kubernetes, AWS, hypervisors, Terraform,
Splunk, ServiceNow. That requires *high-privilege* cloud credentials, which changes the
threat model entirely.

The operator has already proven the core idea by hand: **"we loaded the agents up with
AWS creds and had great results — when controlled."** The unsolved part is the *control*:
how a swarm gets real cloud credentials, uses them for one bounded task, and provably
gives them back — without a long-lived secret sitting in a container, a shared workspace,
or an env var.

Two things make this tractable now:
1. **The token broker already exists.** The controller holds the master key; bots receive
   short-lived, single-user credentials via per-request workspace files
   (`.oshal-cred-*`) and never the master. The DevOps swarm reuses this exact channel —
   the only change is the *source* of the credential.
2. **HashiCorp Vault is the right credential source.** Vault issues short-TTL, scoped,
   auditable secrets (e.g. AWS STS via the AWS secrets engine) on demand and revokes them
   on lease expiry. It externalizes the "issue → scope → expire" lifecycle OSHAL would
   otherwise have to build.

## Decision

Build a **DevOps swarm** whose credential lifecycle is brokered through **Vault**, on an
**ephemeral, single-user privileged runtime**, with the cloud credential delivered to the
bot's tools through the **existing token-broker channel** and wiped at cycle end.

### Components

1. **`vault-bot` + `vault-tool`.** A first-class bot whose tool authenticates to a
   user/tenant's Vault (AppRole, TLS cert, OIDC, or token — "however they log into Vault")
   and, per task, requests a **short-TTL, narrowly-scoped** secret (AWS STS creds, a kube
   token, a DB cred) from the configured secret path. The vault-tool never persists the
   secret; it hands it to the broker.

2. **Dynamic bot config registration.** The vault-bot and its Vault settings are
   registered **live** into a running swarm via the same rail as codex-packer
   (`POST /api/swarm/apps/load`). "Vault settings" is a per-swarm config surface —
   Vault address, auth method + role, secret engine path, default TTL, allowed scopes.
   No redeploy to add Vault to a swarm.

3. **Controlled credential injection (reuse the token broker).** The controller takes the
   Vault-issued secret and injects it into the bot's task workspace exactly like a
   connector token today: a `.oshal-cred-<kind>` file (cwd channel for codex) + scoped env
   (for claude/gemini/cline). The bot's shelled tools (`aws`, `kubectl`, `terraform`) read
   it; the **master Vault auth and OSHAL's `SESSION_SECRET` never enter the bot container.**

4. **Ephemeral, single-user privileged runtime.** A DevOps task runs in an **isolated,
   one-user-at-a-time** runtime: per-session tmpfs for the credential, no shared-workspace
   secrets. At cycle end the runtime **revokes the Vault lease, wipes the tmpfs, and exits
   the session** — provably leaving no residual credential and no cross-user access.

5. **Human-gated remediation.** Remediation output is **scripts + a report handed back for
   operator review**, never auto-applied to production (consistent with the existing
   incident-remediation posture). Apply is a separate, explicitly-approved action.

### Lifecycle (one task)

```
ticket(devops) → dispatch to ephemeral runtime (one user)
  → vault-tool authenticates to Vault (AppRole/cert/OIDC)
  → vault-tool requests short-TTL scoped secret (e.g. AWS STS, 15-min lease)
  → controller broker injects secret into task workspace (.oshal-cred-*, scoped env)
  → bot runs aws/kubectl/terraform for THIS task only
  → bot emits remediation scripts + report (for human review — not auto-applied)
  → runtime revokes the Vault lease, wipes tmpfs, ends session
  → audit record: who, what scope, which lease, when revoked
```

## Security model

| Property | How it's achieved |
|---|---|
| No long-lived cloud key at rest | Vault issues short-TTL leases per task; revoked at cycle end |
| Bot never holds the master | Token-broker channel: controller injects, bot never sees Vault auth or `SESSION_SECRET` |
| Per-user blast radius | One user per session; per-session tmpfs; lease scoped to that task |
| No residual credential | tmpfs wipe + lease revocation are part of cycle teardown (test-asserted) |
| Auditability | Every issuance is a Vault lease with identity + scope + TTL; OSHAL records the mapping to the ticket |
| No prod auto-apply | Output is review-gated scripts; apply is a separate approved action |
| Defense in depth | Pairs with per-user DEK envelope crypto for any OSHAL-stored config |

## Consequences

**Positive**
- Productizes the operator's proven "real creds, great results, when controlled" loop.
- Reuses two things OSHAL already has (the token broker, dynamic app registration), so the
  new surface area is the Vault integration + the ephemeral runtime, not a new secrets system.
- Vault externalizes the hardest part (issue/scope/expire/audit).

**Negative / costs**
- **Not free, by design.** The privileged runtime (ephemeral isolation, per-session tmpfs,
  lease teardown), the Vault dependency, and the audit trail are real infrastructure. This
  is the **premium / paid tier** of OSHAL, not the zero-config local demo.
- The single-user/ephemeral runtime must be built **before** any infra-touching tool goes
  multi-user — it is the gating prerequisite, not an add-on.
- Requires a security review before first production use.

**This ADR is the design.** A **Private Preview facade** shipped first (catalog tile + a
DevOps/Vault control-panel surface) so the capability could be demonstrated and scoped with
early-access customers while the privileged runtime is built behind it.

> **As-built update (2026-07-18):** the facade is now **ACTIVATED** — the DevOps/Vault console
> executes REAL Vault operations (KV + the credential broker + the postgresql dynamic-secrets
> engine) behind `requireSuperAdmin` + `confirm:true` + the governance audit trail, plus an
> owner-scoped **live process trace**. This is the **read/broker half** of the design. The
> **infra-acting half** (build order below — ephemeral runtime, terraform/k8s workers) remains
> unbuilt and gated on the security review. NOT primetime: it currently runs against a **dev-mode
> Vault with a root token** — see [docs/architecture/devops-cockpit-connectivity.md](../architecture/devops-cockpit-connectivity.md)
> for the phased path (real Vault + least-privilege rotating token + Connect-Vault flow) and the
> full topology-discovery / node-deploy / specialist / connectivity design.

## Build order (when greenlit)

1. Ephemeral single-user privileged runtime (tmpfs creds, wipe + session-end teardown) — **first**.
2. `vault-tool` + Vault settings config surface (real, replacing the facade's preview form).
3. Broker injection of Vault-issued secrets via the existing `.oshal-cred-*` channel.
4. First worker: a Terraform/k8s remediation bot, output review-gated.
5. Audit trail (lease ↔ ticket ↔ identity) + the cycle-teardown test
   (asserts no residual cred, no cross-user access).
