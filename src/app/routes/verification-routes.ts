/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of verification routes
 */

import { Router } from 'express';
import { VerificationController } from '@/features/tool-verification';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'verification-routes' });

/**
 * @description Creates and configures routes for tool verification operations.
 * All routes are prefixed with /api/tools/verify in the main router.
 * 
 * @param controller - VerificationController instance from composition root
 * @returns Configured Express Router
 */
export function createVerificationRoutes(controller: VerificationController): Router {
  const router = Router();

  // Scheduler management routes (must come before parameterized routes)
  router.get('/scheduler/status', controller.getSchedulerStatus);
  router.post('/scheduler/start', controller.startScheduler);
  router.post('/scheduler/stop', controller.stopScheduler);
  router.post('/scheduler/run', controller.runSchedulerNow);

  // Results aggregation route
  router.get('/results', controller.getAllResults);

  // Single tool verification routes
  router.post('/:toolId', controller.verifySingleTool);
  router.get('/:toolId/latest', controller.getLatestResult);
  router.get('/:toolId/history', controller.getVerificationHistory);

  // Verify all tools
  router.post('/', controller.verifyAllTools);

  logger.info('Verification routes registered');
  return router;
}
