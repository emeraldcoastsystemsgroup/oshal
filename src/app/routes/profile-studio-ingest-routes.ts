/**
 * Profile Studio Ingest Route — the desktop worker's callback surface for LinkedIn profile updates.
 *
 *   POST /ingest -> the box reports the outcome of a dispatched profile plan. Service-secret
 *                   authed (the box is not OIDC), so this lives in its OWN router mounted WITHOUT
 *                   requiresAuth — exactly like /api/apply/ingest. Resolves the plan
 *                   dispatched -> applied | failed via the store's CAS (a stale or duplicate
 *                   callback loses the CAS and is a no-op).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial ingest callback for
 *   the linkedin-profile-operator desktop worker (mirrors apply-ingest-routes).
 *
 * @module profile-studio-ingest-routes
 */
import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { ProfilePlanStore } from '@/features/profile-studio';

const logger = createChildLogger({ module: 'profile-studio-ingest-routes' });
const ALLOWED = new Set(['applied', 'failed']);

/** Shared-secret check for the non-OIDC desktop worker (same contract as apply-ingest). */
function serviceSecretOk(req: Request): boolean {
  const secret = (process.env.SWARM_SERVICE_SECRET || '').trim();
  return secret.length > 0 && String(req.header('x-service-secret') || '').trim() === secret;
}

/**
 * @description Build the service-secret-authed ingest router for profile-plan outcomes.
 * @param ctx - App context (Postgres pool for the plan store).
 * @returns The router (mount WITHOUT requiresAuth at /api/profile-studio).
 */
export function createProfileStudioIngestRoutes(ctx: AppContext): Router {
  const router = Router();
  const store = new ProfilePlanStore(ctx.pool);

  router.post('/ingest', async (req: Request, res: Response) => {
    if (!serviceSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const userSub = req.body?.userSub ? String(req.body.userSub) : '';
    const result = ALLOWED.has(String(req.body?.result)) ? (String(req.body.result) as 'applied' | 'failed') : 'failed';
    const note = String(req.body?.note || '').slice(0, 4000);
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    try {
      const moved = await store.casState(userSub, 'dispatched', result, { resultNote: note });
      logger.info({ userSub, result, moved }, 'profile plan outcome ingested from desktop worker');
      res.json({ ok: true, moved, result });
    } catch (err) {
      logger.error({ err, userSub, result }, 'profile plan ingest failed');
      res.status(500).json({ error: 'ingest failed' });
    }
  });

  return router;
}
