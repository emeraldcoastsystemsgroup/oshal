/**
 * Caller-owned social signal subscription routes. content-routes mounts them on its router, so
 * they live under /api/content behind requiresAuth (server-auxiliary-routes). Every handler
 * resolves the authenticated caller and answers only for that caller; the pool underneath is
 * the GUC-aware application pool, so owner row-level security on both tables enforces the same
 * boundary a second time.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Moved POST/GET/DELETE /subscriptions out of content-routes so they can be driven over real HTTP without the content assistant's research and prewarm side effects. Added bot binding (a botAgentId no active registry entry carries is refused 400 unknown_bot before anything is persisted) and the owner-only GET /subscriptions/:subscriptionId/deliveries audit read (404 for a subscription the caller does not own). Each handler logs its outcome and duration and logs failures at ERROR.
 *
 * @module routes/social-signal-routes
 */

import type { Request, Response, Router } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  deleteSocialSignalSubscription,
  isRegisteredSocialSignalBot,
  listSocialSignalDeliveries,
  listSocialSignalSubscriptions,
  parseSocialSignalBotAgentId,
  parseSocialSignalSelector,
  registerSocialSignalSubscription,
} from './social-signal-subscriptions';

const logger = createChildLogger({ module: 'social-signal-routes' });
const SUBSCRIPTION_ID = /^[0-9a-f-]{36}$/i;

/** What the subscription routes need from their host router. */
export interface SocialSignalRouteDeps {
  /** GUC-aware application pool; queries run under the caller's request identity. */
  pool: Pool;
  /** Bot binding check; defaults to the active swarm bot registry. */
  isRegisteredBot?: (botAgentId: string) => boolean;
}

type Handler = (req: Request, res: Response, sub: string) => Promise<void>;

function callerSub(req: Request): string | null {
  const user = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return user?.sub ? String(user.sub) : null;
}

/**
 * Resolve the caller (401 without one), run the handler, and log its outcome and duration.
 * A thrown handler answers 502 without echoing the error.
 */
function ownerRoute(name: string, handler: Handler) {
  return async (req: Request, res: Response): Promise<void> => {
    const started = Date.now();
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      await handler(req, res, sub);
      logger.info({ route: name, status: res.statusCode, durationMs: Date.now() - started }, 'social signal route completed');
    } catch (err) {
      logger.error({ err, route: name, durationMs: Date.now() - started }, 'social signal route failed');
      if (!res.headersSent) res.status(502).json({ error: 'subscription_unavailable' });
    }
  };
}

function subscriptionIdParam(req: Request, res: Response): string | null {
  const subscriptionId = String(req.params.subscriptionId || '');
  if (SUBSCRIPTION_ID.test(subscriptionId)) return subscriptionId;
  res.status(400).json({ error: 'invalid_subscription_id' });
  return null;
}

function registerHandler(deps: Required<SocialSignalRouteDeps>): Handler {
  return async (req, res, sub) => {
    const body = req.body as { botAgentId?: unknown; selector?: unknown } | undefined;
    const botAgentId = parseSocialSignalBotAgentId(body?.botAgentId);
    const selector = parseSocialSignalSelector(body?.selector);
    if (!botAgentId || !selector) {
      res.status(400).json({ error: 'botAgentId and a bounded selector { kind, value } are required' });
      return;
    }
    if (!deps.isRegisteredBot(botAgentId)) {
      res.status(400).json({ error: 'unknown_bot', message: 'botAgentId is not a registered bot on this swarm' });
      return;
    }
    const subscriptionId = await registerSocialSignalSubscription(deps.pool, sub, botAgentId, selector);
    res.status(201).json({ subscriptionId, botAgentId, selector, active: true });
  };
}

function deliveriesHandler(pool: Pool): Handler {
  return async (req, res, sub) => {
    const subscriptionId = subscriptionIdParam(req, res);
    if (!subscriptionId) return;
    const deliveries = await listSocialSignalDeliveries(pool, sub, subscriptionId);
    if (!deliveries) { res.status(404).json({ error: 'subscription_not_found' }); return; }
    res.json({ subscriptionId, deliveries });
  };
}

/**
 * @description Mount the caller-owned subscription routes on a router that is already behind
 * requiresAuth: register (with bot binding), list, disable, and the owner-only delivery audit.
 * Captured message bodies are never returned by these routes; the audit exposes message ids,
 * lanes and correlation ids only.
 * @param router - The /api/content router.
 * @param deps - Pool and optional bot binding check.
 * @returns Nothing; the routes are registered on `router`.
 */
export function mountSocialSignalSubscriptionRoutes(router: Router, deps: SocialSignalRouteDeps): void {
  const resolved: Required<SocialSignalRouteDeps> = {
    pool: deps.pool,
    isRegisteredBot: deps.isRegisteredBot ?? ((botAgentId) => isRegisteredSocialSignalBot(botAgentId)),
  };
  router.post('/subscriptions', ownerRoute('register', registerHandler(resolved)));
  router.get('/subscriptions', ownerRoute('list', async (_req, res, sub) => {
    res.json({ subscriptions: await listSocialSignalSubscriptions(resolved.pool, sub) });
  }));
  router.delete('/subscriptions/:subscriptionId', ownerRoute('disable', async (req, res, sub) => {
    const subscriptionId = subscriptionIdParam(req, res);
    if (!subscriptionId) return;
    res.json({ ok: await deleteSocialSignalSubscription(resolved.pool, sub, subscriptionId) });
  }));
  router.get('/subscriptions/:subscriptionId/deliveries', ownerRoute('deliveries', deliveriesHandler(resolved.pool)));
}
