/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Stream Controller - Manages real-time streaming for messages
 * Coordinates WebSocket and SSE streaming to clients
 */

const logger = require('../utils/logger');
const { MESSAGE_TYPES } = require('../utils/messageTypes');

/**
 * @description Central hub for fanning real-time task events out to connected
 * clients over two transports (Socket.IO WebSockets and Server-Sent Events).
 * It exists so the rest of the server can emit task progress, streaming LLM
 * chunks, tool-execution status, errors, and completion without knowing which
 * transport a given client uses or how subscriptions are scoped. Subscription
 * scoping (Issue #022) ensures one bot's internal ticket processing does not
 * leak events into an unrelated dashboard chat.
 */
class StreamController {
  /**
   * @description Initialize empty registries for both transports so the
   * controller can track subscriptions before Socket.IO is wired up. No
   * arguments are taken because connections are added lazily as clients arrive.
   */
  constructor() {
    this.connections = new Map(); // taskId -> Set of connections
    this.socketIO = null;
    this.sseClients = new Map(); // clientId -> response object
  }

  /**
   * Initialize with Socket.IO instance
   */
  initializeSocketIO(io) {
    this.socketIO = io;
    
    io.on('connection', (socket) => {
      logger.info(`WebSocket client connected: ${socket.id}`);

      // Handle task subscription
      socket.on('subscribe_task', (data) => {
        const { taskId } = data;
        this.subscribeSocket(taskId, socket);
      });

      // Handle task unsubscription
      socket.on('unsubscribe_task', (data) => {
        const { taskId } = data;
        this.unsubscribeSocket(taskId, socket);
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        logger.info(`WebSocket client disconnected: ${socket.id}`);
        this.cleanupSocket(socket);
      });
    });

    logger.info('StreamController initialized with Socket.IO');
  }

  /**
   * Subscribe a socket to task updates
   */
  subscribeSocket(taskId, socket) {
    if (!this.connections.has(taskId)) {
      this.connections.set(taskId, new Set());
    }

    this.connections.get(taskId).add(socket);
    socket.join(`task_${taskId}`); // Socket.IO room

    logger.debug(`Socket ${socket.id} subscribed to task ${taskId}`);
  }

  /**
   * Unsubscribe a socket from task updates
   */
  unsubscribeSocket(taskId, socket) {
    const connections = this.connections.get(taskId);
    if (connections) {
      connections.delete(socket);
      if (connections.size === 0) {
        this.connections.delete(taskId);
      }
    }

    socket.leave(`task_${taskId}`);
    logger.debug(`Socket ${socket.id} unsubscribed from task ${taskId}`);
  }

  /**
   * Cleanup socket from all subscriptions
   */
  cleanupSocket(socket) {
    this.connections.forEach((sockets, taskId) => {
      if (sockets.has(socket)) {
        sockets.delete(socket);
        if (sockets.size === 0) {
          this.connections.delete(taskId);
        }
      }
    });
  }

  /**
   * Broadcast message to all clients subscribed to a task
   */
  broadcast(taskId, event, data) {
    if (!this.socketIO) {
      logger.warn('Socket.IO not initialized, cannot broadcast');
      return;
    }

    // Broadcast via Socket.IO room
    this.socketIO.to(`task_${taskId}`).emit(event, data);

    // Also send to SSE clients
    this.broadcastSSE(taskId, event, data);

    logger.debug(`Broadcast ${event} to task ${taskId}`);
  }

  /**
   * Broadcast task update
   */
  broadcastTaskUpdate(taskId, task) {
    this.broadcast(taskId, 'task_update', {
      taskId,
      task,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast new message
   */
  broadcastMessage(taskId, message) {
    this.broadcast(taskId, 'message', {
      taskId,
      message,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast streaming chunk (for real-time LLM response)
   */
  broadcastStreamChunk(taskId, chunk, messageId = null) {
    this.broadcast(taskId, 'stream_chunk', {
      taskId,
      chunk,
      messageId,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast tool execution update
   */
  broadcastToolExecution(taskId, tool, status) {
    this.broadcast(taskId, 'tool_execution', {
      taskId,
      tool,
      status,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast error
   */
  broadcastError(taskId, error) {
    this.broadcast(taskId, 'error', {
      taskId,
      error: error.message || error,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast task completion
   */
  broadcastCompletion(taskId, result) {
    this.broadcast(taskId, 'completion', {
      taskId,
      result,
      timestamp: Date.now(),
    });
  }

  /**
   * Register SSE client
   */
  registerSSEClient(clientId, taskId, res) {
    this.sseClients.set(clientId, {
      taskId,
      res,
      connected: Date.now(),
    });

    // Setup SSE headers only if not already sent
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable Nginx buffering
      });
    }

    // Send initial connection event
    this.sendSSE(res, 'connection', {
      clientId,
      taskId,
      message: 'Connected to streaming',
    });

    // Setup heartbeat
    const heartbeat = setInterval(() => {
      if (!this.sseClients.has(clientId)) {
        clearInterval(heartbeat);
        return;
      }
      this.sendSSE(res, 'heartbeat', {
        timestamp: Date.now(),
      });
    }, 30000); // Every 30 seconds

    // Cleanup on close
    res.on('close', () => {
      clearInterval(heartbeat);
      this.sseClients.delete(clientId);
      logger.info(`SSE client disconnected: ${clientId}`);
    });

    logger.info(`SSE client registered: ${clientId} for task ${taskId}`);
  }

  /**
   * Unregister SSE client
   */
  unregisterSSEClient(clientId) {
    const client = this.sseClients.get(clientId);
    if (client) {
      try {
        client.res.end();
      } catch (err) {
        logger.warn(`Error closing SSE client ${clientId}: ${err.message}`);
      }
      this.sseClients.delete(clientId);
      logger.info(`SSE client unregistered: ${clientId}`);
    }
  }

  /**
   * Send SSE event
   * Always sends as 'streaming-event' type with event name in data
   */
  sendSSE(res, eventName, data) {
    try {
      res.write(`event: streaming-event\n`);
      res.write(`data: ${JSON.stringify({ type: eventName, ...data })}\n\n`);
    } catch (err) {
      logger.error(`Failed to send SSE event: ${err.message}`);
    }
  }

  /**
   * Broadcast to SSE clients
   * PHASE_27 FIX (Issue #022): Only sends to clients subscribed to this specific task.
   * Session-based 'all' clients only receive events for tasks they initiated (stored in client.knownTaskIds).
   * This prevents QM ticket processing events from bleeding into unrelated dashboard chats.
   */
  broadcastSSE(taskId, event, data) {
    this.sseClients.forEach((client, clientId) => {
      if (client.taskId === taskId) {
        // Exact match — always send
        this.sendSSE(client.res, event, { ...data, taskId });
      } else if (client.taskId === 'all' || !client.taskId) {
        // Session-based client: only send if this taskId was explicitly associated with the session
        // This prevents QM internal ticket processing events from bleeding into dashboard chat
        if (client.knownTaskIds && client.knownTaskIds.has(taskId)) {
          this.sendSSE(client.res, event, { ...data, taskId });
        }
        // If not a known task, silently drop — prevents cross-bot SSE noise
      }
    });
  }

  /**
   * Associate a taskId with a session-based SSE client.
   * Called when the dashboard creates a new task (e.g., via /api/send-message).
   * After association, events for that taskId will reach the session client.
   * Issue #022: This is the mechanism that scopes SSE events to the correct dashboard.
   */
  associateTaskWithSession(taskId) {
    this.sseClients.forEach((client, clientId) => {
      if (client.taskId === 'all' || !client.taskId) {
        if (!client.knownTaskIds) {
          client.knownTaskIds = new Set();
        }
        client.knownTaskIds.add(taskId);
        logger.debug(`SSE: Associated task ${taskId} with session client ${clientId}`);
      }
    });
  }

  /**
   * Get connection count for a task
   */
  getConnectionCount(taskId) {
    const sockets = this.connections.get(taskId);
    const socketCount = sockets ? sockets.size : 0;
    
    let sseCount = 0;
    this.sseClients.forEach((client) => {
      if (client.taskId === taskId) {
        sseCount++;
      }
    });

    return {
      websocket: socketCount,
      sse: sseCount,
      total: socketCount + sseCount,
    };
  }

  /**
   * Get total connection statistics
   */
  getStats() {
    const totalWebSocket = Array.from(this.connections.values()).reduce(
      (sum, sockets) => sum + sockets.size,
      0
    );
    const totalSSE = this.sseClients.size;

    return {
      websocket: totalWebSocket,
      sse: totalSSE,
      total: totalWebSocket + totalSSE,
      tasks: this.connections.size,
      sseClients: Array.from(this.sseClients.keys()).length,
    };
  }

  /**
   * Close all connections for a task
   */
  closeTaskConnections(taskId) {
    // Close WebSocket connections
    const sockets = this.connections.get(taskId);
    if (sockets) {
      sockets.forEach((socket) => {
        socket.leave(`task_${taskId}`);
      });
      this.connections.delete(taskId);
    }

    // Close SSE connections
    this.sseClients.forEach((client, clientId) => {
      if (client.taskId === taskId) {
        client.res.end();
        this.sseClients.delete(clientId);
      }
    });

    logger.info(`Closed all connections for task ${taskId}`);
  }
}

module.exports = StreamController;
