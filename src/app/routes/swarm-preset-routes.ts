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
 * @description Builds the Express router that exposes per-user CRUD endpoints for
 * saved "swarm presets" (named, reusable combinations of bots and phase
 * configuration). Wiring the routes through a factory lets the application
 * inject its composed dependencies (notably the database pool) so the handlers
 * stay stateless and testable, and scopes every operation to the authenticated
 * user so presets remain private and isolated.
 * @param ctx The application context supplying shared dependencies such as the database pool.
 * @returns A configured Express Router exposing the swarm-preset list, create, update, and delete endpoints.
 */
export function createSwarmPresetRoutes(ctx: AppContext): Router {
  const router = Router();
  const pool = ctx.pool;

  // List presets for current user
  router.get('/swarm-presets', async (req: Request, res: Response) => {
    const userId = (req as any).oidc?.user?.sub ?? 'anonymous';
    try {
      const result = await pool.query(
        `SELECT id, name, description, bot_ids, phase_config, created_at, updated_at
         FROM swarm_presets WHERE user_id = $1 ORDER BY updated_at DESC`,
        [userId]
      );
      const presets = result.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        botIds: r.bot_ids,
        botCount: r.bot_ids?.length ?? 0,
        phaseConfig: r.phase_config,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      res.json({ presets });
    } catch {
      res.json({ presets: [] });
    }
  });

  // Create preset
  router.post('/swarm-presets', async (req: Request, res: Response) => {
    const userId = (req as any).oidc?.user?.sub ?? 'anonymous';
    const { name, description, botIds, phaseConfig } = req.body;
    if (!name || !botIds?.length) {
      return res.status(400).json({ error: 'name and botIds are required' });
    }
    try {
      const result = await pool.query(
        `INSERT INTO swarm_presets (user_id, name, description, bot_ids, phase_config)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, name, description ?? '', botIds, JSON.stringify(phaseConfig ?? {})]
      );
      res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create preset' });
    }
  });

  // Update preset
  router.put('/swarm-presets/:id', async (req: Request, res: Response) => {
    const userId = (req as any).oidc?.user?.sub ?? 'anonymous';
    const { name, description, botIds, phaseConfig } = req.body;
    try {
      await pool.query(
        `UPDATE swarm_presets SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           bot_ids = COALESCE($3, bot_ids),
           phase_config = COALESCE($4, phase_config),
           updated_at = NOW()
         WHERE id = $5 AND user_id = $6`,
        [name, description, botIds, phaseConfig ? JSON.stringify(phaseConfig) : null, req.params.id, userId]
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to update preset' });
    }
  });

  // Delete preset
  router.delete('/swarm-presets/:id', async (req: Request, res: Response) => {
    const userId = (req as any).oidc?.user?.sub ?? 'anonymous';
    try {
      await pool.query(
        `DELETE FROM swarm_presets WHERE id = $1 AND user_id = $2`,
        [req.params.id, userId]
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete preset' });
    }
  });

  return router;
}