/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — SwarmAccessRole caller-role model (ADR-087). Bots and tools declare the caller roles allowed to discover/call them; omitting the declaration keeps them open to every caller (backward compatible). The first enforced caller role is 'jarvis', so internal/privileged machinery can be scoped out of the assistant's world without a per-bot boolean.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D3: SWARM_ACCESS_ROLES as data + isSwarmAccessRole(). The runtime list and the type are now ONE declaration, so a manifest validator can fail closed on an unknown role without a second copy drifting from the union.
 */

/**
 * @description A caller role in the swarm's access model. Enforcement surfaces
 * (Jarvis's tool feed / app catalog, the queue call-out for jarvis-sourced
 * tickets) identify themselves by role, and bots/tools declare which roles may
 * see and call them. Mirrors the guest-capability-matrix pattern: one shared
 * definition so enforcement and UI never drift.
 *
 * - 'operator' — human operator surfaces (cockpit admin panels, ops dashboards).
 * - 'swarm'    — the swarm's own machinery (queue manager, build pipeline, PM).
 * - 'jarvis'   — the unified assistant acting on a user's behalf (ADR-050).
 */
export const SWARM_ACCESS_ROLES = ['operator', 'swarm', 'jarvis'] as const;

/** @description A caller role in the swarm's access model (ADR-087). */
export type SwarmAccessRole = (typeof SWARM_ACCESS_ROLES)[number];

/**
 * @description Narrow an arbitrary manifest string to a known caller role (ADR-085 D3).
 *
 * The runtime list and the type are now one declaration, so a manifest validator can fail closed on
 * an unknown role without a second copy of the list drifting out of sync with the union.
 *
 * @param value - Candidate from a manifest's `bots[].accessRoles`.
 * @returns True when it names a real caller role.
 */
export function isSwarmAccessRole(value: unknown): value is SwarmAccessRole {
  return typeof value === 'string' && (SWARM_ACCESS_ROLES as readonly string[]).includes(value);
}

/**
 * @description Decides whether a caller role may access a bot/tool given its
 * declared access roles. An absent or empty declaration means unrestricted —
 * every existing bot/tool keeps its current reach until it is deliberately
 * scoped (ADR-087).
 * @param accessRoles - The roles declared on the bot/tool, if any.
 * @param caller - The role of the surface asking.
 * @returns True when the caller may discover/call the bot or tool.
 */
export function roleCanAccess(
  accessRoles: readonly SwarmAccessRole[] | undefined,
  caller: SwarmAccessRole,
): boolean {
  if (!accessRoles || accessRoles.length === 0) return true;
  return accessRoles.includes(caller);
}
