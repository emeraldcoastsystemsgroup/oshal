/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep reserved management roles outside business-role and grant evaluation.
 */
/** Shared deterministic permission semantics; business adapters remain authoritative over records. */
import { createHash } from 'node:crypto';
import { applicationManagementRole, type AuthorizationActor, type AuthorizationAppRegistration, type AuthorizationGrant, type AuthorizationOperation, type AuthorizationTier } from '@/shared/application-authorization';
import type { AuthorizationAssignment, AuthorizationState } from './types';
import { ApplicationAuthorizationError } from './types';
export const TIER_ORDER: AuthorizationTier[] = ['deny', 'viewer', 'editor', 'admin'];
export const APP_ADMIN_ROLE = '@app-admin';
export interface RegisteredAuthorizationApp extends AuthorizationAppRegistration { catalogRevision: string }
export function catalogRevision(app: AuthorizationAppRegistration): string {
  return createHash('sha256').update(canonical({ app: app.app, source: app.source, catalog: app.catalog })).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function assertActor(actor: AuthorizationActor): void {
  if (!actor || !actor.isActive || !validSubject(actor.sub) || !validSubject(actor.issuer)) throw new ApplicationAuthorizationError(401, 'authorization_identity_required');
}
export function validSubject(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
export function managementAllowed(actor: AuthorizationActor, app: string, tenantId: string | undefined, permission: 'read' | 'assign' | 'directory'): boolean {
  if (!actor.isActive || !validSubject(actor.sub) || !validSubject(actor.issuer)) return false;
  if (actor.allowedPermissions && !actor.allowedPermissions.includes(`platform:authorization.${permission}`)) return false;
  if (actor.isSwarmAdmin) return true;
  return (actor.managementScopes ?? []).some(scope => scope.app === app && scope.permissions.includes(permission)
    && (scope.tenantId === undefined || scope.tenantId === tenantId));
}
export function requireManagement(actor: AuthorizationActor, app: string, tenantId: string | undefined, permission: 'read' | 'assign' | 'directory'): void {
  assertActor(actor);
  if (!managementAllowed(actor, app, tenantId, permission)) throw new ApplicationAuthorizationError(403, 'authorization_management_denied');
}
export interface ResolvedAssignments { rows: AuthorizationAssignment[]; unknownDirectory: boolean; stale: boolean }
export function matchingAssignments(state: AuthorizationState, app: RegisteredAuthorizationApp, actor: AuthorizationActor, tenantId: string | undefined, now: number): ResolvedAssignments {
  let unknownDirectory = false; let stale = false;
  const rows = state.assignments.filter(row => {
    if (row.app !== app.app || row.source !== app.source || (row.tenantId !== tenantId && !(row.deny && row.tenantId === undefined))) return false;
    if (row.expiresAt && Date.parse(row.expiresAt) <= now) return false;
    let matches = row.targetSub === actor.sub && row.targetIssuer === actor.issuer;
    if (row.group) {
      const group = row.group;
      const evidence = actor.directory?.find(item => item.issuer === group.issuer && item.tenantId === group.tenantId);
      const age = evidence ? now - Date.parse(evidence.observedAt) : Infinity;
      if (!evidence || !evidence.complete || !Number.isFinite(age) || age < 0 || age > 300_000) { unknownDirectory = true; return false; }
      matches = evidence.groups.includes(group.id);
    }
    if (!matches) return false;
    if (row.catalogRevision !== app.catalogRevision) { stale = true; return row.deny; }
    return true;
  });
  return { rows, unknownDirectory, stale };
}
export function resolveGrantSet(app: RegisteredAuthorizationApp, rows: AuthorizationAssignment[], explicitTier?: AuthorizationTier): { tier: AuthorizationTier; roles: string[]; grants: AuthorizationGrant[]; denied: boolean } {
  const denied = rows.some(row => row.deny && !row.permission) || explicitTier === 'deny';
  const roles = [...new Set(rows.filter(row => !row.deny && row.role && !applicationManagementRole(row.role)).map(row => row.role!))];
  let tier: AuthorizationTier = 'deny'; const grants: AuthorizationGrant[] = [];
  if (!app.catalog && explicitTier === 'admin' && !roles.includes(APP_ADMIN_ROLE)) roles.push(APP_ADMIN_ROLE);
  for (const roleName of roles) {
    if (!app.catalog && roleName === APP_ADMIN_ROLE) { tier = 'admin'; continue; }
    const role = app.catalog?.roles[roleName];
    if (!role) continue;
    if (TIER_ORDER.indexOf(role.tier) > TIER_ORDER.indexOf(tier)) tier = role.tier;
    grants.push(...role.grants);
  }
  if (explicitTier && TIER_ORDER.indexOf(explicitTier) < TIER_ORDER.indexOf(tier)) tier = explicitTier;
  if (app.access && !app.access.supported.includes(tier)) tier = 'deny';
  return { tier: denied ? 'deny' : tier, roles, denied, grants: grants.filter(grant => !rows.some(row => row.deny && row.permission === grant.permission)) };
}
export function resolveOperationPermissions(app: RegisteredAuthorizationApp, input: AuthorizationOperation): string[] | null {
  if (!app.catalog) return [];
  if (input.permission) return Object.prototype.hasOwnProperty.call(app.catalog.permissions, input.permission) ? [input.permission] : null;
  const kind = input.kind ?? 'http'; const bindings = app.catalog.bindings[kind] ?? [];
  if (kind !== 'http') return bindings.find(binding => binding.id === input.operation)?.allOf ?? null;
  const pathname = input.path;
  if (!pathname || pathname.includes('?') || pathname.includes('#') || /[%\\]/.test(pathname) || pathname.includes('//')) return null;
  const paths = [pathname, ...(app.mountPaths ?? []).filter(mount => pathname.startsWith(`${mount}/`) || pathname === mount).map(mount => pathname.slice(mount.length) || '/')];
  const method = (input.method ?? '').toUpperCase();
  const matches = bindings.filter(binding => binding.method === method && paths.some(candidate => {
    const expected = binding.path!.split('/'); const actual = candidate.split('/');
    return actual.length === expected.length && expected.every((part, i) => part === actual[i] || (part.startsWith(':') && Boolean(actual[i]) && actual[i] !== '.' && actual[i] !== '..'));
  }));
  return matches.length === 1 ? matches[0].allOf : null;
}
