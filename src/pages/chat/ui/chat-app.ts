/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Chat application entry point
 *                     |                             | Imports modular services and initializes chat
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added welcome-state lifecycle handling for cockpit-styled standalone chat
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Switched voice imports to browser barrel to comply with Feature-Sliced deep-import restrictions
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added persisted conversation hydration on startup so selected/history task IDs restore full message timeline
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Suppressed no-console for this browser chat-app entry (client-side DOM module, no Node/Pino logger); connect/send failures stay on console
 */

/* eslint-disable no-console -- client-side: browser chat-app entry module, no Node logger in the DOM */

import { StreamingClient } from '../../../features/chat/services/streaming-client';
import {
  renderUserMessage,
  renderAssistantMessage,
  renderSystemMessage,
  renderTypingIndicator,
} from '../../../features/chat/services/message-renderer';
import { STTService, TTSService } from '../../../features/voice/browser';

/**
 * @description Main chat application class that orchestrates all chat functionality
 * Manages streaming, message rendering, voice input/output, and UI state
 */
export class ChatApp {
  private taskId: string;
  private streamingClient: StreamingClient;
  private sttService: STTService;
  private ttsService: TTSService;
  private typingIndicator: HTMLElement | null = null;
  
  private messageArea: HTMLElement;
  private messageInput: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private micButton: HTMLButtonElement;
  private ttsToggle: HTMLButtonElement;
  private connectionStatus: HTMLElement;
  private recordingIndicator: HTMLElement;
  private ttsIndicator: HTMLElement;
  private welcomeState: HTMLElement | null;

  /**
   * @description Creates a new ChatApp instance
   * @param taskId - Unique identifier for this chat session
   */
  constructor(taskId: string) {
    this.taskId = taskId;
    this.streamingClient = new StreamingClient('/api', taskId);
    this.sttService = new STTService();
    this.ttsService = new TTSService();

    // Get DOM elements
    this.messageArea = document.getElementById('messageArea')!;
    this.messageInput = document.getElementById('messageInput') as HTMLTextAreaElement;
    this.sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
    this.micButton = document.getElementById('micButton') as HTMLButtonElement;
    this.ttsToggle = document.getElementById('ttsToggle') as HTMLButtonElement;
    this.connectionStatus = document.getElementById('connectionStatus')!;
    this.recordingIndicator = document.getElementById('recordingIndicator')!;
    this.ttsIndicator = document.getElementById('ttsIndicator')!;
    this.welcomeState = document.getElementById('chatWelcome');
  }

  /**
   * @description Initializes the chat application and connects to streaming
   */
  async initialize(): Promise<void> {
    this.setupEventListeners();
    this.setupVoiceServices();
    this.updateTTSButton();
    await this.loadExistingMessages();
    await this.connectToStreaming();
  }

  /**
   * @description Loads persisted task messages and renders them before live streaming starts.
   */
  private async loadExistingMessages(): Promise<void> {
    try {
      const response = await fetch(`/api/${encodeURIComponent(this.taskId)}/messages`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        this.addSystemMessage(`History unavailable (${response.status})`, 'warning');
        return;
      }

      const payload = await response.json();
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      if (messages.length === 0) {
        return;
      }

      this.messageArea.innerHTML = '';
      this.hideWelcomeState();
      for (const message of messages) {
        this.renderHistoricalMessage(message);
      }
      this.scrollToBottom();
      this.addSystemMessage(`Loaded ${messages.length} messages from task history`, 'info');
    } catch (error) {
      this.addSystemMessage(`Failed to load history: ${(error as Error).message}`, 'warning');
    }
  }

  /**
   * @description Renders a historical user/assistant message into the active chat timeline.
   *
   * @param message - Persisted message payload.
   */
  private renderHistoricalMessage(message: { role?: string; text?: string; createdAt?: string }): void {
    const text = typeof message.text === 'string' ? message.text : '';
    if (text.trim().length === 0) {
      return;
    }

    const timestamp = typeof message.createdAt === 'string' ? new Date(message.createdAt) : new Date();
    const node = message.role === 'user'
      ? renderUserMessage(text, timestamp)
      : renderAssistantMessage(text, timestamp);
    this.messageArea.appendChild(node);
  }

  /**
   * @description Sets up all DOM event listeners
   */
  private setupEventListeners(): void {
    // Send button
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    // Message input
    this.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // Auto-resize textarea
    this.messageInput.addEventListener('input', () => {
      this.messageInput.style.height = 'auto';
      this.messageInput.style.height = this.messageInput.scrollHeight + 'px';
    });

    // Mic button
    this.micButton.addEventListener('click', () => {
      if (this.sttService.getRecordingStatus()) {
        this.stopRecording();
      } else {
        this.startRecording();
      }
    });

    // TTS toggle
    this.ttsToggle.addEventListener('click', () => {
      this.ttsService.toggle();
      this.updateTTSButton();
    });
  }

  /**
   * @description Sets up voice service callbacks
   */
  private setupVoiceServices(): void {
    // STT callbacks
    this.sttService.setOnTranscriptUpdate((transcript) => {
      this.messageInput.value = transcript;
      this.messageInput.style.height = 'auto';
      this.messageInput.style.height = this.messageInput.scrollHeight + 'px';
    });

    this.sttService.setOnError((error) => {
      alert(error);
    });

    // TTS callbacks
    this.ttsService.setOnPlaybackStart(() => {
      this.ttsIndicator.style.display = 'flex';
    });

    this.ttsService.setOnPlaybackEnd(() => {
      this.ttsIndicator.style.display = 'none';
    });

    // Disable mic if not supported
    if (!this.sttService.isSupported()) {
      this.micButton.disabled = true;
      this.micButton.title = 'Voice input not supported in this browser';
    }
  }

  /**
   * @description Connects to the streaming API
   */
  private async connectToStreaming(): Promise<void> {
    try {
      await this.streamingClient.connect();
      this.updateConnectionStatus(true);
      this.addSystemMessage('Connected to chat', 'success');
      this.setupStreamingHandlers();
    } catch (error) {
      console.error('Failed to connect:', error);
      this.updateConnectionStatus(false);
      this.addSystemMessage(`Connection failed: ${(error as Error).message}`, 'error');
    }
  }

  /**
   * @description Sets up streaming event handlers
   */
  private setupStreamingHandlers(): void {
    this.streamingClient.on('message', (data) => {
      this.hideTypingIndicator();
      if (data.role === 'assistant' && data.text) {
        this.hideWelcomeState();
        const msg = renderAssistantMessage(data.text, new Date());
        this.messageArea.appendChild(msg);
        this.scrollToBottom();
        this.ttsService.speak(data.text);
      }
    });

    this.streamingClient.on('llm-response', (data) => {
      this.hideTypingIndicator();
      if (data.text) {
        this.hideWelcomeState();
        const msg = renderAssistantMessage(data.text, new Date());
        this.messageArea.appendChild(msg);
        this.scrollToBottom();
        this.ttsService.speak(data.text);
      }
    });

    this.streamingClient.on('task-completion', () => {
      this.hideTypingIndicator();
      this.addSystemMessage('Task completed', 'success');
    });

    this.streamingClient.on('error', () => {
      this.hideTypingIndicator();
      this.addSystemMessage('Connection error occurred', 'error');
      this.updateConnectionStatus(false);
    });

    this.streamingClient.on('connected', () => {
      this.updateConnectionStatus(true);
    });
  }

  /**
   * @description Sends a message to the chat API
   */
  private async sendMessage(): Promise<void> {
    const text = this.messageInput.value.trim();
    if (!text) return;

    this.messageInput.disabled = true;
    this.sendBtn.disabled = true;

    const userMsg = renderUserMessage(text, new Date());
    this.hideWelcomeState();
    this.messageArea.appendChild(userMsg);
    this.scrollToBottom();

    this.messageInput.value = '';
    this.messageInput.style.height = 'auto';

    this.showTypingIndicator();

    try {
      await this.streamingClient.sendMessage(text);
    } catch (error) {
      console.error('Failed to send message:', error);
      this.hideTypingIndicator();
      this.addSystemMessage(`Failed to send: ${(error as Error).message}`, 'error');
    } finally {
      this.messageInput.disabled = false;
      this.sendBtn.disabled = false;
      this.messageInput.focus();
    }
  }

  /**
   * @description Starts voice recording
   */
  private startRecording(): void {
    if (this.sttService.startRecording()) {
      this.micButton.classList.add('recording');
      this.micButton.querySelector('.codicon')!.className = 'codicon codicon-primitive-square';
      this.micButton.title = 'Stop recording';
      this.recordingIndicator.style.display = 'flex';
    }
  }

  /**
   * @description Stops voice recording
   */
  private stopRecording(): void {
    this.sttService.stopRecording();
    this.micButton.classList.remove('recording');
    this.micButton.querySelector('.codicon')!.className = 'codicon codicon-mic';
    this.micButton.title = 'Voice input (click to record)';
    this.recordingIndicator.style.display = 'none';
  }

  /**
   * @description Updates the TTS toggle button appearance
   */
  private updateTTSButton(): void {
    if (this.ttsService.isEnabled()) {
      this.ttsToggle.classList.add('active');
      this.ttsToggle.querySelector('.codicon')!.className = 'codicon codicon-unmute';
      this.ttsToggle.title = 'AI voice enabled (click to disable)';
    } else {
      this.ttsToggle.classList.remove('active');
      this.ttsToggle.querySelector('.codicon')!.className = 'codicon codicon-mute';
      this.ttsToggle.title = 'AI voice disabled (click to enable)';
    }
  }

  /**
   * @description Updates connection status display
   * @param connected - Whether currently connected
   */
  private updateConnectionStatus(connected: boolean): void {
    if (connected) {
      this.connectionStatus.className = 'connection-status connected';
      this.connectionStatus.innerHTML = `
        <span class="codicon codicon-check"></span>
        <span>Connected</span>
      `;
    } else {
      this.connectionStatus.className = 'connection-status disconnected';
      this.connectionStatus.innerHTML = `
        <span class="codicon codicon-circle-slash"></span>
        <span>Disconnected</span>
      `;
    }
  }

  /**
   * @description Shows typing indicator
   */
  private showTypingIndicator(): void {
    if (!this.typingIndicator) {
      this.hideWelcomeState();
      this.typingIndicator = renderTypingIndicator();
      this.messageArea.appendChild(this.typingIndicator);
      this.scrollToBottom();
    }
  }

  /**
   * @description Hides typing indicator
   */
  private hideTypingIndicator(): void {
    if (this.typingIndicator) {
      this.typingIndicator.remove();
      this.typingIndicator = null;
    }
  }

  /**
   * @description Adds a system message to the chat
   * @param text - Message text
   * @param type - Message type (info, success, error, warning)
   */
  private addSystemMessage(text: string, type: 'info' | 'success' | 'error' | 'warning' = 'info'): void {
    const msg = renderSystemMessage(text, type);
    this.messageArea.appendChild(msg);
    this.scrollToBottom();
  }

  /**
   * @description Removes the welcome panel once active chat content starts rendering.
   */
  private hideWelcomeState(): void {
    if (this.welcomeState) {
      this.welcomeState.remove();
      this.welcomeState = null;
    }
  }

  /**
   * @description Scrolls message area to bottom
   */
  private scrollToBottom(): void {
    this.messageArea.scrollTop = this.messageArea.scrollHeight;
  }

  /**
   * @description Clears all messages from the chat
   */
  clearChat(): void {
    this.messageArea.innerHTML = '';
    this.welcomeState = null;
    this.addSystemMessage('Chat cleared', 'info');
  }

  /**
   * @description Cleans up resources
   */
  dispose(): void {
    this.streamingClient.disconnect();
    this.sttService.dispose();
    this.ttsService.dispose();
  }
}

// Export for global access
(window as any).ChatApp = ChatApp;
