/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added dedicated agent-profile routes under /api/agents/:agentId/profile
 */

import { Router } from 'express';
import multer from 'multer';
import { AgentProfileController } from '@/features/agent-profile';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'agent-profile-routes' });

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

/**
 * @description Creates routes for narrow agent-profile persistence operations.
 * All routes are mounted under `/api/agents` by the main server.
 *
 * @param controller - Wired agent-profile controller.
 * @returns Configured router.
 */
export function createAgentProfileRoutes(controller: AgentProfileController): Router {
  const router = Router();

  router.get('/', controller.listAgents);
  router.get('/bulk/profile-status', controller.listBulkConfigStatus);
  router.post('/bulk/configure-all', controller.configureAllProfiles);
  router.post('/bulk/configure-all-unset', controller.configureUnsetProfiles);
  router.get('/:agentId/profile', controller.getAgentProfile);
  router.put('/:agentId/profile', controller.updateAgentProfile);
  router.post('/:agentId/profile/avatar', avatarUpload.single('avatar'), controller.uploadAgentAvatar);

  logger.info('Agent profile routes registered');
  return router;
}
