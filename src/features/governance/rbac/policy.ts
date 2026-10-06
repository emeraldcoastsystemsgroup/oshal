/**
 * RBAC policy engine (enterprise-governance scaffolding).
 *
 * Pure, unit-testable decision functions plus a thin Express middleware factory. The CORE rule is
 * backward compatibility: with OSHAL_RBAC_ENFORCE off (the DEFAULT), `can()` returns ALLOW for
 * everyone and `rbacMiddleware()` is a no-op, so merging this changes nobody's access. Enforcement
 * is strictly opt-in.
 *
 * Role derivation matches the existing authorization model in src/shared/middleware/authz.ts:
 *   - admin    = a swarm_roles `root`/`admin` row (ADR-148), OR a hit on the operator allowlist
 *                (OSHAL_OPERATOR_SUBS / OSHAL_OPERATOR_EMAILS), so today's operators stay fully
 *                privileged and an admin granted from the Users page is recognised here too.
 *                Rows and allowlists are matched exactly as isOperator matches them, bound to the
 *                caller's verified issuer (authz operatorMatchKeys, ADR-174 Amendment A).
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
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-148 alignment: resolveRole now reads the swarm_roles snapshot FIRST, via the same synchronous privileged-identity cache isOperatorIdentity uses. This module's own header already promised it 'matches the existing authorization model in authz.ts', and that stopped being true the day roles became rows: an admin granted on the Users page passed requiresOperator and appeared in the cockpit rail, while /admin's Current Operator panel resolved them from .env alone and could still call them a viewer with no role claims. Enforcement default (OFF) is untouched, so this changes a DISPLAY today and closes a latent gap for any deployment that turns OSHAL_RBAC_ENFORCE on. The env allowlists stay exactly as they are — break-glass is permanent (ADR-148 D4).
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Export onBreakGlassAllowlist. resolveRole collapses the three axes to one role, which is right for a gate and wrong for a surface: the joined access review has to name WHICH axis granted the role, and the environment allowlists were only reachable through a private helper.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | ADR-174 Amendment A (admin is a role on a person's own account). (1) The admin console is restricted once the deployment names ANY privileged identity: isAdminConsoleRestricted = an operator allowlist entry OR a swarm_roles root/admin (isOperatorRolesConfigured, read from the privileged-identity snapshot and still true after a failed refresh). Before, requireAdminConsoleAccess read only the env allowlist, so emptying it after roles were granted opened /admin and the readiness route to every signed-in user. The permissive bootstrap survives only with neither, and only once the role table has loaded (review: the boot window and a failed first load are not a fresh install). isOperatorAllowlistConfigured counts parsed entries, so a whitespace-only OSHAL_OPERATOR_SUBS no longer hides a populated OSHAL_OPERATOR_EMAILS. (2) RbacCaller carries the verified principal issuer (callerFromRequest reads getAuthenticatedPrincipalIssuer), and resolveRole and onBreakGlassAllowlist match the swarm_roles snapshot and the environment allowlists through authz's operatorMatchKeys: a local-issuer principal matches by subject only, because its email was never verified.
 *
 * @module features/governance/rbac/policy
 */

import type { Request, RequestHandler } from 'express';
import { Role, type Permission, ROLE_PERMISSIONS } from './roles';
import { rolesFromClaims, mapClaimRolesToRole } from './claims';
import { isPrivilegedIdentity, privilegedIdentityStatus } from '@/shared/middleware/privileged-identities';
import { operatorMatchKeys, operatorRequestIssuer } from '@/shared/middleware/authz';

/** Minimal caller shape — same fields getCaller() in authz.ts produces, plus optional IdP roles. */
export interface RbacCaller {
  sub: string | null;
  email: string | null;
  /** Role names from the OIDC token (Keycloak realm/resource roles). Optional; absent = today's behavior. */
  roles?: string[];
  /**
   * The verified principal issuer: set by callerFromRequest (null when the request carries none),
   * and the sub- and email-keyed role sources bind to it (authz operatorMatchKeys). Absent = a
   * caller described by identity alone, matched as before.
   */
  issuer?: string | null;
}

/**
 * @description The caller as the sub- and email-keyed role sources may match it (swarm_roles and
 * the environment allowlists): authz's operatorMatchKeys over the caller's issuer. A local
 * principal matches by subject only.
 * @param caller - The caller to bind.
 * @returns The same caller with the keys it may not be matched by cleared.
 */
function matchableCaller(caller: RbacCaller): RbacCaller {
  const keys = operatorMatchKeys(caller.sub, caller.email, caller.issuer);
  return { ...caller, sub: keys.sub, email: keys.email };
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
 * @description The role, if any, that the operator-local BREAK-GLASS allowlists confer on this
 * caller — `OSHAL_OPERATOR_*` (admin) and `OSHAL_RBAC_OPERATOR_*` (operator). It is separate from
 * resolveRole because a surface has to distinguish a role that lives in `swarm_roles` and can be
 * revoked from a browser from one that exists only in a file nobody can see or audit (ADR-148 D4).
 *
 * @param caller - The identity to test; `sub` matches exactly, `email` case-insensitively, both
 *   bound to the caller's issuer when it has one.
 * @returns Admin, Operator, or null when neither allowlist names this caller.
 */
export function onBreakGlassAllowlist(caller: RbacCaller | null | undefined): Role | null {
  const identity: RbacCaller = matchableCaller(caller ?? { sub: null, email: null });
  if (onAllowlist(identity, process.env.OSHAL_OPERATOR_SUBS, process.env.OSHAL_OPERATOR_EMAILS)) return Role.Admin;
  if (onAllowlist(identity, process.env.OSHAL_RBAC_OPERATOR_SUBS, process.env.OSHAL_RBAC_OPERATOR_EMAILS)) return Role.Operator;
  return null;
}

/**
 * Map a caller to a role, combining two sources (highest privilege wins):
 *   1. IdP token roles (caller.roles, Keycloak realm/resource roles) mapped via OSHAL_RBAC_*_ROLES.
 *      This is how an enterprise grants admin from its directory without an env edit/redeploy.
 *   2. The env allowlists — operator allowlist (the existing OSHAL_OPERATOR_*) -> admin, consistent
 *      with isOperator() in authz.ts; the optional OSHAL_RBAC_OPERATOR_* allowlist -> operator.
 * Everyone else (including unauthenticated) is `viewer`. Backward compatible: with no token roles
 * and no allowlist hit, the result is `viewer` exactly as before. The swarm_roles snapshot and the
 * allowlists are matched with the keys the caller's issuer allows (see matchableCaller); the IdP
 * token roles are the identity provider's own grant and are read as they are.
 */
export function resolveRole(caller: RbacCaller | null | undefined): Role {
  const c: RbacCaller = caller ?? { sub: null, email: null };
  const keys = matchableCaller(c);

  // Start from the claim-derived role (if any), then let roles and the allowlists raise it.
  let role: Role = mapClaimRolesToRole(c.roles ?? []) ?? Role.Viewer;

  // swarm_roles first (ADR-148). root and admin are both swarm administrators, so both map to
  // Admin here — this engine's ranks are about governance permissions, not about who owns the
  // swarm, and it has no rank above Admin to distinguish them with. Reads the same synchronous
  // snapshot as isOperatorIdentity, so a grant or revoke is effective on the next request.
  if (isPrivilegedIdentity(keys.sub, keys.email)) {
    role = higher(role, Role.Admin);
  }

  if (onAllowlist(keys, process.env.OSHAL_OPERATOR_SUBS, process.env.OSHAL_OPERATOR_EMAILS)) {
    role = higher(role, Role.Admin);
  } else if (onAllowlist(keys, process.env.OSHAL_RBAC_OPERATOR_SUBS, process.env.OSHAL_RBAC_OPERATOR_EMAILS)) {
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

/**
 * Read the caller off a request the same way authz.getCaller does (OIDC session only), plus IdP
 * roles and the verified principal issuer the role sources bind to (null when the request has none).
 */
export function callerFromRequest(req: Request): RbacCaller {
  const user = (req as { oidc?: { user?: { sub?: string; email?: string; preferred_username?: string } } }).oidc?.user;
  const sub = user?.sub ? String(user.sub) : null;
  const rawEmail = user?.email || user?.preferred_username || '';
  const email = rawEmail ? String(rawEmail).toLowerCase() : null;
  return { sub, email, roles: rolesFromClaims(user), issuer: operatorRequestIssuer(req) };
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
  return parseSubjectAllowlist(process.env.OSHAL_OPERATOR_SUBS).size > 0 || parseEmailAllowlist(process.env.OSHAL_OPERATOR_EMAILS).size > 0;
}

/**
 * Does swarm_roles hold a root or admin (ADR-148)? Read from the privileged-identity snapshot, and
 * still true after a failed refresh dropped the identities, so an unreadable role table is never
 * mistaken for a fresh install. Mirrors the `operatorRolesConfigured` posture signal.
 */
export function isOperatorRolesConfigured(): boolean {
  return privilegedIdentityStatus().rolesConfigured;
}

/**
 * Is the admin console restricted to admins? Yes once the deployment names ANY privileged identity:
 * an operator allowlist entry or a swarm_roles root/admin. Emptying the allowlists after roles were
 * granted must not open the console; only a fresh install with neither has nobody to lock out. And
 * "neither" is known only once the role table has loaded: until the first successful load (the boot
 * window, or a load that failed) the console stays restricted, because an unread table is not a
 * fresh install. The env allowlist is the way in meanwhile.
 */
function isAdminConsoleRestricted(): boolean {
  const roles = privilegedIdentityStatus();
  return isOperatorAllowlistConfigured() || roles.rolesConfigured || !roles.loaded;
}

/**
 * Admin-only access gate that is INDEPENDENT of OSHAL_RBAC_ENFORCE. The admin console exposes
 * tenant, governance, connector, and cost data, so in any multi-user deployment it must be
 * admin-only REGARDLESS of whether fine-grained RBAC enforcement is switched on (it is off by
 * default, which is exactly why rbacMiddleware can't protect this surface yet). The rule:
 *   - an operator allowlist or a swarm_roles root/admin exists, or the role table has not loaded
 *     yet -> only an Admin-resolved caller passes; everyone else 403.
 *   - neither, after a successful load                          -> permissive (fresh install /
 *     local MOCK_OIDC not locked out).
 * Mount AFTER requiresAuth so req.oidc.user is populated.
 *
 * @returns Express middleware enforcing admin-only access to the admin console surface.
 */
export function requireAdminConsoleAccess(): RequestHandler {
  return (req, res, next) => {
    if (!isAdminConsoleRestricted()) {
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
