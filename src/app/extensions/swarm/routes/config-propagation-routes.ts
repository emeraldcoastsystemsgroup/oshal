/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm config propagation routes for cross-bot credential broadcast
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Restricted fleet propagation to operators, authenticated every outbound credential/status request, and count only explicit imported:true acknowledgements as successful propagation
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: retire raw HTTP credential fan-out pending an ordered versioned rail with revocation tombstones; retain authenticated fleet status diagnostics only.
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { ClaudeCodeAuthService } from '@/features/claude-code-auth';
import { SwarmBotRegistry } from '../swarm-bot-registry';
import { requiresOperator, serviceSecretHeaders } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'config-propagation-routes' });
const authService = new ClaudeCodeAuthService();

/**
 * @description Creates the retired propagation endpoint and authenticated fleet auth-status route.
 * @returns Express Router with /propagate/claude-code-auth endpoint
 */
export function createConfigPropagationRoutes(): Router {
  const router = Router();
  // Credential broadcast and fleet-wide status are global control-plane operations.
  router.use(requiresOperator);

  /**
   * @description Refuses raw credential distribution until a versioned monotonic rail exists.
   * POST /api/swarm/config/propagate/claude-code-auth
   */
  router.post('/propagate/claude-code-auth', async (_req: Request, res: Response) => {
    const machineHeaders = serviceSecretHeaders();
    if (!machineHeaders['X-Service-Secret']) {
      res.status(503).json({ success: false, error: 'Credential propagation is not safely configured' });
      return;
    }
    logger.warn('Claude Code raw credential propagation refused: versioned revocation rail is unavailable');
    res.status(409).json({
      success: false,
      error: 'credential_distribution_disabled_pending_versioned_revocation_rail',
      propagated: 0,
    });
  });

  /**
   * @description Returns the full config propagation status for all bots (reads config endpoint from each).
   * GET /api/swarm/config/propagate/claude-code-auth/status
   */
  router.get('/propagate/claude-code-auth/status', async (_req: Request, res: Response) => {
    const selfIdentity = SwarmBotRegistry.resolveRuntimeIdentity(process.env);
    const allBots = SwarmBotRegistry.listDefinitions();
    const machineHeaders = serviceSecretHeaders();
    if (!machineHeaders['X-Service-Secret']) {
      res.status(503).json({ success: false, error: 'Credential status propagation is not safely configured' });
      return;
    }

    const statuses = await Promise.all(allBots.map(async (bot) => {
      const isSelf = bot.name === selfIdentity.agentName;
      if (isSelf) {
        const status = await authService.getStatus();
        return { name: bot.name, port: bot.port, isSelf: true, authenticated: status.authenticated };
      }
      try {
        const internalUrl = `http://${bot.container}:5000/api/claude-code/auth/status`;
        const response = await fetch(internalUrl, {
          headers: machineHeaders,
          signal: AbortSignal.timeout(5000),
        });
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
