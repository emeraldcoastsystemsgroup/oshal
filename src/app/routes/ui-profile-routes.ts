/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial UI profile routes — /api/ui/profile, /api/ui/profiles
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Resolve swarm-app manifests first, then fall back to on-disk profile JSONs
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | WARN when an explicitly requested ?name= profile falls back to disk — the silent fallback served a stale pre-carve-out little-monsters.json (4 ribbon items, no Record, no theme) whenever RLS hid the app row, masquerading as the app for days.
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { UIProfileService } from '@/features/ui-profile';
import type { SwarmAppService } from '@/features/swarm-apps';

const logger = createChildLogger({ module: 'ui-profile-routes' });

/**
 * @description Creates the UI profile routes. The cockpit calls these at boot
 * to decide which ribbon items to render. A profile does NOT disable backend
 * routes or bots — the framework keeps running; the profile only masks/orders
 * the surfaces the operator sees.
 *
 * Resolution order for a named profile:
 *   1. If a swarm-app manifest is loaded with name=X, synthesise its profile.
 *   2. Otherwise load X from config-seed/profiles/X.json.
 * This lets an operator "focus" a running application without maintaining a
 * separate profile file — the manifest is the single source of truth.
 *
 * Routes:
 *   GET  /api/ui/profile            → resolved active profile (server default
 *                                     unless `?name=<name>` is provided)
 *   GET  /api/ui/profiles           → list of available profile names
 *   POST /api/ui/profile/reload     → clear the in-memory cache (dev only)
 *
 * @param service - UIProfileService for file-based profile fallback
 * @param swarmApps - optional SwarmAppService for manifest-first resolution
 * @returns Express Router
 */
export function createUiProfileRoutes(service: UIProfileService, swarmApps?: SwarmAppService): Router {
  const router = Router();

  router.get('/profile', async (req: Request, res: Response) => {
    const requested = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    const selected = requested || service.getEnvSelectedName();
    try {
      // Try manifest synthesis for BOTH request-level and env-selected names.
      // Without this, UI_PROFILE=<app-name> on the server falls through to the
      // disk profile JSON and loses the manifest's tool-* prefixed IDs and
      // focused ribbon.
      if (selected && swarmApps) {
        const synthetic = await swarmApps.synthesiseProfile(selected);
        if (synthetic) {
          logger.debug({ selected, source: requested ? 'query' : 'env' }, 'Serving synthesised profile from swarm-app manifest');
          res.json({ profile: synthetic, requested: selected, source: 'swarm-app', envDefault: service.getEnvSelectedName() });
          return;
        }
      }
      const profile = service.load(selected);
      if (requested && swarmApps) {
        // An explicit ?name= that reaches the disk fallback usually means the swarm-app
        // row exists but is invisible to THIS caller (RLS scope/owner mismatch) or the
        // app is unloaded — a stale profile JSON can silently impersonate the app here.
        logger.warn({ selected, resolved: profile.name }, 'Requested app profile fell back to disk JSON — manifest synthesis returned nothing for this caller');
      } else {
        logger.debug({ selected, resolved: profile.name }, 'Serving UI profile from disk');
      }
      res.json({ profile, requested: selected, source: 'disk', envDefault: service.getEnvSelectedName() });
    } catch (err) {
      logger.error({ err, selected }, 'Failed to load UI profile');
      res.status(500).json({ error: 'Failed to load UI profile' });
    }
  });

  router.get('/profiles', (_req: Request, res: Response) => {
    try {
      const names = service.list();
      res.json({ profiles: names, envDefault: service.getEnvSelectedName() });
    } catch (err) {
      logger.error({ err }, 'Failed to list UI profiles');
      res.status(500).json({ error: 'Failed to list UI profiles' });
    }
  });

  router.post('/profile/reload', (_req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      res.status(403).json({ error: 'Profile cache reload is disabled in production' });
      return;
    }
    service.reload();
    logger.info('UI profile cache cleared via API');
    res.json({ ok: true });
  });

  return router;
}
