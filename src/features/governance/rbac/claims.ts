/**
 * OIDC role-claim extraction for RBAC (Keycloak-shaped, additive).
 *
 * Today the only privileged identity is the env operator allowlist (authz.ts). That works for a
 * single operator but does not scale: every grant is a config edit + redeploy. This module lets
 * roles come from the **IdP token** instead — the way an enterprise plugs its directory in. It reads
 * the standard Keycloak locations (`realm_access.roles`, `resource_access[client].roles`) plus a
 * flat `roles` fallback, and maps the IdP's role NAMES to OSHAL's coarse roles via configurable
 * name lists. Claim-derived roles are unioned with the env allowlist (highest privilege wins), so
 * nothing existing is lost and no one is granted anything until a token actually carries the role.
 *
 * Pure: no env writes, no IO. The role-name→OSHAL-role mapping is read from env (injectable).
 *
 * @module features/governance/rbac/claims
 */

import { Role } from './roles';

/** Subset of an OIDC userinfo/token payload that may carry roles. */
export interface OidcRoleClaims {
  realm_access?: { roles?: unknown } | null;
  resource_access?: Record<string, { roles?: unknown } | null> | null;
  /** Some IdPs / mappers flatten roles to a top-level array. */
  roles?: unknown;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * @description Collect every role name present in an OIDC user object, lowercased + de-duplicated.
 * Looks in realm_access.roles, every resource_access[*].roles, and a flat roles[]. Never throws on
 * a malformed shape — missing/wrong-typed fields just contribute nothing.
 */
export function rolesFromClaims(user: unknown): string[] {
  if (!user || typeof user !== 'object') return [];
  const u = user as OidcRoleClaims;
  const out = new Set<string>();

  for (const r of asStringArray(u.realm_access?.roles)) out.add(r.toLowerCase());
  if (u.resource_access && typeof u.resource_access === 'object') {
    for (const client of Object.values(u.resource_access)) {
      for (const r of asStringArray(client?.roles)) out.add(r.toLowerCase());
    }
  }
  for (const r of asStringArray(u.roles)) out.add(r.toLowerCase());

  return [...out];
}

function nameList(value: string | undefined, defaults: string[]): Set<string> {
  const parsed = (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return new Set(parsed.length > 0 ? parsed : defaults);
}

/**
 * @description Map a set of IdP role names to the highest OSHAL role they imply, or null when none
 * match. Mapping names are configurable:
 *   - OSHAL_RBAC_ADMIN_ROLES    (default: "oshal-admin,admin")
 *   - OSHAL_RBAC_OPERATOR_ROLES (default: "oshal-operator,operator")
 *   - OSHAL_RBAC_VIEWER_ROLES   (default: "oshal-viewer,viewer")
 * Highest privilege wins (admin > operator > viewer).
 *
 * @param claimRoles Lowercased role names from {@link rolesFromClaims}.
 * @param env Environment (injectable for tests).
 */
export function mapClaimRolesToRole(
  claimRoles: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Role | null {
  if (claimRoles.length === 0) return null;
  const have = new Set(claimRoles.map((r) => r.toLowerCase()));
  const admin = nameList(env.OSHAL_RBAC_ADMIN_ROLES, ['oshal-admin', 'admin']);
  const operator = nameList(env.OSHAL_RBAC_OPERATOR_ROLES, ['oshal-operator', 'operator']);
  const viewer = nameList(env.OSHAL_RBAC_VIEWER_ROLES, ['oshal-viewer', 'viewer']);

  if ([...admin].some((r) => have.has(r))) return Role.Admin;
  if ([...operator].some((r) => have.has(r))) return Role.Operator;
  if ([...viewer].some((r) => have.has(r))) return Role.Viewer;
  return null;
}
