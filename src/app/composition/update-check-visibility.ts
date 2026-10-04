/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Filter cached update metadata through current caller scope and application discovery.
 */
import type { Request } from 'express';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { getCaller } from '@/shared/middleware/authz';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import type { SwarmAppRouteAuthorization } from '@/app/routes/swarm-app-routes';

interface UpdateCheckAppRegistry {
  listApps(status: undefined, scope: { ownerSub: string; isOperator: boolean }): Promise<readonly { name: string }[]>;
}

/** @description Resolve only names the current caller can discover, using the navigation policy.
 * @param apps Installed registry, scoped before discovery. @param authorization Current verified actor and discovery ports.
 * @returns Request-bound visible names; throws when current authority is unavailable.
 */
export function createUpdateCheckVisibility(apps: UpdateCheckAppRegistry, authorization: SwarmAppRouteAuthorization) {
  return async (req: Request): Promise<ReadonlySet<string>> => {
    const { sub } = getCaller(req);
    if (!sub) throw new Error('Verified update caller unavailable');
    let actor: AuthorizationActor | undefined;
    if (!isGuestRequest(req)) {
      actor = await authorization.resolveActor(req);
      if (!actor.isActive || actor.sub !== sub || !actor.issuer) throw new Error('Verified update actor unavailable');
    }
    const scoped = await apps.listApps(undefined, { ownerSub: sub, isOperator: false });
    const visible = new Set<string>();
    for (const app of scoped) if (await authorization.canDiscover(app.name, actor)) visible.add(app.name);
    return visible;
  };
}
