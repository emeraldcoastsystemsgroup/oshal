/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — task CRUD routes
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added agentId task-list filter support for bot-scoped conversation history queries
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added task-scoped checkpoint create/list routes for non-swarm memory layers
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added task telemetry upsert endpoint so localhost cockpit validation can persist per-agent usage without direct database access
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { TaskUsageSummarySchema, type StoredTask, type TaskUsageSummary } from '@/shared/types';
import { canAccessResource, getCaller, isOperator } from '@/shared/middleware/authz';
import type { AppContext } from '../composition-root';

const logger = createChildLogger({ module: 'task-routes' });

/**
 * @description Creates Express router for task management endpoints.
 *
 * @param ctx - Application context with wired dependencies
 * @returns Express Router with task routes mounted
 */
export function createTaskRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/', handleCreateTask(ctx));
  router.get('/', handleListTasks(ctx));
  router.post('/:taskId/usage', handleRecordTaskUsage(ctx));
  router.post('/:taskId/checkpoints', handleCreateCheckpoint(ctx));
  router.get('/:taskId/checkpoints', handleListCheckpoints(ctx));
  router.get('/:taskId/workspace/status', handleGetWorkspaceStatus(ctx));
  router.post('/:taskId/workspace/bootstrap', handleBootstrapWorkspace(ctx));
  router.get('/:taskId', handleGetTask(ctx));
  router.delete('/:taskId', handleDeleteTask(ctx));

  logger.info('Task routes registered');
  return router;
}

/**
 * @description Handler: Create a new task.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleCreateTask(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const startTime = Date.now();
    logger.info({ bodyKeys: Object.keys(req.body || {}) }, 'POST /api/tasks');

    try {
      const task = await ctx.taskStore.create({
        title: req.body.title ?? '',
        processingMode: req.body.processingMode ?? 'agentic',
        agentId: req.body.agentId,
        providerId: req.body.providerId,
        ownerSub: getCaller(req).sub ?? undefined,
        metadata: req.body.metadata ?? {},
      });

      logger.info({ taskId: task.taskId, durationMs: Date.now() - startTime }, 'Task created');
      res.status(201).json(task);
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startTime }, 'Failed to create task');
      res.status(500).json({ error: 'Failed to create task' });
    }
  };
}

/**
 * @description Handler: List tasks with optional filters.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleListTasks(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const startTime = Date.now();
    logger.info({ query: req.query }, 'GET /api/tasks');

    try {
      const status = req.query.status as string | undefined;
      const agentId = req.query.agentId as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const ownerSub = resolveTaskListOwnerSub(req);
      const tasks = await ctx.taskStore.list({
        status: status as any,
        agentId: typeof agentId === 'string' && agentId.trim().length > 0 ? agentId.trim() : undefined,
        ownerSub,
        limit,
      });

      logger.info({ count: tasks.length, durationMs: Date.now() - startTime }, 'Tasks listed');
      res.json({ tasks, count: tasks.length });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startTime }, 'Failed to list tasks');
      res.status(500).json({ error: 'Failed to list tasks' });
    }
  };
}

/**
 * @description Handler: Get a single task by ID.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleGetTask(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const taskId = req.params.taskId as string;
    logger.info({ taskId }, 'GET /api/tasks/:taskId');

    try {
      const task = await ctx.taskStore.get(taskId);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      if (!canAccessTask(req, task)) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      res.json(task);
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to get task');
      res.status(500).json({ error: 'Failed to get task' });
    }
  };
}

/**
 * @description Handler: Record or backfill task telemetry for one task.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleRecordTaskUsage(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const taskId = req.params.taskId as string;
    logger.info({ taskId }, 'POST /api/tasks/:taskId/usage');

    try {
      const existing = await ctx.taskStore.get(taskId);
      if (!existing) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      if (!canAccessTask(req, existing)) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const mutation = buildTaskUsageMutation(req.body);
      if (!mutation) {
        res.status(400).json({ error: 'Invalid usage payload' });
        return;
      }

      await ctx.taskStore.recordUsage(taskId, mutation.usageSummary);
      const updatedTask = await applyTaskTelemetryIdentity(ctx, existing, taskId, mutation.agentId, mutation.providerId);
      res.json({ success: true, task: updatedTask });
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to record task telemetry');
      res.status(500).json({ error: 'Failed to record task telemetry' });
    }
  };
}

/**
 * @description Handler: Create a checkpoint snapshot for one task.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleCreateCheckpoint(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const taskId = req.params.taskId as string;
    logger.info({ taskId }, 'POST /api/tasks/:taskId/checkpoints');

    try {
      const task = await ctx.taskStore.get(taskId);
      if (!task || !canAccessTask(req, task)) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      const checkpoint = await ctx.memoryService.createCheckpoint(taskId, {
        label: typeof req.body?.label === 'string' ? req.body.label : undefined,
        summary: typeof req.body?.summary === 'string' ? req.body.summary : undefined,
        trigger: 'manual',
        metadata: req.body?.metadata ?? {},
      });
      res.status(201).json({ checkpoint });
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to create checkpoint');
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create checkpoint' });
    }
  };
}

/**
 * @description Handler: List checkpoints for one task.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleListCheckpoints(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const taskId = req.params.taskId as string;
    logger.info({ taskId }, 'GET /api/tasks/:taskId/checkpoints');

    try {
      const task = await ctx.taskStore.get(taskId);
      if (!task || !canAccessTask(req, task)) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      const checkpoints = await ctx.memoryService.listCheckpoints(taskId);
      res.json({ checkpoints, count: checkpoints.length });
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to list checkpoints');
      res.status(500).json({ error: 'Failed to list checkpoints' });
    }
  };
}

/**
 * @description Handler: Delete a task and its messages.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleDeleteTask(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const taskId = req.params.taskId as string;
    logger.info({ taskId }, 'DELETE /api/tasks/:taskId');

    try {
      const task = await ctx.taskStore.get(taskId);
      if (!task || !canAccessTask(req, task)) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      await ctx.messageStore.deleteByTask(taskId);
      await ctx.taskStore.delete(taskId);
      logger.info({ taskId }, 'Task and messages deleted');
      res.status(204).end();
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to delete task');
      res.status(500).json({ error: 'Failed to delete task' });
    }
  };
}

/**
 * @description Handler: Get workspace bootstrap/git status for one task.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleGetWorkspaceStatus(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const taskId = req.params.taskId as string;
    logger.info({ taskId }, 'GET /api/tasks/:taskId/workspace/status');

    try {
      const task = await ctx.taskStore.get(taskId);
      if (!task || !canAccessTask(req, task)) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      const status = await ctx.workspaceBootstrapService.getTaskWorkspaceStatus(taskId);
      res.json({ success: true, taskId, status });
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to get workspace status');
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get workspace status' });
    }
  };
}

/**
 * @description Handler: Bootstrap a task workspace into a git-backed project directory.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleBootstrapWorkspace(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const taskId = req.params.taskId as string;
    logger.info({ taskId, bodyKeys: Object.keys(req.body || {}) }, 'POST /api/tasks/:taskId/workspace/bootstrap');

    try {
      const task = await ctx.taskStore.get(taskId);
      if (!task || !canAccessTask(req, task)) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const repoUrl = typeof req.body?.repoUrl === 'string' && req.body.repoUrl.trim().length > 0
        ? req.body.repoUrl.trim()
        : typeof req.body?.projectUrl === 'string' && req.body.projectUrl.trim().length > 0
          ? req.body.projectUrl.trim()
          : undefined;
      const provider = typeof req.body?.provider === 'string' && req.body.provider.trim().length > 0
        ? req.body.provider.trim()
        : inferRepoProvider(repoUrl);
      const remoteName = typeof req.body?.remoteName === 'string' && req.body.remoteName.trim().length > 0
        ? req.body.remoteName.trim()
        : 'origin';
      const branch = typeof req.body?.branch === 'string' && req.body.branch.trim().length > 0
        ? req.body.branch.trim()
        : 'main';

      const status = await ctx.workspaceBootstrapService.bootstrapTaskWorkspace({
        taskId,
        title: task.title,
        provider: provider as 'gitlab' | 'github' | 'generic',
        repoUrl,
        remoteName,
        branch,
      });

      const nextTask = await ctx.taskStore.replace({
        ...task,
        metadata: {
          ...(task.metadata || {}),
          workspacePath: status.workspacePath,
          git: {
            provider,
            repoUrl: repoUrl || '',
            remoteName,
            branch: status.branch || branch,
            remotes: status.remotes,
          },
        },
      });

      res.json({ success: true, taskId, status, task: nextTask });
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to bootstrap workspace');
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to bootstrap workspace' });
    }
  };
}

function resolveTaskListOwnerSub(req: Request): string | undefined {
  if (req.query.scope === 'all' && isOperator(req)) {
    return undefined;
  }
  return getCaller(req).sub ?? '__missing-caller__';
}

function canAccessTask(req: Request, task: StoredTask): boolean {
  return canAccessResource(req, task.ownerSub ?? null);
}

function inferRepoProvider(repoUrl?: string): string {
  if (!repoUrl) {
    return 'generic';
  }
  const normalized = repoUrl.toLowerCase();
  if (normalized.includes('gitlab')) {
    return 'gitlab';
  }
  if (normalized.includes('github')) {
    return 'github';
  }
  return 'generic';
}

function buildTaskUsageMutation(body: unknown): { agentId?: string; providerId?: string; usageSummary: TaskUsageSummary } | null {
  const record = readRecord(body);
  const rawSummary = readRecord(record.usageSummary && typeof record.usageSummary === 'object' ? record.usageSummary : record);
  const usageSummary = TaskUsageSummarySchema.safeParse({
    inputTokens: rawSummary.inputTokens,
    outputTokens: rawSummary.outputTokens,
    totalTokens: readNumericValue(rawSummary.totalTokens) || (readNumericValue(rawSummary.inputTokens) + readNumericValue(rawSummary.outputTokens)),
    inputCost: rawSummary.inputCost,
    outputCost: rawSummary.outputCost,
    totalCost: rawSummary.totalCost,
    currency: rawSummary.currency,
    requestCount: rawSummary.requestCount,
    byModel: buildUsageByModelPayload(rawSummary),
  });

  if (!usageSummary.success) {
    return null;
  }

  return {
    agentId: readOptionalString(record.agentId),
    providerId: readOptionalString(record.providerId),
    usageSummary: usageSummary.data,
  };
}

async function applyTaskTelemetryIdentity(
  ctx: AppContext,
  previousTask: StoredTask,
  taskId: string,
  agentId?: string,
  providerId?: string,
): Promise<StoredTask | null> {
  const refreshed = await ctx.taskStore.get(taskId);
  if (!refreshed) {
    return null;
  }

  if (!agentId && !providerId) {
    return refreshed;
  }

  return ctx.taskStore.replace({
    ...refreshed,
    agentId: agentId || refreshed.agentId || previousTask.agentId,
    providerId: providerId || refreshed.providerId || previousTask.providerId,
  });
}

function buildUsageByModelPayload(rawSummary: Record<string, unknown>): Record<string, unknown> {
  const byModel = readRecord(rawSummary.byModel || rawSummary.usageByModel);
  if (Object.keys(byModel).length > 0) {
    return byModel;
  }

  const modelId = readOptionalString(rawSummary.modelId);
  if (!modelId) {
    return {};
  }

  const inputTokens = readNumericValue(rawSummary.inputTokens);
  const outputTokens = readNumericValue(rawSummary.outputTokens);
  return {
    [modelId]: {
      inputTokens,
      outputTokens,
      totalTokens: readNumericValue(rawSummary.totalTokens) || (inputTokens + outputTokens),
      inputCost: readNumericValue(rawSummary.inputCost),
      outputCost: readNumericValue(rawSummary.outputCost),
      totalCost: readNumericValue(rawSummary.totalCost),
      requestCount: readNumericValue(rawSummary.requestCount),
    },
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumericValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
