/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation - SSE client for OSHAL chat streaming, adapted from any-bot StreamingClient.js
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed SSE ingestion for streaming-event channel and normalized nested message payloads for chat consumers
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fixed EventSource listener typings and JSON response typing for strict server typecheck compatibility
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'streaming-client' });

/**
 * @description Event data structure for SSE events
 */
export interface StreamEvent {
  type: string;
  data?: unknown;
  role?: 'user' | 'assistant';
  text?: string;
  turnCount?: number;
  toolsUsed?: string[];
}

/**
 * @description Event listener callback type
 */
type EventCallback = (data: StreamEvent) => void;

/**
 * @description SSE client for real-time OSHAL chat events.
 * Connects to /api/stream/:taskId endpoint and handles event streaming.
 * 
 * Adapted from any-bot StreamingClient with OSHAL backend integration.
 */
export class StreamingClient {
  private apiUrl: string;
  private taskId: string;
  private eventSource: EventSource | null = null;
  private isConnected = false;
  private listeners: Map<string, EventCallback[]> = new Map();

  /**
   * @description Creates a new streaming client instance
   * 
   * @param apiUrl - Base API URL (e.g., '/api' or 'http://localhost:3456/api')
   * @param taskId - Task identifier to stream events for
   */
  constructor(apiUrl: string, taskId: string) {
    this.apiUrl = apiUrl;
    this.taskId = taskId;
    
    logger.info({ taskId }, 'StreamingClient initialized');
  }

  /**
   * @description Connects to the SSE stream endpoint
   * 
   * @returns Promise that resolves when connection is established
   * @throws Error if connection fails
   */
  async connect(): Promise<boolean> {
    const url = `${this.apiUrl}/stream/${this.taskId}`;
    logger.info({ url }, 'Connecting to SSE stream');
    
    try {
      this.eventSource = new EventSource(url);
      
      this.eventSource.onopen = () => {
        logger.info({ taskId: this.taskId }, 'SSE connected');
        this.isConnected = true;
        this.emit('connected', {});
      };
      
      this.eventSource.onerror = (error) => {
        logger.error({ err: error, taskId: this.taskId }, 'SSE connection error');
        this.isConnected = false;
        this.emit('error', { error });
      };
      
      this.eventSource.onmessage = (event) => {
        this.processSsePayload(event.data, 'message');
      };

      this.eventSource.addEventListener('streaming-event', (event: Event) => {
        const payload = event as MessageEvent;
        this.processSsePayload(payload.data, 'streaming-event');
      });
      
      this.setupEventListeners();
      
      return true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to connect to streaming');
      throw error;
    }
  }

  /**
   * @description Parses raw SSE payloads and routes to typed handlers.
   *
   * @param rawData - Raw JSON payload from EventSource
   * @param channel - Source SSE channel for debug context
   */
  private processSsePayload(rawData: string, channel: string): void {
    try {
      const data = JSON.parse(rawData);
      logger.debug({ type: data.type, taskId: this.taskId, channel }, 'SSE event received');
      this.handleEvent(data);
    } catch (error) {
      logger.error({ err: error, channel }, 'SSE parse error');
    }
  }

  /**
   * @description Sets up event listeners for specific SSE event types
   */
  private setupEventListeners(): void {
    if (!this.eventSource) return;

    const eventTypes = [
      'tool-execution',
      'task-completion',
      'llm-response',
      'task-progress',
      'thinking-process',
      'streaming-started',
      'message',
    ];

    eventTypes.forEach(eventType => {
      this.eventSource!.addEventListener(eventType, (event: Event) => {
        const payload = event as MessageEvent;
        const data = JSON.parse(payload.data);
        logger.debug({ eventType, taskId: this.taskId }, 'Typed SSE event received');
        this.emit(eventType, data);
      });
    });
  }

  /**
   * @description Routes generic events to typed event handlers
   * 
   * @param data - Event data
   */
  private handleEvent(data: StreamEvent): void {
    const eventType = data.type || 'unknown-event';
    this.emit(eventType, this.normalizeEventData(eventType, data));
  }

  /**
   * @description Normalizes backend SSE payload shapes for frontend consumers.
   *
   * @param eventType - Parsed event type
   * @param data - Raw event payload
   * @returns Normalized event payload
   */
  private normalizeEventData(eventType: string, data: StreamEvent): StreamEvent {
    const raw = data as StreamEvent & { message?: Record<string, unknown> };
    if (eventType !== 'message' || !raw.message || typeof raw.message !== 'object') {
      return data;
    }
    return { ...raw, ...(raw.message as Record<string, unknown>) } as StreamEvent;
  }

  /**
   * @description Registers an event listener callback
   * 
   * @param eventType - Event type to listen for
   * @param callback - Callback function to invoke
   */
  on(eventType: string, callback: EventCallback): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    this.listeners.get(eventType)!.push(callback);
  }

  /**
   * @description Removes an event listener callback
   * 
   * @param eventType - Event type
   * @param callback - Callback to remove
   */
  off(eventType: string, callback: EventCallback): void {
    const listeners = this.listeners.get(eventType);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * @description Emits an event to all registered listeners
   * 
   * @param eventType - Event type to emit
   * @param data - Event data
   */
  private emit(eventType: string, data: unknown): void {
    const listeners = this.listeners.get(eventType);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(data as StreamEvent);
        } catch (error) {
          logger.error({ err: error, eventType }, `Error in ${eventType} listener`);
        }
      });
    }
  }

  /**
   * @description Closes the SSE connection
   */
  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      this.isConnected = false;
      logger.info({ taskId: this.taskId }, 'SSE disconnected');
    }
  }

  /**
   * @description Reconnects to the SSE stream
   * 
   * @returns Promise that resolves when reconnected
   */
  reconnect(): Promise<boolean> {
    this.disconnect();
    return this.connect();
  }

  /**
   * @description Gets current connection state
   * 
   * @returns Connection state object
   */
  getConnectionState(): {
    isConnected: boolean;
    readyState?: number;
    url?: string;
    taskId: string;
  } {
    return {
      isConnected: this.isConnected,
      readyState: this.eventSource?.readyState,
      url: this.eventSource?.url,
      taskId: this.taskId,
    };
  }

  /**
   * @description Sends a message to the chat backend
   * 
   * @param message - Message text to send
   * @param options - Additional options (agenticMode, source, etc.)
   * @returns Promise with send result
   * @throws Error if message send fails
   */
  async sendMessage(
    message: string,
    options: { agenticMode?: boolean; source?: string; chatOnly?: boolean } = {},
  ): Promise<{ success: boolean; error?: string }> {
    try {
      logger.info({ taskId: this.taskId, messageLength: message.length }, 'Sending message');

      const response = await fetch(`${this.apiUrl}/send-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: this.taskId,
          text: message,
          agenticMode: options.agenticMode ?? true,
          source: options.source ?? 'chat-ui',
          chatOnly: options.chatOnly ?? true,
        }),
      });
      
      const result = (await response.json()) as { success?: boolean; error?: string };
      
      if (result.success || response.ok) {
        logger.info({ taskId: this.taskId }, 'Message sent successfully');
        return { success: true };
      } else {
        logger.error({ error: result.error, taskId: this.taskId }, 'Message send failed');
        throw new Error(result.error || 'Message send failed');
      }
      
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, taskId: this.taskId }, 'Connection error');
      throw new Error(errMsg);
    }
  }

  /**
   * @description Waits for task completion event
   * 
   * @param timeoutMs - Timeout in milliseconds
   * @returns Promise that resolves with completion data
   * @throws Error on timeout
   */
  async waitForTaskCompletion(timeoutMs = 30000): Promise<StreamEvent> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('task-completion', completionHandler);
        reject(new Error('Task completion timeout'));
      }, timeoutMs);

      const completionHandler = (data: StreamEvent) => {
        clearTimeout(timeout);
        this.off('task-completion', completionHandler);
        resolve(data);
      };

      this.on('task-completion', completionHandler);
    });
  }

  /**
   * @description Gets statistics about registered event listeners
   * 
   * @returns Object mapping event types to listener counts
   */
  getEventStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    this.listeners.forEach((listeners, eventType) => {
      stats[eventType] = listeners.length;
    });
    return stats;
  }
}
