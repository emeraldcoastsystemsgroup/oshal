/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — SSE streaming routes
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added dedicated /api/stream/debug SSE channel with real runtime summaries for the debug window
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log attribution for governance compliance during engineering-screen retrofit work
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '../composition-root';
import { randomUUID } from 'node:crypto';

const logger = createChildLogger({ module: 'stream-routes' });

/**
 * @description Creates Express router for SSE streaming endpoints.
 *
 * @param ctx - Application context with wired dependencies
 * @returns Express Router with streaming routes mounted
 */
export function createStreamRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/debug', handleDebugStream(ctx));
  router.get('/:taskId', handleStreamConnect(ctx));
  router.get('/', handleSessionStream(ctx));

  logger.info('Stream routes registered');
  return router;
}

/**
 * @description Handler: Connect a debug client to a runtime summary SSE feed.
 * This route intentionally emits plain `message` events because the current
 * debug hook listens via `EventSource.onmessage`.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleDebugStream(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const keepAlive = String(req.headers.accept || '').includes('text/event-stream');
    logger.info('GET /api/stream/debug — debug SSE connect');

    setupDebugSseHeaders(res);
    writeDebugEvent(res, 'connected', 'Debug stream connected.', {
      streamClients: ctx.streamManager.getStats().clientCount,
    });

    await emitDebugSummary(ctx, res);

    if (!keepAlive) {
      res.end();
      return;
    }

    const heartbeat = setInterval(() => {
      writeDebugEvent(res, 'heartbeat', 'Debug stream heartbeat.', {
        streamClients: ctx.streamManager.getStats().clientCount,
      });
    }, 30000);

    const summaryTimer = setInterval(() => {
      void emitDebugSummary(ctx, res);
    }, 5000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(summaryTimer);
      logger.info('Debug SSE connection closed');
    });
  };
}

/**
 * @description Handler: Connect an SSE client to a specific task's event stream.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleStreamConnect(ctx: AppContext) {
  return (req: Request, res: Response): void => {
    const taskId = req.params.taskId as string;
    const clientId = randomUUID();

    logger.info({ clientId, taskId }, 'GET /api/stream/:taskId — SSE connect');

    ctx.streamManager.registerClient(clientId, taskId, res);
  };
}

/**
 * @description Handler: Connect an SSE client for session-wide events.
 * Client receives events for all tasks it initiates.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleSessionStream(ctx: AppContext) {
  return (req: Request, res: Response): void => {
    const clientId = randomUUID();

    logger.info({ clientId }, 'GET /api/stream — session SSE connect');

    ctx.streamManager.registerClient(clientId, 'all', res);
  };
}

async function emitDebugSummary(ctx: AppContext, res: Response): Promise<void> {
  try {
    const tasks = await ctx.taskStore.list({ limit: 50 });
    const stats = ctx.streamManager.getStats();
    const active = tasks.filter((task) => task.status === 'active' || task.status === 'processing').length;
    const waiting = tasks.filter((task) => task.status === 'waiting_for_input').length;
    const failed = tasks.filter((task) => task.status === 'failed').length;
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const latestTask = tasks[0];

    const summary = [
      `${tasks.length} task(s) tracked`,
      `${active} active`,
      `${waiting} waiting`,
      `${completed} completed`,
      `${failed} failed`,
      `${stats.clientCount} SSE client(s)`,
      latestTask ? `latest=${latestTask.taskId}` : 'latest=none',
    ].join(', ');

    writeDebugEvent(res, 'summary', summary, {
      totalTasks: tasks.length,
      activeTasks: active,
      waitingTasks: waiting,
      completedTasks: completed,
      failedTasks: failed,
      streamClients: stats.clientCount,
      streamTaskIds: stats.taskIds,
      latestTaskId: latestTask?.taskId ?? null,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to emit debug SSE summary');
    writeDebugEvent(
      res,
      'error',
      error instanceof Error ? error.message : 'Failed to load debug summary.',
    );
  }
}

function setupDebugSseHeaders(res: Response): void {
  if (res.headersSent) {
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function writeDebugEvent(
  res: Response,
  event: string,
  data: string,
  extra: Record<string, unknown> = {},
): void {
  try {
    res.write(`data: ${JSON.stringify({
      event,
      data,
      timestamp: new Date().toISOString(),
      ...extra,
    })}\n\n`);
  } catch (error) {
    logger.warn({ err: error, event }, 'Failed to write debug SSE event');
  }
}
