/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Moved intake routes under swarm extension boundary
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added full JSDoc contract tags for exported route factory
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Registered materializing provider reconciliation separately from read-only pull
 */

import { Router } from 'express';
import { IntakeController } from '@/features/intake';
import { createChildLogger } from '@/shared/logger';
import { requiresOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'swarm-intake-routes' });

/**
 * @description Creates routes for generic provider intake operations.
 * All routes are mounted under `/api/intake` by the swarm extension.
 * @param controller - Intake API controller
 * @returns Router with intake provider endpoints
 */
export function createIntakeRoutes(controller: IntakeController): Router {
  const router = Router();

  router.get('/providers', controller.listProviders);
  router.post('/providers/github/pull', requiresOperator, controller.pullProvider);
  router.post('/providers/github/reconcile', requiresOperator, controller.reconcileProvider);
  router.post('/providers/:provider/pull', controller.pullProvider);
  router.post('/providers/:provider/reconcile', controller.reconcileProvider);

  logger.info('Swarm intake routes registered');
  return router;
}
