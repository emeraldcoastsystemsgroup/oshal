/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial agent status controller for enable/disable
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Governance closeout: documented session continuity for status toggle controller wiring and runtime route adoption
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Track B S4: Wire BotContainerSpawnerService — start/stop docker compose service on status toggle
 */

import { Request, Response } from 'express';
import { AgentProfileRepository } from '@/entities/agent';
import { BotContainerSpawnerService } from '../services';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'agent-status-controller' });

/**
 * @description Valid agent status values for the enable/disable feature.
 * 'active' means the bot participates in swarm routing.
 * 'inactive' means the bot container is running but excluded from task assignment.
 */
const VALID_STATUSES = ['active', 'inactive'] as const;
type AgentStatus = typeof VALID_STATUSES[number];

/**
 * @description Controller for agent status management endpoints.
 * Handles enabling/disabling bots in the swarm and triggers docker compose
 * container start/stop via BotContainerSpawnerService.
 */
export class AgentStatusController {
  constructor(
    private readonly repo: AgentProfileRepository,
    private readonly spawner: BotContainerSpawnerService,
  ) {}

  /**
   * @description PATCH /:agentId/status
   * Toggles a bot's status between 'active' and 'inactive'.
   * This controls swarm routing participation, NOT container lifecycle.
   *
   * @param req - Express request with agentId param and status body
   * @param res - Express response
   */
  async updateStatus(req: Request, res: Response): Promise<void> {
    const { agentId } = req.params;
    const { status } = req.body;

    logger.info({ agentId, requestedStatus: status }, 'Agent status update requested');

    if (!agentId) {
      res.status(400).json({ error: 'agentId parameter is required' });
      return;
    }

    if (!status || !VALID_STATUSES.includes(status as AgentStatus)) {
      res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
      });
      return;
    }

    try {
      const existing = await this.repo.getAgentProfile(String(agentId));
      if (!existing) {
        logger.warn({ agentId }, 'Agent not found for status update');
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      const updated = await this.repo.updateAgentStatus(String(agentId), String(status));
      if (!updated) {
        res.status(500).json({ error: 'Failed to update agent status' });
        return;
      }

      logger.info(
        { agentId, agentName: updated.name, oldStatus: existing.status, newStatus: status },
        'Agent status updated',
      );

      // Trigger docker compose container lifecycle based on new status
      const containerResult = status === 'active'
        ? await this.spawner.startBot(String(agentId))
        : await this.spawner.stopBot(String(agentId));

      if (!containerResult.success) {
        logger.warn(
          { agentId, operation: containerResult.operation, error: containerResult.error },
          'Container operation did not succeed — status persisted but container may be in unexpected state',
        );
      }

      res.json({
        success: true,
        agent: {
          agentId: updated.agentId,
          name: updated.name,
          status: updated.status,
        },
        container: {
          operation: containerResult.operation,
          success: containerResult.success,
          output: containerResult.output,
        },
        message: `Bot '${updated.name}' is now ${status}`,
      });
    } catch (error) {
      logger.error({ err: error, agentId }, 'Failed to update agent status');
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * @description GET /status-list
   * Lists all agents with their current status.
   *
   * @param req - Express request
   * @param res - Express response
   */
  async listAgents(req: Request, res: Response): Promise<void> {
    const statusFilter = req.query.status as string | undefined;

    logger.info({ statusFilter }, 'Listing agents with status');

    try {
      const agents = await this.repo.listAgents();
      const filtered = statusFilter
        ? agents.filter((a) => a.status === statusFilter)
        : agents;

      res.json({
        success: true,
        agents: filtered.map((a) => ({
          agentId: a.agentId,
          name: a.name,
          status: a.status,
        })),
        count: filtered.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list agents');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}