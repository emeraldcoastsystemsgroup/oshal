/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Expose authenticated per-user briefing settings and atomic announcement claims.
 */
import { Router, json, type Request, type RequestHandler, type ErrorRequestHandler } from 'express';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { BriefingPreferenceSchema } from '@/shared/briefings';
import type { JarvisBriefingService } from '../composition/jarvis-briefing-service';
import { createChildLogger } from '@/shared/logger';
const logger = createChildLogger({ module: 'jarvis-briefing-routes' });
/**
 * @description Keep settings and browser claims behind the same verified caller and same-origin mutation boundary.
 * @param service - Trusted preference and delivery service.
 * @param requiresAuth - Existing application authentication gate.
 * @param resolveActor - Server-owned exact-principal resolver; never reads an actor from the body.
 * @returns Authenticated router for the Jarvis briefing mount.
 */
export function createJarvisBriefingRoutes(service: JarvisBriefingService, requiresAuth: RequestHandler,
  resolveActor: (req: Request) => Promise<AuthorizationActor>): Router {
  const router = Router(); router.use(requiresAuth);
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const run = (operation: (req: Request, actor: AuthorizationActor) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json(await operation(req, await resolveActor(req))); }
    catch (error) {
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_briefing_request' }); return; }
      if (error && typeof error === 'object' && 'status' in error && (error.status === 401 || error.status === 403)) {
        res.status(error.status).json({ error: 'briefing_access_denied' }); return;
      }
      logger.warn({ err: error }, 'Briefing preferences unavailable'); res.status(503).json({ error: 'briefings_unavailable' });
    }
  };
  router.get('/settings', async (req, res) => {
    try { await resolveActor(req); res.sendFile(resolve(__dirname, '../../pages/jarvis-briefings/index.html')); }
    catch { res.status(401).send('Authentication required'); }
  });
  router.get('/client.js', (_req, res) => res.sendFile(resolve(__dirname, '../../pages/jarvis-briefings/client.js')));
  router.get('/', run(async (req, actor) => { z.object({}).strict().parse(req.query); return service.catalog(actor); }));
  router.use((req, res, next) => {
    if (req.get('origin') !== `${req.protocol}://${req.get('host')}` || req.get('sec-fetch-site') === 'cross-site'
      || req.get('x-oshal-briefing-request') !== '1') { res.status(403).json({ error: 'same_origin_required' }); return; }
    if (!req.is('application/json')) { res.status(415).json({ error: 'json_required' }); return; } next();
  }, json({ limit: '16kb' }));
  router.put('/:sourceId', run(async (req, actor) => service.savePreference(actor, String(req.params.sourceId), BriefingPreferenceSchema.parse(req.body))));
  router.post('/claim', run(async (req, actor) => {
    const input = z.object({ taskIds: z.array(z.string().min(1).max(200)).min(1).max(100) }).strict().parse(req.body);
    return service.claim(actor, input.taskIds);
  }));
  const parseError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error?.type === 'entity.parse.failed') { res.status(400).json({ error: 'invalid_briefing_request' }); return; } next(error);
  };
  router.use(parseError); return router;
}
