/**
 * Forge Routes — the front door for the agentic-swarm-injection engine.
 *
 * Serves the Bot Forge surface (src/api/forge.html) referenced by
 * swarm-apps/codex-packer.yaml's ui.static. The Forge is the consumer face of the
 * proven pack→build→inject loop: the codex-packer chat agent (right rail) interviews
 * The operator and emits a packed bot; this surface is the gallery + lifecycle view
 * over the live swarm (list / open / export / unload / inject-from-YAML), driven
 * entirely by the existing /api/swarm/apps endpoints. It holds no state of its own.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — serves the Bot Forge front door at GET /api/forge (auth-gated), the productized face of codex-packer + agentic swarm injection.
 *
 * @module forge-routes
 */
import { Router, type Request, type Response } from 'express';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'forge-routes' });

/**
 * @description Builds the Bot Forge surface router (mount at /api/forge, requiresAuth).
 * The surface itself calls the existing /api/swarm/apps endpoints from the browser;
 * this route only serves the static HTML shell.
 * @param apiDir - directory holding the HTML surfaces (forge.html).
 * @returns Express router serving the Bot Forge front door.
 */
export function createForgeRoutes(apiDir: string): Router {
  const router = Router();

  /** GET / — the Bot Forge front door (gallery + lifecycle over the live swarm). */
  router.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(apiDir, 'forge.html'), (err) => {
      if (err) {
        logger.error({ err }, 'Failed to serve Bot Forge surface');
        res.status(404).send('Page not found');
      }
    });
  });

  return router;
}
