/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added checkpoint lookup, restore, and delete API routes for non-swarm memory layers
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '../composition-root';

const logger = createChildLogger({ module: 'checkpoint-routes' });

/**
 * @description Creates checkpoint lifecycle routes.
 *
 * @param ctx - Application context
 * @returns Router for checkpoint detail, restore, and delete endpoints
 */
export function createCheckpointRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/:checkpointId', handleGetCheckpoint(ctx));
  router.post('/:checkpointId/restore', handleRestoreCheckpoint(ctx));
  router.delete('/:checkpointId', handleDeleteCheckpoint(ctx));
  logger.info('Checkpoint routes registered');
  return router;
}

function handleGetCheckpoint(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const checkpointId = String(req.params.checkpointId);
    logger.info({ checkpointId }, 'GET /api/checkpoints/:checkpointId');
    try {
      const checkpoint = await ctx.memoryService.getCheckpoint(checkpointId);
      if (!checkpoint) {
        res.status(404).json({ error: 'Checkpoint not found' });
        return;
      }
      res.json({ checkpoint });
    } catch (error) {
      logger.error({ err: error, checkpointId }, 'Failed to get checkpoint');
      res.status(500).json({ error: 'Failed to get checkpoint' });
    }
  };
}

function handleRestoreCheckpoint(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const checkpointId = String(req.params.checkpointId);
    logger.info({ checkpointId }, 'POST /api/checkpoints/:checkpointId/restore');
    try {
      const task = await ctx.memoryService.restoreCheckpoint(checkpointId);
      res.json({ success: true, task, checkpointId, message: 'Task restored from checkpoint' });
    } catch (error) {
      logger.error({ err: error, checkpointId }, 'Failed to restore checkpoint');
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to restore checkpoint' });
    }
  };
}

function handleDeleteCheckpoint(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const checkpointId = String(req.params.checkpointId);
    logger.info({ checkpointId }, 'DELETE /api/checkpoints/:checkpointId');
    try {
      const deleted = await ctx.memoryService.deleteCheckpoint(checkpointId);
      if (!deleted) {
        res.status(404).json({ error: 'Checkpoint not found' });
        return;
      }
      res.json({ success: true, checkpointId, message: 'Checkpoint deleted' });
    } catch (error) {
      logger.error({ err: error, checkpointId }, 'Failed to delete checkpoint');
      res.status(500).json({ error: 'Failed to delete checkpoint' });
    }
  };
}
