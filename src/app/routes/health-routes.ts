/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of LLM provider health check endpoint
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched health check to dynamic provider resolver and added structured route logging
 */

/**
 * @description
 * Express route for LLM provider health check. Calls provider.testConnection() and returns result.
 */

import type { Request, Response, Router } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '../composition-root';

const logger = createChildLogger({ module: 'health-routes' });

/**
 * @description Register health-check endpoints for runtime diagnostics.
 *
 * @param router - Express router instance
 * @param ctx - Application context with provider resolver
 * @returns Void after route registration
 */
export function registerHealthRoutes(router: Router, ctx: AppContext) {
  /**
   * @route GET /health/llm
   * @description Health check for the current LLM provider.
   */
  router.get('/health/llm', async (req: Request, res: Response) => {
    const startTime = Date.now();
    logger.info({ method: req.method, path: req.path }, 'Health route invoked');

    try {
      const provider = ctx.getProvider();
      const providerName = provider.getProviderName();
      const ok = await provider.testConnection();

      logger.info(
        { durationMs: Date.now() - startTime, providerName, ok },
        'LLM health check completed',
      );
      res.status(ok ? 200 : 500).json({ ok, provider: providerName });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startTime }, 'LLM health check failed');
      res.status(500).json({ ok: false, error: (error as Error).message });
    }
  });
}
