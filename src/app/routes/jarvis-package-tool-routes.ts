/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Expose exact authenticated package previews and one-shot execution without model confirmation authority.
 */
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { JarvisPackageToolService } from './jarvis-package-tool-service';

const selector = z.object({ proposalId: z.string().uuid() }).strict();
const preview = z.object({ sessionId: z.string().min(6).max(128).regex(/^[\w.-]+$/),
  toolName: z.string().min(2).max(64).regex(/^[a-z][a-z0-9_-]+$/), input: z.record(z.string(), z.unknown()) }).strict();
const sameOrigin: RequestHandler = (req, res, next) => {
  if (req.get('origin') !== `${req.protocol}://${req.get('host')}` || req.get('sec-fetch-site') === 'cross-site'
    || req.get('x-oshal-package-tool') !== '1') { res.status(403).json({ error: 'same_origin_required' }); return; }
  if (!req.is('application/json')) { res.status(415).json({ error: 'json_required' }); return; } next();
};

/** @description Build authenticated adapters; the surrounding Jarvis router owns authentication.
 * @param service Composition-owned proposal service. @param resolveActor Existing verified request resolver.
 * @returns A router with no caller-selected identity or authorization fields.
 */
export function createJarvisPackageToolRoutes(service: JarvisPackageToolService, resolveActor: (req: Request) => Promise<AuthorizationActor>): Router {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const run = (work: (req: Request, actor: AuthorizationActor) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json(await work(req, await resolveActor(req))); }
    catch (error) {
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_package_tool_request' }); return; }
      const status = error instanceof Error && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : 503;
      const code = error instanceof Error && /^package_tool_[a-z_]+$/.test(error.message) ? error.message : 'package_tool_unavailable';
      res.status(status).json({ error: code });
    }
  };
  router.get('/catalog', run(async (req, actor) => { z.object({}).strict().parse(req.query); return { tools: await service.discover(actor) }; }));
  router.use(sameOrigin);
  router.post('/preview', run(async (req, actor) => { const input = preview.parse(req.body); return service.propose(actor, input, input.sessionId); }));
  router.post('/execute', run(async (req, actor) => service.execute(actor, selector.parse(req.body).proposalId)));
  router.post('/result', run(async (req, actor) => service.result(actor, selector.parse(req.body).proposalId)));
  return router;
}
