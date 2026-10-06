/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — ported from any-bot StreamController.js
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added task update broadcast helper for chat runtime status transitions
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Revalidate scoped SSE events in order with bounded queues and stop protected delivery when current access is revoked.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Defer protected inline output until durable completion, isolating concurrent scopes and current-authorized pending approval controls.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Observe public stream operations and every caught delivery fault with sanitized identifiers, duration and scrubbed stack frames.
 */

import { createChildLogger, observeOperation, observeAsyncOperation, logOperationError } from '@/shared/logger';
import type { StreamEventType } from '@/shared/types';
import { AsyncLocalStorage } from 'node:async_hooks';

const logger = createChildLogger({ module: 'stream-manager' });

function isApprovalControlEvent(type: StreamEventType): boolean {
  return type === 'tool:approval:request' || type === 'tool:approval:response' || type === 'tool:approval:timeout';
}

/**
 * @description Internal SSE client state tracked by the stream manager.
 */
interface SSEClientState {
  taskId: string;
  response: SSEWritable;
  connectedAt: number;
  knownTaskIds: Set<string>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  authorize?: (taskId: string, eventType?: StreamEventType) => Promise<boolean>;
  delivery: Promise<void>;
  pendingEvents: number;
}

/** @description Per-turn unpublished output; a sticky refusal prevents a caught overflow from later publishing a partial answer. */
interface DeferredTaskEvents {
  taskId: string;
  events: Array<{ type: StreamEventType; data: Record<string, unknown> }>;
  bytes: number;
  closed: boolean;
  refusal?: Error;
  parent?: DeferredTaskEvents;
}

/** @description Refuse a protected turn whose unpublished event buffer cannot remain bounded. */
export class DeferredTaskStreamError extends Error {
  readonly code = 'deferred_task_stream_unavailable';
  /** @description Keep the refusal free of task output or account details.
   * @returns The bounded public stream refusal.
   */
  constructor() { super('deferred_task_stream_unavailable'); this.name = 'DeferredTaskStreamError'; }
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
  private readonly deferredTaskEvents = new AsyncLocalStorage<DeferredTaskEvents>();

  /**
   * @description Set the heartbeat interval; event buffering remains local to each asynchronous turn.
   * @param heartbeatIntervalMs Existing heartbeat interval in milliseconds.
   * @returns An empty stream manager.
   */
  constructor(heartbeatIntervalMs = 30000) {
    const startedAt = Date.now();
    logger.info({ operation: 'constructor', event: 'entry' }, 'Operation started');
    this.sseClients = new Map();
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    logger.info({ operation: 'constructor', event: 'exit', durationMs: Date.now() - startedAt, outcome: 'completed' }, 'Operation finished');
  }

  /**
   * @description Publish protected inline events only after the trusted caller completes its entire durable authorization boundary.
   * @param taskId Exact controller task to defer; unrelated tasks continue through their normal subscribers.
   * @param execute Work including result completion, persistence and final access verification.
   * @returns The outcome after ordered replay through unchanged per-client authorization; rejection discards all unpublished events.
   */
  async withDeferredTaskEvents<T>(taskId: string, execute: () => Promise<T>): Promise<T> {
    return observeAsyncOperation(logger, 'withDeferredTaskEvents', { taskId }, async () => {
      const buffer: DeferredTaskEvents = { taskId, events: [], bytes: 0, closed: false, parent: this.deferredTaskEvents.getStore() };
      try {
        const result = await this.deferredTaskEvents.run(buffer, execute);
        if (buffer.refusal) throw buffer.refusal;
        buffer.closed = true;
        for (const event of buffer.events) this.broadcast(taskId, event.type, event.data);
        return result;
      } finally {
        buffer.closed = true;
        buffer.events.length = 0;
      }
    });
  }

  /**
   * @description Register an SSE client for a specific task or all tasks.
   *
   * @param clientId - Unique client identifier
   * @param taskId - Task to subscribe to, or 'all' for session-wide
   * @param res - Writable response object
   * @param authorize - Optional trusted current-access check used for every task event.
   * @returns No value; existing stream delivery and cleanup behavior is retained.
   */
  registerClient(clientId: string, taskId: string, res: SSEWritable, authorize?: (taskId: string, eventType?: StreamEventType) => Promise<boolean>): void {
    return observeOperation(logger, 'registerClient', { clientId, taskId }, () => {
      this.setupSSEHeaders(res);
      this.sendEvent(res, 'connection', { clientId, taskId, message: 'Connected to streaming' });

      const heartbeatTimer = this.startHeartbeat(clientId, res);

      this.sseClients.set(clientId, {
        taskId,
        response: res,
        connectedAt: Date.now(),
        knownTaskIds: new Set(),
        heartbeatTimer,
        authorize,
        delivery: Promise.resolve(),
        pendingEvents: 0,
      });

      this.setupCleanup(clientId, res);
    });
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
   * @returns No value; existing stream delivery and cleanup behavior is retained.
   */
  unregisterClient(clientId: string): void {
    return observeOperation(logger, 'unregisterClient', { clientId }, () => {
      const startedAt = Date.now();
      const client = this.sseClients.get(clientId);
      if (!client) return;

      if (client.heartbeatTimer) {
        clearInterval(client.heartbeatTimer);
      }

      try {
        client.response.end();
      } catch (err) {
        logOperationError(logger, 'unregisterClient', { clientId }, err, startedAt);
      }

      this.sseClients.delete(clientId);
    });
  }

  /**
   * @description Associate a task ID with session-wide SSE clients.
   * After association, events for that task will reach session clients.
   * (Ported from any-bot Issue #022 fix for cross-bot SSE noise.)
   *
   * @param taskId - Task to associate
   * @returns No value; existing stream delivery and cleanup behavior is retained.
   */
  associateTaskWithSession(taskId: string): void {
    return observeOperation(logger, 'associateTaskWithSession', { taskId }, () => {
      this.sseClients.forEach(client => {
        if (client.taskId === 'all' || !client.taskId) {
          client.knownTaskIds.add(taskId);
        }
      });
    });
  }

  /**
   * @description Broadcast an event to all clients subscribed to a task.
   * Session clients ('all') only receive events for known tasks.
   *
   * @param taskId - Target task
   * @param eventType - Event type name
   * @param data - Event payload
   * @returns No value; existing stream delivery and cleanup behavior is retained.
   */
  broadcast(taskId: string, eventType: StreamEventType, data: Record<string, unknown>): void {
    return observeOperation(logger, 'broadcast', { taskId }, () => {
      const deferred = this.deferTaskEvent(taskId, eventType, data);
      if (deferred === 'buffered') return;
      this.sseClients.forEach((client, clientId) => {
        if (this.shouldReceiveEvent(client, taskId)) {
          if (client.authorize) this.queueAuthorizedEvent(clientId, client, taskId, eventType, data);
          else if (!isApprovalControlEvent(eventType)) this.sendEvent(client.response, eventType, { ...data, taskId });
        }
      });
    });
  }

  /**
   * @description Retain a bounded copy of output until the trusted caller finishes current-rights verification.
   * @param taskId Exact producing task; nested buffers for other tasks remain isolated.
   * @param type Actual event kind, with approval controls admitted separately.
   * @param data Event payload retained for delivery, never for logging.
   * @returns Whether the event was buffered, is a control event, or has no active deferred scope.
   */
  private deferTaskEvent(taskId: string, type: StreamEventType, data: Record<string, unknown>): 'buffered' | 'control' | false {
    const startedAt = Date.now();
    let buffer = this.deferredTaskEvents.getStore();
    while (buffer && buffer.taskId !== taskId) buffer = buffer.parent;
    if (!buffer) return false;
    if (buffer.closed || buffer.refusal) throw buffer.refusal ?? new DeferredTaskStreamError();
    // Approval controls must reach the owner during work; withholding them would deadlock the turn.
    if (isApprovalControlEvent(type)) return 'control';
    let serialized: string;
    try {
      const encoded = JSON.stringify(data);
      if (typeof encoded !== 'string') throw new DeferredTaskStreamError();
      serialized = encoded;
    }
    catch (err) {
      logOperationError(logger, 'deferTaskEvent', { taskId }, err, startedAt);
      buffer.refusal = new DeferredTaskStreamError(); throw buffer.refusal;
    }
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (buffer.events.length >= 128 || buffer.bytes + bytes > 1_048_576) {
      buffer.refusal = new DeferredTaskStreamError(); throw buffer.refusal;
    }
    // Copy mutable payloads now so later producer mutations cannot alter the authorized replay.
    buffer.events.push({ type, data: JSON.parse(serialized) as Record<string, unknown> });
    buffer.bytes += bytes;
    return 'buffered';
  }

  /**
   * @description Preserve per-client ordering while rechecking access immediately before each pending delivery.
   * @param clientId Exact subscribed connection.
   * @param client Current connection state; replacement invalidates any queued work.
   * @param taskId Exact event task.
   * @param eventType Actual stream event kind.
   * @param data Unlogged payload delivered only after current access succeeds.
   * @returns No value; refusal removes access or closes the task-specific connection.
   */
  private queueAuthorizedEvent(clientId: string, client: SSEClientState, taskId: string,
    eventType: StreamEventType, data: Record<string, unknown>): void {
    const startedAt = Date.now();
    if (++client.pendingEvents > 128) { this.unregisterClient(clientId); return; }
    client.delivery = client.delivery.then(async () => {
      if (this.sseClients.get(clientId) !== client) return;
      const allowed = await this.authorizeEvent(client, taskId, eventType);
      if (this.sseClients.get(clientId) !== client) return;
      if (!allowed) {
        client.knownTaskIds.delete(taskId);
        if (client.taskId === taskId) this.unregisterClient(clientId);
        return;
      }
      this.sendEvent(client.response, eventType, { ...data, taskId });
    }).catch(error => {
      logOperationError(logger, 'queueAuthorizedEvent', { clientId, taskId }, error, startedAt);
      this.unregisterClient(clientId);
    }).finally(() => { client.pendingEvents -= 1; });
  }

  /**
   * @description Bound a stalled access check without allowing its late success to revive delivery.
   * @param client Trusted subscriber authorization callback.
   * @param taskId Exact event task.
   * @param eventType Actual event kind, including separate pending approval controls.
   * @returns The access decision, or false after a fault or timeout.
   */
  private async authorizeEvent(client: SSEClientState, taskId: string, eventType: StreamEventType): Promise<boolean> {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([client.authorize!(taskId, eventType), new Promise<boolean>(done => {
        timer = setTimeout(() => done(false), 2_000);
      })]);
    } catch (error) {
      logOperationError(logger, 'authorizeEvent', { taskId }, error, startedAt);
      return false;
    }
    finally { clearTimeout(timer); }
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
   * @returns No value; existing stream delivery and cleanup behavior is retained.
   */
  broadcastMessage(taskId: string, message: Record<string, unknown>): void {
    return observeOperation(logger, 'broadcastMessage', { taskId }, () => {
      this.broadcast(taskId, 'message', { message, timestamp: Date.now() });
    });
  }

  /**
   * @description Convenience: broadcast a streaming chunk.
   *
   * @param taskId - Task identifier
   * @param chunk - Text chunk
   * @param messageId - Optional associated message ID
   * @returns No value; existing stream delivery and cleanup behavior is retained.
   */
  broadcastStreamChunk(taskId: string, chunk: string, messageId?: string): void {
    return observeOperation(logger, 'broadcastStreamChunk', { taskId }, () => {
      this.broadcast(taskId, 'stream_chunk', { chunk, messageId: messageId ?? null, timestamp: Date.now() });
    });
  }

  /**
   * @description Convenience: broadcast a task status/update payload.
   *
   * @param taskId - Task identifier
   * @param task - Task update payload
   * @returns No value; existing stream delivery and cleanup behavior is retained.
   */
  broadcastTaskUpdate(taskId: string, task: Record<string, unknown>): void {
    return observeOperation(logger, 'broadcastTaskUpdate', { taskId }, () => {
      this.broadcast(taskId, 'task_update', { task, timestamp: Date.now() });
    });
  }

  /**
   * @description Convenience: broadcast a tool execution status.
   *
   * @param taskId - Task identifier
   * @param tool - Tool info
   * @param status - Execution status
   * @returns No value; existing stream delivery and cleanup behavior is retained.
   */
  broadcastToolExecution(taskId: string, tool: Record<string, unknown>, status: string): void {
    return observeOperation(logger, 'broadcastToolExecution', { taskId }, () => {
      this.broadcast(taskId, 'tool_execution', { tool, status, timestamp: Date.now() });
    });
  }

  /**
   * @description Convenience: broadcast task completion.
   *
   * @param taskId - Task identifier
   * @param result - Completion result
   * @returns No value; existing stream delivery and cleanup behavior is retained.
   */
  broadcastCompletion(taskId: string, result: Record<string, unknown>): void {
    return observeOperation(logger, 'broadcastCompletion', { taskId }, () => {
      this.broadcast(taskId, 'completion', { result, timestamp: Date.now() });
    });
  }

  /**
   * @description Convenience: broadcast an error.
   *
   * @param taskId - Task identifier
   * @param error - Error message
   * @returns No value; existing stream delivery and cleanup behavior is retained.
   */
  broadcastError(taskId: string, error: string): void {
    return observeOperation(logger, 'broadcastError', { taskId }, () => {
      this.broadcast(taskId, 'error', { error, timestamp: Date.now() });
    });
  }

  /**
   * @description Send a single SSE event to a writable.
   *
   * @param res - Writable response
   * @param eventName - Event type name
   * @param data - Event payload
   */
  private sendEvent(res: SSEWritable, eventName: string, data: Record<string, unknown>): void {
    const startedAt = Date.now();
    try {
      res.write(`event: streaming-event\n`);
      res.write(`data: ${JSON.stringify({ type: eventName, ...data })}\n\n`);
    } catch (err) {
      logOperationError(logger, 'sendEvent', {}, err, startedAt);
    }
  }

  /**
   * @description Get connection statistics.
   *
   * @returns Stats object with client count and task count
   */
  getStats(): { clientCount: number; taskIds: string[] } {
    return observeOperation(logger, 'getStats', {}, () => {
      const taskIds = new Set<string>();
      this.sseClients.forEach((client) => {
        if (client.taskId && client.taskId !== 'all') {
          taskIds.add(client.taskId);
        }
      });
      return { clientCount: this.sseClients.size, taskIds: Array.from(taskIds) };
    });
  }

  /**
   * @description Close all connections for a specific task.
   *
   * @param taskId - Task to disconnect
   * @returns No value; existing stream delivery and cleanup behavior is retained.
   */
  closeTaskConnections(taskId: string): void {
    return observeOperation(logger, 'closeTaskConnections', { taskId }, () => {
      const toRemove: string[] = [];
      this.sseClients.forEach((client, clientId) => {
        if (client.taskId === taskId) {
          toRemove.push(clientId);
        }
      });
      toRemove.forEach((id) => this.unregisterClient(id));
    });
  }
}
