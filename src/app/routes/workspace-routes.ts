/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial workspace REST API: CRUD and path resolution
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Refactored to createWorkspaceRoutes(ctx) pattern matching codebase conventions
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Enforced per-user workspace isolation (IDOR fix). Create stamps owner_sub from the OIDC session; get/update/delete/ensure-path enforce owner-or-operator and 404 on mismatch (so ids are not oracle-able); list is scoped to the caller for non-operators. Previously any authenticated user could read, modify, or DELETE (incl. the on-disk directory) any tenant's workspace by guessing its id.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppContext } from '../composition-root';
import { CreateInternalWorkspaceSchema } from '@/entities/workspace';
import { createChildLogger } from '@/shared/logger';
import { canAccessResource, getCaller, isOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'workspace-routes' });

/**
 * @description Object-level authorization guard for workspace by-id routes. Loads the
 * workspace; if missing, or the caller is neither its owner nor an operator, responds
 * 404 (not 403, so ids cannot be probed) and returns null. Otherwise returns it.
 */
async function requireWorkspaceAccess(
  ctx: AppContext,
  req: Request,
  res: Response,
  workspaceId: string,
) {
  const workspace = await ctx.workspaceService.getWorkspace(workspaceId);
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }
  if (!canAccessResource(req, workspace.ownerSub)) {
    logger.warn({ workspaceId }, 'Workspace access denied (not owner/operator) — returning 404');
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }
  return workspace;
}

/**
 * @description Creates Express router with workspace REST API endpoints for CRUD operations.
 * @param ctx - Application context with workspace services
 * @returns Configured Express router
 */
export function createWorkspaceRoutes(ctx: AppContext): Router {
  const router = Router();

  /* ── POST / ──────────────────────────────────────────────────────── */
  router.post('/', async (req: Request, res: Response) => {
    logger.info('Create workspace requested');
    try {
      const parsed = CreateInternalWorkspaceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
        return;
      }
      // Stamp owner from the validated session; never trust a client-supplied ownerSub.
      const { sub } = getCaller(req);
      const workspace = await ctx.workspaceService.createWorkspace({ ...parsed.data, ownerSub: sub });
      res.status(201).json(workspace);
    } catch (error) {
      logger.error({ err: error }, 'Failed to create workspace');
      res.status(500).json({ error: 'Failed to create workspace' });
    }
  });

  /* ── GET / ───────────────────────────────────────────────────────── */
  router.get('/', async (req: Request, res: Response) => {
    logger.debug('List workspaces requested');
    try {
      const options: Record<string, unknown> = {};
      if (req.query.projectName) options.projectName = String(req.query.projectName);
      if (req.query.limit) options.limit = Number(req.query.limit);
      if (req.query.offset) options.offset = Number(req.query.offset);
      // Non-operators see only their own workspaces; operators see all.
      const { sub } = getCaller(req);
      if (!isOperator(req) && sub) options.ownerSub = sub;

      const workspaces = await ctx.workspaceService.listWorkspaces(options as any);
      res.json({ workspaces, count: workspaces.length });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list workspaces');
      res.status(500).json({ error: 'Failed to list workspaces' });
    }
  });

  /* ── GET /:workspaceId ───────────────────────────────────────────── */
  router.get('/:workspaceId', async (req: Request, res: Response) => {
    const { workspaceId } = req.params;
    logger.debug({ workspaceId }, 'Get workspace requested');
    try {
      const workspace = await requireWorkspaceAccess(ctx, req, res, workspaceId as string);
      if (!workspace) return;
      res.json(workspace);
    } catch (error) {
      logger.error({ err: error }, 'Failed to get workspace');
      res.status(500).json({ error: 'Failed to get workspace' });
    }
  });

  /* ── PATCH /:workspaceId ─────────────────────────────────────────── */
  router.patch('/:workspaceId', async (req: Request, res: Response) => {
    const { workspaceId } = req.params;
    logger.info({ workspaceId }, 'Update workspace requested');
    try {
      if (!(await requireWorkspaceAccess(ctx, req, res, workspaceId as string))) return;
      await ctx.workspaceService.updateWorkspace(workspaceId as string, req.body);
      res.json({ status: 'updated' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to update workspace');
      res.status(500).json({ error: 'Failed to update workspace' });
    }
  });

  /* ── DELETE /:workspaceId ────────────────────────────────────────── */
  router.delete('/:workspaceId', async (req: Request, res: Response) => {
    const { workspaceId } = req.params;
    logger.info({ workspaceId }, 'Delete workspace requested');
    try {
      if (!(await requireWorkspaceAccess(ctx, req, res, workspaceId as string))) return;
      await ctx.workspaceService.deleteWorkspace(workspaceId as string);
      res.json({ status: 'deleted' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete workspace');
      res.status(500).json({ error: 'Failed to delete workspace' });
    }
  });

  /* ── POST /:workspaceId/ensure-path ──────────────────────────────── */
  router.post('/:workspaceId/ensure-path', async (req: Request, res: Response) => {
    const { workspaceId } = req.params;
    logger.info({ workspaceId }, 'Ensure workspace path requested');
    try {
      if (!(await requireWorkspaceAccess(ctx, req, res, workspaceId as string))) return;
      await ctx.workspaceService.ensureWorkspacePath(workspaceId as string);
      res.json({ status: 'ensured' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to ensure workspace path');
      res.status(500).json({ error: 'Failed to ensure workspace path' });
    }
  });

  return router;
}