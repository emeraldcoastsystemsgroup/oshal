/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

import { Router, Request, Response } from 'express';
import type { AppContext } from '../composition/app-context';

/**
 * @description Builds the Express router that exposes per-user onboarding state
 * so the UI can resume a partially completed onboarding flow across sessions.
 * Persistence is intentionally tolerant: reads fall back to a fresh default
 * state when the backing table is unavailable, allowing the app to function
 * before migrations have run. The user identity is derived from the OIDC
 * session, defaulting to 'anonymous' when unauthenticated.
 * @param ctx Application context providing shared dependencies (database pool).
 * @returns An Express Router with GET/PUT handlers under '/user/onboarding'.
 */
export function createOnboardingRoutes(ctx: AppContext): Router {
  const router = Router();
  const pool = ctx.pool;

  // Get onboarding state for current user
  router.get('/user/onboarding', async (req: Request, res: Response) => {
    const userId = (req as any).oidc?.user?.sub ?? 'anonymous';
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
    } catch {
      // If table doesn't exist yet, return default
      res.json({ completed: false, currentStep: 0, data: {} });
    }
  });

  // Update onboarding state
  router.put('/user/onboarding', async (req: Request, res: Response) => {
    const userId = (req as any).oidc?.user?.sub ?? 'anonymous';
    const { completed, currentStep, data } = req.body;

    try {
      await pool.query(
        `INSERT INTO user_preferences (user_id, onboarding_completed, onboarding_step, onboarding_data)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           onboarding_completed = $2,
           onboarding_step = $3,
           onboarding_data = $4,
           updated_at = NOW()`,
        [userId, completed ?? false, currentStep ?? 0, JSON.stringify(data ?? {})]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save onboarding state' });
    }
  });

  return router;
}