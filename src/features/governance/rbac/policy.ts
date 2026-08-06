/**
 * RBAC policy engine (enterprise-governance scaffolding).
 *
 * Pure, unit-testable decision functions plus a thin Express middleware factory. The CORE rule is
 * backward compatibility: with OSHAL_RBAC_ENFORCE off (the DEFAULT), `can()` returns ALLOW for
 * everyone and `rbacMiddleware()` is a no-op, so merging this changes nobody's access. Enforcement
 * is strictly opt-in.
 *
 * Role derivation matches the existing authorization model in src/shared/middleware/authz.ts:
 *   - admin    = a hit on the operator allowlist (OSHAL_OPERATOR_SUBS / OSHAL_OPERATOR_EMAILS),
 *                so today's operators stay fully privileged.
 *   - operator = a caller on a separate OSHAL_RBAC_OPERATOR_SUBS / _EMAILS allowlist (optional).
 *   - viewer   = any other authenticated caller (the safe default role).
 *
 * No DB writes, no logging side effects, no throws on the decision path.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Preserve exact, case-sensitive OIDC subjects in privileged admin/operator allowlist checks; configuration delimiters are still trimmed and email matching remains case-insensitive.
 *
 * @module features/governance/rbac/policy
 */

import type { Request, RequestHandler } from 'express';
import { Role, type Permission, ROLE_PERMISSIONS } from './roles';
import { rolesFromClaims, mapClaimRolesToRole } from './claims';

/** Minimal caller shape — same fields getCaller() in authz.ts produces, plus optional IdP roles. */
export interface RbacCaller {
  sub: string | null;
  email: string | null;
  /** Role names from the OIDC token (Keycloak realm/resource roles). Optional; absent = today's behavior. */
  roles?: string[];
}

/** Rank for "highest privilege wins" when combining claim- and allowlist-derived roles. */
const ROLE_RANK: Record<Role, number> = { [Role.Viewer]: 0, [Role.Operator]: 1, [Role.Admin]: 2 };

function higher(a: Role, b: Role | null): Role {
  if (!b) return a;
  return ROLE_RANK[b] > ROLE_RANK[a] ? b : a;
}

/** Optional context for a permission decision (e.g. resource owner for owner-or-admin checks). */
export interface RbacContext {
  ownerSub?: string | null;
}

/** Is enforcement turned on? Default OFF -> permissive (current behavior preserved). */
export function isEnforcementEnabled(): boolean {
  return (process.env.OSHAL_RBAC_ENFORCE ?? 'false').toLowerCase().trim() === 'true';
}

/** Parse case-sensitive subject identifiers, trimming only configuration delimiters. */
function parseSubjectAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

/** Parse email allowlists case-insensitively; email is not the OIDC subject namespace. */
function parseEmailAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

function onAllowlist(caller: RbacCaller, subsEnv: string | undefined, emailsEnv: string | undefined): boolean {
  const subs = parseSubjectAllowlist(subsEnv);
  const emails = parseEmailAllowlist(emailsEnv);
  if (caller.sub && subs.has(caller.sub)) return true;
  if (caller.email && emails.has(caller.email.toLowerCase())) return true;
  return false;
}

/**
 * Map a caller to a role, combining two sources (highest privilege wins):
 *   1. IdP token roles (caller.roles, Keycloak realm/resource roles) mapped via OSHAL_RBAC_*_ROLES.
 *      This is how an enterprise grants admin from its directory without an env edit/redeploy.
 *   2. The env allowlists — operator allowlist (the existing OSHAL_OPERATOR_*) -> admin, consistent
 *      with isOperator() in authz.ts; the optional OSHAL_RBAC_OPERATOR_* allowlist -> operator.
 * Everyone else (including unauthenticated) is `viewer`. Backward compatible: with no token roles
 * and no allowlist hit, the result is `viewer` exactly as before.
 */
export function resolveRole(caller: RbacCaller | null | undefined): Role {
  const c: RbacCaller = caller ?? { sub: null, email: null };

  // Start from the claim-derived role (if any), then let the allowlists raise it.
  let role: Role = mapClaimRolesToRole(c.roles ?? []) ?? Role.Viewer;

  if (onAllowlist(c, process.env.OSHAL_OPERATOR_SUBS, process.env.OSHAL_OPERATOR_EMAILS)) {
    role = higher(role, Role.Admin);
  } else if (onAllowlist(c, process.env.OSHAL_RBAC_OPERATOR_SUBS, process.env.OSHAL_RBAC_OPERATOR_EMAILS)) {
    role = higher(role, Role.Operator);
  }
  return role;
}

/**
 * Permission decision. ALLOW for everyone when enforcement is off (backward compatible). When on,
 * the caller's resolved role must hold the permission per ROLE_PERMISSIONS, OR the caller owns the
 * contextual resource (owner-or-admin pattern, mirroring canAccessResource). Admin always allowed.
 */
export function can(caller: RbacCaller | null | undefined, permission: Permission, ctx?: RbacContext): boolean {
  if (!isEnforcementEnabled()) return true;
  const role = resolveRole(caller);
  if (role === Role.Admin) return true;
  if (ctx?.ownerSub && caller?.sub && ctx.ownerSub === caller.sub) return true;
  const grants = ROLE_PERMISSIONS[role] ?? [];
  return grants.includes(permission);
}

/** Read the caller off a request the same way authz.getCaller does (OIDC session only), plus IdP roles. */
export function callerFromRequest(req: Request): RbacCaller {
  const user = (req as { oidc?: { user?: { sub?: string; email?: string; preferred_username?: string } } }).oidc?.user;
  const sub = user?.sub ? String(user.sub) : null;
  const rawEmail = user?.email || user?.preferred_username || '';
  const email = rawEmail ? String(rawEmail).toLowerCase() : null;
  return { sub, email, roles: rolesFromClaims(user) };
}

/**
 * Express middleware factory. Returns a handler that, when enforcement is OFF, calls next()
 * immediately (a no-op gate, so existing routes behave exactly as before). When ON, it denies with
 * 403 if the caller lacks `permission`. Mount it AFTER requiresAuth so req.oidc.user is populated.
 *
 * The owner-context branch is not available here (a generic middleware does not know the resource
 * owner); use can(caller, permission, { ownerSub }) inline in a handler for owner-or-admin gates.
 */
export function rbacMiddleware(permission: Permission): RequestHandler {
  return (req, res, next) => {
    if (!isEnforcementEnabled()) {
      next();
      return;
    }
    if (can(callerFromRequest(req), permission)) {
      next();
      return;
    }
    res.status(403).json({ error: 'forbidden', requiredPermission: permission });
  };
}

/**
 * Is an operator allowlist configured? Mirrors the `operatorAllowlistConfigured` posture signal.
 * When true, the deployment has a notion of privileged identity and the admin surface should be
 * restricted to it; when false (fresh install / single-user / MOCK_OIDC local dev) there is no
 * one to lock out, so admin-only gates stay permissive.
 */
export function isOperatorAllowlistConfigured(): boolean {
  return Boolean((process.env.OSHAL_OPERATOR_SUBS || process.env.OSHAL_OPERATOR_EMAILS || '').trim());
}

/**
 * Admin-only access gate that is INDEPENDENT of OSHAL_RBAC_ENFORCE. The admin console exposes
 * tenant, governance, connector, and cost data, so in any multi-user deployment it must be
 * admin-only REGARDLESS of whether fine-grained RBAC enforcement is switched on (it is off by
 * default, which is exactly why rbacMiddleware can't protect this surface yet). The rule:
 *   - operator allowlist configured -> only an Admin-resolved caller passes; everyone else 403.
 *   - no allowlist configured        -> permissive (solo operator / local MOCK_OIDC not locked out).
 * Mount AFTER requiresAuth so req.oidc.user is populated.
 *
 * @returns Express middleware enforcing admin-only access to the admin console surface.
 */
export function requireAdminConsoleAccess(): RequestHandler {
  return (req, res, next) => {
    if (!isOperatorAllowlistConfigured()) {
      next();
      return;
    }
    if (resolveRole(callerFromRequest(req)) === Role.Admin) {
      next();
      return;
    }
    res.status(403).json({ error: 'forbidden', requiredRole: Role.Admin });
  };
}
