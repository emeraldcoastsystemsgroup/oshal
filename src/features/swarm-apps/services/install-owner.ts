/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The deployment's install owner (OSHAL_INSTALL_OWNER_SUB) adopts every application staged before anyone could sign in, and becomes its administrator. Owning a row was not enough: 58 of a full install's 68 applications are ADR-149 protected, and the rail discovers a protected application only for an identity holding an explicit tier — the operator who installed the swarm held none, so a fresh cockpit showed none of its own applications. Adoption and the admin grant happen together, once, at first load; neither ever overrides an owner or tier someone set afterwards. Lives here rather than in swarm-app-service.ts, which is past its 800-line budget.
 */
import { createChildLogger } from '@/shared/logger';
import type { SwarmAppScopeMeta } from './swarm-app-repository';
import type { AppAccessService } from './app-access-service';

const logger = createChildLogger({ module: 'install-owner' });

/**
 * @description Decide the scope metadata an app load should persist, giving an unowned row the
 * deployment's install owner. An explicit owner — from the caller or already stored — always wins.
 * @param scopeMeta Caller-supplied scope (a publish session), if any.
 * @param previousOwnerSub The owner already stored for this app, or null when it has none.
 * @param installOwnerSub The deployment's install owner (OSHAL_INSTALL_OWNER_SUB).
 * @returns The scope metadata to persist — unchanged whenever an owner already exists.
 */
export function withInstallOwner(scopeMeta: SwarmAppScopeMeta | undefined, previousOwnerSub: string | null,
  installOwnerSub: string | undefined): SwarmAppScopeMeta | undefined {
  if (scopeMeta?.ownerSub || previousOwnerSub) return scopeMeta;
  const owner = (installOwnerSub ?? '').trim();
  return owner ? { ...scopeMeta, ownerSub: owner } : scopeMeta;
}

/**
 * @description Name the install owner only when THIS load adopted the row — the persisted owner came
 * from the install default rather than the caller. Later boots find the owner stored and adopt nothing.
 * @param callerScope Scope the caller supplied.
 * @param persistedScope Scope actually persisted after withInstallOwner.
 * @returns The adopting owner's subject, or null when nothing was adopted.
 */
export function adoptedInstallOwner(callerScope: SwarmAppScopeMeta | undefined,
  persistedScope: SwarmAppScopeMeta | undefined): string | null {
  const owner = persistedScope?.ownerSub;
  return owner && owner !== callerScope?.ownerSub ? owner : null;
}

/**
 * @description Make the adopting owner the application's administrator, without overriding a tier
 * anyone already set. A failure is logged, never thrown: a boot must not die over a grant the
 * cockpit can make by hand.
 * @param access The app access store. @param appName Adopted application. @param ownerSub Adopting owner.
 * @returns Whether a tier was newly granted.
 */
export async function grantInstallOwnerAdmin(access: Pick<AppAccessService, 'grantIfAbsent'>,
  appName: string, ownerSub: string): Promise<boolean> {
  try {
    return await access.grantIfAbsent({ userSub: ownerSub, appName, tier: 'admin', assignedBySub: ownerSub,
      reason: 'Install owner: administrator of every application this installation staged' });
  } catch (err) {
    logger.warn({ err, appName }, 'install owner admin tier not granted — grant it from the cockpit');
    return false;
  }
}
