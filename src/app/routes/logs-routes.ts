/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — GET /api/logs returns static debug log entries (placeholder)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Replaced placeholder log response with task/message-derived operational debug feed
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log attribution for governance compliance during engineering-screen retrofit work
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { StoredMessage, StoredTask } from '@/shared/types';
import type { AppContext } from '../composition-root';

const logger = createChildLogger({ module: 'logs-routes' });

interface DebugLogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source: 'task-store' | 'message-store' | 'system';
  taskId?: string;
  agentId?: string;
  type?: string;
}

/**
 * @description Creates the /api/logs route for the debug window feed.
 * The response remains an array for compatibility with the existing UI hook.
 *
 * @param ctx - Application context with task/message persistence
 * @returns Express Router with / (GET) handler
 */
export function createLogsRoutes(ctx: AppContext): Router {
  const router = Router();

  /**
   * @openapi
   * /api/logs:
   *   get:
   *     summary: Get recent operational debug log entries derived from persisted tasks and messages
   *     tags:
   *       - Logs
   *     responses:
   *       200:
   *         description: Array of log entries
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   timestamp:
   *                     type: string
   *                   level:
   *                     type: string
   *                   message:
   *                     type: string
   */
  router.get('/', async (req: Request, res: Response) => {
    const limit = readBoundedLimit(req.query.limit, 50, 1, 200);
    const taskId = readOptionalString(req.query.taskId);
    const includeMessages = readBoolean(req.query.includeMessages, true);

    logger.info({ limit, taskId, includeMessages }, 'GET /api/logs');

    try {
      const entries = await buildDebugLogFeed(ctx, {
        limit,
        taskId,
        includeMessages,
      });

      res.json(entries);
    } catch (error) {
      logger.error({ err: error, limit, taskId }, 'Failed to build debug log feed');
      res.json([
        {
          timestamp: new Date().toISOString(),
          level: 'error',
          message: error instanceof Error ? error.message : 'Failed to build debug log feed.',
          source: 'system',
          type: 'log-feed-error',
        } satisfies DebugLogEntry,
      ]);
    }
  });

  return router;
}

interface DebugLogFeedOptions {
  limit: number;
  taskId?: string;
  includeMessages: boolean;
}

async function buildDebugLogFeed(ctx: AppContext, options: DebugLogFeedOptions): Promise<DebugLogEntry[]> {
  const tasks = await loadRelevantTasks(ctx, options);
  const messageEntries = options.includeMessages
    ? await loadRecentMessageEntries(ctx, tasks, options.limit)
    : [];
  const taskEntries = tasks.map(toTaskLogEntry);
  const summaryEntry = buildSummaryEntry(tasks, messageEntries.length);

  return [summaryEntry, ...taskEntries, ...messageEntries]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, options.limit);
}

async function loadRelevantTasks(ctx: AppContext, options: DebugLogFeedOptions): Promise<StoredTask[]> {
  if (options.taskId) {
    const task = await ctx.taskStore.get(options.taskId);
    return task ? [task] : [];
  }

  const tasks = await ctx.taskStore.list({ limit: Math.min(Math.max(options.limit, 20), 100) });
  return [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function loadRecentMessageEntries(
  ctx: AppContext,
  tasks: StoredTask[],
  limit: number,
): Promise<DebugLogEntry[]> {
  const tasksToInspect = tasks.slice(0, Math.min(tasks.length, 25));
  const messagesPerTask = Math.max(1, Math.min(3, Math.ceil(limit / Math.max(tasksToInspect.length, 1))));

  const taskMessages = await Promise.all(
    tasksToInspect.map(async (task) => ({
      task,
      messages: await ctx.messageStore.getRecent(task.taskId, messagesPerTask),
    })),
  );

  return taskMessages.flatMap(({ task, messages }) =>
    messages.map((message) => toMessageLogEntry(task, message)),
  );
}

function buildSummaryEntry(tasks: StoredTask[], messageCount: number): DebugLogEntry {
  const activeCount = tasks.filter((task) => ['active', 'processing', 'waiting_for_input'].includes(task.status)).length;
  const failedCount = tasks.filter((task) => task.status === 'failed').length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const latestTimestamp = tasks[0]?.updatedAt || new Date().toISOString();

  return {
    timestamp: latestTimestamp,
    level: failedCount > 0 ? 'warn' : 'info',
    message: `Loaded ${tasks.length} task(s): ${activeCount} active, ${completedCount} completed, ${failedCount} failed, ${messageCount} recent message(s).`,
    source: 'system',
    type: 'log-feed-summary',
  };
}

function toTaskLogEntry(task: StoredTask): DebugLogEntry {
  const title = task.title.trim().length > 0 ? task.title.trim() : 'Untitled task';
  const suffixParts = [
    task.agentId ? `agent=${task.agentId}` : '',
    task.providerId ? `provider=${task.providerId}` : '',
    task.totalRequests > 0 ? `requests=${task.totalRequests}` : '',
    task.totalCost > 0 ? `cost=${task.totalCost.toFixed(6)} ${task.costCurrency}` : '',
  ].filter((value) => value.length > 0);

  return {
    timestamp: task.updatedAt,
    level: mapTaskStatusToLevel(task.status),
    message: `Task ${task.taskId} "${truncate(title, 80)}" is ${task.status}${suffixParts.length > 0 ? ` (${suffixParts.join(', ')})` : ''}.`,
    source: 'task-store',
    taskId: task.taskId,
    agentId: task.agentId,
    type: 'task-status',
  };
}

function toMessageLogEntry(task: StoredTask, message: StoredMessage): DebugLogEntry {
  const preview = truncate(normalizeWhitespace(message.text), 120);
  const roleLabel = message.role === 'assistant' ? 'Assistant' : 'User';

  return {
    timestamp: message.createdAt,
    level: mapMessageTypeToLevel(message.type),
    message: `${roleLabel} ${message.type} on ${task.taskId}: ${preview || '[empty message]'}`,
    source: 'message-store',
    taskId: task.taskId,
    agentId: task.agentId,
    type: message.type,
  };
}

function mapTaskStatusToLevel(status: StoredTask['status']): DebugLogEntry['level'] {
  switch (status) {
    case 'failed':
      return 'error';
    case 'waiting_for_input':
      return 'warn';
    case 'completed':
      return 'info';
    case 'active':
    case 'processing':
      return 'debug';
    default:
      return 'info';
  }
}

function mapMessageTypeToLevel(type: StoredMessage['type']): DebugLogEntry['level'] {
  switch (type) {
    case 'error':
      return 'error';
    case 'ask':
    case 'completion':
      return 'warn';
    case 'tool_use':
    case 'tool_result':
    case 'checkpoint':
      return 'debug';
    default:
      return 'info';
  }
}

function readBoundedLimit(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return fallback;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}
