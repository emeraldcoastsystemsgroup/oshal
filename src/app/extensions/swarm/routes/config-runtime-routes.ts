/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added per-agent runtime config routes — OSHAL-owned provider/model push-down + read (ADR-034)
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { ConfigSyncService, RuntimeParams } from '@/features/config-sync';
import type { AgentConfigService } from '@/features/agent-management';

const logger = createChildLogger({ module: 'config-runtime-routes' });

/**
 * @description Per-agent runtime configuration routes (ADR-034). This is the OSHAL-owned,
 * UI-passthrough surface declared as `perAgentRuntime` in the config ownership contract:
 * reading returns the authoritative record; writing pushes the change down to the live bot
 * (via ConfigSyncService.switchProvider) and records it authoritatively with a version bump.
 *
 * @param configSync - The bidirectional config sync service (undefined when no Postgres pool).
 * @param agentConfig - The authoritative per-agent config store.
 * @returns Express Router mounted under /api/agents.
 */
export function createConfigRuntimeRoutes(
  configSync: ConfigSyncService | undefined,
  agentConfig: AgentConfigService | undefined,
): Router {
  const router = Router();

  /**
   * @description Returns the authoritative runtime-param record for an agent.
   * GET /api/agents/:agentId/runtime
   */
  router.get('/:agentId/runtime', async (req: Request, res: Response) => {
    const agentId = String(req.params.agentId);
    if (!agentConfig) {
      res.status(503).json({ success: false, error: 'Agent config store unavailable (no Postgres pool)' });
      return;
    }
    try {
      const config = await agentConfig.getConfig(agentId);
      if (!config) {
        res.status(404).json({ success: false, error: `No config record for agent ${agentId}` });
        return;
      }
      const values = config.values || {};
      res.json({
        success: true,
        agentId: config.agentId,
        runtime: {
          providerId: values.providerId ?? null,
          modelId: values.modelId ?? null,
          mode: values.mode ?? null,
          requestTimeoutMs: values.requestTimeoutMs ?? null,
        },
        configVersion: Number(values.configVersion ?? 0),
        updatedAt: config.updatedAt,
      });
    } catch (err) {
      logger.error({ err, agentId: agentId }, 'Failed to read agent runtime config');
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /**
   * @description Sets an agent's runtime params: pushes the change down to the live bot and
   * records it as the new authoritative value. This is how OSHAL changes a running bot's
   * configuration (the previously-dead control edge).
   * PUT /api/agents/:agentId/runtime  { providerId, modelId?, mode?, requestTimeoutMs?, credentials? }
   */
  router.put('/:agentId/runtime', async (req: Request, res: Response) => {
    const agentId = String(req.params.agentId);
    if (!configSync) {
      res.status(503).json({ success: false, error: 'Config sync service unavailable (no Postgres pool)' });
      return;
    }
    const { providerId, modelId, mode, requestTimeoutMs, credentials } = req.body ?? {};
    if (!providerId && !modelId) {
      res.status(400).json({ success: false, error: 'At least one of providerId or modelId is required' });
      return;
    }
    const params: RuntimeParams = { providerId, modelId, mode, requestTimeoutMs };
    try {
      const result = await configSync.pushToBot(
        agentId,
        params,
        credentials as Record<string, string> | undefined,
      );
      // pushed=false with a reason means the live bot rejected/was unreachable — surface 502
      // so the caller knows the record did not advance, rather than reporting a false success.
      if (result.reason) {
        res.status(502).json({ success: false, error: result.reason, ...result });
        return;
      }
      res.json({ success: true, agentId: agentId, ...result });
    } catch (err) {
      logger.error({ err, agentId: agentId }, 'Failed to push agent runtime config');
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
