/**
 * ADR-157: the kernel's own scheduled-services surface. A package never hand-rolls the checkbox —
 * these three routes are what the setup dashboard's Scheduled services panel and the shared
 * component both call, so "the checkbox in the application config" is the kernel's checkbox.
 *
 * Every route sits on the `/api/swarm/apps` router, which is mounted behind requiresAuth: there is
 * no anonymous path to an activation. Activating a SYSTEM service additionally requires swarm
 * administration, which the activation service checks against the caller's verified actor.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-157 S1: GET /:name/services, POST /:name/services/:id/activate and DELETE /:name/services/:id/activation — read the declared services with their activation state, turn one on under an explicitly named principal class, and turn it off again.
 *
 * @module application-service-activation-routes
 */
import type { Request, Response, Router } from 'express';
import { createChildLogger } from '@/shared/logger';
import { ApplicationAuthorizationError } from '@/features/application-authorization';
import { getApplicationServiceActivations } from '../application-service-activation-wiring';

const logger = createChildLogger({ module: 'application-service-activation-routes' });

/** @description Map an expected authorization refusal to its status; anything else is a 503. */
function fail(res: Response, error: unknown, context: Record<string, unknown>): void {
  if (error instanceof ApplicationAuthorizationError) {
    res.status(error.status).json({ error: error.code });
    return;
  }
  logger.error({ err: error, ...context }, 'Scheduled service activation request failed');
  res.status(503).json({ error: 'authorization_service_unavailable' });
}

/** @description Resolve the composed activation authority, or answer 503 while boot is incomplete. */
function handles(res: Response) {
  const composed = getApplicationServiceActivations();
  if (!composed) {
    res.status(503).json({ error: 'authorization_service_unavailable' });
    return null;
  }
  return composed;
}

/**
 * @description Register the three ADR-157 routes onto the swarm-apps router.
 *
 * They are deliberately registered on the existing `/api/swarm/apps` mount rather than a new one:
 * the mount already carries requiresAuth, and an application's services belong to the application's
 * own namespace.
 *
 * @param router - The `/api/swarm/apps` router, already behind requiresAuth.
 * @returns Nothing; the routes are attached in place.
 */
export function registerApplicationServiceActivationRoutes(router: Router): void {
  /** The declared services of one application with their activation state and readiness answer. */
  router.get('/:name/services', async (req: Request, res: Response) => {
    const name = String(req.params.name);
    const composed = handles(res);
    if (!composed) return;
    try {
      const actor = await composed.resolveActor(req);
      res.json(await composed.service.listServices(actor, name));
    } catch (error) {
      fail(res, error, { name });
    }
  });

  /** Activate one service under an explicitly named principal class. */
  router.post('/:name/services/:id/activate', async (req: Request, res: Response) => {
    const name = String(req.params.name);
    const scheduleId = String(req.params.id);
    const runsAs = (req.body as { runsAs?: unknown } | undefined)?.runsAs;
    if (runsAs !== 'system' && runsAs !== 'user') {
      res.status(400).json({ error: 'authorization_service_class_required' });
      return;
    }
    const composed = handles(res);
    if (!composed) return;
    try {
      const actor = await composed.resolveActor(req);
      const activation = await composed.service.activate(actor, { app: name, scheduleId, runsAs });
      logger.info({ app: name, scheduleId, runsAs }, 'Scheduled service activation requested');
      res.json({ activation: { id: activation.id, runsAs: activation.runsAs, activatedAt: activation.activatedAt } });
    } catch (error) {
      fail(res, error, { name, scheduleId, runsAs });
    }
  });

  /** Deactivate one service: the caller's own, or — for a swarm administrator — a named person's. */
  router.delete('/:name/services/:id/activation', async (req: Request, res: Response) => {
    const name = String(req.params.name);
    const scheduleId = String(req.params.id);
    const targetSub = typeof req.query.targetSub === 'string' ? req.query.targetSub : undefined;
    const targetIssuer = typeof req.query.targetIssuer === 'string' ? req.query.targetIssuer : undefined;
    const composed = handles(res);
    if (!composed) return;
    try {
      const actor = await composed.resolveActor(req);
      const closed = await composed.service.deactivate(actor, { app: name, scheduleId, targetSub, targetIssuer });
      logger.info({ app: name, scheduleId, closed }, 'Scheduled service deactivation requested');
      res.json({ deactivated: closed });
    } catch (error) {
      fail(res, error, { name, scheduleId });
    }
  });
}
