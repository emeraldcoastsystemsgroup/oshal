/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Define core access-administrator and auditor templates without granting business permissions.
 */
import type { AuthorizationManagementRoleDefinition } from './types';

const ROLES: AuthorizationManagementRoleDefinition[] = [
  { id: '@access-admin', label: 'Application access administrator', scope: 'application',
    description: 'Read and manage business-role assignments and directory mappings for the assigned application and tenant. Cannot delegate access-management roles or administer the swarm.',
    permissions: ['read', 'assign', 'directory'] },
  { id: '@access-auditor', label: 'Application access auditor', scope: 'application',
    description: 'Read assigned application access, effective permissions and scoped audit history. Cannot change access or read business records.',
    permissions: ['read'] },
];

/** @description Return independent public copies of core-defined management templates.
 * @returns Explicit application-scoped roles, never a wildcard or business permission.
 */
export function applicationManagementRoles(): AuthorizationManagementRoleDefinition[] {
  return structuredClone(ROLES);
}

/** @description Resolve a reserved core role identifier without consulting an imported catalog.
 * @param id Candidate role name. @returns Its immutable meaning as an independent copy, or undefined.
 */
export function applicationManagementRole(id: string | undefined): AuthorizationManagementRoleDefinition | undefined {
  const role = ROLES.find(value => value.id === id);
  return role ? structuredClone(role) : undefined;
}
