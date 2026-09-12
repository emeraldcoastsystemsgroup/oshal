/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add authenticated Access Administration adapters over the shared policy service and its strict tool schemas.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add bounded, redacted applied authorization history under current application and tenant authority.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Serve the installed source asset from compiled runtimes and redact file delivery failures.
 */
import path from 'node:path';
import { Router, json, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { ApplicationAuthorizationManagementService, AuthorizationActor } from '@/shared/application-authorization';
import {
  AUTHORIZATION_TOOL, AuthorizationApplySchema, AuthorizationAuditSchema, AuthorizationChangeSchema, AuthorizationExplainSchema,
  AuthorizationTargetSchema, type AuthorizationToolExecutor,
} from '@/shared/security/authorization-tool-contract';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'authorization-routes' });
export interface AuthorizationRouteOptions {
  requiresAuth: RequestHandler;
  /** Authentication composition resolves this afresh. Request bodies never construct actors. */
  resolveActor(request: Request): Promise<AuthorizationActor>;
  authorizationTool?: AuthorizationToolExecutor;
}

/** @description Only browser requests from the serving origin may create previews or apply changes. */
export const authorizationSameOrigin: RequestHandler = (req, res, next) => {
  const expected = `${req.protocol}://${req.get('host')}`;
  if (req.get('origin') !== expected || req.get('sec-fetch-site') === 'cross-site'
    || req.get('x-oshal-access-request') !== '1') {
    res.status(403).json({ error: 'same_origin_required' }); return;
  }
  if (!req.is('application/json')) { res.status(415).json({ error: 'json_required' }); return; }
  next();
};

/** @description Preserve expected policy refusals while never exposing internal error details. */
function fail(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_authorization_request' }); return; }
  if (error instanceof Error && 'status' in error && error.status === 401) {
    res.status(401).json({ error: 'authorization_identity_required' }); return;
  }
  if (error instanceof Error && error.name === 'ApplicationAuthorizationError'
    && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500
    && 'code' in error && typeof error.code === 'string') {
    res.status(error.status).json({ error: error.code }); return;
  }
  logger.error({ err: error }, 'Access administration request failed');
  res.status(500).json({ error: 'authorization_unavailable' });
}

/** @description Thin adapters: the same service governs the browser, API and registered tool. */
export function createAuthorizationRoutes(service: ApplicationAuthorizationManagementService, options: AuthorizationRouteOptions): Router {
  const router = Router();
  router.use(options.requiresAuth);
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const run = (handler: (req: Request, actor: AuthorizationActor) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json(await handler(req, await options.resolveActor(req))); }
    catch (error) { fail(res, error); }
  };
  router.get('/catalog', run(async (req, actor) => {
    z.object({}).strict().parse(req.query); return service.catalog(actor);
  }));
  router.get('/me', run(async (req, actor) => {
    const input = AuthorizationTargetSchema.omit({ targetSub: true, targetIssuer: true }).parse(req.query);
    return service.effective(actor, input);
  }));
  router.get('/audit', run(async (req, actor) => {
    const input = { ...req.query, ...(typeof req.query.limit === 'string' && /^[0-9]+$/.test(req.query.limit) ? { limit: Number(req.query.limit) } : {}) };
    return service.auditHistory(actor, AuthorizationAuditSchema.parse(input));
  }));
  router.use(authorizationSameOrigin, json({ limit: '32kb' }));
  router.post('/effective', run(async (req, actor) => service.effective(actor, AuthorizationTargetSchema.parse(req.body))));
  router.post('/explain', run(async (req, actor) => service.explain(actor, AuthorizationExplainSchema.parse(req.body))));
  router.post('/preview', run(async (req, actor) => service.previewChange(actor, AuthorizationChangeSchema.parse(req.body))));
  router.post('/apply', run(async (req, actor) => service.applyChange(actor, AuthorizationApplySchema.parse(req.body))));
  if (options.authorizationTool) {
    const tool = options.authorizationTool;
    router.post('/tool', async (req, res) => {
      try {
        const output: unknown = JSON.parse(await tool.execute(AUTHORIZATION_TOOL, req.body, {
          resolveActor: () => options.resolveActor(req), allowChanges: true,
        }));
        res.json(output);
      } catch (error) { fail(res, error); }
    });
  }
  const parseError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error?.type === 'entity.parse.failed') { res.status(400).json({ error: 'invalid_authorization_request' }); return; }
    if (error?.type === 'entity.too.large') { res.status(413).json({ error: 'authorization_request_too_large' }); return; }
    next(error);
  };
  router.use(parseError);
  return router;
}

/** @description The management page uses the same scope check as its catalog before any HTML is served. */
export function createAuthorizationPageRoutes(service: ApplicationAuthorizationManagementService, options: AuthorizationRouteOptions): Router {
  const router = Router();
  router.use(options.requiresAuth);
  router.get('/', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      await service.catalog(await options.resolveActor(req));
      res.sendFile(path.resolve(process.cwd(), 'src/pages/access/index.html'), error => {
        if (error && !res.headersSent) fail(res, error);
      });
    } catch (error) { fail(res, error); }
  });
  return router;
}
