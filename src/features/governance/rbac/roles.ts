/**
 * RBAC roles + permissions catalog (enterprise-governance scaffolding).
 *
 * ADDITIVE and backward compatible. This deployment has NO IdP role claims and NO fine-grained
 * roles today (see src/shared/middleware/authz.ts): the only privileged identity is the operator
 * allowlist (OSHAL_OPERATOR_SUBS / OSHAL_OPERATOR_EMAILS). This module names a small, stable set
 * of roles and permissions so apps can OPT IN to checks without changing today's behavior. The
 * `admin` role is DERIVED from the existing operator allowlist (see policy.ts resolveRole), so an
 * operator stays an admin and nobody new is granted anything by merging this code.
 *
 * Pure data + types only — no DB, no env reads, no side effects. policy.ts holds the logic.
 *
 * @module features/governance/rbac/roles
 */

/** The three coarse roles. `admin` == today's operator; `operator` and `viewer` are config-set. */
export const Role = {
  Viewer: 'viewer',
  Operator: 'operator',
  Admin: 'admin',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

/** All known roles, lowest privilege first. */
export const ALL_ROLES: readonly Role[] = [Role.Viewer, Role.Operator, Role.Admin];

/**
 * Fine-grained permissions. Kept intentionally small and additive; apps reference these strings
 * when they choose to gate a route. Anything not listed here is treated as an unknown permission
 * and (when enforcement is ON) denied to non-admins by default.
 */
export const Permission = {
  TicketRead: 'ticket.read',
  TicketWrite: 'ticket.write',
  AuditRead: 'audit.read',
  AuditExport: 'audit.export',
  GovernanceAdmin: 'governance.admin',
  ToolApprove: 'tool.approve',
  VaultAccess: 'vault.access',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/** Every permission string, for validation / enumeration. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/**
 * Default role -> permission grants. Admin gets everything (it IS the operator allowlist, which
 * already bypasses object-level checks via isOperator/canAccessResource). Operator is a working
 * privileged role short of full governance/vault. Viewer is read-only on its own resources.
 *
 * NOTE: this map is ONLY consulted when OSHAL_RBAC_ENFORCE is on. With enforcement off (the
 * default) policy.can() short-circuits to ALLOW for everyone, preserving current access.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  [Role.Admin]: [
    Permission.TicketRead,
    Permission.TicketWrite,
    Permission.AuditRead,
    Permission.AuditExport,
    Permission.GovernanceAdmin,
    Permission.ToolApprove,
    Permission.VaultAccess,
  ],
  [Role.Operator]: [
    Permission.TicketRead,
    Permission.TicketWrite,
    Permission.AuditRead,
    Permission.ToolApprove,
  ],
  [Role.Viewer]: [Permission.TicketRead, Permission.AuditRead],
};

/** Does a role hold a permission per the default grant map? Unknown role -> false. */
export function roleHasPermission(role: Role, permission: Permission): boolean {
  const grants = ROLE_PERMISSIONS[role];
  return Array.isArray(grants) && grants.includes(permission);
}
