/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve the complete known roster and reviewed metadata import under fresh swarm administration.
 */
import { Router, json, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { PrincipalRegistrationStore, requireRosterAdmin, RosterError } from '@/features/principal-directory';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { authorizationSameOrigin, type AuthorizationRouteOptions } from './authorization-routes';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'user-directory-routes' });
export interface UserDirectoryPorts {
  ready: Promise<unknown>;
  registrations: PrincipalRegistrationStore;
  roster(actor: AuthorizationActor): Promise<unknown>;
}
/** @description Keep identity imports separate from sign-in and grants. @param ports Fixed directory operations. @param options Verified authentication. @returns Same-origin administration API. */
export function createUserDirectoryRoutes(ports: UserDirectoryPorts, options: AuthorizationRouteOptions): Router {
  const router = Router(); router.use(options.requiresAuth);
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.use(async (req, res, next) => {
    try { const actor = await options.resolveActor(req); requireRosterAdmin(actor); res.locals.rosterActor = actor; await ports.ready; next(); }
    catch (error) { next(error); }
  });
  router.get('/', async (req, res, next) => {
    try { z.object({}).strict().parse(req.query); res.json(await ports.roster(res.locals.rosterActor)); }
    catch (error) { next(error); }
  });
  router.use(authorizationSameOrigin, json({ limit: '512kb' }));
  router.post('/preview', async (req, res, next) => {
    try { res.json(await ports.registrations.preview(res.locals.rosterActor, req.body)); } catch (error) { next(error); }
  });
  router.post('/apply', async (req, res, next) => {
    try { res.json(await ports.registrations.apply(await options.resolveActor(req), req.body)); } catch (error) { next(error); }
  });
  const fail: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof RosterError) { res.status(error.status).json({ error: error.code }); return; }
    if (error instanceof z.ZodError || error?.type === 'entity.parse.failed') { res.status(400).json({ error: 'invalid_roster_request' }); return; }
    if (error?.type === 'entity.too.large') { res.status(413).json({ error: 'roster_request_too_large' }); return; }
    logger.error({ err: error }, 'User directory unavailable'); res.status(503).json({ error: 'roster_unavailable' });
  };
  router.use(fail); return router;
}
