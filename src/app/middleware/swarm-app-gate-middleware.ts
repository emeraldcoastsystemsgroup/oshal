/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial swarm-app gate middleware — 503s manifest-owned routes when the owning app is inactive (ADR 2026-04-20 Phase 1 close)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: enforce declared per-user app tiers on hard-mounted kernel routes, sharing the same exact-subject, method, rollout, and fail-closed policy as dynamic package routes.
 */

import type { Request, Response, NextFunction } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppAccessResolver, SwarmAppService } from '@/features/swarm-apps';
import { appAccessCallerSub, appAccessDenial, appAccessEnforcementMode } from './app-access-policy';

const logger = createChildLogger({ module: 'swarm-app-gate-middleware' });

/**
 * @description Express middleware that enforces the swarm-app contract at
 * the route level: if an incoming request path falls under a mountPath
 * declared by a swarm-app manifest, and that app's current status is
 * 'inactive', the request returns 503 with a structured body naming the
 * app. Framework-owned paths (no manifest claims them) pass through
 * unchanged.
 *
 * This is the piece that makes "toggle off" a real toggle — not just a
 * cosmetic change. An operator deactivating Little Monsters sees both
 * the ribbon icons disappear AND /api/education/* return 503 until the
 * app is reactivated.
 *
 * @param swarmAppService - the service owning the ownership + status cache
 * @returns Express middleware
 */
export function createSwarmAppGateMiddleware(
  swarmAppService: SwarmAppService,
  appAccess?: AppAccessResolver,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const owner = swarmAppService.ownerOf(req.path);
    if (!owner) {
      next();
      return;
    }
    if (owner.status === 'active') {
      if (!owner.access) {
        next();
        return;
      }
      if (!appAccess) {
        logger.error({ path: req.path, appName: owner.appName }, 'Declared app access has no resolver');
        res.status(503).json({ error: 'app_access_unavailable' });
        return;
      }
      const userSub = appAccessCallerSub(req);
      if (!userSub) {
        next(); // anonymous access remains the guest capability matrix's responsibility
        return;
      }
      try {
        const decision = await appAccess.resolve(owner.appName, userSub, owner.access);
        res.locals.oshalAppAccess = decision;
        const denial = appAccessDenial(req.method, decision);
        if (!denial) {
          next();
          return;
        }
        if (appAccessEnforcementMode() === 'shadow') {
          logger.warn(
            { path: req.path, appName: owner.appName, userSub, tier: decision.tier, method: req.method, denial },
            'Gate: app access shadow denial observed',
          );
          next();
          return;
        }
        logger.info(
          { path: req.path, appName: owner.appName, userSub, tier: decision.tier, method: req.method, denial },
          'Gate: app access request denied',
        );
        res.status(403).json({ error: denial, app: owner.appName, tier: decision.tier });
      } catch (err) {
        logger.error({ err, path: req.path, appName: owner.appName }, 'Gate: app access resolution failed closed');
        res.status(503).json({ error: 'app_access_unavailable' });
      }
      return;
    }
    logger.info({ path: req.path, appName: owner.appName }, 'Gate: 503 — owning app is inactive');
    res.status(503).json({
      error: 'Application inactive',
      appName: owner.appName,
      message: `The swarm application "${owner.appName}" owning ${req.path} is currently inactive. Toggle it active via PATCH /api/swarm/apps/${owner.appName}/toggle {active:true} to restore this route.`,
    });
  };
}
