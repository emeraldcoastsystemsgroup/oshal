/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm config propagation routes for cross-bot credential broadcast
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { ClaudeCodeAuthService } from '@/features/claude-code-auth';
import { SwarmBotRegistry } from '../swarm-bot-registry';

const logger = createChildLogger({ module: 'config-propagation-routes' });
const authService = new ClaudeCodeAuthService();

/**
 * @description Creates config propagation routes for broadcasting credentials across the swarm.
 * @returns Express Router with /propagate/claude-code-auth endpoint
 */
export function createConfigPropagationRoutes(): Router {
  const router = Router();

  /**
   * @description Reads Claude Code credentials from the current bot and imports them into all other bots.
   * POST /api/swarm/config/propagate/claude-code-auth
   */
  router.post('/propagate/claude-code-auth', async (_req: Request, res: Response) => {
    const startedAt = Date.now();
    const selfIdentity = SwarmBotRegistry.resolveRuntimeIdentity(process.env);
    logger.info({ selfName: selfIdentity.agentName }, 'Starting Claude Code credential propagation');

    const credentials = authService.getCredentials();
    if (!credentials) {
      res.status(400).json({
        success: false,
        error: 'No valid Claude Code credentials found on this bot. Sign in first.',
      });
      return;
    }

    const allBots = SwarmBotRegistry.listDefinitions();
    const targets = allBots.filter((bot) => bot.name !== selfIdentity.agentName);
    const results: Array<{ name: string; port: number; success: boolean; error?: string }> = [];

    await Promise.all(targets.map(async (bot) => {
      const internalUrl = `http://${bot.container}:5000/api/claude-code/auth/import`;
      try {
        const response = await fetch(internalUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credentials }),
          signal: AbortSignal.timeout(10000),
        });
        const payload = await response.json() as Record<string, unknown>;
        if (response.ok && payload.success) {
          results.push({ name: bot.name, port: bot.port, success: true });
        } else {
          const errorMessage = String(payload.error || `HTTP ${response.status}`);
          results.push({ name: bot.name, port: bot.port, success: false, error: errorMessage });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn({ bot: bot.name, err: errorMessage }, 'Failed to propagate credentials to bot');
        results.push({ name: bot.name, port: bot.port, success: false, error: errorMessage });
      }
    }));

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;
    logger.info(
      { durationMs: Date.now() - startedAt, successCount, failCount, totalTargets: targets.length },
      'Claude Code credential propagation completed',
    );

    res.json({
      success: failCount === 0,
      source: selfIdentity.agentName,
      propagated: successCount,
      failed: failCount,
      total: targets.length,
      results,
    });
  });

  /**
   * @description Returns the full config propagation status for all bots (reads config endpoint from each).
   * GET /api/swarm/config/propagate/claude-code-auth/status
   */
  router.get('/propagate/claude-code-auth/status', async (_req: Request, res: Response) => {
    const selfIdentity = SwarmBotRegistry.resolveRuntimeIdentity(process.env);
    const allBots = SwarmBotRegistry.listDefinitions();

    const statuses = await Promise.all(allBots.map(async (bot) => {
      const isSelf = bot.name === selfIdentity.agentName;
      if (isSelf) {
        const status = await authService.getStatus();
        return { name: bot.name, port: bot.port, isSelf: true, authenticated: status.authenticated };
      }
      try {
        const internalUrl = `http://${bot.container}:5000/api/claude-code/auth/status`;
        const response = await fetch(internalUrl, { signal: AbortSignal.timeout(5000) });
        const payload = await response.json() as Record<string, unknown>;
        return { name: bot.name, port: bot.port, isSelf: false, authenticated: !!payload.authenticated };
      } catch {
        return { name: bot.name, port: bot.port, isSelf: false, authenticated: false, unreachable: true };
      }
    }));

    res.json({ success: true, bots: statuses });
  });

  return router;
}
