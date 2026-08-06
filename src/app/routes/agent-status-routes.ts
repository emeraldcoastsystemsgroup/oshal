/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial agent status routes for enable/disable
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Track B S4: Wire BotContainerSpawnerService into status toggle route
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Track B S7: Add /config-status endpoint for operator visibility into missing required config
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | POST /:agentId/launch — spawn container for already-created agent via DynamicComposeService
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Restricted global agent inventory, validation, status, and container lifecycle operations to exact operators
 */

import { Router, type Request, type Response } from 'express';
import {
  AgentStatusController,
  BotContainerSpawnerService,
  DynamicComposeService,
  AgentConfigService,
  StartupConfigValidator,
} from '@/features/agent-management';
import { AgentProfileRepository } from '@/entities/agent';
import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { requiresOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'agent-status-routes' });

/**
 * @description Creates agent status management routes for enabling/disabling bots.
 * Provides endpoints to list agents by status and toggle enable/disable.
 * Status toggling triggers docker compose start/stop via BotContainerSpawnerService.
 *
 * @param pool - PostgreSQL connection pool for agent profile lookups
 * @returns Express Router with status management endpoints
 */
export function createAgentStatusRoutes(pool: Pool): Router {
  const router = Router();
  const repo = new AgentProfileRepository(pool);
  const dynamicCompose = new DynamicComposeService();
  // Pass dynamic compose file as overlay so dynamically-created services are visible to docker compose
  const spawner = new BotContainerSpawnerService(undefined, undefined, dynamicCompose.filePath);
  const controller = new AgentStatusController(repo, spawner);
  const agentConfigService = new AgentConfigService(pool);
  const configValidator = new StartupConfigValidator(agentConfigService);

  // Agent records and containers are global platform resources. Keep the gate ahead of every
  // repository, compose-file, and Docker operation so denied callers cannot create side effects.
  router.use(requiresOperator);

  /**
   * @openapi
   * /api/agents/status-list:
   *   get:
   *     summary: List all agents with optional status filter
   *     tags: [Agents]
   *     parameters:
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           enum: [active, inactive]
   *     responses:
   *       200:
   *         description: List of agents with status
   */
  router.get('/status-list', async (req: Request, res: Response) => {
    try {
      await controller.listAgents(req, res);
    } catch (error) {
      logger.error({ err: error, route: 'GET /status-list' }, 'Route handler error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * @openapi
   * /api/agents/{agentId}/status:
   *   patch:
   *     summary: Toggle bot status between active and inactive
   *     tags: [Agents]
   *     parameters:
   *       - in: path
   *         name: agentId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               status:
   *                 type: string
   *                 enum: [active, inactive]
   *     responses:
   *       200:
   *         description: Status updated successfully
   */
  router.patch('/:agentId/status', async (req: Request, res: Response) => {
    try {
      await controller.updateStatus(req, res);
    } catch (error) {
      logger.error({ err: error, route: 'PATCH /:agentId/status' }, 'Route handler error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * @openapi
   * /api/agents/config-status:
   *   get:
   *     summary: Operator config validation report — lists agents with missing required runtime config
   *     tags: [Agents]
   *     responses:
   *       200:
   *         description: Per-agent config validation results
   */
  router.get('/config-status', async (_req: Request, res: Response) => {
    try {
      const report = await configValidator.validateAll();
      res.json({ success: true, ...report });
    } catch (error) {
      logger.error({ err: error, route: 'GET /config-status' }, 'Route handler error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * @openapi
   * /api/agents/{agentId}/launch:
   *   post:
   *     summary: Spawn a container for an already-created agent
   *     description: |
   *       Registers the agent in docker-compose.dynamic.yml and runs `docker compose up -d`.
   *       The agent must already exist in the DB (created via AgentFactoryService).
   *       Persona YAML must already be present on disk.
   *       Idempotent — safe to call if the container is already running (docker compose will no-op).
   *     tags: [Agents]
   *     parameters:
   *       - in: path
   *         name: agentId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Container started (or already running)
   *       404:
   *         description: Agent not found
   *       502:
   *         description: docker compose failed
   */
  router.post('/:agentId/launch', async (req: Request, res: Response) => {
    const { agentId } = req.params;
    try {
      const agent = await repo.getAgentProfile(String(agentId));
      if (!agent) {
        res.status(404).json({ success: false, error: `Agent ${agentId} not found` });
        return;
      }

      // Register service in dynamic compose overlay (idempotent)
      const composeResult = dynamicCompose.upsertService({
        agentName: agent.name,
        agentId: agent.agentId,
      });

      if (!composeResult.success) {
        res.status(500).json({ success: false, error: `Compose registration failed: ${composeResult.error}` });
        return;
      }

      // Start (or restart) the container
      const spawnResult = await spawner.startBot(agent.name);
      if (!spawnResult.success) {
        res.status(502).json({
          success: false,
          agentId,
          agentName: agent.name,
          error: `Container start failed: ${spawnResult.error}`,
        });
        return;
      }

      logger.info({ agentId, agentName: agent.name }, 'Agent container launched via /launch endpoint');
      res.json({
        success: true,
        agentId,
        agentName: agent.name,
        containerOutput: spawnResult.output,
      });
    } catch (error) {
      logger.error({ err: error, agentId, route: 'POST /:agentId/launch' }, 'Route handler error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  logger.info('Agent status routes created');
  return router;
}
