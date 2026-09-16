/**
 * Where a swarm role actually CAME FROM.
 *
 * Three authorization axes grant privilege on this swarm and each is correct in isolation:
 * `swarm_roles` rows (ADR-148), IdP role claims on the caller's token, and the operator-local
 * break-glass allowlists in `.env`. `resolveRole()` deliberately collapses them to the single
 * highest role, which is the right answer for a GATE and the wrong answer for a SURFACE: an
 * operator whose only claim is a line in a file nobody can see or audit renders identically to
 * an admin granted from the Users page, and "why can I do this?" has no answer.
 *
 * This module answers that question and nothing else. It grants nothing, writes nothing, and
 * reads only the stores the gate already reads.
 *
 * A source is listed only when it confers privilege ABOVE viewer — every authenticated caller is
 * a viewer by default, so naming a source for that would be noise, not provenance.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Name every axis that independently confers a caller's swarm role, so a break-glass-only operator cannot render identically to a granted admin and an IdP-claim admin is no longer reported as break-glass.
 *
 * @module features/governance/rbac/grant-sources
 */

import { Role } from './roles';
import { mapClaimRolesToRole } from './claims';
import { onBreakGlassAllowlist, resolveRole, type RbacCaller } from './policy';
import { getRootSub, isPrivilegedIdentity, privilegedIdentityStatus } from '@/shared/middleware/privileged-identities';

/**
 * Every provenance label a joined access view may print. `app-assignment` is not produced here —
 * it belongs to the per-application axis (`features/application-authorization`) and is named in
 * this union so one surface can speak about all four with one vocabulary.
 */
export type GrantSource = 'swarm-role' | 'idp-claim' | 'break-glass' | 'app-assignment' | 'none';

/** The swarm-administration axis for one identity, with the provenance of the role it holds. */
export interface SwarmRoleGrant {
  /** The role the gate would resolve for this identity right now. */
  role: Role;
  /**
   * Every axis that INDEPENDENTLY confers a role above viewer, most durable first
   * (`swarm-role` > `idp-claim` > `break-glass`). Empty when the identity is a plain viewer.
   */
  sources: GrantSource[];
  /** The single label a surface shows: `sources[0]`, or `none`. */
  source: GrantSource;
  /** Does this identity hold swarm root (ADR-148)? */
  isRoot: boolean;
  /** Has anybody claimed swarm root on this swarm? */
  rootClaimed: boolean;
  /**
   * Has the `swarm_roles` snapshot ever loaded? "Roles have not loaded" is a different statement
   * from "you hold no role", and conflating them makes a fail-closed cache read as a bug.
   */
  rolesLoaded: boolean;
  /**
   * Was an email available to evaluate? False when only a subject identifier was known (an
   * administrator reviewing somebody else), in which case an EMAIL-only break-glass entry is
   * invisible to this answer and the surface must say so rather than imply the axis is clear.
   */
  emailEvaluated: boolean;
}

/**
 * @description Resolve one identity's swarm role together with the provenance of that role.
 * Reads exactly what the gate reads — the `swarm_roles` snapshot, the caller's IdP role claims
 * and the environment allowlists — and adds no grant path of its own.
 *
 * @param caller - The identity to describe. `email` may be null when only a subject is known.
 * @returns The resolved role plus every axis that independently confers it.
 */
export function resolveSwarmRoleGrant(caller: RbacCaller | null | undefined): SwarmRoleGrant {
  const identity: RbacCaller = caller ?? { sub: null, email: null };
  const sources: GrantSource[] = [];

  if (isPrivilegedIdentity(identity.sub, identity.email)) sources.push('swarm-role');

  const claimed = mapClaimRolesToRole(identity.roles ?? []);
  if (claimed === Role.Admin || claimed === Role.Operator) sources.push('idp-claim');

  if (onBreakGlassAllowlist(identity)) sources.push('break-glass');

  const status = privilegedIdentityStatus();
  return {
    role: resolveRole(identity),
    sources,
    source: sources[0] ?? 'none',
    isRoot: Boolean(identity.sub) && getRootSub() === identity.sub,
    rootClaimed: getRootSub() !== null,
    rolesLoaded: status.loaded,
    emailEvaluated: typeof identity.email === 'string' && identity.email.length > 0,
  };
}
