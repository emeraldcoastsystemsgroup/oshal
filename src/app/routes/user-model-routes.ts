/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Haven user-model routes (ADR-079): the signed-in user's own model — view facts, teach a rule, forget a fact, and pull proactive suggestions (lazy sweep on arrival). Caller-scoped via OIDC sub; mounted behind requiresAuth in server.ts. User control is the point: this is THEIR model of THEM.
 */

import { Router, type Request } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { userModelFor } from '@/features/user-model';

const logger = createChildLogger({ module: 'user-model-routes' });

/** The signed-in caller's OIDC sub, or null. */
function callerSub(req: Request): string | null {
  const user = (req as Request & { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return user?.sub ? String(user.sub) : null;
}

/**
 * @description Routes for the caller's own Haven user model. Every read/write is scoped to the
 * OIDC sub — there is no cross-user access surface here by construction.
 * @param ctx - App context (Postgres pool).
 * @returns Express router (mount behind requiresAuth).
 */
export function createUserModelRoutes(ctx: AppContext): Router {
  const router = Router();
  const svc = () => userModelFor(ctx.pool);

  // The caller's model: facts grouped for display (their data, visible + controllable).
  router.get('/', async (req, res) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'sign in required' }); return; }
    try {
      const facts = await svc().getFacts(sub, false);
      res.json({
        facts: facts.map((f) => ({
          factId: f.factId, facet: f.facet, key: f.factKey, value: f.factValue,
          confidence: Number(f.confidence.toFixed(2)), source: f.source, active: f.active,
          lastSeen: f.lastSeen.toISOString(),
        })),
      });
    } catch (err) {
      logger.error({ err }, 'user-model list failed');
      res.status(500).json({ error: 'could not load your model' });
    }
  });

  // Explicit teach: "always keep answers short" -> high-confidence standing rule.
  router.post('/teach', async (req, res) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'sign in required' }); return; }
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    try {
      const stored = await svc().teach(sub, text);
      if (!stored) { res.status(400).json({ error: 'nothing teachable in that text' }); return; }
      res.json({ ok: true, fact: { facet: stored.facet, key: stored.factKey, value: stored.factValue } });
    } catch (err) {
      logger.error({ err }, 'user-model teach failed');
      res.status(500).json({ error: 'teach failed' });
    }
  });

  // User control: forget one fact permanently.
  router.delete('/facts/:factId', async (req, res) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'sign in required' }); return; }
    try {
      const removed = await svc().forget(sub, String(req.params.factId));
      res.status(removed ? 200 : 404).json({ ok: removed });
    } catch (err) {
      logger.error({ err }, 'user-model forget failed');
      res.status(500).json({ error: 'forget failed' });
    }
  });

  // Proactive suggestions (pull-based): lazily sweep (decay + compute) then return pending.
  router.get('/suggestions', async (req, res) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'sign in required' }); return; }
    try {
      await svc().sweep(sub);
      res.json({ suggestions: await svc().pendingSuggestions(sub) });
    } catch (err) {
      logger.error({ err }, 'user-model suggestions failed');
      res.status(500).json({ error: 'suggestions unavailable' });
    }
  });

  // Dismiss / complete a suggestion.
  router.post('/suggestions/:suggestionId/resolve', async (req, res) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'sign in required' }); return; }
    const status = req.body?.status === 'done' ? 'done' as const : 'dismissed' as const;
    try {
      const ok = await svc().resolveSuggestion(sub, String(req.params.suggestionId), status);
      res.status(ok ? 200 : 404).json({ ok });
    } catch (err) {
      logger.error({ err }, 'user-model suggestion resolve failed');
      res.status(500).json({ error: 'resolve failed' });
    }
  });

  return router;
}
