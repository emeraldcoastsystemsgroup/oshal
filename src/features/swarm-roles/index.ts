/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Swarm root (ADR-148): feature barrel. Everything outside this slice imports from '@/features/swarm-roles' — never a deep path into services/ (Feature-Sliced Design).
 */

export {
  ensureSwarmRoleSchema,
  listRoles,
  getRole,
  getRootSubFromStore,
  refreshPrivilegedCache,
  claimRoot,
  grantRole,
  revokeRole,
  transferRoot,
  SwarmRoleError,
} from './services/swarm-role-store';
export type { SwarmRole, SwarmRoleRow } from './services/swarm-role-store';
