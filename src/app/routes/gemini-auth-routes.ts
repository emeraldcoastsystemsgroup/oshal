/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Gemini connect-state route (Plan E residual). GET /status reports {connected, method, reason, expiresAt?} from the llm-provider probe over GEMINI_API_KEY/GOOGLE_API_KEY + ~/.gemini/oauth_creds.json. Status-ONLY by operator doctrine: the vendor's own CLI login runs host-side (Connect-AI.bat / run `gemini` once) — no /start, no /callback, no Google OAuth client here, ever. Factory takes requiresAuth and applies it per-route (claude-code-auth-routes pattern) so the server.ts mount classifies 'oidc' in the route-auth inventory guard.
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getGeminiAuthStatus } from '@/features/llm-provider';

const logger = createChildLogger({ module: 'gemini-auth-routes' });

/**
 * @description Creates the Gemini connect-state routes used by the Utilities
 * "Bot LLM access" surface. Deliberately status-only: connecting happens by
 * running the vendor's own login on the host (`gemini` once, or Connect-AI.bat),
 * whose credential file docker-compose mounts into the containers — the surface
 * polls this route until that login lands.
 * @param requiresAuth - Session middleware requiring authenticated OSHAL user context
 * @returns Express router with the Gemini auth-status endpoint
 */
export function createGeminiAuthRoutes(requiresAuth: RequestHandler): Router {
  const router = Router();

  router.get('/status', requiresAuth, (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ method: req.method, path: req.path }, 'Gemini auth status route invoked');

    try {
      // Shared, host-mounted platform credential (like the Claude Code one):
      // the probe never exposes token material or the account identity —
      // only connected/method/reason/expiry, safe for any signed-in tenant.
      const status = getGeminiAuthStatus();
      res.json({ success: true, ...status });
      logger.info(
        { durationMs: Date.now() - startedAt, connected: status.connected, authMethod: status.method, reason: status.reason },
        'Gemini auth status route completed',
      );
    } catch (error) {
      logger.error({ err: error }, 'Gemini auth status route failed');
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
