/**
 * Slack Routes — the connector-level LIVE read of the caller's own Slack messages.
 *
 * Thin layer over slack-client.pullSlackFeed using the caller's USER token (stored by the
 * connector hub under provider 'slack'). For the durable, indexed, analyzed experience see
 * the Feeds app (feeds-routes / feeds-indexing) which builds on the same client.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Slack feed reader.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Refactor onto shared slack-client;
 *            | the Feeds app now owns the indexed surface.
 * ---------------------------------------------------------------------------
 * @module slack-routes
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { getValidAccessToken } from './connectors-routes';
import { pullSlackFeed } from './slack-client';

const logger = createChildLogger({ module: 'slack-routes' });
const FEED_DEFAULT = 50;
const FEED_MAX = 200;

/** The authenticated caller's OIDC sub (never client-supplied). */
function callerSub(req: Request): string | null {
  const oidc = (req as any).oidc;
  if (oidc && typeof oidc.isAuthenticated === 'function' && oidc.isAuthenticated()) {
    const sub = (oidc.user || {}).sub || (oidc.user || {}).oid;
    if (sub) return String(sub);
  }
  return null;
}

/**
 * @description Slack feed sub-router (mounted at /api/slack, requiresAuth).
 * @param ctx - app context (db pool)
 * @returns an Express router
 */
export function createSlackRoutes(ctx: AppContext): Router {
  const router = Router();

  /** GET /api/slack/status — is the caller connected? (no token ever leaves the server) */
  router.get('/status', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not authenticated' }); return; }
    try {
      const token = await getValidAccessToken(ctx.pool, sub, 'slack');
      res.json({ connected: !!token });
    } catch (err: any) {
      logger.error({ err }, 'slack status failed');
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/slack/feed?limit=N — the caller's recent messages, live (not indexed). */
  router.get('/feed', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not authenticated' }); return; }
    const limit = Math.min(FEED_MAX, Math.max(1, parseInt(String(req.query.limit || ''), 10) || FEED_DEFAULT));
    try {
      const token = await getValidAccessToken(ctx.pool, sub, 'slack');
      if (!token) { res.status(404).json({ error: 'not connected', connectUrl: '/api/connect/slack/start' }); return; }
      const { messages, meta } = await pullSlackFeed(token);
      res.json({ count: Math.min(messages.length, limit), messages: messages.slice(0, limit), truncated: meta });
    } catch (err: any) {
      logger.error({ err }, 'slack feed failed');
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
