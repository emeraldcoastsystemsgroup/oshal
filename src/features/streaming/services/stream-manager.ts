/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — ported from any-bot StreamController.js
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added task update broadcast helper for chat runtime status transitions
 */

import { createChildLogger } from '@/shared/logger';
import type { StreamEventType } from '@/shared/types';

const logger = createChildLogger({ module: 'stream-manager' });

/**
 * @description Internal SSE client state tracked by the stream manager.
 */
interface SSEClientState {
  taskId: string;
  response: SSEWritable;
  connectedAt: number;
  knownTaskIds: Set<string>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
}

/**
 * @description Writable interface for SSE responses.
 * Abstracts Express Response to allow testing and alternative transports.
 */
export interface SSEWritable {
  headersSent: boolean;
  writeHead(statusCode: number, headers: Record<string, string>): void;
  write(data: string): boolean;
  end(): void;
  on(event: string, callback: () => void): void;
}

/**
 * @description Manages real-time streaming connections (SSE).
 * Ported from any-bot's StreamController — handles SSE client registration,
 * heartbeat, task-scoped event broadcasting, and cleanup.
 *
 * @remarks
 * In any-bot, this also managed Socket.IO — we use SSE-only for now.
 * Socket.IO can be added later if needed. The key improvement from
 * any-bot Phase 27 (Issue #022) is preserved: session-based clients
 * only receive events for tasks they explicitly initiated.
 */
export class StreamManager {
  private sseClients: Map<string, SSEClientState>;
  private heartbeatIntervalMs: number;

  constructor(heartbeatIntervalMs = 30000) {
    this.sseClients = new Map();
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    logger.info({ heartbeatIntervalMs }, 'Stream manager initialized');
  }

  /**
   * @description Register an SSE client for a specific task or all tasks.
   *
   * @param clientId - Unique client identifier
   * @param taskId - Task to subscribe to, or 'all' for session-wide
   * @param res - Writable response object
   */
  registerClient(clientId: string, taskId: string, res: SSEWritable): void {
    this.setupSSEHeaders(res);
    this.sendEvent(res, 'connection', { clientId, taskId, message: 'Connected to streaming' });

    const heartbeatTimer = this.startHeartbeat(clientId, res);

    this.sseClients.set(clientId, {
      taskId,
      response: res,
      connectedAt: Date.now(),
      knownTaskIds: new Set(),
      heartbeatTimer,
    });

    this.setupCleanup(clientId, res);
    logger.info({ clientId, taskId }, 'SSE client registered');
  }

  /**
   * @description Set SSE response headers if not already sent.
   *
   * @param res - Writable response object
   */
  private setupSSEHeaders(res: SSEWritable): void {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }
  }

  /**
   * @description Start a heartbeat interval for an SSE client.
   *
   * @param clientId - Client identifier
   * @param res - Writable response object
   * @returns Interval timer handle
   */
  private startHeartbeat(clientId: string, res: SSEWritable): ReturnType<typeof setInterval> {
    return setInterval(() => {
      if (!this.sseClients.has(clientId)) return;
      this.sendEvent(res, 'heartbeat', { timestamp: Date.now() });
    }, this.heartbeatIntervalMs);
  }

  /**
   * @description Setup cleanup handler for client disconnection.
   *
   * @param clientId - Client identifier
   * @param res - Writable response object
   */
  private setupCleanup(clientId: string, res: SSEWritable): void {
    res.on('close', () => {
      this.unregisterClient(clientId);
    });
  }

  /**
   * @description Unregister an SSE client and clean up resources.
   *
   * @param clientId - Client identifier
   */
  unregisterClient(clientId: string): void {
    const client = this.sseClients.get(clientId);
    if (!client) return;

    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
    }

    try {
      client.response.end();
    } catch (err) {
      logger.warn({ err, clientId }, 'Error closing SSE client');
    }

    this.sseClients.delete(clientId);
    logger.info({ clientId }, 'SSE client unregistered');
  }

  /**
   * @description Associate a task ID with session-wide SSE clients.
   * After association, events for that task will reach session clients.
   * (Ported from any-bot Issue #022 fix for cross-bot SSE noise.)
   *
   * @param taskId - Task to associate
   */
  associateTaskWithSession(taskId: string): void {
    this.sseClients.forEach((client, clientId) => {
      if (client.taskId === 'all' || !client.taskId) {
        client.knownTaskIds.add(taskId);
        logger.debug({ clientId, taskId }, 'Task associated with session client');
      }
    });
  }

  /**
   * @description Broadcast an event to all clients subscribed to a task.
   * Session clients ('all') only receive events for known tasks.
   *
   * @param taskId - Target task
   * @param eventType - Event type name
   * @param data - Event payload
   */
  broadcast(taskId: string, eventType: StreamEventType, data: Record<string, unknown>): void {
    this.sseClients.forEach((client) => {
      if (this.shouldReceiveEvent(client, taskId)) {
        this.sendEvent(client.response, eventType, { ...data, taskId });
      }
    });
    logger.debug({ taskId, eventType }, 'Event broadcast');
  }

  /**
   * @description Check if a client should receive an event for a task.
   *
   * @param client - SSE client state
   * @param taskId - Target task
   * @returns True if the client should receive the event
   */
  private shouldReceiveEvent(client: SSEClientState, taskId: string): boolean {
    if (client.taskId === taskId) return true;
    if (client.taskId === 'all' || !client.taskId) {
      return client.knownTaskIds.has(taskId);
    }
    return false;
  }

  /**
   * @description Convenience: broadcast a new message event.
   *
   * @param taskId - Task identifier
   * @param message - Message payload
   */
  broadcastMessage(taskId: string, message: Record<string, unknown>): void {
    this.broadcast(taskId, 'message', { message, timestamp: Date.now() });
  }

  /**
   * @description Convenience: broadcast a streaming chunk.
   *
   * @param taskId - Task identifier
   * @param chunk - Text chunk
   * @param messageId - Optional associated message ID
   */
  broadcastStreamChunk(taskId: string, chunk: string, messageId?: string): void {
    this.broadcast(taskId, 'stream_chunk', { chunk, messageId: messageId ?? null, timestamp: Date.now() });
  }

  /**
   * @description Convenience: broadcast a task status/update payload.
   *
   * @param taskId - Task identifier
   * @param task - Task update payload
   */
  broadcastTaskUpdate(taskId: string, task: Record<string, unknown>): void {
    this.broadcast(taskId, 'task_update', { task, timestamp: Date.now() });
  }

  /**
   * @description Convenience: broadcast a tool execution status.
   *
   * @param taskId - Task identifier
   * @param tool - Tool info
   * @param status - Execution status
   */
  broadcastToolExecution(taskId: string, tool: Record<string, unknown>, status: string): void {
    this.broadcast(taskId, 'tool_execution', { tool, status, timestamp: Date.now() });
  }

  /**
   * @description Convenience: broadcast task completion.
   *
   * @param taskId - Task identifier
   * @param result - Completion result
   */
  broadcastCompletion(taskId: string, result: Record<string, unknown>): void {
    this.broadcast(taskId, 'completion', { result, timestamp: Date.now() });
  }

  /**
   * @description Convenience: broadcast an error.
   *
   * @param taskId - Task identifier
   * @param error - Error message
   */
  broadcastError(taskId: string, error: string): void {
    this.broadcast(taskId, 'error', { error, timestamp: Date.now() });
  }

  /**
   * @description Send a single SSE event to a writable.
   *
   * @param res - Writable response
   * @param eventName - Event type name
   * @param data - Event payload
   */
  private sendEvent(res: SSEWritable, eventName: string, data: Record<string, unknown>): void {
    try {
      res.write(`event: streaming-event\n`);
      res.write(`data: ${JSON.stringify({ type: eventName, ...data })}\n\n`);
    } catch (err) {
      logger.error({ err, eventName }, 'Failed to send SSE event');
    }
  }

  /**
   * @description Get connection statistics.
   *
   * @returns Stats object with client count and task count
   */
  getStats(): { clientCount: number; taskIds: string[] } {
    const taskIds = new Set<string>();
    this.sseClients.forEach((client) => {
      if (client.taskId && client.taskId !== 'all') {
        taskIds.add(client.taskId);
      }
    });
    return { clientCount: this.sseClients.size, taskIds: Array.from(taskIds) };
  }

  /**
   * @description Close all connections for a specific task.
   *
   * @param taskId - Task to disconnect
   */
  closeTaskConnections(taskId: string): void {
    const toRemove: string[] = [];
    this.sseClients.forEach((client, clientId) => {
      if (client.taskId === taskId) {
        toRemove.push(clientId);
      }
    });
    toRemove.forEach((id) => this.unregisterClient(id));
    logger.info({ taskId, closedCount: toRemove.length }, 'Closed task connections');
  }
}
