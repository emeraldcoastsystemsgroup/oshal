/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added capability expansion + agent config API routes
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { Router, type Request, type Response } from 'express';
import type { CapabilityExpansionService } from '@/features/agent-management';
import type { AgentConfigService } from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'capability-expansion-routes' });

/**
 * @description Creates routes for capability expansion and per-agent config management.
 * Ported from the legacy implementation's /api/agents/expand-capability and /api/agents/:id/config endpoints.
 * @param expansionService - CapabilityExpansionService instance
 * @param configService - AgentConfigService instance
 * @returns Express router
 */
export function createCapabilityExpansionRoutes(
  expansionService: CapabilityExpansionService,
  configService: AgentConfigService,
): Router {
  const router = Router();

  // ─── Capability Expansion ────────────────────────────────────────────

  /**
   * POST /api/swarm/agents/expand-capability — Expand an agent's capabilities with a new tool.
   */
  router.post('/expand-capability', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ agentId: req.body?.agentId ?? null }, 'POST /api/swarm/agents/expand-capability');
    try {
      const { agentId, tool, configFields } = req.body;
      if (!agentId || !tool?.toolName || !tool?.description || !tool?.capabilities) {
        logger.warn({ durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents/expand-capability missing required fields');
        res.status(400).json({
          error: 'Missing required fields: agentId, tool.toolName, tool.description, tool.capabilities',
        });
        return;
      }
      const result = await expansionService.expand({ agentId, tool, configFields });
      logger.info({ agentId, success: result.success, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents/expand-capability complete');
      res.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents/expand-capability failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/swarm/agents/expand-capability/validate — Dry-run validation of expansion spec.
   */
  router.post('/expand-capability/validate', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ agentId: req.body?.agentId ?? null }, 'POST /api/swarm/agents/expand-capability/validate');
    try {
      const { agentId, tool, configFields } = req.body;
      const result = await expansionService.validate({ agentId, tool, configFields });
      logger.info({ agentId, valid: result.valid, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents/expand-capability/validate complete');
      res.json(result);
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'POST /api/swarm/agents/expand-capability/validate failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/swarm/agents/:agentId/expansion-history — Get expansion history for an agent.
   */
  router.get('/:agentId/expansion-history', (req: Request, res: Response) => {
    const history = expansionService.getExpansionHistory(req.params.agentId as string);
    res.json({ agentId: req.params.agentId, history });
  });

  // ─── Agent Config ────────────────────────────────────────────────────

  /**
   * GET /api/swarm/agents/:agentId/config — Get config schema + values for an agent.
   */
  router.get('/:agentId/config', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ agentId: req.params.agentId }, 'GET /api/swarm/agents/:agentId/config');
    try {
      const config = await configService.getConfig(req.params.agentId as string);
      if (!config) {
        logger.warn({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'GET /api/swarm/agents/:agentId/config not found');
        res.status(404).json({ error: 'No config found for this agent' });
        return;
      }
      logger.info({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'GET /api/swarm/agents/:agentId/config complete');
      res.json(config);
    } catch (error) {
      logger.error({ err: error, agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'GET /api/swarm/agents/:agentId/config failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * PUT /api/swarm/agents/:agentId/config — Set config schema and/or values for an agent.
   * Body: { schema?: ConfigField[], values?: Record<string, unknown> }
   */
  router.put('/:agentId/config', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ agentId: req.params.agentId }, 'PUT /api/swarm/agents/:agentId/config');
    try {
      const agentId = req.params.agentId as string;
      const { schema, values } = req.body;

      if (schema) {
        await configService.setConfigSchema(agentId, schema);
      }
      if (values) {
        await configService.setConfigValues(agentId, values);
      }
      if (!schema && !values) {
        logger.warn({ agentId, durationMs: Date.now() - startedAt }, 'PUT /api/swarm/agents/:agentId/config missing schema and values');
        res.status(400).json({ error: 'Provide at least one of: schema, values' });
        return;
      }

      const config = await configService.getConfig(agentId);
      logger.info({ agentId, durationMs: Date.now() - startedAt }, 'PUT /api/swarm/agents/:agentId/config complete');
      res.json(config);
    } catch (error) {
      logger.error({ err: error, agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'PUT /api/swarm/agents/:agentId/config failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * DELETE /api/swarm/agents/:agentId/config — Delete all config for an agent.
   */
  router.delete('/:agentId/config', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ agentId: req.params.agentId }, 'DELETE /api/swarm/agents/:agentId/config');
    try {
      const deleted = await configService.deleteConfig(req.params.agentId as string);
      if (!deleted) {
        logger.warn({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'DELETE /api/swarm/agents/:agentId/config not found');
        res.status(404).json({ error: 'No config found for this agent' });
        return;
      }
      logger.info({ agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'DELETE /api/swarm/agents/:agentId/config complete');
      res.json({ deleted: true, agentId: req.params.agentId });
    } catch (error) {
      logger.error({ err: error, agentId: req.params.agentId, durationMs: Date.now() - startedAt }, 'DELETE /api/swarm/agents/:agentId/config failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/swarm/agents/configs/list — List all agents that have config registered.
   */
  router.get('/configs/list', async (_req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info('GET /api/swarm/agents/configs/list');
    try {
      const agents = await configService.listConfiguredAgents();
      logger.info({ count: agents.length, durationMs: Date.now() - startedAt }, 'GET /api/swarm/agents/configs/list complete');
      res.json({ agents });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'GET /api/swarm/agents/configs/list failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  logger.info('Capability expansion routes registered');
  return router;
}
