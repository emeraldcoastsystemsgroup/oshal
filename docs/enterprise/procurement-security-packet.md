# OSHAL Procurement Security Packet

Prepared: 2026-06-23

Status: pilot-ready security packet. This is not a SOC 2 report, penetration-test report, DPA, or legal security addendum. It is the current buyer-review packet that explains what is built, what is proved, and what remains open before broad public SaaS or enterprise procurement.

> **Evidence freshness (read before sending to a buyer):** this is a point-in-time packet dated
> above. The `docs/evidence/*` files cited below were the latest live proofs *as of the prepared
> date* — several now have newer regenerations in `docs/evidence/` (the proofs are refreshed on an
> ongoing cadence; see the newest `competitive-readiness-*` / `procurement-saas-readiness-*` by
> date). **Regenerate this packet against the latest run before sending it externally** — do not
> present a dated citation as current proof.

## Product Boundary

OSHAL is a self-hostable or hosted control plane for AI-assisted work. The platform coordinates user requests, specialist bots, connector-backed data access, approval-gated tool actions, generated artifacts, audit evidence, and model/provider routing.

Supported deployment modes are documented in `docs/deployment-models.md`:

- Local/zero-keys demo.
- Local self-host with user-owned providers.
- Tunneled production/design-partner deployment.
- Kubernetes/team deployment path.
- Home appliance packaging roadmap.

## Data Types

| Data Type | Examples | Current Handling |
|---|---|---|
| Identity data | OIDC subject, email, roles | Authenticated routes use OIDC identity; governance whoami endpoint exposes resolved role/permissions. |
| User work data | tickets, chat tasks, task messages, generated outputs | User scoping is enforced in app routes and live-proved for task/message isolation. |
| Connector credentials | OAuth access/refresh tokens, API keys | Token broker and connector runtime prefer per-user/broker credentials; secret values are not printed in evidence. |
| Connector data | Gmail labels, calendar list, Slack channels, GitHub user info, Jira user info | Live read proof covers a small set; more live proofs are required before broad connector claims. |
| Audit data | access events, guard receipts, posture exports | Governance audit export exists and is RBAC-gated when enforcement is enabled. |
| Cost data | token/cost telemetry, Token Chase comparisons | Cost proof exists; per-tenant budget enforcement remains open. |

## Current Security Controls

| Control | Evidence | Status |
|---|---|---|
| Authenticated routes | `src/app/server.ts`, OIDC route guards | Built. |
| Role/permission scaffolding | `src/features/governance/rbac/policy.ts` | Built; enforcement must be turned on and negative-path proved for procurement. |
| Row-level isolation posture | `src/shared/services/database/guc-pool.ts`, `docs/governance/rls-policies-enforce.sql` | Built and live-proved for task/message surfaces. |
| Two-user privacy proof | `docs/evidence/live-two-user-isolation-2026-06-22.md` | Live proof passed. |
| Legacy unowned row disposition | `docs/evidence/legacy-owner-backfill-quarantine-2026-06-22.md` | Live proof exists. |
| Risky write confirmation | `docs/evidence/risky-write-guards-2026-06-23.md` | Live proof passed for email, payments, finance, social, home, and trading guards. |
| SSRF protection | `src/shared/security/ssrf-guard.ts`, `docs/security/security-control-evidence.md` | Unit-proven. |
| Audit export | `src/app/routes/audit-export-routes.ts` | Built; buyer-facing UI/export package still needs polish. |
| Data export/delete | `docs/evidence/data-export-delete-2026-06-22.md` | Live proof exists. |
| Backup/restore | `docs/evidence/backup-restore-2026-06-22.md` | Live proof exists. |
| Hosted design-partner path | `docs/evidence/hosted-enough-2026-06-22.md` | Passed for design-partner mode, not public SaaS scale. |

## Subprocessors And External Services

Actual subprocessors depend on deployment configuration and enabled connectors. For buyer review, disclose:

- Identity provider: Google OIDC, Microsoft Entra, or other configured OIDC issuer.
- LLM/model providers: Anthropic, OpenAI, local model runtime, Bedrock, Gemini, or any provider enabled by the operator.
- Tunnel/edge provider when used: Cloudflare Tunnel for tunneled production mode.
- Connector providers selected by the user or tenant: Google, GitHub, Slack, Jira, Dropbox, Microsoft, X/Twitter, Meta, SmartThings, Spotify, Square, PayPal, and other enabled providers.
- Infrastructure providers for hosted deployments: database, cache/queue, object storage, monitoring, and cloud hosting vendors selected by the operator.

Before enterprise sale, this packet needs a deployment-specific subprocessor table with legal entity names, processing purpose, data categories, region, and DPA status.

## Retention And Deletion

Current posture:

- User export/delete proof exists in `docs/evidence/data-export-delete-2026-06-22.md`.
- Generated artifacts, connector records, and chat/task records need a unified retention policy visible in admin settings.
- Connector token revocation and user deletion should produce audit receipts.

Required before procurement close:

- Document default retention periods by data type.
- Add tenant-level retention settings.
- Add deletion SLA and restore-window behavior.
- Add admin-visible deletion/export receipts.

## Audit And Evidence

Audit evidence currently exists as repo artifacts and route-level exports:

- `docs/evidence/competitive-readiness-2026-06-23.md`
- `docs/evidence/procurement-saas-readiness-2026-06-23.md`
- `docs/evidence/risky-write-guards-2026-06-23.md`
- `docs/evidence/live-two-user-isolation-2026-06-22.md`
- `docs/evidence/connector-five-live-reads-2026-06-22.md`
- `/api/governance/audit/export`
- `/api/governance/posture`

Required before enterprise close:

- Admin UI for audit search/export.
- Immutable audit log posture or documented append-only storage.
- Sample CSV/JSON audit export attached to this packet.
- Alerting for denied cross-user/cross-tenant access attempts.

## Open Procurement Gaps

| Gap | Required Closure |
|---|---|
| Buyer-grade admin console | One place for users, tenants, roles, connectors, tools, approvals, audit, cost, and posture. |
| SCIM/provisioning | SCIM or documented Entra/Google group-to-role sync with joiner/mover/leaver proof. |
| Permission-aware RAG | Source ACL metadata, retrieval filtering, freshness, citation proof, and negative tests. |
| Legal documents | DPA, privacy policy, terms, subprocessor list, security addendum. |
| External assessment | Vulnerability scan, dependency scan report, penetration-test plan/report, or SOC 2 roadmap. |
| Production operations | SLA, support model, incident response, on-call, maintenance windows, backup RPO/RTO. |

## Procurement Answer

Current buyer answer:

OSHAL is credible for a closely operated design-partner pilot where the operator can explain the evidence, configure the deployment, and monitor the environment. It is not yet packaged enough for broad enterprise procurement without follow-up security/legal materials and a buyer-grade admin console.
