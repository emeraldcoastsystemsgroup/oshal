/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial agent status controller for enable/disable
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Governance closeout: documented session continuity for status toggle controller wiring and runtime route adoption
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Track B S4: Wire BotContainerSpawnerService — start/stop docker compose service on status toggle
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Toggle through the substrate-agnostic BotRuntimeLauncher instead of BotContainerSpawnerService. The compose service was hard-wired, so on Kubernetes disabling a bot ran `docker compose stop` inside a pod that has neither a compose file nor a docker socket: the DB row flipped, the pod kept running, and the operator saw a container error with no explanation. It also passed the agent UUID where the spawner expects the compose SERVICE NAME, so even under compose the stop targeted a service that does not exist. Now it calls setRunning(name, active) on the resolved launcher and reports which substrate answered.
 */

import { Request, Response } from 'express';
import { AgentProfileRepository } from '@/entities/agent';
import type { BotRuntimeLauncher } from '../services';
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
 * Handles enabling/disabling bots in the swarm and starts/stops the bot's runtime
 * through the substrate-agnostic BotRuntimeLauncher — compose start/stop on a
 * docker host, a Deployment scaled to 0/1 on Kubernetes.
 */
export class AgentStatusController {
  constructor(
    private readonly repo: AgentProfileRepository,
    private readonly launcher: BotRuntimeLauncher,
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

      // Drive the runtime on whichever substrate this controller is running on.
      // Keyed on the bot NAME: that is the compose service key and the Deployment
      // name alike — the agent UUID names neither.
      const running = status === 'active';
      const runtimeResult = await this.launcher.setRunning(updated.name, running);

      if (!runtimeResult.success) {
        logger.warn(
          { agentId, runtime: runtimeResult.runtime, error: runtimeResult.error },
          'Runtime operation did not succeed — status persisted but the bot runtime may be in an unexpected state',
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
          runtime: runtimeResult.runtime,
          operation: running ? 'start' : 'stop',
          success: runtimeResult.success,
          error: runtimeResult.error,
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