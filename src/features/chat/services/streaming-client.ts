/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial extraction from chat-standalone.html
 *                     |                             | StreamingClient for SSE-based chat streaming
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed SSE event ingestion by handling streaming-event channel and normalizing nested message payloads for chat rendering
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fixed message send response handling to treat API success:false as failure and prevent indefinite typing hangs
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added DOM custom-event dispatch for generic SSE events so the standalone tools modal can react to task status changes
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Rebound embedded cockpit chat sends to the cockpit-selected bot so the native right-rail workspace targets the active bot instead of the shared default chat agent
 */

/* eslint-disable no-console -- client-side: browser SSE module (EventSource/document/window), no Node logger in the DOM */

/**
 * @description Client for managing Server-Sent Events (SSE) streaming connections
 * for real-time chat communication. Handles connection lifecycle, event routing,
 * and message sending to the chat API.
 */
export class StreamingClient {
  private apiUrl: string;
  private taskId: string;
  private eventSource: EventSource | null = null;
  private isConnected: boolean = false;
  private listeners: Map<string, Array<(data: any) => void>> = new Map();

  /**
   * @description Creates a new StreamingClient instance
   * @param apiUrl - Base URL for the chat API (e.g., '/api')
   * @param taskId - Unique identifier for this chat task/session
   */
  constructor(apiUrl: string, taskId: string) {
    this.apiUrl = apiUrl;
    this.taskId = taskId;
    console.log(`StreamingClient initialized for task ${taskId}`);
  }

  /**
   * @description Establishes SSE connection to the streaming endpoint
   * @returns Promise that resolves when connection is established
   * @throws Error if connection fails
   */
  async connect(): Promise<boolean> {
    const url = `${this.apiUrl}/stream/${this.taskId}`;
    console.log('Connecting to SSE:', url);
    
    try {
      this.eventSource = new EventSource(url);
      
      this.eventSource.onopen = () => {
        console.log('SSE connected');
        this.isConnected = true;
        this.emit('connected', {});
      };
      
      this.eventSource.onerror = (error) => {
        console.error('SSE connection error:', error);
        this.isConnected = false;
        this.emit('error', { error });
      };
      
      this.eventSource.onmessage = (event) => {
        this.processSsePayload(event.data, 'message');
      };

      this.eventSource.addEventListener('streaming-event', (event: MessageEvent) => {
        this.processSsePayload(event.data, 'streaming-event');
      });
      
      this.setupEventListeners();
      
      return true;
    } catch (error) {
      console.error('Failed to connect to streaming:', error);
      throw error;
    }
  }

  /**
   * @description Parses raw SSE payloads and routes to typed handlers.
   * @param rawData - Raw JSON payload from EventSource
   * @param channel - Source SSE channel for debug context
   */
  private processSsePayload(rawData: string, channel: string): void {
    try {
      const data = JSON.parse(rawData);
      console.log(`${channel} SSE event:`, data);
      this.handleEvent(data);
    } catch (error) {
      console.error('SSE parse error:', error);
    }
  }

  /**
   * @description Sets up event listeners for all supported SSE event types
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
      this.eventSource!.addEventListener(eventType, (event: MessageEvent) => {
        const data = JSON.parse(event.data);
        console.log(`${eventType} event:`, data);
        this.emit(eventType, data);
      });
    });
  }

  /**
   * @description Handles incoming SSE events and routes them to listeners
   * @param data - Event data from the SSE stream
   */
  private handleEvent(data: any): void {
    const eventType = data.type || 'unknown-event';
    const normalizedData = this.normalizeEventData(eventType, data);
    this.emit(eventType, normalizedData);
    this.dispatchDomEvents(eventType, normalizedData);
  }

  /**
   * @description Normalizes backend SSE payload shapes for frontend consumers.
   * @param eventType - Parsed event type
   * @param data - Raw event payload
   * @returns Normalized payload
   */
  private normalizeEventData(eventType: string, data: any): any {
    if (eventType !== 'message' || !data?.message || typeof data.message !== 'object') {
      return data;
    }
    return { ...data, ...data.message };
  }

  /**
   * @description Emits tool approval events as DOM CustomEvents for modal integration.
   * @param eventType - Parsed event type
   * @param data - Event payload
   */
  private dispatchDomEvents(eventType: string, data: any): void {
    if (typeof document === 'undefined') {
      return;
    }

    document.dispatchEvent(new CustomEvent(`oshal-stream:${eventType}`, { detail: data }));

    if (eventType.startsWith('tool:approval:')) {
      document.dispatchEvent(new CustomEvent(`sse:${eventType}`, { detail: data }));
    }
  }

  /**
   * @description Registers an event listener for a specific event type
   * @param eventType - Type of event to listen for
   * @param callback - Function to call when event is received
   */
  on(eventType: string, callback: (data: any) => void): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    this.listeners.get(eventType)!.push(callback);
  }

  /**
   * @description Emits an event to all registered listeners
   * @param eventType - Type of event to emit
   * @param data - Data to pass to listeners
   */
  private emit(eventType: string, data: any): void {
    const listeners = this.listeners.get(eventType);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in ${eventType} listener:`, error);
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
      console.log('SSE disconnected');
    }
  }

  /**
   * @description Sends a chat message to the API
   * @param message - Text content of the message
   * @param options - Optional configuration for message sending
   * @param options.agenticMode - Enable agentic processing (default: true)
   * @param options.source - Source identifier for the message (default: 'chat-ui')
   * @returns Promise with send result
   * @throws Error if message send fails
   */
  async sendMessage(
    message: string, 
    options: { agenticMode?: boolean; source?: string } = {}
  ): Promise<{ success: boolean }> {
    try {
      const targetAgentId = this.resolveEmbeddedCockpitAgentId();
      console.log('Sending message:', message);
      
      const response = await fetch(`${this.apiUrl}/send-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          taskId: this.taskId,
          text: message,
          agenticMode: options.agenticMode !== false,
          source: options.source || 'chat-ui',
          agentId: targetAgentId,
        }),
      });
      
      const result = await response.json();
      this.assertMessageSendResult(response, result);
      console.log('Message sent successfully');
      return { success: true };
      
    } catch (error) {
      console.error('Connection error:', error);
      throw error;
    }
  }

  /**
   * @description Resolve the cockpit-selected bot id when the native chat page is embedded inside cockpit.
   * @returns Active embedded cockpit bot id or undefined when standalone chat is in use.
   */
  private resolveEmbeddedCockpitAgentId(): string | undefined {
    if (typeof document === 'undefined') {
      return undefined;
    }

    const rootAgentId = document.documentElement?.dataset?.cockpitAgentId?.trim();
    if (rootAgentId) {
      return rootAgentId;
    }

    const globalAgentId = (window as Window & {
      __oshalCockpitEmbedContext?: { agentId?: string };
    }).__oshalCockpitEmbedContext?.agentId?.trim();

    return globalAgentId || undefined;
  }

  /**
   * @description Validates API send-message responses and throws on failures.
   * Prevents UI hangs by honoring payload-level `success:false` even on HTTP 200.
   * @param response - Fetch response object from the API call
   * @param payload - Parsed JSON response payload
   * @throws Error when transport or application-level failure is detected
   */
  private assertMessageSendResult(response: Response, payload: any): void {
    if (!response.ok) {
      throw new Error(payload?.error || `Message send failed (${response.status})`);
    }

    if (payload && typeof payload.success === 'boolean' && payload.success === false) {
      throw new Error(payload.error || 'Message send failed');
    }
  }

  /**
   * @description Gets the current connection status
   * @returns True if connected, false otherwise
   */
  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  /**
   * @description Gets the task ID for this streaming session
   * @returns Task ID string
   */
  getTaskId(): string {
    return this.taskId;
  }
}
