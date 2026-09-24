/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Add authenticated GET /api/ops/refusals with bounded trailing-window reads whose visibility remains caller-scoped by the ledger RLS policy.
 */

import { Router, type RequestHandler } from 'express';
import type { PostgresRefusalStore } from '@/features/refusal-visibility';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'refusal-routes' });
const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 7 * 24;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** @description Parse and clamp one positive integer query parameter. */
function bounded(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(1, Math.floor(parsed))) : fallback;
}

/** @description Build the read-only, authenticated refusal-ledger route. */
export function createRefusalRoutes(
  store: Pick<PostgresRefusalStore, 'listRecent'>,
  requiresAuth: RequestHandler,
): Router {
  const router = Router();
  router.get('/', requiresAuth, async (req, res) => {
    const hours = bounded(req.query.hours, DEFAULT_WINDOW_HOURS, MAX_WINDOW_HOURS);
    const limit = bounded(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
    res.set('Cache-Control', 'private, no-store');
    try {
      const refusals = await store.listRecent(hours, limit);
      res.json({ refusals, count: refusals.length, windowHours: hours });
    } catch (error) {
      logger.error({ err: error, hours, limit }, 'Refusal ledger read failed');
      res.status(503).json({ error: 'refusal_ledger_unavailable' });
    }
  });
  return router;
}
