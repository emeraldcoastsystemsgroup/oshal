/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | List installed authorized experiences and recheck their actual named entry operation before opening a page or focused rail.
 */
import { Router } from 'express';
import type { Request } from 'express';
import type { SwarmAppService } from '@/features/swarm-apps';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'experience-package-routes' });
export interface ExperiencePackagePorts {
  apps?: Pick<SwarmAppService, 'listExperiences' | 'getAppForViewer'>;
  authorization?: {
    runtime: Pick<ApplicationAuthorizationRuntime, 'canDiscover'> & Partial<Pick<ApplicationAuthorizationRuntime, 'canNavigateHttpPath'>>;
    resolveActor(req: Request): Promise<AuthorizationActor>;
  };
}

/** These routes are mounted behind the UI router's existing authentication middleware. */
export function createExperiencePackageRoutes(ports: ExperiencePackagePorts): Router {
  const router = Router();
  router.use('/experiences', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/experiences', async (req, res) => {
    if (!ports.apps || !ports.authorization) { res.status(503).json({ error: 'experience_discovery_unavailable' }); return; }
    try {
      const actor = await ports.authorization.resolveActor(req);
      if (!actor.isActive) { res.status(403).json({ error: 'experience_principal_inactive' }); return; }
      const candidates = await ports.apps.listExperiences({ ownerSub: actor.sub, isOperator: actor.isSwarmAdmin });
      const experiences = [];
      for (const row of candidates) if (await ports.authorization.runtime.canDiscover(row.app, actor)) experiences.push(row);
      res.json({ experiences });
    } catch (err) {
      logger.error({ err }, 'Experience discovery refused');
      res.status(503).json({ error: 'experience_discovery_unavailable' });
    }
  });
  router.get('/experiences/:name/open', async (req, res) => {
    if (!ports.apps || !ports.authorization?.runtime.canNavigateHttpPath) {
      res.status(503).json({ error: 'experience_navigation_unavailable' }); return;
    }
    try {
      const actor = await ports.authorization.resolveActor(req);
      const name = req.params.name;
      if (!actor.isActive) { res.status(403).json({ error: 'experience_principal_inactive' }); return; }
      const record = await ports.apps.getAppForViewer(name, { ownerSub: actor.sub, isOperator: actor.isSwarmAdmin });
      if (!record || record.status !== 'active' || !record.manifest.experience
        || !(await ports.authorization.runtime.canDiscover(name, actor))) {
        res.status(404).json({ error: 'experience_unavailable' }); return;
      }
      const declaration = structuredClone(record.manifest.experience);
      const generation = JSON.stringify([record.appId, record.manifestPath, record.version, record.updatedAt, record.manifest.experience]);
      if (!(await ports.authorization.runtime.canNavigateHttpPath(actor, declaration.entry))) {
        res.status(403).json({ error: 'experience_entry_denied' }); return;
      }
      // Recheck installation after awaited policy reads; an uninstall/reload cannot redirect a stale generation.
      const current = await ports.apps.getAppForViewer(name, { ownerSub: actor.sub, isOperator: actor.isSwarmAdmin });
      if (!current || current.status !== 'active'
        || JSON.stringify([current.appId, current.manifestPath, current.version, current.updatedAt, current.manifest.experience]) !== generation) {
        res.status(409).json({ error: 'experience_changed' }); return;
      }
      res.redirect(302, declaration.shell === 'page' ? declaration.entry : `/cockpit/?app=${encodeURIComponent(name)}`);
    } catch (err) {
      logger.error({ err }, 'Experience navigation refused');
      res.status(503).json({ error: 'experience_navigation_unavailable' });
    }
  });
  return router;
}
