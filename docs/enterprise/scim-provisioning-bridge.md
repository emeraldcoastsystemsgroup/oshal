# SCIM / Directory Provisioning Bridge

Prepared: 2026-06-23

Status: documented and unit-tested directory-role bridge. Full SCIM user create/update/delete endpoints remain a future implementation.

## Decision

The first enterprise provisioning lane is **OIDC group/role claim mapping**, not a standalone SCIM server. This is the right near-term bridge because OSHAL already authenticates through OIDC and already resolves role claims through the RBAC policy layer.

Supported current bridge:

- IdP emits role or group claims in the OIDC token.
- OSHAL extracts roles from `realm_access.roles`, `resource_access[*].roles`, or flat `roles[]`.
- OSHAL maps IdP role names to coarse product roles.
- `OSHAL_RBAC_ENFORCE=true` turns the mapped role into enforced route permissions.

Code:

- `src/features/governance/rbac/claims.ts`
- `src/features/governance/rbac/policy.ts`
- `src/features/governance/rbac/roles.ts`

Tests:

- `src/features/governance/rbac/claims.test.ts`

## Role Mapping

| OSHAL Role | Default Claim Names | Override Env |
|---|---|---|
| `admin` | `oshal-admin`, `admin` | `OSHAL_RBAC_ADMIN_ROLES` |
| `operator` | `oshal-operator`, `operator` | `OSHAL_RBAC_OPERATOR_ROLES` |
| `viewer` | `oshal-viewer`, `viewer` | `OSHAL_RBAC_VIEWER_ROLES` |

The existing operator allowlist still works:

- `OSHAL_OPERATOR_SUBS`
- `OSHAL_OPERATOR_EMAILS`
- `OSHAL_RBAC_OPERATOR_SUBS`
- `OSHAL_RBAC_OPERATOR_EMAILS`

Highest privilege wins when claim roles and allowlists overlap.

## Entra / Google / Keycloak Setup Pattern

1. Create IdP groups for `oshal-admin`, `oshal-operator`, and `oshal-viewer`.
2. Configure the OIDC application to include group or app role names in token claims.
3. If the IdP emits custom names, set the matching `OSHAL_RBAC_*_ROLES` env vars.
4. Set `OSHAL_RBAC_ENFORCE=true` only after admin/operator/viewer negative-path tests pass.
5. Verify `/api/governance/whoami` shows the expected role and permissions.
6. Verify `/admin/` shows RBAC as enforcing and the expected operator identity.

## What This Solves

- Enterprise IT can assign users to admin/operator/viewer roles from its directory.
- OSHAL no longer needs a redeploy for every privilege change when the IdP emits role claims.
- Procurement has a concrete joiner/mover/leaver bridge before full SCIM.

## What Full SCIM Still Needs

Full SCIM is still open work:

- `POST /scim/v2/Users`
- `GET /scim/v2/Users`
- `PATCH /scim/v2/Users/:id`
- `DELETE /scim/v2/Users/:id` or active=false deprovisioning
- `GET /scim/v2/Groups`
- `PATCH /scim/v2/Groups/:id`
- SCIM bearer-token management
- tenant-scoped provisioning policy
- audit events for every provision/deprovision action

## Procurement Answer

Current answer:

OSHAL supports a documented, tested directory-role bridge through OIDC claims. This is enough for a design-partner enterprise pilot using Entra, Google Workspace, or Keycloak role/group claims. Full SCIM lifecycle automation remains a public-enterprise gap and should be implemented before broad enterprise self-serve.
