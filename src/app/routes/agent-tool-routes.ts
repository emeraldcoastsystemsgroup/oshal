/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of agent-tool routes for Layer 1 Tools Framework
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added per-tool runtime configuration route for tool credentials/auth payload persistence
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added cockpit compatibility alias for per-tool auth-mode updates during Session 69 stabilization
 */

import { Router } from 'express';
import { AgentToolController } from '@/features/tool-switch';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'agent-tool-routes' });

/**
 * @description Creates and configures routes for agent-tool operations.
 * All routes are prefixed with /api/agents in the main router.
 * 
 * @param controller - AgentToolController instance from composition root
 * @returns Configured Express Router
 */
export function createAgentToolRoutes(controller: AgentToolController): Router {
  const router = Router();

  // Admin operation - recompose all agents
  router.post('/selectors/recompose-all', controller.recomposeAllSelectors);

  // Agent-specific tool management
  router.get('/:agentId/tools', controller.getAgentTools);
  router.get('/:agentId/tools/enabled', controller.getEnabledTools);
  router.put('/:agentId/tools/:toolId', controller.setToolAuthMode);
  router.put('/:agentId/tools/:toolId/auth-mode', controller.setToolAuthMode);
  router.put('/:agentId/tools/:toolId/config', controller.setToolConfig);
  router.put('/:agentId/tools/groups/:groupName', controller.setGroupAuthMode);

  // Selector composition
  router.get('/:agentId/selector', controller.getComposedSelector);
  router.post('/:agentId/selector/recompose', controller.recomposeSelector);

  logger.info('Agent tool routes registered');
  return router;
}
