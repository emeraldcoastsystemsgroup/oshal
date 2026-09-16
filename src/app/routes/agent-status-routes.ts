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
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Both runtime routes now go through resolveBotRuntimeLauncher instead of constructing DynamicComposeService + BotContainerSpawnerService here. Building the compose pair inline made these two routes docker-only: inside a Kubernetes pod there is no compose file and no docker socket, so enabling or disabling a bot from the cockpit shelled a command that could only fail while the bot kept running. The resolver picks compose or the cluster once, and both routes report which substrate answered.
 */

import { Router, type Request, type Response } from 'express';
import {
  AgentStatusController,
  AgentConfigService,
  StartupConfigValidator,
  resolveBotRuntimeLauncher,
} from '@/features/agent-management';
import { AgentProfileRepository } from '@/entities/agent';
import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { requiresOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'agent-status-routes' });

/**
 * @description Creates agent status management routes for enabling/disabling bots.
 * Provides endpoints to list agents by status and toggle enable/disable.
 * Status toggling starts/stops the bot runtime on whichever substrate this
 * controller runs on — compose start/stop on a docker host, a Deployment scaled
 * to 0/1 inside a cluster.
 *
 * @param pool - PostgreSQL connection pool for agent profile lookups
 * @returns Express Router with status management endpoints
 */
export function createAgentStatusRoutes(pool: Pool): Router {
  const router = Router();
  const repo = new AgentProfileRepository(pool);
  const launcher = resolveBotRuntimeLauncher();
  const controller = new AgentStatusController(repo, launcher);
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
   *       Registers and starts the agent's runtime on the controller's substrate —
   *       a docker-compose.dynamic.yml entry plus `docker compose up -d` on a docker
   *       host, a Deployment + Service inside a cluster.
   *       The agent must already exist in the DB (created via AgentFactoryService).
   *       Persona YAML must already be present on disk.
   *       Idempotent — safe to call if the runtime is already up.
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
   *         description: the runtime launch failed on this substrate
   */
  router.post('/:agentId/launch', async (req: Request, res: Response) => {
    const { agentId } = req.params;
    try {
      const agent = await repo.getAgentProfile(String(agentId));
      if (!agent) {
        res.status(404).json({ success: false, error: `Agent ${agentId} not found` });
        return;
      }

      // Register-and-start on the resolved substrate. The launcher owns the
      // registration step (compose overlay entry, or Deployment + Service), so a
      // cluster install gets the same idempotent create-or-update.
      const launchResult = await launcher.launch({
        agentName: agent.name,
        agentId: agent.agentId,
      });
      if (!launchResult.success) {
        res.status(502).json({
          success: false,
          agentId,
          agentName: agent.name,
          runtime: launchResult.runtime,
          error: `Runtime launch failed: ${launchResult.error}`,
        });
        return;
      }

      logger.info(
        { agentId, agentName: agent.name, runtime: launchResult.runtime },
        'Agent runtime launched via /launch endpoint',
      );
      res.json({
        success: true,
        agentId,
        agentName: agent.name,
        runtime: launchResult.runtime,
      });
    } catch (error) {
      logger.error({ err: error, agentId, route: 'POST /:agentId/launch' }, 'Route handler error');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  logger.info('Agent status routes created');
  return router;
}
