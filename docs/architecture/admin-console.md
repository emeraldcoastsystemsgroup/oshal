# Admin Console

A single operator-grade surface for identity, tenants, connectors, audit, cost, and security
posture. Read-only observability plus a control plane for the actions an operator/tenant admin
actually needs.

## Access

- URL: `/admin` (e.g. `http://localhost:35457/admin`, or append `/admin` to your cockpit host).
- Gate: admin-only when an operator allowlist is configured (`OSHAL_OPERATOR_EMAILS` /
  `OSHAL_OPERATOR_SUBS`); permissive for a solo/local operator with no allowlist. A non-admin
  gets `403`. This gate is independent of `OSHAL_RBAC_ENFORCE`.
- Roles: `admin` = a hit on the operator allowlist (or an `admin` token claim); `operator` =
  the optional `OSHAL_RBAC_OPERATOR_*` allowlist; `viewer` = any other authenticated caller.

## What each panel shows (read-only)

- **Identity & RBAC** — your resolved role, effective permissions, and whether RBAC enforcement
  is on or permissive.
- **Control Posture** — RBAC, RLS GUC, legacy-unowned, CSP, rate limit, token crypto, mock-OIDC,
  audit forwarding.
- **RLS Release Gate** — the tenant-isolation posture: stage, DB role, schema mode, blockers, and
  per-table enforcement (backed by `/api/governance/posture`, which now covers every RLS table).
- **Connectors** — marketplace totals, high-risk connectors, and a CSV audit export.
- **Tools & Approvals** — write-capable / high-risk counts, policy enforcement, DLP mode.
- **Access Audit Log** — search the append-only audit trail by action / resource / actor /
  decision / date, and export CSV. (The trail is append-only at the DB level — see the runbook.)
- **LLM Budgets** — budget/quota/routing enforcement and the global daily cap.
- **Procurement & SaaS Gates** — readiness scores from the latest evidence artifact.

## Control-plane actions (write)

### Tenants & Users
- **Create household** — creates a `space` tenant; you become its **admin**.
  (`POST /api/tenants`)
- **Add member** — pick a household you admin, enter the member's sub/id and a role.
  (`POST /api/tenants/:id/members`)
- **Members list** — the selected household's members, each with:
  - a **role** dropdown to promote/demote (`PATCH /api/tenants/:id/members/:sub`), and
  - a **remove** button (`DELETE /api/tenants/:id/members/:sub`).
  - Guardrail: the last admin cannot be demoted or removed, so a household is never orphaned.

### Connectors
- **Enable / Disable** a connector by provider id, or **search the catalog** and toggle a match
  inline. (`POST /api/connectors/marketplace/:provider/{enable|disable}`; search reads the full
  marketplace via `GET /api/connectors/marketplace?full=1`.)

## Notes

- The console page (`src/pages/admin/`) is bind-mounted, so UI changes hot-swap without a rebuild.
  New API routes are TypeScript and take effect on the next image rebuild.
- Every write action is best-effort audited to the access audit log, so admin activity is itself
  reviewable in the Audit panel.
