/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial workspace REST API: CRUD and path resolution
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Refactored to createWorkspaceRoutes(ctx) pattern matching codebase conventions
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Enforced per-user workspace isolation (IDOR fix). Create stamps owner_sub from the OIDC session; get/update/delete/ensure-path enforce owner-or-operator and 404 on mismatch (so ids are not oracle-able); list is scoped to the caller for non-operators. Previously any authenticated user could read, modify, or DELETE (incl. the on-disk directory) any tenant's workspace by guessing its id.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Made HTTP owner/path fields server-controlled and immutable, omitted absolute paths from responses, and retained exact owner-or-operator checks across every workspace operation.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { InternalWorkspace } from '@/entities/workspace';
import { CreateInternalWorkspaceSchema } from '@/entities/workspace';
import { createChildLogger } from '@/shared/logger';
import { getCaller, isOperator } from '@/shared/middleware/authz';
import type { AppContext } from '../composition-root';

const logger = createChildLogger({ module: 'workspace-routes' });
const CreatePublicWorkspaceSchema = CreateInternalWorkspaceSchema
  .omit({ path: true, ownerSub: true })
  .strict();
const UpdatePublicWorkspaceSchema = z.object({
  name: z.string().min(1).optional(),
  projectName: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

/**
 * @description Creates the authenticated workspace REST router while keeping filesystem
 * identity fields out of the public input and output contracts.
 * @param ctx - Application context with the workspace service.
 * @returns Configured workspace router.
 */
export function createWorkspaceRoutes(ctx: AppContext): Router {
  const router = Router();
  router.post('/', createWorkspaceHandler(ctx));
  router.get('/', createListHandler(ctx));
  router.get('/:workspaceId', createGetHandler(ctx));
  router.patch('/:workspaceId', createUpdateHandler(ctx));
  router.delete('/:workspaceId', createDeleteHandler(ctx));
  router.post('/:workspaceId/ensure-path', createEnsurePathHandler(ctx));
  return router;
}

function createWorkspaceHandler(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    logger.info('Create workspace requested');
    const parsed = CreatePublicWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
      return;
    }
    const sub = requireCallerSub(req, res);
    if (!sub) return;

    try {
      const workspace = await ctx.workspaceService.createWorkspace({ ...parsed.data, ownerSub: sub });
      logger.info({ workspaceId: workspace.workspaceId, durationMs: Date.now() - startedAt }, 'Workspace created');
      res.status(201).json(toPublicWorkspace(workspace));
    } catch (error) {
      respondWorkspaceError(res, error, 'Failed to create workspace');
    }
  };
}

function createListHandler(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    logger.debug('List workspaces requested');
    const sub = requireCallerSub(req, res);
    if (!sub) return;
    try {
      const options = readListOptions(req, sub, isOperator(req));
      const workspaces = await ctx.workspaceService.listWorkspaces(options);
      const visible = workspaces.filter((workspace) => canReadWorkspace(req, workspace));
      res.json({ workspaces: visible.map(toPublicWorkspace), count: visible.length });
    } catch (error) {
      respondWorkspaceError(res, error, 'Failed to list workspaces');
    }
  };
}

function createGetHandler(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const workspaceId = readParam(req.params.workspaceId);
    logger.debug({ workspaceId }, 'Get workspace requested');
    try {
      const workspace = await requireWorkspaceAccess(ctx, req, res, workspaceId);
      if (workspace) res.json(toPublicWorkspace(workspace));
    } catch (error) {
      respondWorkspaceError(res, error, 'Failed to get workspace');
    }
  };
}

function createUpdateHandler(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const workspaceId = readParam(req.params.workspaceId);
    logger.info({ workspaceId }, 'Update workspace requested');
    const parsed = UpdatePublicWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
      return;
    }
    try {
      if (!(await requireWorkspaceAccess(ctx, req, res, workspaceId))) return;
      await ctx.workspaceService.updateWorkspace(workspaceId, parsed.data);
      res.json({ status: 'updated' });
    } catch (error) {
      respondWorkspaceError(res, error, 'Failed to update workspace');
    }
  };
}

function createDeleteHandler(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const workspaceId = readParam(req.params.workspaceId);
    logger.info({ workspaceId }, 'Delete workspace requested');
    try {
      if (!(await requireWorkspaceAccess(ctx, req, res, workspaceId))) return;
      await ctx.workspaceService.deleteWorkspace(workspaceId);
      res.json({ status: 'deleted' });
    } catch (error) {
      respondWorkspaceError(res, error, 'Failed to delete workspace');
    }
  };
}

function createEnsurePathHandler(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const workspaceId = readParam(req.params.workspaceId);
    logger.info({ workspaceId }, 'Ensure workspace path requested');
    try {
      if (!(await requireWorkspaceAccess(ctx, req, res, workspaceId))) return;
      await ctx.workspaceService.ensureWorkspacePath(workspaceId);
      res.json({ status: 'ensured' });
    } catch (error) {
      respondWorkspaceError(res, error, 'Failed to ensure workspace path');
    }
  };
}

async function requireWorkspaceAccess(
  ctx: AppContext,
  req: Request,
  res: Response,
  workspaceId: string,
): Promise<InternalWorkspace | null> {
  const workspace = await ctx.workspaceService.getWorkspace(workspaceId);
  if (!workspace || !canReadWorkspace(req, workspace)) {
    logger.warn({ workspaceId }, 'Workspace unavailable to caller');
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }
  return workspace;
}

function canReadWorkspace(req: Request, workspace: InternalWorkspace): boolean {
  const { sub } = getCaller(req);
  return isOperator(req) || (Boolean(sub) && workspace.ownerSub === sub);
}

function requireCallerSub(req: Request, res: Response): string | null {
  const { sub } = getCaller(req);
  if (sub && sub.trim().length > 0 && !sub.includes('\0')) return sub;
  res.status(401).json({ error: 'Authentication required' });
  return null;
}

function readListOptions(req: Request, sub: string, operator: boolean) {
  const options: { projectName?: string; ownerSub?: string; limit?: number; offset?: number } = {};
  if (typeof req.query.projectName === 'string') options.projectName = req.query.projectName;
  const limit = readBoundedInteger(req.query.limit, 200, 1);
  const offset = readBoundedInteger(req.query.offset, 100_000, 0);
  options.limit = limit ?? 100;
  if (offset !== undefined) options.offset = offset;
  if (!operator) options.ownerSub = sub;
  return options;
}

function readBoundedInteger(value: unknown, maximum: number, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error('Invalid pagination');
  return Math.min(parsed, maximum);
}

function toPublicWorkspace(workspace: InternalWorkspace) {
  return {
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    projectName: workspace.projectName,
    ownerSub: workspace.ownerSub,
    metadata: workspace.metadata,
    createdAt: workspace.createdAt,
  };
}

function respondWorkspaceError(res: Response, error: unknown, fallback: string): void {
  logger.error({ err: error }, fallback);
  const message = error instanceof Error ? error.message : '';
  if (message.includes('already in use') || message.includes('conflicted')) {
    res.status(409).json({ error: 'Workspace conflict' });
    return;
  }
  if (isWorkspaceInputError(message)) {
    res.status(400).json({ error: 'Invalid workspace configuration' });
    return;
  }
  res.status(500).json({ error: fallback });
}

function isWorkspaceInputError(message: string): boolean {
  return ['invalid', 'immutable', 'below the shared', 'contains a link', 'escapes the shared']
    .some((fragment) => message.toLowerCase().includes(fragment.toLowerCase()));
}

function readParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}
