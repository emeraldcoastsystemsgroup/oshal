/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Expose same-origin membership catalog and preview/apply through the current administrator service.
 */
import { Router, json, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { ExternalTenantMembershipService, ExternalTenantMembershipError,
  ExternalTenantMembershipChangeSchema, ExternalTenantMembershipApplySchema } from '@/features/external-tenant-memberships';
import { createChildLogger } from '@/shared/logger';
import { authorizationSameOrigin } from './authorization-routes';
const logger = createChildLogger({ module: 'external-tenant-membership-routes' });

/** @description Authentication composition supplies exact caller provenance, never a body or query actor. */
export interface ExternalTenantMembershipRouteOptions {
  requiresAuth: RequestHandler; resolveActor(request: Request): Promise<AuthorizationActor>;
}
/** @description Mount before the broader authorization router at /api/authorization/tenant-memberships.
 * @param service Current administrator authority. @param options Verified authentication ports. @returns Fixed same-origin router.
 */
export function createExternalTenantMembershipRoutes(service: ExternalTenantMembershipService, options: ExternalTenantMembershipRouteOptions): Router {
  const router = Router(); router.use(options.requiresAuth);
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const run = (handler: (req: Request, actor: AuthorizationActor) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json(await handler(req, await options.resolveActor(req))); } catch (error) { fail(res,error); }
  };
  router.get('/catalog', run(async (req, actor) => { z.object({}).strict().parse(req.query); return service.catalog(actor); }));
  router.use(authorizationSameOrigin, json({ limit: '8kb' }));
  router.post('/preview', run(async (req, actor) => service.preview(actor, ExternalTenantMembershipChangeSchema.parse(req.body))));
  router.post('/apply', run(async (req, actor) => service.apply(actor, ExternalTenantMembershipApplySchema.parse(req.body))));
  const parseError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error?.type === 'entity.parse.failed') { res.status(400).json({ error: 'invalid_tenant_membership_request' }); return; }
    if (error?.type === 'entity.too.large') { res.status(413).json({ error: 'tenant_membership_request_too_large' }); return; }
    next(error);
  };
  router.use(parseError); return router;
}
function fail(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_tenant_membership_request' }); return; }
  if (error instanceof ExternalTenantMembershipError) { res.status(error.status).json({ error: error.code }); return; }
  if (error instanceof Error && 'status' in error && error.status === 401) {
    res.status(401).json({ error: 'authorization_identity_required' }); return;
  }
  logger.error({ err: error }, 'External tenant membership request failed');
  res.status(503).json({ error: 'tenant_membership_unavailable' });
}
