/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Derive current application management scopes from the existing revision-bound assignment store.
 */
import { applicationManagementRole, type AuthorizationActor, type AuthorizationManagementScope } from '@/shared/application-authorization';
import { matchingAssignments, type RegisteredAuthorizationApp } from './policy';
import type { AuthorizationState } from './types';

/** @description Resolve direct or verified-group management roles under the same expiry, source and deny rules as business assignments.
 * @param state Current policy snapshot. @param app Current registered application. @param actor Exact current subject.
 * @param tenantId Selected business tenant. @param now Current clock. @returns Current core role IDs only.
 */
export function resolveManagementRoles(state: AuthorizationState, app: RegisteredAuthorizationApp,
  actor: AuthorizationActor, tenantId: string | undefined, now: number): string[] {
  if (!actor.isActive || (tenantId && !actor.tenantIds?.includes(tenantId))) return [];
  const resolved = matchingAssignments(state, app, actor, tenantId, now);
  if (resolved.stale || resolved.unknownDirectory || resolved.rows.some(row => row.deny && !row.permission)) return [];
  return [...new Set(resolved.rows.filter(row => !row.deny && applicationManagementRole(row.role)).map(row => row.role!))];
}

/** @description Expand fixed role templates into explicit current scopes; never grants business permission or swarm administration.
 * @param state Current policy snapshot. @param apps Active registrations. @param actor Verified subject.
 * @param now Current clock. @returns Explicit per-application and per-tenant management scopes.
 */
export function storedManagementScopes(state: AuthorizationState, apps: Iterable<RegisteredAuthorizationApp>,
  actor: AuthorizationActor, now: number): AuthorizationManagementScope[] {
  const scopes: AuthorizationManagementScope[] = [];
  for (const app of apps) {
    const tenants = new Set(state.assignments.filter(row => row.app === app.app && applicationManagementRole(row.role)).map(row => row.tenantId));
    for (const tenantId of tenants) {
      const roles = resolveManagementRoles(state, app, actor, tenantId, now);
      const permissions = [...new Set(roles.flatMap(role => applicationManagementRole(role)!.permissions))];
      if (permissions.length) scopes.push({ app: app.app, tenantId, permissions });
    }
  }
  return scopes;
}

/** @description Merge only server-trusted explicit scope sources, preserving tenant boundaries.
 * @param sources Authenticated composition scopes and current persisted-role scopes. @returns Deduplicated scopes.
 */
export function mergeManagementScopes(...sources: Array<AuthorizationManagementScope[] | undefined>): AuthorizationManagementScope[] {
  const scopes = new Map<string, AuthorizationManagementScope>();
  for (const scope of sources.flatMap(source => source ?? [])) {
    const key = JSON.stringify([scope.app, scope.tenantId]); const previous = scopes.get(key);
    scopes.set(key, { ...scope, permissions: [...new Set([...(previous?.permissions ?? []), ...scope.permissions])] });
  }
  return [...scopes.values()];
}
