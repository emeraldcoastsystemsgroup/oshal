/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm orchestration route definitions for processing and run status APIs
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added smoke test route for Plane connectivity validation
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added escalation query route for triage dashboards
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added run list and work item query routes for operator visibility
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Restricted private GitHub provider processing to operators
 */

import { Router } from 'express';
import { SwarmOrchestrationController } from '@/features/swarm-orchestration';
import { createChildLogger } from '@/shared/logger';
import { requiresOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'swarm-orchestration-routes' });

/**
 * @description Creates routes for swarm processing orchestration APIs.
 * @param controller - Swarm orchestration controller
 * @returns Express router mounted by the swarm extension
 */
export function createSwarmOrchestrationRoutes(controller: SwarmOrchestrationController): Router {
  const router = Router();

  router.get('/smoke', controller.smokeTest);
  router.post('/providers/github/process', requiresOperator, controller.processProvider);
  router.post('/providers/:provider/process', controller.processProvider);
  router.get('/runs', controller.listRuns);
  router.get('/runs/:runId', controller.getRun);
  router.get('/work-items', controller.listWorkItems);
  router.get('/escalations', controller.listEscalations);
  router.post('/tickets', controller.submitTickets);

  logger.info('Swarm orchestration routes registered');
  return router;
}
