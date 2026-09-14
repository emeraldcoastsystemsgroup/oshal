/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve partial per-user setup progress, validate writes and report unavailable persistence instead of claiming a fresh installation.
 */

import { Router, Request, Response } from 'express';
import type { AppContext } from '../composition/app-context';
import { z } from 'zod';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'onboarding-routes' });
const updateSchema = z.object({
  completed: z.boolean().optional(), currentStep: z.number().int().min(0).max(100).optional(),
  data: z.record(z.unknown()).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 16384).optional(),
}).strict();

function caller(req: Request): string | null {
  const oidc = (req as Request & { oidc?: { isAuthenticated?: () => boolean; user?: { sub?: unknown } } }).oidc;
  const sub = oidc?.user?.sub;
  return oidc?.isAuthenticated?.() && typeof sub === 'string' && sub.length > 0 ? sub : null;
}

function sameOrigin(req: Request): boolean {
  try { return req.is('application/json') !== false && new URL(req.get('origin') || '').origin === `${req.protocol}://${req.get('host')}`; }
  catch { return false; }
}

/**
 * @description Builds the Express router that exposes per-user onboarding state
 * so the UI can resume a partially completed onboarding flow across sessions.
 * Partial updates preserve previously completed choices. A failed database read is
 * unavailable, never evidence that an existing user is visiting for the first time.
 * Identity comes exclusively from the authenticated session.
 * @param ctx Application context providing shared dependencies (database pool).
 * @returns An Express Router with GET/PUT handlers under '/user/onboarding'.
 */
export function createOnboardingRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/user/onboarding', readProgress(ctx.pool));
  router.put('/user/onboarding', writeProgress(ctx.pool));
  return router;
}

function readProgress(pool: AppContext['pool']) {
  return async (req: Request, res: Response) => {
    const userId = caller(req);
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
    try {
      const result = await pool.query(
        `SELECT onboarding_completed, onboarding_step, onboarding_data
         FROM user_preferences WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return res.json({ completed: false, currentStep: 0, data: {} });
      }

      const row = result.rows[0];
      res.json({
        completed: row.onboarding_completed ?? false,
        currentStep: row.onboarding_step ?? 0,
        data: row.onboarding_data ?? {},
      });
    } catch (err) {
      logger.error({ err }, 'Could not read onboarding progress');
      res.status(503).json({ error: 'Onboarding progress is temporarily unavailable' });
    }
  };
}

function writeProgress(pool: AppContext['pool']) {
  return async (req: Request, res: Response) => {
    const userId = caller(req);
    if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
    if (!sameOrigin(req)) { res.status(403).json({ error: 'Same-origin JSON request required' }); return; }
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid onboarding progress' }); return; }
    const { completed, currentStep, data } = parsed.data;

    try {
      await pool.query(
        `INSERT INTO user_preferences (user_id, onboarding_completed, onboarding_step, onboarding_data)
         VALUES ($1, COALESCE($2, FALSE), COALESCE($3, 0), $4::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET
           onboarding_completed = COALESCE($2, user_preferences.onboarding_completed),
           onboarding_step = COALESCE($3, user_preferences.onboarding_step),
           onboarding_data = COALESCE(user_preferences.onboarding_data, '{}'::jsonb) || $4::jsonb,
           updated_at = NOW()`,
        [userId, completed ?? null, currentStep ?? null, JSON.stringify(data ?? {})]
      );
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Could not save onboarding progress');
      res.status(500).json({ error: 'Failed to save onboarding state' });
    }
  };
}
